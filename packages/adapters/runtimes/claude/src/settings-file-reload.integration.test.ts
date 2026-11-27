import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { ClaudeSdkRuntime, engineSettingsPath } from "./runtime.ts";

// Bash runs as the engine's own user, so a session can rewrite the
// `--settings` file the launcher wrote for it; the file's Edit deny stops a
// plain copy but not a write whose target the engine cannot read off the
// command. What such a rewrite is worth depends on whether the pinned engine
// reads the file again while it runs. These tests measure that: a deny rule
// added between turns, by the test or by the session's own Bash.

const MODEL = "claude-sonnet-4-5";
const DENY_LATER = "Bash(mkdir later-dir)";
// How long a rewrite has to be noticed before the next turn; 15 s measured
// the same.
const SETTLE_MS = 4_000;

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

type Turn = { command: string; id: string };

function lastPrompt(messages: Array<{ content?: unknown; role?: string }>) {
  const last = messages.at(-1);
  if (last?.role !== "user") return undefined;
  if (typeof last.content === "string") return last.content;
  if (!Array.isArray(last.content)) return undefined;
  const blocks = last.content as Array<{ text?: string; type?: string }>;
  if (blocks.some((block) => block.type === "tool_result")) return undefined;
  return blocks.filter((block) => block.type === "text").at(-1)?.text;
}

async function run(input: {
  turns: Turn[] | ((settingsPath: string) => Turn[]);
  /** Runs after the turn of that index settles, before the next starts. */
  between?: (path: string, after: number) => void;
}) {
  isolated = await createIsolatedWorkspace({ prefix: "settings-reload-" });
  const { home, workspace } = isolated;
  const path = join(home, "launcher-settings.json");
  const turns =
    typeof input.turns === "function" ? input.turns(path) : input.turns;
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
    const turn = turns.find((t) => lastPrompt(messages) === t.id);
    return turn === undefined
      ? textReply("done")
      : toolReply(
          "Bash",
          { command: turn.command, description: turn.id },
          `toolu_${turn.id}`,
        );
  });
  const config: ClaudeRuntimeConfig = {
    claudeConfigDir: home,
    correlationId: "settings-reload",
    cwd: workspace,
    home,
    maxTurns: 5,
    mode: "new",
    model: MODEL,
    permissionMode: "bypassPermissions",
    profile: {
      kind: "anthropic",
      endpoint: server.url,
      auth: { kind: "api_key", value: "placeholder-local" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: [],
    tools: ["Bash"],
  };
  if (engineSettingsPath(config) !== path) {
    throw new Error("the launcher writes the settings somewhere else");
  }
  const runtime = new ClaudeSdkRuntime({
    endpoints: [server.url],
    models: [MODEL],
  }).start(config, {
    onPermission: async () => ({ behavior: "deny", message: "needs a person" }),
  });
  let settled = 0;
  const consume = (async () => {
    for await (const frame of runtime) {
      if (frame.envelope.message.type !== "result") continue;
      input.between?.(path, settled);
      settled += 1;
      const next = turns[settled];
      if (next === undefined) {
        runtime.finishInput();
        continue;
      }
      await Bun.sleep(SETTLE_MS);
      runtime.send({ message: next.id, uuid: crypto.randomUUID() });
    }
  })();
  const first = turns[0];
  if (first === undefined) throw new Error("no turns");
  runtime.send({ message: first.id, uuid: crypto.randomUUID() });
  await consume;
  return {
    made: (dir: string) => existsSync(join(workspace, dir)),
    path,
    results,
  };
}

const withLaterDeny = (text: string) => {
  const file = JSON.parse(text) as { permissions: { deny: string[] } };
  file.permissions.deny.push(DENY_LATER);
  return `${JSON.stringify(file, null, 2)}\n`;
};

describe("the engine's --settings file during a session", () => {
  test("a deny rule written into the file between turns is not read", async () => {
    let rewritten = "";
    const { made, path } = await run({
      between: (file, after) => {
        if (after !== 0) return;
        writeFileSync(file, withLaterDeny(readFileSync(file, "utf8")));
        rewritten = readFileSync(file, "utf8");
      },
      turns: [
        { id: "first", command: "mkdir first-dir" },
        { id: "later", command: "mkdir later-dir" },
      ],
    });
    expect(rewritten).toContain(DENY_LATER);
    expect(readFileSync(path, "utf8")).toBe(rewritten);
    expect(made("first-dir")).toBe(true);
    expect(made("later-dir")).toBe(true);
  }, 120_000);

  test("a deny rule the session's own Bash writes into the file is not read", async () => {
    const { made, path, results } = await run({
      between: (file, after) => {
        // The next turn's Bash copies this over the file.
        if (after === 0) {
          writeFileSync(
            `${file}.patched`,
            withLaterDeny(readFileSync(file, "utf8")),
          );
        }
      },
      turns: (file) => [
        { id: "first", command: "mkdir first-dir" },
        // The engine sees a plain copy onto the file and denies it...
        { id: "copy", command: `cp '${file}.patched' '${file}'` },
        // ...but not a write it cannot read the target of.
        {
          id: "rewrite",
          command: `python3 -c 'import shutil,sys; shutil.copy(sys.argv[1], sys.argv[2])' '${file}.patched' '${file}'`,
        },
        { id: "later", command: "mkdir later-dir" },
      ],
    });
    // `cp` is an allowed command, so the engine reads its target and names
    // the deny rule that holds it.
    expect(results.get("toolu_copy")).toContain("blocked by a deny rule");
    expect(results.get("toolu_rewrite")).not.toContain("denied");
    expect(readFileSync(path, "utf8")).toContain(DENY_LATER);
    expect(made("first-dir")).toBe(true);
    expect(made("later-dir")).toBe(true);
  }, 120_000);
});
