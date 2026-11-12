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
      entry[`input_cost_per_token${suffix}`] =
        (card.short.inputUsdPerMtok * multiple) / 1e6;
      entry[`output_cost_per_token${suffix}`] =
        (card.short.outputUsdPerMtok * multiple) / 1e6;
      if (!pro) {
        entry[`cache_read_input_token_cost${suffix}`] =
          (card.short.cacheReadUsdPerMtok * multiple) / 1e6;
      }
    };
    put("", 1);
    if (card.long !== undefined) {
      entry.input_cost_per_token_above_272k_tokens =
        card.long.inputUsdPerMtok / 1e6;
      entry.output_cost_per_token_above_272k_tokens =
        card.long.outputUsdPerMtok / 1e6;
      if (!pro) {
        entry.cache_read_input_token_cost_above_272k_tokens =
          card.long.cacheReadUsdPerMtok / 1e6;
      }
    }
    for (const [tier, multiple] of Object.entries(card.speeds)) {
      put(tier === "fast" ? "_priority" : `_${tier}`, multiple);
    }
    entry.input_cost_per_token_batches = card.short.inputUsdPerMtok / 2e6;
    data[model] = entry;
  }
  return data;
}

describe("litellm-price-drift", () => {
  test("data that agrees with the table reports no drift", () => {
    expect(compare(parseLiteLlm(agreeing()))).toEqual([]);
  });

  test("a rate that differs is reported with both figures", () => {
    const data = agreeing();
    const entry = data["gpt-5.5"];
    if (entry === undefined) throw new Error("no gpt-5.5");
    entry.output_cost_per_token_priority = 60 / 1e6;
    expect(compare(parseLiteLlm(data))).toEqual([
      {
        model: "gpt-5.5",
        field: "fast",
        detail: "`output_cost_per_token_priority`: LiteLLM $60, werft $75",
      },
    ]);
  });

  test("a long-context rate, a cache write and a missing model are reported", () => {
    const data = agreeing();
    const astra = data["gpt-6-astra"];
    if (astra === undefined) throw new Error("no gpt-6-astra");
    astra.input_cost_per_token_above_272k_tokens = 25 / 1e6;
    astra.cache_creation_input_token_cost_above_12hr = 30 / 1e6;
    delete data["o3-pro"];
    expect(
      compare(parseLiteLlm(data)).map(({ model, field }) => [model, field]),
    ).toEqual([
      ["gpt-6-astra", "standard"],
      ["gpt-6-astra", "cache write"],
      ["o3-pro", "entry"],
    ]);
  });

  test("a tier the card does not list is reported, batch and flex are not", () => {
    const data = agreeing();
    // gpt-5.4-nano is on no speed tab of werft's card.
    const nano = data["gpt-5.4-nano"];
    if (nano === undefined) throw new Error("no gpt-5.4-nano");
    nano.input_cost_per_token_priority = 0.4 / 1e6;
    nano.input_cost_per_token_turbo = 0.8 / 1e6;
    nano.input_cost_per_token_flex = 0.1 / 1e6;
    // gpt-6-luna's `decisions` tier is a known one.
    const luna = data["gpt-6-luna"];
    if (luna === undefined) throw new Error("no gpt-6-luna");
    luna.input_cost_per_token_decisions = 0.1 / 1e6;
    expect(
      compare(parseLiteLlm(data)).map(({ model, field }) => [model, field]),
    ).toEqual([
      ["gpt-5.4-nano", "fast"],
      ["gpt-5.4-nano", "turbo"],
    ]);
  });

  test("a difference werft keeps on purpose is not reported", () => {
    const data = agreeing();
    const mini = data["gpt-5-mini"];
    if (mini === undefined) throw new Error("no gpt-5-mini");
    mini.output_cost_per_token_priority = 3.6 / 1e6;
    expect(compare(parseLiteLlm(data))).toEqual([]);
  });

  test("a cache read LiteLLM leaves out is reported unless the card prices it at the input rate", () => {
    const data = agreeing();
    const sol = data["gpt-6-sol"];
    if (sol === undefined) throw new Error("no gpt-6-sol");
    delete sol.cache_read_input_token_cost;
    expect(
      compare(parseLiteLlm(data)).map(({ model, field }) => [model, field]),
    ).toEqual([["gpt-6-sol", "standard"]]);
  });

  test("an entry werft prices must have numbers where it reads them; other entries are not read", () => {
    const data: Record<string, unknown> = agreeing();
    data["unrelated-model"] = { input_cost_per_token: "free" };
    expect(() => parseLiteLlm(data)).not.toThrow();
    data["gpt-5.5"] = { input_cost_per_token: "5e-6" };
    expect(() => parseLiteLlm(data)).toThrow(/gpt-5\.5/);
    expect(() => parseLiteLlm([])).toThrow();
  });

  test("the report names the commit and the license", () => {
    const commit = "0".repeat(40);
    const text = render(commit, [
      { model: "gpt-5.5", field: "fast", detail: "x" },
    ]);
    expect(text).toContain(
      `/blob/${commit}/model_prices_and_context_window.json`,
    );
    expect(text).toContain("| `gpt-5.5` | fast | x |");
    expect(text).toContain("MIT, Copyright (c) 2023 Berri AI");
  });
});
