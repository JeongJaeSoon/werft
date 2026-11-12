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
import { OPENAI_CARDS } from "../../packages/platform/src/limits/model-prices-openai.ts";

const REPO = "BerriAI/litellm";
const PATH = "model_prices_and_context_window.json";
const MAX_BYTES = 64 * 1024 * 1024;

const sha = z.string().regex(/^[0-9a-f]{40}$/);

const perToken = z.number().finite().nonnegative();

/** The fields this check reads; LiteLLM's other fields pass through unread. */
const entrySchema = z.looseObject({
  input_cost_per_token: perToken.optional(),
  output_cost_per_token: perToken.optional(),
  cache_read_input_token_cost: perToken.optional(),
  cache_creation_input_token_cost: perToken.optional(),
  cache_creation_input_token_cost_above_12hr: perToken.optional(),
});

/** Only the entries werft prices are validated; the rest stay unknown. */
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

type Entry = z.infer<typeof entrySchema>;

/** werft's speed tier names as LiteLLM suffixes its fields. */
const TIER_SUFFIX: Readonly<Record<string, string>> = {
  fast: "_priority",
  ultrafast: "_ultrafast",
};
/** LiteLLM tiers that are not a speed: a different service, not priced here. */
const NOT_SPEEDS = new Set(["batches", "flex"]);

/** Differences werft keeps on purpose. Keyed `<model> <field>`. */
export const KNOWN: Readonly<Record<string, string>> = {
  "gpt-5-mini fast":
    "the page lists 1.8x; werft keeps 2x, which errs high (94S-1545)",
  "gpt-6-luna decisions":
    "not on the pricing page (checked 2026-11-12); werft charges a tier its card does not list 6x, which errs high",
};

export type Drift = { model: string; field: string; detail: string };

const CACHE_WRITE_30M = 1.25;
const CACHE_WRITE_12H = 2.5;

function numberAt(entry: Entry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" ? value : undefined;
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

function perMtok(value: number): string {
  return `$${Number((value * 1_000_000).toPrecision(12))}`;
}

const PARTS = [
  ["input_cost_per_token", "inputUsdPerMtok"],
  ["cache_read_input_token_cost", "cacheReadUsdPerMtok"],
  ["output_cost_per_token", "outputUsdPerMtok"],
] as const;

export function compare(litellm: Record<string, Entry>): Drift[] {
  const drift: Drift[] = [];
  const report = (model: string, field: string, detail: string) => {
    if (!Object.hasOwn(KNOWN, `${model} ${field}`)) {
      drift.push({ model, field, detail });
    }
  };
  for (const [model, card] of Object.entries(OPENAI_CARDS)) {
    const entry = litellm[model];
    if (entry === undefined) {
      report(model, "entry", "LiteLLM has no entry for this model");
      continue;
    }
    const check = (key: string, ours: number, field: string) => {
      const theirs = numberAt(entry, key);
      if (theirs === undefined) {
        // A Pro card prices a cache read at the input rate because the page
        // gives none; LiteLLM leaves the field out for the same reason.
        if (
          key.startsWith("cache_read_") &&
          ours * 1_000_000 ===
            (key.includes("272k")
              ? card.long?.inputUsdPerMtok
              : card.short.inputUsdPerMtok)
        ) {
          return;
        }
        report(
          model,
          field,
          `LiteLLM has no \`${key}\`; werft ${perMtok(ours)}`,
        );
      } else if (!same(theirs, ours)) {
        report(
          model,
          field,
          `\`${key}\`: LiteLLM ${perMtok(theirs)}, werft ${perMtok(ours)}`,
        );
      }
    };
    const tiers: [string, number, string][] = [
      ["standard", 1, ""],
      ...Object.entries(card.speeds).map(
        ([tier, multiple]): [string, number, string] => [
          tier,
          multiple,
          TIER_SUFFIX[tier] ?? `_${tier}`,
        ],
      ),
    ];
    for (const [tier, multiple, suffix] of tiers) {
      for (const [key, part] of PARTS) {
        check(`${key}${suffix}`, (card.short[part] * multiple) / 1e6, tier);
        if (card.long === undefined) continue;
        const longKey =
          key === "cache_read_input_token_cost"
            ? `${key}_above_272k_tokens${suffix}`
            : `${key.replace("_per_token", "_per_token_above_272k_tokens")}${suffix}`;
        // The page shows no long rates for some fast tiers; werft charges
        // the long card times the multiple there, which only errs high.
        if (tier !== "standard" && numberAt(entry, longKey) === undefined) {
          continue;
        }
        check(longKey, (card.long[part] * multiple) / 1e6, tier);
      }
    }
    // werft charges every model 1.25x / 2.5x of input for a cache write.
    for (const [key, factor] of [
      ["cache_creation_input_token_cost", CACHE_WRITE_30M],
      ["cache_creation_input_token_cost_above_12hr", CACHE_WRITE_12H],
    ] as const) {
      const theirs = numberAt(entry, key);
      const ours = (card.short.inputUsdPerMtok * factor) / 1e6;
      if (theirs !== undefined && !same(theirs, ours)) {
        report(
          model,
          "cache write",
          `\`${key}\`: LiteLLM ${perMtok(theirs)}, werft ${perMtok(ours)}`,
        );
      }
    }
    // A tier LiteLLM prices that the card does not list: werft charges it
    // the highest multiple, which errs high, but the card may be stale.
    for (const key of Object.keys(entry)) {
      const tier = /^input_cost_per_token_([a-z]+)$/.exec(key)?.[1];
      if (tier === undefined || NOT_SPEEDS.has(tier)) continue;
      const name =
        Object.entries(TIER_SUFFIX).find(([, s]) => s === `_${tier}`)?.[0] ??
        tier;
      if (!Object.hasOwn(card.speeds, name)) {
        report(
          model,
          name,
          `LiteLLM prices a \`${tier}\` tier the werft card does not list`,
        );
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
      "Check each row against https://developers.openai.com/api/docs/pricing before changing the table; LiteLLM can be wrong or late. A difference werft keeps on purpose goes in `KNOWN` in `.github/scripts/litellm-price-drift.ts`.",
      "",
      "| Model | Field | Difference |",
      "|---|---|---|",
      ...drift.map((d) => `| \`${d.model}\` | ${d.field} | ${d.detail} |`),
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
