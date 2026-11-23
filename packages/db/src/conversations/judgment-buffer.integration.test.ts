import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationTopicId } from "@werft-ai/contracts";
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
import { createPostgresConversationStore } from "./conversation-store.ts";
import {
  dropBufferedMessage,
  dropUnlistenedBuffer,
  holdBufferedInput,
} from "./judgment-buffer.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// Races a single-connection engine cannot show: a hold against the change
// that stops the channel being heard, and two removals emptying one topic.
integration("judgment buffer races", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const TEAM = "T0RACE";
  const installationId = randomUUID();
  let channelSeq = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "judgment_buffer" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema }) as unknown as Database;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status, conversation_rollout) VALUES ($1, $2, $3, 'racer', 'racer', 'active', 'on')",
      [agentId, workspaceId, team],
    );
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0RACE', $3)",
      [installationId, workspaceId, TEAM],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  /** A channel bound in use and listening free, with one thread's topic. */
  async function heardChannel() {
    const channelId = `C${String(++channelSeq).padStart(6, "0")}`;
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

  const hold = (
    tx: Database,
    place: { channelId: string; topicId: ConversationTopicId },
    ts: string,
  ) =>
    holdBufferedInput(
      tx,
      { workspaceId, agentId, teamId: TEAM },
      {
        topicId: place.topicId,
        channelId: place.channelId,
        ts,
        buffered: { body: "unheard", slackUserId: "U0PERSON" },
      },
    );

  const heldIn = async (channelId: string) =>
    (
      await pool.query(
        "SELECT slack_ts FROM conversation_inputs WHERE slack_channel_id = $1 AND buffer_expires_at IS NOT NULL",
        [channelId],
      )
    ).rows.length;
  const topicsIn = async (channelId: string) =>
    (
      await pool.query(
        "SELECT id FROM conversation_topics WHERE slack_channel_id = $1",
        [channelId],
      )
    ).rows.length;

  /** A promise and the function that settles it. */
  function gate() {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  /**
   * Whether the second transaction came to wait on a lock. A test checks its
   * outcome first and this last, so it never passes on a run with no race.
   */
  const waitingOnLock = async () => {
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (rows.length > 0) return true;
      await Bun.sleep(20);
    }
    return false;
  };

  const turnOff = (tx: Database, channelId: string) =>
    tx.execute(
      sql`UPDATE surface_bindings SET mode = 'off' WHERE agent_id = ${agentId}::uuid AND external_surface_id = ${channelId}`,
    );

  test("a channel turned off while a post is being held: the hold waits and holds nothing", async () => {
    const place = await heardChannel();
    const ready = gate();
    const committed = gate();
    const stopping = db.transaction(async (tx) => {
      await turnOff(tx, place.channelId);
      await dropUnlistenedBuffer(tx, { agentId, channelId: place.channelId });
      ready.open();
      await committed.opened;
    });
    await ready.opened;
    const holding = db.transaction((tx) => hold(tx, place, "100.000100"));
    const waited = await waitingOnLock();
    committed.open();
    await stopping;
    expect(await holding).toBe("not_held");
    expect(await heldIn(place.channelId)).toBe(0);
    expect(await topicsIn(place.channelId)).toBe(0);
    expect(waited).toBe(true);
  });

  test("a post held while the channel is being turned off: the change waits and removes it", async () => {
    const place = await heardChannel();
    const ready = gate();
    const committed = gate();
    const holding = db.transaction(async (tx) => {
      const held = await hold(tx, place, "100.000100");
      ready.open();
      await committed.opened;
      return held;
    });
    await ready.opened;
    const stopping = db.transaction(async (tx) => {
      await turnOff(tx, place.channelId);
      return dropUnlistenedBuffer(tx, { agentId, channelId: place.channelId });
    });
    const waited = await waitingOnLock();
    committed.open();
    expect(await holding).toBe("held");
    expect(await stopping).toBe(1);
    expect(await heldIn(place.channelId)).toBe(0);
    expect(await topicsIn(place.channelId)).toBe(0);
    expect(waited).toBe(true);
  });

  test("two deletes emptying one topic at once leave no topic", async () => {
    const place = await heardChannel();
    await db.transaction((tx) => hold(tx, place, "100.000100"));
    await db.transaction((tx) => hold(tx, place, "100.000200"));
    expect(await heldIn(place.channelId)).toBe(2);
    const message = (ts: string) => ({
      workspaceId,
      teamId: TEAM,
      channelId: place.channelId,
      ts,
    });
    const ready = gate();
    const committed = gate();
    const first = db.transaction(async (tx) => {
      const removed = await dropBufferedMessage(tx, message("100.000100"));
      ready.open();
      await committed.opened;
      return removed;
    });
    await ready.opened;
    const second = db.transaction((tx) =>
      dropBufferedMessage(tx, message("100.000200")),
    );
    const waited = await waitingOnLock();
    committed.open();
    expect([await first, await second]).toEqual([1, 1]);
    expect(await topicsIn(place.channelId)).toBe(0);
    expect(waited).toBe(true);
  });
});
