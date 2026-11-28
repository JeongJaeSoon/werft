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
 *
 * A model neither table names is priced from the LiteLLM snapshot
 * (`model-prices-litellm.ts`), and one that is in none of the three is
 * unknown: charged at the highest rates the tables have, with no discount.
 */

import {
  CLAUDE_CACHE_WRITE_1H as CACHE_WRITE_1H,
  CLAUDE_CACHE_WRITE_5M as CACHE_WRITE_5M,
  CLAUDE_CARDS,
  type ClaudeCard,
  CLAUDE_GEO_PERCENT as GEO_PERCENT,
  WEB_SEARCH_MICRO_USD,
} from "./model-prices-claude.ts";
import {
  liteLlmDecisionRatesFor,
  liteLlmRatesFor,
} from "./model-prices-litellm.ts";

export { PRICE_VERSION } from "./model-prices-litellm.ts";

import {
  OPENAI_ALL_RATES,
  OPENAI_CACHE_WRITE_12H,
  OPENAI_CACHE_WRITE_30M,
  TOP_SPEED_MULTIPLIER as OPENAI_TOP_SPEED_MULTIPLIER,
  openAiFallbackFloor,
  openAiFallbackSpeedMultiplier,
  openAiNames,
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
 * A model from before Claude 4.6 (a card without `geo`) has a 200K window,
 * and its card's rates stop there: an answer that used more came from a
 * provider charging a long-context rate the table does not know.
 */
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
 * What a speed multiplies a Claude model's rates by. A tier its card does not
 * list, `fast` without fast mode or a name the page does not use, is charged
 * the highest multiple either table has, as the OpenAI table charges one: a
 * budget errs on counting too much, never too little.
 */
export const CLAUDE_UNLISTED_SPEED_MULTIPLIER = Math.max(
  OPENAI_TOP_SPEED_MULTIPLIER,
  ...CARDS.flatMap(([, card]) => (card.fast === undefined ? [] : [card.fast])),
);

function claudeSpeedMultiplier(card: ClaudeCard, speed: string): number {
  if (speed === "standard") return 1;
  return speed === "fast" && card.fast !== undefined
    ? card.fast
    : CLAUDE_UNLISTED_SPEED_MULTIPLIER;
}

/**
 * A model nothing prices is charged every part at the highest rate either
 * table has, and an unknown geo at the highest multiplier too. A cache read
 * pays the input rate: nothing says its endpoint discounts one. The figure
 * is the limit's, not the provider's bill, which may be higher still: a
 * session of such a model is also held to a token limit of its own.
 */
const UNKNOWN_PRICE: ModelPrice = (() => {
  const prices = [
    ...Object.values(MODEL_PRICES),
    ...Object.values(FAST_MODEL_PRICES),
    ...OPENAI_ALL_RATES,
  ];
  const input = Math.max(...prices.map((known) => known.inputUsdPerMtok));
  return price(
    input,
    Math.max(...prices.map((known) => known.outputUsdPerMtok)),
    input,
  );
})();
const FALLBACK_GEO_PERCENT = Math.max(...Object.values(GEO_PERCENT));

/**
 * For a model the Claude table does not name: one the snapshot prices, one
 * nothing does, or an OpenAI one whose table has no rates for the prompt's
 * length. Any may be an OpenAI call, so away from the standard speed every
 * rate is multiplied by the dearest multiple the OpenAI table has for that
 * tier, and a cache write the snapshot does not price costs what the dearer
 * of the two providers charges. A model the Claude table names keeps its
 * own multiples and cache writes.
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
 * Which rates priced a call: the platform's tables, the LiteLLM snapshot,
 * the highest known ones for a model neither prices (`unknown`), or none,
 * for a connection that declared `billing: none`. `fallback` is what
 * releases before the snapshot wrote for `unknown`; no call is given it now.
 */
export type PricedBy =
  | "table"
  | "litellm"
  | "unknown"
  | "fallback"
  | "unmetered";

/** What prices a metered call today. */
export type PriceSource = "table" | "litellm" | "unknown";

export function priceProviderUsage(usage: ProviderUsage): {
  costUsd: number;
  pricedBy: PriceSource;
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
  const card = Object.hasOwn(CLAUDE_CARDS, usage.model)
    ? CLAUDE_CARDS[usage.model]
    : undefined;
  const nonClaude = card === undefined;
  // A model before Claude 4.6 cannot run with `inference_geo` and always
  // pays the global rates; an unknown geo pays the highest multiplier.
  const older = card?.geo === false;
  const geo = older
    ? 100
    : ((Object.hasOwn(GEO_PERCENT, usage.inferenceGeo)
        ? GEO_PERCENT[usage.inferenceGeo]
        : undefined) ?? FALLBACK_GEO_PERCENT);
  const promptTokens =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  const known =
    card === undefined || (older && promptTokens > BEFORE_4_6_CONTEXT_TOKENS)
      ? undefined
      : card.long !== undefined && promptTokens > card.long.aboveTokens
        ? card.long.rates
        : card.standard;
  const floor = nonClaude ? openAiFallbackFloor(usage.model) : undefined;
  // The snapshot fills in only for a model neither table names: one a table
  // names past its card has outgrown rates the platform checked itself.
  const lite =
    nonClaude && !openAiNames(usage.model)
      ? liteLlmRatesFor(usage.model, promptTokens, {
          short: NON_CLAUDE_SHORT_WRITE,
          long: NON_CLAUDE_LONG_WRITE,
        })
      : undefined;
  const rates =
    known ??
    (lite === undefined
      ? floor === undefined
        ? UNKNOWN_PRICE
        : price(
            Math.max(UNKNOWN_PRICE.inputUsdPerMtok, floor.inputUsdPerMtok),
            Math.max(UNKNOWN_PRICE.outputUsdPerMtok, floor.outputUsdPerMtok),
            Math.max(
              UNKNOWN_PRICE.cacheReadUsdPerMtok,
              floor.cacheReadUsdPerMtok,
            ),
          )
      : price(lite.input, lite.output, lite.cacheRead));
  // Tokens times a rate, in the order the tables' own multiples have always
  // been applied: another order moves a product's last bit, and with it a
  // charge by a micro-dollar.
  const written = (tokens: number, snapshot: number | undefined, of: number) =>
    snapshot === undefined
      ? tokens * rates.inputUsdPerMtok * of
      : tokens * snapshot;
  // Past its window a Claude model keeps its own multiple on the unknown rate.
  const speedMultiplier =
    card === undefined
      ? openAiFallbackSpeedMultiplier(usage.model, usage.speed)
      : claudeSpeedMultiplier(card, usage.speed);
  const oneHour = Math.min(
    usage.cacheCreation1hInputTokens,
    usage.cacheCreationInputTokens,
  );
  const perMtok =
    usage.inputTokens * rates.inputUsdPerMtok +
    written(
      usage.cacheCreationInputTokens - oneHour,
      lite?.cacheWrite,
      nonClaude ? NON_CLAUDE_SHORT_WRITE : CACHE_WRITE_5M,
    ) +
    written(
      oneHour,
      lite?.cacheWriteLong,
      nonClaude ? NON_CLAUDE_LONG_WRITE : CACHE_WRITE_1H,
    ) +
    usage.cacheReadInputTokens * rates.cacheReadUsdPerMtok +
    usage.outputTokens * rates.outputUsdPerMtok;
  return {
    costUsd:
      ((perMtok * speedMultiplier * geo) / 100 +
        usage.webSearchRequests * WEB_SEARCH_MICRO_USD) /
      1_000_000,
    pricedBy:
      known !== undefined
        ? "table"
        : lite === undefined
          ? "unknown"
          : "litellm",
  };
}

/**
 * A call's settlement: the dearer of what the model that answered costs and
 * what the model the request asked for would have. An endpoint is free to
 * answer under any name, and one that names a cheap model in place of the
 * one it ran would otherwise settle at the cheap one's rates. `unknown`
 * says either model is one nothing prices, whichever rates won.
 */
export function priceSettledUsage(
  usage: ProviderUsage,
  requestModel: string | null,
): { costUsd: number; pricedBy: PriceSource; unknown: boolean } {
  const answered = priceProviderUsage(usage);
  if (requestModel === null || requestModel === usage.model) {
    return { ...answered, unknown: answered.pricedBy === "unknown" };
  }
  const asked = priceProviderUsage({ ...usage, model: requestModel });
  return {
    ...(asked.costUsd > answered.costUsd ? asked : answered),
    unknown: asked.pricedBy === "unknown" || answered.pricedBy === "unknown",
  };
}

/**
 * The achievement judge's models, priced apart from any session: Luna
 * charges its input and nothing for its answer.
 */
export const JUDGE_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-luna": price(0.1, 0, 0),
};

/**
 * One judgment call: the table, then the snapshot's judgment models, then
 * the unknown rate.
 */
export function priceJudgmentUsage(usage: ProviderUsage): {
  costUsd: number;
  pricedBy: PriceSource;
} {
  const known = Object.hasOwn(JUDGE_MODEL_PRICES, usage.model)
    ? JUDGE_MODEL_PRICES[usage.model]
    : undefined;
  const lite =
    known === undefined ? liteLlmDecisionRatesFor(usage.model) : undefined;
  const rates =
    known ??
    (lite === undefined ? UNKNOWN_PRICE : price(lite.input, lite.output, 0));
  const input =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return {
    costUsd:
      (input * rates.inputUsdPerMtok +
        usage.outputTokens * rates.outputUsdPerMtok) /
      1_000_000,
    pricedBy:
      known !== undefined
        ? "table"
        : lite === undefined
          ? "unknown"
          : "litellm",
  };
}
