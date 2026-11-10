import { describe, expect, test } from "bun:test";
import { testConnection } from "../testing/catalog-fakes.ts";
import {
  type CatalogConnection,
  modelFamiliesSchema,
  modelMoves,
  modelSuccessor,
} from "./catalog.ts";

const base: CatalogConnection = {
  ...testConnection(),
  models: ["sonnet-5-2", "opus-5-1"],
  model_families: {
    "sonnet-5-0": { family: "sonnet", rank: 0 },
    "sonnet-5-1": { family: "sonnet", rank: 1 },
    "sonnet-5-2": { family: "sonnet", rank: 2 },
    "opus-5-0": { family: "opus", rank: 0 },
    "opus-5-1": { family: "opus", rank: 1 },
  },
};

describe("modelSuccessor", () => {
  test("moves a removed model one step up its own family", () => {
    expect(modelSuccessor(base, "sonnet-5-0")).toBe("sonnet-5-2");
    expect(modelSuccessor(base, "sonnet-5-1")).toBe("sonnet-5-2");
  });

  test("takes the nearest listed rank when several are newer", () => {
    const connection = {
      ...base,
      models: ["sonnet-5-1", "sonnet-5-2", "opus-5-1"],
    };
    expect(modelSuccessor(connection, "sonnet-5-0")).toBe("sonnet-5-1");
  });

  test("never crosses families, whatever the names look like", () => {
    const connection = { ...base, models: ["opus-5-1"] };
    expect(modelSuccessor(connection, "sonnet-5-2")).toBeNull();
  });

  test("never moves down: only an older model is listed", () => {
    const connection = { ...base, models: ["sonnet-5-0"] };
    expect(modelSuccessor(connection, "sonnet-5-2")).toBeNull();
  });

  test("a model still listed, or with no family entry, does not move", () => {
    expect(modelSuccessor(base, "sonnet-5-2")).toBeNull();
    expect(modelSuccessor(base, "unknown-model")).toBeNull();
    const { model_families: _gone, ...plain } = base;
    expect(modelSuccessor(plain, "sonnet-5-0")).toBeNull();
  });

  test("modelMoves lists only removed models that have a successor", () => {
    expect(modelMoves(base)).toEqual([
      { from: "sonnet-5-0", to: "sonnet-5-2" },
      { from: "sonnet-5-1", to: "sonnet-5-2" },
      { from: "opus-5-0", to: "opus-5-1" },
    ]);
  });
});

describe("model_families in the settings schema", () => {
  test("refuses two models sharing a rank in one family", () => {
    const parsed = modelFamiliesSchema.safeParse({
      a: { family: "f", rank: 1 },
      b: { family: "f", rank: 1 },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      "two models of one family cannot share a rank",
    ]);
  });

  test("accepts the same rank in different families", () => {
    const parsed = modelFamiliesSchema.safeParse({
      a: { family: "f", rank: 1 },
      b: { family: "g", rank: 1 },
    });
    expect(parsed.success).toBe(true);
  });
});
