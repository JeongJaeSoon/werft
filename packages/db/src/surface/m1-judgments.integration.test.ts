import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationInputId,
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
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

// No notice is published yet; one is put in so the gate can open.
const VERSIONS: readonly SlackNoticeVersionEntry[] = [
  {
    version: slackNoticeVersionSchema.parse(1),
    text: {
      ko: {
        body: ["k"],
        policyLink: { label: "l", href: "https://example.invalid" },
      },
      ja: {
        body: ["j"],
        policyLink: { label: "l", href: "https://example.invalid" },
      },
    },
    requiresReapproval: true,
  },
];

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
    await pool.query(
      `INSERT INTO slack_notice_approvals (id, workspace_id, agent_id, slack_team_id, notice_version, approved_by)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [randomUUID(), workspaceId, agentId, TEAM, randomUUID()],
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
  });

  const rowsOf = async (channelId: string) =>
    (
      await pool.query(
        "SELECT * FROM conversation_judgments WHERE slack_channel_id = $1 ORDER BY created_at",
        [channelId],
      )
    ).rows;

  test("with no notice published the gate is closed and nothing is written", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db);
    const place4 = {
      workspaceId,
      agentId,
      teamId: TEAM,
      channelId: place.channelId,
    };
    expect(await store.gateOpen(place4)).toBe(false);
    const inputId = await hold(place, "200.000001", "chatter");
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
      [inputId],
    );
    expect(written).toBe(false);
    expect(await rowsOf(place.channelId)).toEqual([]);
  });

  test("an externally shared channel's gate is closed", async () => {
    const place = await channel({ externalShared: true });
    const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
    expect(
      await store.gateOpen({
        workspaceId,
        agentId,
        teamId: TEAM,
        channelId: place.channelId,
      }),
    ).toBe(false);
  });

  test("a batch's record holds refs and codes, and its judged posts leave the buffer", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
        [judged],
      ),
    ).toBe(true);
    const [row] = await rowsOf(place.channelId);
    expect(row).toMatchObject({
      grade: "buffer_m1",
      refs: ["300.000001"],
      judgment_batch_id: closed.batch.id,
      outcome: "judged",
      decision: "quiet",
      reason: "human_conversation",
      prompt_version: 2,
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
      const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
      const judged = batch.inputs.map((input) => input.inputId);
      expect(
        await store.recordBatch(
          batch,
          {
            ...judgedRecord(batch.id, ["500.000001", "500.000002"]),
            summary: outcome,
          },
          judged,
        ),
      ).toBe(true);
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
        [judged],
      );
      expect(rows).toEqual([]);
      const [row] = await rowsOf(place.channelId);
      expect(row).toMatchObject({ summary: "written", prompt_version: 2 });
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
      const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
      const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
      const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
      const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
        batch.inputs.map((input) => input.inputId),
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
      const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
      expect(
        await writeM1SummaryLine(
          closed,
          batch,
          draftOf(batch, "someone said hello"),
        ),
      ).toBeNull();
      expect(
        await createPostgresChannelSummaryStore(db).read(placeOf(batch)),
      ).toBeNull();
    });
  });

  test("an engaged thread's reply waits outside batches, is judged, and its text goes", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
    const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
    await hold(place, "500.000001", "later", "m1_engaged");
    const claimed = await store.claimReply();
    if (claimed === null) throw new Error("none");
    expect(await store.finishReply(claimed.id, null)).toBe("dropped");
    expect(await rowsOf(place.channelId)).toEqual([]);
  });

  test("a reply unjudged past the buffer's time is dropped", async () => {
    const place = await channel();
    const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
    await hold(place, "600.000001", "old", "m1_engaged");
    await pool.query(
      "UPDATE conversation_judgments SET created_at = now() - interval '11 minutes' WHERE slack_channel_id = $1",
      [place.channelId],
    );
    expect(await store.claimReply()).toBeNull();
    expect(await rowsOf(place.channelId)).toEqual([]);
  });

  test("a bound reply is graded by its session's status", async () => {
    const place = await channel();
    const session = await newPartitionedSession(db, "m1-grade");
    const grades: string[] = [];
    for (const [status, ts] of [
      ["running", "700.000001"],
      ["idle", "700.000002"],
    ] as const) {
      await pool.query("UPDATE sessions SET status = $2 WHERE id = $1", [
        session.sessionId,
        status,
      ]);
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
    expect(grades).toEqual(["m1_to_task", "m1"]);
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
    const store = createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
});
