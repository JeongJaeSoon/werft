import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  type HookCallback,
  type Options,
  query,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeProcessObserver } from "@werft-ai/runtime-core";
import type { ClaudeRuntimeConfig } from "./config.ts";
import type { DriverRun, RuntimeHooks } from "./driver.ts";
import { modeSettings } from "./engine-settings.ts";
import { MEMORY_READ_GUIDANCE, readsOnlyMemory } from "./memory-read.ts";
import { MirrorProgress } from "./mirror-progress.ts";
import {
  ENGINE_API_KEY_DESCRIPTOR,
  engineApiKey,
  type RuntimePolicy,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "./profile.ts";
import { relayedToolDescriptions } from "./remote-mcp.ts";
import { systemPromptAppend } from "./repository-instructions.ts";
import { ResumedHistory } from "./resumed-history.ts";
import { ClaudeSdkRun, InputStream } from "./run.ts";
import { offerableRules } from "./session-rules.ts";
import { TurnLedger } from "./turn-ledger.ts";

const MIN_BUDGET_USD = 0.000001;

// The platform attributes commits and pull requests itself. Flag settings
// outrank a repository's `.claude/settings.json`, so a project cannot turn
// the engine's own signature back on.
const ENGINE_ATTRIBUTION_OFF = { commit: "", pr: "", sessionUrl: false };

// Not a person's refusal: the platform could not record that the
// checkpoint this turn waits on no longer holds once the tool runs.
const ADMISSION_GUARD_REFUSED =
  "The platform could not record that this tool is starting, so it was not run. This is not a user decision.";

/** The SDK driver `ClaudeAgentRuntime` wraps. */
export class ClaudeSdkRuntime {
  constructor(
    private readonly policy: RuntimePolicy,
    private readonly processObserver?: RuntimeProcessObserver,
  ) {}

  start(config: ClaudeRuntimeConfig, hooks: RuntimeHooks): DriverRun {
    validateRuntimeConfig(config, this.policy);
    const mirror =
      config.sessionStore === undefined ? undefined : new MirrorProgress();
    const { history, launched } = resumedHistory(
      mirror === undefined || config.sessionStore === undefined
        ? config
        : { ...config, sessionStore: mirror.watch(config.sessionStore) },
    );
    const input = new InputStream();
    const abortController = new AbortController();
    const ledger = new TurnLedger(config.resume);
    const sdkQuery = query({
      prompt: input,
      options: buildSdkOptions(
        launched,
        hooks,
        ledger,
        abortController,
        this.processObserver,
      ),
    });
    return new ClaudeSdkRun(
      config.correlationId,
      input,
      sdkQuery,
      abortController,
      history,
      ledger,
      () => relayedToolDescriptions(launched.mcpServers),
      mirror,
    );
  }
}

/** Where the transcript a resumed run continues comes from, read the way the engine reads it. */
function resumedHistory(config: ClaudeRuntimeConfig): {
  history: ResumedHistory;
  launched: ClaudeRuntimeConfig;
} {
  if (config.mode !== "resume") {
    return { history: ResumedHistory.empty(), launched: config };
  }
  if (config.sessionStore !== undefined) {
    const { history, store } = ResumedHistory.watching(config.sessionStore);
    return { history, launched: { ...config, sessionStore: store } };
  }
  // validateRuntimeConfig let a store-less resume through only as a local one.
  return {
    history: ResumedHistory.fromLocalDisk(
      config.claudeConfigDir,
      config.cwd,
      config.resume,
    ),
    launched: config,
  };
}

export function buildSdkOptions(
  config: ClaudeRuntimeConfig,
  hooks: RuntimeHooks,
  ledger = new TurnLedger(config.resume),
  abortController = new AbortController(),
  processObserver?: RuntimeProcessObserver,
): Options {
  const permittedTools = new Set(config.tools);
  const trustedTools = new Set(config.trustedTools ?? []);
  const bypass = config.permissionMode === "bypassPermissions";
  // Neither mode calls canUseTool for a call it lets through.
  const unattended = bypass || config.permissionMode === "auto";
  const settle: HookCallback = async (input) => {
    if ("tool_use_id" in input) ledger.toolSettled(input.tool_use_id);
    return {};
  };
  const append = [
    systemPromptAppend(config),
    unattended ? undefined : MEMORY_READ_GUIDANCE,
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
  return {
    abortController,
    canUseTool: async (tool, toolInput, options) => {
      // A denied tool never runs and no PostToolUse follows, so the gate
      // settles it here rather than waiting on a tool_result.
      const deny = (message: string) => {
        ledger.toolSettled(options.toolUseID);
        return {
          behavior: "deny" as const,
          message,
          toolUseID: options.toolUseID,
        };
      };
      if (!permittedTools.has(tool)) {
        return deny("Tool is outside the server allowlist");
      }
      // PreToolUse already admitted it past any checkpoint lease, and no
      // person is asked, so there is no prompt for the ledger to track.
      if (await readsOnlyMemory(config, tool, toolInput)) {
        return { behavior: "allow", toolUseID: options.toolUseID };
      }
      const admission = ledger.permissionStarting(options.toolUseID);
      if (!admission.allowed) return deny(admission.message);
      let allowed = false;
      try {
        // The engine says a rule would grant more than this ask's own verb.
        const suggestedRules = options.suppressAlwaysAllowRule
          ? []
          : offerableRules(options.suggestions, permittedTools, {
              tool,
              input: toolInput,
            });
        const decision = await hooks.onPermission({
          input: toolInput,
          requestId: options.requestId,
          signal: options.signal,
          tool,
          toolUseId: options.toolUseID,
          ...(suggestedRules.length === 0 ? {} : { suggestedRules }),
        });
        allowed = decision.behavior === "allow";
        return { ...decision, toolUseID: options.toolUseID };
      } finally {
        ledger.permissionSettled(options.toolUseID);
        if (!allowed) ledger.toolSettled(options.toolUseID);
      }
    },
    cwd: config.cwd,
    env: runtimeEnvironment(config),
    // The checkpoint quiescence gate. PreToolUse runs for
    // every tool before the permission check, auto-allowed ones included, so
    // it is where a checkpoint lease refuses a new writer; the other three
    // are the ways a tool it admitted can end. An allow answers nothing
    // except for a `trusted` tool, for which it is the point: "allow" here
    // skips the permission check.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (!("tool_use_id" in input)) return {};
              const deny = (reason: string) => ({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: reason,
                },
              });
              // The allowlist canUseTool enforces has to hold here too, in
              // every mode: a session rule lets the engine pass a call
              // without asking canUseTool at all, and a hook deny binds
              // whatever the mode or the rules say.
              if (
                "tool_name" in input &&
                !permittedTools.has(input.tool_name)
              ) {
                return deny("Tool is outside the server allowlist");
              }
              // A guard that lands while another is awaited is awaited too:
              // the call is admitted only past whichever the host holds now.
              let passed: ((id: string) => Promise<void>) | undefined;
              for (;;) {
                const guard = ledger.admissionGuard;
                if (guard === undefined || guard === passed) break;
                try {
                  await guard(input.tool_use_id);
                } catch {
                  return deny(ADMISSION_GUARD_REFUSED);
                }
                passed = guard;
              }
              const admission = ledger.toolStarting(input.tool_use_id);
              if (!admission.allowed) return deny(admission.message);
              // The one judgment this skips is the engine's permission
              // stage (a person's answer, the auto classifier). It comes
              // last so the allowlist, the admission guard and the ledger
              // record above still bind a trusted tool. Plan mode keeps
              // asking: it promises no side effects.
              if (
                "tool_name" in input &&
                trustedTools.has(input.tool_name) &&
                config.permissionMode !== "plan"
              ) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "allow" as const,
                  },
                };
              }
              return {};
            },
          ],
        },
      ],
      PostToolUse: [{ hooks: [settle] }],
      PostToolUseFailure: [{ hooks: [settle] }],
      PermissionDenied: [{ hooks: [settle] }],
    },
    ...(config.maxBudgetUsd === undefined
      ? {}
      : {
          // The engine refuses 0 and exits before its first request. A
          // micro-dollar, the smallest amount the platform counts, stops the
          // turn at its first request instead, which is what nothing left means.
          maxBudgetUsd: Math.max(config.maxBudgetUsd, MIN_BUDGET_USD),
        }),
    ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
    ...(config.mcpServers === undefined
      ? {}
      : { mcpServers: config.mcpServers as never }),
    model: config.model,
    pathToClaudeCodeExecutable: resolvePinnedClaudeExecutable(),
    permissionMode: config.permissionMode ?? "default",
    ...(bypass ? { allowDangerouslySkipPermissions: true } : {}),
    ...(config.plugins === undefined || config.plugins.length === 0
      ? {}
      : {
          plugins: config.plugins,
          // The platform owns MCP: a bundle's own MCP declarations never load.
          skipMcpDiscovery: true,
        }),
    pluginDelivery: "initialize",
    ...(config.mode === "resume" ? { resume: config.resume } : {}),
    // "eager" so a batch is durable within a frame of the local write: a
    // checkpoint taken at the end of a turn should not be waiting on a flush
    // the SDK would otherwise defer.
    ...(config.sessionStore === undefined
      ? {}
      : {
          sessionStore: config.sessionStore,
          sessionStoreFlush: "eager" as const,
        }),
    settings: {
      attribution: ENGINE_ATTRIBUTION_OFF,
      ...modeSettings({
        cwd: config.cwd,
        permissionMode: config.permissionMode,
        tools: permittedTools,
        trusted: trustedTools.size > 0,
      }),
    },
    settingSources: config.settingSources ?? ["project"],
    strictMcpConfig: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(append === "" ? {} : { append }),
      snapshot: true,
    },
    // The built-in set only; an MCP server's tools come with the server and
    // stay in the allowlist above.
    tools: config.tools.filter((tool) => !tool.startsWith("mcp__")),
    spawnClaudeCodeProcess: (options) =>
      spawnEngine(options, engineApiKey(config.profile), processObserver),
  };
}

/**
 * The engine under Bun.spawn, not node:child_process: Bun's node wrapper
 * closes an extra stdio socket a second time when it is collected, by then
 * on whatever descriptor reused the number. Bun.spawn hands the
 * extra socket over as a bare descriptor it closes once; we only write the
 * key down it, and the engine reads up to the newline.
 */
function spawnEngine(
  options: SpawnOptions,
  apiKey: string | undefined,
  processObserver: RuntimeProcessObserver | undefined,
): SpawnedProcess {
  const events = new EventEmitter();
  const child = Bun.spawn([options.command, ...options.args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    signal: options.signal,
    // The SDK reads stderr only from a process it spawned itself.
    stdio:
      apiKey === undefined
        ? ["pipe", "pipe", "ignore"]
        : ["pipe", "pipe", "ignore", "pipe"],
  });
  processObserver?.onSpawn(child.pid);
  // Not Bun's onExit, which may fire before spawn returns and so before the
  // SDK listens: `exited` settles no earlier than the next microtask.
  child.exited.then(
    () => {
      processObserver?.onExit?.(child.pid, child.exitCode, child.signalCode);
      events.emit("exit", child.exitCode, child.signalCode);
    },
    (error: unknown) => {
      if (events.listenerCount("error") > 0) events.emit("error", error);
    },
  );
  const descriptor = child.stdio[ENGINE_API_KEY_DESCRIPTOR];
  if (apiKey !== undefined && typeof descriptor === "number") {
    const line = Buffer.from(`${apiKey}\n`);
    try {
      let written = 0;
      while (written < line.length) {
        const count = writeSync(descriptor, line, written);
        if (count === 0) throw new Error("key descriptor accepted nothing");
        written += count;
      }
    } catch {
      // An engine without its key line waits for it forever, or has
      // already gone; either way, stopping it is what reports the failure.
      child.kill();
    }
  }
  const input = child.stdin;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        input.write(chunk);
        Promise.resolve(input.flush()).then(() => callback(), callback);
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try {
        Promise.resolve(input.end()).then(() => callback(), callback);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  return {
    stdin,
    stdout: Readable.fromWeb(child.stdout as unknown as WebReadableStream),
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => {
      child.kill(signal);
      return true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) =>
      void events.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) =>
      void events.once(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) =>
      void events.off(event, listener),
  } as SpawnedProcess;
}

export type { RuntimeProcessObserver };

export function resolvePinnedClaudeExecutable(): string {
  const { platform, arch } = process;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Claude Code architecture: ${arch}`);
  }
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  try {
    return Bun.resolveSync(`${packageName}/claude`, import.meta.dir);
  } catch (error) {
    if (platform !== "linux") throw error;
    return Bun.resolveSync(`${packageName}-musl/claude`, import.meta.dir);
  }
}
