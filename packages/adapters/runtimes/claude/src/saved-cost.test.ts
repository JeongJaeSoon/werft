import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@werft-ai/runtime-core";
import { ResumedHistory, savedCostOfEntry } from "./resumed-history.ts";

// The 0.3.319 engine checks a `cost-state` entry against a schema and drops
// one that fails, then resumes from the last valid entry of the session (or
// from zero). A baseline taken from an entry it dropped would be charged
// short, so everything the engine drops must be dropped here too.

const SESSION = "s1";

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 3,
};

function entry(overrides: Record<string, unknown> = {}): TranscriptEntry {
  return {
    type: "cost-state",
    sessionId: SESSION,
    totalCostUSD: 3,
    totalAPIDuration: 15,
    totalAPIDurationWithoutRetries: 14,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: 335,
    startTime: 1794151687760,
    modelUsage: { "claude-sonnet-4-5": { ...usage } },
    ...overrides,
  };
}

describe("savedCostOfEntry", () => {
  test("accepts what the engine writes", () => {
    expect(savedCostOfEntry(entry(), SESSION)).toEqual({
      usd: 3,
      sessionId: SESSION,
    });
    const optional = entry({
      hasUnknownModelCost: false,
      modelUsage: {
        m: {
          ...usage,
          thinkingTokens: 1,
          cacheCreationEphemeral5mInputTokens: 0,
        },
      },
    });
    expect(savedCostOfEntry(optional, SESSION)?.usd).toBe(3);
  });

  test("ignores an entry of another session", () => {
    expect(savedCostOfEntry(entry({ sessionId: "other" }), SESSION)).toBe(
      undefined,
    );
  });

  const dropped: Array<[string, Record<string, unknown>]> = [
    ["a model usage without its fields", { modelUsage: { m: {} } }],
    ["a model usage that is not an object", { modelUsage: { m: 1 } }],
    ["a negative model cost", { modelUsage: { m: { ...usage, costUSD: -1 } } }],
    [
      "a model usage field past 1e15",
      { modelUsage: { m: { ...usage, inputTokens: 1e15 + 1 } } },
    ],
    [
      "token totals across models past 1e15",
      {
        modelUsage: {
          a: { ...usage, inputTokens: 6e14 },
          b: { ...usage, inputTokens: 6e14 },
        },
      },
    ],
    [
      "an optional model field out of range",
      { modelUsage: { m: { ...usage, thinkingTokens: -1 } } },
    ],
    [
      "a model key with a control character",
      { modelUsage: { "m\u0007": usage } },
    ],
    ["a model key with a format character", { modelUsage: { "m​": usage } }],
    ["an empty model key", { modelUsage: { "": usage } }],
    ["a non-boolean hasUnknownModelCost", { hasUnknownModelCost: "false" }],
    ["a total cost past 1e9", { totalCostUSD: 1e9 + 1 }],
    ["a duration past 1e15", { totalDuration: 1e15 + 1 }],
    ["a missing field", { startTime: undefined }],
    ["a negative total", { totalCostUSD: -1 }],
    ["a model usage that is an array", { modelUsage: [] }],
  ];
  for (const [name, overrides] of dropped) {
    test(`drops ${name}`, () => {
      expect(savedCostOfEntry(entry(overrides), SESSION)).toBeUndefined();
    });
  }
});

describe("the saved cost of a resumed transcript", () => {
  function costOf(entries: TranscriptEntry[], sessionId = SESSION) {
    const { history, store } = ResumedHistory.watching({
      load: async () => entries,
      append: async () => {},
      listSubkeys: async () => [],
      revisionScoped: true,
    });
    return store
      .load({ projectKey: "p", sessionId })
      .then(() => history.savedCost());
  }

  test("a valid 3 followed by an invalid 5 keeps the 3", async () => {
    const saved = await costOf([
      entry({ totalCostUSD: 3 }),
      entry({ totalCostUSD: 5, modelUsage: { m: {} } }),
    ]);
    expect(saved).toEqual({ usd: 3, sessionId: SESSION });
  });

  test("the last entry of another session does not hide the resumed one", async () => {
    const saved = await costOf([
      entry({ totalCostUSD: 3 }),
      entry({ totalCostUSD: 8, sessionId: "after-clear" }),
    ]);
    expect(saved).toEqual({ usd: 3, sessionId: SESSION });
  });

  test("a transcript whose only entry is invalid has no baseline", async () => {
    expect(
      await costOf([entry({ totalCostUSD: 3, modelUsage: { m: {} } })]),
    ).toBeUndefined();
  });

  test("an abandoned history settles its cost as unknown", async () => {
    const { history } = ResumedHistory.watching({
      load: async () => null,
      append: async () => {},
      listSubkeys: async () => [],
      revisionScoped: true,
    });
    history.abandon();
    expect(await history.savedCost()).toBeUndefined();
  });
});
