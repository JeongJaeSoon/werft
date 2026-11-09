import { describe, expect, test } from "bun:test";

import {
  PERMISSION_RULE_MAX_LENGTH,
  PERMISSION_RULES_MAX,
  parsePermissionRule,
  parsePermissionRules,
} from "./permission-rules.ts";
import type { ToolCatalogView } from "./profile-tools.ts";

const catalog: ToolCatalogView = {
  id: "test@1",
  tools: [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash",
    "WebFetch",
    "WebSearch",
    "Agent",
    "TaskStop",
  ].map((name) => ({ name, boundary: "local" as const })),
  aliases: { Task: "Agent", KillShell: "TaskStop" },
};

const parsed = (rule: string) => {
  const result = parsePermissionRule(catalog, rule);
  if ("refusal" in result) throw new Error(result.refusal.message);
  return result.parsed;
};
const refusedAs = (rule: string) => {
  const result = parsePermissionRule(catalog, rule);
  return "refusal" in result ? result.refusal.reason_code : "accepted";
};

describe("parsePermissionRule", () => {
  test("a whole catalog tool is stored under its current name", () => {
    expect(parsed("WebSearch")).toEqual({
      rule: "WebSearch",
      kind: "tool",
      tool: "WebSearch",
    });
    expect(parsed("Task").rule).toBe("Agent");
    expect(parsed("KillShell").rule).toBe("TaskStop");
  });

  test("the scoped shapes the engine documents are taken", () => {
    expect(parsed("Bash(git push:*)").kind).toBe("pattern");
    expect(parsed("Bash(npm test)").rule).toBe("Bash(npm test)");
    expect(parsed("Read(./.env)").tool).toBe("Read");
    expect(parsed("Edit(./infra/**)").tool).toBe("Edit");
    expect(parsed("WebFetch(domain:example.com)").rule).toBe(
      "WebFetch(domain:example.com)",
    );
  });

  test("a rule on a tool the catalog lacks has no effect and is refused", () => {
    expect(refusedAs("NoSuchTool")).toBe("rule_no_effect");
    expect(refusedAs("Glob(src/**)")).toBe("rule_no_effect");
    expect(refusedAs("Agent(x)")).toBe("rule_no_effect");
  });

  test("a glob over tool names is refused, so is an empty argument", () => {
    expect(refusedAs("B*")).toBe("rule_syntax");
    expect(refusedAs("mcp__*")).toBe("rule_syntax");
    expect(refusedAs("Bash()")).toBe("rule_syntax");
    expect(refusedAs("Bash(*)")).toBe("rule_syntax");
    expect(refusedAs("")).toBe("rule_syntax");
    expect(refusedAs("Bash(a\nb)")).toBe("rule_syntax");
  });

  test("WebFetch takes only a plain host", () => {
    expect(refusedAs("WebFetch(example.com)")).toBe("rule_syntax");
    expect(refusedAs("WebFetch(domain:)")).toBe("rule_syntax");
    expect(refusedAs("WebFetch(domain:a b)")).toBe("rule_syntax");
  });

  test("an MCP tool is a whole name or nothing", () => {
    expect(parsed("mcp__docs__read")).toEqual({
      rule: "mcp__docs__read",
      kind: "mcp",
      tool: "mcp__docs__read",
    });
    // `()*:` are part of an MCP tool's name, matched exactly by the platform's
    // own path; only a name that is not server__tool is refused.
    expect(refusedAs("mcp__docs")).toBe("rule_syntax");
    expect(refusedAs("mcp__docs__read(x)")).toBe("accepted");
  });

  test("a root-relative path is kept and flagged, a double slash is not", () => {
    expect(parsed("Read(/etc/passwd)").warning).toBe("path_root_relative");
    expect(parsed("Read(//etc/passwd)").warning).toBeUndefined();
    expect(parsed("Read(./x)").warning).toBeUndefined();
  });

  test("a rule over the length limit is refused", () => {
    expect(refusedAs(`Bash(${"a".repeat(PERMISSION_RULE_MAX_LENGTH)})`)).toBe(
      "rule_too_long",
    );
  });
});

describe("parsePermissionRules", () => {
  test("repeats collapse, aliases included, in the order given", () => {
    const result = parsePermissionRules(catalog, [
      "WebSearch",
      "Task",
      "Agent",
      "WebSearch",
    ]);
    expect("rules" in result && result.rules.map((r) => r.rule)).toEqual([
      "WebSearch",
      "Agent",
    ]);
  });

  test("the list is capped as a whole", () => {
    const many = Array.from(
      { length: PERMISSION_RULES_MAX + 1 },
      (_, i) => `Bash(cmd${i})`,
    );
    const result = parsePermissionRules(catalog, many);
    expect("refusal" in result && result.refusal.reason_code).toBe(
      "too_many_rules",
    );
    expect("rules" in parsePermissionRules(catalog, many.slice(1))).toBe(true);
  });

  test("the first bad rule is the one reported", () => {
    const result = parsePermissionRules(catalog, ["WebSearch", "B*", "Nope"]);
    expect("refusal" in result && result.refusal.rule).toBe("B*");
  });
});
