import { describe, expect, test } from "bun:test";
import { runtimeConfigSchema } from "./index.ts";

const base = {
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: { kind: "egress_token", token: "t" },
  },
} as const;
const bundle = {
  name: "lint",
  digest: "ab".repeat(32),
  scope: "agent",
} as const;

describe("runtime_config.extensions", () => {
  test("a config without the field parses and stays without it", () => {
    const parsed = runtimeConfigSchema.parse(base);
    expect("extensions" in parsed).toBe(false);
  });

  test("a bundle list parses, and the schema of a worker built before the field refuses it", () => {
    const parsed = runtimeConfigSchema.parse({ ...base, extensions: [bundle] });
    expect(parsed.extensions).toEqual([bundle]);
    const older = runtimeConfigSchema.omit({ extensions: true });
    expect(older.safeParse(base).success).toBe(true);
    expect(older.safeParse({ ...base, extensions: [bundle] }).success).toBe(
      false,
    );
  });

  test("a list longer than any fixed cap still parses: session creation sets no cap, so the claim must not", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
      ...bundle,
      name: `ext-${i}`,
    }));
    expect(
      runtimeConfigSchema.safeParse({ ...base, extensions: many }).success,
    ).toBe(true);
  });

  test("an empty list, a repeated name, a bad digest, an unknown key and an unknown scope are refused", () => {
    for (const extensions of [
      [],
      [bundle, { ...bundle, digest: "cd".repeat(32) }],
      [{ ...bundle, digest: "AB".repeat(32) }],
      [{ ...bundle, path: "/etc" }],
      [{ ...bundle, scope: "global" }],
    ]) {
      expect(
        runtimeConfigSchema.safeParse({ ...base, extensions }).success,
      ).toBe(false);
    }
  });
});
