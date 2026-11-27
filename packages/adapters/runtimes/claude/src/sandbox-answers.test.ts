import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservedToolDecision } from "@werft-ai/runtime-core";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { buildSdkOptions } from "./runtime.ts";

// What the adapter answers for is read in runtime-core (asked-line.test.ts);
// here: which calls reach that reading, and what is recorded.
const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-answers-")));
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "notes"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The scene a person was asked about: a branch, then a workflow file. */
const OWNER =
  "git switch -c hello-actions sandbox/main && cat > .github/workflows/hello.yml <<'EOF'\nname: Hello\nEOF";
describe("the permission callback", () => {
  const configOf = (extra: Partial<ClaudeRuntimeConfig> = {}) =>
    ({
      claudeConfigDir: "/tenant/config",
      correlationId: "sandbox-answers",
      mode: "new",
      cwd: workspace,
      home: "/tenant/home",
      model: "primary",
      profile: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value: "placeholder" },
        principal: { ownerScope: "owner-a" },
      },
      tools: ["Bash", "Write", "Edit"],
      ...extra,
    }) as ClaudeRuntimeConfig;

  /** One call as the engine makes it: the gate, the ask, then the run. */
  async function call(
    tool: string,
    input: Record<string, unknown>,
    extra: Partial<ClaudeRuntimeConfig> = {},
    shell: string | null = workspace,
  ) {
    let asked = 0;
    const observed: ObservedToolDecision[] = [];
    const options = buildSdkOptions(
      configOf(extra),
      {
        onPermission: async () => {
          asked += 1;
          return { behavior: "deny", message: "needs a person" };
        },
      },
      undefined,
      undefined,
      undefined,
      { observe: (decision) => observed.push(decision) },
    );
    const hook = async (event: "PreToolUse" | "PostToolUse") => {
      const callback = options.hooks?.[event]?.[0]?.hooks[0];
      if (callback === undefined) throw new Error(`${event} hook is required`);
      await callback(
        {
          hook_event_name: event,
          tool_name: tool,
          tool_input: input,
          tool_use_id: "tool-1",
          cwd: shell,
        } as never,
        "tool-1",
        { signal: new AbortController().signal },
      );
    };
    if (shell !== null) await hook("PreToolUse");
    const answer = await options.canUseTool?.(tool, input, {
      requestId: "request-1",
      signal: new AbortController().signal,
      toolUseID: "tool-1",
    } as never);
    if (answer?.behavior === "allow") await hook("PostToolUse");
    return {
      asked,
      behavior: answer?.behavior,
      audit: observed.map(({ decision, basis }) => `${decision}:${basis}`),
    };
  }
  const bash = (
    command: string,
    extra: Partial<ClaudeRuntimeConfig> = {},
    shell: string | null = workspace,
    more: Record<string, unknown> = {},
  ) => call("Bash", { command, ...more }, extra, shell);
  const TEE = "echo alpha | tee notes/a.txt";
  const FORCED = "git status && git add -f notes/sample.txt";

  test("a line the policy does not keep runs without a person, recorded as the sandbox's", async () => {
    for (const command of [OWNER, TEE, "curl -s https://example.test"]) {
      expect(await bash(command)).toEqual({
        asked: 0,
        behavior: "allow",
        audit: ["allow:sandbox_boundary"],
      });
    }
  });

  test("a file write inside the workspace runs without a person; a kept path asks", async () => {
    const write = (path: string, extra: Partial<ClaudeRuntimeConfig> = {}) =>
      call("Write", { file_path: path, content: "x" }, extra);
    expect(await write(join(workspace, ".vscode", "settings.json"))).toEqual({
      asked: 0,
      behavior: "allow",
      audit: ["allow:sandbox_boundary"],
    });
    expect((await write(join(workspace, ".env"))).asked).toBe(1);
    expect((await write(join(root, "outside.txt"))).asked).toBe(1);
    expect(
      (
        await call("Edit", {
          file_path: join(workspace, ".git", "config"),
          old_string: "a",
          new_string: "b",
        })
      ).asked,
    ).toBe(1);
    // In auto the classifier stands behind the ask.
    expect(
      (
        await write(join(workspace, ".vscode", "settings.json"), {
          permissionMode: "auto",
        })
      ).asked,
    ).toBe(1);
  });

  test.each<[string, string, Partial<ClaudeRuntimeConfig>, string | null]>([
    ["a part an ask rule names", FORCED, {}, workspace],
    ["a secret path written", "echo x > .env.local", {}, workspace],
    ["a path outside the workspace", "echo x > ../out.txt", {}, workspace],
    [
      "a release that denies a Bash shape",
      TEE,
      { disallowedTools: ["Bash(git push *)"] },
      workspace,
    ],
    [
      "a release that denies a file tool",
      TEE,
      { disallowedTools: ["Write"] },
      workspace,
    ],
    ["plan mode", TEE, { permissionMode: "plan" }, workspace],
    ["a call the gate never saw", TEE, {}, null],
    [
      "a command in no list, in auto mode",
      TEE,
      { permissionMode: "auto" },
      workspace,
    ],
    [
      "a runner, in auto mode",
      "git status && bun test notes",
      { permissionMode: "auto" },
      workspace,
    ],
    [
      "an ask rule, in auto mode",
      FORCED,
      { permissionMode: "auto" },
      workspace,
    ],
  ])("%s still goes to a person", async (_name, command, extra, shell) => {
    const { asked, behavior, audit } = await bash(command, extra, shell);
    expect([asked, behavior, audit]).toEqual([1, "deny", []]);
  });

  test("auto mode answers for a line that is plainly the policy's own work", async () => {
    expect(await bash(OWNER, { permissionMode: "auto" })).toEqual({
      asked: 0,
      behavior: "allow",
      audit: ["allow:sandbox_boundary"],
    });
  });

  test("a call that asks to leave the engine's sandbox still goes to a person", async () => {
    expect(
      (await bash(TEE, {}, workspace, { dangerouslyDisableSandbox: true }))
        .asked,
    ).toBe(1);
    expect(
      (await bash(TEE, {}, workspace, { run_in_background: true })).asked,
    ).toBe(0);
  });

  test("a deny rule for another tool leaves the answer to the policy", async () => {
    expect((await bash(TEE, { disallowedTools: ["WebSearch"] })).asked).toBe(0);
  });
});
