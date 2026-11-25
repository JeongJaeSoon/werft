import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationInputId,
  type ConversationTopicId,
  conversationInputIdSchema,
} from "@werft-ai/contracts";
import {
  assembleContext,
  type ContextFragment,
  type ContextFragmentSource,
  type ConversationKey,
  readableScopes,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { createPostgresSlackSourceMarkStore } from "../surface/slack-source-marks.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import { createPostgresChannelSummaryStore } from "./channel-summaries.ts";
import { createPostgresContextFragmentSource } from "./context-fragments.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/** What names a fragment in these tests: its line, its input or its message. */
const idOf = (fragment: ContextFragment) =>
  fragment.kind === "channel_summary_line"
    ? `line:${fragment.lineId}`
    : fragment.kind === "buffered_message"
      ? `input:${fragment.inputId}`
      : `engaged:${fragment.sources[0]?.slack?.ts}`;

integration("context assembler (G1, 9-2 leak table)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let source: ContextFragmentSource;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const secondAgentId = randomUUID();
  const outsideAgentId = randomUUID();
  const requester = randomUUID();
  const otherPerson = randomUUID();
  const teamId = "T0CTX";
  let turnId: number;
  let tsCounter = 1792900000;
  let seq = 0;
  let channelCounter = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "context_assembler" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    source = createPostgresContextFragmentSource(db);
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    for (const id of [requester, otherPerson]) {
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, `${id}@example.invalid`],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
        [workspaceId, id],
      );
    }
    const team = await fixtureTeamSql(pool, workspaceId);
    for (const id of [agentId, secondAgentId, outsideAgentId]) {
      await pool.query(
        "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
        [id, workspaceId, team, `agent-${id.slice(0, 8)}`],
      );
    }
    const session = await newPartitionedSession(db, "context-assembler");
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

  const nextTs = () => {
    tsCounter += 1;
    return `${tsCounter}.000100`;
  };
  const newChannel = (prefix = "C") => {
    channelCounter += 1;
    return `${prefix}0CTX${channelCounter}`;
  };
  const channelKey = (
    channelId: string,
    agent: string = agentId,
  ): Extract<ConversationKey, { kind: "channel" }> => ({
    kind: "channel",
    workspaceId,
    agentId: agent,
    teamId,
    channelId,
  });
  const dmKey = (
    person: string = requester,
    agent: string = agentId,
  ): ConversationKey => ({
    kind: "dm",
    workspaceId,
    agentId: agent,
    personUserId: person,
  });
  const keyName = (key: ConversationKey) =>
    key.kind === "channel"
      ? `${key.agentId}:${key.channelId}`
      : `${key.agentId}:dm:${key.personUserId}`;

  type Place = {
    conversationId: string;
    topicId: ConversationTopicId;
    slackChannelId: string;
    sessionId: string | null;
  };
  const places = new Map<string, Place>();
  /** The conversation of the key, its one topic, and the Slack channel it is in. */
  async function placeOf(key: ConversationKey): Promise<Place> {
    const known = places.get(keyName(key));
    if (known !== undefined) return known;
    const conversations = createPostgresConversationStore(db);
    const conversation = await conversations.findOrCreateConversation(key);
    // A DM's topic names the D… channel as Slack sent it.
    const slackChannelId =
      key.kind === "channel" ? key.channelId : newChannel("D");
    const topic = await conversations.findOrCreateThreadTopic(conversation.id, {
      teamId,
      channelId: slackChannelId,
      threadTs: nextTs(),
    });
    const place = {
      conversationId: conversation.id,
      topicId: topic.id,
      slackChannelId,
      sessionId: null,
    };
    places.set(keyName(key), place);
    return place;
  }

  /** A session of the conversation, as a Slack session gets its parent. */
  async function sessionOf(key: ConversationKey): Promise<string> {
    const place = await placeOf(key);
    if (place.sessionId !== null) return place.sessionId;
    const { sessionId } = await newPartitionedSession(db, "context-engaged");
    await pool.query(
      "UPDATE sessions SET parent_conversation_id = $1 WHERE id = $2",
      [place.conversationId, sessionId],
    );
    place.sessionId = sessionId;
    return sessionId;
  }

  /** A Slack message the agent took part in, in its conversation. */
  async function engaged(key: ConversationKey): Promise<string> {
    const place = await placeOf(key);
    const sessionId = await sessionOf(key);
    const ts = nextTs();
    await pool.query(
      "INSERT INTO conversation_engagements (workspace_id, agent_id, team_id, channel_id, ts, kind, session_id) VALUES ($1, $2, $3, $4, $5, 'bound', $6)",
      [workspaceId, key.agentId, teamId, place.slackChannelId, ts, sessionId],
    );
    return ts;
  }

  /** An unmentioned message held in the agent's buffer. */
  async function buffered(
    key: ConversationKey,
    body = "lunch at noon?",
    expiresInSeconds = 600,
  ): Promise<{ id: ConversationInputId; ts: string; channelId: string }> {
    const place = await placeOf(key);
    const id = conversationInputIdSchema.parse(randomUUID());
    const ts = nextTs();
    seq += 1;
    await pool.query(
      "INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id, body, buffer_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'slack_user', 'U0POSTER', $9, now() + make_interval(secs => $10))",
      [
        id,
        workspaceId,
        key.agentId,
        place.topicId,
        seq,
        teamId,
        place.slackChannelId,
        ts,
        body,
        expiresInSeconds,
      ],
    );
    return { id, ts, channelId: place.slackChannelId };
  }

  /** A summary line of the channel, written by the key's agent from a message it took. */
  async function summed(
    key: Extract<ConversationKey, { kind: "channel" }>,
    text = "the team agreed on Friday",
  ): Promise<{ lineId: string; ts: string }> {
    const place = await placeOf(key);
    const inputId = conversationInputIdSchema.parse(randomUUID());
    const ts = nextTs();
    seq += 1;
    await pool.query(
      "INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id, turn_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'slack_bot', 'U0SPEAKER', $9)",
      [
        inputId,
        workspaceId,
        key.agentId,
        place.topicId,
        seq,
        teamId,
        key.channelId,
        ts,
        turnId,
      ],
    );
    const summaries = createPostgresChannelSummaryStore(db);
    const summaryPlace = { workspaceId, teamId, channelId: key.channelId };
    const current = await summaries.read(summaryPlace);
    const written = await summaries.append({
      place: summaryPlace,
      agentId: key.agentId,
      expectedVersion: current?.version ?? 0,
      lines: [{ text, sources: [{ inputId, slack: null }] }],
    });
    if (written.outcome !== "written") throw new Error(written.outcome);
    return { lineId: written.lineIds[0] as string, ts };
  }

  const assemble = (key: ConversationKey) => assembleContext(source, key);
  const ids = async (key: ConversationKey) =>
    (await assemble(key)).map(idOf).sort();
  /** Every fragment is tagged with a scope the conversation reads. */
  async function expectContained(key: ConversationKey) {
    const readable = new Set<string>(readableScopes(key));
    const result = await assemble(key);
    for (const fragment of result)
      expect(readable.has(fragment.scope)).toBe(true);
    return result;
  }
  const deleteMark = (channelId: string, ts: string) =>
    pool.query(
      "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at) VALUES ($1, $2, $3, $4, now())",
      [workspaceId, teamId, channelId, ts],
    );

  test("a channel conversation gets its summary lines, engagements and buffered messages, each with its channel scope and sources", async () => {
    const channel = newChannel();
    const key = channelKey(channel);
    const line = await summed(key);
    const engagedTs = await engaged(key);
    const held = await buffered(key, "anyone free?");
    const result = await expectContained(key);
    const scope = String(readableScopes(key)[0]);
    expect(result.map((f) => [f.kind, String(f.scope)])).toEqual([
      ["channel_summary_line", scope],
      ["engagement", scope],
      ["buffered_message", scope],
    ]);
    expect(result.map((f) => f.sources)).toEqual([
      [
        {
          inputId: expect.any(String),
          slack: { teamId, channelId: channel, ts: line.ts },
        },
      ],
      [{ inputId: null, slack: { teamId, channelId: channel, ts: engagedTs } }],
      [
        {
          inputId: held.id,
          slack: { teamId, channelId: channel, ts: held.ts },
        },
      ],
    ]);
    expect(result[2]).toMatchObject({
      body: "anyone free?",
      poster: { kind: "slack_user", id: "U0POSTER" },
    });
  });

  test("9-2 row 1 (DM record -> channel reply): the DM's engagements and messages are not in a channel's assembly", async () => {
    const channel = newChannel();
    const dmEngaged = await engaged(dmKey());
    const dmHeld = await buffered(dmKey(), "my salary question");
    await engaged(channelKey(channel));
    const channelIds = await ids(channelKey(channel));
    expect(channelIds).not.toContain(`engaged:${dmEngaged}`);
    expect(channelIds).not.toContain(`input:${dmHeld.id}`);
    const dm = await expectContained(dmKey());
    expect(dm.map(idOf)).toEqual(
      expect.arrayContaining([`engaged:${dmEngaged}`, `input:${dmHeld.id}`]),
    );
  });

  test("9-2 row 2 (requester's personal scope -> public reply): a public channel's assembly holds no person-scope fragment of its requester", async () => {
    const channel = newChannel();
    await engaged(dmKey(requester));
    await buffered(dmKey(requester));
    await summed(channelKey(channel));
    const result = await expectContained(channelKey(channel));
    expect(result.length).toBeGreaterThan(0);
    expect(result.filter((f) => f.scope.startsWith("person:"))).toEqual([]);
  });

  test("9-2 row 3 (private channel summary -> other channel or DM): private channel A's summary is in neither channel B's nor a DM's assembly", async () => {
    const privateA = newChannel("G");
    const channelB = newChannel();
    const line = await summed(channelKey(privateA), "the private plan");
    await summed(channelKey(channelB));
    expect(await ids(channelKey(privateA))).toContain(`line:${line.lineId}`);
    expect(await ids(channelKey(channelB))).not.toContain(
      `line:${line.lineId}`,
    );
    await engaged(dmKey());
    expect(await ids(dmKey())).not.toContain(`line:${line.lineId}`);
    await expectContained(channelKey(channelB));
    await expectContained(dmKey());
  });

  test("9-2 row 4 (public channel summary -> other channel): two public channels do not mix", async () => {
    const one = newChannel();
    const two = newChannel();
    const lineOne = await summed(channelKey(one), "one");
    const lineTwo = await summed(channelKey(two), "two");
    const heldOne = await buffered(channelKey(one));
    expect(await ids(channelKey(one))).toEqual(
      [`input:${heldOne.id}`, `line:${lineOne.lineId}`].sort(),
    );
    expect(await ids(channelKey(two))).toEqual([`line:${lineTwo.lineId}`]);
  });

  test("9-2 row 5 (channel summary -> agent memory): assembling promotes nothing and reads no memory, the agent's or the requester's", async () => {
    const channel = newChannel();
    const line = await summed(channelKey(channel));
    // Memory a reader could pick up: active with a clean revision, the
    // agent's own and its requester's.
    for (const [scope, column, owner] of [
      ["agent", "agent_id", agentId],
      ["personal", "subject_user_id", requester],
    ] as const) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO memory_documents (id, workspace_id, scope, ${column}, state) VALUES ($1, $2, $3, $4, 'candidate')`,
        [id, workspaceId, scope, owner],
      );
      await pool.query(
        "INSERT INTO memory_revisions (document_id, revision, title, body, body_sha256, scan_status, author_user_id) VALUES ($1, 1, 'deploy notes', 'deploys go out on Friday', $2, 'clean', $3)",
        [id, "a".repeat(64), requester],
      );
      await pool.query(
        "UPDATE memory_documents SET state = 'active', current_revision = 1 WHERE id = $1",
        [id],
      );
    }
    const count = async () =>
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM memory_documents) + (SELECT count(*) FROM channel_summary_lines) AS n",
        )
      ).rows[0].n;
    const before = await count();
    const result = await expectContained(channelKey(channel));
    expect(await count()).toBe(before);
    expect(result.map(idOf)).toEqual([`line:${line.lineId}`]);
    expect(await assemble(dmKey(requester))).not.toContainEqual(
      expect.objectContaining({ scope: expect.stringMatching(/^agent:/) }),
    );
  });

  test("9-2 row 6 (work started in a DM -> channel): a DM session's engagements stay in the DM", async () => {
    const channel = newChannel();
    const other = otherPerson;
    const fromDm = await engaged(dmKey(other));
    expect(await ids(channelKey(channel))).not.toContain(`engaged:${fromDm}`);
    expect(await ids(dmKey(requester))).not.toContain(`engaged:${fromDm}`);
    expect(await ids(dmKey(other))).toContain(`engaged:${fromDm}`);
  });

  test("9-2 row 7 (other channel's or DM's message -> channel work): buffered messages of another channel or a DM are not read", async () => {
    const channel = newChannel();
    const elsewhere = newChannel();
    const there = await buffered(channelKey(elsewhere));
    const dm = await buffered(dmKey());
    const here = await buffered(channelKey(channel));
    expect(await ids(channelKey(channel))).toEqual([`input:${here.id}`]);
    expect(await ids(channelKey(elsewhere))).toContain(`input:${there.id}`);
    expect(await ids(dmKey())).toContain(`input:${dm.id}`);
  });

  test("9-2 row 8 (work started in a private channel -> elsewhere): its engagements are only in that channel's assembly (session lists are 94S-1999's)", async () => {
    const privateA = newChannel("G");
    const channelB = newChannel();
    const ts = await engaged(channelKey(privateA));
    expect(await ids(channelKey(privateA))).toContain(`engaged:${ts}`);
    expect(await ids(channelKey(channelB))).not.toContain(`engaged:${ts}`);
    expect(await ids(dmKey())).not.toContain(`engaged:${ts}`);
  });

  test("9-2 row 9 (shared channel summary): two agents in a channel read the same summary; an agent not in it reads nothing, and each reads only its own engagements and buffer", async () => {
    const channel = newChannel();
    const first = await summed(channelKey(channel, agentId), "first");
    const second = await summed(channelKey(channel, secondAgentId), "second");
    const mine = await buffered(channelKey(channel, agentId));
    const theirs = await engaged(channelKey(channel, secondAgentId));
    const lines = async (agent: string) =>
      (await assemble(channelKey(channel, agent)))
        .filter((f) => f.kind === "channel_summary_line")
        .map(idOf)
        .sort();
    const both = [`line:${first.lineId}`, `line:${second.lineId}`].sort();
    expect(await lines(agentId)).toEqual(both);
    expect(await lines(secondAgentId)).toEqual(both);
    expect(await ids(channelKey(channel, agentId))).not.toContain(
      `engaged:${theirs}`,
    );
    expect(await ids(channelKey(channel, secondAgentId))).not.toContain(
      `input:${mine.id}`,
    );
    expect(await assemble(channelKey(channel, outsideAgentId))).toEqual([]);
  });

  test("a fragment with a deleted source is left out: Slack's delete through the marks, and a mark the assembler alone sees (check place 1)", async () => {
    const channel = newChannel();
    const key = channelKey(channel);
    const goneLine = await summed(key, "gone");
    const keptLine = await summed(key, "kept");
    const goneEngaged = await engaged(key);
    const keptEngaged = await engaged(key);
    const goneHeld = await buffered(key);
    const marks = createPostgresSlackSourceMarkStore(db);
    for (const ts of [goneLine.ts, goneEngaged, goneHeld.ts]) {
      await marks.markDeleted({
        workspaceId,
        teamId,
        channelId: channel,
        ts,
        at: new Date(),
      });
    }
    expect(await ids(key)).toEqual(
      [`engaged:${keptEngaged}`, `line:${keptLine.lineId}`].sort(),
    );
    // The engagement row stays (its mark is kept for it); only the assembler drops it.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_engagements WHERE workspace_id = $1 AND ts = $2",
      [workspaceId, goneEngaged],
    );
    expect(rows[0].n).toBe(1);
    // A mark the line and the buffer have not been cleared for yet.
    const lateLine = await summed(key, "late");
    const lateHeld = await buffered(key);
    await deleteMark(channel, lateLine.ts);
    await deleteMark(channel, lateHeld.ts);
    expect(await ids(key)).toEqual(
      [`engaged:${keptEngaged}`, `line:${keptLine.lineId}`].sort(),
    );
  });

  test("the read counts what it left out because its source is gone", async () => {
    const channel = newChannel();
    const key = channelKey(channel);
    const line = await summed(key, "kept");
    const goneEngaged = await engaged(key);
    const goneHeld = await buffered(key);
    const first = await buffered(key, "first");
    const second = await buffered(key, "second");
    await deleteMark(channel, goneEngaged);
    await deleteMark(channel, goneHeld.ts);
    const read = await source.read(key);
    expect(read.unreadable).toBe(2);
    expect(read.fragments).toHaveLength(3);
    expect(read.fragments[0]).toMatchObject({ lineId: line.lineId });
    // Each text read again lands on its own input.
    expect(read.fragments.slice(1)).toMatchObject([
      { inputId: first.id, body: "first" },
      { inputId: second.id, body: "second" },
    ]);
  });

  test("a buffered message whose time is up is not read before the purge removes it", async () => {
    const channel = newChannel();
    const live = await buffered(channelKey(channel), "live", 600);
    await buffered(channelKey(channel), "expired", -1);
    expect(await ids(channelKey(channel))).toEqual([`input:${live.id}`]);
  });

  test("property: in a random world of channels, DMs and agents, every fragment of every assembly is in that conversation's readable scopes, and is exactly what was made for it, less what was deleted", async () => {
    // mulberry32, fixed seed: the same world every run.
    let state = 94_2015;
    const draw = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(draw() * items.length)] as T;
    const channels = [
      newChannel(),
      newChannel(),
      newChannel("G"),
      newChannel("G"),
    ];
    const agents = [agentId, secondAgentId];
    // People of this world only: the tests before it left DM fragments.
    const people: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, `${id}@example.invalid`],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
        [workspaceId, id],
      );
      people.push(id);
    }
    const keys: ConversationKey[] = [
      ...agents.flatMap((agent) =>
        channels.map((channel) => channelKey(channel, agent)),
      ),
      ...agents.flatMap((agent) =>
        people.map((person) => dmKey(person, agent)),
      ),
    ];
    // What each conversation should read: its own fragments, and a channel
    // conversation every summary line of its channel.
    const expected = new Map<string, Set<string>>(
      keys.map((key) => [keyName(key), new Set()]),
    );
    const channelLines = new Map<string, Set<string>>(
      channels.map((c) => [c, new Set()]),
    );
    const deleted = new Set<string>();
    for (let step = 0; step < 60; step += 1) {
      const key = pick(keys);
      const what =
        key.kind === "channel"
          ? pick(["line", "engaged", "held"] as const)
          : pick(["engaged", "held"] as const);
      let id: string;
      let at: { channelId: string; ts: string };
      if (what === "line" && key.kind === "channel") {
        const line = await summed(key, `line ${step}`);
        id = `line:${line.lineId}`;
        at = { channelId: key.channelId, ts: line.ts };
        channelLines.get(key.channelId)?.add(id);
      } else if (what === "engaged") {
        const ts = await engaged(key);
        id = `engaged:${ts}`;
        at = { channelId: (await placeOf(key)).slackChannelId, ts };
        expected.get(keyName(key))?.add(id);
      } else {
        const held = await buffered(key, `message ${step}`);
        id = `input:${held.id}`;
        at = { channelId: held.channelId, ts: held.ts };
        expected.get(keyName(key))?.add(id);
      }
      if (draw() < 0.15) {
        await deleteMark(at.channelId, at.ts);
        deleted.add(id);
      }
    }
    let fragments = 0;
    for (const key of keys) {
      const result = await expectContained(key);
      const want = [
        ...(expected.get(keyName(key)) ?? []),
        ...(key.kind === "channel"
          ? (channelLines.get(key.channelId) ?? [])
          : []),
      ].filter((id) => !deleted.has(id));
      expect(result.map(idOf).sort()).toEqual(want.sort());
      fragments += result.length;
    }
    expect(fragments).toBeGreaterThan(0);
    expect(deleted.size).toBeGreaterThan(0);
    console.info(
      `G1 property (db): ${keys.length} conversations, ${fragments} fragments read, ${deleted.size} deleted left out`,
    );
  }, 120_000);
});
