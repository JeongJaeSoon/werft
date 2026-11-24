import { describe, expect, test } from "bun:test";
import type { SchedulerRunSummary } from "@werft-ai/platform";
import { PASS_DEGRADED_EXIT, PASS_SKIPPED_EXIT } from "../pass-loop/loop.ts";
import { exitCodeFor } from "./main.ts";

const clean: SchedulerRunSummary = {
  activeAfter: 0,
  activeBefore: 0,
  draining: [],
  drainsOverdue: [],
  failedLaunches: [],
  imageUnresolved: false,
  imagesRefused: [],
  heldIncompatible: [],
  heldRetired: [],
  waitingForEngine: [],
  killFailed: [],
  killed: [],
  killsStopping: [],
  launched: [],
  launchesNoCapacity: [],
  launchesNoCodexSandbox: [],
  waitingForCapacity: [],
  idleWorkersStopped: [],
  launchesBackingOff: [],
  launchesQuarantined: [],
  launchesRetracted: [],
  launchesEngineDropped: [],
  launchesLimitsChanged: [],
  networkScanFailed: false,
  networksFailed: [],
  networksReclaimed: [],
  networksRepaired: [],
  orphansTerminated: [],
  orphansUnresolved: [],
  orphansStopping: [],
  reclaimFailed: [],
  reconcileFailed: [],
  reensured: [],
  replaced: [],
  replacementsExhausted: [],
  skipped: false,
  slotLimit: 10,
  terminatedObserved: [],
  terminationsOverdue: 0,
  workspaceScanFailed: false,
  workspacesFailed: [],
  workspacesReclaimed: [],
  workspacesUnresolved: [],
};
const ref = { executionId: "exec-1", generation: 1 };

describe("scheduler exit code", () => {
  test("a clean pass exits 0", () => {
    expect(exitCodeFor(clean)).toBe(0);
  });

  test("a kill still draining is not a failure", () => {
    expect(exitCodeFor({ ...clean, killsStopping: [ref] })).toBe(0);
    expect(exitCodeFor({ ...clean, orphansStopping: [ref] })).toBe(0);
  });

  test("a skipped pass says so, so the loop counts it as neither", () => {
    expect(exitCodeFor({ ...clean, skipped: true })).toBe(PASS_SKIPPED_EXIT);
  });

  test("unfinished work exits 1 so supervisors notice", () => {
    expect(exitCodeFor({ ...clean, failedLaunches: [ref] })).toBe(1);
    // An image that could not be pinned admits nobody at all.
    expect(exitCodeFor({ ...clean, imageUnresolved: true })).toBe(1);
    // An image refused for running another combination than configured is an
    // install defect someone has to correct: the alert.
    expect(
      exitCodeFor({ ...clean, imagesRefused: ["sha256:worker:previous"] }),
    ).toBe(1);
    expect(exitCodeFor({ ...clean, orphansUnresolved: [ref] })).toBe(1);
    expect(exitCodeFor({ ...clean, reclaimFailed: [ref] })).toBe(1);
    expect(exitCodeFor({ ...clean, reconcileFailed: [ref] })).toBe(1);
  });

  test("a session backing off, given up on, or out of replacements degrades the pass without failing it", () => {
    expect(PASS_DEGRADED_EXIT).not.toBe(PASS_SKIPPED_EXIT);
    expect(exitCodeFor({ ...clean, launchesBackingOff: [ref] })).toBe(
      PASS_DEGRADED_EXIT,
    );
    expect(exitCodeFor({ ...clean, launchesQuarantined: [ref] })).toBe(
      PASS_DEGRADED_EXIT,
    );
    expect(exitCodeFor({ ...clean, replacementsExhausted: [ref] })).toBe(
      PASS_DEGRADED_EXIT,
    );
  });

  test("a real failure beside a degraded session still exits 1", () => {
    const degraded = {
      ...clean,
      launchesBackingOff: [ref],
      launchesQuarantined: [ref],
      replacementsExhausted: [ref],
    };
    expect(exitCodeFor({ ...degraded, failedLaunches: [ref] })).toBe(1);
    expect(exitCodeFor({ ...degraded, imageUnresolved: true })).toBe(1);
    expect(exitCodeFor({ ...degraded, killFailed: [ref] })).toBe(1);
    expect(exitCodeFor({ ...degraded, networkScanFailed: true })).toBe(1);
    expect(exitCodeFor({ ...degraded, networksFailed: ["ap-net-1"] })).toBe(1);
    expect(exitCodeFor({ ...degraded, orphansUnresolved: [ref] })).toBe(1);
    expect(exitCodeFor({ ...degraded, reclaimFailed: [ref] })).toBe(1);
    expect(exitCodeFor({ ...degraded, reconcileFailed: [ref] })).toBe(1);
    expect(exitCodeFor({ ...degraded, workspaceScanFailed: true })).toBe(1);
    expect(exitCodeFor({ ...degraded, workspacesFailed: ["ap-ws-1"] })).toBe(1);
    // A skipped pass looked at nothing, degraded or not.
    expect(exitCodeFor({ ...degraded, skipped: true })).toBe(PASS_SKIPPED_EXIT);
  });

  test("a worker network left leaking or cut off exits 1; one reclaimed or repaired does not", () => {
    expect(exitCodeFor({ ...clean, networkScanFailed: true })).toBe(1);
    expect(exitCodeFor({ ...clean, networksFailed: ["ap-net-1"] })).toBe(1);
    expect(
      exitCodeFor({
        ...clean,
        networksReclaimed: ["ap-net-1"],
        networksRepaired: ["ap-net-2"],
      }),
    ).toBe(0);
  });

  test("a GC fault exits 1, a GC judgement does not", () => {
    expect(exitCodeFor({ ...clean, workspaceScanFailed: true })).toBe(1);
    expect(exitCodeFor({ ...clean, workspacesFailed: ["ap-ws-1"] })).toBe(1);
    // Still mounted, or someone else's: both deliberate, both retried next
    // pass, neither a reason to wake anyone.
    expect(exitCodeFor({ ...clean, workspacesUnresolved: ["ap-ws-1"] })).toBe(
      0,
    );
  });
});
