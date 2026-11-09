import { describe, expect, test } from "bun:test";
import { runtimeConfigSchema, workerCapabilitiesSchema } from "./index.ts";

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

const settings = {
  permissions: { allow: ["Bash(make test)"], deny: ["Bash(rm:*)"] },
  autoMode: { soft_deny: ["Do not push to main."] },
};

describe("runtime_config.engine_settings", () => {
  test("a config without the field parses and stays without it", () => {
    expect("engine_settings" in runtimeConfigSchema.parse(base)).toBe(false);
  });

  test("merged settings parse, and the schema of a worker built before the field refuses them", () => {
    const parsed = runtimeConfigSchema.parse({
      ...base,
      engine_settings: settings,
    });
    expect(parsed.engine_settings).toEqual(settings);
    const older = runtimeConfigSchema.omit({ engine_settings: true });
    expect(older.safeParse(base).success).toBe(true);
    expect(
      older.safeParse({ ...base, engine_settings: settings }).success,
    ).toBe(false);
  });

  test.each([
    ["an empty object", {}],
    ["an empty permissions object", { permissions: {} }],
    ["an empty autoMode object", { autoMode: {} }],
    ["an empty rule list", { permissions: { deny: [] } }],
    ["an empty rule", { permissions: { deny: [""] } }],
    [
      "a permission rule over 256 characters",
      { permissions: { deny: ["a".repeat(257)] } },
    ],
    [
      "more than 128 permission rules",
      {
        permissions: {
          allow: Array.from({ length: 129 }, (_, i) => `Bash(c${i})`),
        },
      },
    ],
    [
      "a classifier rule over 1024 characters",
      { autoMode: { allow: ["a".repeat(1025)] } },
    ],
    [
      "more than 64 classifier rules",
      {
        autoMode: { allow: Array.from({ length: 65 }, (_, i) => `rule ${i}`) },
      },
    ],
    ["an unknown section", { autoMode: { classifyAllShell: ["x"] } }],
    ["an unknown key", { permissions: { defaultMode: ["x"] } }],
    ["an unknown top-level key", { hooks: {} }],
  ])("refuses %s", (_name, engine_settings) => {
    expect(
      runtimeConfigSchema.safeParse({ ...base, engine_settings }).success,
    ).toBe(false);
  });
});

describe("the engine_settings capability", () => {
  test("a worker may announce it, and only as true", () => {
    expect(workerCapabilitiesSchema.parse({ engine_settings: true })).toEqual({
      engine_settings: true,
    });
    expect(
      workerCapabilitiesSchema.safeParse({ engine_settings: false }).success,
    ).toBe(false);
  });
});
