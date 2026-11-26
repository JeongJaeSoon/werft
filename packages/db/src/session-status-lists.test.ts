import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ListSessionsQuery, SessionStatus } from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createSessionService,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  executions,
  pendingRequests,
  sessions,
  turns,
} from "./schema.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";

// The status-filtered lists read through the in-flight index and the open
// requests (94S-2279): what they return and in which order must not move.

const OWNER = testCaller("00000000-0000-4000-8000-00000000002a");
const OTHER = testCaller("00000000-0000-4000-8000-00000000002b");
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

const service = () =>
  createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog: testSessionCatalog({
      repositories: {
        app: {
          url: "https://example.invalid/app.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    }),
    limits: {
      ...LIMITS,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });

type Request = "parked" | "expired" | "resolved";

/** A session of `owner` stored as `status`, created at `minute`. */
async function sessionAt(
  owner: typeof OWNER,
  status: "running" | "idle" | "stopped",
  minute: number,
  request?: Request,
) {
  const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    principal: owner,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    repository: {
      id: "app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    message: "turn 1",
    limits: LIMITS,
  });
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  const sessionId = created.response.session_id;
  await db
    .update(sessions)
    .set({
      status,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, minute)),
    })
    .where(eq(sessions.id, sessionId));
  if (request) {
    const [turn] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    if (!turn) throw new Error("turn missing");
    // Parked, so the attempt that asked may be gone; its row stays.
    const attemptId = `att-${sessionId}`;
    await db.insert(executions).values({
      id: `exec-${sessionId}`,
      sessionId,
      backend: "local_docker",
      generation: 0,
      desiredState: "stopped",
      observedState: "stopped",
    });
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId: `exec-${sessionId}`,
      leaseEpoch: 0,
      executionGeneration: 0,
      authRevision: 0,
      state: "exited",
      leaseExpiresAt: new Date(0),
    });
    await db.insert(pendingRequests).values({
      requestId: `req-${sessionId}`,
      sessionId,
      turnId: turn.id,
      attemptId,
      kind: "question",
      payload: {},
      inputHash: "h",
      parkedAt: new Date(),
      expiresAt:
        request === "expired"
          ? sql`now() - interval '1 minute'`
          : sql`now() + interval '1 day'`,
      resolvedAt: request === "resolved" ? new Date() : null,
    });
  }
  return sessionId;
}

async function ids(query: Partial<ListSessionsQuery>) {
  const page = await service().listSessions(OWNER, { limit: 50, ...query });
  return page.items.map((item) => item.id);
}

/** Every page of `status`, `limit` at a time, following the cursor. */
async function paged(status: SessionStatus, limit: number) {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await service().listSessions(OWNER, {
      limit,
      status,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((item) => item.id));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return seen;
}

describe("status-filtered session lists (94S-2279)", () => {
  test("running and needs_input list exactly their sessions, newest first, and the counts agree", async () => {
    const oldRunning = await sessionAt(OWNER, "running", 1);
    const waitingIdle = await sessionAt(OWNER, "idle", 2, "parked");
    await sessionAt(OWNER, "stopped", 3);
    const expiredAsk = await sessionAt(OWNER, "running", 4, "expired");
    const answered = await sessionAt(OWNER, "running", 5, "resolved");
    const waitingRunning = await sessionAt(OWNER, "running", 6, "parked");
    const idle = await sessionAt(OWNER, "idle", 7);
    // Two in one instant: the id breaks the tie, descending.
    const tieA = await sessionAt(OWNER, "running", 8);
    const tieB = await sessionAt(OWNER, "running", 8);
    await sessionAt(OTHER, "running", 9);
    await sessionAt(OTHER, "idle", 9, "parked");

    const ties = [tieA, tieB].sort().reverse();
    const running = [...ties, answered, expiredAsk, oldRunning];
    const waiting = [waitingRunning, waitingIdle];

    expect(await ids({ status: "running" })).toEqual(running);
    expect(await ids({ status: "needs_input" })).toEqual(waiting);
    expect(await ids({ status: "idle" })).toEqual([idle]);
    // A page at a time reads the same rows in the same order.
    expect(await paged("running", 2)).toEqual(running);
    expect(await paged("needs_input", 1)).toEqual(waiting);

    const { counts } = await service().countSessions(OWNER, {});
    expect(counts).toMatchObject({
      running: running.length,
      needs_input: waiting.length,
      idle: 1,
      stopped: 1,
    });
  });
});
