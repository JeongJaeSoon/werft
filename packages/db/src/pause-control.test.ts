import { describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drainAttention } from "./drain.ts";
import { pauseBlocker, pauseReceiptResult } from "./pause-control.ts";
import type { Database } from "./queries.ts";

const session = {
  id: "11111111-1111-4111-8111-111111111111",
  admissionState: "pausing" as const,
  checkpointRevision: 3,
  checkpointFallbackRevision: null,
  checkpointPendingReason: null,
  contextResetCheckpointRevision: null,
  pauseReason: null,
};

// Supplies query results, never evaluates SQL or simulates a transaction.
function reads(...results: object[][]) {
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  let next = 0;
  const db = {
    select: () => {
      const rows = results[next++];
      if (rows === undefined) throw new Error("Unexpected query");
      const query = Object.assign(Promise.resolve(rows), {
        from: () => query,
        innerJoin: () => query,
        where: (predicate: SQL) => {
          queries.push(new PgDialect().sqlToQuery(predicate));
          return query;
        },
        limit: async () => rows,
      });
      return query;
    },
  } as unknown as Database;
  return { db, queries };
}

describe("pause read wiring", () => {
  test("a mirror error outranks an open turn without querying it", async () => {
    const { db, queries } = reads();
    expect(
      await pauseBlocker(db, {
        ...session,
        checkpointPendingReason: "mirror_error",
      }),
    ).toBe("mirror_error");
    expect(queries).toHaveLength(0);
  });

  test("a park with an open turn does not query its pending requests", async () => {
    const { db, queries } = reads([{ id: "turn" }]);
    expect(
      await pauseBlocker(db, { ...session, pauseReason: "awaiting_input" }),
    ).toBe("long_turn");
    expect(queries).toHaveLength(1);
  });

  test.each([
    ["pending_request", [{ id: "request" }]],
    ["long_turn", []],
  ] as const)("an open turn reports %s", async (expected, pending) => {
    const { db, queries } = reads([{ id: "turn" }], [...pending]);
    expect(await pauseBlocker(db, session)).toBe(expected);
    expect(queries[1]?.params).toContain("turn");
  });

  test("a pause with no restore point stops before reading coverage", async () => {
    const { db, queries } = reads([]);
    expect(
      await pauseBlocker(db, { ...session, checkpointRevision: null }),
    ).toBe("checkpoint_unavailable");
    expect(queries).toHaveLength(1);
  });

  test("an advisory refusal uses coverage of the fallback actually restored", async () => {
    const { db, queries } = reads([], [{ sequence: 2 }], [{ sequence: 1 }]);
    expect(
      await pauseBlocker(db, {
        ...session,
        checkpointFallbackRevision: 0,
        checkpointPendingReason: "publish_failed",
      }),
    ).toBe("checkpoint_unavailable");
    expect(queries[2]?.params).toContain(0);
  });

  test("a later covering checkpoint clears an advisory refusal", async () => {
    const { db } = reads([], [{ sequence: 2 }], [{ sequence: 3 }]);
    expect(
      await pauseBlocker(db, {
        ...session,
        checkpointPendingReason: "publish_failed",
      }),
    ).toBeNull();
  });

  test("the receipt assembles the queued count with the restored revision", async () => {
    const { db } = reads([{ count: 2 }]);
    expect(
      await pauseReceiptResult(db, {
        ...session,
        checkpointFallbackRevision: 0,
      }),
    ).toEqual({
      resulting_admission_state: "paused",
      checkpoint_revision: 0,
      queued_turn_count: 2,
    });
  });

  test("the default deadline queries the database clock at sixty seconds regardless of the host clock", async () => {
    const hostClock = spyOn(Date, "now").mockReturnValue(0);
    try {
      const { db, queries } = reads([]);
      expect(await drainAttention(db, session)).toBeNull();
      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toContain(
        '"receipts"."created_at" <= clock_timestamp() + ',
      );
      expect(queries[0]?.sql).toContain(
        "::double precision * interval '1 millisecond'",
      );
      expect(queries[0]?.params).toContain(-60_000);
    } finally {
      hostClock.mockRestore();
    }
  });
});
