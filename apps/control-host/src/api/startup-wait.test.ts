import { describe, expect, test } from "bun:test";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import { createStartupWait, STARTUP_WAIT_BUDGET_MS } from "./startup-wait.ts";

const away = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
  code: "ECONNREFUSED",
});
const isAway = (error: unknown) => error === away;

// A clock that only the pauses, the deadlines and `tick` move, so no test
// waits. A try's deadline fires only when a test fires it, unless `hung`:
// then every try runs to its deadline.
function start({ budgetMs, hung }: { budgetMs?: number; hung?: true } = {}) {
  const sink = new MemoryLogSink();
  const pauses: number[] = [];
  const deadlines: { ms: number; fire: () => void }[] = [];
  let clock = 0;
  const wait = createStartupWait({
    logger: createLogger({ sinks: [sink] }),
    ...(budgetMs === undefined ? {} : { budgetMs }),
    now: () => clock,
    sleep: async (ms) => {
      pauses.push(ms);
      clock += ms;
    },
    after: (ms, run) => {
      const fire = () => {
        clock += ms;
        run();
      };
      deadlines.push({ ms, fire });
      if (hung) queueMicrotask(fire);
      return () => {};
    },
  });
  return {
    wait,
    pauses,
    deadlines,
    lines: () => sink.records.map(({ level, message }) => [level, message]),
    records: sink.records,
    tick: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}

// Fails `failures` times, then answers.
function upAfter(failures: number) {
  let tries = 0;
  return async () => {
    tries += 1;
    if (tries <= failures) throw away;
    return "up";
  };
}
const neverSettles = () => new Promise<never>(() => {});

describe("waiting for a dependency at start", () => {
  test("says nothing about a dependency that answers at once", async () => {
    const { wait, pauses, lines } = start();
    expect(await wait("database", async () => "up", isAway)).toBe("up");
    expect(pauses).toEqual([]);
    expect(lines()).toEqual([]);
  });

  test("tries again while the dependency is away, one line per failed try", async () => {
    const { wait, pauses, records } = start();
    expect(await wait("database", upAfter(6), isAway)).toBe("up");
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

  test("a try that has not settled in 20 s counts as a failed one", async () => {
    const { wait, deadlines, records } = start();
    let tries = 0;
    const answered = wait(
      "object store",
      () => {
        tries += 1;
        return tries === 1 ? neverSettles() : Promise.resolve("up");
      },
      // Whatever the step's own failures mean, no answer is no answer.
      () => false,
    );
    expect(deadlines.map(({ ms }) => ms)).toEqual([20_000]);
    deadlines[0]?.fire();
    expect(await answered).toBe("up");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      message: "Waiting for the object store before starting",
      fields: {
        attempt: 1,
        waited_ms: 20_000,
        error_name: "NoAnswerError",
        error: "no answer within 20000 ms",
        code: null,
      },
    });
  });

  test("gives up at the budget, with a line that says so", async () => {
    const { wait, pauses, records } = start();
    await expect(
      wait("object store", upAfter(Number.POSITIVE_INFINITY), isAway),
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
    const { wait, pauses, lines } = start({ budgetMs: 10_000 });
    await wait("object store", upAfter(3), isAway);
    await expect(
      wait("database", upAfter(Number.POSITIVE_INFINITY), isAway),
    ).rejects.toBe(away);
    // 7 s went to the object store, so the database gets what is left.
    expect(pauses).toEqual([1_000, 2_000, 4_000, 1_000]);
    expect(lines().at(-1)).toEqual([
      "error",
      "Refusing to start: the database could not be reached",
    ]);
  });

  test("no try runs past the budget, so a dependency that never answers ends the start by then", async () => {
    const short = start({ budgetMs: 30_000, hung: true });
    await expect(
      short.wait("object store", neverSettles, isAway),
    ).rejects.toThrow("no answer within 9000 ms");
    // The second try gets the 9 s left after the first one and its pause.
    expect(short.deadlines.map(({ ms }) => ms)).toEqual([20_000, 9_000]);
    expect(short.clock()).toBe(30_000);

    const shipped = start({ hung: true });
    await expect(
      shipped.wait("database", neverSettles, isAway),
    ).rejects.toThrow("no answer within");
    expect(shipped.clock()).toBeLessThanOrEqual(STARTUP_WAIT_BUDGET_MS);
    // deploy/helm/werft/templates/api.yaml: periodSeconds 5 x failureThreshold 24.
    expect(STARTUP_WAIT_BUDGET_MS).toBeLessThan(120_000);
    expect(shipped.lines().at(-1)).toEqual([
      "error",
      "Refusing to start: the database could not be reached",
    ]);
  });
});
