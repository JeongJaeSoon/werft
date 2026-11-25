import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationInputId,
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
} from "@werft-ai/contracts";
import type { M1Record } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requestReplyJudgment } from "../conversations/conversation-judgments.ts";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { createPostgresJudgmentBatchStore } from "../conversations/judgment-batches.ts";
import { holdBufferedInput } from "../conversations/judgment-buffer.ts";
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
      [{ inputId, ts: "200.000001", body: "chatter", editMark: null }],
    );
    expect(written).toEqual({ outcome: "closed" });
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
        [
          {
            inputId: judged,
            ts: "300.000001",
            body: "secret words one",
            editMark: null,
          },
        ],
      ),
    ).toEqual({ outcome: "written" });
    const [row] = await rowsOf(place.channelId);
    expect(row).toMatchObject({
      grade: "buffer_m1",
      refs: ["300.000001"],
      judgment_batch_id: closed.batch.id,
      outcome: "judged",
      decision: "quiet",
      reason: "human_conversation",
      prompt_version: 1,
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

  describe("check spot ② (a1/J6)", () => {
    const store = () =>
      createPostgresM1JudgmentStore(db, { versions: VERSIONS });
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
      ).toEqual({ outcome: "written" });
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
      ).toEqual({ outcome: "written" });
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
        ["judged", `${inputId}-rejudge:m1`],
        ["voided", `${inputId}:m1`],
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

    test("a bound reply edited while judged is voided and not judged again", async () => {
      await pool.query(
        "DELETE FROM conversation_judgments WHERE outcome IS NULL",
      );
      const place = await channel();
      const session = await newPartitionedSession(db, "m1-j6");
      await pool.query("UPDATE sessions SET status = 'idle' WHERE id = $1", [
        session.sessionId,
      ]);
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

    test("a bound reply whose context was deleted is voided and not judged again", async () => {
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
      ).toEqual({ voided: "voided_by_delete", rejudge: null });
    });
  });
});
