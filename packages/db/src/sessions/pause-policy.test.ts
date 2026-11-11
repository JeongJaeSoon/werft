import { describe, expect, test } from "bun:test";
import { hasRestorePoint, restoreBaseRevision } from "../control-shared.ts";
import {
  pauseCoverageBlocker,
  pausedReceiptResult,
  pausedResumeRefusal,
} from "./pause-policy.ts";

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
    [
      "transcript limit",
      { checkpointPendingReason: "transcript_too_large" },
      true,
    ],
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

describe("pause checkpoint coverage", () => {
  test.each([
    ["no turn ran", null, null, null],
    ["checkpoint before any turn", null, 1, null],
    ["turn-less checkpoint", 2, null, "checkpoint_unavailable"],
    ["pointer behind the last turn", 2, 1, "checkpoint_unavailable"],
    ["pointer covers the last turn", 2, 2, null],
    ["later checkpoint covers a skipped turn", 2, 3, null],
  ] as const)("%s", (_name, lastRanTurn, checkpointedTurn, expected) => {
    expect(pauseCoverageBlocker({ lastRanTurn, checkpointedTurn })).toBe(
      expected,
    );
  });

  test("the paused receipt names the fallback actually restored and preserves queued work", () => {
    expect(
      pausedReceiptResult({ ...checkpoint, checkpointFallbackRevision: 0 }, 2),
    ).toEqual({
      resulting_admission_state: "paused",
      checkpoint_revision: 0,
      queued_turn_count: 2,
    });
    expect(pausedReceiptResult(checkpoint, 0)).toEqual({
      resulting_admission_state: "paused",
      checkpoint_revision: 3,
      queued_turn_count: 0,
    });
  });
});

describe("paused resume refusal priority", () => {
  test("an unknown turn takes priority over an untrusted checkpoint and legacy pod", () => {
    expect(
      pausedResumeRefusal(
        { ...checkpoint, checkpointRevision: null, podId: "legacy" },
        "7",
      ),
    ).toEqual({ outcome: "recovery_required", unconfirmedTurnId: "7" });
  });

  test("a missing restore point takes priority over a legacy pod", () => {
    expect(
      pausedResumeRefusal(
        { ...checkpoint, checkpointRevision: null, podId: "legacy" },
        null,
      ),
    ).toEqual({ outcome: "checkpoint_unavailable" });
  });

  test("a trusted checkpoint still cannot resume a legacy pod", () => {
    expect(
      pausedResumeRefusal({ ...checkpoint, podId: "legacy" }, null),
    ).toEqual({ outcome: "unsupported" });
  });

  test("a trusted checkpoint on an execution can proceed to parked-request checks", () => {
    expect(
      pausedResumeRefusal({ ...checkpoint, podId: null }, null),
    ).toBeNull();
  });
});
