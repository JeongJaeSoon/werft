import { randomUUID } from "node:crypto";
import type { ExecutionBackend } from "@werft-ai/contracts";
import {
  type ConfirmExecutionGoneResult,
  DEFAULT_NONCE_TTL_MS,
  generateLaunchNonce,
  hashWorkerToken,
  type ReserveLaunchInput,
} from "@werft-ai/platform";

import { fromDbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { createPostgresSchedulerStore } from "../scheduler/scheduler-store.ts";
import { workerLaunches } from "../schema.ts";
import { createPostgresWorkerUnitOfWork } from "../worker-unit-of-work.ts";

export type TestLaunch = {
  executionId: string;
  generation: number;
  nonce: string;
};

const SPEC = {
  image: "sha256:worker",
  resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
};

/**
 * Launches for a session the way the scheduler does — reservation, then the
 * bootstrap nonce its container would carry — so a test claims through the
 * production path. Budget is not judged here: the gate a test exercises is
 * the claim's own. Throws when the session is not launchable now.
 */
export async function launchSession(
  db: Database,
  input: {
    sessionId: string;
    backend?: ExecutionBackend;
    image?: string;
    imageRuntime?: ReserveLaunchInput["imageRuntime"];
    nonceTtlMs?: number;
    now?: Date;
  },
): Promise<TestLaunch> {
  const store = createPostgresSchedulerStore(db, {
    connectForLock: () =>
      Promise.reject(new Error("launchSession takes no pass lock")),
    sessionCostLimitUsd: Number.POSITIVE_INFINITY,
    sessionTokenLimit: null,
    ...(input.nonceTtlMs === undefined ? {} : { nonceTtlMs: input.nonceTtlMs }),
  });
  const intent = await store.reserveLaunch({
    ...SPEC,
    backend: input.backend ?? "local_docker",
    image: input.image ?? SPEC.image,
    ...(input.imageRuntime === undefined
      ? {}
      : { imageRuntime: input.imageRuntime }),
    now: input.now ?? new Date(),
    sessionId: input.sessionId,
    slotLimit: Number.MAX_SAFE_INTEGER,
  });
  if (!intent) {
    throw new Error(`Session ${input.sessionId} is not launchable`);
  }
  const nonce = await store.issueBootstrapNonce({
    executionId: intent.executionId,
    generation: intent.generation,
  });
  return {
    executionId: intent.executionId,
    generation: intent.generation,
    nonce,
  };
}

/**
 * A launch reserved for no session, which `claimAtomic` serves from its
 * partition's head. No production path writes one; it is for the tests of
 * that branch alone.
 */
export async function insertUnreservedLaunch(
  db: Database,
  input: { partition: string },
): Promise<TestLaunch> {
  const executionId = `exec-${randomUUID()}`;
  const nonce = generateLaunchNonce();
  await db.insert(workerLaunches).values({
    executionId,
    generation: 1,
    partition: input.partition,
    sessionId: null,
    backend: "local_docker",
    nonceHash: hashWorkerToken(nonce),
    nonceExpiresAt: fromDbNow(DEFAULT_NONCE_TTL_MS),
  });
  return { executionId, generation: 1, nonce };
}

/**
 * The backend observing the execution gone, with no incarnation to fence
 * on — `SchedulerStore.confirmExecutionGone` given null — returning what was
 * released rather than the scheduler's verdict.
 */
export function confirmExecutionGone(
  db: Database,
  executionId: string,
  now: Date = new Date(),
): Promise<ConfirmExecutionGoneResult> {
  return createPostgresWorkerUnitOfWork(db).confirmExecutionGoneAtomic({
    executionId,
    now,
  });
}
