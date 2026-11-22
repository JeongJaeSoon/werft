// Test fixtures only: a worker gateway over the database, and the worker a
// bootstrap claim hands back.
import type { WorkerScope } from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import type { Database } from "../queries.ts";
import { createPostgresWorkerUnitOfWork } from "../worker-unit-of-work.ts";

/**
 * A gateway whose checkpoints all verify, with a session budget no test
 * reaches; `deps` adds or replaces what a test needs.
 */
export function testWorkerGateway(
  db: Database,
  catalog: SessionCatalog,
  deps: Partial<Parameters<typeof createWorkerGateway>[0]> = {},
): WorkerGateway {
  return createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog,
    checkpoints: {
      async verify() {
        return { status: "verified" };
      },
    },
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 60_000,
      sleep: async () => {},
    },
    ...deps,
  });
}

export type TestWorker = {
  principal: WorkerPrincipal;
  scope: WorkerScope;
  executionId: string;
};

export function workerOf(
  claimed: Awaited<ReturnType<WorkerGateway["bootstrapClaim"]>>,
  executionId: string,
): TestWorker {
  return {
    principal: {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    },
    scope: {
      session_id: claimed.session_id,
      turn_id: null,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    },
    executionId,
  };
}
