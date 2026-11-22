import { createPostgresSessionUnitOfWork, type Database } from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import type { WorkerGateway } from "@werft-ai/platform";
import { releaseIn, TEST_OWNER } from "./releases.ts";

/** A new session's execution, launched and bootstrap-claimed through the gateway. */
export async function claimed(db: Database, gateway: WorkerGateway) {
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: TEST_OWNER },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    agentReleaseId: await releaseIn(db),
    model: TEST_MODEL,
    repository: {
      id: "sample-app",
      url: "https://git.invalid/agent/app.git",
      branch: "main",
    },
    message: "hello",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  const launch = await launchSession(db, {
    sessionId: accepted.response.session_id,
  });
  return await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    },
  );
}
