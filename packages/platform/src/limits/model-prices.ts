/**
 * What the platform charges a session for one Messages call: the
 * provider's list price per million tokens, by the model the answer names.
 * The platform owns this table and updates it with its releases, when a
 * model is added or a price changes; checked against Anthropic's pricing
 * on 2026-11-02.
 *
 * Fast mode has its own rates, and each web search adds its
 * per-search fee. US-only inference costs 1.1x on every token rate.
 * An estimate, not a bill: code execution container time is not priced.
 *
 * An OpenAI model, which an `openai_responses` session calls, is priced from
 * `model-prices-openai.ts`.
 */

import {
  OPENAI_ALL_RATES,
  OPENAI_CACHE_WRITE_12H,
  OPENAI_CACHE_WRITE_30M,
  openAiFallbackFloor,
  openAiFallbackSpeedMultiplier,
  openAiRatesFor,
  openAiSpeedMultiplier,
} from "./model-prices-openai.ts";

type ModelPrice = {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
};

// Cache writes cost a multiple of the input rate: 1.25x held five minutes,
// 2x held an hour.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

function price(input: number, output: number, cacheRead: number): ModelPrice {
  return {
    inputUsdPerMtok: input,
    outputUsdPerMtok: output,
    cacheReadUsdPerMtok: cacheRead,
  };
}

const FABLE_5_1 = price(10, 50, 0.25);
const FABLE_5 = price(10, 50, 1);
const OPUS_5_5 = price(4, 20, 0.2);
const OPUS_5 = price(5, 25, 0.5);
const OPUS_4 = price(15, 75, 1.5);
const SONNET_5 = price(2, 10, 0.2);
const SONNET_4 = price(3, 15, 0.3);
const HAIKU_4_5 = price(1, 5, 0.1);
const HAIKU_5_5 = price(0.1, 0.5, 0.01);

/** Exact model ids as an answer names them, aliases and dated ids both. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": FABLE_5_1,
  "claude-mythos-5-1": FABLE_5_1,
  "claude-fable-5": FABLE_5,
  "claude-mythos-5": FABLE_5,
  "claude-opus-5-5": OPUS_5_5,
  "claude-opus-5": OPUS_5,
  "claude-opus-4-8": OPUS_5,
  "claude-opus-4-7": OPUS_5,
  "claude-opus-4-6": OPUS_5,
  "claude-opus-4-5": OPUS_5,
  "claude-opus-4-5-20251101": OPUS_5,
  "claude-opus-4-0": OPUS_4,
  "claude-opus-4-20250514": OPUS_4,
  "claude-sonnet-5-5": SONNET_5,
  "claude-sonnet-5": SONNET_5,
  "claude-sonnet-4-6": SONNET_4,
  "claude-sonnet-4-5": SONNET_4,
  "claude-sonnet-4-5-20250929": SONNET_4,
  "claude-sonnet-4-0": SONNET_4,
  "claude-sonnet-4-20250514": SONNET_4,
  "claude-haiku-5-5": HAIKU_5_5,
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-haiku-4-5-20251001": HAIKU_4_5,
};

/**
 * Models with a second rate card for a long prompt: past `aboveTokens` of
 * input, cache included, every part of the call pays `price`.
 */
const LONG_PROMPT_PRICES: Readonly<
  Record<string, { aboveTokens: number; price: ModelPrice }>
> = {
  "claude-haiku-5-5": { aboveTokens: 100_000, price: price(0.5, 2.5, 0.05) },
};

/**
 * Models from before Claude 4.6. They cannot run with `inference_geo` and
 * always pay the standard rates. Their window is 200K tokens and the table's
 * rates stop there: an answer that used more came from a provider charging
 * a long-context rate the table does not know.
 */
const BEFORE_4_6: ReadonlySet<string> = new Set([
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
]);
const BEFORE_4_6_CONTEXT_TOKENS = 200_000;

/**
 * What `inference_geo` multiplies every token rate by, cache ones included,
 * in percent: a whole micro-dollar figure stays whole, where times 1.1 it
 * would pick up float noise that the ledger's ceil turns into a micro-dollar.
 */
const GEO_PERCENT: Readonly<Record<string, number>> = {
  global: 100,
  us: 110,
};

/** `speed: "fast"` rates, twice the standard ones for the models offering it. */
export const FAST_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": price(8, 40, 0.4),
  "claude-opus-5": price(10, 50, 1),
  "claude-opus-4-8": price(10, 50, 1),
};

/**
 * $10 per 1,000 searches, in millionths of a dollar like a token count
 * times its per-million rate. Web fetch has no fee beyond its tokens.
 */
const WEB_SEARCH_MICRO_USD = 10_000;

/**
 * A model the table does not know, at a speed or in a geo it does not know,
 * is charged every part at the highest rate either table has, and an unknown
 * geo at the highest multiplier too: a budget errs on counting too much,
 * never too little.
 */
const FALLBACK_PRICE: ModelPrice = (() => {
  const prices = [
    ...Object.values(MODEL_PRICES),
    ...Object.values(FAST_MODEL_PRICES),
    ...OPENAI_ALL_RATES,
  ];
  return price(
    Math.max(...prices.map((known) => known.inputUsdPerMtok)),
    Math.max(...prices.map((known) => known.outputUsdPerMtok)),
    Math.max(...prices.map((known) => known.cacheReadUsdPerMtok)),
  );
})();
const FALLBACK_GEO_PERCENT = Math.max(...Object.values(GEO_PERCENT));

/**
 * The fallback for a model the Claude table does not name: one no table
 * knows, or an OpenAI one whose table has no rates for the prompt's length.
 * Either may be an OpenAI call, so away from the standard speed every rate
 * is multiplied by the dearest multiple the OpenAI table has for that tier,
 * and its cache writes cost what the dearer of the two providers charges. A
 * model the Claude table names stays on Claude's own highest rates above.
 */
const NON_CLAUDE_SHORT_WRITE = Math.max(CACHE_WRITE_5M, OPENAI_CACHE_WRITE_30M);
const NON_CLAUDE_LONG_WRITE = Math.max(CACHE_WRITE_1H, OPENAI_CACHE_WRITE_12H);

export type ProviderUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Every cache write, the hour-long ones included. */
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
  cacheReadInputTokens: number;
  /** `standard`, `fast`, or whatever else the call named, which is priced high. */
  speed: string;
  /** `global`, `us`, or whatever else, `unknown` included, which is priced high. */
  inferenceGeo: string;
  webSearchRequests: number;
  webFetchRequests: number;
  /** Billed by container time, which the answer does not say: not priced. */
  codeExecutionRequests: number;
  /** The proxy estimated some of it high; the answer did not say. */
  estimated: boolean;
};

/**
 * Which rates priced a call: the table's, the fallback's (a model the table
 * does not know), or none, for a connection that declared `billing: none`.
 */
export type PricedBy = "table" | "fallback" | "unmetered";

export function priceProviderUsage(usage: ProviderUsage): {
  costUsd: number;
  pricedBy: "table" | "fallback";
} {
  // An OpenAI model has no speed or geo to price: its own table decides, and
  // a model or prompt length it does not cover falls through to the fallback.
  const openAi = openAiRatesFor(
    usage.model,
    usage.inputTokens +
      usage.cacheCreationInputTokens +
      usage.cacheReadInputTokens,
  );
  if (openAi !== undefined) {
    const longWrites = Math.min(
      usage.cacheCreation1hInputTokens,
      usage.cacheCreationInputTokens,
    );
    const shortWrites = usage.cacheCreationInputTokens - longWrites;
    const tokenCost =
      (usage.inputTokens * openAi.inputUsdPerMtok +
        shortWrites * openAi.inputUsdPerMtok * OPENAI_CACHE_WRITE_30M +
        longWrites * openAi.inputUsdPerMtok * OPENAI_CACHE_WRITE_12H +
        usage.cacheReadInputTokens * openAi.cacheReadUsdPerMtok +
        usage.outputTokens * openAi.outputUsdPerMtok) /
      1_000_000;
    return {
      costUsd:
        // A tier the model's card does not list, or none reported, is
        // priced at the dearest multiple the table knows.
        tokenCost * openAiSpeedMultiplier(usage.model, usage.speed) +
        (usage.webSearchRequests * WEB_SEARCH_MICRO_USD) / 1_000_000,
      pricedBy: "table",
    };
  }
  const table: Readonly<Record<string, ModelPrice>> =
    usage.speed === "standard"
      ? MODEL_PRICES
      : usage.speed === "fast"
        ? FAST_MODEL_PRICES
        : {};
  const older = BEFORE_4_6.has(usage.model);
  const geo = older
    ? 100
    : Object.hasOwn(GEO_PERCENT, usage.inferenceGeo)
      ? GEO_PERCENT[usage.inferenceGeo]
      : undefined;
  const promptTokens =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  const longContext = older && promptTokens > BEFORE_4_6_CONTEXT_TOKENS;
  const longPrompt =
    usage.speed === "standard" && Object.hasOwn(LONG_PROMPT_PRICES, usage.model)
      ? LONG_PROMPT_PRICES[usage.model]
      : undefined;
  const known =
    geo !== undefined && !longContext && Object.hasOwn(table, usage.model)
      ? longPrompt !== undefined && promptTokens > longPrompt.aboveTokens
        ? longPrompt.price
        : table[usage.model]
      : undefined;
  const nonClaude =
    known === undefined && !Object.hasOwn(MODEL_PRICES, usage.model);
  const floor = nonClaude ? openAiFallbackFloor(usage.model) : undefined;
  const rates =
    known ??
    (floor === undefined
      ? FALLBACK_PRICE
      : price(
          Math.max(FALLBACK_PRICE.inputUsdPerMtok, floor.inputUsdPerMtok),
          Math.max(FALLBACK_PRICE.outputUsdPerMtok, floor.outputUsdPerMtok),
          Math.max(
            FALLBACK_PRICE.cacheReadUsdPerMtok,
            floor.cacheReadUsdPerMtok,
          ),
        ));
  const speedMultiplier = nonClaude
    ? openAiFallbackSpeedMultiplier(usage.speed)
    : 1;
  const oneHour = Math.min(
    usage.cacheCreation1hInputTokens,
    usage.cacheCreationInputTokens,
  );
  const perMtok =
    usage.inputTokens * rates.inputUsdPerMtok +
    (usage.cacheCreationInputTokens - oneHour) *
      rates.inputUsdPerMtok *
      (nonClaude ? NON_CLAUDE_SHORT_WRITE : CACHE_WRITE_5M) +
    oneHour *
      rates.inputUsdPerMtok *
      (nonClaude ? NON_CLAUDE_LONG_WRITE : CACHE_WRITE_1H) +
    usage.cacheReadInputTokens * rates.cacheReadUsdPerMtok +
    usage.outputTokens * rates.outputUsdPerMtok;
  return {
    costUsd:
      ((perMtok * speedMultiplier * (geo ?? FALLBACK_GEO_PERCENT)) / 100 +
        usage.webSearchRequests * WEB_SEARCH_MICRO_USD) /
      1_000_000,
    pricedBy: known === undefined ? "fallback" : "table",
  };
}

/**
 * The achievement judge's models, priced apart from any session: Luna
 * charges its input and nothing for its answer (achievement-rules.md §4).
 */
export const JUDGE_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-luna": price(0.1, 0, 0),
};

/** One judgment call; a model the table does not know is priced high. */
export function priceJudgmentUsage(usage: ProviderUsage): {
  costUsd: number;
  pricedBy: "table" | "fallback";
} {
  const known = Object.hasOwn(JUDGE_MODEL_PRICES, usage.model)
    ? JUDGE_MODEL_PRICES[usage.model]
    : undefined;
  const rates = known ?? FALLBACK_PRICE;
  const input =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return {
    costUsd:
      (input * rates.inputUsdPerMtok +
        usage.outputTokens * rates.outputUsdPerMtok) /
      1_000_000,
    pricedBy: known === undefined ? "fallback" : "table",
  };
}
