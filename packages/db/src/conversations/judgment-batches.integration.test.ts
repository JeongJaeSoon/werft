import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
} from "@werft-ai/contracts";
import { type JudgmentBatch, runJudgmentBatches } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "../testing/spec-pins.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";
import { createPostgresJudgmentBatchStore } from "./judgment-batches.ts";
import {
  dropUnlistenedBuffer,
  holdBufferedInput,
  purgeJudgmentBuffer,
} from "./judgment-buffer.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// What a single-connection engine cannot show: two workers closing one
// channel at once, over every foreign key.
integration("judgment batches across workers", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const releaseId = `rel-${randomUUID()}`;
  const TEAM = "T0RACE";
  let channelSeq = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "judgment_batches" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema }) as unknown as Database;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status, conversation_rollout) VALUES ($1, $2, $3, 'racer', 'racer', 'active', 'shadow')",
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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  /** A channel heard free, with one thread's topic. */
  async function heardChannel() {
    const channelId = `C${String(++channelSeq).padStart(6, "0")}`;
    const installationId = randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, $3, $4)",
      [installationId, workspaceId, `A0${channelId}`, TEAM],
    );
    await pool.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
        installation_id, external_surface_id, surface_kind, mode, listen,
        ceiling_actions, ceiling_disclosure, status)
       VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
        '{}', 'full', 'ready')`,
      [randomUUID(), workspaceId, agentId, installationId, channelId],
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
    return { channelId, topicId: topic.id as ConversationTopicId };
  }

  /** Holds a message received 20 seconds ago: due for its batch. */
  async function quietPost(
    place: { channelId: string; topicId: ConversationTopicId },
    ts: string,
  ) {
    await db.transaction((tx) =>
      holdBufferedInput(
        tx,
        { workspaceId, agentId, teamId: TEAM },
        {
          topicId: place.topicId,
          channelId: place.channelId,
          ts,
          buffered: { body: "chatter", slackUserId: "U0PERSON" },
        },
        JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
      ),
    );
    await pool.query(
      "UPDATE conversation_inputs SET received_at = now() - interval '20 seconds' WHERE slack_channel_id = $1 AND slack_ts = $2",
      [place.channelId, ts],
    );
  }

  test("two workers taking one channel at once call the judge once", async () => {
    for (let round = 0; round < 5; round++) {
      const place = await heardChannel();
      await quietPost(place, `200.00010${round}`);
      const judged: JudgmentBatch[] = [];
      const judge = {
        async judge(batch: JudgmentBatch) {
          judged.push(batch);
          // Held open, so the other worker meets it judging.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { modelCalled: true, left: [] };
        },
        async rateLimited() {},
      };
      const worker = () =>
        runJudgmentBatches({
          store: createPostgresJudgmentBatchStore(db),
          judge,
          logger: { warn() {} },
          deadline: Date.now() + 10_000,
        });
      const runs = await Promise.all([worker(), worker()]);
      expect(runs.reduce((sum, run) => sum + run.judged, 0)).toBe(1);
      expect(
        judged.filter((b) => b.channelId === place.channelId),
      ).toHaveLength(1);
    }
  });

  test("a close racing the removal of a channel no longer heard never deadlocks", async () => {
    const store = createPostgresJudgmentBatchStore(db);
    for (let round = 0; round < 10; round++) {
      const place = await heardChannel();
      for (let n = 0; n < 30; n++) {
        await quietPost(place, `400.${String(n).padStart(6, "0")}`);
      }
      const stop = db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE surface_bindings SET listen = 'mention' WHERE agent_id = ${agentId}::uuid AND external_surface_id = ${place.channelId}`,
        );
        return dropUnlistenedBuffer(tx, {
          agentId,
          channelId: place.channelId,
        });
      });
      const [, dropped] = await Promise.all([store.closeNext(), stop]);
      // Whichever went first, every row is gone once the channel is unheard,
      // or in the batch the close made before it.
      const left = await pool.query(
        "SELECT judgment_batch_id FROM conversation_inputs WHERE slack_channel_id = $1",
        [place.channelId],
      );
      expect(
        dropped + left.rows.filter((row) => row.judgment_batch_id).length,
      ).toBe(30);
      await pool.query(
        "UPDATE judgment_batches SET state = 'failed', ended_at = now() WHERE slack_channel_id = $1 AND state = 'judging'",
        [place.channelId],
      );
    }
  });

  test("a close racing an archive's agent lock and buffer removal never deadlocks", async () => {
    const store = createPostgresJudgmentBatchStore(db);
    for (let round = 0; round < 10; round++) {
      const place = await heardChannel();
      for (let n = 0; n < 30; n++) {
        await quietPost(place, `500.${String(n).padStart(6, "0")}`);
      }
      // As agents.ts archives: the agent row first, then its buffer.
      const archive = db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM agents WHERE id = ${agentId}::uuid FOR UPDATE`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tx.execute(
          sql`UPDATE surface_bindings SET listen = 'mention' WHERE agent_id = ${agentId}::uuid AND external_surface_id = ${place.channelId}`,
        );
        return dropUnlistenedBuffer(tx, {
          agentId,
          channelId: place.channelId,
        });
      });
      const [, dropped] = await Promise.all([store.closeNext(), archive]);
      expect(dropped).toBe(30);
      await pool.query(
        "UPDATE judgment_batches SET state = 'failed', ended_at = now() WHERE slack_channel_id = $1 AND state = 'judging'",
        [place.channelId],
      );
    }
  });

  test("an expiry purge racing an archive never deadlocks", async () => {
    for (let round = 0; round < 10; round++) {
      const place = await heardChannel();
      for (let n = 0; n < 30; n++) {
        await quietPost(place, `600.${String(n).padStart(6, "0")}`);
      }
      await pool.query(
        "UPDATE conversation_inputs SET buffer_expires_at = now() - interval '1 second' WHERE slack_channel_id = $1",
        [place.channelId],
      );
      // A channel with no tally yet, so the purge inserts one.
      await pool.query(
        "DELETE FROM judgment_channel_tallies WHERE slack_channel_id = $1",
        [place.channelId],
      );
      const archive = db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM agents WHERE id = ${agentId}::uuid FOR UPDATE`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tx.execute(
          sql`UPDATE surface_bindings SET listen = 'mention' WHERE agent_id = ${agentId}::uuid AND external_surface_id = ${place.channelId}`,
        );
        return dropUnlistenedBuffer(tx, {
          agentId,
          channelId: place.channelId,
        });
      });
      const [purged, dropped] = await Promise.all([
        purgeJudgmentBuffer(db, { limit: 100, dryRun: false }),
        archive,
      ]);
      // Every row went once, by one or the other.
      expect(purged.expired + dropped).toBe(30);
    }
  });

  test("closes racing on one channel make one judging batch", async () => {
    const place = await heardChannel();
    await quietPost(place, "300.000100");
    const store = createPostgresJudgmentBatchStore(db);
    const closed = await Promise.all(
      Array.from({ length: 6 }, () => store.closeNext()),
    );
    const mine = closed.filter(
      (close) => close?.batch.channelId === place.channelId,
    );
    expect(mine).toHaveLength(1);
    const batches = await pool.query(
      "SELECT state FROM judgment_batches WHERE slack_channel_id = $1",
      [place.channelId],
    );
    expect(batches.rows).toEqual([{ state: "judging" }]);
  });
});
