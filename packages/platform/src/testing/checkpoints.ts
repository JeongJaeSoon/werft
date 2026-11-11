import type { CheckpointRef } from "@werft-ai/contracts";
import {
  type RuntimeFingerprint,
  transcriptBytes,
  transcriptParts,
} from "@werft-ai/runtime-core";

import type { CheckpointService } from "../checkpoints/checkpoint-service.ts";
import type { CheckpointFence } from "../checkpoints/ports/checkpoint-store.ts";
import {
  type CheckpointOutputObject,
  checkpointOutputObjects,
  checkpointOutputsDigest,
} from "../checkpoints/ports/checkpoint-verifier.ts";

export type CommitCheckpointInput = {
  checkpoint: CheckpointRef;
  fence: CheckpointFence;
  now: Date;
  sessionId: string;
  turnId: string | null;
  /** The verifier's `versionsHeld`, recorded on the pointer. */
  versionsHeld?: boolean;
  /** The verified manifest's transcript total, recorded on its row. */
  transcriptBytes?: number;
  /** The verified manifest's stored output objects, recorded beside it. */
  outputs?: readonly CheckpointOutputObject[];
  /** The verified manifest's out/ list digest, recorded on its row. */
  outputsDigest?: string | null;
  /** The verified manifest's runtime fingerprint, recorded on its row. */
  runtime?: RuntimeFingerprint;
};

export type CommitCheckpointResult =
  | { outcome: "committed" | "replayed"; revision: number }
  // The pointer already stands at this revision or a later one: another epoch
  // finalized while this one was uploading.
  | { outcome: "conflict"; currentRevision: number | null }
  // The fence no longer matches the session row; another epoch owns it.
  | { outcome: "stale_epoch" | "lease_expired" };

/** A test store's pointer advance, standing in for `finalizeAtomic`'s. */
export type CommitCheckpoint = (
  input: CommitCheckpointInput,
) => Promise<CommitCheckpointResult>;

export type FinalizeCheckpointInput = {
  checkpoint: CheckpointRef;
  fence: CheckpointFence;
  now: Date;
  sessionId: string;
  turnId: string | null;
};

export type FinalizeCheckpointResult =
  | { outcome: "committed" | "replayed"; revision: number }
  | { currentRevision: number | null; outcome: "conflict" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "stale_epoch" | "lease_expired" };

/**
 * What a turn's finalize does to its checkpoint, without the turn: the
 * manifest is judged by `verifyAttemptManifest`, exactly as the gateway judges
 * it, and only a verified one reaches `commit`. Production has no turn-less
 * commit — the pointer moves in `finalizeAtomic`, with the turn's terminal —
 * so tests that need checkpoint history or a verdict drive it through here.
 */
export async function finalizeCheckpoint(
  service: Pick<CheckpointService, "verifyAttemptManifest">,
  commit: CommitCheckpoint,
  input: FinalizeCheckpointInput,
): Promise<FinalizeCheckpointResult> {
  if (input.fence.sessionId !== input.sessionId) {
    return {
      outcome: "rejected",
      reason: `fence belongs to session ${input.fence.sessionId}`,
    };
  }
  const verdict = await service.verifyAttemptManifest({
    checkpoint: input.checkpoint,
    fence: input.fence,
  });
  if (verdict.status === "rejected") {
    return { outcome: "rejected", reason: verdict.reason };
  }
  return commit({
    checkpoint: input.checkpoint,
    fence: input.fence,
    now: input.now,
    sessionId: input.sessionId,
    turnId: input.turnId,
    versionsHeld: verdict.versionsHeld === true,
    transcriptBytes: transcriptBytes(
      transcriptParts(verdict.manifest.transcripts),
    ),
    outputs: checkpointOutputObjects(verdict.manifest.outputs),
    outputsDigest: checkpointOutputsDigest(verdict.manifest.outputs),
    runtime: verdict.manifest.runtime,
  });
}
