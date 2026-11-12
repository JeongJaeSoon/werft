import { describe, expect, test } from "bun:test";
import { OPENAI_CARDS } from "../../packages/platform/src/limits/model-prices-openai.ts";
import { compare, parseLiteLlm, render } from "./litellm-price-drift.ts";

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
