import { describe, expect, test } from "bun:test";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import { API_POOL_TIMEOUTS } from "./pool.ts";
import {
  runStorageCounterCheck,
  STORAGE_COUNTER_CHECK_INTERVAL_MS,
  STORAGE_COUNTER_CHECK_TIMEOUT_MS,
  untilNextStorageCounterCheck,
} from "./storage-counter-check.ts";

function logged() {
  const sink = new MemoryLogSink();
  return { sink, logger: createLogger({ sinks: [sink] }) };
}

const records = (sink: MemoryLogSink) =>
  sink.records.map(({ level, message, fields }) => ({
    level,
    message,
    fields,
  }));

describe("the daily storage counter check", () => {
  test("a counter equal to the turns is logged at info", async () => {
    const { sink, logger } = logged();
    await runStorageCounterCheck(
      async () => ({ outcome: "checked", counterBytes: 42, actualBytes: 42 }),
      logger,
    );
    expect(records(sink)).toEqual([
      {
        level: "info",
        message: "The storage counter matches the turns",
        fields: { counter_bytes: 42, actual_bytes: 42, difference_bytes: 0 },
      },
    ]);
  });

  test("a counter that differs is a warning with both figures and the difference", async () => {
    const { sink, logger } = logged();
    await runStorageCounterCheck(
      async () => ({ outcome: "checked", counterBytes: 40, actualBytes: 52 }),
      logger,
    );
    expect(records(sink)).toEqual([
      {
        level: "warn",
        message: "The storage counter differs from the turns",
        fields: { counter_bytes: 40, actual_bytes: 52, difference_bytes: -12 },
      },
    ]);
  });

  test("a lock held by another replica skips the check", async () => {
    const { sink, logger } = logged();
    await runStorageCounterCheck(async () => ({ outcome: "busy" }), logger);
    expect(records(sink)).toEqual([
      {
        level: "info",
        message: "The daily storage counter check ran on another replica",
        fields: undefined,
      },
    ]);
  });

  test("a failed or timed-out scan is a warning, never a throw", async () => {
    const { sink, logger } = logged();
    const timedOut = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    await runStorageCounterCheck(async () => {
      throw new Error("Failed query", { cause: timedOut });
    }, logger);
    expect(records(sink)).toEqual([
      {
        level: "warn",
        message: "The daily storage counter check failed",
        fields: { error_name: "Error", sqlstate: "57014" },
      },
    ]);
  });

  test("the scan is cut off by the server before the api pool's read timeout", () => {
    expect(STORAGE_COUNTER_CHECK_TIMEOUT_MS).toBeLessThan(
      API_POOL_TIMEOUTS.queryMs,
    );
  });

  test("every replica runs at 03:30 UTC, never at once", () => {
    const at = (iso: string) =>
      new Date(
        Date.parse(iso) + untilNextStorageCounterCheck(Date.parse(iso)),
      ).toISOString();
    expect(at("2026-11-26T07:00:00.000Z")).toBe("2026-11-27T03:30:00.000Z");
    expect(at("2026-11-26T03:29:59.000Z")).toBe("2026-11-26T03:30:00.000Z");
    // At the moment itself: the next day's, so a boot then does not scan.
    expect(
      untilNextStorageCounterCheck(Date.parse("2026-11-26T03:30:00Z")),
    ).toBe(STORAGE_COUNTER_CHECK_INTERVAL_MS);
  });
});
