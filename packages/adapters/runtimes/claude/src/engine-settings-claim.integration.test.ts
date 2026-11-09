import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { PermissionMode } from "./config.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

// The rules in a claim's `engine_settings` reach the pinned engine as inline
// settings and no repository file is involved (settingSources is empty), so
// this is the path the platform will use. `mkdir` is in the baseline's allow,
// which makes it a call that runs unasked unless the claim says otherwise.

const MODEL = "claude-sonnet-4-5";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

const steps = [
  { id: "control", dir: "control-dir" },
  { id: "denied", dir: "denied-dir" },
  { id: "asked", dir: "asked-dir" },
].map((step) => ({
  ...step,
  input: { command: `mkdir ${step.dir}`, description: step.id },
}));

const ENGINE_SETTINGS = {
  permissions: {
    deny: ["Bash(mkdir denied-dir)"],
    ask: ["Bash(mkdir asked-dir)"],
  },
};

async function run(permissionMode: PermissionMode, withClaim: boolean) {
  isolated = await createIsolatedWorkspace({ prefix: "engine-settings-" });
  const { home, workspace } = isolated;
  const results = new Map<string, string>();
  server = startFakeAnthropicServer((request) => {
    const messages = (request.body.messages ?? []) as Array<{
      content?: unknown;
      role?: string;
    }>;
    for (const message of messages) {
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content as Array<{
        content?: unknown;
        tool_use_id?: string;
        type?: string;
      }>) {
        if (block.type === "tool_result" && block.tool_use_id !== undefined) {
          results.set(block.tool_use_id, JSON.stringify(block.content));
        }
      }
    }
    const done = messages.filter(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) => (block as { type?: string }).type === "tool_use",
        ),
    ).length;
    const next = steps[done];
    return next === undefined
      ? textReply("done")
      : toolReply("Bash", next.input, `toolu_${next.id}`);
  });
  const asked = new Set<string>();
  const runtime = new ClaudeSdkRuntime({
    endpoints: [server.url],
    models: [MODEL],
  }).start(
    {
      claudeConfigDir: home,
      correlationId: "engine-settings",
      cwd: workspace,
      home,
      ...(withClaim ? { engineSettings: ENGINE_SETTINGS } : {}),
      maxTurns: steps.length + 3,
      mode: "new",
      model: MODEL,
      permissionMode,
      profile: {
        kind: "anthropic",
        endpoint: server.url,
        auth: { kind: "api_key", value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: [],
      tools: ["Read", "Write", "Edit", "Bash"],
    },
    {
      onPermission: async (request) => {
        asked.add(request.toolUseId);
        return { behavior: "deny", message: "needs a person" };
      },
    },
  );
  const consume = (async () => {
    for await (const _frame of runtime) {
    }
  })();
  runtime.send({ message: "go", uuid: crypto.randomUUID() });
  runtime.finishInput();
  await consume;
  return {
    asked,
    made: (dir: string) => existsSync(join(workspace, dir)),
    results,
  };
}

describe("a claim's engine_settings against the pinned engine", () => {
  test("default mode: the claim's deny stops a call the baseline allows, its ask sends one to a person", async () => {
    const { asked, made, results } = await run("default", true);
    expect(made("control-dir")).toBe(true);
    expect(made("denied-dir")).toBe(false);
    expect(made("asked-dir")).toBe(false);
    expect(results.get("toolu_denied")).toContain("has been denied");
    expect([...asked]).toEqual(["toolu_asked"]);
  }, 120_000);

  test("bypassPermissions: the claim's deny still stops the call", async () => {
    const { asked, made, results } = await run("bypassPermissions", true);
    expect(made("control-dir")).toBe(true);
    expect(made("denied-dir")).toBe(false);
    expect(results.get("toolu_denied")).toContain("has been denied");
    expect(asked.has("toolu_denied")).toBe(false);
  }, 120_000);

  // The same calls run when the claim carries nothing, so the tests above
  // cannot pass by the calls failing for another reason.
  test("default mode without a claim: all three run unasked", async () => {
    const { asked, made } = await run("default", false);
    expect(made("control-dir")).toBe(true);
    expect(made("denied-dir")).toBe(true);
    expect(made("asked-dir")).toBe(true);
    expect(asked.size).toBe(0);
  }, 120_000);
});
