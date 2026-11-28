import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { TASK_CLOSING_DEFAULT } from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { sessionOutcomes, sessions } from "../schema.ts";
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

async function taskWithMergedPullRequest(name: string): Promise<string> {
  const { sessionId, ownerId } = await newPartitionedSession(db, name);
  await db
    .update(sessions)
    .set({ taskClosing: TASK_CLOSING_DEFAULT })
    .where(eq(sessions.id, sessionId));
  await db.insert(sessionOutcomes).values({
    id: randomUUID(),
    ownerId,
    sessionId,
    type: "github_pull_request",
    url: `https://github.com/acme/app/pull/${name}`,
    externalId: name,
    state: "merged",
    stateChangedAt: new Date(),
  });
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
    await taskWithMergedPullRequest("1"),
    await taskWithMergedPullRequest("2"),
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
  // Round again: the refused one is tried, the closed one is not.
  expect(await sweep.closeOnPullRequests(1)).toBe(0);
  expect(await taskOf(stuck)).toEqual({ admission: "active", reason: null });
});
