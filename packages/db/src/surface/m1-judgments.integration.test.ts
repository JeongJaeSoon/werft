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
          sessionId: null,
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
