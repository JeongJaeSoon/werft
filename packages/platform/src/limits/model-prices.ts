/**
 * What the platform charges a session for one Messages call: the
 * provider's list price per million tokens, by the model the answer names.
 * The platform owns the tables and updates them with its releases, when a
 * model is added or a price changes.
 *
 * A Claude model is priced from `model-prices-claude.ts`: fast mode has its
 * own rates, and each web search adds its per-search fee. US-only inference
 * costs 1.1x on every token rate. An estimate, not a bill: code execution
 * container time is not priced.
 *
 * An OpenAI model, which an `openai_responses` session calls, is priced from
 * `model-prices-openai.ts`.
 */

import {
  CLAUDE_CACHE_WRITE_1H as CACHE_WRITE_1H,
  CLAUDE_CACHE_WRITE_5M as CACHE_WRITE_5M,
  CLAUDE_CARDS,
  CLAUDE_GEO_PERCENT as GEO_PERCENT,
  WEB_SEARCH_MICRO_USD,
} from "./model-prices-claude.ts";
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

function price(input: number, output: number, cacheRead: number): ModelPrice {
  return {
    inputUsdPerMtok: input,
    outputUsdPerMtok: output,
    cacheReadUsdPerMtok: cacheRead,
  };
}

const CARDS = Object.entries(CLAUDE_CARDS);

/** Exact model ids as an answer names them, aliases and dated ids both. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> =
  Object.fromEntries(CARDS.map(([model, card]) => [model, card.standard]));

/**
 * Models with a second rate card for a long prompt: past `aboveTokens` of
 * input, cache included, every part of the call pays `price`.
 */
const LONG_PROMPT_PRICES: Readonly<
  Record<string, { aboveTokens: number; price: ModelPrice }>
> = Object.fromEntries(
  CARDS.flatMap(([model, card]) =>
    card.long === undefined
      ? []
      : [
          [
            model,
            { aboveTokens: card.long.aboveTokens, price: card.long.rates },
          ],
        ],
  ),
);

/**
 * Models from before Claude 4.6. They cannot run with `inference_geo` and
 * always pay the standard rates. Their window is 200K tokens and the table's
 * rates stop there: an answer that used more came from a provider charging
 * a long-context rate the table does not know.
 */
const BEFORE_4_6: ReadonlySet<string> = new Set(
  CARDS.filter(([, card]) => !card.geo).map(([model]) => model),
);
const BEFORE_4_6_CONTEXT_TOKENS = 200_000;

/** `speed: "fast"` rates, a multiple of the standard ones for the models offering it. */
export const FAST_MODEL_PRICES: Readonly<Record<string, ModelPrice>> =
  Object.fromEntries(
    CARDS.flatMap(([model, { standard, fast }]) =>
      fast === undefined
        ? []
        : [
            [
              model,
              price(
                standard.inputUsdPerMtok * fast,
                standard.outputUsdPerMtok * fast,
                standard.cacheReadUsdPerMtok * fast,
              ),
            ],
          ],
    ),
  );

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
    ? openAiFallbackSpeedMultiplier(usage.model, usage.speed)
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
