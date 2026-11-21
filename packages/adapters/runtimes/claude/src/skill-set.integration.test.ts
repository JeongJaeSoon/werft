import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import type { ClaudeRuntimeConfig } from "./config.ts";
import type { AgentFrame, DriverRun } from "./driver.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

/**
 * The start check against the pinned engine: what it lists, what the model
 * is shown, and that a session it refuses runs no tool even when the model
 * asks for one before the check ends.
 */

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;
afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

function writeSkill(plugin: string, name: string, flags = ""): void {
  mkdirSync(join(plugin, "skills", name), { recursive: true });
  writeFileSync(
    join(plugin, "skills", name, "SKILL.md"),
    `---\ndescription: "skill-set-probe-${name}"\n${flags}---\nbody\n`,
  );
}

const HIDDEN = "user-invocable: false\n";

async function session(): Promise<{
  plugin: string;
  workspace: string;
  config: ClaudeRuntimeConfig;
}> {
  isolated = await createIsolatedWorkspace({ prefix: "94s-1896-" });
  const { home, workspace } = isolated;
  const plugin = join(home, "lint-plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "lint" }),
  );
  writeSkill(plugin, "fix");
  writeSkill(plugin, "helper", HIDDEN);
  writeSkill(plugin, "manual", "disable-model-invocation: true\n");
  return {
    plugin,
    workspace,
    config: {
      claudeConfigDir: home,
      correlationId: "skill-set",
      mode: "new",
      cwd: workspace,
      home,
      maxTurns: 4,
      model: "claude-sonnet-4-5",
      permissionMode: "bypassPermissions",
      profile: {
        kind: "anthropic",
        endpoint: "",
        auth: { kind: "api_key", value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      identities: { plugins: { [plugin]: "digest-1" } },
      plugins: [{ type: "local", path: plugin }],
      settingSources: [],
      tools: ["Skill", "Write"],
    },
  };
}

function start(config: ClaudeRuntimeConfig, url: string): DriverRun {
  return new ClaudeSdkRuntime({
    endpoints: [url],
    models: ["claude-sonnet-4-5"],
  }).start(
    { ...config, profile: { ...config.profile, endpoint: url } },
    { onPermission: async () => ({ behavior: "allow" }) },
  );
}

/** Reads the run until its first result, then closes the input. */
function consume(run: DriverRun): Promise<AgentFrame[]> {
  return (async () => {
    const frames: AgentFrame[] = [];
    for await (const frame of run.events()) {
      frames.push(frame);
      if (frame.envelope.message.type === "result") run.finishInput();
    }
    return frames;
  })();
}

describe("the start check on the pinned engine", () => {
  test("a session whose engine shows exactly its skills starts, and the model is offered only them", async () => {
    const { config } = await session();
    server = startFakeAnthropicServer(() => textReply("done"));
    const run = start(config, server.url);
    const frames = consume(run);
    await run.ready();
    run.send({ message: "hello", uuid: crypto.randomUUID() });
    await frames;
    const asked = JSON.stringify(server.requests);
    expect(asked).toContain("skill-set-probe-fix");
    expect(asked).toContain("skill-set-probe-helper");
    // Only a person may call it, so the model is not offered it.
    expect(asked).not.toContain("skill-set-probe-manual");
    // One of the engine's bundled skills, listed without the filter.
    expect(asked).not.toContain("dataviz");
  }, 60_000);

  test("a session with no skills attached is offered none, even with the Skill tool", async () => {
    const { config } = await session();
    const { plugins: _plugins, identities: _identities, ...bare } = config;
    server = startFakeAnthropicServer(() => textReply("done"));
    const run = start(bare, server.url);
    const frames = consume(run);
    await run.ready();
    run.send({ message: "hello", uuid: crypto.randomUUID() });
    await frames;
    const asked = JSON.stringify(server.requests);
    expect(asked).toContain("hello");
    expect(asked).not.toContain("dataviz");
  }, 60_000);

  test("a hidden skill the session did not attach fails the start, and the tool the model asked for first never runs", async () => {
    const { config, plugin, workspace } = await session();
    const target = join(workspace, "written-by-the-model.txt");
    server = startFakeAnthropicServer((request) =>
      JSON.stringify(request.body.messages).includes("tool_result")
        ? textReply("done")
        : toolReply("Write", { file_path: target, content: "ran" }),
    );
    const run = start(config, server.url);
    // After the adapter read the tree, before the engine loads it.
    writeSkill(plugin, "secret", HIDDEN);
    const frames = consume(run);
    // Sent ahead of the check, which a host never does, so the gate is what
    // stands between the model's call and the tool.
    run.send({ message: "write the file", uuid: crypto.randomUUID() });
    await expect(run.ready()).rejects.toThrow(
      "skill_set_mismatch: the engine's model-invocable skills differ from the session's skills (not attached lint:secret)",
    );
    await frames;
    expect(existsSync(target)).toBe(false);
    const results = JSON.stringify(server.requests.at(-1)?.body.messages);
    expect(results).toContain(
      "The engine's skills did not match the session's, so no tool runs in it.",
    );
  }, 60_000);
});
