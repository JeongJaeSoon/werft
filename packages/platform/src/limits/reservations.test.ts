import { describe, expect, test } from "bun:test";
import type { ProviderUsage } from "./model-prices.ts";
import {
  admitsReservations,
  priceReservation,
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
    const admits = admitsReservations({
      costUsd: 3 * cost,
      tokens: null,
      unknownPriceTokens: 1,
    });
    const held = {
      costUsd: cost - 0.01,
      providerTokens: 0,
      unknownPriceTokens: 0,
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
      unknownPriceTokens: 1,
    });
    const held = {
      costUsd: 0,
      providerTokens: 0,
      unknownPriceTokens: 0,
      unmetered: true,
    };
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

describe("the limit on tokens of unknown price", () => {
  // A model no table and no snapshot entry names.
  const unknown: ProviderUsage = {
    ...nothing,
    model: "no-table-and-no-snapshot-names-this",
    inputTokens: 600,
    outputTokens: 400,
  };
  const known: ProviderUsage = { ...unknown, model: "claude-sonnet-5" };
  // No other limit in the way.
  const admitsUnder = (unknownPriceTokens: number) =>
    admitsReservations({
      costUsd: 1_000_000,
      tokens: null,
      unknownPriceTokens,
    });
  const session = {
    costUsd: 0,
    providerTokens: 0,
    unknownPriceTokens: 0,
    unmetered: false,
  };

  test("admits a call for an unpriced model while its reserve stays under the limit", () => {
    expect(admitsUnder(1_001)({ ...session, reserves: [unknown] })).toBe(true);
  });

  test("refuses the first call when its reserve alone reaches the limit", () => {
    expect(admitsUnder(1_000)({ ...session, reserves: [unknown] })).toBe(false);
  });

  test("counts settled tokens marked unknown with every held reserve for an unpriced model", () => {
    const held = { ...session, unknownPriceTokens: 500 };
    // 500 settled + 1,000 held + 1,000 new.
    expect(admitsUnder(2_501)({ ...held, reserves: [unknown, unknown] })).toBe(
      true,
    );
    expect(admitsUnder(2_500)({ ...held, reserves: [unknown, unknown] })).toBe(
      false,
    );
  });

  test("never refuses a session with no tokens of unknown price, however low it is set", () => {
    expect(admitsUnder(1)({ ...session, reserves: [known, known] })).toBe(true);
  });

  test("a priced model's reserve adds nothing to it, and one priced from the snapshot is priced", () => {
    const held = { ...session, unknownPriceTokens: 999 };
    expect(admitsUnder(1_000)({ ...held, reserves: [known] })).toBe(true);
    const fromSnapshot = { ...unknown, model: "deepseek-chat" };
    expect(priceReservation(fromSnapshot).pricedBy).toBe("litellm");
    expect(admitsUnder(1_000)({ ...held, reserves: [fromSnapshot] })).toBe(
      true,
    );
  });

  test("once its settled tokens reach the limit, the session opens no further call, priced or not", () => {
    const held = { ...session, unknownPriceTokens: 1_000 };
    expect(admitsUnder(1_000)({ ...held, reserves: [known] })).toBe(false);
  });

  test("a reserve for an unpriced model holds no amount: the cost limit is left to the priced calls", () => {
    expect(priceReservation(unknown)).toEqual({
      costUsd: 0,
      pricedBy: "unknown",
    });
    const cost = reservationCostUsd(known);
    expect(cost).toBeGreaterThan(0);
    const admits = admitsReservations({
      costUsd: cost * 1.5,
      tokens: null,
      unknownPriceTokens: 1_000_000,
    });
    expect(
      admits({ ...session, reserves: [unknown, unknown, unknown, known] }),
    ).toBe(true);
    expect(admits({ ...session, reserves: [unknown, known, known] })).toBe(
      false,
    );
  });

  test("a session its priced calls took to the cost limit opens no call for an unpriced model either", () => {
    const admits = admitsReservations({
      costUsd: 5,
      tokens: null,
      unknownPriceTokens: 1_000_000,
    });
    expect(admits({ ...session, costUsd: 4.99, reserves: [unknown] })).toBe(
      true,
    );
    expect(admits({ ...session, costUsd: 5, reserves: [unknown] })).toBe(false);
  });

  test("an unmetered session's reserves are not of unknown price", () => {
    expect(
      admitsUnder(1_000)({ ...session, unmetered: true, reserves: [unknown] }),
    ).toBe(true);
  });
});
