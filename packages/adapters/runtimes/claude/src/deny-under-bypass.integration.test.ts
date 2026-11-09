import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

// Measures what the engine does with a settings `permissions.deny` rule when
// permission mode is bypassPermissions, because the profile-removal design
// moves workspace deny rules into engine settings and relies on them holding
// under the `bypass` execution mode. The rules reach the engine here through
// the repository's own project settings, a source the engine merges like any
// other; the flag-settings path the design uses is a higher-precedence source
// of the same rule type.

const MODEL = "claude-sonnet-4-5";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

type Step = {
  id: string;
  input: (workspace: string) => Record<string, unknown>;
  name: string;
  /** The file the call creates, read from the disk afterwards. */
  creates: string;
};

const touch = (id: string, command: string, creates: string): Step => ({
  creates,
  id,
  input: () => ({ command, description: id }),
  name: "Bash",
});

const steps: Step[] = [
  touch("control_unlisted", "touch control.txt", "control.txt"),
  touch("deny_exact_pattern", "touch denied.txt", "denied.txt"),
  touch(
    "deny_in_compound",
    "echo start && touch denied-compound.txt",
    "denied-compound.txt",
  ),
  touch("deny_after_pipe", "echo x | tee denied-pipe.txt", "denied-pipe.txt"),
  {
    creates: "write-denied.txt",
    id: "deny_whole_tool",
    input: (w) => ({
      content: "x\n",
      file_path: join(w, "write-denied.txt"),
    }),
    name: "Write",
  },
];

const DENY = [
  "Bash(touch denied.txt)",
  "Bash(touch denied-compound.txt)",
  "Bash(tee denied-pipe.txt)",
  "Write",
];

async function run(permissionMode: PermissionMode, deny: string[]) {
  isolated = await createIsolatedWorkspace({ prefix: "deny-bypass-" });
  const { home, workspace } = isolated;
  await mkdir(join(workspace, ".claude"), { recursive: true });
  await writeFile(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify({ permissions: { deny } }),
  );
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
      : toolReply(next.name, next.input(workspace), `toolu_${next.id}`);
  });
  const asked = new Set<string>();
  const runtime = new ClaudeSdkRuntime({
    endpoints: [server.url],
    models: [MODEL],
  }).start(
    {
      claudeConfigDir: home,
      correlationId: "deny-bypass",
      cwd: workspace,
      home,
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
      settingSources: ["project"],
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
  return { asked, results, workspace };
}

const filesCreated = (workspace: string) =>
  Object.fromEntries(
    steps.map((step) => [step.id, existsSync(join(workspace, step.creates))]),
  );

describe("settings deny rules under a permission mode", () => {
  test("bypassPermissions: the deny rules still stop the call, an unlisted one runs", async () => {
    const { asked, results, workspace } = await run("bypassPermissions", DENY);
    const ran = filesCreated(workspace);
    expect(ran.control_unlisted).toBe(true);
    expect(ran.deny_exact_pattern).toBe(false);
    expect(ran.deny_in_compound).toBe(false);
    expect(ran.deny_after_pipe).toBe(false);
    expect(ran.deny_whole_tool).toBe(false);
    // Stopped by the rule, not by something else in the sandbox and not by
    // the permission callback: bypass never reaches it for a call it lets by.
    for (const id of [
      "deny_exact_pattern",
      "deny_in_compound",
      "deny_after_pipe",
    ]) {
      expect([id, results.get(`toolu_${id}`)]).toEqual([
        id,
        expect.stringContaining("has been denied"),
      ]);
    }
    expect(asked.size).toBe(0);
    expect(results.get("toolu_deny_whole_tool")).toContain(
      "No such tool available: Write",
    );
  }, 120_000);

  // Without the rules the same calls run, so the test above cannot pass by
  // the calls failing for another reason.
  test("bypassPermissions without deny rules: every call runs", async () => {
    const { workspace } = await run("bypassPermissions", []);
    const ran = filesCreated(workspace);
    expect(ran.control_unlisted).toBe(true);
    expect(ran.deny_exact_pattern).toBe(true);
    expect(ran.deny_in_compound).toBe(true);
    expect(ran.deny_after_pipe).toBe(true);
    expect(ran.deny_whole_tool).toBe(true);
  }, 120_000);
});
