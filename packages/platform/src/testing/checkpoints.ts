import { createReadStream } from "node:fs";
import type { CheckpointRef } from "@werft-ai/contracts";
import {
  gitBundleOffersFrom,
  type RuntimeFingerprint,
  transcriptBytes,
  transcriptParts,
} from "@werft-ai/runtime-core";

import type { CheckpointService } from "../checkpoints/checkpoint-service.ts";
import type { CheckpointFence } from "../checkpoints/ports/checkpoint-store.ts";
import {
  type CheckpointOutputObject,
  type CheckpointVerifier,
  checkpointOutputObjects,
  checkpointOutputsDigest,
} from "../checkpoints/ports/checkpoint-verifier.ts";
import type { WorkspaceBundleVerifier } from "../checkpoints/ports/workspace-bundle-verifier.ts";

// Test-only: accepts any structurally valid ref. A deployment that wires
// this promotes checkpoint pointers nobody has read, and the damage only
// surfaces at the next restore, when the execution that wrote them is gone.
export const acceptAllCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "verified" };
  },
};

/**
 * Everything the bytes alone can settle, and deliberately not more.
 *
 * The bundle header must name the commit as a ref tip and demand no
 * prerequisite a fresh workspace cannot have, and the packfile must match the
 * checksum git wrote into it. That rules out a commit that was never captured,
 * a truncated upload and a corrupted object — the accidents a checkpoint
 * actually meets.
 *
 * What it cannot rule out is a *fabricated* pack: a header, an object count
 * and a recomputed trailer are all things whoever wrote the object could have
 * produced, and the manifest's own digest is no help because the worker hashed
 * the same bytes. Only reconstructing the pack settles that. Test-only: a
 * deployment that wired this instead of a git-backed verifier would be
 * trusting its workers about their own commits.
 */
export const structuralBundleVerifier: WorkspaceBundleVerifier = {
  async verify({ bases = [], commit, key, path }) {
    const earlier = new Set<string>();
    for (const [index, link] of [...bases, { key, path }].entries()) {
      const verdict = await gitBundleOffersFrom(
        createReadStream(link.path),
        index === bases.length ? commit : undefined,
        earlier,
      );
      if (verdict.status !== "offers") {
        return {
          status: "unusable",
          reason:
            bases.length === 0
              ? verdict.reason
              : `${link.key}: ${verdict.reason}`,
        };
      }
      for (const tip of verdict.tips) earlier.add(tip);
    }
    return { status: "restorable" };
  },
};

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
