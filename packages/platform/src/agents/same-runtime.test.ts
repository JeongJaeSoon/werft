import { describe, expect, test } from "bun:test";

import { sameRuntime } from "./agent-service.ts";

const OLD = {
  model: "claude-sonnet-5",
  tools: ["Read", "Edit"],
  permission_mode: "default",
  provider: { kind: "litellm", endpoint: "https://litellm.invalid" },
};

describe("sameRuntime, for a profile migration", () => {
  test("a release made before the answer language is the same runtime as one that records it", () => {
    for (const language of ["follow-user", "ko", "en", "ja"]) {
      expect(sameRuntime(OLD, { ...OLD, language })).toBe(true);
      expect(
        sameRuntime({ ...OLD, language: "ko" }, { ...OLD, language }),
      ).toBe(true);
    }
  });

  test("tool order is still ignored, and a real runtime difference is still one", () => {
    expect(sameRuntime(OLD, { ...OLD, tools: ["Edit", "Read"] })).toBe(true);
    expect(sameRuntime(OLD, { ...OLD, model: "other" })).toBe(false);
    expect(sameRuntime(OLD, { ...OLD, permission_mode: "acceptEdits" })).toBe(
      false,
    );
  });
});
