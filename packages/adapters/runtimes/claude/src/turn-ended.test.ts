import { describe, expect, test } from "bun:test";
import type { NativeSdkMessage } from "./driver.ts";
import { TurnAccounting } from "./turn-accounting.ts";
import { turnEndedOf } from "./turn-ended.ts";

function ended(result: NativeSdkMessage, before: NativeSdkMessage[] = []) {
  const accounting = new TurnAccounting();
  for (const message of [...before, result]) accounting.observe(message);
  return turnEndedOf(result, accounting, undefined);
}

describe("turnEndedOf", () => {
  test("a clean success is no failure", () => {
    expect(
      ended({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        terminal_reason: "completed",
        usage: { input_tokens: 3 },
      }),
    ).toEqual({
      isError: false,
      abortedByStop: false,
      budgetExceeded: false,
      engineResult: {
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        terminal_reason: "completed",
      },
      cost: { countRestarted: false, unknown: true },
      usage: { input_tokens: 3 },
      inputs: [],
    });
  });

  test.each([
    [
      "an error subtype is its own reason",
      { subtype: "error_during_execution", is_error: true },
      { isError: true, abortedByStop: false, budgetExceeded: false },
      "error_during_execution",
    ],
    [
      "a success the engine flags as an error takes its terminal reason",
      {
        subtype: "success",
        is_error: true,
        terminal_reason: "prompt_too_long",
      },
      { isError: true, abortedByStop: false, budgetExceeded: false },
      "prompt_too_long",
    ],
    [
      "a flagged success with no terminal reason is a plain error",
      { subtype: "success", is_error: true },
      { isError: true, abortedByStop: false, budgetExceeded: false },
      "error",
    ],
    [
      "a subtype that is not a string is unknown",
      { is_error: false },
      { isError: true, abortedByStop: false, budgetExceeded: false },
      "unknown",
    ],
    [
      "the engine's budget running out",
      { subtype: "error_max_budget_usd", is_error: true },
      { isError: true, abortedByStop: false, budgetExceeded: true },
      "error_max_budget_usd",
    ],
    [
      "an abort mid-tool",
      {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
      },
      { isError: true, abortedByStop: true, budgetExceeded: false },
      "error_during_execution",
    ],
    [
      "an abort mid-response the engine calls a success",
      {
        subtype: "success",
        is_error: false,
        terminal_reason: "aborted_streaming",
      },
      { isError: false, abortedByStop: true, budgetExceeded: false },
      "aborted_streaming",
    ],
  ])("%s", (_, fields, flags, reason) => {
    const turn = ended({ type: "result", ...fields });

    expect(turn).toMatchObject(flags);
    expect(turn.failure).toEqual({ reason });
  });

  test("a provider refusal carries the provider's failure on the result", () => {
    const turn = ended(
      {
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
      },
      [
        { type: "system", subtype: "api_retry", error_status: 529 },
        { type: "assistant", error: "overloaded" },
      ],
    );

    expect(turn.failure).toEqual({ reason: "api_error", httpStatus: 529 });
    expect(turn.engineResult).toEqual({
      subtype: "success",
      is_error: true,
      stop_reason: null,
      terminal_reason: "api_error",
      api_error_status: 529,
      provider_error: "overloaded",
      last_retry_status: 529,
    });
  });

  test("a new engine session restarts the count", () => {
    const accounting = new TurnAccounting();
    const first = { type: "result", total_cost_usd: 2, session_id: "s1" };
    const second = { type: "result", total_cost_usd: 0.5, session_id: "s2" };
    accounting.observe(first);
    turnEndedOf(first, accounting, undefined);
    accounting.observe(second);

    expect(turnEndedOf(second, accounting, undefined).cost).toEqual({
      deltaUsd: 0.5,
      countRestarted: true,
      unknown: false,
    });
  });
});
