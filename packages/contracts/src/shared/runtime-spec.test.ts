import { describe, expect, test } from "bun:test";
import { repositoryModeSchema } from "../api/profiles.ts";
import { PERMISSION_MODE_VALUES, RUNTIME_KIND_VALUES } from "../api/session.ts";
import {
  deriveRuntimeSpec,
  executionModeOf,
  runtimeSpecSchema,
  type SpecSource,
  specSourceSchema,
} from "./runtime-spec.ts";

const source: SpecSource = {
  derivation_version: 1,
  origin: "profile",
  release_id: "sha256:abc",
  release_id_version: 4,
  profile_id: "default",
  profile_digest: "sha256:def",
  runtime: { kind: "claude_agent_sdk", version: "0.3.319" },
  connection: {
    id: "conn-1",
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    billing: "metered",
  },
  model: "claude-sonnet-5",
  permission_mode: "default",
  tools: ["Read", "Bash"],
  repository_mode: "required",
};

describe("runtime spec contract", () => {
  // The module repeats these enums to avoid an import cycle; a value added to
  // the original and not here would make a valid profile underivable.
  test("the repeated enums match the originals", () => {
    const shape = specSourceSchema.shape;
    expect(shape.permission_mode.options).toEqual([...PERMISSION_MODE_VALUES]);
    expect(shape.runtime.shape.kind.options).toEqual([...RUNTIME_KIND_VALUES]);
    expect(shape.repository_mode.options).toEqual(repositoryModeSchema.options);
  });

  test("only bypassPermissions stays bypass; every other mode is auto", () => {
    for (const mode of PERMISSION_MODE_VALUES) {
      expect([mode, executionModeOf(mode)]).toEqual([
        mode,
        mode === "bypassPermissions" ? "bypass" : "auto",
      ]);
    }
  });

  test("a spec is a pure function of its source and parses", () => {
    const spec = deriveRuntimeSpec(source);
    expect(runtimeSpecSchema.parse(spec)).toEqual(spec);
    expect(deriveRuntimeSpec(structuredClone(source))).toEqual(spec);
    expect(spec.execution_mode).toBe("auto");
    expect(spec).not.toHaveProperty("permission_mode");
    expect(spec).not.toHaveProperty("mcp_deny");
  });

  test("optional inputs reach the spec, an empty mcp_deny does not", () => {
    const spec = deriveRuntimeSpec({
      ...source,
      permission_mode: "bypassPermissions",
      project_settings: { claude_md: true },
      mcp_deny: ["mcp__docs__write"],
    });
    expect(spec.execution_mode).toBe("bypass");
    expect(spec.project_settings).toEqual({ claude_md: true });
    expect(spec.mcp_deny).toEqual(["mcp__docs__write"]);
    expect(deriveRuntimeSpec({ ...source, mcp_deny: [] })).not.toHaveProperty(
      "mcp_deny",
    );
  });

  test("a connection with no row yet still parses, with a null id", () => {
    const withoutRow = {
      ...source,
      connection: { ...source.connection, id: null },
    };
    expect(specSourceSchema.safeParse(withoutRow).success).toBe(true);
  });

  test.each([
    ["an unknown key", { ...source, secret: "x" }],
    [
      "a credential-shaped connection",
      { ...source, connection: { ...source.connection, auth: {} } },
    ],
    ["a release id version of 6", { ...source, release_id_version: 6 }],
    ["an unsupported derivation version", { ...source, derivation_version: 2 }],
    ["an empty model", { ...source, model: "" }],
  ])("a source with %s is refused", (_name, value) => {
    expect(specSourceSchema.safeParse(value).success).toBe(false);
  });

  test("a spec holding the legacy mode name is refused", () => {
    expect(
      runtimeSpecSchema.safeParse({
        ...deriveRuntimeSpec(source),
        permission_mode: "default",
      }).success,
    ).toBe(false);
  });
});
