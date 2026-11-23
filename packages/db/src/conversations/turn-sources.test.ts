import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ConversationInputId, SlackMessageRef } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { queuePushFollowUps } from "../action/push-follow-ups.ts";
import { createPostgresSessionUnitOfWork } from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import {
  deletedSources,
  sessions,
  slackOutbox,
  turns,
  workspaces,
} from "../schema.ts";
import { createPostgresSlackOutboxStore } from "../surface/slack-outbox.ts";
import {
  createPostgresSlackSourceMarkStore,
  purgeUnknownSlackSourceMarks,
} from "../surface/slack-source-marks.ts";
import { fixtureRelease, TEST_MODEL } from "../testing/spec-pins.ts";
import {
  newTurnSources,
  recordSourceInput,
  sourceSetHoldsMark,
  sourcesHoldPlace,
} from "./turn-sources.ts";

const OWNER = testCaller("00000000-0000-4000-8000-00000000000a");
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };
const TEAM = "T0SRC";
const CHANNEL = "C0SRC";
const A = "1792800000.000100";
const B = "1792800000.000200";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

const slackMessage = (ts: string): SlackMessageRef => ({
  team_id: TEAM,
  channel_id: CHANNEL,
  ts,
  thread_ts: ts === A ? null : A,
  permalink: null,
});
const place = (ts: string) => ({ team_id: TEAM, channel_id: CHANNEL, ts });

async function create(slack: SlackMessageRef | null): Promise<string> {
  const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    principal: OWNER,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    titleSource: "derived",
    repository: {
      id: "app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    message: "start",
    limits: LIMITS,
    ...(slack === null ? {} : { channel: "slack", slackMessage: slack }),
  });
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  return created.response.session_id;
}

async function append(sessionId: string, slack: SlackMessageRef | null) {
  const appended = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
    principal: OWNER,
    sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message: "more",
    limits: LIMITS,
    ...(slack === null
      ? { channel: "web" }
      : { channel: "slack", slackMessage: slack }),
  });
  if (appended.outcome !== "accepted") throw new Error(appended.outcome);
}

const sourcesOf = async (sessionId: string) =>
  (
    await db
      .select({ sources: turns.sources })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence))
  ).map((row) => row.sources);

describe("turn sources", () => {
  test("a session from the web or the API has turns with no sources", async () => {
    const sessionId = await create(null);
    await append(sessionId, null);
    expect(await sourcesOf(sessionId)).toEqual([null, null]);
  });

  test("a Slack message is its turn's direct source; later turns inherit it, a web input's too", async () => {
    const sessionId = await create(slackMessage(A));
    await append(sessionId, slackMessage(B));
    await append(sessionId, null);
    expect(await sourcesOf(sessionId)).toEqual([
      { direct: [place(A)], inherited: [] },
      // B's direct sources hold only B; A is inherited.
      { direct: [place(B)], inherited: [place(A)] },
      { direct: [], inherited: [place(A), place(B)] },
    ]);
  });

  test("the push follow-up turn inherits the session's sources", async () => {
    const sessionId = await create(slackMessage(A));
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (session === undefined) throw new Error("no session");
    const pushRequestId = crypto.randomUUID();
    await client.query("SET session_replication_role = replica");
    await client.query(
      `INSERT INTO push_requests (id, owner_id, session_id, repository_id, checkpoint_revision, git_commit, target_branch, state, requested_by, request_receipt_id)
       VALUES ($1::uuid, $2, $3::uuid, 'repo', 1, repeat('a', 40), 'agent/' || $3::text || '-b' || left(replace($1::text, '-', ''), 12), 'requested', '{}', $1::uuid)`,
      [pushRequestId, session.ownerId, sessionId],
    );
    await client.query(
      "INSERT INTO push_follow_ups (push_request_id, session_id, message) VALUES ($1, $2, 'note')",
      [pushRequestId, sessionId],
    );
    await client.query("SET session_replication_role = origin");
    expect(await queuePushFollowUps(db, { session })).toBe(1);
    expect((await sourcesOf(sessionId))[1]).toEqual({
      direct: [],
      inherited: [place(A)],
    });
  });

  test("the input's id joins every key at its place in the session, and only there", async () => {
    const sessionId = await create(slackMessage(A));
    await append(sessionId, slackMessage(B));
    const other = await create(slackMessage(A));
    const inputId = crypto.randomUUID() as ConversationInputId;
    await recordSourceInput(db, {
      sessionId,
      inputId,
      place: { teamId: TEAM, channelId: CHANNEL, ts: A },
    });
    expect(await sourcesOf(sessionId)).toEqual([
      { direct: [{ input_id: inputId, ...place(A) }], inherited: [] },
      { direct: [place(B)], inherited: [{ input_id: inputId, ...place(A) }] },
    ]);
    expect(await sourcesOf(other)).toEqual([
      { direct: [place(A)], inherited: [] },
    ]);
  });
});

describe("input ids written after a set was read", () => {
  async function inputFor(sessionId: string, ts: string) {
    const [turn] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence))
      .limit(1);
    const workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, sessionId));
    const session = { workspaceId };
    const id = crypto.randomUUID() as ConversationInputId;
    await client.query("SET session_replication_role = replica");
    await client.query(
      `INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id, turn_id)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'user', 'u', $8)`,
      [
        id,
        session?.workspaceId ?? crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        TEAM,
        CHANNEL,
        ts,
        turn?.id,
      ],
    );
    await client.query("SET session_replication_role = origin");
    return id;
  }

  test("a turn inserted after its session's input was taken, but before the id reached the earlier turn, still names it", async () => {
    // complete() took A's input; the first turn's key is not named yet.
    const sessionId = await create(slackMessage(A));
    const inputId = await inputFor(sessionId, A);
    expect(await newTurnSources(db, { sessionId, slackMessage: null })).toEqual(
      {
        direct: [],
        inherited: [{ input_id: inputId, ...place(A) }],
      },
    );
  });

  test("an outbox row copied from a turn read before the id was written names it", async () => {
    const sessionId = await create(slackMessage(A));
    const inputId = await inputFor(sessionId, A);
    const [session] = await db
      .select({ workspaceId: sessions.workspaceId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    await client.query("SET session_replication_role = replica");
    await createPostgresSlackOutboxStore(db).enqueue({
      workspaceId: session?.workspaceId ?? crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      slackAppId: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
      kind: "reply",
      channelId: CHANNEL,
      threadTs: A,
      slackUserId: null,
      sessionId,
      sessionLinkId: null,
      body: { text: "done" },
      dedupeKey: crypto.randomUUID(),
      sources: { direct: [place(A)], inherited: [] },
    });
    await client.query("SET session_replication_role = origin");
    expect(
      (
        await db
          .select({ sources: slackOutbox.sources })
          .from(slackOutbox)
          .where(eq(slackOutbox.sessionId, sessionId))
      ).map((row) => row.sources),
    ).toEqual([
      { direct: [{ input_id: inputId, ...place(A) }], inherited: [] },
    ]);
  });
});

describe("delete marks and source sets", () => {
  async function workspace() {
    const id = crypto.randomUUID();
    await db.insert(workspaces).values({ id, slug: `ws-${id}`, name: "ws" });
    return id;
  }

  async function heldBy(workspaceId: string, ts: string) {
    const [row] = (
      await db.execute<{ held: boolean }>(
        sql`SELECT ${sourceSetHoldsMark({
          workspaceId: sql`${workspaceId}::uuid`,
          teamId: sql`${TEAM}::text`,
          channelId: sql`${CHANNEL}::text`,
          ts: sql`${ts}::text`,
        })} AS held`,
      )
    ).rows;
    return row?.held;
  }

  test("a turn holding a place, direct or inherited, without its input id, still holds the mark", async () => {
    // The input row never came: complete() did not run after the turn.
    const workspaceId = await workspace();
    const sessionId = await create(slackMessage(A));
    await append(sessionId, null);
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, sessionId));
    expect(await heldBy(workspaceId, A)).toBe(true);
    // Inherited only: the first turn no longer lists it.
    await db
      .update(turns)
      .set({ sources: null })
      .where(sql`${turns.sessionId} = ${sessionId} AND ${turns.sequence} = 1`);
    expect(await heldBy(workspaceId, A)).toBe(true);
    expect(await heldBy(workspaceId, B)).toBe(false);
    expect(await heldBy(await workspace(), A)).toBe(false);
  });

  test("an outbox row holding the place holds the mark", async () => {
    const workspaceId = await workspace();
    expect(await heldBy(workspaceId, B)).toBe(false);
    await client.query("SET session_replication_role = replica");
    await db.insert(slackOutbox).values({
      id: crypto.randomUUID(),
      workspaceId,
      agentId: crypto.randomUUID(),
      slackAppId: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
      kind: "reply",
      channelId: CHANNEL,
      threadTs: A,
      body: { text: "done" },
      dedupeKey: crypto.randomUUID(),
      sources: { direct: [], inherited: [place(B)] },
    });
    await client.query("SET session_replication_role = origin");
    expect(await heldBy(workspaceId, B)).toBe(true);
  });

  test("the unknown-mark purge keeps the mark of a message a turn came from", async () => {
    const workspaceId = await workspace();
    const sessionId = await create(slackMessage(A));
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, sessionId));
    const marks = createPostgresSlackSourceMarkStore(db);
    const at = new Date("2026-11-23T01:00:00.000Z");
    for (const ts of [A, B]) {
      await marks.markDeleted({
        workspaceId,
        teamId: TEAM,
        channelId: CHANNEL,
        ts,
        at,
      });
    }
    await db
      .update(deletedSources)
      .set({ markedAt: sql`now() - make_interval(mins => 71)` })
      .where(eq(deletedSources.workspaceId, workspaceId));
    expect(
      await purgeUnknownSlackSourceMarks(db, { limit: 10, dryRun: false }),
    ).toEqual({ deleted: 1, edited: 0 });
    expect(
      (
        await db
          .select({ ts: deletedSources.ts })
          .from(deletedSources)
          .where(eq(deletedSources.workspaceId, workspaceId))
      ).map((row) => row.ts),
    ).toEqual([A]);
  });

  test("the place test is the containment shape the GIN index answers", async () => {
    await client.query("SET enable_seqscan = off");
    const plan = (
      await db.execute<{ "QUERY PLAN": string }>(
        sql`EXPLAIN SELECT 1 FROM turns WHERE sources IS NOT NULL AND ${sourcesHoldPlace(
          sql.raw("turns.sources"),
          { teamId: TEAM, channelId: CHANNEL, ts: A },
        )}`,
      )
    ).rows
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toContain("turns_sources_idx");
  });
});
