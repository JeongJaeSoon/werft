import { describe, expect, test } from "bun:test";
import {
  profileExecutionForm,
  sameExecutionForm,
} from "./profile-execution-form.ts";

const base = {
  runtime_kind: "claude",
  runtime_version: "1.0.0",
  model: "m-a",
  tools: ["Read", "Bash"],
  permission_mode: "default",
  provider: { kind: "anthropic" },
};

const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  sameExecutionForm(
    { definition: a, deny: null },
    { definition: b, deny: null },
  );

describe("sameExecutionForm", () => {
  test("an omitted models list equals one that holds only the model", () => {
    expect(same(base, { ...base, models: ["m-a"] })).toBe(true);
  });

  test("models are a set: order and the repeated default do not matter", () => {
    expect(
      same(
        { ...base, models: ["m-b", "m-c"] },
        { ...base, models: ["m-c", "m-a", "m-b"] },
      ),
    ).toBe(true);
  });

  test("tools are sorted", () => {
    expect(same(base, { ...base, tools: ["Bash", "Read"] })).toBe(true);
  });

  test("defaults for billing, project settings and empty rule lists", () => {
    expect(
      same(base, {
        ...base,
        provider: { kind: "anthropic", billing: "per_token" },
        project_settings: { claude_md: false },
        auto_mode_rules: [],
        title_model: undefined,
      }),
    ).toBe(true);
  });

  test("the repository mode is not part of the form", () => {
    expect(same(base, { ...base, repository: "none" })).toBe(true);
  });

  test.each([
    ["model", { model: "m-b" }],
    ["title model", { title_model: "m-t" }],
    ["an extra allowed model", { models: ["m-a", "m-z"] }],
    ["a tool", { tools: ["Read"] }],
    ["billing", { provider: { kind: "anthropic", billing: "none" } }],
    ["claude_md", { project_settings: { claude_md: true } }],
    ["permission mode", { permission_mode: "plan" }],
    ["auto mode rules", { auto_mode_rules: ["allow x"] }],
  ])("a changed %s is a different form", (_name, change) => {
    expect(same(base, { ...base, ...change })).toBe(false);
  });

  test("the form is a stable string", () => {
    expect(profileExecutionForm(base)).toBe(
      profileExecutionForm(JSON.parse(JSON.stringify(base))),
    );
  });

  // Pinned text, not a comparison of the function with itself: a profile
  // with no `mcp__` deny must keep the form (and so the release id) it had.
  test("a profile with no mcp__ deny keeps its exact form", () => {
    const expected =
      '{"model":"m-a","models":["m-a"],"permission_mode":"default","project_settings":{"claude_md":false},"provider":{"billing":"per_token","kind":"anthropic"},"runtime_kind":"claude","runtime_version":"1.0.0","title_model":null,"tools":["Bash","Read"]}';
    expect(profileExecutionForm(base)).toBe(expected);
    expect(profileExecutionForm(base, [])).toBe(expected);
    expect(profileExecutionForm(base, ["Bash", "WebFetch"])).toBe(expected);
  });
});

describe("mcp__ deny in the execution form", () => {
  const withDeny = (deny: string[] | null) => ({ definition: base, deny });

  test("an mcp__ deny makes a different form, whichever way it is spelled", () => {
    expect(
      sameExecutionForm(withDeny(null), withDeny(["mcp__docs__read"])),
    ).toBe(false);
    expect(
      sameExecutionForm(
        withDeny(["mcp__docs__read", "mcp__a__b"]),
        withDeny(["mcp__a__b", "mcp__docs__read", "mcp__a__b"]),
      ),
    ).toBe(true);
  });

  test("catalog names in the deny column do not change the form", () => {
    expect(sameExecutionForm(withDeny(["WebFetch"]), withDeny(["Bash"]))).toBe(
      true,
    );
    expect(sameExecutionForm(withDeny([]), withDeny(null))).toBe(true);
  });

  test("the form carries the names as a sorted set", () => {
    expect(
      JSON.parse(profileExecutionForm(base, ["mcp__b__x", "mcp__a__y"])),
    ).toMatchObject({ mcp_deny: ["mcp__a__y", "mcp__b__x"] });
  });
});
