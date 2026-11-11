import { describe, expect, test } from "bun:test";
import type { CheckpointManifest } from "@werft-ai/runtime-core";
import {
  checkpointOutputsDigest,
  serviceCheckpointVerifier,
} from "./checkpoint-verifier.ts";

const fence = {
  sessionId: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  attemptId: "att_1",
  leaseEpoch: 2,
  executionGeneration: 3,
  authRevision: 4,
};
const checkpoint = {
  revision: 1,
  manifest_ref: "sessions/s/checkpoints/0000000001/att_1/manifest.json",
  manifest_sha256: "0".repeat(64),
};

describe("serviceCheckpointVerifier", () => {
  test("hands the service the whole fence and reduces its verdict to the port's", async () => {
    const asked: unknown[] = [];
    let verdict:
      | { status: "verified"; manifest: CheckpointManifest }
      | {
          limit?: "transcript_too_large";
          status: "rejected";
          reason: string;
        } = {
      status: "rejected",
      reason: "manifest digest mismatch",
    };
    const verifier = serviceCheckpointVerifier({
      async verifyAttemptManifest(input) {
        asked.push(input);
        return verdict;
      },
    });
    const at = new Date("2026-09-23T00:00:00Z");
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({ status: "rejected", reason: "manifest digest mismatch" });
    // The fence is what proves the manifest is this attempt's: session and
    // attempt pick the key, the epochs ride along for the pointer CAS.
    expect(asked).toEqual([{ checkpoint, fence }]);

    verdict = {
      status: "rejected",
      reason: "the transcript is over the limit",
      limit: "transcript_too_large",
    };
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({
      status: "rejected",
      reason: "the transcript is over the limit",
      limit: "transcript_too_large",
    });

    const part = (key: string, bytes: number) => ({
      bytes,
      key,
      sha256: "0".repeat(64),
    });
    verdict = {
      status: "verified",
      manifest: {
        transcripts: {
          root: { parts: [part("a", 10), part("b", 5)] },
          subagents: { "agent-1": { parts: [part("c", 7)] } },
        },
      } as unknown as CheckpointManifest,
    };
    // The total the session detail judges TRANSCRIPT_LIMIT on.
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({
      status: "verified",
      outputs: [],
      outputsDigest: null,
      transcriptBytes: 22,
    });

    // Outputs: two paths of the same content are one object, an inherited
    // ref is named like any other, and an omitted file has no object at all.
    verdict = {
      status: "verified",
      manifest: {
        transcripts: { root: { parts: [] }, subagents: {} },
        outputs: [
          { ...part("s/checkpoints/1/att_1/outputs/aa", 100), path: "out/a" },
          { ...part("s/checkpoints/1/att_1/outputs/aa", 100), path: "out/b" },
          { ...part("s/checkpoints/0/att_0/outputs/cc", 30), path: "out/c" },
          { bytes: 5_000_000_000, omitted: "too_large", path: "out/big" },
        ],
      } as unknown as CheckpointManifest,
    };
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({
      status: "verified",
      outputs: [
        { key: "s/checkpoints/1/att_1/outputs/aa", bytes: 100 },
        { key: "s/checkpoints/0/att_0/outputs/cc", bytes: 30 },
      ],
      outputsDigest: checkpointOutputsDigest(
        (verdict.manifest as CheckpointManifest).outputs,
      ),
      transcriptBytes: 0,
    });
  });

  test("the out/ digest changes with a path, a copy or an omitted file, not with the order", () => {
    const report = {
      bytes: 10,
      key: "s/checkpoints/1/att_1/outputs/aa",
      path: "out/report.md",
      sha256: "a".repeat(64),
    };
    const big = {
      bytes: 9_000_000_000,
      omitted: "too_large" as const,
      path: "out/big.bin",
    };
    const base = checkpointOutputsDigest([report]);
    expect(checkpointOutputsDigest([])).toBeNull();
    expect(checkpointOutputsDigest(undefined)).toBeNull();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpointOutputsDigest([{ ...report }])).toBe(base);
    const changed = [
      [{ ...report, path: "out/final.md" }],
      [report, { ...report, path: "out/copy.md" }],
      [report, big],
      [report, { ...big, bytes: big.bytes + 1 }],
    ].map(checkpointOutputsDigest);
    expect(new Set([base, ...changed]).size).toBe(5);
    expect(checkpointOutputsDigest([big, report])).toBe(
      checkpointOutputsDigest([report, big]),
    );
  });

  test("carries the manifest's runtime fingerprint to the pointer row", async () => {
    const runtime = {
      cliVersion: "2.1.270",
      engine: "claude-agent-sdk",
      profileSha256: "a".repeat(64),
      sdkVersion: "0.3.270",
    };
    const verifier = serviceCheckpointVerifier({
      async verifyAttemptManifest() {
        return {
          status: "verified",
          manifest: {
            runtime,
            transcripts: { root: { parts: [] }, subagents: {} },
          } as unknown as CheckpointManifest,
        };
      },
    });
    const verdict = await verifier.verify({
      fence,
      turnId: "1",
      checkpoint,
      at: new Date("2026-10-31T00:00:00Z"),
    });
    expect(verdict).toMatchObject({ status: "verified", runtime });
  });
});
