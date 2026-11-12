/**
 * Compares werft's OpenAI price table (packages/platform/src/limits/
 * model-prices-openai.ts) with LiteLLM's price data and reports where they
 * differ. It only reports: the table is changed by a person who checks the
 * official page, never from this data.
 *
 * Data source: `model_prices_and_context_window.json` in
 * https://github.com/BerriAI/litellm, read at one commit whose SHA the report
 * records (`--sha`, or the file's latest commit on `main`). LiteLLM is MIT
 * licensed outside its `enterprise/` directory, Copyright (c) 2023 Berri AI
 * (https://github.com/BerriAI/litellm/blob/main/LICENSE). The data is fetched
 * at run time and not stored in this repository; the tests use figures from
 * werft's own table.
 *
 * usage: bun .github/scripts/litellm-price-drift.ts [--sha <40-hex>] [--out <file>]
 * exit:  0 no drift, 1 drift (report written), 2 the data could not be read
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  OPENAI_CARDS,
  type OpenAiRates,
  openAiSpeedMultiplier,
} from "../../packages/platform/src/limits/model-prices-openai.ts";

const REPO = "BerriAI/litellm";
const PATH = "model_prices_and_context_window.json";
const MAX_BYTES = 64 * 1024 * 1024;

const sha = z.string().regex(/^[0-9a-f]{40}$/);

/** The token rates werft prices, by LiteLLM's name for them. */
const PARTS: Readonly<Record<string, keyof OpenAiRates>> = {
  input_cost_per_token: "inputUsdPerMtok",
  output_cost_per_token: "outputUsdPerMtok",
  cache_read_input_token_cost: "cacheReadUsdPerMtok",
  // A cache write is a multiple of the input rate.
  cache_creation_input_token_cost: "inputUsdPerMtok",
};
const PART_NAMES = Object.keys(PARTS);

/** A rate field: its part, then a 12-hour write, long context and a tier. */
const RATE_KEY =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(_above_12hr)?(_above_272k_tokens)?(?:_([a-z]+))?$/;

const perToken = z.number().finite().nonnegative();

/** Every rate field of an entry werft prices must be a rate. */
const entrySchema = z
  .record(z.string(), z.unknown())
  .superRefine((entry, ctx) => {
    for (const [key, value] of Object.entries(entry)) {
      if (
        PART_NAMES.some((part) => key.startsWith(part)) &&
        !perToken.safeParse(value).success
      ) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "not a non-negative number",
        });
      }
    }
  });

type Entry = z.infer<typeof entrySchema>;

/** Only the entries werft prices are validated; the rest are not read. */
export function parseLiteLlm(raw: unknown): Record<string, Entry> {
  const all = z.record(z.string(), z.unknown()).parse(raw);
  const entries: Record<string, Entry> = {};
  for (const model of Object.keys(OPENAI_CARDS)) {
    if (!Object.hasOwn(all, model)) continue;
    const parsed = entrySchema.safeParse(all[model]);
    if (!parsed.success) {
      throw new Error(
        `LiteLLM entry ${model} is not in the expected shape: ${z.prettifyError(parsed.error)}`,
      );
    }
    entries[model] = parsed.data;
  }
  return entries;
}

/** LiteLLM's tier suffix for werft's `fast`; other tiers share the name. */
const LITELLM_FAST = "priority";
/** LiteLLM tiers that are not a speed: a different service, not priced here. */
const NOT_SPEEDS = new Set(["batches", "flex"]);

/**
 * Differences werft keeps on purpose, keyed `<model> <tier>`. Each one only
 * hides a difference where werft charges more; a LiteLLM rate above werft's
 * is always reported.
 */
export const KNOWN: Readonly<Record<string, string>> = {
  "gpt-5-mini fast":
    "the page lists 1.8x; werft keeps 2x, which errs high (94S-1545)",
  "gpt-6-luna decisions":
    "not on the pricing page (checked 2026-11-12); werft charges a tier its card does not list 6x, which errs high",
};

export type Drift = {
  model: string;
  tier: string;
  detail: string;
  /** LiteLLM's rate is above werft's, or the rate cannot be compared. */
  undercharges: boolean;
};

const CACHE_WRITE_30M = 1.25;
const CACHE_WRITE_12H = 2.5;

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

function perMtok(value: number): string {
  return `$${Number((value * 1_000_000).toPrecision(12))}`;
}

function suffixOf(tier: string): string {
  if (tier === "standard") return "";
  return `_${tier === "fast" ? LITELLM_FAST : tier}`;
}

export function compare(litellm: Record<string, Entry>): Drift[] {
  const drift: Drift[] = [];
  const report = (
    model: string,
    tier: string,
    detail: string,
    undercharges: boolean,
  ) => {
    if (undercharges || !Object.hasOwn(KNOWN, `${model} ${tier}`)) {
      drift.push({ model, tier, detail, undercharges });
    }
  };
  for (const [model, card] of Object.entries(OPENAI_CARDS)) {
    const entry = litellm[model];
    if (entry === undefined) {
      report(model, "standard", "LiteLLM has no entry for this model", false);
      continue;
    }
    // Every rate LiteLLM gives, against what werft charges for it.
    for (const [key, theirs] of Object.entries(entry)) {
      // parseLiteLlm has made every such field a number.
      if (
        typeof theirs !== "number" ||
        !PART_NAMES.some((part) => key.startsWith(part))
      ) {
        continue;
      }
      const match = RATE_KEY.exec(key);
      const [, part, twelveHours, long, suffix] = match ?? [];
      if (
        part === undefined ||
        (twelveHours !== undefined &&
          part !== "cache_creation_input_token_cost")
      ) {
        report(
          model,
          "standard",
          `\`${key}\` is a rate this check does not know`,
          true,
        );
        continue;
      }
      if (suffix !== undefined && NOT_SPEEDS.has(suffix)) continue;
      const tier =
        suffix === undefined
          ? "standard"
          : suffix === LITELLM_FAST
            ? "fast"
            : suffix;
      const rates = long === undefined ? card.short : card.long;
      // A length the card has no rates for is priced by the fallback, which
      // is at least the highest card of its kind.
      if (rates === undefined) continue;
      const rate = PARTS[part];
      if (rate === undefined) continue;
      const write =
        part === "cache_creation_input_token_cost"
          ? twelveHours === undefined
            ? CACHE_WRITE_30M
            : CACHE_WRITE_12H
          : 1;
      const ours =
        (rates[rate] * write * openAiSpeedMultiplier(model, tier)) / 1e6;
      if (!same(theirs, ours)) {
        const unlisted =
          Object.hasOwn(card.speeds, tier) || tier === "standard"
            ? ""
            : " (the card does not list this tier; werft charges its highest multiple)";
        report(
          model,
          tier,
          `\`${key}\`: LiteLLM ${perMtok(theirs)}, werft ${perMtok(ours)}${unlisted}`,
          theirs > ours,
        );
      }
    }
    // Rates werft charges that LiteLLM does not give.
    for (const tier of ["standard", ...Object.keys(card.speeds)]) {
      for (const part of [
        "input_cost_per_token",
        "output_cost_per_token",
        "cache_read_input_token_cost",
      ]) {
        const lengths: [string, OpenAiRates | undefined][] = [
          ["", card.short],
          // The page shows no long rates for some fast tiers.
          ...(tier === "standard"
            ? [
                ["_above_272k_tokens", card.long] as [
                  string,
                  OpenAiRates | undefined,
                ],
              ]
            : []),
        ];
        for (const [length, rates] of lengths) {
          if (rates === undefined) continue;
          // A Pro card prices a cache read at the input rate because the
          // page gives none; LiteLLM leaves the field out for that reason.
          if (
            part === "cache_read_input_token_cost" &&
            rates.cacheReadUsdPerMtok === rates.inputUsdPerMtok
          ) {
            continue;
          }
          const key = `${part}${length}${suffixOf(tier)}`;
          if (!Object.hasOwn(entry, key)) {
            report(model, tier, `LiteLLM has no \`${key}\``, false);
          }
        }
      }
    }
  }
  return drift;
}

export function render(commit: string, drift: Drift[]): string {
  const source = `https://github.com/${REPO}/blob/${commit}/${PATH}`;
  const lines = [
    `werft's OpenAI price table compared with LiteLLM's [\`${PATH}\`](${source}) at \`${commit}\`.`,
    "",
  ];
  if (drift.length === 0) {
    lines.push("No differences outside the known ones.");
  } else {
    lines.push(
      "Check each row against https://developers.openai.com/api/docs/pricing before changing the table; LiteLLM can be wrong or late. A row marked **werft lower** may undercharge. A difference werft keeps on purpose, where werft charges more, goes in `KNOWN` in `.github/scripts/litellm-price-drift.ts`.",
      "",
      "| Model | Tier | Difference | werft lower |",
      "|---|---|---|---|",
      ...drift.map(
        (d) =>
          `| \`${d.model}\` | ${d.tier} | ${d.detail} | ${d.undercharges ? "**yes**" : "no"} |`,
      ),
    );
  }
  lines.push(
    "",
    `LiteLLM data: MIT, Copyright (c) 2023 Berri AI (https://github.com/${REPO}/blob/${commit}/LICENSE).`,
  );
  return `${lines.join("\n")}\n`;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "werft-price-drift" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BYTES)
    throw new Error(`${url}: over ${MAX_BYTES} bytes`);
  return text;
}

async function latestCommit(): Promise<string> {
  const commits = z
    .array(z.looseObject({ sha }))
    .min(1)
    .parse(
      JSON.parse(
        await getText(
          `https://api.github.com/repos/${REPO}/commits?path=${PATH}&per_page=1`,
        ),
      ),
    );
  return commits[0]?.sha ?? "";
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { sha: { type: "string" }, out: { type: "string" } },
  });
  try {
    const commit = sha.parse(values.sha ?? (await latestCommit()));
    const raw: unknown = JSON.parse(
      await getText(
        `https://raw.githubusercontent.com/${REPO}/${commit}/${PATH}`,
      ),
    );
    const drift = compare(parseLiteLlm(raw));
    const text = render(commit, drift);
    if (values.out !== undefined) writeFileSync(values.out, text);
    process.stdout.write(text);
    process.exit(drift.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
