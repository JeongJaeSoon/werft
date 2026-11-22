// Test fixtures only: sessions with their first input, for tests that drive
// a worker gateway.
import type { AcceptSessionInput, WorkerGateway } from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import { createPostgresSessionUnitOfWork } from "../postgres-unit-of-work.ts";
import type { Database } from "../queries.ts";
import { sessions, unassignedSessions } from "../schema.ts";
import { type TestWorker, workerOf } from "./gateway.ts";
import { launchSession } from "./launches.ts";
import { fixtureRelease, TEST_MODEL } from "./spec-pins.ts";

export type PartitionedSession = {
  sessionId: string;
  ownerId: string;
  partition: string;
};

async function firstInput(
  db: Database,
  principal: AcceptSessionInput["principal"],
): Promise<string> {
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    repository: {
      id: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    message: "first input",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  return accepted.response.session_id;
}

/**
 * A session with its first input, for a new owner, on a partition of its own
 * named after `name`.
 */
export async function newPartitionedSession(
  db: Database,
  name: string,
): Promise<PartitionedSession> {
  const partition = `${name}-${crypto.randomUUID()}`;
  const ownerId = crypto.randomUUID();
  const sessionId = await firstInput(db, { ownerId });
  await db
    .update(sessions)
    .set({ partition })
    .where(eq(sessions.id, sessionId));
  await db
    .update(unassignedSessions)
    .set({ partition })
    .where(eq(unassignedSessions.sessionId, sessionId));
  return { sessionId, ownerId, partition };
}

/** A session with its first input, bound to a launch its worker claimed. */
export async function claimedSession(
  db: Database,
  gateway: WorkerGateway,
  principal: AcceptSessionInput["principal"],
): Promise<TestWorker & { sessionId: string }> {
  const sessionId = await firstInput(db, principal);
  const { executionId, generation, nonce } = await launchSession(db, {
    sessionId,
  });
  const claimed = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    },
  );
  return { sessionId, ...workerOf(claimed, executionId) };
}
