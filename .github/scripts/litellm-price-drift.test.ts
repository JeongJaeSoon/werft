import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CARDS,
  type ClaudeRates,
} from "../../packages/platform/src/limits/model-prices-claude.ts";
import { OPENAI_CARDS } from "../../packages/platform/src/limits/model-prices-openai.ts";
import {
  compare,
  compareClaude,
  parseLiteLlm,
  render,
} from "./litellm-price-drift.ts";

// LiteLLM-shaped data built from werft's own table, so it agrees by
// construction; each test then changes one thing. No LiteLLM data is copied.
function agreeing(): Record<string, Record<string, number>> {
  const data: Record<string, Record<string, number>> = {};
  for (const [model, card] of Object.entries(OPENAI_CARDS)) {
    const pro = model.endsWith("-pro");
    const entry: Record<string, number> = {};
    const put = (suffix: string, multiple: number) => {
      for (const [length, rates] of [
        ["", card.short],
        ["_above_272k_tokens", card.long],
      ] as const) {
        if (rates === undefined) continue;
        const at = (rate: number) => (rate * multiple) / 1e6;
        entry[`input_cost_per_token${length}${suffix}`] = at(
          rates.inputUsdPerMtok,
        );
        entry[`output_cost_per_token${length}${suffix}`] = at(
          rates.outputUsdPerMtok,
        );
        if (pro) continue;
        entry[`cache_read_input_token_cost${length}${suffix}`] = at(
          rates.cacheReadUsdPerMtok,
        );
        entry[`cache_creation_input_token_cost${length}${suffix}`] = at(
          rates.inputUsdPerMtok * 1.25,
        );
        entry[`cache_creation_input_token_cost_above_12hr${length}${suffix}`] =
          at(rates.inputUsdPerMtok * 2.5);
      }
    };
    put("", 1);
    for (const [tier, multiple] of Object.entries(card.speeds)) {
      put(tier === "fast" ? "_priority" : `_${tier}`, multiple);
    }
    put("_batches", 0.5);
    data[model] = entry;
  }
  return data;
}

function entryOf(
  data: Record<string, Record<string, number>>,
  model: string,
): Record<string, number> {
  const entry = data[model];
  if (entry === undefined) throw new Error(`no ${model}`);
  return entry;
}

const where = (data: Record<string, Record<string, number>>) =>
  compare(parseLiteLlm(data)).map(({ model, tier, undercharges }) => [
    model,
    tier,
    undercharges,
  ]);

describe("litellm-price-drift", () => {
  test("data that agrees with the table reports no drift", () => {
    expect(compare(parseLiteLlm(agreeing()))).toEqual([]);
  });

  test("a rate that differs is reported with both figures and its direction", () => {
    const data = agreeing();
    entryOf(data, "gpt-5.5").output_cost_per_token_priority = 60 / 1e6;
    entryOf(data, "gpt-6-sol").input_cost_per_token = 3 / 1e6;
    expect(compare(parseLiteLlm(data))).toEqual([
      {
        model: "gpt-6-sol",
        tier: "standard",
        detail: "`input_cost_per_token`: LiteLLM $3, werft $2",
        undercharges: true,
      },
      {
        model: "gpt-5.5",
        tier: "fast",
        detail: "`output_cost_per_token_priority`: LiteLLM $60, werft $75",
        undercharges: false,
      },
    ]);
  });

  test("long-context rates and cache writes at every tier are compared", () => {
    const data = agreeing();
    const astra = entryOf(data, "gpt-6-astra");
    astra.input_cost_per_token_above_272k_tokens = 25 / 1e6;
    astra.cache_creation_input_token_cost_priority = 100 / 1e6;
    astra.cache_creation_input_token_cost_above_272k_tokens = 100 / 1e6;
    astra.cache_creation_input_token_cost_above_12hr_above_272k_tokens_ultrafast =
      1 / 1e6;
    expect(where(data)).toEqual([
      // In LiteLLM's key order: long input, long write, fast write, the rest.
      ["gpt-6-astra", "standard", true],
      ["gpt-6-astra", "standard", true],
      ["gpt-6-astra", "fast", true],
      ["gpt-6-astra", "ultrafast", false],
    ]);
  });

  test("a model or a rate LiteLLM does not give is reported", () => {
    const data = agreeing();
    delete data["o3-pro"];
    delete entryOf(data, "gpt-6-sol").cache_read_input_token_cost;
    delete entryOf(data, "gpt-6.1-sol").output_cost_per_token_ultrafast;
    expect(where(data)).toEqual([
      ["gpt-6.1-sol", "ultrafast", false],
      ["gpt-6-sol", "standard", false],
      ["o3-pro", "standard", false],
    ]);
  });

  test("a tier the card does not list is compared at werft's highest multiple; batch and flex are skipped", () => {
    const data = agreeing();
    // gpt-5.4-nano is on no speed tab of werft's card, so werft charges 6x.
    const nano = entryOf(data, "gpt-5.4-nano");
    nano.input_cost_per_token_priority = 0.4 / 1e6;
    nano.input_cost_per_token_turbo = 2 / 1e6;
    nano.input_cost_per_token_flex = 0.1 / 1e6;
    expect(where(data)).toEqual([
      ["gpt-5.4-nano", "fast", false],
      ["gpt-5.4-nano", "turbo", true],
    ]);
  });

  test("a known difference is hidden only while werft charges more", () => {
    const data = agreeing();
    const mini = entryOf(data, "gpt-5-mini");
    mini.output_cost_per_token_priority = 3.6 / 1e6;
    // gpt-6-luna's `decisions` tier is known: 1x against werft's 6x.
    entryOf(data, "gpt-6-luna").input_cost_per_token_decisions = 0.1 / 1e6;
    expect(compare(parseLiteLlm(data))).toEqual([]);
    mini.output_cost_per_token_priority = 100 / 1e6;
    entryOf(data, "gpt-6-luna").input_cost_per_token_decisions = 1 / 1e6;
    expect(where(data)).toEqual([
      ["gpt-6-luna", "decisions", true],
      ["gpt-5-mini", "fast", true],
    ]);
  });

  test("a dated snapshot is compared with its base card, a rate it leaves out is not", () => {
    const data = agreeing();
    // werft prices `gpt-5.5-2026-04-23` as `gpt-5.5`.
    data["gpt-5.5-2026-04-23"] = { input_cost_per_token: 100 / 1e6 };
    data["gpt-5.4-2026-03-05"] = { input_cost_per_token: 2.5 / 1e6 };
    data["gpt-9-2026-01-01"] = { input_cost_per_token: 100 / 1e6 };
    expect(compare(parseLiteLlm(data))).toEqual([
      {
        model: "gpt-5.5-2026-04-23",
        tier: "standard",
        detail: "`input_cost_per_token`: LiteLLM $100, werft $5",
        undercharges: true,
      },
    ]);
  });

  test("a known tier is still reported when LiteLLM drops its rate", () => {
    const data = agreeing();
    delete entryOf(data, "gpt-5-mini").output_cost_per_token_priority;
    expect(where(data)).toEqual([["gpt-5-mini", "fast", false]]);
  });

  test("a rate for a length the card has no rates for is reported as one werft may undercharge", () => {
    const data = agreeing();
    // gpt-5.4-nano has no long card; werft charges its fallback past 272K.
    entryOf(data, "gpt-5.4-nano").input_cost_per_token_above_272k_tokens =
      100 / 1e6;
    expect(where(data)).toEqual([["gpt-5.4-nano", "standard", true]]);
  });

  test("a rate field this check does not know is reported", () => {
    const data = agreeing();
    entryOf(data, "gpt-5.5").input_cost_per_token_above_128k_tokens = 1 / 1e6;
    entryOf(data, "gpt-5.5").output_cost_per_token_above_12hr = 1 / 1e6;
    expect(where(data)).toEqual([
      ["gpt-5.5", "standard", true],
      ["gpt-5.5", "standard", true],
    ]);
  });

  test("every rate field of an entry werft prices must be a number; other entries are not read", () => {
    const data: Record<string, unknown> = agreeing();
    data["unrelated-model"] = { input_cost_per_token: "free" };
    expect(() => parseLiteLlm(data)).not.toThrow();
    data["gpt-6-astra"] = {
      ...entryOf(agreeing(), "gpt-6-astra"),
      input_cost_per_token_above_272k_tokens_priority: "100e-6",
    };
    expect(() => parseLiteLlm(data)).toThrow(/gpt-6-astra/);
    data["gpt-6-astra"] = { input_cost_per_token: -1 };
    expect(() => parseLiteLlm(data)).toThrow(/gpt-6-astra/);
    expect(() => parseLiteLlm([])).toThrow();
  });

  test("the report names the commit, the license and an undercharge", () => {
    const commit = "0".repeat(40);
    const text = render(commit, [
      { model: "gpt-5.5", tier: "fast", detail: "x", undercharges: true },
    ]);
    expect(text).toContain(
      `/blob/${commit}/model_prices_and_context_window.json`,
    );
    expect(text).toContain("| `gpt-5.5` | fast | x | **yes** |");
    expect(text).toContain("MIT, Copyright (c) 2023 Berri AI");
  });
});

type Raw = Record<string, Record<string, unknown>>;

// The same for werft's Claude table: agrees by construction, no LiteLLM data.
function claudeAgreeing(): Raw {
  const data: Raw = {};
  for (const [model, card] of Object.entries(CLAUDE_CARDS)) {
    const entry: Record<string, unknown> = { litellm_provider: "anthropic" };
    const lengths: [string, ClaudeRates][] = [["", card.standard]];
    if (card.long !== undefined) {
      lengths.push([
        `_above_${card.long.aboveTokens / 1000}k_tokens`,
        card.long.rates,
      ]);
    }
    for (const [length, rates] of lengths) {
      const at = (rate: number) => rate / 1e6;
      entry[`input_cost_per_token${length}`] = at(rates.inputUsdPerMtok);
      entry[`output_cost_per_token${length}`] = at(rates.outputUsdPerMtok);
      entry[`cache_read_input_token_cost${length}`] = at(
        rates.cacheReadUsdPerMtok,
      );
      entry[`cache_creation_input_token_cost${length}`] = at(
        rates.inputUsdPerMtok * 1.25,
      );
      entry[`cache_creation_input_token_cost_above_1hr${length}`] = at(
        rates.inputUsdPerMtok * 2,
      );
      entry[`input_cost_per_token${length}_batches`] = at(
        rates.inputUsdPerMtok / 2,
      );
    }
    const multiples: Record<string, number> = {};
    if (card.fast !== undefined) multiples.fast = card.fast;
    if (card.geo) multiples.us = 1.1;
    if (Object.keys(multiples).length > 0) {
      entry.provider_specific_entry = multiples;
    }
    entry.search_context_cost_per_query = {
      search_context_size_low: 0.01,
      search_context_size_high: 0.01,
    };
    data[model] = entry;
  }
  return data;
}

function claudeEntryOf(data: Raw, model: string): Record<string, unknown> {
  const entry = data[model];
  if (entry === undefined) throw new Error(`no ${model}`);
  return entry;
}

function multiplesOf(data: Raw, model: string): Record<string, number> {
  const entry = claudeEntryOf(data, model);
  entry.provider_specific_entry ??= {};
  return entry.provider_specific_entry as Record<string, number>;
}

const whereClaude = (data: Raw) =>
  compareClaude(parseLiteLlm(data)).map(({ model, tier, undercharges }) => [
    model,
    tier,
    undercharges,
  ]);

describe("litellm-price-drift for the Claude table", () => {
  test("data that agrees with the table reports no drift", () => {
    expect(compareClaude(parseLiteLlm(claudeAgreeing()))).toEqual([]);
  });

  test("a rate or an hour-long cache write that differs is reported with its direction", () => {
    const data = claudeAgreeing();
    claudeEntryOf(data, "claude-sonnet-5").cache_read_input_token_cost =
      0.1 / 1e6;
    claudeEntryOf(
      data,
      "claude-opus-5",
    ).cache_creation_input_token_cost_above_1hr = 12 / 1e6;
    expect(compareClaude(parseLiteLlm(data))).toEqual([
      {
        model: "claude-opus-5",
        tier: "standard",
        detail:
          "`cache_creation_input_token_cost_above_1hr`: LiteLLM $12, werft $10",
        undercharges: true,
      },
      {
        model: "claude-sonnet-5",
        tier: "standard",
        detail: "`cache_read_input_token_cost`: LiteLLM $0.1, werft $0.2",
        undercharges: false,
      },
    ]);
  });

  test("long-prompt rates are compared at werft's threshold; another length or a batch rate is not", () => {
    const data = claudeAgreeing();
    const haiku = claudeEntryOf(data, "claude-haiku-5-5");
    haiku.output_cost_per_token_above_100k_tokens = 3 / 1e6;
    haiku.input_cost_per_token_above_200k_tokens = 1 / 1e6;
    haiku.input_cost_per_token_batches = 99 / 1e6;
    claudeEntryOf(
      data,
      "claude-opus-4-8",
    ).input_cost_per_token_above_200k_tokens = 10 / 1e6;
    expect(whereClaude(data)).toEqual([
      ["claude-opus-4-8", "standard", true],
      ["claude-haiku-5-5", "standard", true],
      ["claude-haiku-5-5", "standard", true],
    ]);
  });

  test("a model or a rate LiteLLM does not give is reported, unless the id is unpaired for a reason", () => {
    const data = claudeAgreeing();
    delete data["claude-opus-5"];
    delete data["claude-opus-4-0"];
    delete claudeEntryOf(data, "claude-haiku-5-5")
      .cache_creation_input_token_cost_above_1hr_above_100k_tokens;
    expect(whereClaude(data)).toEqual([
      ["claude-opus-5", "standard", false],
      ["claude-haiku-5-5", "standard", false],
    ]);
  });

  test("fast and US-only multiples are compared, and one this check does not know is reported", () => {
    const data = claudeAgreeing();
    multiplesOf(data, "claude-opus-5-5").fast = 2.5;
    // werft offers claude-opus-4-7 no fast rates.
    multiplesOf(data, "claude-opus-4-7").fast = 2;
    delete multiplesOf(data, "claude-sonnet-5").us;
    // werft prices claude-sonnet-4-5, from before Claude 4.6, at global rates.
    multiplesOf(data, "claude-sonnet-4-5").us = 1.1;
    multiplesOf(data, "claude-haiku-5-5").eu = 1.2;
    expect(whereClaude(data)).toEqual([
      ["claude-opus-5-5", "fast", true],
      ["claude-opus-4-7", "fast", true],
      ["claude-sonnet-5", "us", false],
      ["claude-sonnet-4-5", "us", true],
      ["claude-haiku-5-5", "eu", true],
    ]);
  });

  test("a web search fee that differs is reported", () => {
    const data = claudeAgreeing();
    claudeEntryOf(data, "claude-opus-5").search_context_cost_per_query = {
      search_context_size_low: 0.02,
    };
    expect(whereClaude(data)).toEqual([["claude-opus-5", "web search", true]]);
  });

  test("a search fee one entry leaves out is not reported; one every entry leaves out is", () => {
    const data = claudeAgreeing();
    delete claudeEntryOf(data, "claude-haiku-4-5")
      .search_context_cost_per_query;
    expect(whereClaude(data)).toEqual([]);
    for (const entry of Object.values(data)) {
      entry.search_context_cost_per_query = {};
    }
    expect(whereClaude(data)).toEqual([["claude-*", "web search", false]]);
  });

  test("a Claude API model werft has no card for is reported; other providers' and unpaired ids are not", () => {
    const data = claudeAgreeing();
    data["claude-fable-9"] = {
      litellm_provider: "anthropic",
      input_cost_per_token: 1 / 1e6,
    };
    data["claude-opus-4-6-20260205"] = { litellm_provider: "anthropic" };
    data["claude-fable-latest"] = {};
    data["claude-fable-9-v1:0"] = { litellm_provider: "bedrock" };
    expect(whereClaude(data)).toEqual([["claude-fable-9", "standard", true]]);
  });

  test("a Claude entry's multiples and search fee must be numbers; another provider's entry is not read", () => {
    const data = claudeAgreeing();
    data["claude-fable-9-v1:0"] = {
      litellm_provider: "bedrock",
      provider_specific_entry: { fast: "x" },
    };
    expect(() => parseLiteLlm(data)).not.toThrow();
    multiplesOf(data, "claude-opus-5").fast = Number.NaN;
    expect(() => parseLiteLlm(data)).toThrow(/claude-opus-5/);
    multiplesOf(data, "claude-opus-5").fast = 2;
    claudeEntryOf(data, "claude-sonnet-5").search_context_cost_per_query = {
      search_context_size_low: -1,
    };
    expect(() => parseLiteLlm(data)).toThrow(/claude-sonnet-5/);
  });
});
