import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { TASK_CLOSING_DEFAULT } from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { events, sessionOutcomes, sessions } from "../schema.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import { createPostgresTaskCloses } from "./task-close.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

type PullState = "open" | "merged" | "closed";

async function pullRequest(
  sessionId: string,
  number: string,
  state: PullState,
) {
  const [session] = await db
    .select({ ownerId: sessions.ownerId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  await db.insert(sessionOutcomes).values({
    id: randomUUID(),
    ownerId: session?.ownerId ?? "",
    sessionId,
    type: "github_pull_request",
    url: `https://github.com/acme/app/pull/${number}`,
    externalId: number,
    state,
    stateChangedAt: new Date(),
  });
}

async function taskWithPullRequest(
  name: string,
  state: PullState = "merged",
): Promise<string> {
  const { sessionId } = await newPartitionedSession(db, name);
  await db
    .update(sessions)
    .set({ taskClosing: TASK_CLOSING_DEFAULT })
    .where(eq(sessions.id, sessionId));
  await pullRequest(sessionId, name, state);
  return sessionId;
}

const taskOf = async (sessionId: string) =>
  (
    await db
      .select({
        admission: sessions.admissionState,
        reason: sessions.taskClosedReason,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
  )[0];

test("a task the close keeps refusing does not hold the ones after it out of every pass", async () => {
  const [stuck, next] = [
    await taskWithPullRequest("1"),
    await taskWithPullRequest("2"),
  ].sort();
  if (stuck === undefined || next === undefined) throw new Error("no tasks");
  // A legacy pod binding: closeAtomic answers unsupported every time.
  await db
    .update(sessions)
    .set({ podId: "legacy-pod" })
    .where(eq(sessions.id, stuck));
  const sweep = createPostgresTaskCloses(db);

  expect(await sweep.closeOnPullRequests(1)).toBe(0);
  expect(await sweep.closeOnPullRequests(1)).toBe(1);
  expect(await taskOf(next)).toEqual({
    admission: "closed",
    reason: "completed",
  });
  // Past the last one the pass finds none and starts over: the one refused
  // before is tried again and, no longer refused, closes.
  await db.update(sessions).set({ podId: null }).where(eq(sessions.id, stuck));
  expect(await sweep.closeOnPullRequests(1)).toBe(0);
  expect(await sweep.closeOnPullRequests(1)).toBe(1);
  expect(await taskOf(stuck)).toEqual({
    admission: "closed",
    reason: "completed",
  });
});

/** The database, with `then` run right after the pass reads its candidates. */
function afterCandidates(then: () => Promise<void>): Database {
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "execute") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<Database["execute"]>) => {
        const rows = await target.execute(...args);
        await then();
        return rows;
      };
    },
  });
}

test.each([
  ["open", { admission: "active", reason: null }],
  ["merged", { admission: "closed", reason: "completed" }],
] as const)(
  "a pull request saved %s after the pass chose a task to cancel is what its close judges",
  async (state, after) => {
    const sessionId = await taskWithPullRequest("1", "closed");
    const sweep = createPostgresTaskCloses(
      afterCandidates(() => pullRequest(sessionId, "2", state)),
    );
    expect(await sweep.closeOnPullRequests(10)).toBe(state === "open" ? 0 : 1);
    expect(await taskOf(sessionId)).toEqual(after);
  },
);

// 94S-2539 (M14): who the status event of a close names.
describe("the actor a task's close is recorded as", () => {
  const actorsOf = async (sessionId: string) =>
    (
      await db
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
    )
      .map(({ payload }) => (payload as { actor?: unknown }).actor)
      .filter((actor) => actor !== undefined);

  test("a pull request's close names the pull request event, not the owner", async () => {
    const sessionId = await taskWithPullRequest("1", "merged");
    expect(await createPostgresTaskCloses(db).closeOnPullRequests(10)).toBe(1);
    expect(await actorsOf(sessionId)).toEqual([
      { kind: "system", by: "pull_request_event" },
    ]);
  });

  test("its requester's close names the owner it closed under", async () => {
    const sessionId = await taskWithPullRequest("1", "open");
    const [session] = await db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const ownerId = session?.ownerId ?? "";
    expect(
      await createPostgresTaskCloses(db).close({
        principal: { ownerId },
        sessionId,
        reason: "cancelled",
      }),
    ).toBe("closed");
    expect(await actorsOf(sessionId)).toEqual([{ owner_id: ownerId }]);
  });
});
