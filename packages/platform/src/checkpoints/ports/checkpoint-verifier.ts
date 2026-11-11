import { createHash } from "node:crypto";
import type { CheckpointRef } from "@werft-ai/contracts";
import {
  type CheckpointOutput,
  type RuntimeFingerprint,
  storedOutputs,
  type TranscriptSizeProblem,
  transcriptBytes,
  transcriptParts,
} from "@werft-ai/runtime-core";
import type { WorkerFence } from "../../ports/worker-unit-of-work.ts";
import type { ManifestVerdict } from "../checkpoint-service.ts";
import type { CheckpointFence } from "./checkpoint-store.ts";

export type CheckpointOutputObject = { key: string; bytes: number };

// Two paths with the same content share one object, so one row per key.
export function checkpointOutputObjects(
  outputs: readonly CheckpointOutput[] | undefined,
): CheckpointOutputObject[] {
  const byKey = new Map<string, number>();
  for (const { key, bytes } of storedOutputs(outputs)) byKey.set(key, bytes);
  return [...byKey].map(([key, bytes]) => ({ key, bytes }));
}

/**
 * The out/ list as achievements see it, path by path; null when it names no
 * file. Object keys alone miss a rename, a copy to a new path, and a file
 * over the limits, which has no object.
 */
export function checkpointOutputsDigest(
  outputs: readonly CheckpointOutput[] | undefined,
): string | null {
  if (outputs === undefined || outputs.length === 0) return null;
  const lines = outputs
    .map((output) =>
      "omitted" in output
        ? `${output.path}\0${output.omitted}\0${output.bytes}`
        : `${output.path}\0${output.sha256}`,
    )
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export type CheckpointVerdict =
  // `versionsHeld`: see `ManifestVerdict`; finalize records it on the pointer.
  // `transcriptBytes`: the manifest's transcript total, recorded on its row.
  // `outputs`: the stored output objects it names, inherited ones included;
  // finalize records them beside its row, and `outputsDigest` on it.
  // `runtime`: the manifest's fingerprint, recorded on its row.
  | {
      status: "verified";
      outputs?: readonly CheckpointOutputObject[];
      outputsDigest?: string | null;
      runtime?: RuntimeFingerprint;
      transcriptBytes?: number;
      versionsHeld?: boolean;
    }
  // `limit`: see `ManifestVerdict`; the gateway records it on the session.
  | {
      limit?: TranscriptSizeProblem["reason"];
      reason: string;
      status: "rejected";
    };

// finalize refuses to promote a checkpoint pointer the verifier has not
// accepted. The whole fence is passed, not just the session: reading the
// manifest proves it exists, not that *this* attempt wrote it, and promoting
// another attempt's orphan manifest is exactly what the epoch is for.
// `serviceCheckpointVerifier` is the storage-backed one; the pointer itself
// is advanced by the turn's own transaction (finalizeAtomic), never here.
export interface CheckpointVerifier {
  verify(input: {
    fence: WorkerFence;
    turnId: string;
    checkpoint: CheckpointRef;
    // The gateway's clock at the call, so a verifier that judges freshness
    // uses the same one the fence is judged against.
    at: Date;
  }): Promise<CheckpointVerdict>;
}

// Test-only: accepts any structurally valid ref. A deployment that wires
// this promotes checkpoint pointers nobody has read, and the damage only
// surfaces at the next restore, when the execution that wrote them is gone.
export const acceptAllCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "verified" };
  },
};

// What a composition root gets when no object store is configured: finalize
// without a checkpoint still commits, and a checkpoint is refused rather than
// trusted.
export const rejectUnverifiedCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "rejected", reason: "no checkpoint verifier configured" };
  },
};

/**
 * The storage-backed verifier: the manifest must be this attempt's own key
 * and must validate down to the workspace bundle. `at` is not consulted —
 * freshness is the fence's business, and the gateway re-judges the lease at
 * commit time.
 */
export function serviceCheckpointVerifier(service: {
  verifyAttemptManifest(input: {
    checkpoint: CheckpointRef;
    fence: CheckpointFence;
  }): Promise<ManifestVerdict>;
}): CheckpointVerifier {
  return {
    async verify({ fence, checkpoint }) {
      const verdict = await service.verifyAttemptManifest({
        checkpoint,
        fence: {
          attemptId: fence.attemptId,
          authRevision: fence.authRevision,
          executionGeneration: fence.executionGeneration,
          leaseEpoch: fence.leaseEpoch,
          sessionId: fence.sessionId,
        },
      });
      if (verdict.status === "rejected") {
        return verdict.limit === undefined
          ? { status: "rejected", reason: verdict.reason }
          : {
              limit: verdict.limit,
              reason: verdict.reason,
              status: "rejected",
            };
      }
      const bytes = transcriptBytes(
        transcriptParts(verdict.manifest.transcripts),
      );
      const outputs = checkpointOutputObjects(verdict.manifest.outputs);
      const outputsDigest = checkpointOutputsDigest(verdict.manifest.outputs);
      const { runtime } = verdict.manifest;
      return verdict.versionsHeld === true
        ? {
            status: "verified",
            outputs,
            outputsDigest,
            runtime,
            transcriptBytes: bytes,
            versionsHeld: true,
          }
        : {
            status: "verified",
            outputs,
            outputsDigest,
            runtime,
            transcriptBytes: bytes,
          };
    },
  };
}
