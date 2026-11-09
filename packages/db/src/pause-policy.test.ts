import { describe, expect, test } from "bun:test";
import { hasRestorePoint, restoreBaseRevision } from "./control-shared.ts";

const checkpoint = {
  checkpointRevision: 3,
  checkpointFallbackRevision: null,
  checkpointPendingReason: null,
  contextResetCheckpointRevision: null,
};

describe("pause restore point", () => {
  test.each([
    ["missing pointer", { checkpointRevision: null }, false],
    ["revision zero", { checkpointRevision: 0 }, true],
    ["healthy pointer", {}, true],
    ["mirror gap", { checkpointPendingReason: "mirror_error" }, false],
    ["unknown reason", { checkpointPendingReason: "future_reason" }, false],
    ["publish refusal", { checkpointPendingReason: "publish_failed" }, true],
    ["busy workspace", { checkpointPendingReason: "background_writer" }, true],
    ["held lease", { checkpointPendingReason: "checkpoint_lease_held" }, true],
    ["transcript limit", { checkpointPendingReason: "transcript_too_large" }, true],
    ["retired pointer", { contextResetCheckpointRevision: 3 }, false],
    ["older pointer", { contextResetCheckpointRevision: 4 }, false],
    ["new checkpoint after reset", { contextResetCheckpointRevision: 2 }, true],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(hasRestorePoint({ ...checkpoint, ...overrides })).toBe(expected);
  });

  test.each([
    [null, null, null],
    [0, null, 0],
    [3, null, 3],
    [3, 0, 0],
    [3, 2, 2],
  ] as const)(
    "pointer %s with fallback %s restores revision %s",
    (checkpointRevision, checkpointFallbackRevision, expected) => {
      expect(
        restoreBaseRevision({ checkpointRevision, checkpointFallbackRevision }),
      ).toBe(expected);
    },
  );
});
