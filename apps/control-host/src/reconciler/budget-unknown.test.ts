import { describe, expect, test } from "bun:test";
import type { UnknownBudgetHeld } from "@werft-ai/db";
import { runUnknownBudgetReport } from "./budget-unknown.ts";
import { runConversationCallReconciler } from "./conversation-calls.ts";

function logger() {
  const records: { level: string; message: string; fields: unknown }[] = [];
  return {
    records,
    info: (message: string, fields?: Readonly<Record<string, unknown>>) =>
      void records.push({ level: "info", message, fields }),
    warn: (message: string, fields?: Readonly<Record<string, unknown>>) =>
      void records.push({ level: "warn", message, fields }),
  };
}

describe("the reconciler's unknown ends", () => {
  test("the accounts holding the most are logged with what they hold, then the total over all", async () => {
    const sink = logger();
    const held: UnknownBudgetHeld[] = [
      {
        accountId: "6d1c0b0e-4f5a-4c55-9a40-1f2e3d4c5b6a" as never,
        ownerKind: "team",
        ownerId: "team-1",
        count: 2,
        costUsd: 1.5,
        tokens: 4_000,
      },
      {
        accountId: null,
        ownerKind: null,
        ownerId: null,
        count: 1,
        costUsd: 0.25,
        tokens: 500,
      },
    ];
    const asked: number[] = [];
    await runUnknownBudgetReport({
      environment: { RECONCILER_BATCH_SIZE: "2" },
      logger: sink,
      unknownByAccount: async (limit) => {
        asked.push(limit);
        // Three accounts hold unknown ends; the batch logs two.
        return {
          accounts: held,
          total: { accountCount: 3, count: 4, costUsd: 2, tokens: 5_000 },
        };
      },
    });
    expect(asked).toEqual([2]);
    expect(sink.records).toEqual([
      {
        level: "warn",
        message: "Budget reservations of unknown end held",
        fields: {
          account_id: held[0]?.accountId,
          owner_kind: "team",
          owner_id: "team-1",
          unknown_count: 2,
          held_cost_usd: 1.5,
          held_tokens: 4_000,
        },
      },
      {
        level: "warn",
        message: "Budget reservations of unknown end held",
        fields: {
          account_id: null,
          owner_kind: null,
          owner_id: null,
          unknown_count: 1,
          held_cost_usd: 0.25,
          held_tokens: 500,
        },
      },
      {
        level: "info",
        message: "Budget reservations of unknown end reported",
        fields: {
          account_count: 3,
          logged_account_count: 2,
          unknown_count: 4,
          held_cost_usd: 2,
          held_tokens: 5_000,
        },
      },
    ]);
  });

  test("the conversation call pass releases unused tokens and marks unknown ends, both in a dry run too", async () => {
    const sink = logger();
    const asked: unknown[] = [];
    expect(
      await runConversationCallReconciler({
        environment: { RECONCILER_DRY_RUN: "true" },
        logger: sink,
        releaseExpired: async (options) => {
          asked.push(["release", options]);
          return { released: 2 };
        },
        markUnknown: async (options) => {
          asked.push(["unknown", options]);
          return { unknown: 3 };
        },
      }),
    ).toEqual({ released: 2, unknown: 3 });
    expect(asked).toEqual([
      ["release", { dryRun: true, limit: 100 }],
      ["unknown", { dryRun: true, limit: 100 }],
    ]);
    expect(sink.records).toEqual([
      {
        level: "info",
        message: "Conversation call reservations reconciled",
        fields: { dry_run: true, released_count: 2, unknown_count: 3 },
      },
    ]);
  });
});
