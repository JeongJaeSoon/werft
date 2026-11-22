import { expect, test } from "bun:test";
import { join } from "node:path";
import type { NativeSdkMessage } from "./driver.ts";
import { TurnAccounting } from "./turn-accounting.ts";

// What each turn is charged from the engine's running totals, pinned to the
// bytes main produced before the runtime contract refactor.
// Regenerate only for an intended change: UPDATE_GOLDEN=1 bun test <file>.

const GOLDEN = join(
  import.meta.dir,
  "../../../../../tests/fixtures/golden/worker/turn-accounting.json",
);

type Step = { observe: NativeSdkMessage } | "settle";

function result(
  total: unknown,
  sessionId: string | undefined = "s1",
): NativeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    ...(total === undefined ? {} : { total_cost_usd: total }),
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  };
}

const scenarios: Record<string, Step[]> = {
  "running total differences": [
    { observe: result(0.1) },
    "settle",
    { observe: result(0.3) },
    "settle",
    { observe: result(0.3) },
    "settle",
  ],
  "a new session restarts the count": [
    { observe: result(3) },
    "settle",
    { observe: result(0.5, "s2") },
    "settle",
    { observe: result(0.75, "s2") },
    "settle",
  ],
  "a total that went down restarts the count": [
    { observe: result(2) },
    "settle",
    { observe: result(1.5) },
    "settle",
  ],
  "a new session that has spent nothing": [
    { observe: result(3) },
    "settle",
    { observe: result(0, "after-clear") },
    "settle",
    { observe: result(0.25, "after-clear") },
    "settle",
  ],
  "a result nobody settled carries over": [
    { observe: result(1) },
    { observe: result(1.5) },
    "settle",
  ],
  "unknown costs carry to the next turn that reports": [
    { observe: result(1) },
    "settle",
    { observe: result(1.5) },
    { observe: result(undefined) },
    "settle",
    { observe: result(0) },
    "settle",
    { observe: result(-1) },
    "settle",
    { observe: result("2") },
    "settle",
    { observe: result(2) },
    "settle",
  ],
  // JSON writes both as null in the trace; the settled figure is what counts.
  "totals that are not finite numbers": [
    { observe: result(1) },
    "settle",
    { observe: result(Number.NaN) },
    "settle",
    { observe: result(Number.POSITIVE_INFINITY) },
    "settle",
    { observe: result(Number.NEGATIVE_INFINITY) },
    "settle",
    { observe: result(1.25) },
    "settle",
  ],
  "a result without a session id": [
    { observe: { type: "result", subtype: "success", total_cost_usd: 1 } },
    "settle",
    { observe: { type: "result", subtype: "success", total_cost_usd: 1.5 } },
    "settle",
    { observe: result(0.25, "s9") },
    "settle",
  ],
  "zero before anything was spent is a figure": [
    { observe: result(0) },
    "settle",
    "settle",
  ],
  "provider failures": [
    {
      observe: {
        type: "system",
        subtype: "api_retry",
        error: "rate_limit",
        error_status: 429,
      },
    },
    { observe: { type: "system", subtype: "api_retry", error_status: 503 } },
    { observe: { type: "assistant", error: "server_error" } },
    "settle",
    { observe: { type: "system", subtype: "api_retry", error: "overloaded" } },
    { observe: { type: "assistant" } },
    "settle",
  ],
};

test("turn accounting matches main (golden)", async () => {
  const actual = Object.fromEntries(
    Object.entries(scenarios).map(([name, steps]) => {
      const accounting = new TurnAccounting();
      const trace = steps.map((step) => {
        if (step !== "settle") {
          accounting.observe(step.observe);
          return { observed: step.observe, restarted: accounting.restarted };
        }
        const { costUsd, providerFailure } = accounting.settle();
        return {
          settled: {
            // JSON would drop an undefined cost, and unknown is not zero.
            costUsd: costUsd === undefined ? "<unknown>" : costUsd,
            providerFailure: providerFailure ?? null,
          },
          restarted: accounting.restarted,
        };
      });
      return [name, trace];
    }),
  );
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await Bun.write(GOLDEN, text);
    return;
  }
  expect(text).toBe(await Bun.file(GOLDEN).text());
});
