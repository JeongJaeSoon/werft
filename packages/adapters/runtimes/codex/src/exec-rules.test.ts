import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_POLICY } from "@werft-ai/runtime-core";
import {
  EXEC_RULES_FILE,
  execRulesOf,
  prefixOf,
  renderExecRules,
  writeExecRules,
} from "./exec-rules.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("prefixOf", () => {
  test.each([
    ["git * --output*", ["git", "--output"]],
    ["git -C*", ["git", "-C"]],
    ["git add * -f*", ["git", "add", "-f"]],
    ["sed -*i*", ["sed", "-i"]],
    ["gh auth *", ["gh", "auth"]],
  ])("%s asks for its prefix", (pattern, prefix) => {
    expect(prefixOf(pattern)).toEqual(prefix);
  });

  test.each([
    ["a glob inside a token", "git add *.env*"],
    ["a token that only starts a word", "git config alias.*"],
    ["a path", "mkdir /*"],
    ["a climbing path", "mkdir *..*"],
    ["a single token", "git"],
    ["a quote", "sed *'w*"],
  ])("%s has no prefix form", (_name, pattern) => {
    expect(prefixOf(pattern)).toBeUndefined();
  });
});

describe("execRulesOf", () => {
  const { rules, unexpressed } = execRulesOf();

  test("allows every command the policy allows, as a whole-token prefix", () => {
    const allowed = rules
      .filter((rule) => rule.decision === "allow")
      .map((rule) => rule.pattern.join(" "));
    expect(allowed).toEqual([
      ...WORKSPACE_POLICY.git.allow,
      ...WORKSPACE_POLICY.read.allow,
      ...WORKSPACE_POLICY.fs.allow,
      ...WORKSPACE_POLICY.dev.commands,
    ]);
  });

  test("asks for the shapes a prefix can name, once each", () => {
    const prompts = rules
      .filter((rule) => rule.decision === "prompt")
      .map((rule) => rule.pattern.join(" "));
    expect(prompts).toContain("git --output");
    expect(prompts).toContain("git -C");
    expect(prompts).toContain("gh auth");
    expect(prompts).toContain("sed -i");
    expect(prompts).toContain("git worktree");
    expect(prompts).not.toContain("git switch");
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  test("lists what it could not express instead of writing a wrong rule", () => {
    expect(unexpressed).toContain("git config alias.*");
    expect(unexpressed).toContain("sed *w *");
    expect(unexpressed).toContain("mkdir /*");
    expect(unexpressed).toContain("git add *.env*");
    expect(
      rules.some((rule) => rule.pattern.some((token) => token.endsWith("."))),
    ).toBe(false);
  });

  test("refuses a policy whose ask would cover a whole allowed command", () => {
    const policy = structuredClone(WORKSPACE_POLICY);
    policy.dev.commands = [...policy.dev.commands, "make check"];
    policy.git.ask = [...policy.git.ask, "make check*"];
    expect(() => execRulesOf(policy)).toThrow(
      /would ask for all of make check/,
    );
  });

  test("renders one prefix_rule per rule", () => {
    const text = renderExecRules([
      { pattern: ["git"], decision: "allow" },
      { pattern: ["git", "-C"], decision: "prompt" },
    ]);
    expect(text).toContain('prefix_rule(pattern=["git"], decision="allow")');
    expect(text).toContain(
      'prefix_rule(pattern=["git","-C"], decision="prompt")',
    );
  });
});

describe("writeExecRules", () => {
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    made.push(dir);
    return dir;
  };

  test("leaves only the platform's file in the rules directory", () => {
    const dir = home();
    mkdirSync(join(dir, "rules"));
    writeFileSync(
      join(dir, "rules", "session.rules"),
      'prefix_rule(pattern=["rm"], decision="allow")\n',
    );
    writeExecRules(dir, "untrusted");
    expect(existsSync(join(dir, "rules", "session.rules"))).toBe(false);
    expect(readFileSync(join(dir, "rules", EXEC_RULES_FILE), "utf8")).toBe(
      renderExecRules(execRulesOf().rules),
    );
  });

  test("writes nothing when approval is never, where a prompt rule would refuse", () => {
    const dir = home();
    writeExecRules(dir, "untrusted");
    writeExecRules(dir, "never");
    expect(existsSync(join(dir, "rules"))).toBe(false);
  });

  test("writes the rules for auto mode, which asks for approvals", () => {
    const dir = home();
    writeExecRules(dir, "on-request");
    expect(readFileSync(join(dir, "rules", EXEC_RULES_FILE), "utf8")).toBe(
      renderExecRules(execRulesOf().rules),
    );
  });
});
