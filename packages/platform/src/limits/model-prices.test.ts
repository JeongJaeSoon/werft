import { describe, expect, test } from "bun:test";
import {
  FAST_MODEL_PRICES,
  MODEL_PRICES,
  priceJudgmentUsage,
  priceProviderUsage,
} from "./model-prices.ts";
import { CLAUDE_CARDS, claudeCardsSchema } from "./model-prices-claude.ts";
import { OPENAI_CARDS, openAiCardsSchema } from "./model-prices-openai.ts";

const nothing = {
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
  estimated: false,
};

describe("priceProviderUsage", () => {
  test("prices every part at the model's rate, the hour-long cache writes at twice the input", () => {
    // claude-sonnet-5: $2 in, $10 out, $0.20 cache read per million.
    const { costUsd, pricedBy } = priceProviderUsage({
      ...nothing,
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 3_000_000,
      cacheCreation1hInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      estimated: false,
    });
    expect(pricedBy).toBe("table");
    // 2 + 10 + 2 × 2 × 1.25 + 1 × 2 × 2 + 0.2
    expect(costUsd).toBeCloseTo(21.2, 9);
  });

  test("a dated id is its own entry, and nothing else is matched by prefix", () => {
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-sonnet-4-5-20250929",
        outputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: 15, pricedBy: "table" });
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-sonnet-4-5-20990101",
        outputTokens: 1_000_000,
      }).pricedBy,
    ).toBe("fallback");
  });

  test("an unknown model pays the highest known rate for each part", () => {
    // Fast rates are known rates: claude-fable-5-2 fast's $80 out is the highest.
    const highest = Math.max(
      ...[
        ...Object.values(MODEL_PRICES),
        ...Object.values(FAST_MODEL_PRICES),
      ].map((price) => price.outputUsdPerMtok),
    );
    expect(highest).toBe(80);
    expect(
      priceProviderUsage({
        ...nothing,
        model: "litellm-alias",
        outputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: highest, pricedBy: "fallback" });
    expect(
      priceProviderUsage({ ...nothing, model: "constructor" }).pricedBy,
    ).toBe("fallback");
  });

  test("a fast answer pays the fast rates, cache multipliers on top", () => {
    // claude-opus-5-5 fast: $8 in, $40 out, $0.40 cache read per million.
    const { costUsd, pricedBy } = priceProviderUsage({
      ...nothing,
      model: "claude-opus-5-5",
      speed: "fast",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 2_000_000,
      cacheCreation1hInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    expect(pricedBy).toBe("table");
    // 8 + 40 + 1 × 8 × 1.25 + 1 × 8 × 2 + 0.4
    expect(costUsd).toBeCloseTo(74.4, 9);
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-opus-5-5",
        outputTokens: 1_000_000,
      }).costUsd,
    ).toBe(20);
  });

  test("a fast answer from a model without fast mode, or an unknown speed, pays its own rates at the highest multiple either table has", () => {
    // 6x is OpenAI's ultrafast, above Claude's 2x fast.
    for (const [usage, costUsd] of [
      [{ model: "claude-sonnet-5", speed: "fast" }, 10 * 6],
      [{ model: "claude-opus-5", speed: "turbo" }, 25 * 6],
      [{ model: "claude-opus-5", speed: "unknown" }, 25 * 6],
      [{ model: "claude-fable-5-2", speed: "turbo" }, 40 * 6],
    ] as const) {
      expect([
        usage,
        priceProviderUsage({ ...nothing, ...usage, outputTokens: 1_000_000 }),
      ]).toEqual([usage, { costUsd, pricedBy: "table" }]);
    }
    // A long prompt keeps its long rates at that multiple.
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-haiku-5-5",
        speed: "turbo",
        inputTokens: 200_000,
      }),
      // 200K at $0.50 long input, times 6.
    ).toEqual({ costUsd: 0.6, pricedBy: "table" });
    // Past a pre-4.6 model's window the fallback keeps that multiple too.
    const past = priceProviderUsage({
      ...nothing,
      model: "claude-sonnet-4-5",
      speed: "turbo",
      inputTokens: 1_000_000,
    });
    expect(past.pricedBy).toBe("fallback");
    expect(past.costUsd).toBeCloseTo(20 * 6, 9);
  });

  test("each web search adds $0.01; web fetch and code execution add nothing", () => {
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-sonnet-5",
        webSearchRequests: 3,
        webFetchRequests: 5,
        codeExecutionRequests: 7,
      }),
    ).toEqual({ costUsd: 0.03, pricedBy: "table" });
  });

  const highest = (() => {
    const prices = [
      ...Object.values(MODEL_PRICES),
      ...Object.values(FAST_MODEL_PRICES),
    ];
    return {
      input: Math.max(...prices.map((price) => price.inputUsdPerMtok)),
      output: Math.max(...prices.map((price) => price.outputUsdPerMtok)),
    };
  })();

  test("US-only inference pays 1.1x on every token rate, fast and cache ones included, but not on search fees", () => {
    const tokens = {
      ...nothing,
      model: "claude-opus-5-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 2_000_000,
      cacheCreation1hInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      webSearchRequests: 100,
    };
    // 4 + 20 + 1 × 4 × 1.25 + 1 × 4 × 2 + 0.2 = 37.2 in tokens, $1 in searches.
    expect(priceProviderUsage(tokens)).toEqual({
      costUsd: 38.2,
      pricedBy: "table",
    });
    const us = priceProviderUsage({ ...tokens, inferenceGeo: "us" });
    expect(us.pricedBy).toBe("table");
    expect(us.costUsd).toBeCloseTo(37.2 * 1.1 + 1, 9);
    // Fast: 74.4 in tokens (see above).
    expect(
      priceProviderUsage({ ...tokens, speed: "fast", inferenceGeo: "us" })
        .costUsd,
    ).toBeCloseTo(74.4 * 1.1 + 1, 9);
    // A whole micro-dollar figure stays whole, with nothing for the ledger's
    // ceil to round up.
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-opus-5",
        outputTokens: 1_000,
        inferenceGeo: "us",
      }).costUsd,
    ).toBe(0.0275);
  });

  test("a geo the table does not know pays the model's own rates at the highest geo multiplier", () => {
    for (const inferenceGeo of ["unknown", "eu", "US", "constructor"]) {
      expect([
        inferenceGeo,
        priceProviderUsage({
          ...nothing,
          model: "claude-sonnet-5",
          outputTokens: 1_000_000,
          inferenceGeo,
        }),
      ]).toEqual([inferenceGeo, { costUsd: 11, pricedBy: "table" }]);
    }
    // A model no table knows still pays the highest rate at that multiplier.
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-unknown",
        outputTokens: 1_000_000,
        inferenceGeo: "eu",
      }),
    ).toEqual({ costUsd: highest.output * 1.1, pricedBy: "fallback" });
  });

  test("a model from before 4.6 pays standard rates whatever the geo says", () => {
    for (const inferenceGeo of ["us", "unknown"]) {
      expect(
        priceProviderUsage({
          ...nothing,
          model: "claude-haiku-4-5",
          outputTokens: 1_000_000,
          inferenceGeo,
        }),
      ).toEqual({ costUsd: 5, pricedBy: "table" });
    }
  });

  test("a model from before 4.6 past 200K input, cache included, pays the highest rate; 4.6 and later keep theirs", () => {
    const at = (model: string, input: number) =>
      priceProviderUsage({
        ...nothing,
        model,
        inputTokens: input - 150_000,
        cacheCreationInputTokens: 100_000,
        cacheReadInputTokens: 50_000,
      });
    expect(at("claude-sonnet-4-5", 200_000).pricedBy).toBe("table");
    const over = at("claude-sonnet-4-5-20250929", 200_001);
    expect(over.pricedBy).toBe("fallback");
    // 50,001 in, 100,000 written for five minutes, 50,000 read.
    expect(over.costUsd).toBeGreaterThan((50_001 * highest.input) / 1_000_000);
    expect(at("claude-sonnet-4-6", 900_000).pricedBy).toBe("table");
    expect(at("claude-opus-4-6", 900_000).pricedBy).toBe("table");
  });

  test("claude-sonnet-5-5 pays $2/$10 and a $0.10 cache read, half Sonnet 5's", () => {
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-sonnet-5-5",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: 12.1, pricedBy: "table" });
  });

  test("claude-fable-5-2 and claude-mythos-5-2 pay $8/$40 with a $0.20 cache read, and twice that fast", () => {
    for (const model of ["claude-fable-5-2", "claude-mythos-5-2"]) {
      const call = {
        ...nothing,
        model,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      };
      expect([model, priceProviderUsage(call)]).toEqual([
        model,
        { costUsd: 48.2, pricedBy: "table" },
      ]);
      expect([model, priceProviderUsage({ ...call, speed: "fast" })]).toEqual([
        model,
        { costUsd: 96.4, pricedBy: "table" },
      ]);
    }
  });

  test("claude-haiku-5-5 pays $0.10/$0.50 up to a 100K prompt, cache included, and $0.50/$2.50 past it", () => {
    const at = (input: number) =>
      priceProviderUsage({
        ...nothing,
        model: "claude-haiku-5-5",
        inputTokens: input - 60_000,
        cacheCreationInputTokens: 40_000,
        cacheReadInputTokens: 20_000,
        outputTokens: 1_000_000,
      });
    const short = at(100_000);
    expect(short.pricedBy).toBe("table");
    // 40,000 × 0.1 + 40,000 × 0.1 × 1.25 + 20,000 × 0.01 + 1M × 0.5
    expect(short.costUsd).toBeCloseTo(0.5092, 9);
    const long = at(100_001);
    expect(long.pricedBy).toBe("table");
    // 40,001 × 0.5 + 40,000 × 0.5 × 1.25 + 20,000 × 0.05 + 1M × 2.5
    expect(long.costUsd).toBeCloseTo(2.5460005, 9);
  });
});

describe("priceJudgmentUsage", () => {
  test("gpt-6-luna charges $0.10 a million input tokens and nothing for output", () => {
    expect(
      priceJudgmentUsage({
        ...nothing,
        model: "gpt-6-luna",
        inputTokens: 600,
        outputTokens: 5,
        speed: "unknown",
        inferenceGeo: "unknown",
      }),
    ).toEqual({ costUsd: 0.00006, pricedBy: "table" });
  });

  test("a model the judge table does not know is charged the highest rate", () => {
    const priced = priceJudgmentUsage({
      ...nothing,
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
    });
    expect(priced.pricedBy).toBe("fallback");
    expect(priced.costUsd).toBeGreaterThan(2);
  });
});

// Figures from https://developers.openai.com/api/docs/pricing, checked
// 2026-11-12; the same URL and date sit in the table in model-prices-openai.ts.
describe("priceProviderUsage for an OpenAI model", () => {
  const openAi = { ...nothing, speed: "standard", inferenceGeo: "unknown" };

  test("prices input, cached input and output at the model's rates, whatever the geo", () => {
    // gpt-5.5: $5 in, $0.50 cached, $30 out per million.
    expect(
      priceProviderUsage({
        ...openAi,
        model: "gpt-5.5",
        inputTokens: 100_000,
        cacheReadInputTokens: 100_000,
        outputTokens: 100_000,
      }),
    ).toEqual({ costUsd: 0.5 + 0.05 + 3, pricedBy: "table" });
  });

  test("a dated snapshot prices as its base, and only a date suffix does", () => {
    const call = { ...openAi, outputTokens: 1_000_000 };
    expect(
      priceProviderUsage({ ...call, model: "gpt-5.5-2026-04-23" }),
    ).toEqual({ costUsd: 30, pricedBy: "table" });
    expect(
      priceProviderUsage({ ...call, model: "gpt-5.5-preview" }),
    ).toMatchObject({ pricedBy: "fallback" });
  });

  test("a prompt past 272K input tokens, cache included, pays the long-context card on every part", () => {
    // gpt-5.5 long: $10 in, $1 cached, $45 out.
    expect(
      priceProviderUsage({
        ...openAi,
        model: "gpt-5.5",
        inputTokens: 72_000,
        cacheReadInputTokens: 201_000,
        outputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: 0.72 + 0.201 + 45, pricedBy: "table" });
    expect(
      priceProviderUsage({
        ...openAi,
        model: "gpt-5.5",
        inputTokens: 72_000,
        cacheReadInputTokens: 200_000,
        outputTokens: 1_000_000,
      }).costUsd,
    ).toBeCloseTo(0.36 + 0.1 + 30, 9);
  });

  test("a model with no long-context card is priced by the fallback past 272K", () => {
    const priced = priceProviderUsage({
      ...openAi,
      model: "gpt-5.4-mini",
      inputTokens: 300_000,
    });
    expect(priced.pricedBy).toBe("fallback");
    expect(priced.costUsd).toBeGreaterThan((300_000 * 0.75) / 1_000_000);
  });

  test("a cache write costs 1.25x the input rate, a 12-hour one 2.5x", () => {
    const plain = priceProviderUsage({
      ...openAi,
      model: "gpt-6.1-sol",
      inputTokens: 100_000,
    }).costUsd;
    const written = priceProviderUsage({
      ...openAi,
      model: "gpt-6.1-sol",
      cacheCreationInputTokens: 100_000,
    }).costUsd;
    const twelveHours = priceProviderUsage({
      ...openAi,
      model: "gpt-6.1-sol",
      cacheCreationInputTokens: 100_000,
      cacheCreation1hInputTokens: 100_000,
    }).costUsd;
    expect(written).toBeCloseTo(plain * 1.25, 9);
    expect(twelveHours).toBeCloseTo(plain * 2.5, 9);
  });

  test("the fast speed doubles the token cost", () => {
    const call = { ...openAi, model: "gpt-6.1-sol", outputTokens: 100_000 };
    expect(priceProviderUsage({ ...call, speed: "fast" }).costUsd).toBeCloseTo(
      priceProviderUsage(call).costUsd * 2,
      9,
    );
  });

  test("gpt-5.5 fast is 2.5x its standard rates, as the Fast tab lists them", () => {
    // Fast tab: $12.50 in, $1.25 cached, $75 out.
    expect(
      priceProviderUsage({
        ...openAi,
        model: "gpt-5.5",
        speed: "fast",
        inputTokens: 100_000,
        cacheReadInputTokens: 100_000,
        outputTokens: 100_000,
      }).costUsd,
    ).toBeCloseTo(1.25 + 0.125 + 7.5, 9);
  });

  test("the Ultrafast tier is 6x the standard rates, long context and cache writes included", () => {
    // Ultrafast tab, gpt-6-astra: $60 in, $6 cached, $300 out; long $120 in,
    // $450 out; a 30-minute write $75. gpt-6.1-sol long: $24 in, $90 out.
    const astra = { ...openAi, model: "gpt-6-astra", speed: "ultrafast" };
    const short = priceProviderUsage({
      ...astra,
      inputTokens: 100_000,
      cacheReadInputTokens: 100_000,
      outputTokens: 100_000,
    });
    expect(short.pricedBy).toBe("table");
    expect(short.costUsd).toBeCloseTo(6 + 0.6 + 30, 9);
    expect(
      priceProviderUsage({
        ...astra,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }).costUsd,
    ).toBeCloseTo(120 + 450, 9);
    expect(
      priceProviderUsage({ ...astra, cacheCreationInputTokens: 100_000 })
        .costUsd,
    ).toBeCloseTo(7.5, 9);
    expect(
      priceProviderUsage({
        ...openAi,
        model: "gpt-6.1-sol",
        speed: "ultrafast",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }).costUsd,
    ).toBeCloseTo(24 + 90, 9);
  });

  // Was 2x, the fast rate (#1515). A tier the page adds later, or one the
  // answer names in a way the proxy does not map, may be dearer than fast:
  // 94S-1545 prices it at the highest known multiple.
  test("a tier the model's card does not list is priced at the highest known multiple, not the fast one", () => {
    const call = { ...openAi, model: "gpt-5.5", outputTokens: 100_000 };
    const standard = priceProviderUsage(call).costUsd;
    for (const speed of ["ultrafast", "unknown", "turbo", "constructor"]) {
      expect(priceProviderUsage({ ...call, speed }).costUsd).toBeCloseTo(
        standard * 6,
        9,
      );
    }
    // A model on neither speed tab pays the same for a `fast` answer.
    const nano = { ...openAi, model: "gpt-5-nano", outputTokens: 1_000_000 };
    expect(priceProviderUsage({ ...nano, speed: "fast" }).costUsd).toBeCloseTo(
      priceProviderUsage(nano).costUsd * 6,
      9,
    );
  });

  test("a Pro model is priced from its own card, a cache read at the input rate", () => {
    // gpt-5.5-pro: $30 in, no cached rate, $180 out; long $60 in, $270 out.
    expect(
      priceProviderUsage({
        ...openAi,
        model: "gpt-5.5-pro",
        inputTokens: 100_000,
        cacheReadInputTokens: 100_000,
        outputTokens: 100_000,
      }),
    ).toEqual({ costUsd: 3 + 3 + 18, pricedBy: "table" });
    expect(
      priceProviderUsage({
        ...openAi,
        model: "gpt-5.5-pro-2026-04-23",
        inputTokens: 300_000,
        outputTokens: 100_000,
      }),
    ).toEqual({ costUsd: 18 + 27, pricedBy: "table" });
  });

  test("a Pro model past its card is charged the highest Pro rates, other models are not", () => {
    // gpt-5.2-pro has no long card; the highest Pro rate is $60 in, $270 out.
    // The fallback prices an unknown geo high too, so this call names one.
    const long = {
      ...openAi,
      inferenceGeo: "global",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    expect(priceProviderUsage({ ...long, model: "gpt-5.2-pro" })).toEqual({
      costUsd: 60 + 270,
      pricedBy: "fallback",
    });
    // The fallback for every other model keeps the non-Pro highest: $20 in
    // (gpt-6-astra long), $80 out (claude-fable-5-2 fast).
    expect(priceProviderUsage({ ...long, model: "gpt-9" })).toEqual({
      costUsd: 20 + 80,
      pricedBy: "fallback",
    });
  });

  test("a longer prompt never costs less for a model past its card, at any speed", () => {
    // gpt-5.2-pro and gpt-5-nano have no long card and are on no speed tab.
    for (const model of ["gpt-5.2-pro", "gpt-5-nano", "gpt-5.4-mini"]) {
      for (const speed of ["standard", "fast", "ultrafast", "turbo"]) {
        const call = {
          ...openAi,
          model,
          speed,
          inferenceGeo: "global",
          outputTokens: 100_000,
        };
        const atCard = priceProviderUsage({ ...call, inputTokens: 272_000 });
        const past = priceProviderUsage({ ...call, inputTokens: 272_001 });
        expect([model, speed, past.pricedBy]).toEqual([
          model,
          speed,
          "fallback",
        ]);
        expect([model, speed, past.costUsd >= atCard.costUsd]).toEqual([
          model,
          speed,
          true,
        ]);
      }
    }
  });

  test("every card names its source page and the day it was checked", () => {
    for (const [model, entry] of Object.entries(OPENAI_CARDS)) {
      expect([model, entry.source, entry.checked]).toEqual([
        model,
        "https://developers.openai.com/api/docs/pricing",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      ]);
    }
  });

  test("the card schema refuses a card that would undercharge or lose its source", () => {
    const rates = {
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 10,
      cacheReadUsdPerMtok: 0.2,
    };
    const good = {
      source: "https://developers.openai.com/api/docs/pricing",
      checked: "2026-11-12",
      short: rates,
      speeds: { fast: 2 },
    };
    expect(openAiCardsSchema.safeParse({ m: good }).success).toBe(true);
    for (const bad of [
      { ...good, short: { ...rates, inputUsdPerMtok: -1 } },
      { ...good, short: { ...rates, outputUsdPerMtok: Number.NaN } },
      { ...good, long: { ...rates, outputUsdPerMtok: 9 } },
      { ...good, speeds: { fast: 0.5 } },
      { ...good, speeds: { standard: 2 } },
      { ...good, checked: "2026-13-01" },
      { ...good, checked: undefined },
      { ...good, source: "http://developers.openai.com/api/docs/pricing" },
      { ...good, short: { ...rates, cacheWriteUsdPerMtok: 1 } },
    ]) {
      expect([bad, openAiCardsSchema.safeParse({ m: bad }).success]).toEqual([
        bad,
        false,
      ]);
    }
  });

  test("every Claude card names its source page and the day it was checked", () => {
    for (const [model, entry] of Object.entries(CLAUDE_CARDS)) {
      expect([model, entry.source, entry.checked]).toEqual([
        model,
        "https://platform.claude.com/docs/en/about-claude/pricing",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      ]);
    }
  });

  test("the Claude card schema refuses a card that would undercharge or lose its source", () => {
    const rates = {
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 10,
      cacheReadUsdPerMtok: 0.2,
    };
    const good = {
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      checked: "2026-11-13",
      standard: rates,
      fast: 2,
      geo: true,
    };
    const long = {
      aboveTokens: 100_000,
      rates: { ...rates, outputUsdPerMtok: 20 },
    };
    const { fast: _, ...slow } = good;
    expect(claudeCardsSchema.safeParse({ m: good }).success).toBe(true);
    expect(claudeCardsSchema.safeParse({ m: { ...slow, long } }).success).toBe(
      true,
    );
    for (const bad of [
      { ...good, standard: { ...rates, inputUsdPerMtok: -1 } },
      { ...good, standard: { ...rates, cacheReadUsdPerMtok: 0 } },
      { ...good, standard: { ...rates, outputUsdPerMtok: Number.NaN } },
      { ...slow, long: { ...long, rates: { ...rates, outputUsdPerMtok: 9 } } },
      { ...slow, long: { ...long, aboveTokens: 0 } },
      // A fast call would be charged its standard-length rates past the threshold.
      { ...good, long },
      { ...good, fast: 0.5 },
      // Fast mode is premium pricing: 1x would charge a fast call standard rates.
      { ...good, fast: 1 },
      { ...good, geo: undefined },
      { ...good, checked: "2026-13-01" },
      { ...good, checked: undefined },
      {
        ...good,
        source: "http://platform.claude.com/docs/en/about-claude/pricing",
      },
      { ...good, standard: { ...rates, cacheWriteUsdPerMtok: 1 } },
    ]) {
      expect([bad, claudeCardsSchema.safeParse({ m: bad }).success]).toEqual([
        bad,
        false,
      ]);
    }
  });

  test("a web search adds its call fee to the tokens", () => {
    const call = {
      ...openAi,
      model: "gpt-5.5",
      inputTokens: 100,
      outputTokens: 100,
    };
    expect(
      priceProviderUsage({ ...call, webSearchRequests: 1 }).costUsd -
        priceProviderUsage(call).costUsd,
    ).toBeCloseTo(0.01, 9);
  });

  test("the fallback is never cheaper than a known long-context card", () => {
    const unknown = priceProviderUsage({
      ...openAi,
      model: "gpt-9",
      inputTokens: 1_000_000,
    });
    const longest = priceProviderUsage({
      ...openAi,
      model: "gpt-6-astra",
      inputTokens: 1_000_000,
    });
    expect(unknown.pricedBy).toBe("fallback");
    expect(unknown.costUsd).toBeGreaterThanOrEqual(longest.costUsd);
  });

  test("an OpenAI model the table does not know is charged the highest rate", () => {
    const priced = priceProviderUsage({
      ...openAi,
      model: "gpt-9",
      outputTokens: 1_000_000,
    });
    expect(priced.pricedBy).toBe("fallback");
    expect(priced.costUsd).toBeGreaterThanOrEqual(50);
  });

  // Was 2x for every speed (#1515, #1630): fast is now gpt-5.5's 2.5x, and a
  // tier past fast the highest multiple the table knows (94S-1545).
  test("a model no table names is charged the dearest multiple of its tier away from the standard speed", () => {
    const call = { ...openAi, model: "gpt-9", outputTokens: 1_000_000 };
    const standard = priceProviderUsage(call).costUsd;
    for (const [speed, multiple] of [
      ["fast", 2.5],
      ["ultrafast", 6],
      ["unknown", 6],
    ] as const) {
      expect(priceProviderUsage({ ...call, speed })).toEqual({
        costUsd: standard * multiple,
        pricedBy: "fallback",
      });
    }
  });

  test("a model no table names is charged a 12-hour cache write at 2.5x the input rate", () => {
    const call = { ...openAi, model: "gpt-9" };
    const plain = priceProviderUsage({ ...call, inputTokens: 1_000_000 });
    const twelveHours = priceProviderUsage({
      ...call,
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 1_000_000,
    });
    expect(twelveHours.pricedBy).toBe("fallback");
    expect(twelveHours.costUsd).toBeCloseTo(plain.costUsd * 2.5, 9);
  });

  test("an OpenAI model past its table's prompt length is charged the same multipliers", () => {
    // gpt-5.4-mini has no long-context card, so 300K of input is the fallback's.
    const call = { ...openAi, model: "gpt-5.4-mini", inputTokens: 300_000 };
    const standard = priceProviderUsage(call);
    expect(standard.pricedBy).toBe("fallback");
    // Was 2x (#1630); fast is now the dearest fast multiple, 2.5x (94S-1545).
    expect(priceProviderUsage({ ...call, speed: "fast" })).toEqual({
      costUsd: standard.costUsd * 2.5,
      pricedBy: "fallback",
    });
    const twelveHours = priceProviderUsage({
      ...call,
      inputTokens: 0,
      cacheCreationInputTokens: 300_000,
      cacheCreation1hInputTokens: 300_000,
    });
    expect(twelveHours.costUsd).toBeCloseTo(standard.costUsd * 2.5, 9);
  });

  test("the fallback is never cheaper than a known model, part by part, at the same speed, prompt length and geo", () => {
    // One part at a time, so a low rate on one cannot hide behind another.
    const partsOf = (size: number) => [
      { inputTokens: size },
      { cacheReadInputTokens: size },
      { cacheCreationInputTokens: size },
      { cacheCreationInputTokens: size, cacheCreation1hInputTokens: size },
    ];
    const usages = [
      // Up to 272K of input is the short card, past it the long one.
      ...partsOf(100_000),
      ...partsOf(272_000),
      ...partsOf(272_001),
      { outputTokens: 100_000 },
      { inputTokens: 272_001, outputTokens: 100_000 },
    ];
    for (const model of [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]) {
      for (const speed of ["standard", "fast", "ultrafast", "turbo"]) {
        for (const inferenceGeo of ["unknown", "global"]) {
          for (const part of usages) {
            const usage = { ...nothing, ...part, speed, inferenceGeo };
            const known = priceProviderUsage({ ...usage, model });
            const unknown = priceProviderUsage({ ...usage, model: "gpt-9" });
            expect(known.pricedBy).toBe("table");
            expect(unknown.pricedBy).toBe("fallback");
            expect([model, speed, inferenceGeo, part, unknown.costUsd]).toEqual(
              [
                model,
                speed,
                inferenceGeo,
                part,
                Math.max(unknown.costUsd, known.costUsd),
              ],
            );
          }
        }
      }
    }
  });

  test("a model the Claude table names keeps its own rates and Claude's cache writes when its speed is not one the table has", () => {
    // $25 out at the highest multiple either table has (6x).
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-opus-5",
        speed: "turbo",
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
      }),
    ).toEqual({ costUsd: 150, pricedBy: "table" });
    const hourLong = priceProviderUsage({
      ...nothing,
      model: "claude-opus-5",
      speed: "turbo",
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 1_000_000,
    });
    const input = priceProviderUsage({
      ...nothing,
      model: "claude-opus-5",
      speed: "turbo",
      inputTokens: 1_000_000,
    });
    expect(hourLong.costUsd).toBeCloseTo(input.costUsd * 2, 9);
  });
});
