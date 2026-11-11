/**
 * What an `openai_responses` session is charged per million tokens, by the
 * model the answer names. List prices of the standard tier, text tokens only,
 * from https://developers.openai.com/api/docs/pricing, checked on 2026-11-10.
 * The page gives no date of its own.
 *
 * Not priced: the Pro, cyber, Rosalind, Law and search models (a model
 * missing here falls to the fallback rate, which is the highest the platform
 * knows), the data-residency uplift (the connection's default endpoint is
 * not a regional one), and the fast tier. `gpt-5.6-sol` is listed at its
 * promotional rate until 2026-11-30; the page does not say which of its
 * figures that is, so the table keeps what the page shows and the entry needs
 * a second look then.
 *
 * Cached input is priced by the call's `cache_read_input_tokens`; OpenAI has
 * no cache-write fee. A prompt past 272K input tokens, cached ones included,
 * pays the second rate card on every part of the call.
 */

export type OpenAiRates = {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
};

type Card = { short: OpenAiRates; long?: OpenAiRates };

/** Input at which the long-context rates start: ">272K input tokens". */
export const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

function rates(input: number, cached: number, output: number): OpenAiRates {
  return {
    inputUsdPerMtok: input,
    outputUsdPerMtok: output,
    cacheReadUsdPerMtok: cached,
  };
}

function card(short: OpenAiRates, long?: OpenAiRates): Card {
  return long === undefined ? { short } : { short, long };
}

/** Ids as the page writes them; a dated snapshot is looked up by its base. */
const CARDS: Readonly<Record<string, Card>> = {
  "gpt-6.1-sol": card(rates(2, 0.1, 10), rates(4, 0.2, 15)),
  "gpt-6.1-terra": card(rates(1, 0.05, 5), rates(2, 0.1, 7.5)),
  "gpt-6-luna": card(rates(0.1, 0.01, 0.5), rates(0.2, 0.02, 0.75)),
  "gpt-6-sol": card(rates(2, 0.2, 10), rates(4, 0.4, 15)),
  "gpt-6-astra": card(rates(10, 1, 50), rates(20, 2, 75)),
  "gpt-5.6-sol": card(rates(4, 0.4, 20), rates(8, 0.8, 30)),
  "gpt-5.6-terra": card(rates(2, 0.2, 12), rates(4, 0.4, 18)),
  "gpt-5.6-luna": card(rates(0.2, 0.02, 1.2), rates(0.4, 0.04, 1.8)),
  "gpt-5.5": card(rates(5, 0.5, 30), rates(10, 1, 45)),
  "gpt-5.4": card(rates(2.5, 0.25, 15), rates(5, 0.5, 22.5)),
  "gpt-5.4-mini": card(rates(0.75, 0.075, 4.5)),
  "gpt-5.4-nano": card(rates(0.2, 0.02, 1.25)),
  "gpt-5.3-codex": card(rates(1.75, 0.175, 14)),
  "gpt-5.2": card(rates(1.75, 0.175, 14)),
  "gpt-5.1": card(rates(1.25, 0.125, 10)),
  "gpt-5": card(rates(1.25, 0.125, 10)),
  "gpt-5-mini": card(rates(0.25, 0.025, 2)),
  "gpt-5-nano": card(rates(0.05, 0.005, 0.4)),
};

/** Short and long rates both: the fallback must not undercut a long card. */
export const OPENAI_ALL_RATES: readonly OpenAiRates[] = Object.values(
  CARDS,
).flatMap((entry) =>
  entry.long === undefined ? [entry.short] : [entry.short, entry.long],
);

/**
 * GPT-5.6 and later bill a cache write above the input rate: 1.25x for the
 * default 30 minutes, 2.5x for the 12-hour lifetime. Fast mode doubles every
 * rate of a model that has it; a model that has none is charged the same
 * doubling, which only errs high.
 */
export const OPENAI_CACHE_WRITE_30M = 1.25;
export const OPENAI_CACHE_WRITE_12H = 2.5;
export const OPENAI_FAST_MULTIPLIER = 2;

const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The rates for a call, or undefined for a model not in the table. An answer
 * names the dated snapshot it ran (`gpt-5.5-2026-04-23`), which prices as
 * its base.
 */
export function openAiRatesFor(
  model: string,
  promptTokens: number,
): OpenAiRates | undefined {
  const base = model.replace(DATED_SNAPSHOT, "");
  if (!Object.hasOwn(CARDS, base)) return undefined;
  const entry = CARDS[base];
  if (entry === undefined) return undefined;
  // A model whose long rates the page does not give is priced by the
  // fallback (undefined) past the threshold, not at its short rates.
  return promptTokens > OPENAI_LONG_CONTEXT_TOKENS ? entry.long : entry.short;
}
