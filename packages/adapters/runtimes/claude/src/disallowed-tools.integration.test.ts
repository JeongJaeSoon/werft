import { afterEach, describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { pinnedClaudeToolCatalog } from "@werft-ai/runtime-claude-codec";
import {
  type FakeAnthropicServer,
  type RecordedRequest,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { ClaudeRuntimeConfig, PermissionMode } from "./config.ts";
import { InputStream } from "./run.ts";
import { buildSdkOptions } from "./runtime.ts";

/**
 * `disallowedTools` against the pinned engine, in every permission mode: a
 * whole tool leaves the model's tool list, and a scoped rule refuses only the
 * calls it names, with no file written and no command run. The deny is a key
 * of its own beside the mode's settings, which auto and plan build without
 * permission rules, so a mode that dropped it would show here.
 */

const catalogTools = (pinnedClaudeToolCatalog()?.tools ?? []).map(
  (tool) => tool.name,
);
const MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "plan",
  "auto",
];
const DENIED_CALL = "toolu_denied_touch";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

function toolNames(request: RecordedRequest): string[] {
  return (request.body.tools ?? []).map(
    (tool) => (tool as { name?: string }).name ?? "",
  );
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join(" ");
  if (content !== null && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return "";
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function run(permissionMode: PermissionMode) {
  isolated = await createIsolatedWorkspace({ prefix: "disallowed-tools-" });
  const { home, workspace } = isolated;
  const denied = join(workspace, "denied.txt");
  const control = join(workspace, "control.txt");
  const results = new Map<string, { isError: boolean; text: string }>();
  const offered: string[][] = [];
  let calls = 0;
  server = startFakeAnthropicServer((request) => {
    for (const message of (request.body.messages ?? []) as Array<{
      content?: unknown;
    }>) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_result") continue;
        results.set(String(block.tool_use_id), {
          isError: block.is_error === true,
          text: textOf(block.content),
        });
      }
    }
    const first = JSON.stringify(
      (request.body.messages as Array<{ content?: unknown }>)?.[0]?.content ??
        "",
    );
    if (!first.includes("DENY_PROBE")) return textReply("auxiliary reply");
    offered.push(toolNames(request));
    calls += 1;
    if (calls === 1) {
      return toolReply(
        "Bash",
        { command: `touch ${denied}`, description: "denied probe" },
        DENIED_CALL,
      );
    }
    if (calls === 2) {
      return toolReply(
        "Bash",
        { command: `echo kept > ${control}`, description: "control probe" },
        "toolu_control_echo",
      );
    }
    return textReply("done");
  });
  const config: ClaudeRuntimeConfig = {
    claudeConfigDir: home,
    correlationId: "disallowed-tools-harness",
    mode: "new",
    cwd: workspace,
    home,
    maxTurns: 10,
    model: "claude-sonnet-4-5",
    permissionMode,
    profile: {
      kind: "anthropic",
      endpoint: server.url,
      auth: { kind: "api_key", value: "placeholder-local" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: [],
    tools: catalogTools,
    disallowedTools: ["WebSearch", "Bash(touch:*)"],
  };
  const abortController = new AbortController();
  const options = buildSdkOptions(
    config,
    { onPermission: async () => ({ behavior: "allow" }) },
    undefined,
    abortController,
  );
  const input = new InputStream();
  const consume = (async () => {
    for await (const message of query({ prompt: input, options })) {
      if (message.type === "result") input.finish();
    }
  })();
  input.push({
    message: "DENY_PROBE: run the scripted calls",
    uuid: crypto.randomUUID(),
  });
  const timer = setTimeout(() => abortController.abort(), 50_000);
  // A run that throws or is aborted fails the test: only a deny may explain
  // the missing file.
  await consume.finally(() => clearTimeout(timer));
  return {
    offered,
    denied: await exists(denied),
    control: await exists(control),
    controlText: await readFile(control, "utf8").catch(() => ""),
    result: results.get(DENIED_CALL),
  };
}

describe("disallowedTools against the pinned engine", () => {
  test.each(MODES)(
    "holds in permission mode %s",
    async (mode) => {
      const seen = await run(mode);
      // A whole-tool rule: the model is never offered it. The scoped rule
      // leaves Bash itself in the list.
      expect(seen.offered.length).toBeGreaterThan(0);
      for (const tools of seen.offered) {
        expect(tools).not.toContain("WebSearch");
        expect(tools).toContain("Bash");
        expect(tools).toContain("Read");
      }
      // The named call is refused and has no effect, whatever the mode.
      expect(seen.denied).toBe(false);
      expect(seen.result?.isError).toBe(true);
      expect(seen.result?.text).toMatch(/permission|denied|deny/i);
    },
    60_000,
  );

  test("a scoped rule refuses only what it names", async () => {
    const seen = await run("bypassPermissions");
    expect(seen.denied).toBe(false);
    expect(seen.control).toBe(true);
    expect(seen.controlText.trim()).toBe("kept");
  }, 60_000);
});
