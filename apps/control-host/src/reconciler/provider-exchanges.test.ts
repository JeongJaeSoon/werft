import { describe, expect, test } from "bun:test";
import {
  type ProviderExchangesReconciled,
  runProviderExchangeReconciler,
} from "./provider-exchanges.ts";

type Logged = {
  level: "info" | "warn";
  message: string;
  fields: Readonly<Record<string, unknown>> | undefined;
};

function logger() {
  const records: Logged[] = [];
  return {
    records,
    info: (message: string, fields?: Readonly<Record<string, unknown>>) =>
      void records.push({ level: "info", message, fields }),
    warn: (message: string, fields?: Readonly<Record<string, unknown>>) =>
      void records.push({ level: "warn", message, fields }),
  };
}

const NOTICED = {
  exchangeId: "8a1c5f7e-2b6d-4e1a-9c3f-0d4e5f6a7b8c",
  sessionId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
  attemptId: "att-1",
  openedAt: new Date("2026-11-12T08:00:00.000Z"),
};

describe("the provider exchange ledger's reconciler pass", () => {
  test("logs each noticed row once and a summary, with the batch settings", async () => {
    const sink = logger();
    const asked: unknown[] = [];
    const result: ProviderExchangesReconciled = {
      settled: 2,
      noticed: [NOTICED],
      deleted: 3,
    };
    expect(
      await runProviderExchangeReconciler({
        environment: { RECONCILER_BATCH_SIZE: "9" },
        logger: sink,
        reconcile: async (options) => {
          asked.push(options);
          return result;
        },
      }),
    ).toBe(result);
    expect(asked).toEqual([{ dryRun: false, limit: 9 }]);
    expect(sink.records).toEqual([
      {
        level: "warn",
        message: "Provider exchange reservation expired unsettled",
        fields: {
          dry_run: false,
          exchange_id: NOTICED.exchangeId,
          session_id: NOTICED.sessionId,
          attempt_id: NOTICED.attemptId,
          opened_at: "2026-11-12T08:00:00.000Z",
        },
      },
      {
        level: "info",
        message: "Provider exchange ledger reconciled",
        fields: {
          dry_run: false,
          settled_count: 2,
          noticed_count: 1,
          deleted_count: 3,
        },
      },
    ]);
  });

  test("a dry run is asked as one and says so", async () => {
    const sink = logger();
    const asked: unknown[] = [];
    await runProviderExchangeReconciler({
      environment: { RECONCILER_DRY_RUN: "true" },
      logger: sink,
      reconcile: async (options) => {
        asked.push(options);
        return { settled: 0, noticed: [], deleted: 0 };
      },
    });
    expect(asked).toEqual([{ dryRun: true, limit: 100 }]);
    expect(sink.records).toEqual([
      expect.objectContaining({
        message: "Provider exchange ledger reconciled",
        fields: expect.objectContaining({ dry_run: true }),
      }),
    ]);
  });
});
