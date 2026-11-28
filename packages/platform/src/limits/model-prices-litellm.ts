/**
 * Rates for a model the platform's own tables do not name, read from the
 * LiteLLM snapshot in `model-prices-litellm.gen.ts`. The snapshot is part of
 * the release: nothing is fetched at run time, and
 * `scripts/update-litellm-prices.ts` is the only writer of that file.
 *
 * The rows are checked when the module loads, so a snapshot that would
 * undercharge (a rate that is not a finite number, an input or output rate
 * of zero) fails the process instead of the bill.
 */

import {
  LITELLM_DECISION_RATES,
  LITELLM_SNAPSHOT,
  LITELLM_TOKEN_RATES,
} from "./model-prices-litellm.gen.ts";

/** USD per million tokens. In the snapshot's rows 0 is a part it does not price. */
export type LiteLlmRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteLong: number;
};

type Entry = LiteLlmRates & {
  /** Rates past a prompt length, shortest first. */
  tiers: readonly (LiteLlmRates & { aboveTokens: number })[];
};

/** What a cache write costs as a multiple of input where no rate is given. */
export type WriteMultiples = { short: number; long: number };

/**
 * Which price data priced a call: the snapshot's upstream commit and the
 * version of the rules that read it. Kept with each call, so a reserve and
 * its settlement priced by different releases can be told apart.
 */
export const PRICE_VERSION = `litellm@${LITELLM_SNAPSHOT.commit}/r${LITELLM_SNAPSHOT.rules}`;

const PARTS = 5;

function ratesOf(model: string, numbers: readonly number[]): LiteLlmRates {
  for (const rate of numbers) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`LiteLLM snapshot: ${model} has a rate that is not one`);
    }
  }
  const [input = 0, output = 0, cacheRead = 0, cacheWrite = 0, long = 0] =
    numbers;
  return { input, output, cacheRead, cacheWrite, cacheWriteLong: long };
}

function entryOf([model, ...numbers]: readonly [string, ...number[]]): Entry {
  const base = ratesOf(model, numbers.slice(0, PARTS));
  if (!(base.input > 0 && base.output > 0)) {
    throw new Error(`LiteLLM snapshot: ${model} has no input or output rate`);
  }
  const tiers: Entry["tiers"][number][] = [];
  for (let at = PARTS; at < numbers.length; at += PARTS + 1) {
    const aboveTokens = numbers[at] ?? 0;
    const last = tiers.at(-1)?.aboveTokens ?? 0;
    if (!Number.isSafeInteger(aboveTokens) || aboveTokens <= last) {
      throw new Error(`LiteLLM snapshot: ${model} has tiers out of order`);
    }
    tiers.push({
      aboveTokens,
      ...ratesOf(model, numbers.slice(at + 1, at + 1 + PARTS)),
    });
  }
  return { ...base, tiers };
}

/**
 * An entry's rates for a prompt, every part filled. A tier's part is never
 * below the base's. A part the snapshot does not price is charged from the
 * input rate, with no discount: a cache read at the input rate, a cache
 * write at the caller's multiple of it.
 */
function at(
  entry: Entry,
  promptTokens: number,
  writes: WriteMultiples,
): LiteLlmRates {
  let given: LiteLlmRates = entry;
  for (const tier of entry.tiers) {
    if (promptTokens > tier.aboveTokens) given = tier;
  }
  const filled = (part: keyof LiteLlmRates, otherwise: number) =>
    given[part] > 0 ? Math.max(given[part], entry[part]) : otherwise;
  const input = Math.max(given.input, entry.input);
  const cacheWrite = filled("cacheWrite", input * writes.short);
  return {
    input,
    output: Math.max(given.output, entry.output),
    cacheRead: filled("cacheRead", input),
    cacheWrite,
    cacheWriteLong: Math.max(
      cacheWrite,
      filled("cacheWriteLong", input * writes.long),
    ),
  };
}

/** The lookups over one snapshot's rows; the module's own are over the file's. */
export function liteLlmPrices(
  tokenRows: readonly (readonly [string, ...number[]])[],
  decisionRows: readonly (readonly [string, number, number])[],
) {
  const byName = new Map<string, Entry>();
  // Entries by the name after their provider prefix (`azure/gpt-4o`).
  const byBareName = new Map<string, Entry[]>();
  for (const row of tokenRows) {
    const [name] = row;
    const entry = entryOf(row);
    byName.set(name, entry);
    const slash = name.lastIndexOf("/");
    if (slash >= 0) {
      const bare = name.slice(slash + 1);
      byBareName.set(bare, [...(byBareName.get(bare) ?? []), entry]);
    }
  }
  const decisions = new Map<string, { input: number; output: number }>();
  for (const [model, ...numbers] of decisionRows) {
    const { input, output } = ratesOf(model, numbers);
    // A judgment model may charge nothing for its answer, never for its input.
    if (!(input > 0)) {
      throw new Error(`LiteLLM snapshot: ${model} has no input rate`);
    }
    decisions.set(model, { input, output });
  }
  return {
    /**
     * The rates for `model` at a prompt length. The name itself is looked up
     * first. Without one, every entry that carries it behind a provider
     * prefix counts, and each part is charged at the dearest of them: the
     * same bare name can be another provider's other model, and a budget
     * errs on counting too much.
     */
    ratesFor(
      model: string,
      promptTokens: number,
      writes: WriteMultiples,
    ): LiteLlmRates | undefined {
      const named = byName.get(model);
      const entries = named === undefined ? byBareName.get(model) : [named];
      return entries
        ?.map((entry) => at(entry, promptTokens, writes))
        .reduce((most, rates) => ({
          input: Math.max(most.input, rates.input),
          output: Math.max(most.output, rates.output),
          cacheRead: Math.max(most.cacheRead, rates.cacheRead),
          cacheWrite: Math.max(most.cacheWrite, rates.cacheWrite),
          cacheWriteLong: Math.max(most.cacheWriteLong, rates.cacheWriteLong),
        }));
    },
    /** A judgment model's rates, by its exact name only. */
    decisionRatesFor(
      model: string,
    ): { input: number; output: number } | undefined {
      return decisions.get(model);
    },
  };
}

export const {
  ratesFor: liteLlmRatesFor,
  decisionRatesFor: liteLlmDecisionRatesFor,
} = liteLlmPrices(LITELLM_TOKEN_RATES, LITELLM_DECISION_RATES);
