/**
 * Compares werft's OpenAI and Claude price tables (packages/platform/src/
 * limits/model-prices-openai.ts and model-prices-claude.ts) with LiteLLM's
 * price data and reports where they differ. It only reports: a table is
 * changed by a person who checks the official page, never from this data.
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
  CLAUDE_CACHE_WRITE_1H,
  CLAUDE_CACHE_WRITE_5M,
  CLAUDE_CARDS,
  CLAUDE_GEO_PERCENT,
  type ClaudeRates,
  WEB_SEARCH_MICRO_USD,
} from "../../packages/platform/src/limits/model-prices-claude.ts";
import {
  OPENAI_CACHE_WRITE_12H,
  OPENAI_CACHE_WRITE_30M,
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

const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/** werft prices a dated snapshot (`gpt-5.5-2026-04-23`) as its base model. */
function baseOf(name: string): string {
  return name.replace(DATED_SNAPSHOT, "");
}

const anthropic = z.looseObject({ litellm_provider: z.literal("anthropic") });

/** What a Claude entry adds: its multiples and its web search fee. */
const claudeExtrasSchema = z.looseObject({
  provider_specific_entry: z
    .record(z.string(), z.number().finite().positive())
    .optional(),
  search_context_cost_per_query: z.record(z.string(), perToken).optional(),
});

/** A Claude model werft prices, or one LiteLLM prices on the Claude API. */
function isClaude(model: string, value: unknown): boolean {
  return (
    Object.hasOwn(CLAUDE_CARDS, model) ||
    (model.startsWith("claude-") && anthropic.safeParse(value).success)
  );
}

/** Only the entries werft prices are validated; the rest are not read. */
export function parseLiteLlm(raw: unknown): Record<string, Entry> {
  const all = z.record(z.string(), z.unknown()).parse(raw);
  const entries: Record<string, Entry> = {};
  for (const model of Object.keys(all)) {
    const claude = isClaude(model, all[model]);
    if (!claude && !Object.hasOwn(OPENAI_CARDS, baseOf(model))) continue;
    const shape = (error: z.ZodError) =>
      new Error(
        `LiteLLM entry ${model} is not in the expected shape: ${z.prettifyError(error)}`,
      );
    const parsed = entrySchema.safeParse(all[model]);
    if (!parsed.success) throw shape(parsed.error);
    const extras = claude ? claudeExtrasSchema.safeParse(all[model]) : null;
    if (extras?.success === false) throw shape(extras.error);
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
  for (const [model, card] of Object.entries(OPENAI_CARDS)) {
    const report = (
      shown: string,
      tier: string,
      detail: string,
      undercharges: boolean,
      // Only a rate both sides give can be shown to be one werft charges more.
      hideable = !undercharges,
    ) => {
      if (!hideable || !Object.hasOwn(KNOWN, `${model} ${tier}`)) {
        drift.push({ model: shown, tier, detail, undercharges });
      }
    };
    const entry = litellm[model];
    if (entry === undefined) {
      report(
        model,
        "standard",
        "LiteLLM has no entry for this model",
        false,
        false,
      );
    }
    // Every rate LiteLLM gives for the model or a dated snapshot of it,
    // which werft prices as the model, against what werft charges for it.
    const rates = Object.entries(litellm)
      .filter(([name]) => baseOf(name) === model)
      .flatMap(([name, each]) =>
        Object.entries(each).map(([key, value]) => [name, key, value] as const),
      );
    for (const [shown, key, theirs] of rates) {
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
          shown,
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
      const cardRates = long === undefined ? card.short : card.long;
      // A length the card has no rates for is priced by the fallback, which
      // this check does not compute: a person compares the two.
      if (cardRates === undefined) {
        report(
          shown,
          tier,
          `\`${key}\`: LiteLLM ${perMtok(theirs)}; werft has no rate for this length and charges its fallback`,
          true,
        );
        continue;
      }
      const rate = PARTS[part];
      if (rate === undefined) continue;
      const write =
        part === "cache_creation_input_token_cost"
          ? twelveHours === undefined
            ? OPENAI_CACHE_WRITE_30M
            : OPENAI_CACHE_WRITE_12H
          : 1;
      const ours =
        (cardRates[rate] * write * openAiSpeedMultiplier(model, tier)) / 1e6;
      if (!same(theirs, ours)) {
        const unlisted =
          Object.hasOwn(card.speeds, tier) || tier === "standard"
            ? ""
            : " (the card does not list this tier; werft charges its highest multiple)";
        report(
          shown,
          tier,
          `\`${key}\`: LiteLLM ${perMtok(theirs)}, werft ${perMtok(ours)}${unlisted}`,
          theirs > ours,
        );
      }
    }
    // Rates werft charges that LiteLLM does not give.
    if (entry === undefined) continue;
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
            report(model, tier, `LiteLLM has no \`${key}\``, false, false);
          }
        }
      }
    }
  }
  return drift;
}

/** A Claude rate field: its part, then an hour-long write, a long prompt, a batch. */
const CLAUDE_RATE_KEY =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(_above_1hr)?(?:_above_(\d+)k_tokens)?(_batches)?$/;

const RETIRED =
  "retired on the Claude API on 2026-06-15 (model deprecations page, checked 2026-11-13); LiteLLM keeps it only under cloud-provider names";
const NOT_AN_API_ID =
  "not a Claude API id: ids carry no date from Claude 4.6 on (model ids page, checked 2026-11-13)";

/**
 * Claude ids one side names and the other does not, for a reason a person
 * checked. The row is not reported; a rate both sides give still is.
 */
export const CLAUDE_UNPAIRED: Readonly<Record<string, string>> = {
  "claude-opus-4-0": RETIRED,
  "claude-opus-4-20250514": RETIRED,
  "claude-sonnet-4-0": RETIRED,
  "claude-sonnet-4-20250514": RETIRED,
  "claude-opus-4-6-20260205": NOT_AN_API_ID,
  "claude-opus-4-7-20260416": NOT_AN_API_ID,
  "claude-mythos-preview":
    "deprecated 2026-06-09 and not on the pricing page (checked 2026-11-13); werft charges its fallback",
};

/** The same comparison for werft's Claude table. */
export function compareClaude(litellm: Record<string, Entry>): Drift[] {
  const drift: Drift[] = [];
  const ourSearch = WEB_SEARCH_MICRO_USD / 1e6;
  let searchSeen = false;
  for (const [model, card] of Object.entries(CLAUDE_CARDS)) {
    const report = (
      tier: string,
      detail: string,
      undercharges: boolean,
      hideable = !undercharges,
    ) => {
      if (!hideable || !Object.hasOwn(KNOWN, `${model} ${tier}`)) {
        drift.push({ model, tier, detail, undercharges });
      }
    };
    const entry = litellm[model];
    if (entry === undefined) {
      if (!Object.hasOwn(CLAUDE_UNPAIRED, model)) {
        report("standard", "LiteLLM has no entry for this model", false, false);
      }
      continue;
    }
    const long =
      card.long === undefined
        ? undefined
        : `_above_${card.long.aboveTokens / 1000}k_tokens`;
    for (const [key, theirs] of Object.entries(entry)) {
      if (
        typeof theirs !== "number" ||
        !PART_NAMES.some((part) => key.startsWith(part))
      ) {
        continue;
      }
      const [, part, hour, aboveK, batches] = CLAUDE_RATE_KEY.exec(key) ?? [];
      if (
        part === undefined ||
        (hour !== undefined && part !== "cache_creation_input_token_cost")
      ) {
        report(
          "standard",
          `\`${key}\` is a rate this check does not know`,
          true,
        );
        continue;
      }
      // werft prices no batch call.
      if (batches !== undefined) continue;
      let rates: ClaudeRates = card.standard;
      if (aboveK !== undefined) {
        if (card.long === undefined || `_above_${aboveK}k_tokens` !== long) {
          report(
            "standard",
            `\`${key}\`: LiteLLM ${perMtok(theirs)}; werft has no rate past ${aboveK}K tokens${card.long === undefined ? "" : ` (its long rates start past ${card.long.aboveTokens / 1000}K)`}`,
            true,
          );
          continue;
        }
        rates = card.long.rates;
      }
      const rate = PARTS[part];
      if (rate === undefined) continue;
      const write =
        part === "cache_creation_input_token_cost"
          ? hour === undefined
            ? CLAUDE_CACHE_WRITE_5M
            : CLAUDE_CACHE_WRITE_1H
          : 1;
      const ours = (rates[rate] * write) / 1e6;
      if (!same(theirs, ours)) {
        report(
          "standard",
          `\`${key}\`: LiteLLM ${perMtok(theirs)}, werft ${perMtok(ours)}`,
          theirs > ours,
        );
      }
    }
    // Rates werft charges that LiteLLM does not give.
    for (const length of long === undefined ? [""] : ["", long]) {
      for (const key of [
        ...PART_NAMES.map((part) => `${part}${length}`),
        `cache_creation_input_token_cost_above_1hr${length}`,
      ]) {
        if (!Object.hasOwn(entry, key)) {
          report("standard", `LiteLLM has no \`${key}\``, false, false);
        }
      }
    }
    // The multiples: fast mode and US-only inference.
    const extras = claudeExtrasSchema.parse(entry);
    const multiples = extras.provider_specific_entry ?? {};
    const ourMultiples: Record<string, number | undefined> = {
      fast: card.fast,
      us: card.geo ? (CLAUDE_GEO_PERCENT.us ?? 0) / 100 : undefined,
    };
    for (const name of new Set([
      ...Object.keys(ourMultiples),
      ...Object.keys(multiples),
    ])) {
      const theirs = multiples[name];
      const ours = ourMultiples[name];
      if (!Object.hasOwn(ourMultiples, name)) {
        report(
          name,
          `\`provider_specific_entry.${name}\` is a multiple this check does not know`,
          true,
        );
      } else if (theirs === undefined && ours !== undefined) {
        report(name, `LiteLLM gives no ${name} multiple`, false, false);
      } else if (theirs !== undefined && ours === undefined) {
        report(
          name,
          `LiteLLM ${theirs}x; werft has no ${name} rates for this model and charges ${name === "us" ? "the global rates" : "its fallback"}`,
          true,
        );
      } else if (
        theirs !== undefined &&
        ours !== undefined &&
        !same(theirs, ours)
      ) {
        report(name, `LiteLLM ${theirs}x, werft ${ours}x`, theirs > ours);
      }
    }
    const searchFees = Object.entries(
      extras.search_context_cost_per_query ?? {},
    );
    if (searchFees.length > 0) searchSeen = true;
    for (const [size, theirs] of searchFees) {
      if (!same(theirs, ourSearch)) {
        report(
          "web search",
          `\`search_context_cost_per_query.${size}\`: LiteLLM $${theirs}, werft $${ourSearch} per search`,
          theirs > ourSearch,
        );
      }
    }
  }
  // Some entries (claude-haiku-4-5) never carry the fee, so only its absence
  // from every entry, a field LiteLLM dropped or renamed, is reported.
  if (!searchSeen) {
    drift.push({
      model: "claude-*",
      tier: "web search",
      detail:
        "LiteLLM gives no `search_context_cost_per_query` for any Claude model werft prices",
      undercharges: false,
    });
  }
  // Claude models LiteLLM prices that werft does not: werft charges them
  // its fallback, which this check does not compute.
  for (const [model, entry] of Object.entries(litellm)) {
    if (
      model.startsWith("claude-") &&
      anthropic.safeParse(entry).success &&
      !Object.hasOwn(CLAUDE_CARDS, model) &&
      !Object.hasOwn(CLAUDE_UNPAIRED, model)
    ) {
      drift.push({
        model,
        tier: "standard",
        detail: "werft has no card for this model and charges its fallback",
        undercharges: true,
      });
    }
  }
  return drift;
}

export function render(commit: string, drift: Drift[]): string {
  const source = `https://github.com/${REPO}/blob/${commit}/${PATH}`;
  const lines = [
    `werft's OpenAI and Claude price tables compared with LiteLLM's [\`${PATH}\`](${source}) at \`${commit}\`.`,
    "",
  ];
  if (drift.length === 0) {
    lines.push("No differences outside the known ones.");
  } else {
    lines.push(
      "Check each row against the official page before changing a table: https://developers.openai.com/api/docs/pricing for a `gpt-` or `o` model, https://platform.claude.com/docs/en/about-claude/pricing for a `claude-` one. LiteLLM can be wrong or late. A row marked **werft lower** may undercharge. A difference werft keeps on purpose, where werft charges more, goes in `KNOWN` in `.github/scripts/litellm-price-drift.ts`; a Claude id only one side names, with the reason, in `CLAUDE_UNPAIRED`.",
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
    const entries = parseLiteLlm(raw);
    const drift = [...compare(entries), ...compareClaude(entries)];
    const text = render(commit, drift);
    if (values.out !== undefined) writeFileSync(values.out, text);
    process.stdout.write(text);
    process.exit(drift.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
