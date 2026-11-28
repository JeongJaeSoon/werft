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
 * unknown: its calls have no amount, and no other model's rates stand in.
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
  OPENAI_CACHE_WRITE_12H,
  OPENAI_CACHE_WRITE_30M,
  TOP_SPEED_MULTIPLIER as OPENAI_TOP_SPEED_MULTIPLIER,
  openAiNames,
  openAiRatesFor,
  openAiSpeedMultiplier,
  openAiTierMultiplier,
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

/**
 * A model from before Claude 4.6 (a card without `geo`) has a 200K window,
 * and its card's rates stop there: an answer that used more came from a
 * provider charging a long-context rate the table does not know.
 */
const BEFORE_4_6_CONTEXT_TOKENS = 200_000;

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
 * A call nothing prices: it has no amount, which the ledger stores as 0
 * beside `unknown`. No rate is guessed for it, so no cost limit counts it;
 * a session of such a model is held to a token limit of its own.
 */
const UNPRICED = { costUsd: 0, pricedBy: "unknown" } as const;
/** A model the tables price pays the highest multiplier for a geo none lists. */
const FALLBACK_GEO_PERCENT = Math.max(...Object.values(GEO_PERCENT));

/**
 * For a model the snapshot prices, which neither table names. It may be an
 * OpenAI call, so away from the standard speed every rate is multiplied by
 * the dearest multiple the OpenAI table has for that tier, and a cache write
 * the snapshot does not price costs what the dearer of the two providers
 * charges. A model the Claude table names keeps its own multiples and cache
 * writes.
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
 * none because nothing prices its model (`unknown`), or none because its
 * connection declared `billing: none`. `fallback` is in rows of releases
 * before the snapshot, which charged such a model the highest rates the
 * tables had; no call is given it now.
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
  // a model or prompt length it does not cover is decided below.
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
      ? undefined
      : price(lite.input, lite.output, lite.cacheRead));
  if (rates === undefined) return UNPRICED;
  // Tokens times a rate, in the order the tables' own multiples have always
  // been applied: another order moves a product's last bit, and with it a
  // charge by a micro-dollar.
  const written = (tokens: number, snapshot: number | undefined, of: number) =>
    snapshot === undefined
      ? tokens * rates.inputUsdPerMtok * of
      : tokens * snapshot;
  const speedMultiplier =
    card === undefined
      ? openAiTierMultiplier(usage.speed)
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
    pricedBy: known === undefined ? "litellm" : "table",
  };
}

/**
 * A call's settlement: the dearer of what the model that answered costs and
 * what the model the request asked for would have. An endpoint is free to
 * answer under any name, and one that names a cheap model in place of the
 * one it ran would otherwise settle at the cheap one's rates. When nothing
 * prices either model the call is `unknown` and has no amount: the other
 * model's price is not taken for it.
 */
export function priceSettledUsage(
  usage: ProviderUsage,
  requestModel: string | null,
): { costUsd: number; pricedBy: PriceSource } {
  const answered = priceProviderUsage(usage);
  if (requestModel === null || requestModel === usage.model) return answered;
  const asked = priceProviderUsage({ ...usage, model: requestModel });
  if (asked.pricedBy === "unknown" || answered.pricedBy === "unknown") {
    return UNPRICED;
  }
  return asked.costUsd > answered.costUsd ? asked : answered;
}

/**
 * The achievement judge's models, priced apart from any session: Luna
 * charges its input and nothing for its answer.
 */
export const JUDGE_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-luna": price(0.1, 0, 0),
};

/**
 * One judgment call: the table, then the snapshot's judgment models. A
 * model in neither has no amount.
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
    (lite === undefined ? undefined : price(lite.input, lite.output, 0));
  if (rates === undefined) return UNPRICED;
  const input =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return {
    costUsd:
      (input * rates.inputUsdPerMtok +
        usage.outputTokens * rates.outputUsdPerMtok) /
      1_000_000,
    pricedBy: known === undefined ? "litellm" : "table",
  };
}
