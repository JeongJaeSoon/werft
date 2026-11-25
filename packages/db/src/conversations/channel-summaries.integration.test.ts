import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ChannelSummaryLineId,
  type ConversationInputId,
  type ConversationTopicId,
  conversationInputIdSchema,
} from "@werft-ai/contracts";
import type {
  ChannelSummaryPlace,
  ChannelSummaryStore,
  NewChannelSummaryLine,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  createPostgresSlackSourceMarkStore,
  purgeUnknownSlackSourceMarks,
} from "../surface/slack-source-marks.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import {
  createPostgresChannelSummaryStore,
  pruneChannelSummaryHistory,
} from "./channel-summaries.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";
import { lockSlackSourceMark } from "./source-mark-lock.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

test("a summary line takes no speaker or place from its writer (G8)", () => {
  const line: NewChannelSummaryLine = {
    text: "x",
    sources: [
      { inputId: conversationInputIdSchema.parse(randomUUID()), slack: null },
    ],
    // @ts-expect-error who spoke is the input row's to say
    speaker: { kind: "user", id: "someone" },
  };
  const placed: NewChannelSummaryLine = {
    text: "x",
    sources: [
      { inputId: conversationInputIdSchema.parse(randomUUID()), slack: null },
    ],
    // @ts-expect-error where it was said is the input row's too
    ts: "1792800000.000100",
  };
  expect([line, placed]).toHaveLength(2);
});

integration("channel summaries (0325)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let summaries: ChannelSummaryStore;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const teamId = "T0SUM";
  const at = new Date("2026-11-23T01:00:00.000Z");
  let turnId: number;
  let tsCounter = 1792800000;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "channel_summaries" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    summaries = createPostgresChannelSummaryStore(db);
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const team = await fixtureTeamSql(pool, workspaceId);
    for (const id of [agentId, otherAgentId]) {
      await pool.query(
        "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
        [id, workspaceId, team, `agent-${id.slice(0, 8)}`],
      );
    }
    const session = await newPartitionedSession(db, "channel-summaries");
    const { rows } = await pool.query(
      "SELECT id FROM turns WHERE session_id = $1 ORDER BY sequence LIMIT 1",
      [session.sessionId],
    );
    turnId = Number(rows[0].id);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const topics = new Map<string, ConversationTopicId>();
  async function topicOf(agent: string, channelId: string) {
    const key = `${agent}:${channelId}`;
    const known = topics.get(key);
    if (known !== undefined) return known;
    const conversations = createPostgresConversationStore(db);
    const conversation = await conversations.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId: agent,
      teamId,
      channelId,
    });
    const topic = await conversations.findOrCreateThreadTopic(conversation.id, {
      teamId,
      channelId,
      threadTs: `${tsCounter}.000000`,
    });
    topics.set(key, topic.id);
    return topic.id;
  }

  let seq = 0;
  /** A Slack input of the agent in the channel, said by `speaker`. */
  async function input(
    channelId: string,
    speaker = "U0SPEAKER",
    agent = agentId,
  ): Promise<{ id: ConversationInputId; ts: string }> {
    const topicId = await topicOf(agent, channelId);
    const id = conversationInputIdSchema.parse(randomUUID());
    tsCounter += 1;
    const ts = `${tsCounter}.000100`;
    seq += 1;
    await pool.query(
      "INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id, turn_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'slack_bot', $9, $10)",
      [
        id,
        workspaceId,
        agent,
        topicId,
        seq,
        teamId,
        channelId,
        ts,
        speaker,
        turnId,
      ],
    );
    return { id, ts };
  }

  const src = (row: { id: ConversationInputId }) => ({
    inputId: row.id,
    slack: null,
  });
  const placeOf = (channelId: string): ChannelSummaryPlace => ({
    workspaceId,
    teamId,
    channelId,
  });
  let channelCounter = 0;
  const newChannel = () => {
    channelCounter += 1;
    return `C0SUM${channelCounter}`;
  };

  async function append(
    channelId: string,
    expectedVersion: number,
    lines: NewChannelSummaryLine[],
  ) {
    const written = await summaries.append({
      place: placeOf(channelId),
      agentId,
      expectedVersion,
      lines,
    });
    if (written.outcome !== "written") throw new Error(written.outcome);
    return written;
  }

  /** Every version's line texts, 0 to the current one. */
  async function everyVersion(channelId: string): Promise<string[][]> {
    const current = await summaries.read(placeOf(channelId));
    if (current === null) return [];
    const versions: string[][] = [];
    for (let v = 0; v <= current.version; v += 1) {
      const summary = await summaries.read(placeOf(channelId), v);
      versions.push(summary?.lines.map((line) => line.text) ?? []);
    }
    return versions;
  }

  const marks = () => createPostgresSlackSourceMarkStore(db);
  const mark = (channelId: string, ts: string) => ({
    workspaceId,
    teamId,
    channelId,
    ts,
    at,
  });

  test("a line's speaker and place come from its input row", async () => {
    const channel = newChannel();
    const said = await input(channel, "U0ALICE");
    const written = await append(channel, 0, [
      { text: "Alice asked for the deploy plan", sources: [src(said)] },
    ]);
    expect(written).toMatchObject({ version: 1, skipped: [] });
    const summary = await summaries.read(placeOf(channel));
    expect(summary?.version).toBe(1);
    expect(summary?.lines).toEqual([
      {
        id: written.lineIds[0] as ChannelSummaryLineId,
        text: "Alice asked for the deploy plan",
        writtenByAgentId: agentId,
        writtenAt: expect.any(Date),
        sources: [
          {
            inputId: said.id,
            teamId,
            channelId: channel,
            ts: said.ts,
            speaker: { kind: "slack_bot", id: "U0ALICE" },
            at: new Date(Math.floor(Number(said.ts) * 1000)),
          },
        ],
      },
    ]);
  });

  test("deleting one of three sources takes its line out of every version, and a revert does not bring it back", async () => {
    const channel = newChannel();
    const [a, b, c] = [
      await input(channel),
      await input(channel),
      await input(channel),
    ];
    if (!a || !b || !c) throw new Error("inputs");
    await append(channel, 0, [{ text: "line a", sources: [src(a)] }]);
    await append(channel, 1, [
      { text: "line b", sources: [src(b)] },
      { text: "line c", sources: [src(c)] },
    ]);
    expect(await everyVersion(channel)).toEqual([
      [],
      ["line a"],
      ["line a", "line b", "line c"],
    ]);

    expect(await marks().markDeleted(mark(channel, b.ts))).toBe("recorded");
    // Before: v2 held line b. After: no version does, and the summary moved on.
    expect(await everyVersion(channel)).toEqual([
      [],
      ["line a"],
      ["line a", "line c"],
      ["line a", "line c"],
    ]);

    const reverted = await summaries.revert({
      place: placeOf(channel),
      expectedVersion: 3,
      toVersion: 2,
    });
    expect(reverted).toMatchObject({ outcome: "written", version: 4 });
    expect(
      (await summaries.read(placeOf(channel)))?.lines.map((l) => l.text),
    ).toEqual(["line a", "line c"]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM channel_summary_line_sources WHERE ts = $1",
      [b.ts],
    );
    expect(rows[0].n).toBe(0);
  });

  test("a revert brings back folded lines once, however often it runs, and never a deleted one", async () => {
    const channel = newChannel();
    const [a, b] = [await input(channel), await input(channel)];
    if (!a || !b) throw new Error("inputs");
    const first = await append(channel, 0, [
      { text: "line a", sources: [src(a)] },
      { text: "line b", sources: [src(b)] },
    ]);
    const folded = await summaries.fold({
      place: placeOf(channel),
      agentId,
      expectedVersion: 1,
      lineIds: first.lineIds,
      text: "a and b",
    });
    expect(folded).toMatchObject({ outcome: "written", version: 2 });
    const back = { place: placeOf(channel), toVersion: 1 };
    await summaries.revert({ ...back, expectedVersion: 2 });
    await summaries.revert({ ...back, expectedVersion: 3 });
    expect(await everyVersion(channel)).toEqual([
      [],
      ["line a", "line b"],
      ["a and b"],
      ["line a", "line b"],
      ["line a", "line b"],
    ]);

    await marks().markDeleted(mark(channel, a.ts));
    // The folded line had a among its sources: it goes whole, from v2 too.
    expect(await everyVersion(channel)).toEqual([
      [],
      ["line b"],
      [],
      ["line b"],
      ["line b"],
      ["line b"],
    ]);
    await summaries.revert({
      place: placeOf(channel),
      expectedVersion: 5,
      toVersion: 2,
    });
    await summaries.revert({
      place: placeOf(channel),
      expectedVersion: 6,
      toVersion: 1,
    });
    expect(
      (await summaries.read(placeOf(channel)))?.lines.map((l) => l.text),
    ).toEqual(["line b"]);
  });

  test("a revert keeps the order of lines written together", async () => {
    const channel = newChannel();
    const [a, b] = [await input(channel), await input(channel)];
    if (!a || !b) throw new Error("inputs");
    const first = await append(channel, 0, [
      { text: "line a", sources: [src(a)] },
      { text: "line b", sources: [src(b)] },
    ]);
    await summaries.fold({
      place: placeOf(channel),
      agentId,
      expectedVersion: 1,
      lineIds: [first.lineIds[0] as ChannelSummaryLineId],
      text: "a again",
    });
    const back = { place: placeOf(channel), toVersion: 1 };
    await summaries.revert({ ...back, expectedVersion: 2 });
    await summaries.revert({ ...back, expectedVersion: 3 });
    expect(await everyVersion(channel)).toEqual([
      [],
      ["line a", "line b"],
      // The folded line stands where the line it folded stood.
      ["a again", "line b"],
      ["line a", "line b"],
      ["line a", "line b"],
    ]);
  });

  test("a folded line of two sources goes whole when only one of them is deleted", async () => {
    const channel = newChannel();
    const [a, b] = [await input(channel, "U0A"), await input(channel, "U0B")];
    if (!a || !b) throw new Error("inputs");
    const first = await append(channel, 0, [
      { text: "line a", sources: [src(a)] },
      { text: "line b", sources: [src(b)] },
    ]);
    const folded = await summaries.fold({
      place: placeOf(channel),
      agentId: otherAgentId,
      expectedVersion: 1,
      lineIds: first.lineIds,
      text: "a and b agreed",
    });
    if (folded.outcome !== "written") throw new Error(folded.outcome);
    const summary = await summaries.read(placeOf(channel));
    expect(summary?.lines).toHaveLength(1);
    expect(summary?.lines[0]?.writtenByAgentId).toBe(otherAgentId);
    expect(summary?.lines[0]?.sources.map((s) => s.speaker.id).sort()).toEqual([
      "U0A",
      "U0B",
    ]);

    await marks().markDeleted(mark(channel, b.ts));
    expect(await everyVersion(channel)).toEqual([[], ["line a"], [], []]);
  });

  test("an edit of a source takes its line out of every version as a delete does", async () => {
    const channel = newChannel();
    const [a, b] = [await input(channel), await input(channel)];
    if (!a || !b) throw new Error("inputs");
    await append(channel, 0, [
      { text: "line a", sources: [src(a)] },
      { text: "line b", sources: [src(b)] },
    ]);
    expect(await marks().markEdited(mark(channel, a.ts))).toBe("recorded");
    expect(await everyVersion(channel)).toEqual([[], ["line b"], ["line b"]]);
  });

  test("a delete of a message no line has leaves the version where it was", async () => {
    const channel = newChannel();
    const a = await input(channel);
    const other = await input(channel);
    await append(channel, 0, [{ text: "line a", sources: [src(a)] }]);
    await marks().markDeleted(mark(channel, other.ts));
    expect((await summaries.read(placeOf(channel)))?.version).toBe(1);
  });

  test("a write that read an older version gets a conflict and writes nothing", async () => {
    const channel = newChannel();
    const a = await input(channel);
    const b = await input(channel);
    const first = await append(channel, 0, [
      { text: "line a", sources: [src(a)] },
    ]);
    const stale = await summaries.append({
      place: placeOf(channel),
      agentId,
      expectedVersion: 0,
      lines: [{ text: "line b", sources: [src(b)] }],
    });
    expect(stale).toEqual({ outcome: "conflict", version: 1 });
    expect(
      await summaries.fold({
        place: placeOf(channel),
        agentId,
        expectedVersion: 0,
        lineIds: first.lineIds,
        text: "x",
      }),
    ).toEqual({ outcome: "conflict", version: 1 });
    expect(
      await summaries.revert({
        place: placeOf(channel),
        expectedVersion: 0,
        toVersion: 0,
      }),
    ).toEqual({ outcome: "conflict", version: 1 });
    expect(await everyVersion(channel)).toEqual([[], ["line a"]]);
  });

  test("an input already marked deleted or edited gets no line", async () => {
    const channel = newChannel();
    const [a, b, c] = [
      await input(channel),
      await input(channel),
      await input(channel),
    ];
    if (!a || !b || !c) throw new Error("inputs");
    await marks().markDeleted(mark(channel, a.ts));
    await marks().markEdited(mark(channel, b.ts));
    const written = await append(channel, 0, [
      { text: "line a", sources: [src(a)] },
      { text: "line b", sources: [src(b)] },
      { text: "line c", sources: [src(c)] },
    ]);
    expect(written.skipped.sort()).toEqual([a.id, b.id].sort());
    expect(await everyVersion(channel)).toEqual([[], ["line c"]]);
  });

  test("a write waits for a delete of its source in flight, then leaves the line out", async () => {
    const channel = newChannel();
    const a = await input(channel);
    const deleting = await pool.connect();
    try {
      await deleting.query("BEGIN");
      await drizzle(deleting).execute(
        lockSlackSourceMark({
          workspaceId,
          teamId,
          channelId: channel,
          ts: a.ts,
        }),
      );
      await deleting.query(
        "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at) VALUES ($1, $2, $3, $4, $5)",
        [workspaceId, teamId, channel, a.ts, at],
      );
      let settled = false;
      const writing = summaries
        .append({
          place: placeOf(channel),
          agentId,
          expectedVersion: 0,
          lines: [{ text: "line a", sources: [src(a)] }],
        })
        .then((result) => {
          settled = true;
          return result;
        });
      await Bun.sleep(300);
      expect(settled).toBe(false);
      await deleting.query("COMMIT");
      expect(await writing).toMatchObject({
        outcome: "written",
        lineIds: [],
        skipped: [a.id],
      });
    } finally {
      deleting.release();
    }
    expect((await summaries.read(placeOf(channel)))?.lines).toEqual([]);
  });

  test("a delete waits for a write of its source in flight, then takes the line out", async () => {
    const channel = newChannel();
    const a = await input(channel);
    let deleting: Promise<string> | undefined;
    // The store's own transaction nests as a savepoint; the outer one holds
    // the mark lock it took until it commits.
    await db.transaction(async (tx) => {
      expect(
        await createPostgresChannelSummaryStore(tx).append({
          place: placeOf(channel),
          agentId,
          expectedVersion: 0,
          lines: [{ text: "line a", sources: [src(a)] }],
        }),
      ).toMatchObject({ outcome: "written", version: 1 });
      let settled = false;
      deleting = marks()
        .markDeleted(mark(channel, a.ts))
        .then((result) => {
          settled = true;
          return result;
        });
      await Bun.sleep(300);
      expect(settled).toBe(false);
    });
    expect(await deleting).toBe("recorded");
    expect(await everyVersion(channel)).toEqual([[], [], []]);
  });

  test("a delete waits for a fold of its source in flight, then takes the folded line out", async () => {
    const channel = newChannel();
    const [a, b] = [await input(channel), await input(channel)];
    if (!a || !b) throw new Error("inputs");
    const first = await append(channel, 0, [
      { text: "line a", sources: [src(a)] },
      { text: "line b", sources: [src(b)] },
    ]);
    let deleting: Promise<string> | undefined;
    await db.transaction(async (tx) => {
      expect(
        await createPostgresChannelSummaryStore(tx).fold({
          place: placeOf(channel),
          agentId,
          expectedVersion: 1,
          lineIds: first.lineIds,
          text: "a and b",
        }),
      ).toMatchObject({ outcome: "written", version: 2 });
      let settled = false;
      deleting = marks()
        .markDeleted(mark(channel, a.ts))
        .then((result) => {
          settled = true;
          return result;
        });
      await Bun.sleep(300);
      expect(settled).toBe(false);
    });
    expect(await deleting).toBe("recorded");
    expect(await everyVersion(channel)).toEqual([[], ["line b"], [], []]);
  });

  test("a read in a caller's transaction gives each line its sources", async () => {
    const channel = newChannel();
    const a = await input(channel, "U0IN");
    await append(channel, 0, [{ text: "line a", sources: [src(a)] }]);
    await db.transaction(async (tx) => {
      const summary = await createPostgresChannelSummaryStore(tx).read(
        placeOf(channel),
      );
      expect(
        summary?.lines.map((line) => line.sources.map((s) => s.speaker.id)),
      ).toEqual([["U0IN"]]);
    });
    expect(await summaries.read(placeOf(channel), 2)).toBeNull();
    expect(await summaries.read(placeOf(newChannel()))).toBeNull();
  });

  test("a source must be an input of the writing agent in the channel", async () => {
    const channel = newChannel();
    const elsewhere = await input(newChannel());
    const others = await input(channel, "U0X", otherAgentId);
    for (const source of [elsewhere, others]) {
      expect(
        await summaries.append({
          place: placeOf(channel),
          agentId,
          expectedVersion: 0,
          lines: [{ text: "x", sources: [src(source)] }],
        }),
      ).toEqual({
        outcome: "invalid_source",
        source: { inputId: source.id, slack: null },
      });
    }
    expect(await summaries.read(placeOf(channel))).toBeNull();
  });

  test("deleting a channel's summary leaves no line or history of it and the other channel as it was", async () => {
    const gone = newChannel();
    const kept = newChannel();
    for (const channel of [gone, kept]) {
      const a = await input(channel);
      const first = await append(channel, 0, [
        { text: "line", sources: [src(a)] },
      ]);
      await summaries.fold({
        place: placeOf(channel),
        agentId,
        expectedVersion: 1,
        lineIds: first.lineIds,
        text: "folded",
      });
    }
    expect(await summaries.deleteChannel(placeOf(gone))).toEqual({ lines: 2 });
    const count = async (table: string, channel: string) => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1 AND channel_id = $2`,
        [workspaceId, channel],
      );
      return rows[0].n;
    };
    for (const table of [
      "channel_summaries",
      "channel_summary_lines",
      "channel_summary_line_sources",
    ]) {
      expect(await count(table, gone)).toBe(0);
    }
    expect(await count("channel_summaries", kept)).toBe(1);
    expect(await count("channel_summary_lines", kept)).toBe(2);
    expect(await count("channel_summary_line_sources", kept)).toBe(2);
    expect(await everyVersion(kept)).toEqual([[], ["line"], ["folded"]]);
  });

  test("a mark of a message a summary line points at outlives its retention", async () => {
    const channel = newChannel();
    const a = await input(channel);
    await append(channel, 0, [{ text: "line a", sources: [src(a)] }]);
    // The input row may go before the line (buffer expiry); the line keeps
    // the mark. Written straight in, as no mark store path leaves a line.
    await pool.query("DELETE FROM conversation_inputs WHERE id = $1", [a.id]);
    await pool.query(
      "INSERT INTO edited_sources (workspace_id, team_id, channel_id, ts, edited_at, marked_at) VALUES ($1, $2, $3, $4, $5, now() - interval '1 day')",
      [workspaceId, teamId, channel, a.ts, at],
    );
    await purgeUnknownSlackSourceMarks(db, { limit: 100, dryRun: false });
    const { rows } = await pool.query(
      "SELECT 1 FROM edited_sources WHERE workspace_id = $1 AND channel_id = $2 AND ts = $3",
      [workspaceId, channel, a.ts],
    );
    expect(rows).toHaveLength(1);
  });

  describe("a1/J8 writes", () => {
    const editMark = (channelId: string, ts: string, editedAt: Date) => ({
      workspaceId,
      teamId,
      channelId,
      ts,
      at: editedAt,
    });

    test("an edit removes the lines made from the text before it, not one made from the edited text", async () => {
      const channel = newChannel();
      const [a, c] = [await input(channel), await input(channel)];
      if (!a || !c) throw new Error("inputs");
      const edited = new Date("2026-11-24T00:00:00.000Z");
      // Before: line a was made from a's first text, line a2 from its
      // edited text, line c from c's first text (no edit time: its ts).
      await append(channel, 0, [
        { text: "line a", sources: [src(a)] },
        { text: "line a2", sources: [{ ...src(a), editedAt: edited }] },
        { text: "line c", sources: [src(c)] },
      ]);
      expect(await marks().markEdited(editMark(channel, a.ts, edited))).toBe(
        "recorded",
      );
      // After: only the line made before the edit went, from every version.
      expect(await everyVersion(channel)).toEqual([
        [],
        ["line a2", "line c"],
        ["line a2", "line c"],
      ]);
      const summary = await summaries.read(placeOf(channel));
      expect(
        summary?.lines.find((line) => line.text === "line a2")?.sources[0]?.at,
      ).toEqual(edited);
      // An edit later than the edited text it was made from removes it too.
      await marks().markEdited(
        editMark(channel, a.ts, new Date("2026-11-24T00:05:00.000Z")),
      );
      expect(
        (await summaries.read(placeOf(channel)))?.lines.map((l) => l.text),
      ).toEqual(["line c"]);
      // A line read off text already edited since is not written at all.
      const late = await summaries.append({
        place: placeOf(channel),
        agentId,
        expectedVersion: 3,
        lines: [
          { text: "line a3", sources: [{ ...src(a), editedAt: edited }] },
        ],
      });
      expect(late).toEqual({
        outcome: "written",
        version: 3,
        lineIds: [],
        skipped: [a.id],
      });
    });

    test("a source read off a summary line keeps the time of the text the call read, not a newer line's", async () => {
      const channel = newChannel();
      const a = await input(channel);
      if (!a) throw new Error("input");
      const edited = new Date("2026-11-24T00:00:00.000Z");
      const at = (ts: string) => new Date(Number(ts) * 1000);
      const ofA = (editedAt: Date) => ({
        inputId: null,
        slack: { teamId, channelId: channel, ts: a.ts },
        editedAt,
      });
      // A late call read line A, made from a's first text. Meanwhile the
      // edit removed line A and line B was made from the edited text.
      await append(channel, 0, [{ text: "line A", sources: [src(a)] }]);
      await marks().markEdited(editMark(channel, a.ts, edited));
      // The edit took line A out: a version of its own.
      const afterEdit = (await summaries.read(placeOf(channel)))?.version ?? 0;
      const { version } = await append(channel, afterEdit, [
        { text: "line B", sources: [{ ...src(a), editedAt: edited }] },
      ]);
      // The input row is gone: a is known only by line B's source row.
      await pool.query("DELETE FROM conversation_inputs WHERE id = $1", [a.id]);
      const write = (editedAt: Date) =>
        summaries.append({
          place: placeOf(channel),
          agentId,
          expectedVersion: version,
          lines: [{ text: "line read", sources: [ofA(editedAt)] }],
        });
      expect(await write(at(a.ts))).toEqual({
        outcome: "written",
        version,
        lineIds: [],
        skipped: [a.id],
      });
      // One that read line B is the edited text's, and stays.
      expect(await write(edited)).toMatchObject({
        outcome: "written",
        version: version + 1,
      });
    });

    test("a message the call read that no row names (an engagement's) is kept with no speaker, and its delete removes the line", async () => {
      const channel = newChannel();
      const a = await input(channel, "U0ANN");
      if (!a) throw new Error("input");
      const engaged = "9000.000100";
      const written = await append(channel, 0, [
        {
          text: "line E",
          sources: [
            src(a),
            {
              inputId: null,
              slack: { teamId, channelId: channel, ts: engaged },
            },
          ],
        },
      ]);
      expect(written.lineIds).toHaveLength(1);
      const summary = await summaries.read(placeOf(channel));
      expect(
        new Map(
          summary?.lines[0]?.sources.map((source) => [
            source.ts,
            source.speaker,
          ]),
        ),
      ).toEqual(
        new Map([
          [a.ts, { kind: "slack_bot", id: "U0ANN" }],
          [engaged, { kind: "unknown", id: "" }],
        ]),
      );
      expect(await marks().markDeleted(mark(channel, engaged))).toBe(
        "recorded",
      );
      // After: a version of its own without the line, and none holds it.
      expect(await everyVersion(channel)).toEqual([[], [], []]);
    });

    test("a line keeps every source its call read, and one read off a summary line goes when that line's source is deleted", async () => {
      const channel = newChannel();
      const [a, b, c] = [
        await input(channel, "U0ANN"),
        await input(channel, "U0BOB"),
        await input(channel, "U0CAT"),
      ];
      if (!a || !b || !c) throw new Error("inputs");
      await append(channel, 0, [{ text: "line A", sources: [src(a)] }]);
      // Line B read line A (named by its Slack place, as a fragment does)
      // and b's own post.
      await append(channel, 1, [
        {
          text: "line B",
          sources: [
            { inputId: null, slack: { teamId, channelId: channel, ts: a.ts } },
            src(b),
          ],
        },
      ]);
      await append(channel, 2, [{ text: "line C", sources: [src(c)] }]);
      const summary = await summaries.read(placeOf(channel));
      expect(
        summary?.lines.map((line) => [
          line.text,
          line.sources.map((source) => source.speaker.id),
        ]),
      ).toEqual([
        ["line A", ["U0ANN"]],
        ["line B", ["U0ANN", "U0BOB"]],
        ["line C", ["U0CAT"]],
      ]);
      // The input rows may be gone (judged and dropped): the summary's own
      // source rows still name who said it.
      await pool.query("DELETE FROM conversation_inputs WHERE id = $1", [a.id]);
      await append(channel, 3, [
        {
          text: "line D",
          sources: [{ inputId: a.id, slack: null }],
        },
      ]);
      expect(await marks().markDeleted(mark(channel, a.ts))).toBe("recorded");
      // Before: A, B and D held a among their sources. After: none of them
      // is in any version.
      expect(await everyVersion(channel)).toEqual([
        [],
        [],
        [],
        ["line C"],
        ["line C"],
        ["line C"],
      ]);
    });

    test("two writes that read one version: one loses, then adds only its own line", async () => {
      const channel = newChannel();
      const [a, b] = [await input(channel), await input(channel)];
      if (!a || !b) throw new Error("inputs");
      const write = (text: string, source: { id: ConversationInputId }) =>
        summaries.append({
          place: placeOf(channel),
          agentId,
          expectedVersion: 0,
          lines: [{ text, sources: [src(source)] }],
        });
      const results = await Promise.all([
        write("line a", a),
        write("line b", b),
      ]);
      const lost = results.find((result) => result.outcome === "conflict");
      expect(lost).toEqual({ outcome: "conflict", version: 1 });
      const loser =
        results[0]?.outcome === "conflict" ? ["line a", a] : ["line b", b];
      const again = await summaries.append({
        place: placeOf(channel),
        agentId,
        expectedVersion: 1,
        lines: [
          {
            text: loser[0] as string,
            sources: [src(loser[1] as { id: ConversationInputId })],
          },
        ],
      });
      expect(again).toMatchObject({ outcome: "written", version: 2 });
      const texts = (await summaries.read(placeOf(channel)))?.lines.map(
        (line) => line.text,
      );
      expect([...(texts ?? [])].sort()).toEqual(["line a", "line b"]);
    });

    test("versions current in the last 7 days stay; older ones go, and cannot be read or reverted to", async () => {
      const channel = newChannel();
      const [a, b, c] = [
        await input(channel),
        await input(channel),
        await input(channel),
      ];
      if (!a || !b || !c) throw new Error("inputs");
      const first = await append(channel, 0, [
        { text: "line a", sources: [src(a)] },
      ]);
      await summaries.fold({
        place: placeOf(channel),
        agentId,
        expectedVersion: 1,
        lineIds: first.lineIds,
        text: "folded a",
      });
      await append(channel, 2, [{ text: "line b", sources: [src(b)] }]);
      await append(channel, 3, [{ text: "line c", sources: [src(c)] }]);
      // Versions 0 to 2 were made 10 days ago, 3 and 4 two days ago.
      const day = 24 * 60 * 60_000;
      const now = new Date();
      await pool.query(
        "UPDATE channel_summary_versions SET made_at = $4 WHERE workspace_id = $1 AND team_id = $2 AND channel_id = $3 AND version <= 2",
        [workspaceId, teamId, channel, new Date(now.getTime() - 10 * day)],
      );
      await pool.query(
        "UPDATE channel_summary_versions SET made_at = $4 WHERE workspace_id = $1 AND team_id = $2 AND channel_id = $3 AND version > 2",
        [workspaceId, teamId, channel, new Date(now.getTime() - 2 * day)],
      );
      expect(await everyVersion(channel)).toEqual([
        [],
        ["line a"],
        ["folded a"],
        ["folded a", "line b"],
        ["folded a", "line b", "line c"],
      ]);
      const dry = await pruneChannelSummaryHistory(db, {
        limit: 100,
        dryRun: true,
        now,
      });
      expect(dry.versions).toBeGreaterThanOrEqual(2);
      expect(await summaries.read(placeOf(channel), 1)).not.toBeNull();

      await pruneChannelSummaryHistory(db, { limit: 100, dryRun: false, now });
      // Version 2 was current until version 3, two days ago: kept. 0 and 1
      // stopped being current 10 days ago: gone, with line a, which only
      // they held.
      expect(await summaries.read(placeOf(channel), 0)).toBeNull();
      expect(await summaries.read(placeOf(channel), 1)).toBeNull();
      expect(
        (await summaries.read(placeOf(channel), 2))?.lines.map((l) => l.text),
      ).toEqual(["folded a"]);
      const { rows } = await pool.query(
        "SELECT text FROM channel_summary_lines WHERE workspace_id = $1 AND channel_id = $2 ORDER BY text",
        [workspaceId, channel],
      );
      expect(rows.map((row) => row.text)).toEqual([
        "folded a",
        "line b",
        "line c",
      ]);
      expect(
        await summaries.revert({
          place: placeOf(channel),
          expectedVersion: 4,
          toVersion: 1,
        }),
      ).toEqual({ outcome: "version_not_found" });
      expect(
        await summaries.revert({
          place: placeOf(channel),
          expectedVersion: 4,
          toVersion: 2,
        }),
      ).toMatchObject({ outcome: "written", version: 5 });

      // The current version stays however old it is.
      await pool.query(
        "UPDATE channel_summary_versions SET made_at = $4 WHERE workspace_id = $1 AND team_id = $2 AND channel_id = $3",
        [workspaceId, teamId, channel, new Date(now.getTime() - 30 * day)],
      );
      await pruneChannelSummaryHistory(db, { limit: 100, dryRun: false, now });
      expect(
        (await summaries.read(placeOf(channel)))?.lines.map((l) => l.text),
      ).toEqual(["folded a"]);
      expect(await summaries.read(placeOf(channel), 4)).toBeNull();
    });
  });
});
