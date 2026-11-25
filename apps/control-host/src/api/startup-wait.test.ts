import { describe, expect, test } from "bun:test";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import { BUCKET_CHECK_BOUNDS } from "./checkpoints.ts";
import { createStartupWait, STARTUP_WAIT_BUDGET_MS } from "./startup-wait.ts";

const away = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
  code: "ECONNREFUSED",
});
const isAway = (error: unknown) => error === away;

// A clock that only the pauses and `tick` move, so no test waits.
function start(budgetMs?: number) {
  const sink = new MemoryLogSink();
  const pauses: number[] = [];
  let clock = 0;
  const wait = createStartupWait({
    logger: createLogger({ sinks: [sink] }),
    ...(budgetMs === undefined ? {} : { budgetMs }),
    now: () => clock,
    sleep: async (ms) => {
      pauses.push(ms);
      clock += ms;
    },
  });
  return {
    wait,
    pauses,
    lines: () => sink.records.map(({ level, message }) => [level, message]),
    records: sink.records,
    tick: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}

// Fails `failures` times, each try taking `tryMs`, then answers.
function upAfter(failures: number, tick: (ms: number) => void, tryMs = 0) {
  let tries = 0;
  return async () => {
    tries += 1;
    if (tries <= failures) {
      tick(tryMs);
      throw away;
    }
    return "up";
  };
}

describe("waiting for a dependency at start", () => {
  test("says nothing about a dependency that answers at once", async () => {
    const { wait, pauses, lines } = start();
    expect(await wait("database", async () => "up", isAway)).toBe("up");
    expect(pauses).toEqual([]);
    expect(lines()).toEqual([]);
  });

  test("tries again while the dependency is away, one line per failed try", async () => {
    const { wait, pauses, records, tick } = start();
    expect(await wait("database", upAfter(6, tick), isAway)).toBe("up");
    expect(pauses).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
    expect(records).toHaveLength(6);
    expect(records[0]).toMatchObject({
      level: "warn",
      message: "Waiting for the database before starting",
      fields: {
        attempt: 1,
        waited_ms: 0,
        retry_in_ms: 1_000,
        error_name: "Error",
        error: "connect ECONNREFUSED 10.0.0.5:5432",
        code: "ECONNREFUSED",
      },
    });
    expect(records[5]).toMatchObject({
      level: "warn",
      fields: { attempt: 6, waited_ms: 17_000, retry_in_ms: 5_000 },
    });
  });

  test("a failure that is not the dependency being away refuses the start at once", async () => {
    const { wait, pauses, lines } = start();
    const refusal = new Error("Checkpoint bucket has versioning Off");
    await expect(
      wait(
        "object store",
        async () => {
          throw refusal;
        },
        isAway,
      ),
    ).rejects.toBe(refusal);
    expect(pauses).toEqual([]);
    expect(lines()).toEqual([]);
  });

  test("gives up past the budget, with a line that says so", async () => {
    const { wait, pauses, records, tick } = start();
    await expect(
      wait("object store", upAfter(Number.POSITIVE_INFINITY, tick), isAway),
    ).rejects.toBe(away);
    const waited = pauses.reduce((total, ms) => total + ms, 0);
    expect(waited).toBeLessThanOrEqual(STARTUP_WAIT_BUDGET_MS);
    expect(waited).toBeGreaterThan(STARTUP_WAIT_BUDGET_MS - 5_000);
    expect(records.at(-1)).toMatchObject({
      level: "error",
      message: "Refusing to start: the object store could not be reached",
      fields: { waited_ms: waited, code: "ECONNREFUSED" },
    });
    expect(records.slice(0, -1).every(({ level }) => level === "warn")).toBe(
      true,
    );
  });

  test("the steps of one start share the budget", async () => {
    const { wait, pauses, lines, tick } = start(10_000);
    await wait("object store", upAfter(3, tick), isAway);
    await expect(
      wait("database", upAfter(Number.POSITIVE_INFINITY, tick), isAway),
    ).rejects.toBe(away);
    // 7 s went to the object store, so the database gets what is left.
    expect(pauses).toEqual([1_000, 2_000, 4_000, 1_000, 2_000]);
    expect(lines().at(-1)).toEqual([
      "error",
      "Refusing to start: the database could not be reached",
    ]);
  });

  test("a store that times out on every try is given up on before the chart's startup probe ends the start", async () => {
    const { wait, clock, tick } = start();
    // One failed bucket check: the SDK's three tries, each to its timeout.
    const checkMs = 3 * BUCKET_CHECK_BOUNDS.requestTimeout;
    await expect(
      wait(
        "object store",
        upAfter(Number.POSITIVE_INFINITY, tick, checkMs),
        isAway,
      ),
    ).rejects.toBe(away);
    // deploy/helm/werft/templates/api.yaml: periodSeconds 5 x failureThreshold 24.
    expect(clock()).toBeLessThan(120_000);
  });
});
