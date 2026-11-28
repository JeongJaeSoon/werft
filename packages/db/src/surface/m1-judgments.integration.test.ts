import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationInputId,
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
  M1_PROMPT_VERSION,
} from "@werft-ai/contracts";
import {
  type JudgmentBatch,
  M1_SUMMARY_WRITE_ATTEMPTS,
  type M1Record,
  writeM1SummaryLine,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  appendChannelSummaryLines,
  createPostgresChannelSummaryStore,
  deleteChannelSummary,
  holdChannelSummary,
} from "../conversations/channel-summaries.ts";
import { requestReplyJudgment } from "../conversations/conversation-judgments.ts";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { createPostgresJudgmentBatchStore } from "../conversations/judgment-batches.ts";
import { holdBufferedInput } from "../conversations/judgment-buffer.ts";
import { createPostgresSurfaceBindingStore } from "../musterrolle/surface-bindings.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "../testing/spec-pins.ts";
import { createPostgresM1JudgmentStore } from "./m1-judgments.ts";
import { createPostgresSlackSourceMarkStore } from "./slack-source-marks.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("M1 judgment records", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const releaseId = `rel-${randomUUID()}`;
  const TEAM = "T0M1";
  let installationId = "";
  // Another agent of the workspace in the same Slack team, by its own app.
  const otherAgentId = randomUUID();
  let otherInstallationId = "";
  let channelSeq = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "m1_judgments" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Database;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status, conversation_rollout) VALUES ($1, $2, $3, 'judged', 'judged', 'active', 'shadow')",
      [agentId, workspaceId, team],
    );
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status, conversation_rollout) VALUES ($1, $2, $3, 'other', 'other', 'active', 'shadow')",
      [otherAgentId, workspaceId, team],
    );
    const versionId = randomUUID();
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         repository_id, runtime_config_snapshot, effective_tools, policy_pins,
         ${RELEASE_SPEC_SQL_COLUMNS})
       VALUES ($1, $2, $3, $4, 'sample-app', '{}', '{}', '{}', ${releaseSpecSqlValues()})`,
      [releaseId, agentId, versionId, "a".repeat(64)],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    installationId = randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0M1', $3)",
      [installationId, workspaceId, TEAM],
    );
    otherInstallationId = randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0M1OTHER', $3)",
      [otherInstallationId, workspaceId, TEAM],
    );
    await pool.query(
      `INSERT INTO agent_identities
         (id, workspace_id, agent_id, provider, installation_id, external_principal_id, credential_ref)
       VALUES ($1, $2, $3, 'slack_bot', $4, 'U0BOTM1', 'slack/bot-m1')`,
      [randomUUID(), workspaceId, agentId, installationId],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  /** A channel heard free, with one thread's topic. */
  async function channel(options: { externalShared?: boolean } = {}) {
    const channelId = `C${String(++channelSeq).padStart(6, "0")}`;
    await pool.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
        installation_id, external_surface_id, surface_kind, mode, listen,
        ceiling_actions, ceiling_disclosure, status, external_shared)
       VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
        '{}', 'full', 'ready', $6)`,
      [
        randomUUID(),
        workspaceId,
        agentId,
        installationId,
        channelId,
        options.externalShared ?? false,
      ],
    );
    const store = createPostgresConversationStore(db);
    const conversation = await store.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId,
      teamId: TEAM,
      channelId,
    });
    const topic = await store.findOrCreateThreadTopic(conversation.id, {
      teamId: TEAM,
      channelId,
      threadTs: "100.000100",
    });
    return {
      channelId,
      conversationId: conversation.id,
      topicId: topic.id as ConversationTopicId,
    };
  }

  type Place = Awaited<ReturnType<typeof channel>>;

  async function hold(
    place: Place,
    ts: string,
    body: string,
    judgment?: "m1_engaged",
  ) {
    await db.transaction((tx) =>
      holdBufferedInput(
        tx,
        { workspaceId, agentId, teamId: TEAM },
        {
          topicId: place.topicId,
          channelId: place.channelId,
          ts,
          buffered: { body, slackUserId: "U0PERSON" },
          ...(judgment === undefined ? {} : { judgment }),
        },
        JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
      ),
    );
    const { rows } = await pool.query<{ id: ConversationInputId }>(
      "SELECT id FROM conversation_inputs WHERE slack_channel_id = $1 AND slack_ts = $2",
      [place.channelId, ts],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("not held");
    return id;
  }

  const judgedRecord = (key: string, refs: string[]): M1Record => ({
    verdict: {
      outcome: "judged",
      decision: "quiet",
      reason: "human_conversation",
    },
    refs,
    sources: { keys: [], overflow: false },
    releaseId,
    callKey: `${key}:m1` as never,
    attempts: 1,
    summary: null,
    target: null,
  });

  const rowsOf = async (channelId: string) =>
    (
      await pool.query(
        "SELECT * FROM conversation_judgments WHERE slack_channel_id = $1 ORDER BY created_at, judged_at NULLS FIRST",
        [channelId],
      )
    ).rows;

  test("with the switch off the gate is closed and nothing is written", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db);
    // Held while the switch is up, then judged after it went off.
    const inputId = await hold(place, "200.000001", "chatter");
    await pool.query(
      "UPDATE agents SET conversation_rollout = 'off' WHERE id = $1",
      [agentId],
    );
    try {
      const place4 = {
        workspaceId,
        agentId,
        teamId: TEAM,
        channelId: place.channelId,
      };
      expect(await store.gateOpen(place4)).toBe(false);
      const written = await store.recordBatch(
        {
          id: randomUUID() as never,
          workspaceId,
          agentId,
          conversationId: place.conversationId,
          teamId: TEAM,
          channelId: place.channelId,
          releaseId,
          inputs: [],
        },
        judgedRecord("k", ["200.000001"]),
        [{ inputId, ts: "200.000001", body: "chatter", editMark: null }],
      );
      expect(written).toEqual({ outcome: "closed" });
      expect(await rowsOf(place.channelId)).toEqual([]);
    } finally {
      await pool.query(
        "UPDATE agents SET conversation_rollout = 'shadow' WHERE id = $1",
        [agentId],
      );
    }
  });

  test("an externally shared channel's gate is closed", async () => {
    const place = await channel({ externalShared: true });
    const store = createPostgresM1JudgmentStore(db);
    expect(
      await store.gateOpen({
        workspaceId,
        agentId,
        teamId: TEAM,
        channelId: place.channelId,
      }),
    ).toBe(false);
  });

  test("an emergency-stopped channel's gate is closed, so no reply waiting for a judgment is called", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db);
    const at = {
      workspaceId,
      agentId,
      teamId: TEAM,
      channelId: place.channelId,
    };
    expect(await store.gateOpen(at)).toBe(true);
    await pool.query(
      `UPDATE surface_bindings SET mode = 'off', emergency_stopped_at = now(),
         emergency_stop_reason = 'a leak suspected' WHERE external_surface_id = $1`,
      [place.channelId],
    );
    expect(await store.gateOpen(at)).toBe(false);
  });

  test("a batch's record holds refs and codes, and its judged posts leave the buffer", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db);
    const judged = await hold(place, "300.000001", "secret words one");
    const left = await hold(place, "300.000002", "secret words two");
    const batchStore = createPostgresJudgmentBatchStore(db);
    await pool.query(
      "UPDATE conversation_inputs SET received_at = now() - interval '20 seconds' WHERE slack_channel_id = $1",
      [place.channelId],
    );
    const closed = await batchStore.closeNext();
    if (closed?.outcome !== "judging") throw new Error("no batch");
    expect(closed.batch.channelId).toBe(place.channelId);
    expect(
      await store.recordBatch(
        closed.batch,
        judgedRecord(closed.batch.id, ["300.000001"]),
        [
          {
            inputId: judged,
            ts: "300.000001",
            body: "secret words one",
            editMark: null,
          },
        ],
      ),
    ).toMatchObject({ outcome: "written" });
    const [row] = await rowsOf(place.channelId);
    expect(row).toMatchObject({
      grade: "buffer_m1",
      refs: ["300.000001"],
      judgment_batch_id: closed.batch.id,
      outcome: "judged",
      decision: "quiet",
      reason: "human_conversation",
      prompt_version: M1_PROMPT_VERSION,
      attempts: 1,
      release_id: releaseId,
    });
    expect(JSON.stringify(row)).not.toContain("secret words");
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM conversation_inputs WHERE slack_channel_id = $1 AND body IS NOT NULL",
      [place.channelId],
    );
    expect(rows.map((r) => r.id)).toEqual([left]);
  });

  describe("a batch's summary line (a1/J8)", () => {
    async function closedBatch(place: Place, posts: [string, string][]) {
      for (const [ts, body] of posts) await hold(place, ts, body);
      await pool.query(
        "UPDATE conversation_inputs SET received_at = now() - interval '20 seconds' WHERE slack_channel_id = $1",
        [place.channelId],
      );
      const closed = await createPostgresJudgmentBatchStore(db).closeNext();
      if (closed?.outcome !== "judging") throw new Error("no batch");
      return closed.batch;
    }
    const draftOf = (
      batch: JudgmentBatch,
      text: string,
      expectedVersion = 0,
    ) => ({
      text,
      expectedVersion,
      sources: batch.inputs.map((input) => ({
        inputId: input.inputId,
        slack: { teamId: TEAM, channelId: batch.channelId, ts: input.ts },
        editedAt: input.editedAt ?? null,
      })),
      messages: batch.inputs.map((input) => input.body),
    });
    const placeOf = (batch: JudgmentBatch) => ({
      workspaceId,
      teamId: TEAM,
      channelId: batch.channelId,
    });
    /** Another agent's write landing first: a line on the summary's version now. */
    async function rival(
      batch: JudgmentBatch,
      sourceInput: ConversationInputId,
    ) {
      const summaries = createPostgresChannelSummaryStore(db);
      const now = await summaries.read(placeOf(batch));
      const written = await summaries.append({
        place: placeOf(batch),
        agentId,
        expectedVersion: now?.version ?? 0,
        lines: [
          {
            text: "rival line",
            sources: [{ inputId: sourceInput, slack: null }],
          },
        ],
      });
      if (written.outcome !== "written") throw new Error(written.outcome);
    }

    test("is written with the server's speakers before the buffer goes, again after a lost compare", async () => {
      const place = await channel();
      const store = createPostgresM1JudgmentStore(db);
      const batch = await closedBatch(place, [
        ["500.000001", "when does the release go out?"],
        ["500.000002", "friday, after the freeze"],
      ]);
      const other = await hold(place, "500.000009", "unrelated");
      // The call read version 0; another write made version 1 meanwhile.
      await rival(batch, other);
      const outcome = await writeM1SummaryLine(
        store,
        batch,
        draftOf(
          batch,
          "someone asked when the release goes out; another said Friday",
        ),
      );
      expect(outcome).toBe("written");
      const judged = batch.inputs.map(({ inputId, ts, body, editMark }) => ({
        inputId,
        ts,
        body,
        editMark,
      }));
      expect(
        await store.recordBatch(
          batch,
          {
            ...judgedRecord(batch.id, ["500.000001", "500.000002"]),
            summary: outcome,
          },
          judged,
        ),
      ).toMatchObject({ outcome: "written" });
      const summary = await createPostgresChannelSummaryStore(db).read(
        placeOf(batch),
      );
      expect(summary?.version).toBe(2);
      expect(
        summary?.lines.map((line) => [
          line.text,
          line.sources.map((source) => [source.ts, source.speaker.id]),
        ]),
      ).toEqual([
        ["rival line", [["500.000009", "U0PERSON"]]],
        [
          "someone asked when the release goes out; another said Friday",
          [
            ["500.000001", "U0PERSON"],
            ["500.000002", "U0PERSON"],
          ],
        ],
      ]);
      // After: the judged posts' rows are gone, the line and its sources stay.
      const { rows } = await pool.query(
        "SELECT id FROM conversation_inputs WHERE id = ANY($1::uuid[])",
        [judged.map((post) => post.inputId)],
      );
      expect(rows).toEqual([]);
      const [row] = await rowsOf(place.channelId);
      expect(row).toMatchObject({
        summary: "written",
        prompt_version: M1_PROMPT_VERSION,
      });
    });

    test("a channel delete and a write under the gate take the binding, then the summary, so neither waits on the other", async () => {
      const place = await channel();
      const first = await hold(place, "800.000001", "first post");
      const second = await hold(place, "800.000002", "second post");
      const summaryPlace = {
        workspaceId,
        teamId: TEAM,
        channelId: place.channelId,
      };
      const summaries = createPostgresChannelSummaryStore(db);
      const made = await summaries.append({
        place: summaryPlace,
        agentId,
        expectedVersion: 0,
        lines: [
          { text: "first line", sources: [{ inputId: first, slack: null }] },
        ],
      });
      if (made.outcome !== "written") throw new Error(made.outcome);
      let deletion: Promise<boolean> = Promise.resolve(false);
      const written = await db.transaction(async (tx) => {
        // The binding as writeSummaryLine's gate holds it.
        await tx.execute(sql`
          SELECT 1 FROM surface_bindings
          WHERE agent_id = ${agentId}::uuid AND surface = 'slack'
            AND external_surface_id = ${place.channelId}
          FOR SHARE`);
        // The delete starts now and waits on that binding.
        deletion = createPostgresSurfaceBindingStore(db).channelDeleted(
          installationId,
          place.channelId,
          null,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        return appendChannelSummaryLines(tx, {
          place: summaryPlace,
          expectedVersion: 1,
          agentId,
          lines: [
            {
              text: "second line",
              sources: [{ inputId: second, slack: null }],
            },
          ],
        });
      });
      expect(written).toMatchObject({ outcome: "written", version: 2 });
      expect(await deletion).toBe(true);
      // After: the delete ran second and took the summary with it.
      expect(await summaries.read(summaryPlace)).toBeNull();
    });

    test("a write after the channel's delete makes no summary again", async () => {
      const place = await channel();
      const store = createPostgresM1JudgmentStore(db);
      const batch = await closedBatch(place, [
        ["810.000001", "is this channel going away?"],
      ]);
      // An earlier binding of the channel, revoked, stays behind.
      await pool.query(
        `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
          installation_id, external_surface_id, surface_kind, mode, listen,
          ceiling_actions, ceiling_disclosure, status, revoked_at)
         VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
          '{}', 'full', 'revoked', now())`,
        [randomUUID(), workspaceId, agentId, installationId, place.channelId],
      );
      // The channel went while the call ran.
      expect(
        await createPostgresSurfaceBindingStore(db).channelDeleted(
          installationId,
          place.channelId,
          null,
        ),
      ).toBe(true);
      expect(
        await store.writeSummaryLine(
          batch,
          draftOf(batch, "someone asked if the channel goes away"),
        ),
      ).toEqual({ outcome: "channel_gone" });
      expect(
        await createPostgresChannelSummaryStore(db).read(placeOf(batch)),
      ).toBeNull();
      const { rows } = await pool.query(
        "SELECT (SELECT count(*) FROM channel_summary_lines WHERE channel_id = $1)::int AS lines, (SELECT count(*) FROM channel_summary_line_sources WHERE channel_id = $1)::int AS sources",
        [place.channelId],
      );
      expect(rows[0]).toEqual({ lines: 0, sources: 0 });
    });

    /** The other agent's binding of the channel, in use. */
    async function otherBinding(channelId: string) {
      await pool.query(
        `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
          installation_id, external_surface_id, surface_kind, mode, listen,
          ceiling_actions, ceiling_disclosure, status)
         VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
          '{}', 'full', 'ready')`,
        [
          randomUUID(),
          workspaceId,
          otherAgentId,
          otherInstallationId,
          channelId,
        ],
      );
    }

    test("another agent's channel delete, committed first, keeps the shared summary gone", async () => {
      const place = await channel();
      await otherBinding(place.channelId);
      const store = createPostgresM1JudgmentStore(db);
      const batch = await closedBatch(place, [
        ["830.000001", "did the channel just go?"],
      ]);
      // The other agent's event came first; this agent's is still to come.
      expect(
        await createPostgresSurfaceBindingStore(db).channelDeleted(
          otherInstallationId,
          place.channelId,
          null,
        ),
      ).toBe(true);
      expect(
        await writeM1SummaryLine(
          store,
          batch,
          draftOf(batch, "someone asked if the channel went"),
        ),
      ).toBe("channel_gone");
      const { rows } = await pool.query(
        "SELECT (SELECT count(*) FROM channel_summaries WHERE channel_id = $1)::int AS summaries, (SELECT count(*) FROM channel_summary_versions WHERE channel_id = $1)::int AS versions",
        [place.channelId],
      );
      expect(rows[0]).toEqual({ summaries: 0, versions: 0 });
    });

    test("a write that comes while another agent's channel delete runs waits for it, then writes nothing", async () => {
      const place = await channel();
      await otherBinding(place.channelId);
      const store = createPostgresM1JudgmentStore(db);
      const batch = await closedBatch(place, [
        ["840.000001", "is anyone archiving this?"],
      ]);
      let settled = false;
      let write: Promise<unknown> = Promise.resolve();
      await db.transaction(async (tx) => {
        // The delete's steps: the summary's row held and removed, the
        // binding gone.
        await holdChannelSummary(tx, placeOf(batch));
        await deleteChannelSummary(tx, placeOf(batch));
        await tx.execute(sql`
          UPDATE surface_bindings SET status = 'gone', revision = revision + 1
          WHERE agent_id = ${otherAgentId}::uuid
            AND external_surface_id = ${place.channelId}`);
        write = store
          .writeSummaryLine(
            batch,
            draftOf(batch, "someone asked about archiving"),
          )
          .then((result) => {
            settled = true;
            return result;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Before: the write waits on the held row.
        expect(settled).toBe(false);
      });
      // After: it saw the binding gone and wrote nothing.
      expect(await write).toEqual({ outcome: "channel_gone" });
      const { rows } = await pool.query(
        "SELECT (SELECT count(*) FROM channel_summaries WHERE channel_id = $1)::int AS summaries, (SELECT count(*) FROM channel_summary_versions WHERE channel_id = $1)::int AS versions",
        [place.channelId],
      );
      expect(rows[0]).toEqual({ summaries: 0, versions: 0 });
    });

    test("three lost compares in a row drop the line and the record says so", async () => {
      const place = await channel();
      const store = createPostgresM1JudgmentStore(db);
      const batch = await closedBatch(place, [
        ["600.000001", "who owns the oncall rota?"],
      ]);
      const other = await hold(place, "600.000009", "unrelated");
      let writes = 0;
      const racing = {
        writeSummaryLine: async (
          b: JudgmentBatch,
          line: Parameters<typeof store.writeSummaryLine>[1],
        ) => {
          writes += 1;
          await rival(b, other);
          return store.writeSummaryLine(b, line);
        },
      };
      const outcome = await writeM1SummaryLine(
        racing,
        batch,
        draftOf(batch, "someone asked who owns the oncall rota"),
      );
      expect(outcome).toBe("lost");
      expect(writes).toBe(M1_SUMMARY_WRITE_ATTEMPTS);
      await store.recordBatch(
        batch,
        { ...judgedRecord(batch.id, ["600.000001"]), summary: outcome },
        batch.inputs.map(({ inputId, ts, body, editMark }) => ({
          inputId,
          ts,
          body,
          editMark,
        })),
      );
      const summary = await createPostgresChannelSummaryStore(db).read(
        placeOf(batch),
      );
      expect(summary?.lines.map((line) => line.text)).toEqual([
        "rival line",
        "rival line",
        "rival line",
      ]);
      const [row] = await rowsOf(place.channelId);
      expect(row).toMatchObject({ summary: "lost", outcome: "judged" });
    });

    test("one made from a body edited before the judgment survives that edit", async () => {
      const place = await channel();
      const store = createPostgresM1JudgmentStore(db);
      await hold(place, "700.000001", "deploy at 3pm");
      const edited = new Date("2026-11-25T01:00:00.000Z");
      const marks = createPostgresSlackSourceMarkStore(db);
      const mark = {
        workspaceId,
        teamId: TEAM,
        channelId: place.channelId,
        ts: "700.000001",
      };
      expect(
        await marks.markEdited({ ...mark, at: edited }, "deploy at 4pm"),
      ).toBe("recorded");
      const batch = await closedBatch(place, []);
      expect(batch.inputs[0]).toMatchObject({
        body: "deploy at 4pm",
        editedAt: edited,
      });
      expect(
        await writeM1SummaryLine(
          store,
          batch,
          draftOf(batch, "someone moved the deploy to the afternoon"),
        ),
      ).toBe("written");
      const texts = async () =>
        (
          await createPostgresChannelSummaryStore(db).read(placeOf(batch))
        )?.lines.map((line) => line.text);
      expect(await texts()).toEqual([
        "someone moved the deploy to the afternoon",
      ]);
      // A later edit is of text the line was not made from: the line goes.
      await marks.markEdited(
        { ...mark, at: new Date("2026-11-25T01:10:00.000Z") },
        "deploy at 5pm",
      );
      expect(await texts()).toEqual([]);
    });

    test("a closed gate writes no line", async () => {
      const place = await channel();
      const batch = await closedBatch(place, [["800.000001", "hello"]]);
      const closed = createPostgresM1JudgmentStore(db);
      await pool.query(
        "UPDATE agents SET conversation_rollout = 'off' WHERE id = $1",
        [agentId],
      );
      try {
        expect(
          await writeM1SummaryLine(
            closed,
            batch,
            draftOf(batch, "someone said hello"),
          ),
        ).toBeNull();
      } finally {
        await pool.query(
          "UPDATE agents SET conversation_rollout = 'shadow' WHERE id = $1",
          [agentId],
        );
      }
      expect(
        await createPostgresChannelSummaryStore(db).read(placeOf(batch)),
      ).toBeNull();
    });
  });

  test("an engaged thread's reply waits outside batches, is judged, and its text goes", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db);
    const inputId = await hold(place, "400.000001", "thanks all", "m1_engaged");
    await pool.query(
      "UPDATE conversation_inputs SET received_at = now() - interval '20 seconds' WHERE id = $1",
      [inputId],
    );
    const [waiting] = await rowsOf(place.channelId);
    expect(waiting).toMatchObject({
      grade: "m1_engaged",
      input_id: inputId,
      outcome: null,
      rule_decision: "none",
      rule_reason: "stray_reply",
    });
    // Held for its own judgment: no batch takes it.
    const batch = await createPostgresJudgmentBatchStore(db).closeNext();
    expect(batch?.batch.channelId).not.toBe(place.channelId);
    const claimed = await store.claimReply();
    expect(claimed?.subject).toMatchObject({
      grade: "m1_engaged",
      key: inputId,
      topicId: place.topicId,
      posts: [{ inputId, ts: "400.000001", body: "thanks all" }],
    });
    expect(claimed?.rateLimited).toBe(false);
    if (claimed === null || claimed === undefined) throw new Error("none");
    expect(
      await store.finishReply(
        claimed.id,
        judgedRecord(inputId, ["400.000001"]),
      ),
    ).toBe("written");
    const [done] = await rowsOf(place.channelId);
    expect(done).toMatchObject({ outcome: "judged", refs: ["400.000001"] });
    const { rows } = await pool.query(
      "SELECT body FROM conversation_inputs WHERE id = $1",
      [inputId],
    );
    expect(rows[0]?.body ?? null).toBeNull();
  });

  test("a reply given up leaves no row", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db);
    await hold(place, "500.000001", "later", "m1_engaged");
    const claimed = await store.claimReply();
    if (claimed === null) throw new Error("none");
    expect(await store.finishReply(claimed.id, null)).toBe("dropped");
    expect(await rowsOf(place.channelId)).toEqual([]);
  });

  test("a reply unjudged past the buffer's time is dropped", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db);
    await hold(place, "600.000001", "old", "m1_engaged");
    await pool.query(
      "UPDATE conversation_judgments SET created_at = now() - interval '11 minutes' WHERE slack_channel_id = $1",
      [place.channelId],
    );
    expect(await store.claimReply()).toBeNull();
    expect(await rowsOf(place.channelId)).toEqual([]);
  });

  test("a bound reply is graded by its session's admission (decision 35)", async () => {
    const place = await channel();
    const session = await newPartitionedSession(db, "m1-grade");
    await pool.query("UPDATE sessions SET status = 'idle' WHERE id = $1", [
      session.sessionId,
    ]);
    const grades: string[] = [];
    for (const [admission, ts] of [
      ["active", "700.000001"],
      ["stopped", "700.000002"],
      ["closing", "700.000003"],
      ["closed", "700.000004"],
    ] as const) {
      await pool.query(
        "UPDATE sessions SET admission_state = $2 WHERE id = $1",
        [session.sessionId, admission],
      );
      const inputId = await hold(place, ts, "reply");
      await db.transaction((tx) =>
        requestReplyJudgment(tx, {
          workspaceId,
          agentId,
          teamId: TEAM,
          channelId: place.channelId,
          ts,
          topicId: place.topicId,
          inputId,
          sessionId: session.sessionId,
          rule: { decision: "reply", reason: "default_reply" },
        }),
      );
      const { rows } = await pool.query<{ grade: string }>(
        "SELECT grade FROM conversation_judgments WHERE input_id = $1",
        [inputId],
      );
      grades.push(rows[0]?.grade ?? "none");
    }
    expect(grades).toEqual(["m1_to_task", "m1_to_task", "m1", "m1"]);
  });
  test("a bound reply writes no waiting row with the switch off or in a shared channel", async () => {
    const request = async (
      place: Place,
      inputId: ConversationInputId,
      ts: string,
    ) => {
      await db.transaction((tx) =>
        requestReplyJudgment(tx, {
          workspaceId,
          agentId,
          teamId: TEAM,
          channelId: place.channelId,
          ts,
          topicId: place.topicId,
          inputId,
          // A turn's session; none here, so the reply grades as `m1`.
          sessionId: randomUUID(),
          rule: { decision: "reply", reason: "default_reply" },
        }),
      );
      return (
        await pool.query(
          "SELECT 1 FROM conversation_judgments WHERE input_id = $1",
          [inputId],
        )
      ).rows.length;
    };
    const shared = await channel();
    const sharedInput = await hold(shared, "800.000001", "reply");
    await pool.query(
      "UPDATE surface_bindings SET external_shared = true WHERE external_surface_id = $1",
      [shared.channelId],
    );
    expect(await request(shared, sharedInput, "800.000001")).toBe(0);

    const place = await channel();
    const offInput = await hold(place, "800.000002", "reply");
    const onInput = await hold(place, "800.000003", "reply");
    await pool.query(
      "UPDATE agents SET conversation_rollout = 'off' WHERE id = $1",
      [agentId],
    );
    try {
      expect(await request(place, offInput, "800.000002")).toBe(0);
    } finally {
      await pool.query(
        "UPDATE agents SET conversation_rollout = 'shadow' WHERE id = $1",
        [agentId],
      );
    }
    expect(await request(place, onInput, "800.000003")).toBe(1);
  });
  test("an engaged reply past the channel's twelve an hour is rate limited", async () => {
    const store = createPostgresM1JudgmentStore(db);
    const counted = async (place: Place, n: number) => {
      for (let i = 0; i < n; i++) {
        await pool.query(
          `INSERT INTO conversation_judgments (id, workspace_id, agent_id, conversation_id, grade,
             slack_team_id, slack_channel_id, refs, release_id, call_key, attempts, prompt_version,
             outcome, decision, reason, rule_decision, rule_reason, claimed_at, judged_at)
           VALUES ($1, $2, $3, $4, 'm1_engaged', $5, $6, ARRAY[$7], $8, $9, 1, 1,
             'judged', 'quiet', 'unclear', 'none', 'stray_reply', now(), now())`,
          [
            randomUUID(),
            workspaceId,
            agentId,
            place.conversationId,
            TEAM,
            place.channelId,
            `900.${String(i).padStart(6, "0")}`,
            releaseId,
            `k${i}:m1`,
          ],
        );
      }
    };
    // Earlier cases leave waiting rows; this one claims its own.
    await pool.query(
      "DELETE FROM conversation_judgments WHERE outcome IS NULL",
    );
    const full = await channel();
    await counted(full, 12);
    await hold(full, "901.000001", "one more", "m1_engaged");
    const limited = await store.claimReply();
    expect(limited?.subject.channelId).toBe(full.channelId);
    expect(limited?.rateLimited).toBe(true);
    if (limited) await store.finishReply(limited.id, null);

    const room = await channel();
    await counted(room, 11);
    await hold(room, "902.000001", "the last place", "m1_engaged");
    const fits = await store.claimReply();
    expect(fits?.subject.channelId).toBe(room.channelId);
    expect(fits?.rateLimited).toBe(false);
    if (fits) await store.finishReply(fits.id, null);
  });

  describe("check spot ② (a1/J6)", () => {
    const store = () => createPostgresM1JudgmentStore(db);
    const marks = () => createPostgresSlackSourceMarkStore(db);
    const mark = (place: Place, ts: string) => ({
      workspaceId,
      teamId: TEAM,
      channelId: place.channelId,
      ts,
      at: new Date(),
    });

    /** Holds the posts, then closes the channel's batch over them. */
    async function batchOver(place: Place, posts: [string, string][]) {
      const held = [];
      for (const [ts, body] of posts) {
        held.push({
          inputId: await hold(place, ts, body),
          ts,
          body,
          editMark: null,
        });
      }
      await pool.query(
        "UPDATE conversation_inputs SET received_at = now() - interval '20 seconds' WHERE slack_channel_id = $1",
        [place.channelId],
      );
      const batches = createPostgresJudgmentBatchStore(db);
      for (let i = 0; i < 10; i++) {
        const closed = await batches.closeNext();
        if (closed === null) break;
        if (closed.batch.channelId === place.channelId) {
          if (closed.outcome !== "judging") throw new Error("rate limited");
          return { batch: closed.batch, held };
        }
      }
      throw new Error("no batch for the channel");
    }

    const bodiesOf = async (place: Place) =>
      (
        await pool.query<{ slack_ts: string; body: string }>(
          "SELECT slack_ts, body FROM conversation_inputs WHERE slack_channel_id = $1 AND buffer_expires_at IS NOT NULL ORDER BY slack_ts",
          [place.channelId],
        )
      ).rows;

    test("a post deleted while judged voids the result: no decision, no place, the call's key", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [
        ["1100.000001", "one"],
        ["1100.000002", "two"],
        ["1100.000003", "three"],
      ]);
      await marks().markDeleted(mark(place, "1100.000002"));
      const [one, , three] = held;
      if (!one || !three) throw new Error("three");
      const refs = held.map((post) => post.ts);
      const first = await store().recordBatch(
        batch,
        judgedRecord(batch.id, refs),
        held,
      );
      expect(first).toMatchObject({
        outcome: "voided",
        reason: "voided_by_delete",
        remaining: [one, three],
      });
      const [voided] = await rowsOf(place.channelId);
      expect(voided).toMatchObject({
        grade: "buffer_m1",
        outcome: "voided",
        decision: null,
        reason: "voided_by_delete",
        refs: [],
        sources: null,
        input_id: null,
        call_key: `${batch.id}:m1`,
        attempts: 1,
        judgment_batch_id: batch.id,
      });
      // The two left keep their rows for the judgment again.
      expect((await bodiesOf(place)).map((row) => row.slack_ts)).toEqual([
        "1100.000001",
        "1100.000003",
      ]);
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(`${batch.id}-rejudge`, ["1100.000001", "1100.000003"]),
          [one, three],
          { final: true },
        ),
      ).toMatchObject({ outcome: "written" });
      const rows = await rowsOf(place.channelId);
      expect(rows.map((row) => [row.outcome, row.refs, row.call_key])).toEqual([
        ["voided", [], `${batch.id}:m1`],
        ["judged", ["1100.000001", "1100.000003"], `${batch.id}-rejudge:m1`],
      ]);
      expect(await bodiesOf(place)).toEqual([]);
    });

    test("every post deleted: voided with nothing left to judge again", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["1200.000001", "one"]]);
      await marks().markDeleted(mark(place, "1200.000001"));
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(batch.id, ["1200.000001"]),
          held,
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_delete",
        remaining: [],
      });
    });

    test("an edit while judged voids it and hands back the buffer's new text; edited again, the posts go", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [
        ["1300.000001", "before"],
      ]);
      await marks().markEdited(mark(place, "1300.000001"), "after");
      const first = await store().recordBatch(
        batch,
        judgedRecord(batch.id, ["1300.000001"]),
        held,
      );
      expect(first).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [{ ts: "1300.000001", body: "after" }],
      });
      if (first.outcome !== "voided") throw new Error("not voided");
      await marks().markEdited(
        { ...mark(place, "1300.000001"), at: new Date(Date.now() + 1000) },
        "after again",
      );
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(`${batch.id}-rejudge`, ["1300.000001"]),
          first.remaining,
          { final: true, readAt: first.readAt },
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [],
      });
      expect(await bodiesOf(place)).toEqual([]);
      const rows = await rowsOf(place.channelId);
      expect(rows.map((row) => [row.outcome, row.reason])).toEqual([
        ["voided", "voided_by_edit"],
        ["voided", "voided_by_edit"],
      ]);
      expect(JSON.stringify(rows)).not.toContain("after");
    });

    test("an edit before the batch closed is not a change: its new text was read", async () => {
      const place = await channel();
      await hold(place, "1400.000001", "before");
      await marks().markEdited(mark(place, "1400.000001"), "after");
      const { batch } = await batchOver(place, []);
      const [read] = batch.inputs;
      expect(read?.body).toBe("after");
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(batch.id, ["1400.000001"]),
          batch.inputs,
        ),
      ).toMatchObject({ outcome: "written" });
    });

    test("a delete committing while the result is written is waited for and voids it", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["1500.000001", "one"]]);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('slack_source_marks'), hashtext(concat_ws('|', $1::text, $2::text, $3::text, $4::text)))",
          [workspaceId, TEAM, place.channelId, "1500.000001"],
        );
        await client.query(
          "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at) VALUES ($1, $2, $3, $4, now())",
          [workspaceId, TEAM, place.channelId, "1500.000001"],
        );
        let settled = false;
        const writing = store()
          .recordBatch(batch, judgedRecord(batch.id, ["1500.000001"]), held)
          .finally(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        await client.query("COMMIT");
        expect((await writing).outcome).toBe("voided");
      } finally {
        client.release();
      }
      const rows = await rowsOf(place.channelId);
      expect(rows.map((row) => row.outcome)).toEqual(["voided"]);
    });

    test("the switch lowered before the write: nothing written, nothing voided", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["1600.000001", "one"]]);
      await pool.query(
        "UPDATE agents SET conversation_rollout = 'off' WHERE id = $1",
        [agentId],
      );
      try {
        await marks().markDeleted(mark(place, "1600.000002"));
        expect(
          await store().recordBatch(
            batch,
            judgedRecord(batch.id, ["1600.000001"]),
            held,
          ),
        ).toEqual({ outcome: "closed" });
      } finally {
        await pool.query(
          "UPDATE agents SET conversation_rollout = 'shadow' WHERE id = $1",
          [agentId],
        );
      }
      expect(await rowsOf(place.channelId)).toEqual([]);
    });

    test("an engaged reply edited while judged waits for one judgment again on its new text", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      const inputId = await hold(place, "1700.000001", "before", "m1_engaged");
      const claimed = await store().claimReply();
      if (claimed === null) throw new Error("none");
      await marks().markEdited(mark(place, "1700.000001"), "after");
      const first = await store().finishReply(
        claimed.id,
        judgedRecord(inputId, ["1700.000001"]),
        { read: { body: "before", editMark: null } },
      );
      expect(first).toMatchObject({
        voided: "voided_by_edit",
        rejudge: { body: "after" },
      });
      if (typeof first !== "object" || first.rejudge === null) {
        throw new Error("no judgment again");
      }
      const { readAt, ...read } = first.rejudge;
      let rows = await rowsOf(place.channelId);
      expect(rows.map((row) => [row.outcome, row.input_id])).toEqual([
        [null, inputId],
        ["voided", null],
      ]);
      expect(
        await store().finishReply(
          claimed.id,
          judgedRecord(`${inputId}-rejudge`, ["1700.000001"]),
          { read, readAt, final: true },
        ),
      ).toBe("written");
      rows = await rowsOf(place.channelId);
      expect(rows.map((row) => [row.outcome, row.call_key])).toEqual([
        ["voided", `${inputId}:m1`],
        ["judged", `${inputId}-rejudge:m1`],
      ]);
    });

    test("an engaged reply deleted while judged becomes a voided row and keeps no place", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      const inputId = await hold(place, "1800.000001", "gone", "m1_engaged");
      const claimed = await store().claimReply();
      if (claimed === null) throw new Error("none");
      await marks().markDeleted(mark(place, "1800.000001"));
      expect(
        await store().finishReply(
          claimed.id,
          judgedRecord(inputId, ["1800.000001"]),
          { read: { body: "gone", editMark: null } },
        ),
      ).toEqual({ voided: "voided_by_delete", rejudge: null });
      const [row] = await rowsOf(place.channelId);
      expect(row).toMatchObject({
        outcome: "voided",
        reason: "voided_by_delete",
        decision: null,
        refs: [],
        input_id: null,
        sources: null,
      });
    });

    test("a held reply of work going on edited while judged is judged once more on its new text, its row kept", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      const inputId = await hold(place, "1950.000001", "before");
      await db.transaction((tx) =>
        requestReplyJudgment(tx, {
          workspaceId,
          agentId,
          teamId: TEAM,
          channelId: place.channelId,
          ts: "1950.000001",
          topicId: place.topicId,
          inputId,
          sessionId: null,
          heldAs: "m1_to_task",
          rule: { decision: "reply", reason: "default_reply" },
        }),
      );
      const claimed = await store().claimReply();
      if (claimed === null) throw new Error("none");
      expect(claimed.subject.grade).toBe("m1_to_task");
      await marks().markEdited(mark(place, "1950.000001"), "after");
      expect(
        await store().finishReply(
          claimed.id,
          judgedRecord(inputId, ["1950.000001"]),
          { read: { body: "before", editMark: null } },
        ),
      ).toMatchObject({ voided: "voided_by_edit", rejudge: { body: "after" } });
      // The reply's record keeps its held row (out of M1's batches); the
      // voided call has a row of its own.
      let rows = await rowsOf(place.channelId);
      expect(rows.map((row) => [row.outcome, row.input_id])).toEqual([
        [null, inputId],
        ["voided", null],
      ]);
      // Voided again: it could not be judged, and the record stays.
      await marks().markEdited(mark(place, "1950.000001"), "later");
      expect(
        await store().finishReply(
          claimed.id,
          judgedRecord(`${inputId}-rejudge`, ["1950.000001"]),
          { read: { body: "after", editMark: null }, final: true },
        ),
      ).toMatchObject({ voided: "voided_by_edit", rejudge: null });
      rows = await rowsOf(place.channelId);
      expect(
        rows.map((row) => [row.outcome, row.reason, row.input_id]),
      ).toEqual([
        ["voided", "voided_by_edit", null],
        ["voided", "voided_by_edit", null],
        ["failed", "provider_error", inputId],
      ]);
    });

    test("a bound reply edited while judged is voided and not judged again", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      const session = await newPartitionedSession(db, "m1-j6");
      await pool.query(
        "UPDATE sessions SET status = 'idle', admission_state = 'closed' WHERE id = $1",
        [session.sessionId],
      );
      const inputId = await hold(place, "1900.000001", "reply");
      await db.transaction((tx) =>
        requestReplyJudgment(tx, {
          workspaceId,
          agentId,
          teamId: TEAM,
          channelId: place.channelId,
          ts: "1900.000001",
          topicId: place.topicId,
          inputId,
          sessionId: session.sessionId,
          rule: { decision: "reply", reason: "default_reply" },
        }),
      );
      const claimed = await store().claimReply();
      if (claimed === null) throw new Error("none");
      expect(claimed.subject.grade).toBe("m1");
      await marks().markEdited(mark(place, "1900.000001"));
      expect(
        await store().finishReply(
          claimed.id,
          judgedRecord(inputId, ["1900.000001"]),
          { read: { body: "reply", editMark: null } },
        ),
      ).toEqual({ voided: "voided_by_edit", rejudge: null });
      const [row] = await rowsOf(place.channelId);
      expect(row).toMatchObject({
        grade: "m1",
        outcome: "voided",
        refs: [],
        input_id: null,
        rule_decision: "reply",
      });
    });

    const withContext = (record: M1Record, ...places: [Place, string][]) => ({
      ...record,
      sources: {
        keys: places.map(([place, ts]) => ({
          inputId: null,
          slack: { teamId: TEAM, channelId: place.channelId, ts },
        })),
        overflow: false,
      },
    });

    test("a context message deleted while judged voids the result, and every post is judged again", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["2000.000002", "now"]]);
      await marks().markDeleted(mark(place, "2000.000001"));
      expect(
        await store().recordBatch(
          batch,
          withContext(
            judgedRecord(batch.id, ["2000.000002"]),
            [place, "2000.000001"],
            [place, "2000.000002"],
          ),
          held,
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_delete",
        remaining: held,
      });
    });

    test("a called judgment that failed is voided too, keeping no deleted place", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["2100.000001", "one"]]);
      await marks().markDeleted(mark(place, "2100.000001"));
      const failed: M1Record = {
        ...judgedRecord(batch.id, ["2100.000001"]),
        verdict: { outcome: "failed", decision: "quiet", reason: "timed_out" },
      };
      expect((await store().recordBatch(batch, failed, held)).outcome).toBe(
        "voided",
      );
      const [row] = await rowsOf(place.channelId);
      expect(row).toMatchObject({
        outcome: "voided",
        refs: [],
        decision: null,
      });
    });

    test("voided again, the batch's buffered rows go, those not judged too", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [
        ["2200.000001", "one"],
        ["2200.000002", "two"],
      ]);
      const [one] = held;
      if (!one) throw new Error("one");
      await marks().markEdited(mark(place, "2200.000001"), "one, edited");
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(`${batch.id}-rejudge`, ["2200.000001"]),
          [one],
          { final: true },
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [],
      });
      expect(await bodiesOf(place)).toEqual([]);
    });

    test("a buffered post edited and then gone without a delete is voided and not judged again", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["2300.000001", "one"]]);
      const [one] = held;
      if (!one) throw new Error("one");
      await marks().markEdited(mark(place, "2300.000001"), "one, edited");
      // Gone as an expired row goes.
      await pool.query("DELETE FROM conversation_inputs WHERE id = $1", [
        one.inputId,
      ]);
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(batch.id, ["2300.000001"]),
          held,
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [],
      });
    });

    test("an edit Slack gave with no text voids the result and is not judged again", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["2350.000001", "one"]]);
      await marks().markEdited(mark(place, "2350.000001"));
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(batch.id, ["2350.000001"]),
          held,
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [],
      });
    });

    test("an engaged reply whose context was deleted is judged again on the text it read", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      const inputId = await hold(place, "2400.000002", "reply", "m1_engaged");
      const claimed = await store().claimReply();
      if (claimed === null) throw new Error("none");
      await marks().markDeleted(mark(place, "2400.000001"));
      expect(
        await store().finishReply(
          claimed.id,
          withContext(judgedRecord(inputId, ["2400.000002"]), [
            place,
            "2400.000001",
          ]),
          { read: { body: "reply", editMark: null } },
        ),
      ).toMatchObject({
        voided: "voided_by_delete",
        rejudge: { body: "reply", editMark: null },
      });
    });

    test("a held reply of work going on whose context was deleted is judged once more, as a held reply is", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      const session = await newPartitionedSession(db, "m1-j6-context");
      const inputId = await hold(place, "2500.000002", "reply");
      await db.transaction((tx) =>
        requestReplyJudgment(tx, {
          workspaceId,
          agentId,
          teamId: TEAM,
          channelId: place.channelId,
          ts: "2500.000002",
          topicId: place.topicId,
          inputId,
          sessionId: session.sessionId,
          rule: { decision: "reply", reason: "default_reply" },
        }),
      );
      const claimed = await store().claimReply();
      if (claimed === null) throw new Error("none");
      await marks().markDeleted(mark(place, "2500.000001"));
      expect(
        await store().finishReply(
          claimed.id,
          withContext(judgedRecord(inputId, ["2500.000002"]), [
            place,
            "2500.000001",
          ]),
          { read: { body: "reply", editMark: null } },
        ),
      ).toMatchObject({
        voided: "voided_by_delete",
        rejudge: { body: "reply" },
      });
    });

    test("a context message edited while judged voids the result, and every post is judged again", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["2600.000002", "now"]]);
      await marks().markEdited(mark(place, "2600.000001"), "changed");
      expect(
        await store().recordBatch(
          batch,
          withContext(
            judgedRecord(batch.id, ["2600.000002"]),
            [place, "2600.000001"],
            [place, "2600.000002"],
          ),
          held,
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: held,
      });
    });

    test("a context message edited before the batch closed is not a change", async () => {
      const place = await channel();
      await marks().markEdited(mark(place, "2700.000001"), "changed");
      const { batch, held } = await batchOver(place, [["2700.000002", "now"]]);
      expect(
        await store().recordBatch(
          batch,
          withContext(
            judgedRecord(batch.id, ["2700.000002"]),
            [place, "2700.000001"],
            [place, "2700.000002"],
          ),
          held,
        ),
      ).toMatchObject({ outcome: "written" });
    });

    test("an edit with text, then one with none, leaves no stale text to judge again", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["2800.000001", "one"]]);
      await marks().markEdited(mark(place, "2800.000001"), "between");
      await marks().markEdited({
        ...mark(place, "2800.000001"),
        at: new Date(Date.now() + 1000),
      });
      expect(await bodiesOf(place)).toEqual([]);
      expect(
        await store().recordBatch(
          batch,
          judgedRecord(batch.id, ["2800.000001"]),
          held,
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [],
      });
    });

    test("with its context cut, a delete in the channel committing meanwhile is waited for and voids it", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["2900.000002", "one"]]);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock_shared(hashtext('slack_channel_marks'), hashtext(concat_ws('|', $1::text, $2::text, $3::text)))",
          [workspaceId, TEAM, place.channelId],
        );
        await client.query(
          "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at) VALUES ($1, $2, $3, $4, now())",
          [workspaceId, TEAM, place.channelId, "2900.000001"],
        );
        let settled = false;
        const record = judgedRecord(batch.id, ["2900.000002"]);
        const writing = store()
          .recordBatch(
            batch,
            { ...record, sources: { ...record.sources, overflow: true } },
            held,
          )
          .finally(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        await client.query("COMMIT");
        expect(await writing).toMatchObject({
          outcome: "voided",
          reason: "voided_by_delete",
        });
      } finally {
        client.release();
      }
    });

    test("with its context cut, an edit in the channel since the read voids it", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["3000.000002", "one"]]);
      await marks().markEdited(mark(place, "3000.000001"), "changed");
      const record = judgedRecord(batch.id, ["3000.000002"]);
      expect(
        await store().recordBatch(
          batch,
          { ...record, sources: { ...record.sources, overflow: true } },
          held,
        ),
      ).toMatchObject({
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: held,
      });
    });

    test("a reply's claim waits out a mark in progress and reads after it", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      await hold(place, "3100.000002", "reply", "m1_engaged");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock_shared(hashtext('slack_channel_marks'), hashtext(concat_ws('|', $1::text, $2::text, $3::text)))",
          [workspaceId, TEAM, place.channelId],
        );
        await client.query(
          "INSERT INTO edited_sources (workspace_id, team_id, channel_id, ts, edited_at, marked_at) VALUES ($1, $2, $3, $4, now(), clock_timestamp())",
          [workspaceId, TEAM, place.channelId, "3100.000001"],
        );
        let settled = false;
        const claiming = store()
          .claimReply()
          .finally(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        await client.query("COMMIT");
        const claimed = await claiming;
        expect(claimed?.subject.channelId).toBe(place.channelId);
        const [marked] = (
          await pool.query<{ after: boolean }>(
            "SELECT $1::timestamptz > marked_at AS after FROM edited_sources WHERE channel_id = $2",
            [claimed?.readAt, place.channelId],
          )
        ).rows;
        expect(marked?.after).toBe(true);
      } finally {
        client.release();
      }
    });

    test("with its context cut and a named context message unchanged, an edit past the cut still voids it", async () => {
      const place = await channel();
      const { batch, held } = await batchOver(place, [["3200.000003", "one"]]);
      await marks().markEdited(mark(place, "3200.000001"), "changed");
      const record = withContext(
        judgedRecord(batch.id, ["3200.000003"]),
        [place, "3200.000002"],
        [place, "3200.000003"],
      );
      expect(
        await store().recordBatch(
          batch,
          { ...record, sources: { ...record.sources, overflow: true } },
          held,
        ),
      ).toMatchObject({ outcome: "voided", reason: "voided_by_edit" });
    });

    test("a close waits out a mark in progress and reads after it", async () => {
      const place = await channel();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock_shared(hashtext('slack_channel_marks'), hashtext(concat_ws('|', $1::text, $2::text, $3::text)))",
          [workspaceId, TEAM, place.channelId],
        );
        await client.query(
          "INSERT INTO edited_sources (workspace_id, team_id, channel_id, ts, edited_at, marked_at) VALUES ($1, $2, $3, $4, now(), clock_timestamp())",
          [workspaceId, TEAM, place.channelId, "3300.000001"],
        );
        let settled = false;
        const closing = batchOver(place, [["3300.000002", "one"]]).finally(
          () => {
            settled = true;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        await client.query("COMMIT");
        const { batch } = await closing;
        const [marked] = (
          await pool.query<{ after: boolean }>(
            "SELECT $1::timestamptz > marked_at AS after FROM edited_sources WHERE channel_id = $2",
            [batch.readAt, place.channelId],
          )
        ).rows;
        expect(marked?.after).toBe(true);
      } finally {
        client.release();
      }
    });

    test("an older edit with no text arriving late keeps the newer text held", async () => {
      const place = await channel();
      await hold(place, "3400.000001", "one");
      const now = Date.now();
      await marks().markEdited(
        { ...mark(place, "3400.000001"), at: new Date(now) },
        "newer",
      );
      await marks().markEdited({
        ...mark(place, "3400.000001"),
        at: new Date(now - 60_000),
      });
      expect(await bodiesOf(place)).toEqual([
        { slack_ts: "3400.000001", body: "newer" },
      ]);
    });
  });
});
