import { describe, expect, test } from "bun:test";
import type { ProviderUsage } from "./model-prices.ts";
import {
  admitsReservations,
  reservationCostUsd,
  reservationTokens,
} from "./reservations.ts";

const nothing: ProviderUsage = {
  model: "claude-sonnet-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "global",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: true,
};

describe("reservationCostUsd", () => {
  test("a Claude reserve pays its whole prompt as hour-long cache writes", () => {
    // claude-sonnet-5: $2 in, $10 out per million; an hour-long write is 2×.
    expect(
      reservationCostUsd({
        ...nothing,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(1 * 2 * 2 + 10, 9);
  });

  test("an OpenAI reserve pays its whole prompt as twelve-hour cache writes", () => {
    // gpt-5.5: $5 in, $30 out per million; a twelve-hour write is 2.5×.
    expect(
      reservationCostUsd({
        ...nothing,
        model: "gpt-5.5",
        inputTokens: 100_000,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(0.1 * 5 * 2.5 + 0.1 * 30, 9);
  });
});

describe("admitsReservations", () => {
  const reserve: ProviderUsage = {
    ...nothing,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };
  const cost = reservationCostUsd(reserve);

  test("admits while stored spend and every reserve stay under the cost limit, and not at it", () => {
    const admits = admitsReservations({ costUsd: 3 * cost, tokens: null });
    const held = {
      costUsd: cost - 0.01,
      providerTokens: 0,
      unmetered: false,
    };
    expect(admits({ ...held, reserves: [reserve] })).toBe(true);
    expect(admits({ ...held, reserves: [reserve, reserve] })).toBe(true);
    expect(
      admits({ ...held, costUsd: cost, reserves: [reserve, reserve] }),
    ).toBe(false);
  });

  test("an unmetered session's reserves cost nothing but their tokens count", () => {
    const admits = admitsReservations({
      costUsd: 1,
      tokens: 3 * reservationTokens(reserve),
    });
    const held = { costUsd: 0, providerTokens: 0, unmetered: true };
    expect(admits({ ...held, reserves: [reserve, reserve] })).toBe(true);
    expect(admits({ ...held, reserves: [reserve, reserve, reserve] })).toBe(
      false,
    );
    expect(admits({ ...held, unmetered: false, reserves: [reserve] })).toBe(
      false,
    );
  });

  test("a reserve's tokens are what the provider_usage trigger would add", () => {
    expect(
      reservationTokens({
        ...nothing,
        inputTokens: 1,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 300,
        outputTokens: 4_000,
      }),
    ).toBe(4_321);
  });
});
