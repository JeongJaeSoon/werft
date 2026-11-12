/**
 * What a Claude session is charged per million tokens, by the model id the
 * answer names, aliases and dated ids both. List prices from
 * https://platform.claude.com/docs/en/about-claude/pricing; each card carries
 * the day it was last checked against that page. The page gives no date of
 * its own.
 *
 * The cards are checked against `claudeCardsSchema` when the module loads, so
 * a typo that would undercharge (a negative rate, a long card cheaper than
 * the standard one, a fast multiple below 1x) fails the process instead of
 * the bill.
 */

import { z } from "zod";

// The page prices no Claude token part at zero.
const usdPerMtok = z.number().finite().positive();

const ratesSchema = z.strictObject({
  inputUsdPerMtok: usdPerMtok,
  outputUsdPerMtok: usdPerMtok,
  cacheReadUsdPerMtok: usdPerMtok,
});

export type ClaudeRates = z.infer<typeof ratesSchema>;

const cardSchema = z
  .strictObject({
    /** The page the rates were read from. */
    source: z.url({ protocol: /^https$/ }),
    /** The day the card was checked against that page. */
    checked: z.iso.date(),
    standard: ratesSchema,
    /** Past `aboveTokens` of input, cache included, every part pays `rates`. */
    long: z
      .strictObject({
        aboveTokens: z.number().int().positive(),
        rates: ratesSchema,
      })
      .optional(),
    /**
     * `speed: "fast"` as a multiple of the standard rates, on every part.
     * Fast mode is premium pricing; the weekly LiteLLM check compares the
     * multiple itself.
     */
    fast: z.number().finite().gt(1).optional(),
    /**
     * Claude 4.6 and later: `inference_geo` multiplies every rate, and the
     * rates hold across the whole window. A model before them always pays
     * the global rates, and its rates stop at its 200K window.
     */
    geo: z.boolean(),
  })
  .refine(
    ({ standard, long }) =>
      long === undefined ||
      (long.rates.inputUsdPerMtok >= standard.inputUsdPerMtok &&
        long.rates.outputUsdPerMtok >= standard.outputUsdPerMtok &&
        long.rates.cacheReadUsdPerMtok >= standard.cacheReadUsdPerMtok),
    { message: "a long-prompt rate is below its standard one" },
  )
  // A fast call is priced at its fast rates whatever its length.
  .refine(({ long, fast }) => long === undefined || fast === undefined, {
    message: "a card with long-prompt rates cannot have a fast multiple",
  });

export const claudeCardsSchema = z.record(z.string().min(1), cardSchema);

type Card = z.infer<typeof cardSchema>;

/**
 * Cache writes cost a multiple of the input rate: 1.25x held five minutes,
 * 2x held an hour.
 */
export const CLAUDE_CACHE_WRITE_5M = 1.25;
export const CLAUDE_CACHE_WRITE_1H = 2;

/**
 * What `inference_geo` multiplies every token rate by, cache ones included,
 * in percent: a whole micro-dollar figure stays whole, where times 1.1 it
 * would pick up float noise that the ledger's ceil turns into a micro-dollar.
 */
export const CLAUDE_GEO_PERCENT: Readonly<Record<string, number>> = {
  global: 100,
  us: 110,
};

/**
 * $10 per 1,000 searches, in millionths of a dollar like a token count
 * times its per-million rate. Web fetch has no fee beyond its tokens.
 */
export const WEB_SEARCH_MICRO_USD = 10_000;

function rates(input: number, output: number, cacheRead: number): ClaudeRates {
  return {
    inputUsdPerMtok: input,
    outputUsdPerMtok: output,
    cacheReadUsdPerMtok: cacheRead,
  };
}

const SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const CHECKED = "2026-11-13";

type Options = { fast?: number; long?: Card["long"]; geo?: boolean };

const FAST: Options = { fast: 2 };
const BEFORE_4_6: Options = { geo: false };

function card(standard: ClaudeRates, options: Options = {}): Card {
  return {
    source: SOURCE,
    checked: CHECKED,
    standard,
    geo: options.geo ?? true,
    ...(options.fast === undefined ? {} : { fast: options.fast }),
    ...(options.long === undefined ? {} : { long: options.long }),
  };
}

const FABLE_5_2 = rates(8, 40, 0.2);
const FABLE_5_1 = rates(10, 50, 0.25);
const FABLE_5 = rates(10, 50, 1);
const OPUS_5_5 = rates(4, 20, 0.2);
const OPUS_5 = rates(5, 25, 0.5);
const OPUS_4 = rates(15, 75, 1.5);
const SONNET_5_5 = rates(2, 10, 0.1);
const SONNET_5 = rates(2, 10, 0.2);
const SONNET_4 = rates(3, 15, 0.3);
const HAIKU_5_5 = rates(0.1, 0.5, 0.01);
const HAIKU_4_5 = rates(1, 5, 0.1);

/** Every model id the Claude table prices. */
export const CLAUDE_CARDS: Readonly<Record<string, Card>> =
  claudeCardsSchema.parse({
    "claude-fable-5-2": card(FABLE_5_2, FAST),
    "claude-mythos-5-2": card(FABLE_5_2, FAST),
    "claude-fable-5-1": card(FABLE_5_1),
    "claude-mythos-5-1": card(FABLE_5_1),
    "claude-fable-5": card(FABLE_5),
    "claude-mythos-5": card(FABLE_5),
    "claude-opus-5-5": card(OPUS_5_5, FAST),
    "claude-opus-5": card(OPUS_5, FAST),
    "claude-opus-4-8": card(OPUS_5, FAST),
    "claude-opus-4-7": card(OPUS_5),
    "claude-opus-4-6": card(OPUS_5),
    "claude-opus-4-5": card(OPUS_5, BEFORE_4_6),
    "claude-opus-4-5-20251101": card(OPUS_5, BEFORE_4_6),
    "claude-opus-4-0": card(OPUS_4, BEFORE_4_6),
    "claude-opus-4-20250514": card(OPUS_4, BEFORE_4_6),
    "claude-sonnet-5-5": card(SONNET_5_5),
    "claude-sonnet-5": card(SONNET_5),
    "claude-sonnet-4-6": card(SONNET_4),
    "claude-sonnet-4-5": card(SONNET_4, BEFORE_4_6),
    "claude-sonnet-4-5-20250929": card(SONNET_4, BEFORE_4_6),
    "claude-sonnet-4-0": card(SONNET_4, BEFORE_4_6),
    "claude-sonnet-4-20250514": card(SONNET_4, BEFORE_4_6),
    "claude-haiku-5-5": card(HAIKU_5_5, {
      long: { aboveTokens: 100_000, rates: rates(0.5, 2.5, 0.05) },
    }),
    "claude-haiku-4-5": card(HAIKU_4_5, BEFORE_4_6),
    "claude-haiku-4-5-20251001": card(HAIKU_4_5, BEFORE_4_6),
  });
