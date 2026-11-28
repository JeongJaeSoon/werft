import { describe, expect, test } from "bun:test";
import { CLAUDE_CARDS } from "./model-prices-claude.ts";
import {
  LITELLM_SNAPSHOT,
  LITELLM_TOKEN_RATES,
} from "./model-prices-litellm.gen.ts";
import {
  liteLlmPrices,
  liteLlmRatesFor,
  PRICE_VERSION,
} from "./model-prices-litellm.ts";
import { OPENAI_CARDS } from "./model-prices-openai.ts";

const writes = { short: 1.25, long: 2.5 };

describe("the LiteLLM snapshot's lookups", () => {
  test("the name itself is looked up before any prefixed entry", () => {
    const { ratesFor } = liteLlmPrices(
      [
        ["m", 1, 2, 0.1],
        ["azure/m", 9, 9, 9],
      ],
      [],
    );
    expect(ratesFor("m", 0, writes)).toMatchObject({
      input: 1,
      output: 2,
      cacheRead: 0.1,
    });
    expect(ratesFor("azure/m", 0, writes)).toMatchObject({ input: 9 });
  });

  test("a name only prefixed entries carry is charged the dearest of them, part by part", () => {
    const { ratesFor } = liteLlmPrices(
      [
        ["azure/m", 1, 8, 0.5, 2, 3],
        ["bedrock/eu/m", 4, 2, 0.1, 5, 6],
        ["azure/other", 100, 100],
      ],
      [],
    );
    expect(ratesFor("m", 0, writes)).toEqual({
      input: 4,
      output: 8,
      cacheRead: 0.5,
      cacheWrite: 5,
      cacheWriteLong: 6,
    });
    // The name asked for is not stripped: only the entries' prefixes are.
    expect(ratesFor("vertex/m", 0, writes)).toBeUndefined();
    expect(ratesFor("unlisted", 0, writes)).toBeUndefined();
  });

  test("a part the snapshot does not price is charged from the input rate, undiscounted", () => {
    const { ratesFor } = liteLlmPrices([["m", 2, 10]], []);
    expect(ratesFor("m", 0, writes)).toEqual({
      input: 2,
      output: 10,
      cacheRead: 2,
      cacheWrite: 2.5,
      cacheWriteLong: 5,
    });
    // One prefixed entry without a cache rate keeps the name undiscounted.
    const mixed = liteLlmPrices(
      [
        ["a/m", 2, 10, 0.2],
        ["b/m", 2, 10],
      ],
      [],
    );
    expect(mixed.ratesFor("m", 0, writes)?.cacheRead).toBe(2);
  });

  test("past a tier's prompt length its rates apply, never below the base's", () => {
    const { ratesFor } = liteLlmPrices(
      [["m", 1, 4, 0.1, 0, 0, 200_000, 2, 3, 0, 0, 0, 500_000, 5, 9, 0.5]],
      [],
    );
    expect(ratesFor("m", 200_000, writes)).toMatchObject({
      input: 1,
      output: 4,
      cacheRead: 0.1,
    });
    // The tier gives no cache read and a lower output: the tier's input, the base's output.
    expect(ratesFor("m", 200_001, writes)).toMatchObject({
      input: 2,
      output: 4,
      cacheRead: 2,
    });
    expect(ratesFor("m", 500_001, writes)).toMatchObject({
      input: 5,
      output: 9,
      cacheRead: 0.5,
    });
  });

  test("a row that would undercharge fails the load", () => {
    for (const row of [
      ["m", 0, 1],
      ["m", 1, 0],
      ["m", 1],
      ["m", 1, 1, -0.1],
      ["m", 1, 1, Number.NaN],
      ["m", 1, 1, Number.POSITIVE_INFINITY],
      ["m", 1, 1, 0, 0, 0, 200_000, 2, 2, 0, 0, 0, 100_000, 3, 3],
    ] as const) {
      expect(() => liteLlmPrices([row], [])).toThrow(/LiteLLM snapshot: m/);
    }
    expect(() => liteLlmPrices([], [["j", 0, 0]])).toThrow(/no input rate/);
  });

  test("a judgment model is found by its exact name and may charge nothing for its answer", () => {
    const { decisionRatesFor } = liteLlmPrices([], [["p/judge", 0.1, 0]]);
    expect(decisionRatesFor("p/judge")).toEqual({ input: 0.1, output: 0 });
    expect(decisionRatesFor("judge")).toBeUndefined();
  });
});

describe("the snapshot in the repository", () => {
  test("names its upstream commit, the file's sha256 and the rules' version", () => {
    expect(LITELLM_SNAPSHOT.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(LITELLM_SNAPSHOT.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(PRICE_VERSION).toBe(
      `litellm@${LITELLM_SNAPSHOT.commit}/r${LITELLM_SNAPSHOT.rules}`,
    );
  });

  test("is sorted by name with no name twice, so an update's diff is the upstream's", () => {
    const names = LITELLM_TOKEN_RATES.map(([name]) => name);
    expect(names.length).toBeGreaterThan(1000);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  // A table the snapshot prices above is a table gone stale: the platform's
  // own rates come first, so the call would be charged the lower one.
  test("prices no model above the platform's own table for it", () => {
    const own: [
      string,
      { inputUsdPerMtok: number; outputUsdPerMtok: number },
    ][] = [
      ...Object.entries(CLAUDE_CARDS).map(
        ([model, card]) =>
          [model, card.standard] as [string, typeof card.standard],
      ),
      ...Object.entries(OPENAI_CARDS).map(
        ([model, card]) => [model, card.short] as [string, typeof card.short],
      ),
    ];
    const above = own.flatMap(([model, rates]) => {
      const theirs = liteLlmRatesFor(model, 0, writes);
      return theirs !== undefined &&
        (theirs.input > rates.inputUsdPerMtok ||
          theirs.output > rates.outputUsdPerMtok)
        ? [
            `${model}: snapshot ${theirs.input}/${theirs.output}, table ${rates.inputUsdPerMtok}/${rates.outputUsdPerMtok}`,
          ]
        : [];
    });
    expect(above).toEqual([]);
  });
});
