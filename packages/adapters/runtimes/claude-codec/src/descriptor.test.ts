import { describe, expect, test } from "bun:test";
import { featureSupport, unmetFeatures } from "@werft-ai/runtime-core";

import { CLAUDE_DESCRIPTOR } from "./descriptor.ts";

describe("CLAUDE_DESCRIPTOR", () => {
  const { capabilities, extraFeatures } = CLAUDE_DESCRIPTOR;

  test("declares user hooks as an extra feature it does not offer", () => {
    expect(extraFeatures.user_hooks).toBe("none");
    expect(featureSupport(capabilities, extraFeatures, "user_hooks")).toBe(
      "none",
    );
    expect(
      unmetFeatures(capabilities, extraFeatures, {
        features: ["user_hooks", "mcp"],
      }),
    ).toEqual(["user_hooks"]);
  });

  test("offers what a shipped profile can ask for", () => {
    expect(
      unmetFeatures(capabilities, extraFeatures, {
        features: ["mcp", "classifier_review", "session_resume", "subagents"],
      }),
    ).toEqual([]);
  });
});
