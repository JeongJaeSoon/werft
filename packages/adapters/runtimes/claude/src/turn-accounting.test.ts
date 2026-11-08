import { describe, expect, test } from "bun:test";
import type { NativeSdkMessage } from "./driver.ts";
import { TurnAccounting } from "./turn-accounting.ts";

function result(total: unknown, sessionId = "s"): NativeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    total_cost_usd: total,
  } as NativeSdkMessage;
}

function charges(totals: unknown[]): Array<number | undefined> {
  const accounting = new TurnAccounting();
  return totals.map((total) => {
    accounting.observe(result(total));
    return accounting.settle().costUsd;
  });
}

describe("TurnAccounting", () => {
  test("charges each turn the difference from the previous running total", () => {
    expect(charges([0.25, 0.75, 1])).toEqual([0.25, 0.5, 0.25]);
  });

  // The engine's totals continue across resumes (SDK 0.3.277 and later), so
  // what is charged must add up to its last total, not exceed it.
  test("a resumed run is charged only what it spent past the saved cost", () => {
    // New session: $3. Resume 1 saved $3 and spends $3 (total 6). Resume 2
    // saved $6 and spends $1.5 (total 7.5).
    const runs: Array<{ saved: number | undefined; totals: number[] }> = [
      { saved: undefined, totals: [3] },
      { saved: 3, totals: [6] },
      { saved: 6, totals: [7, 7.5] },
    ];
    let charged = 0;
    for (const { saved, totals } of runs) {
      const accounting = new TurnAccounting();
      accounting.continueFrom(
        saved === undefined ? undefined : { usd: saved, sessionId: "s" },
      );
      for (const total of totals) {
        accounting.observe(result(total));
        charged += accounting.settle().costUsd ?? 0;
      }
      expect(accounting.restarted).toBe(false);
    }
    expect(charged).toBe(7.5);
  });

  test("a resume with no saved cost counts its first total in full", () => {
    const accounting = new TurnAccounting();
    accounting.continueFrom(undefined);
    accounting.observe(result(6));
    expect(accounting.settle().costUsd).toBe(6);
  });

  test("a resume whose total starts below the saved cost counts it in full", () => {
    // An engine that counts from zero again must not be charged less.
    const accounting = new TurnAccounting();
    accounting.continueFrom({ usd: 3, sessionId: "s" });
    accounting.observe(result(1));
    expect(accounting.settle().costUsd).toBe(1);
    expect(accounting.restarted).toBe(true);
  });

  test("no saved cost, whatever its value, can charge less than the engine total", () => {
    for (const usd of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ]) {
      const accounting = new TurnAccounting();
      accounting.continueFrom({ usd, sessionId: "s" });
      accounting.observe(result(5));
      expect(accounting.settle().costUsd).toBe(5);
    }
    // Larger than the first total: the engine started over, so charge it all.
    const above = new TurnAccounting();
    above.continueFrom({ usd: 9, sessionId: "s" });
    above.observe(result(5));
    expect(above.settle().costUsd).toBe(5);
  });

  test("a saved cost with no session is not a baseline", () => {
    const accounting = new TurnAccounting();
    accounting.continueFrom({ usd: 3 });
    accounting.observe(result(5, "after-clear"));
    expect(accounting.settle().costUsd).toBe(5);
  });

  test("a /clear before the first resumed result is a new session, charged in full", () => {
    const accounting = new TurnAccounting();
    accounting.continueFrom({ usd: 3, sessionId: "saved" });
    accounting.observe(result(5, "after-clear"));
    expect(accounting.settle().costUsd).toBe(5);
    expect(accounting.restarted).toBe(true);
  });

  test("a total that drops counts the new total in full", () => {
    expect(charges([1, 0.25, 0.5])).toEqual([1, 0.25, 0.25]);
  });

  test("a new engine session counts its total in full even when it is higher", () => {
    const accounting = new TurnAccounting();
    accounting.observe(result(0.25, "first"));
    expect(accounting.settle().costUsd).toBe(0.25);
    accounting.observe(result(0.75, "after-clear"));
    expect(accounting.settle().costUsd).toBe(0.75);
    accounting.observe(result(1, "after-clear"));
    expect(accounting.settle().costUsd).toBe(0.25);
  });

  test("a zero total after spending reports nothing and keeps the baseline", () => {
    expect(charges([1, 0, 1.5])).toEqual([1, undefined, 0.5]);
  });

  test("a zero total before any spending is a cost of zero", () => {
    expect(charges([0, 0.5])).toEqual([0, 0.5]);
  });

  test("a new engine session that has spent nothing reports zero and resets the baseline", () => {
    const accounting = new TurnAccounting();
    accounting.observe(result(1, "old"));
    expect(accounting.settle().costUsd).toBe(1);
    accounting.observe(result(0, "new"));
    expect(accounting.settle().costUsd).toBe(0);
    accounting.observe(result(0, "new"));
    expect(accounting.settle().costUsd).toBe(0);
    accounting.observe(result(0.5, "new"));
    expect(accounting.settle().costUsd).toBe(0.5);
    // A zero after spending in the same session is still no report.
    accounting.observe(result(0, "new"));
    expect(accounting.settle().costUsd).toBeUndefined();
  });

  test("says when the engine's count started over, and only then", () => {
    const accounting = new TurnAccounting();
    accounting.observe(result(0.5, "resumed"));
    accounting.observe(result(1, "resumed"));
    // A result that reports nothing is not a new count.
    accounting.observe(result(0, "resumed"));
    expect(accounting.restarted).toBe(false);

    const cleared = new TurnAccounting();
    cleared.observe(result(1, "old"));
    cleared.observe(result(0, "new"));
    expect(cleared.restarted).toBe(true);

    const dropped = new TurnAccounting();
    dropped.observe(result(1));
    dropped.observe(result(0.25));
    expect(dropped.restarted).toBe(true);
  });

  test("a turn whose totals are missing or not a cost has no cost, not zero", () => {
    expect(charges([undefined, -1, Number.NaN, 0.5])).toEqual([
      undefined,
      undefined,
      undefined,
      0.5,
    ]);
  });

  test("a turn that reports nothing leaves carried cost for the next turn that does", () => {
    const accounting = new TurnAccounting();
    accounting.observe(result(1));
    expect(accounting.settle().costUsd).toBe(1);
    // Another turn's result, then this turn's own unusable zero.
    accounting.observe(result(1.25));
    accounting.observe(result(0));
    expect(accounting.settle().costUsd).toBeUndefined();
    accounting.observe(result(2));
    expect(accounting.settle().costUsd).toBe(1);
  });

  test("a result nobody settled rides on the next settlement", () => {
    const accounting = new TurnAccounting();
    accounting.observe(result(0.25));
    accounting.observe(result(0.75));
    expect(accounting.settle().costUsd).toBe(0.75);
    expect(accounting.settle().costUsd).toBeUndefined();
  });

  test("remembers the last retry status, and forgets it once a request succeeds", () => {
    const accounting = new TurnAccounting();
    accounting.observe({
      type: "system",
      subtype: "api_retry",
      error: "rate_limit",
      error_status: 429,
      session_id: "s",
    } as NativeSdkMessage);
    accounting.observe({
      type: "assistant",
      error: "rate_limit",
    } as NativeSdkMessage);
    expect(accounting.settle().providerFailure).toEqual({
      error: "rate_limit",
      status: 429,
    });

    accounting.observe({
      type: "system",
      subtype: "api_retry",
      error_status: 500,
      session_id: "s",
    } as NativeSdkMessage);
    accounting.observe({ type: "assistant" } as NativeSdkMessage);
    expect(accounting.settle().providerFailure).toBeUndefined();
  });

  test("a connection failure has no status", () => {
    const accounting = new TurnAccounting();
    accounting.observe({
      type: "system",
      subtype: "api_retry",
      error: "unknown",
      error_status: null,
      session_id: "s",
    } as NativeSdkMessage);
    expect(accounting.settle().providerFailure).toEqual({
      error: "unknown",
      status: null,
    });
  });
});
