import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LITELLM_DECISION_RATES,
  LITELLM_SNAPSHOT,
  LITELLM_TOKEN_RATES,
} from "../packages/platform/src/limits/model-prices-litellm.gen.ts";
import {
  drops,
  extract,
  RULES,
  render,
} from "../scripts/update-litellm-prices.ts";

// Entries in upstream's shape with made-up names and rates: no LiteLLM data
// is copied here.
const chat = (rates: Record<string, unknown>) => ({ mode: "chat", ...rates });

describe("what the snapshot keeps of the upstream file", () => {
  test("a priced chat, responses or completion model, in USD per million tokens, by name", () => {
    const { tokens, decisions } = extract({
      "zeta/model": chat({
        input_cost_per_token: 1.5e-7,
        output_cost_per_token: 6e-7,
      }),
      "alpha-model": {
        mode: "responses",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
      "old-model": {
        mode: "completion",
        input_cost_per_token: 2e-6,
        output_cost_per_token: 2e-6,
      },
    });
    expect(tokens).toEqual([
      ["alpha-model", 3, 15],
      ["old-model", 2, 2],
      ["zeta/model", 0.15, 0.6],
    ]);
    expect(decisions).toEqual([]);
  });

  test("nothing of another mode, of the sample entry, or with a zero rate", () => {
    const { tokens } = extract({
      sample_spec: { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
      "an-embedding": {
        mode: "embedding",
        input_cost_per_token: 1e-7,
        output_cost_per_token: 1e-7,
      },
      "self-hosted": chat({
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      }),
      "free-output": chat({ input_cost_per_token: 1e-6 }),
      "not-an-entry": "text",
    });
    expect(tokens).toEqual([]);
  });

  test("the cache rates, the dearer of the two long-lived write names, no trailing zeros", () => {
    const { tokens } = extract({
      cached: chat({
        input_cost_per_token: 1e-6,
        output_cost_per_token: 4e-6,
        cache_read_input_token_cost: 1e-7,
        cache_creation_input_token_cost: 1.25e-6,
        cache_creation_input_token_cost_above_1hr: 2e-6,
        cache_creation_input_token_cost_above_12hr: 2.5e-6,
      }),
      "read-only": chat({
        input_cost_per_token: 1e-6,
        output_cost_per_token: 4e-6,
        cache_read_input_token_cost: 1e-7,
      }),
    });
    expect(tokens).toEqual([
      ["cached", 1, 4, 0.1, 1.25, 2.5],
      ["read-only", 1, 4, 0.1],
    ]);
  });

  test("each long-prompt tier after the base, lowest threshold first", () => {
    const { tokens } = extract({
      tiered: chat({
        input_cost_per_token: 1e-6,
        output_cost_per_token: 4e-6,
        input_cost_per_token_above_272k_tokens: 2e-6,
        output_cost_per_token_above_272k_tokens: 6e-6,
        input_cost_per_token_above_128k_tokens: 1.5e-6,
        output_cost_per_token_above_128k_tokens: 5e-6,
        cache_read_input_token_cost_above_128k_tokens: 2e-7,
      }),
    });
    expect(tokens).toEqual([
      // A tier keeps its zeros: the reader finds it by position.
      ["tiered", 1, 4, 0, 0, 0, 128_000, 1.5, 5, 0.2, 0, 0, 272_000, 2, 6],
    ]);
  });

  test("a judgment model with an input rate, even when its answer is free", () => {
    const { tokens, decisions } = extract({
      judge: { mode: "decisions", input_cost_per_token: 1e-7 },
      "free-judge": { mode: "decisions", input_cost_per_token: 0 },
    });
    expect(tokens).toEqual([]);
    expect(decisions).toEqual([["judge", 0.1, 0]]);
  });

  test.each([
    ["a negative rate", { input_cost_per_token: -1e-6 }],
    ["text for a rate", { input_cost_per_token: "0.000001" }],
    ["a rate that is not finite", { output_cost_per_token: 1 / 0 }],
  ])("refuses %s instead of reading it as a price", (_name, rates) => {
    expect(() =>
      extract({
        broken: chat({
          input_cost_per_token: 1e-6,
          output_cost_per_token: 1e-6,
          ...rates,
        }),
      }),
    ).toThrow(/is not a rate/);
  });

  test("refuses data that is not an object of models, and a name that would not print as text", () => {
    expect(() => extract([])).toThrow(/not an object/);
    expect(() => extract(null)).toThrow(/not an object/);
    const rates = { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 };
    expect(() =>
      extract({ [`line${String.fromCharCode(10)}break`]: chat(rates) }),
    ).toThrow(/not printable/);
    expect(() => extract({ ["x".repeat(257)]: chat(rates) })).toThrow(
      /too long/,
    );
  });
});

describe("the generated file", () => {
  test("is what the script prints from its own rows, under the rules it names", () => {
    expect(LITELLM_SNAPSHOT.rules).toBe(RULES);
    const file = readFileSync(
      join(
        import.meta.dir,
        "../packages/platform/src/limits/model-prices-litellm.gen.ts",
      ),
      "utf8",
    );
    expect(
      render(LITELLM_SNAPSHOT, {
        tokens: [...LITELLM_TOKEN_RATES],
        decisions: [...LITELLM_DECISION_RATES],
      }) === file,
    ).toBe(true);
  });

  test("carries the pin, the license notice and every row", () => {
    const text = render(
      { commit: "a".repeat(40), sha256: "b".repeat(64) },
      { tokens: [["m/one", 1, 2]], decisions: [["judge", 0.1, 0]] },
    );
    expect(text).toContain(`commit: "${"a".repeat(40)}"`);
    expect(text).toContain(`sha256: "${"b".repeat(64)}"`);
    expect(text).toContain("// Copyright (c) 2023 Berri AI");
    expect(text).toContain('["m/one",1,2],');
    expect(text).toContain('["judge",0.1,0],');
  });
});

describe("what a moved pin reports for the pull request", () => {
  const before = {
    tokens: [
      ["halved", 2, 8],
      ["output-halved", 2, 8],
      ["gone", 1, 4],
      ["cheaper", 2, 8],
      ["dearer", 2, 8],
    ] as [string, ...number[]][],
    decisions: [],
  };

  test("a rate that fell by half or more, and a model that left", () => {
    const lines = drops(before, {
      tokens: [
        ["halved", 1, 8],
        ["output-halved", 2, 3],
        ["cheaper", 1.5, 8],
        ["dearer", 4, 16],
        ["new", 1, 1],
      ],
      decisions: [],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("halved");
    expect(lines[0]).toContain("input $2 -> $1");
    expect(lines[1]).toContain("output $8 -> $3");
    expect(lines[2]).toContain("gone");
    expect(lines[2]).toContain("no longer priced");
  });

  test("nothing when no rate fell that far", () => {
    expect(drops(before, before)).toEqual([]);
  });
});
