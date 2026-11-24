import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
} from "@werft-ai/contracts";
import {
  type JudgmentBatch,
  type JudgmentBatchResult,
  M1_JUDGMENTS_PER_CHANNEL_WINDOW,
  runJudgmentBatches,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";
import { createPostgresJudgmentBatchStore } from "./judgment-batches.ts";
import {
  dropBufferedMessage,
  editBufferedMessage,
  holdBufferedInput,
  purgeJudgmentBuffer,
} from "./judgment-buffer.ts";

let client: PGlite;
let db: Database;

const WORKSPACE = "00000000-0000-4000-8000-0000000000b4";
const AGENT = "00000000-0000-4000-8000-0000000001b4";
const TEAM = "T0BATCH";
const CHANNEL = "C0BATCH";
const RELEASE = "rel-batch";
const SEC = 1_000;
const MIN = 60 * SEC;

// Real time, so rows the database stamps (their 10 minutes) agree with it.
let base: number;
let topicId: ConversationTopicId;

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows a batch reads; foreign keys are not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
  base = Date.now();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'ws-batch', 'ws')",
    [WORKSPACE],
  );
  await client.query(
    `INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status,
      conversation_rollout, active_release_id, activation_revision)
     VALUES ($1, $2, $3, 'batcher', 'batcher', 'active', 'shadow', $4, 1)`,
    [AGENT, WORKSPACE, randomUUID(), RELEASE],
  );
  await client.query(
    `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
      installation_id, external_surface_id, surface_kind, mode, listen,
      ceiling_actions, ceiling_disclosure, status)
     VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
      '{}', 'full', 'ready')`,
    [randomUUID(), WORKSPACE, AGENT, randomUUID(), CHANNEL],
  );
  const store = createPostgresConversationStore(db);
  const conversation = await store.findOrCreateConversation({
    kind: "channel",
    workspaceId: WORKSPACE,
    agentId: AGENT,
    teamId: TEAM,
    channelId: CHANNEL,
  });
  const topic = await store.findOrCreateThreadTopic(conversation.id, {
    teamId: TEAM,
    channelId: CHANNEL,
    threadTs: "100.000000",
  });
  topicId = topic.id as ConversationTopicId;
});

afterEach(async () => {
  await client.close();
});

const at = (ms: number) => new Date(base + ms);
let tsSeq = 0;

/** Holds a message received `ms` after the start; returns its ts. */
async function post(ms: number, body = "chatter"): Promise<string> {
  const ts = `200.${String(++tsSeq).padStart(6, "0")}`;
  const held = await db.transaction((tx) =>
    holdBufferedInput(
      tx,
      { workspaceId: WORKSPACE, agentId: AGENT, teamId: TEAM },
      {
        topicId,
        channelId: CHANNEL,
        ts,
        buffered: { body, slackUserId: "U0PERSON" },
      },
      JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
    ),
  );
  expect(held.outcome).toBe("held");
  await client.query(
    "UPDATE conversation_inputs SET received_at = $1 WHERE slack_ts = $2",
    [at(ms).toISOString(), ts],
  );
  return ts;
}

/** A judge that records what it was given and answers as told. */
function fakeJudge(
  answer: (batch: JudgmentBatch) => JudgmentBatchResult = () => ({
    modelCalled: true,
    left: [],
  }),
) {
  const judged: JudgmentBatch[] = [];
  const rateLimited: JudgmentBatch[] = [];
  return {
    judged,
    rateLimited,
    judge: {
      async judge(batch: JudgmentBatch) {
        judged.push(batch);
        return answer(batch);
      },
      async rateLimited(batch: JudgmentBatch) {
        rateLimited.push(batch);
      },
    },
  };
}

type Logger = { warn(message: string): void };
const quiet: Logger = { warn() {} };

/** One pass at `ms` after the start. */
function pass(
  judge: ReturnType<typeof fakeJudge>["judge"],
  ms: number,
  logger: Logger = quiet,
) {
  return runJudgmentBatches({
    store: createPostgresJudgmentBatchStore(db),
    judge,
    logger,
    deadline: Number.POSITIVE_INFINITY,
    now: () => at(ms),
  });
}

const tsOf = (batch: JudgmentBatch | undefined) =>
  batch?.inputs.map((input) => input.ts);

const heldTs = async () =>
  (
    await client.query<{ slack_ts: string }>(
      "SELECT slack_ts FROM conversation_inputs ORDER BY slack_ts",
    )
  ).rows.map((row) => row.slack_ts);

const tally = async () =>
  (
    await client.query<{
      rate_limited_count: string;
      unjudged_count: string;
    }>(
      "SELECT rate_limited_count, unjudged_count FROM judgment_channel_tallies WHERE agent_id = $1",
      [AGENT],
    )
  ).rows.map((row) => ({
    rateLimited: Number(row.rate_limited_count),
    unjudged: Number(row.unjudged_count),
  }))[0] ?? { rateLimited: 0, unjudged: 0 };

describe("judgment batches", () => {
  test("a batch closes once the channel has been quiet 15 seconds, not at 14", async () => {
    const judge = fakeJudge();
    const first = await post(0);
    const second = await post(5 * SEC);
    expect((await pass(judge.judge, 19 * SEC)).judged).toBe(0);
    expect(judge.judged).toHaveLength(0);
    expect((await pass(judge.judge, 20 * SEC)).judged).toBe(1);
    expect(tsOf(judge.judged[0])).toEqual([first, second]);
    expect(judge.judged[0]).toMatchObject({
      agentId: AGENT,
      teamId: TEAM,
      channelId: CHANNEL,
      releaseId: RELEASE,
    });
    // Judged, they are in no later batch.
    expect((await pass(judge.judge, 40 * SEC)).judged).toBe(0);
  });

  test("talk every 10 seconds closes once, 60 seconds after its first message", async () => {
    const judge = fakeJudge();
    const posted: string[] = [];
    for (let ms = 0; ms <= 50 * SEC; ms += 10 * SEC) {
      posted.push(await post(ms));
      expect((await pass(judge.judge, ms + 9 * SEC)).judged).toBe(0);
    }
    expect((await pass(judge.judge, 59 * SEC)).judged).toBe(0);
    expect((await pass(judge.judge, 60 * SEC)).judged).toBe(1);
    expect(tsOf(judge.judged[0])).toEqual(posted);
  });

  test("more than 10 messages inside 15 seconds do not close a batch by count", async () => {
    const judge = fakeJudge();
    for (let n = 0; n < 12; n++) await post(n * SEC);
    expect((await pass(judge.judge, 11 * SEC)).judged).toBe(0);
    expect((await pass(judge.judge, 25 * SEC)).judged).toBe(0);
    expect((await pass(judge.judge, 26 * SEC)).judged).toBe(1);
    expect(judge.judged[0]?.inputs).toHaveLength(12);
  });

  test("while a judgment runs the next batch waits, then goes", async () => {
    const store = createPostgresJudgmentBatchStore(db);
    await post(0);
    const first = await store.closeNext({ now: at(15 * SEC) });
    expect(first?.outcome).toBe("judging");
    const later = await post(16 * SEC);
    expect(await store.closeNext({ now: at(40 * SEC) })).toBeNull();
    if (!first) throw new Error("no batch");
    expect(
      await store.finish(
        first.batch.id,
        { modelCalled: true, left: [] },
        { now: at(41 * SEC) },
      ),
    ).toBe("finished");
    const next = await store.closeNext({ now: at(41 * SEC) });
    expect(tsOf(next?.batch)).toEqual([later]);
  });

  test("the 13th batch in an hour is not judged; its messages wait for room, counted once", async () => {
    const judge = fakeJudge();
    for (let n = 0; n < M1_JUDGMENTS_PER_CHANNEL_WINDOW; n++) {
      await post(n * 20 * SEC);
      expect((await pass(judge.judge, n * 20 * SEC + 15 * SEC)).judged).toBe(1);
    }
    const over = await post(240 * SEC);
    expect(await pass(judge.judge, 255 * SEC)).toEqual({
      judged: 0,
      rateLimited: 1,
      failed: 0,
    });
    expect(tsOf(judge.rateLimited[0])).toEqual([over]);
    expect(judge.judged).toHaveLength(M1_JUDGMENTS_PER_CHANNEL_WINDOW);
    expect(await tally()).toEqual({ rateLimited: 1, unjudged: 0 });
    // Later passes neither judge nor count it again.
    expect(await pass(judge.judge, 300 * SEC)).toEqual({
      judged: 0,
      rateLimited: 0,
      failed: 0,
    });
    expect(await tally()).toEqual({ rateLimited: 1, unjudged: 0 });
    expect(await heldTs()).toContain(over);
    // The oldest batch leaves the window (moved back past the hour, since
    // the message would expire long before the real one does).
    await client.query(
      "UPDATE judgment_batches SET closed_at = closed_at - interval '61 minutes' WHERE id = (SELECT id FROM judgment_batches ORDER BY closed_at LIMIT 1)",
    );
    expect((await pass(judge.judge, 301 * SEC)).judged).toBe(1);
    expect(tsOf(judge.judged.at(-1))).toEqual([over]);
    expect(await tally()).toEqual({ rateLimited: 1, unjudged: 0 });
  });

  test("a batch stopped before the model does not count against the cap", async () => {
    const judge = fakeJudge(() => ({ modelCalled: false, left: [] }));
    for (let n = 0; n <= M1_JUDGMENTS_PER_CHANNEL_WINDOW; n++) {
      await post(n * 20 * SEC);
      await pass(judge.judge, n * 20 * SEC + 15 * SEC);
    }
    expect(judge.judged).toHaveLength(M1_JUDGMENTS_PER_CHANNEL_WINDOW + 1);
    expect(judge.rateLimited).toHaveLength(0);
  });

  test("a judgment that fails counts, and its messages expire unjudged", async () => {
    const judge = {
      judge: {
        async judge(): Promise<JudgmentBatchResult> {
          throw new Error("judge down");
        },
        async rateLimited() {},
      },
    };
    const warned: string[] = [];
    const failed = await post(0);
    expect(
      await pass(judge.judge, 15 * SEC, {
        warn: (message) => {
          warned.push(message);
        },
      }),
    ).toEqual({ judged: 0, rateLimited: 0, failed: 1 });
    expect(warned).toEqual(["Judgment batch failed"]);
    // In its failed batch, not in the next.
    const next = fakeJudge();
    expect((await pass(next.judge, 60 * SEC)).judged).toBe(0);
    expect(await heldTs()).toEqual([failed]);
  });

  test("a judging batch past its deadline is failed and frees the channel", async () => {
    const store = createPostgresJudgmentBatchStore(db);
    await post(0);
    const stuck = await store.closeNext({ now: at(15 * SEC) });
    const later = await post(20 * SEC);
    expect(await store.closeNext({ now: at(2 * MIN) })).toBeNull();
    const next = await store.closeNext({ now: at(2 * MIN + 15 * SEC) });
    expect(tsOf(next?.batch)).toEqual([later]);
    if (!stuck) throw new Error("no batch");
    expect(
      await store.finish(stuck.batch.id, { modelCalled: true, left: [] }),
    ).toBe("late");
  });

  test("messages the judgment left out go to the next batch and stay buffered", async () => {
    let first = true;
    const judge = fakeJudge((batch) => {
      const oldest = batch.inputs[0];
      if (!first || oldest === undefined)
        return { modelCalled: true, left: [] };
      first = false;
      return { modelCalled: true, left: [oldest.inputId] };
    });
    const old = await post(0);
    const kept = await post(1 * SEC);
    // The message left out is already due: the same pass judges it next.
    expect((await pass(judge.judge, 16 * SEC)).judged).toBe(2);
    expect(tsOf(judge.judged[0])).toEqual([old, kept]);
    expect(tsOf(judge.judged[1])).toEqual([old]);
    expect(await heldTs()).toEqual([old, kept]);
  });

  describe("no batch while the channel is not judged", () => {
    const cases: [string, string, unknown[]][] = [
      [
        "the switch is off",
        "UPDATE agents SET conversation_rollout = 'off' WHERE id = $1",
        [AGENT],
      ],
      [
        "the agent has no active release",
        "UPDATE agents SET active_release_id = NULL, activation_revision = -1 WHERE id = $1",
        [AGENT],
      ],
      [
        "the channel listens for mentions only",
        "UPDATE surface_bindings SET listen = 'mention' WHERE agent_id = $1",
        [AGENT],
      ],
      [
        "the channel is archived",
        "UPDATE conversations SET channel_state = 'archived' WHERE agent_id = $1",
        [AGENT],
      ],
    ];
    for (const [name, change, params] of cases) {
      test(name, async () => {
        const judge = fakeJudge();
        await post(0);
        await client.query(change, params);
        expect(await pass(judge.judge, 2 * MIN)).toEqual({
          judged: 0,
          rateLimited: 0,
          failed: 0,
        });
        const batches = await client.query("SELECT 1 FROM judgment_batches");
        expect(batches.rows).toHaveLength(0);
      });
    }
  });

  test("a batch carries an edit's new text and not a message deleted or expired before it closed", async () => {
    const judge = fakeJudge();
    const edited = await post(0, "old text");
    const deleted = await post(1 * SEC);
    const expired = await post(2 * SEC);
    const kept = await post(3 * SEC);
    const editedAt = new Date();
    await client.query(
      "INSERT INTO edited_sources (workspace_id, team_id, channel_id, ts, edited_at) VALUES ($1, $2, $3, $4, $5)",
      [WORKSPACE, TEAM, CHANNEL, edited, editedAt.toISOString()],
    );
    await db.transaction((tx) =>
      editBufferedMessage(tx, {
        workspaceId: WORKSPACE,
        teamId: TEAM,
        channelId: CHANNEL,
        ts: edited,
        at: editedAt,
        body: "new text",
      }),
    );
    await db.transaction((tx) =>
      dropBufferedMessage(tx, {
        workspaceId: WORKSPACE,
        teamId: TEAM,
        channelId: CHANNEL,
        ts: deleted,
      }),
    );
    await client.query(
      "UPDATE conversation_inputs SET buffer_expires_at = $1 WHERE slack_ts = $2",
      [at(10 * SEC).toISOString(), expired],
    );
    await pass(judge.judge, 20 * SEC);
    expect(tsOf(judge.judged[0])).toEqual([edited, kept]);
    expect(judge.judged[0]?.inputs[0]?.body).toBe("new text");
  });

  test("messages past 10 minutes with no judgment go, counted unjudged; judged ones are not", async () => {
    const judge = fakeJudge();
    await post(0);
    await pass(judge.judge, 15 * SEC);
    const unjudged = await post(20 * SEC);
    await client.query(
      "UPDATE agents SET active_release_id = NULL, activation_revision = -1 WHERE id = $1",
      [AGENT],
    );
    const later = at(11 * MIN);
    expect(
      await purgeJudgmentBuffer(db, { limit: 100, dryRun: true, now: later }),
    ).toEqual({ expired: 2, unjudged: 1, unlistened: 0, batches: 0 });
    expect(
      await purgeJudgmentBuffer(db, { limit: 100, dryRun: false, now: later }),
    ).toEqual({ expired: 2, unjudged: 1, unlistened: 0, batches: 0 });
    expect(await heldTs()).toEqual([]);
    expect(await tally()).toEqual({ rateLimited: 0, unjudged: 1 });
    expect(unjudged).toBeDefined();
  });

  test("the 10 minutes stand: a message is held at 9 and gone at 10", async () => {
    const ts = await post(0);
    const purge = (ms: number) =>
      purgeJudgmentBuffer(db, { limit: 100, dryRun: false, now: at(ms) });
    expect((await purge(9 * MIN)).expired).toBe(0);
    expect(await heldTs()).toEqual([ts]);
    // Stamped by the database a moment after `base`.
    expect((await purge(10 * MIN + 5 * SEC)).expired).toBe(1);
  });

  test("ended batches go once past the cap's window, a judging one stays", async () => {
    const store = createPostgresJudgmentBatchStore(db);
    const judge = fakeJudge();
    await post(0);
    await pass(judge.judge, 15 * SEC);
    await post(20 * SEC);
    await store.closeNext({ now: at(35 * SEC) });
    const purge = (ms: number) =>
      purgeJudgmentBuffer(db, { limit: 100, dryRun: false, now: at(ms) });
    expect((await purge(60 * MIN)).batches).toBe(0);
    expect((await purge(60 * MIN + 20 * SEC)).batches).toBe(1);
    const left = await client.query<{ state: string }>(
      "SELECT state FROM judgment_batches",
    );
    expect(left.rows).toEqual([{ state: "judging" }]);
  });
});
