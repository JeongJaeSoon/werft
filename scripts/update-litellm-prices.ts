/**
 * Rewrites packages/platform/src/limits/model-prices-litellm.gen.ts: the
 * rates the platform reads from LiteLLM's price data for a model its own
 * tables do not name. The data is a snapshot in the repository, never read
 * at run time: a changed rate shows in a pull request's diff.
 *
 *   bun scripts/update-litellm-prices.ts              the pinned commit again
 *   bun scripts/update-litellm-prices.ts --check      and fail if the file differs
 *   bun scripts/update-litellm-prices.ts --sha <40-hex> | --latest
 *                                                     move the pin
 *   --report <file>   with a moved pin: rates that fell by half or more and
 *                     models that left, for the pull request's body
 *   --source <file>   read the data from a file instead of fetching it
 *
 * The pin is the commit and the sha256 of the whole upstream file, both in
 * the generated file's head. With the pin unmoved the fetched bytes must
 * hash to it. LiteLLM is MIT licensed outside its enterprise directory,
 * Copyright (c) 2023 Berri AI; the generated file carries the notice.
 *
 * exit: 0 written or unchanged, 1 --check found a difference, 2 the data
 * could not be read or is not in the shape the rules read
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const REPO = "BerriAI/litellm";
const PATH = "model_prices_and_context_window.json";
const OUT = join(
  import.meta.dir,
  "../packages/platform/src/limits/model-prices-litellm.gen.ts",
);
const MAX_BYTES = 64 * 1024 * 1024;
const ATTEMPTS = 4;

/**
 * The version of the rules below. A change to what is kept or how it is
 * written raises it, and the platform records it with each call it prices.
 */
export const RULES = 1;

/** The modes a session's or a conversation's call is priced from. */
const TOKEN_MODES: ReadonlySet<string> = new Set([
  "chat",
  "responses",
  "completion",
]);
const DECISION_MODE = "decisions";

const PARTS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
] as const;
/** A cache write kept longer than the default costs more; either name. */
const LONG_WRITES = ["_above_1hr", "_above_12hr"] as const;
const TIER = /^input_cost_per_token_above_(\d+)k_tokens$/;
/** A name is printed into source, so it must be plain text. */
function printable(name: string): boolean {
  return [...name].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

type Row = readonly [string, ...number[]];

export type Snapshot = {
  /** name, input, output, cache read, cache write, long cache write, tiers. */
  tokens: Row[];
  /** name, input, output: a judge's answer may cost nothing. */
  decisions: (readonly [string, number, number])[];
};

class ShapeError extends Error {}

/** USD per token as USD per million, without the float noise of the product. */
function perMtok(perToken: number): number {
  return Number((perToken * 1_000_000).toPrecision(12));
}

/** A rate field: absent is 0, anything but a finite number >= 0 is an error. */
function rate(model: string, entry: Record<string, unknown>, key: string) {
  const value = entry[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ShapeError(`${model}: ${key} is not a rate`);
  }
  return perMtok(value);
}

/** The five rates at one prompt length; "" is the base. */
function ratesAt(model: string, entry: Record<string, unknown>, tier: string) {
  return [
    ...PARTS.map((part) => rate(model, entry, part + tier)),
    Math.max(
      ...LONG_WRITES.map((long) =>
        rate(model, entry, `cache_creation_input_token_cost${long}${tier}`),
      ),
    ),
  ];
}

const byName = (a: Row, b: Row) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * What the platform keeps of the upstream file. An entry with no input or
 * output rate above zero is left out: upstream writes 0 for a model a user
 * hosts, and a zero read as a price would make its calls free.
 */
export function extract(raw: unknown): Snapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ShapeError("the data is not an object of models");
  }
  const tokens: Snapshot["tokens"] = [];
  const decisions: Snapshot["decisions"] = [];
  for (const [model, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const judged = entry.mode === DECISION_MODE;
    if (
      !judged &&
      !(typeof entry.mode === "string" && TOKEN_MODES.has(entry.mode))
    ) {
      continue;
    }
    if (model.length > 256 || !printable(model)) {
      throw new ShapeError("a model name is not printable or too long");
    }
    const base = ratesAt(model, entry, "");
    const [input = 0, output = 0] = base;
    if (judged) {
      if (input > 0) decisions.push([model, input, output]);
      continue;
    }
    if (!(input > 0 && output > 0)) continue;
    const tiers = Object.keys(entry)
      .flatMap((key) => TIER.exec(key)?.[1] ?? [])
      .map(Number)
      .sort((a, b) => a - b)
      .flatMap((k) => [
        k * 1000,
        ...ratesAt(model, entry, `_above_${k}k_tokens`),
      ]);
    const row = [...base, ...tiers];
    while (row.at(-1) === 0) row.pop();
    tokens.push([model, ...row]);
  }
  return { tokens: tokens.sort(byName), decisions: decisions.sort(byName) };
}

const NOTICE = [
  "MIT License",
  "",
  "Copyright (c) 2023 Berri AI",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
];

export function render(
  pin: { commit: string; sha256: string },
  snapshot: Snapshot,
): string {
  const rows = (list: readonly Row[]) =>
    list.map((row) => `${JSON.stringify(row)},`).join("\n");
  return [
    "// Generated by scripts/update-litellm-prices.ts; do not edit.",
    "//",
    `// Rates taken from ${PATH} of`,
    "// https://github.com/" +
      REPO +
      " at the commit named below, under its license:",
    "//",
    ...NOTICE.map((line) => `// ${line}`.trimEnd()),
    "",
    "/** The upstream commit, the sha256 of its whole file, the rules' version. */",
    "export const LITELLM_SNAPSHOT = {",
    `  commit: "${pin.commit}",`,
    `  sha256: "${pin.sha256}",`,
    `  rules: ${RULES},`,
    "} as const;",
    "",
    "/**",
    " * A model, then USD per million tokens: input, output, cache read, cache",
    " * write, long-lived cache write; then, per long-prompt tier, the prompt",
    " * tokens it starts past and the same five. 0: upstream gives none.",
    " */",
    "export const LITELLM_TOKEN_RATES: readonly (readonly [string, ...number[]])[] = [",
    rows(snapshot.tokens),
    "];",
    "",
    "/** A judgment model, then USD per million tokens: input, output. */",
    "export const LITELLM_DECISION_RATES: readonly (readonly [string, number, number])[] = [",
    rows(snapshot.decisions),
    "];",
    "",
  ].join("\n");
}

/** Rates that fell by half or more, and models that left, since `before`. */
export function drops(before: Snapshot, after: Snapshot): string[] {
  const now = new Map(after.tokens.map(([model, ...rates]) => [model, rates]));
  const tick = String.fromCharCode(96);
  const lines: string[] = [];
  for (const [model, input = 0, output = 0] of before.tokens) {
    const name = tick + model + tick;
    const rates = now.get(model);
    if (rates === undefined) {
      lines.push(
        "- " +
          name +
          ": no longer priced (was $" +
          input +
          " / $" +
          output +
          " per Mtok)",
      );
      continue;
    }
    const [nextInput = 0, nextOutput = 0] = rates;
    if (nextInput * 2 <= input || nextOutput * 2 <= output) {
      lines.push(
        "- " +
          name +
          ": input $" +
          input +
          " -> $" +
          nextInput +
          ", output $" +
          output +
          " -> $" +
          nextOutput +
          " per Mtok",
      );
    }
  }
  return lines;
}

async function download(commit: string): Promise<Uint8Array> {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${PATH}`;
  let failure = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > MAX_BYTES) {
          throw new Error(`body over ${MAX_BYTES} bytes`);
        }
        chunks.push(chunk);
      }
      if (response.ok) return Buffer.concat(chunks);
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = String(error);
    }
    console.error(`attempt ${attempt}/${ATTEMPTS} for ${url}: ${failure}`);
    if (attempt < ATTEMPTS) await Bun.sleep(5000 * attempt);
  }
  throw new Error(`could not fetch ${url}: ${failure}`);
}

/** The commit that last changed the price file on the default branch. */
async function latestCommit(): Promise<string> {
  const token = process.env.GH_TOKEN;
  const response = await fetch(
    "https://api.github.com/repos/" +
      REPO +
      "/commits?path=" +
      PATH +
      "&per_page=1",
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  const [latest] = (await response.json()) as { sha?: unknown }[];
  if (!response.ok || typeof latest?.sha !== "string") {
    throw new Error(
      `could not read the latest commit: HTTP ${response.status}`,
    );
  }
  return latest.sha;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      latest: { type: "boolean", default: false },
      sha: { type: "string" },
      report: { type: "string" },
      source: { type: "string" },
    },
  });
  try {
    const current = await import(OUT);
    const pinned: { commit: string; sha256: string } = current.LITELLM_SNAPSHOT;
    const commit = values.latest
      ? await latestCommit()
      : (values.sha ?? pinned.commit);
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error("--sha takes 40 hex digits");
    }
    const moved = commit !== pinned.commit;
    if (moved && values.check) {
      throw new Error("--check reads the pinned commit only");
    }
    const bytes = values.source
      ? readFileSync(values.source)
      : await download(commit);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!moved && sha256 !== pinned.sha256) {
      throw new Error(
        "the file at " +
          commit +
          " hashes to " +
          sha256 +
          ", pinned " +
          pinned.sha256,
      );
    }
    const snapshot = extract(JSON.parse(new TextDecoder().decode(bytes)));
    const text = render({ commit, sha256 }, snapshot);
    const unchanged = readFileSync(OUT, "utf8") === text;
    if (values.check) {
      console.log(
        unchanged
          ? `model-prices-litellm.gen.ts matches ${commit}`
          : "model-prices-litellm.gen.ts differs from what " +
              commit +
              " generates",
      );
      process.exit(unchanged ? 0 : 1);
    }
    if (!unchanged) writeFileSync(OUT, text);
    if (values.report !== undefined) {
      const tick = String.fromCharCode(96);
      const fell = drops(
        {
          tokens: current.LITELLM_TOKEN_RATES,
          decisions: current.LITELLM_DECISION_RATES,
        },
        snapshot,
      );
      writeFileSync(
        values.report,
        [
          "LiteLLM price snapshot: " +
            tick +
            pinned.commit +
            tick +
            " -> " +
            tick +
            commit +
            tick +
            " (sha256 " +
            tick +
            sha256 +
            tick +
            ").",
          "",
          fell.length === 0
            ? "No rate fell by half or more and no model left."
            : "Rates that fell by half or more, or models that left. Check each before merging: a rate read too low undercounts a budget.",
          ...(fell.length === 0 ? [] : ["", ...fell]),
          "",
        ].join("\n"),
      );
    }
    console.log(
      (unchanged ? "unchanged " : "wrote ") +
        commit +
        ": " +
        snapshot.tokens.length +
        " models, " +
        snapshot.decisions.length +
        " judgment models",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
