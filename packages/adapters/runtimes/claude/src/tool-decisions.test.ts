import { describe, expect, test } from "bun:test";
import type { ObservedToolDecision } from "@werft-ai/runtime-core";
import type { ClaudeRuntimeConfig, PermissionMode } from "./config.ts";
import { buildSdkOptions } from "./runtime.ts";
import { TurnLedger } from "./turn-ledger.ts";

const PUSH = "mcp__github__request_push";

function configOf(
  extra: { permissionMode?: PermissionMode; trustedTools?: string[] } = {},
): ClaudeRuntimeConfig {
  return {
    claudeConfigDir: "/tenant/config",
    correlationId: "tool-decisions",
    mode: "new",
    cwd: "/workspace",
    home: "/tenant/home",
    model: "primary",
    profile: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", value: "placeholder" },
      principal: { ownerScope: "owner-a" },
    },
    tools: ["Read", "Bash", PUSH],
    ...extra,
  };
}

type Hooks = Parameters<typeof buildSdkOptions>[1];

// Everything a test needs to drive the adapter the way the engine does.
function rig(
  config: ClaudeRuntimeConfig,
  hooks: Hooks = { onPermission: async () => ({ behavior: "allow" }) },
  observe: (decision: ObservedToolDecision) => void = () => {},
  ledger = new TurnLedger("s1"),
) {
  const observed: ObservedToolDecision[] = [];
  const options = buildSdkOptions(
    config,
    hooks,
    ledger,
    new AbortController(),
    undefined,
    {
      observe: (decision) => {
        observed.push(decision);
        observe(decision);
      },
    },
  );
  const hook = (
    event: "PreToolUse" | "PostToolUse" | "PermissionDenied",
    tool: string,
    input: Record<string, unknown>,
    id: string,
  ) => {
    const callback = options.hooks?.[event]?.[0]?.hooks[0];
    if (callback === undefined) throw new Error(`${event} hook is required`);
    return callback(
      {
        hook_event_name: event,
        tool_name: tool,
        tool_input: input,
        tool_use_id: id,
      } as never,
      id,
      { signal: new AbortController().signal },
    );
  };
  const ask = (tool: string, input: Record<string, unknown>, id: string) => {
    const canUseTool = options.canUseTool;
    if (canUseTool === undefined) throw new Error("canUseTool is required");
    return canUseTool(tool, input, {
      requestId: `request-${id}`,
      signal: new AbortController().signal,
      toolUseID: id,
    } as Parameters<typeof canUseTool>[2]);
  };
  return { observed, hook, ask, ledger };
}

const summary = (list: ObservedToolDecision[]) =>
  list.map((d) => [d.toolUseId, d.tool, d.decision, d.basis]);

describe("tool decisions the adapter reports", () => {
  test("a tool outside the allowlist is reported denied from either gate", async () => {
    const { observed, hook, ask } = rig(configOf());
    await ask("WebFetch", { url: "https://example.invalid" }, "toolu_1");
    await hook("PreToolUse", "WebFetch", {}, "toolu_2");
    expect(summary(observed)).toEqual([
      ["toolu_1", "WebFetch", "deny", "not_permitted"],
      ["toolu_2", "WebFetch", "deny", "not_permitted"],
    ]);
  });

  test("a refusal from the host's precheck or a checkpoint lease is a hook deny", async () => {
    const ledger = new TurnLedger("s1");
    const { observed, hook } = rig(
      configOf(),
      {
        onPermission: async () => ({ behavior: "allow" }),
        precheckTool: async (_tool, input) =>
          input.source_ref === "orphan" ? "unrelated_history" : null,
      },
      undefined,
      ledger,
    );
    await hook("PreToolUse", "Read", { source_ref: "orphan" }, "toolu_1");
    await hook("PreToolUse", "Read", { source_ref: "main" }, "toolu_2");
    await hook("PostToolUse", "Read", { source_ref: "main" }, "toolu_2");
    const grant = ledger.leaseCheckpoint();
    await hook("PreToolUse", "Read", {}, "toolu_3");
    grant.lease?.release();
    expect(summary(observed)).toEqual([
      ["toolu_1", "Read", "deny", "hook_deny"],
      ["toolu_2", "Read", "unknown", "engine_internal"],
      ["toolu_3", "Read", "deny", "hook_deny"],
    ]);
  });

  test("a trusted tool is credited when it ran, not when the adapter let it pass", async () => {
    const { observed, hook } = rig(configOf({ trustedTools: [PUSH] }));
    await hook("PreToolUse", PUSH, { branch: "x" }, "toolu_1");
    expect(observed).toEqual([]);
    await hook("PostToolUse", PUSH, { branch: "x" }, "toolu_1");
    expect(summary(observed)).toEqual([
      ["toolu_1", PUSH, "allow", "trusted_tool"],
    ]);
  });

  test("an unattended mode is credited at the end, and a refusal by the engine is no judgment of ours", async () => {
    const { observed, hook } = rig(
      configOf({ permissionMode: "bypassPermissions" }),
    );
    await hook("PreToolUse", "Bash", { command: "ls" }, "toolu_1");
    await hook("PostToolUse", "Bash", { command: "ls" }, "toolu_1");
    await hook("PreToolUse", "Bash", { command: "rm x" }, "toolu_2");
    await hook("PermissionDenied", "Bash", { command: "rm x" }, "toolu_2");
    // Settling twice credits once.
    await hook("PostToolUse", "Bash", { command: "ls" }, "toolu_1");
    expect(summary(observed)).toEqual([
      ["toolu_1", "Bash", "allow", "permission_mode"],
    ]);
  });

  test("a call a person is asked about is left to the approval report, not credited to the engine", async () => {
    const { observed, hook, ask } = rig(configOf());
    await hook("PreToolUse", "Bash", { command: "ls" }, "toolu_1");
    await ask("Bash", { command: "ls" }, "toolu_1");
    await hook("PostToolUse", "Bash", { command: "ls" }, "toolu_1");
    expect(observed).toEqual([]);
  });

  test("a call that never passed the gate is not credited by a stray result", async () => {
    const { observed, hook } = rig(configOf());
    await hook("PostToolUse", "Bash", { command: "ls" }, "toolu_ghost");
    expect(observed).toEqual([]);
  });

  test("the input the observer gets is redacted, never the raw secret", async () => {
    // Assembled at run time so no secret-shaped literal sits in the source.
    const secret = ["sk", "ant", "api03", "SYNTHETIC".repeat(5)].join("-");
    const command = `curl -H "x-api-key: ${secret}" https://example.invalid`;
    const { observed, hook, ask } = rig(configOf());
    await ask("WebFetch", { command }, "toolu_1");
    await hook("PreToolUse", "Bash", { command }, "toolu_2");
    await hook("PostToolUse", "Bash", { command }, "toolu_2");
    expect(observed).toHaveLength(2);
    expect(JSON.stringify(observed)).not.toContain(secret);
  });

  test("an observer that throws changes no answer", async () => {
    const { hook, ask } = rig(
      configOf({ trustedTools: [PUSH] }),
      undefined,
      () => {
        throw new Error("sink down");
      },
    );
    expect(await ask("WebFetch", {}, "toolu_1")).toMatchObject({
      behavior: "deny",
    });
    expect(await hook("PreToolUse", PUSH, {}, "toolu_2")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(await hook("PostToolUse", PUSH, {}, "toolu_2")).toEqual({});
  });

  test("an adapter built with no observer behaves as before", async () => {
    const options = buildSdkOptions(configOf(), {
      onPermission: async () => ({ behavior: "allow" }),
    });
    expect(options.canUseTool).toBeDefined();
  });
});
