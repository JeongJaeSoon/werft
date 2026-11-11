import type {
  CommitCheckpointInput,
  CommitCheckpointResult,
} from "@werft-ai/platform/testing/checkpoints";
import type { Database } from "../queries.ts";
import { acquireFence } from "../sessions/fence.ts";
import { advanceCheckpointPointer } from "../worker-unit-of-work.ts";

/**
 * The fenced pointer advance a turn's finalize makes, with no turn: what
 * tests use to lay down checkpoint history. Production commits only in
 * `finalizeAtomic`, together with the turn's terminal.
 */
export function commitCheckpoint(
  db: Database,
  input: CommitCheckpointInput,
): Promise<CommitCheckpointResult> {
  if (input.turnId !== null) {
    return Promise.reject(
      new Error(
        "commitCheckpoint lays down turn-less history only; a turn's checkpoint goes through finalizeAtomic",
      ),
    );
  }
  return db.transaction(async (tx) => {
    if (input.sessionId !== input.fence.sessionId) {
      return { outcome: "stale_epoch" };
    }
    const fenced = await acquireFence(tx, input.fence);
    if (fenced.outcome !== "ok") return fenced;
    const advanced = await advanceCheckpointPointer(tx, {
      fence: input.fence,
      session: fenced.session,
      checkpoint: input.checkpoint,
      turnRowId: null,
      now: input.now,
      versionsHeld: input.versionsHeld === true,
      ...(input.transcriptBytes === undefined
        ? {}
        : { transcriptBytes: input.transcriptBytes }),
      ...(input.outputs === undefined ? {} : { outputs: input.outputs }),
      ...(input.outputsDigest === undefined
        ? {}
        : { outputsDigest: input.outputsDigest }),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    });
    return advanced.outcome === "committed"
      ? advanced
      : { outcome: "conflict", currentRevision: advanced.currentRevision };
  });
}
