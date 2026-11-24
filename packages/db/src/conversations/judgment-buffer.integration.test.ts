import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
} from "@werft-ai/contracts";
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
// that stops the channel being heard, two removals emptying one topic, and
// holds at once against the channel's limit.
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
  async function heardChannel(
    agent = agentId,
    channelId = `C${String(++channelSeq).padStart(6, "0")}`,
    threadTs = "100.000100",
  ) {
    await pool.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
        installation_id, external_surface_id, surface_kind, mode, listen,
        ceiling_actions, ceiling_disclosure, status)
       VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
        '{}', 'full', 'ready')`,
      [randomUUID(), workspaceId, agent, installationId, channelId],
    );
    return { channelId, topicId: await topicOf(agent, channelId, threadTs) };
  }

  /** The topic of a thread in a channel the agent hears. */
  async function topicOf(agent: string, channelId: string, threadTs: string) {
    const store = createPostgresConversationStore(db);
    const conversation = await store.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId: agent,
      teamId: TEAM,
      channelId,
    });
    const topic = await store.findOrCreateThreadTopic(conversation.id, {
      teamId: TEAM,
      channelId,
      threadTs,
    });
    return topic.id as ConversationTopicId;
  }

  const hold = (
    tx: Database,
    place: { channelId: string; topicId: ConversationTopicId },
    ts: string,
    options: { limit?: number; agent?: string } = {},
  ) =>
    holdBufferedInput(
      tx,
      { workspaceId, agentId: options.agent ?? agentId, teamId: TEAM },
      {
        topicId: place.topicId,
        channelId: place.channelId,
        ts,
        buffered: { body: "unheard", slackUserId: "U0PERSON" },
      },
      options.limit ?? JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
    );

  const heldTsIn = async (channelId: string, agent = agentId) =>
    (
      await pool.query<{ slack_ts: string }>(
        "SELECT slack_ts FROM conversation_inputs WHERE slack_channel_id = $1 AND agent_id = $2 AND buffer_expires_at IS NOT NULL ORDER BY slack_ts::numeric",
        [channelId, agent],
      )
    ).rows.map((row) => row.slack_ts);
  const heldIn = async (channelId: string) =>
    (await heldTsIn(channelId)).length;
  const droppedIn = async (channelId: string, agent = agentId) =>
    Number(
      (
        await pool.query<{ dropped_count: string }>(
          "SELECT dropped_count FROM judgment_buffer_overflows WHERE slack_channel_id = $1 AND agent_id = $2",
          [channelId, agent],
        )
      ).rows[0]?.dropped_count ?? 0,
    );
  const tsOf = (n: number) => `200.${String(n).padStart(6, "0")}`;
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
    expect((await holding).outcome).toBe("not_held");
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
    expect((await holding).outcome).toBe("held");
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
  test("the post past the limit removes the channel's oldest one and counts it; other channels and agents keep theirs", async () => {
    const place = await heardChannel();
    const other = await heardChannel();
    const otherAgent = randomUUID();
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status, conversation_rollout) SELECT $1, workspace_id, managing_team_id, 'other', 'other', 'active', 'shadow' FROM agents WHERE id = $2",
      [otherAgent, agentId],
    );
    const shared = await heardChannel(otherAgent, place.channelId);
    await db.transaction((tx) => hold(tx, other, tsOf(1)));
    await db.transaction((tx) =>
      hold(tx, shared, tsOf(1), { agent: otherAgent }),
    );
    for (let n = 1; n <= JUDGMENT_BUFFER_LIMIT_PER_CHANNEL; n += 1) {
      expect(await db.transaction((tx) => hold(tx, place, tsOf(n)))).toEqual({
        outcome: "held",
        dropped: 0,
      });
    }
    expect(await droppedIn(place.channelId)).toBe(0);
    const past = JUDGMENT_BUFFER_LIMIT_PER_CHANNEL + 1;
    expect(await db.transaction((tx) => hold(tx, place, tsOf(past)))).toEqual({
      outcome: "held",
      dropped: 1,
    });
    const kept = await heldTsIn(place.channelId);
    expect(kept).toHaveLength(JUDGMENT_BUFFER_LIMIT_PER_CHANNEL);
    expect(kept[0]).toBe(tsOf(2));
    expect(kept.at(-1)).toBe(tsOf(past));
    expect(await droppedIn(place.channelId)).toBe(1);
    expect(await heldTsIn(other.channelId)).toEqual([tsOf(1)]);
    expect(await heldTsIn(place.channelId, otherAgent)).toEqual([tsOf(1)]);
    expect(await droppedIn(other.channelId)).toBe(0);
    expect(await droppedIn(place.channelId, otherAgent)).toBe(0);
  });

  test("a lower limit is the one kept to", async () => {
    const place = await heardChannel();
    for (let n = 1; n <= 4; n += 1) {
      await db.transaction((tx) => hold(tx, place, tsOf(n), { limit: 2 }));
    }
    expect(await heldTsIn(place.channelId)).toEqual([tsOf(3), tsOf(4)]);
    expect(await droppedIn(place.channelId)).toBe(2);
  });

  test("a hold while another holds in the channel waits for it, and the two keep to the limit", async () => {
    const place = await heardChannel();
    const second = {
      channelId: place.channelId,
      topicId: await topicOf(agentId, place.channelId, "300.000100"),
    };
    const ready = gate();
    const committed = gate();
    const first = db.transaction(async (tx) => {
      const held = await hold(tx, place, tsOf(1), { limit: 1 });
      ready.open();
      await committed.opened;
      return held;
    });
    await ready.opened;
    const next = db.transaction((tx) =>
      hold(tx, second, tsOf(2), { limit: 1 }),
    );
    const waited = await waitingOnLock();
    committed.open();
    expect(await first).toEqual({ outcome: "held", dropped: 0 });
    expect(await next).toEqual({ outcome: "held", dropped: 1 });
    expect(await heldTsIn(place.channelId)).toEqual([tsOf(2)]);
    expect(await droppedIn(place.channelId)).toBe(1);
    expect(waited).toBe(true);
  });

  test("many holds at once, each holding its topic as the inbox does, leave no more than the limit and no empty topic", async () => {
    const place = await heardChannel();
    const topics = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map(async (n) => ({
        channelId: place.channelId,
        topicId: await topicOf(agentId, place.channelId, `400.00000${n}`),
        ts: tsOf(10 + n),
      })),
    );
    // An older post in each topic, so a hold's overflow removes the last
    // row of topics other holds have locked.
    for (const [n, topic] of topics.entries()) {
      await db.transaction((tx) => hold(tx, topic, tsOf(n + 1), { limit: 8 }));
    }
    const outcomes = await Promise.all(
      topics.map((topic) =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM conversation_topics WHERE id = ${topic.topicId}::uuid FOR UPDATE`,
          );
          return hold(tx, topic, topic.ts, { limit: 3 });
        }),
      ),
    );
    expect(outcomes.every((held) => held.outcome === "held")).toBe(true);
    expect(outcomes.reduce((sum, held) => sum + held.dropped, 0)).toBe(13);
    expect(await heldTsIn(place.channelId)).toEqual([
      tsOf(16),
      tsOf(17),
      tsOf(18),
    ]);
    expect(await droppedIn(place.channelId)).toBe(13);
    const { rows: empty } = await pool.query(
      "SELECT t.id FROM conversation_topics t WHERE t.slack_channel_id = $1 AND NOT EXISTS (SELECT 1 FROM conversation_inputs i WHERE i.topic_id = t.id)",
      [place.channelId],
    );
    expect(empty).toEqual([]);
  });
});
