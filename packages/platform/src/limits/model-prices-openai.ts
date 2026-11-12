/**
 * What an `openai_responses` session is charged per million tokens, by the
 * model the answer names. List prices, text tokens only, from
 * https://developers.openai.com/api/docs/pricing; each card carries the day
 * it was last checked against that page. The page gives no date of its own.
 *
 * Not priced: the cyber, Rosalind, Law and search models (a model missing
 * here falls to the fallback rate, which is the highest the platform knows
 * outside the Pro cards) and the data-residency uplift (the connection's
 * default endpoint is not a regional one). `gpt-5.6-sol` is listed at its
 * promotional rate until 2026-11-30; the page does not say which of its
 * figures that is, so the table keeps what the page shows and the entry needs
 * a second look then.
 *
 * Cached input is priced by the call's `cache_read_input_tokens`. A prompt
 * past 272K input tokens, cached ones included, pays the second rate card on
 * every part of the call.
 *
 * The cards are checked against `cardsSchema` when the module loads, so a
 * typo that would undercharge (a negative rate, a long card cheaper than the
 * short one, a tier below 1x) fails the process instead of the bill.
 */

import { z } from "zod";

const usdPerMtok = z.number().finite().nonnegative();

const ratesSchema = z.strictObject({
  inputUsdPerMtok: usdPerMtok,
  outputUsdPerMtok: usdPerMtok,
  cacheReadUsdPerMtok: usdPerMtok,
});

export type OpenAiRates = z.infer<typeof ratesSchema>;

const cardSchema = z
  .strictObject({
    /** The page the rates were read from. */
    source: z.url({ protocol: /^https$/ }),
    /** The day the card was checked against that page. */
    checked: z.iso.date(),
    short: ratesSchema,
    long: ratesSchema.optional(),
    /**
     * A speed tier's tab on the page, as a multiple of the model's standard
     * rates. Every model a tab lists pays one multiple on every part, long
     * context and cache writes included.
     */
    speeds: z.record(
      z.string().refine((name) => name !== "standard"),
      z.number().finite().min(1),
    ),
  })
  .refine(
    ({ short, long }) =>
      long === undefined ||
      (long.inputUsdPerMtok >= short.inputUsdPerMtok &&
        long.outputUsdPerMtok >= short.outputUsdPerMtok &&
        long.cacheReadUsdPerMtok >= short.cacheReadUsdPerMtok),
    { message: "a long-context rate is below its short one" },
  );

export const openAiCardsSchema = z.record(z.string().min(1), cardSchema);
const cardsSchema = openAiCardsSchema;

type Card = z.infer<typeof cardSchema>;
type Speeds = Card["speeds"];

/** Input at which the long-context rates start: ">272K input tokens". */
export const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

function rates(input: number, cached: number, output: number): OpenAiRates {
  return {
    inputUsdPerMtok: input,
    outputUsdPerMtok: output,
    cacheReadUsdPerMtok: cached,
  };
}

const SOURCE = "https://developers.openai.com/api/docs/pricing";
const CHECKED = "2026-11-12";

// The Fast tab doubles most models. `gpt-5-mini` is listed at 1.8x and kept
// at 2x, which only errs high. The tab shows no long-context rates for
// `gpt-5.5` and `gpt-5.4`; their long card is charged the same multiple.
const FAST: Speeds = { fast: 2 };
const ULTRAFAST: Speeds = { fast: 2, ultrafast: 6 };
// The Nano models and the Pro ones are on neither tab.
const STANDARD_ONLY: Speeds = {};

function card(
  short: OpenAiRates,
  long: OpenAiRates | undefined,
  speeds: Speeds,
): Card {
  const entry = { source: SOURCE, checked: CHECKED, short, speeds };
  return long === undefined ? entry : { ...entry, long };
}

/** Ids as the page writes them; a dated snapshot is looked up by its base. */
const CARDS: Readonly<Record<string, Card>> = cardsSchema.parse({
  "gpt-6.1-sol": card(rates(2, 0.1, 10), rates(4, 0.2, 15), ULTRAFAST),
  "gpt-6.1-terra": card(rates(1, 0.05, 5), rates(2, 0.1, 7.5), FAST),
  "gpt-6-luna": card(rates(0.1, 0.01, 0.5), rates(0.2, 0.02, 0.75), FAST),
  "gpt-6-sol": card(rates(2, 0.2, 10), rates(4, 0.4, 15), FAST),
  "gpt-6-astra": card(rates(10, 1, 50), rates(20, 2, 75), ULTRAFAST),
  "gpt-5.6-sol": card(rates(4, 0.4, 20), rates(8, 0.8, 30), FAST),
  "gpt-5.6-terra": card(rates(2, 0.2, 12), rates(4, 0.4, 18), FAST),
  "gpt-5.6-luna": card(rates(0.2, 0.02, 1.2), rates(0.4, 0.04, 1.8), FAST),
  "gpt-5.5": card(rates(5, 0.5, 30), rates(10, 1, 45), { fast: 2.5 }),
  "gpt-5.4": card(rates(2.5, 0.25, 15), rates(5, 0.5, 22.5), FAST),
  "gpt-5.4-mini": card(rates(0.75, 0.075, 4.5), undefined, FAST),
  "gpt-5.4-nano": card(rates(0.2, 0.02, 1.25), undefined, STANDARD_ONLY),
  "gpt-5.3-codex": card(rates(1.75, 0.175, 14), undefined, FAST),
  "gpt-5.2": card(rates(1.75, 0.175, 14), undefined, FAST),
  "gpt-5.1": card(rates(1.25, 0.125, 10), undefined, FAST),
  "gpt-5": card(rates(1.25, 0.125, 10), undefined, FAST),
  "gpt-5-mini": card(rates(0.25, 0.025, 2), undefined, FAST),
  "gpt-5-nano": card(rates(0.05, 0.005, 0.4), undefined, STANDARD_ONLY),
});

/**
 * The Pro models give no cached-input rate, so a cache read pays the input
 * rate. They stay out of the fallback's highest rates: a model no table
 * names is charged the highest non-Pro rate, and only a Pro model past its
 * card is charged the highest Pro one.
 */
const PRO_CARDS: Readonly<Record<string, Card>> = cardsSchema.parse({
  "gpt-5.5-pro": card(rates(30, 30, 180), rates(60, 60, 270), STANDARD_ONLY),
  "gpt-5.4-pro": card(rates(30, 30, 180), rates(60, 60, 270), STANDARD_ONLY),
  "gpt-5.2-pro": card(rates(21, 21, 168), undefined, STANDARD_ONLY),
  "gpt-5-pro": card(rates(15, 15, 120), undefined, STANDARD_ONLY),
  "o3-pro": card(rates(20, 20, 80), undefined, STANDARD_ONLY),
});

/** Every card, for checks that walk the table. */
export const OPENAI_CARDS: Readonly<Record<string, Card>> = {
  ...CARDS,
  ...PRO_CARDS,
};

function allRates(cards: Readonly<Record<string, Card>>): OpenAiRates[] {
  return Object.values(cards).flatMap((entry) =>
    entry.long === undefined ? [entry.short] : [entry.short, entry.long],
  );
}

function highest(all: readonly OpenAiRates[]): OpenAiRates {
  return rates(
    Math.max(...all.map((known) => known.inputUsdPerMtok)),
    Math.max(...all.map((known) => known.cacheReadUsdPerMtok)),
    Math.max(...all.map((known) => known.outputUsdPerMtok)),
  );
}

/** Short and long rates both: the fallback must not undercut a long card. */
export const OPENAI_ALL_RATES: readonly OpenAiRates[] = allRates(CARDS);

const PRO_HIGHEST = highest(allRates(PRO_CARDS));

/**
 * GPT-5.6 and later bill a cache write above the input rate: 1.25x for the
 * default 30 minutes, 2.5x for the 12-hour lifetime. A model whose card
 * shows no write rate is charged the same, which only errs high.
 */
export const OPENAI_CACHE_WRITE_30M = 1.25;
export const OPENAI_CACHE_WRITE_12H = 2.5;

/**
 * The highest multiple any card has for any tier: what a tier the model's
 * card does not list is charged, whatever its name. A tier the page adds
 * later must not be priced below the dearest one the table knows.
 */
export const TOP_SPEED_MULTIPLIER = Math.max(
  ...Object.values(OPENAI_CARDS).flatMap((entry) =>
    Object.values(entry.speeds),
  ),
);

const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

function cardFor(model: string): Card | undefined {
  const base = model.replace(DATED_SNAPSHOT, "");
  return Object.hasOwn(OPENAI_CARDS, base) ? OPENAI_CARDS[base] : undefined;
}

/**
 * The rates for a call, or undefined for a model not in the table. An answer
 * names the dated snapshot it ran (`gpt-5.5-2026-04-23`), which prices as
 * its base.
 */
export function openAiRatesFor(
  model: string,
  promptTokens: number,
): OpenAiRates | undefined {
  const entry = cardFor(model);
  if (entry === undefined) return undefined;
  // A model whose long rates the page does not give is priced by the
  // fallback (undefined) past the threshold, not at its short rates.
  return promptTokens > OPENAI_LONG_CONTEXT_TOKENS ? entry.long : entry.short;
}

/** What a model the table names multiplies its rates by at `speed`. */
export function openAiSpeedMultiplier(model: string, speed: string): number {
  if (speed === "standard") return 1;
  const speeds = cardFor(model)?.speeds ?? {};
  return Object.hasOwn(speeds, speed)
    ? (speeds[speed] ?? TOP_SPEED_MULTIPLIER)
    : TOP_SPEED_MULTIPLIER;
}

/**
 * What the fallback multiplies its rates by at `speed` for a model that may
 * be an OpenAI one: the highest multiple any card has for that tier, or the
 * highest of any tier for one no card lists. A model the table names but
 * prices past its card keeps its own multiple if that is higher, so a longer
 * prompt never costs less.
 */
export function openAiFallbackSpeedMultiplier(
  model: string,
  speed: string,
): number {
  if (speed === "standard") return 1;
  const listed = Object.values(OPENAI_CARDS).flatMap((entry) =>
    Object.hasOwn(entry.speeds, speed) ? [entry.speeds[speed] ?? 0] : [],
  );
  const tier = listed.length === 0 ? TOP_SPEED_MULTIPLIER : Math.max(...listed);
  return cardFor(model) === undefined
    ? tier
    : Math.max(tier, openAiSpeedMultiplier(model, speed));
}

/**
 * The rates the fallback must not undercut for `model`: the highest Pro
 * rates for a Pro model past its card, none otherwise.
 */
export function openAiFallbackFloor(model: string): OpenAiRates | undefined {
  const base = model.replace(DATED_SNAPSHOT, "");
  return Object.hasOwn(PRO_CARDS, base) ? PRO_HIGHEST : undefined;
}
