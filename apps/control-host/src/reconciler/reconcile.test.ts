import { describe, expect, test } from "bun:test";
import type { ReconciledOrphan } from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { runReconciler } from "./reconcile.ts";

describe("reconciler run", () => {
  test("runs one bounded batch and logs the affected session IDs", async () => {
    const sink = new MemoryLogSink();
    const reconciled: ReconciledOrphan[] = [
      {
        action: "requeued",
        blockedMessageIds: [],
        dryRun: false,
        releasedMessageIds: [7],
        sessionId: "session-a",
        stalePodId: "pod-a",
        terminalMessageIds: [],
      },
      {
        action: "released",
        blockedMessageIds: [],
        dryRun: false,
        releasedMessageIds: [],
        sessionId: "session-b",
        stalePodId: "pod-b",
        terminalMessageIds: [8],
      },
    ];
    let calls = 0;
    const result = await runReconciler({
      environment: {
        RECONCILER_BATCH_SIZE: "12",
        RECONCILER_DRY_RUN: "false",
      },
      logger: new StructuredLogger({ sinks: [sink] }),
      now: new Date("2026-09-14T00:00:00Z"),
      reconcile: async (options) => {
        calls += 1;
        expect(options).toEqual({
          dryRun: false,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return reconciled;
      },
      reconcileLeases: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return [];
      },
      reconcileInterrupts: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return [
          {
            attemptId: "attempt-c",
            dryRun: false,
            executionId: "exec-c",
            sessionId: "session-c",
          },
        ];
      },
      expireInterrupts: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return 3;
      },
      expireTerminations: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return 2;
      },
      expireParked: async (options) => {
        expect(options).toEqual({ dryRun: false, limit: 12 });
        return ["session-f"];
      },
      announceInputReturns: async (options) => {
        expect(options).toEqual({ dryRun: false, limit: 12 });
        return [{ sessionId: "session-e", phase: "running" }];
      },
      expireDecisions: async (options) => {
        expect(options).toEqual({ dryRun: false, limit: 12 });
        return 5;
      },
      expireToolAudits: async (options) => {
        expect(options).toEqual({ dryRun: false, limit: 12 });
        return 7;
      },
      deleteExpiredWebSessions: async (options) => {
        expect(options).toEqual({ dryRun: false, limit: 12 });
        return 6;
      },
      purgeExpiredEnvStart: async (options) => {
        expect(options).toEqual({ dryRun: false, limit: 12 });
        return 4;
      },
      projectToolCalls: async () => ({
        eventsRead: 40,
        batches: 2,
        appliedThrough: 31,
        caughtUp: true,
        timedOut: 1,
        heldByFillSeconds: null,
      }),
    });

    expect(calls).toBe(1);
    expect(result.orphans).toBe(reconciled);
    expect(result.leases).toEqual([]);
    expect(result.interrupts).toHaveLength(1);
    expect(result.interruptsOverdue).toBe(3);
    expect(result.terminationsOverdue).toBe(2);
    expect(result.parkedExpired).toEqual(["session-f"]);
    expect(result.decisionsExpired).toBe(5);
    expect(result.toolAuditsExpired).toBe(7);
    expect(result.webSessionsDeleted).toBe(6);
    expect(result.envStartsPurged).toBe(4);
    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "info",
        message: "Orphan session reconciliation completed",
        fields: {
          blocked_count: 0,
          dry_run: false,
          reconciled_count: 2,
          released_count: 1,
          requeued_count: 1,
          session_ids: ["session-a", "session-b"],
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Expired lease reconciliation completed",
        fields: {
          dry_run: false,
          ended_count: 0,
          fenced_count: 0,
          fenced_session_ids: [],
          reconciled_count: 0,
          session_ids: [],
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Overdue interrupt executions sent to terminate",
        fields: {
          dry_run: false,
          fenced_count: 1,
          session_ids: ["session-c"],
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Overdue interrupt receipts marked unknown",
        fields: { dry_run: false, overdue_count: 3 },
      }),
      expect.objectContaining({
        level: "info",
        message: "Overdue terminate receipts marked unknown",
        fields: { dry_run: false, overdue_count: 2 },
      }),
      expect.objectContaining({
        level: "info",
        message: "Expired parked requests settled",
        fields: { dry_run: false, session_ids: ["session-f"] },
      }),
      expect.objectContaining({
        level: "info",
        message: "Ended input waits announced",
        fields: {
          dry_run: false,
          announced_count: 1,
          session_ids: ["session-e"],
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Expired authorization decisions deleted",
        fields: { dry_run: false, deleted_count: 5 },
      }),
      expect.objectContaining({
        level: "info",
        message: "Expired tool call audits deleted",
        fields: { dry_run: false, deleted_count: 7 },
      }),
      expect.objectContaining({
        level: "info",
        message: "Expired web sessions deleted",
        fields: { dry_run: false, deleted_count: 6 },
      }),
      expect.objectContaining({
        level: "info",
        message: "Expired session variable values purged",
        fields: { dry_run: false, purged_count: 4 },
      }),
      expect.objectContaining({
        level: "info",
        message: "Tool calls projected",
        fields: {
          dry_run: false,
          events_read: 40,
          batches: 2,
          applied_through: 31,
          caught_up: true,
          timed_out_batches: 1,
        },
      }),
    ]);
    expect(result.inputReturns).toEqual([
      { sessionId: "session-e", phase: "running" },
    ]);
  });

  test("a dry run asks every pass not to write and logs what it would do", async () => {
    const sink = new MemoryLogSink();
    const seen: boolean[] = [];
    const run = await runReconciler({
      environment: { RECONCILER_DRY_RUN: "1" },
      logger: new StructuredLogger({ sinks: [sink] }),
      reconcile: async ({ dryRun }) => {
        seen.push(dryRun);
        return [];
      },
      reconcileLeases: async ({ dryRun }) => {
        seen.push(dryRun);
        return [];
      },
      reconcileInterrupts: async ({ dryRun }) => {
        seen.push(dryRun);
        return [
          {
            attemptId: "attempt-d",
            dryRun,
            executionId: "exec-d",
            sessionId: "session-d",
          },
        ];
      },
      expireInterrupts: async ({ dryRun }) => {
        seen.push(dryRun);
        return 4;
      },
      expireTerminations: async ({ dryRun }) => {
        seen.push(dryRun);
        return 0;
      },
      expireParked: async ({ dryRun }) => {
        seen.push(dryRun);
        return [];
      },
      announceInputReturns: async ({ dryRun }) => {
        seen.push(dryRun);
        return [];
      },
      expireDecisions: async ({ dryRun }) => {
        seen.push(dryRun);
        return 0;
      },
      expireToolAudits: async ({ dryRun }) => {
        seen.push(dryRun);
        return 0;
      },
      deleteExpiredWebSessions: async ({ dryRun }) => {
        seen.push(dryRun);
        return 0;
      },
      purgeExpiredEnvStart: async ({ dryRun }) => {
        seen.push(dryRun);
        return 2;
      },
      projectToolCalls: async () => {
        throw new Error("a dry run projects nothing");
      },
    });

    expect(seen).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(run.toolCalls).toBeNull();
    expect(run.envStartsPurged).toBe(2);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        message: "Expired session variable values purged",
        fields: { dry_run: true, purged_count: 2 },
      }),
    );
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        message: "Tool calls projected",
        fields: { dry_run: true },
      }),
    );
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        message: "Overdue interrupt receipts marked unknown",
        fields: { dry_run: true, overdue_count: 4 },
      }),
    );
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        message: "Overdue interrupt executions sent to terminate",
        fields: {
          dry_run: true,
          fenced_count: 1,
          session_ids: ["session-d"],
        },
      }),
    );
  });

  test("warns when the tool call projection has waited long on the neutral field fill", async () => {
    const records = async (heldByFillSeconds: number | null) => {
      const sink = new MemoryLogSink();
      await runReconciler({
        logger: new StructuredLogger({ sinks: [sink] }),
        reconcile: async () => [],
        reconcileLeases: async () => [],
        reconcileInterrupts: async () => [],
        expireInterrupts: async () => 0,
        expireTerminations: async () => 0,
        expireParked: async () => [],
        announceInputReturns: async () => [],
        expireDecisions: async () => 0,
        expireToolAudits: async () => 0,
        deleteExpiredWebSessions: async () => 0,
        purgeExpiredEnvStart: async () => 0,
        projectToolCalls: async () => ({
          eventsRead: 10,
          batches: 1,
          appliedThrough: 7,
          caughtUp: true,
          timedOut: 0,
          heldByFillSeconds,
        }),
      });
      return sink.records.filter((record) => record.level === "warn");
    };
    expect(await records(null)).toEqual([]);
    expect(await records(30)).toEqual([]);
    expect(await records(900.4)).toEqual([
      expect.objectContaining({
        message:
          "Tool call projection is waiting on the event neutral field fill",
        fields: { applied_through: 7, fill_idle_seconds: 900 },
      }),
    ]);
  });

  test("refuses HEARTBEAT_TTL_SEC outright, and invalid batch or dry-run settings", async () => {
    const logger = new StructuredLogger({ sinks: [] });
    const reconcile = async () => [];
    const reconcileLeases = async () => [];
    const reconcileInterrupts = async () => [];
    const expireInterrupts = async () => 0;
    const expireTerminations = async () => 0;
    const expireParked = async () => [];
    const announceInputReturns = async () => [];
    const expireDecisions = async () => 0;
    const expireToolAudits = async () => 0;
    const deleteExpiredWebSessions = async () => 0;
    const purgeExpiredEnvStart = async () => 0;
    const projectToolCalls = async () => ({
      eventsRead: 0,
      batches: 0,
      appliedThrough: 0,
      caughtUp: true,
      timedOut: 0,
      heldByFillSeconds: null,
    });
    // Valid or not: the reconciler has no TTL to be told, so a value here is
    // an operator who believes it does. It must not start and quietly
    // judge by the deadlines the API wrote with a different one.
    for (const value of ["120", "30", "0"]) {
      let reconciled = 0;
      await expect(
        runReconciler({
          environment: { HEARTBEAT_TTL_SEC: value },
          logger,
          reconcile: async () => {
            reconciled += 1;
            return [];
          },
          reconcileLeases,
          reconcileInterrupts,
          expireInterrupts,
          expireTerminations,
          expireParked,
          announceInputReturns,
          expireDecisions,
          expireToolAudits,
          deleteExpiredWebSessions,
          purgeExpiredEnvStart,
          projectToolCalls,
        }),
      ).rejects.toThrow("HEARTBEAT_TTL_SEC is read by the API only");
      expect(reconciled).toBe(0);
    }
    await expect(
      runReconciler({
        environment: { RECONCILER_BATCH_SIZE: "1.5" },
        logger,
        reconcile,
        reconcileLeases,
        reconcileInterrupts,
        expireInterrupts,
        expireTerminations,
        expireParked,
        announceInputReturns,
        expireDecisions,
        expireToolAudits,
        deleteExpiredWebSessions,
        purgeExpiredEnvStart,
        projectToolCalls,
      }),
    ).rejects.toThrow("RECONCILER_BATCH_SIZE");
    await expect(
      runReconciler({
        environment: { RECONCILER_DRY_RUN: "yes" },
        logger,
        reconcile,
        reconcileLeases,
        reconcileInterrupts,
        expireInterrupts,
        expireTerminations,
        expireParked,
        announceInputReturns,
        expireDecisions,
        expireToolAudits,
        deleteExpiredWebSessions,
        purgeExpiredEnvStart,
        projectToolCalls,
      }),
    ).rejects.toThrow("RECONCILER_DRY_RUN");
  });
});
