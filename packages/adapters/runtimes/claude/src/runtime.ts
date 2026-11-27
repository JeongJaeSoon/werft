import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  type HookCallback,
  type Options,
  query,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  askedLineRefusal,
  keptForPerson,
  type RuntimeProcessObserver,
  type ToolDecisionObserver,
  writeKeptForPerson,
} from "@werft-ai/runtime-core";
import type { ClaudeRuntimeConfig } from "./config.ts";
import type { DriverRun, RuntimeHooks } from "./driver.ts";
import { modeSettings } from "./engine-settings.ts";
import { MirrorProgress } from "./mirror-progress.ts";
import { expectedPluginSkills } from "./plugin-skills.ts";
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
import { ToolDecisions } from "./tool-decisions.ts";
import { TurnLedger } from "./turn-ledger.ts";

const MIN_BUDGET_USD = 0.000001;

const FILE_WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];
const SHELLS_REMEMBERED = 1_000;

const SETTINGS_SCHEMA =
  "https://json.schemastore.org/claude-code-settings.json";

/**
 * Where a start's merged settings go: beside the engine's own state, outside
 * the checkout, so neither the repository nor its history carries them.
 */
export function engineSettingsPath(config: ClaudeRuntimeConfig): string {
  return join(config.claudeConfigDir, "launcher-settings.json");
}

/** Deny rules that keep the agent from editing the settings file it runs under. */
export function settingsFileDenyRules(path: string, home: string): string[] {
  const rules = [`Edit(/${path})`];
  const fromHome = relative(home, path);
  if (
    fromHome !== "" &&
    !fromHome.startsWith("..") &&
    !fromHome.startsWith(sep)
  ) {
    rules.unshift(`Edit(~/${fromHome})`);
  }
  return rules;
}

/**
 * Writes the settings to a fresh file and returns its path for the engine's
 * `--settings`. Rewritten on every start, so an edit made during a session
 * never outlives the engine that made it. The old file is removed first and
 * the new one created exclusively, so a link left in its place is not
 * followed.
 */
export function writeEngineSettings(
  config: ClaudeRuntimeConfig,
  settings: Record<string, unknown>,
): string {
  const path = engineSettingsPath(config);
  const permissions = (settings.permissions ?? {}) as { deny?: string[] };
  const file = {
    $schema: SETTINGS_SCHEMA,
    ...settings,
    permissions: {
      ...permissions,
      deny: [
        ...(permissions.deny ?? []),
        ...settingsFileDenyRules(path, config.home),
      ],
    },
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

// The platform attributes commits and pull requests itself. Flag settings
// outrank a repository's `.claude/settings.json`, so a project cannot turn
// the engine's own signature back on.
const ENGINE_ATTRIBUTION_OFF = { commit: "", pr: "", sessionUrl: false };

// The engine's `language` setting takes a language name, not a code.
const ENGINE_LANGUAGE_NAMES = {
  ko: "korean",
  en: "english",
  ja: "japanese",
} as const;

// Not a person's refusal: the platform could not record that the
// checkpoint this turn waits on no longer holds once the tool runs.
const ADMISSION_GUARD_REFUSED =
  "The platform could not record that this tool is starting, so it was not run. This is not a user decision.";

const SKILL_SET_UNCONFIRMED =
  "The engine's skills did not match the session's, so no tool runs in it. This is not a user decision.";

/** The SDK driver `ClaudeAgentRuntime` wraps. */
export class ClaudeSdkRuntime {
  constructor(
    private readonly policy: RuntimePolicy,
    private readonly processObserver?: RuntimeProcessObserver,
    private readonly launch: typeof query = query,
    private readonly toolDecisions?: ToolDecisionObserver,
  ) {}

  start(config: ClaudeRuntimeConfig, hooks: RuntimeHooks): DriverRun {
    validateRuntimeConfig(config, this.policy);
    const expectedSkills =
      config.plugins === undefined || config.plugins.length === 0
        ? undefined
        : expectedPluginSkills(config.plugins);
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
    const options = buildSdkOptions(
      launched,
      hooks,
      ledger,
      abortController,
      this.processObserver,
      this.toolDecisions,
    );
    const sdkQuery = this.launch({
      prompt: input,
      options: {
        ...options,
        settings: writeEngineSettings(
          launched,
          options.settings as Record<string, unknown>,
        ),
        // Leaves the engine's bundled skills out of the model's listing and
        // has its Skill tool refuse them; left out, the engine offers them all.
        skills: expectedSkills?.all ?? [],
      },
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
      expectedSkills,
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

// Marked as the person's so the model neither reads it as tool output nor
// dismisses it as an injection riding on one.
function approverNote(note: string): string {
  return `The user approved this tool call and gave you this instruction with the approval. Follow it from here on:\n${note}`;
}

export function buildSdkOptions(
  config: ClaudeRuntimeConfig,
  hooks: RuntimeHooks,
  ledger = new TurnLedger(config.resume),
  abortController = new AbortController(),
  processObserver?: RuntimeProcessObserver,
  toolDecisions?: ToolDecisionObserver,
): Options {
  const decisions = new ToolDecisions(toolDecisions);
  const trustedTools = new Set(config.trustedTools ?? []);
  const servedTools = new Set(config.servedTools ?? []);
  // The built-in `werft` server's tools are in no release's list.
  const permittedTools = new Set([...config.tools, ...servedTools]);
  const bypass = config.permissionMode === "bypassPermissions";
  // Neither mode calls canUseTool for a call it lets through.
  const unattended = bypass || config.permissionMode === "auto";
  const settings = {
    attribution: ENGINE_ATTRIBUTION_OFF,
    ...(config.responseLanguage === undefined
      ? {}
      : { language: ENGINE_LANGUAGE_NAMES[config.responseLanguage] }),
    ...modeSettings({
      cwd: config.cwd,
      permissionMode: config.permissionMode,
      trusted: trustedTools.size > 0,
    }),
  };
  const disallowed = [...(config.disallowedTools ?? [])];
  // The adapter answers the engine's asks for shell lines and file writes
  // itself (asked-line.ts in runtime-core). Not in plan mode, which has no
  // workspace rules, and not under a release that denies a shape of these
  // tools: a line the engine did not read was not matched against that deny.
  const answersAsks =
    "permissions" in settings &&
    !disallowed.some((rule) =>
      /^(Bash|Write|Edit|MultiEdit|NotebookEdit)\s*(\(|$)/.test(rule.trim()),
    );
  /** Where the engine's shell stood when it took each Bash call. */
  const shellAt = new Map<string, string>();
  // In auto the classifier stands behind an ask and is not overruled: only a
  // line that is plainly the policy's own work passes there.
  const narrow = config.permissionMode === "auto";
  const sandboxAnswers = (
    tool: string,
    input: Record<string, unknown>,
    shell: string | undefined,
  ): boolean => {
    if (tool === "Bash") {
      // A call that asks to leave the engine's sandbox is a person's.
      if (typeof input.command !== "string") return false;
      if (input.dangerouslyDisableSandbox === true) return false;
      const at = { workspace: config.cwd, shell };
      return (
        (narrow
          ? askedLineRefusal(input.command, at)
          : keptForPerson(input.command, at)) === null
      );
    }
    if (narrow || !FILE_WRITE_TOOLS.includes(tool)) return false;
    const path = input.file_path ?? input.notebook_path;
    return (
      typeof path === "string" && writeKeptForPerson(path, config.cwd) === null
    );
  };
  const notes = new Map<string, string>();
  const settle: HookCallback = async (input) => {
    if (!("tool_use_id" in input)) return {};
    shellAt.delete(input.tool_use_id);
    ledger.toolSettled(input.tool_use_id);
    decisions.ran(input.tool_use_id);
    const note = notes.get(input.tool_use_id);
    notes.delete(input.tool_use_id);
    if (note === undefined) return {};
    if (
      input.hook_event_name !== "PostToolUse" &&
      input.hook_event_name !== "PostToolUseFailure"
    ) {
      hooks.noteSettled?.(input.tool_use_id, false);
      return {};
    }
    hooks.noteSettled?.(input.tool_use_id, true);
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: approverNote(note),
      },
    };
  };
  const settleRefused: HookCallback = async (input) => {
    if ("tool_use_id" in input) {
      shellAt.delete(input.tool_use_id);
      if (notes.delete(input.tool_use_id)) {
        hooks.noteSettled?.(input.tool_use_id, false);
      }
      ledger.toolSettled(input.tool_use_id);
      decisions.refusedByEngine(input.tool_use_id);
    }
    return {};
  };
  const append = systemPromptAppend(config) ?? "";
  return {
    abortController,
    canUseTool: async (tool, toolInput, options) => {
      // A denied tool never runs and no PostToolUse follows, so the gate
      // settles it here rather than waiting on a tool_result.
      const deny = (message: string, basis: "not_permitted" | "hook_deny") => {
        ledger.toolSettled(options.toolUseID);
        decisions.decide({
          toolUseId: options.toolUseID,
          tool,
          input: toolInput,
          decision: "deny",
          basis,
        });
        return {
          behavior: "deny" as const,
          message,
          toolUseID: options.toolUseID,
        };
      };
      if (!permittedTools.has(tool)) {
        return deny("Tool is outside the server allowlist", "not_permitted");
      }
      const shell = shellAt.get(options.toolUseID);
      shellAt.delete(options.toolUseID);
      if (answersAsks && sandboxAnswers(tool, toolInput, shell)) {
        decisions.admitted(
          options.toolUseID,
          tool,
          toolInput,
          "sandbox_boundary",
        );
        return {
          behavior: "allow" as const,
          updatedInput: toolInput,
          toolUseID: options.toolUseID,
        };
      }
      const admission = ledger.permissionStarting(options.toolUseID);
      if (!admission.allowed) return deny(admission.message, "hook_deny");
      decisions.answeredElsewhere(options.toolUseID);
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
        if (decision.behavior === "allow") {
          const { note, ...engine } = decision;
          if (note !== undefined) notes.set(options.toolUseID, note);
          return { ...engine, toolUseID: options.toolUseID };
        }
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
              const toolName = "tool_name" in input ? input.tool_name : "";
              const toolInput =
                "tool_input" in input &&
                typeof input.tool_input === "object" &&
                input.tool_input !== null
                  ? (input.tool_input as Record<string, unknown>)
                  : {};
              const deny = (
                reason: string,
                basis: "not_permitted" | "hook_deny",
              ) => {
                decisions.decide({
                  toolUseId: input.tool_use_id,
                  tool: toolName,
                  input: toolInput,
                  decision: "deny",
                  basis,
                });
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: reason,
                  },
                };
              };
              if (!(await ledger.startConfirmed)) {
                return deny(SKILL_SET_UNCONFIRMED, "hook_deny");
              }
              // The allowlist canUseTool enforces has to hold here too, in
              // every mode: a session rule lets the engine pass a call
              // without asking canUseTool at all, and a hook deny binds
              // whatever the mode or the rules say.
              if (
                "tool_name" in input &&
                !permittedTools.has(input.tool_name)
              ) {
                return deny(
                  "Tool is outside the server allowlist",
                  "not_permitted",
                );
              }
              // The host's advice, before the call is admitted: a refusal
              // here is a call that never ran. A check that throws refuses
              // nothing.
              if ("tool_name" in input && hooks.precheckTool !== undefined) {
                const refusal = await hooks
                  .precheckTool(input.tool_name, toolInput)
                  .catch(() => null);
                if (refusal !== null) return deny(refusal, "hook_deny");
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
                  return deny(ADMISSION_GUARD_REFUSED, "hook_deny");
                }
                passed = guard;
              }
              const admission = ledger.toolStarting(input.tool_use_id);
              if (!admission.allowed)
                return deny(admission.message, "hook_deny");
              if (answersAsks && toolName === "Bash") {
                shellAt.set(input.tool_use_id, input.cwd);
                // A call whose end the engine never reports is forgotten.
                if (shellAt.size > SHELLS_REMEMBERED) {
                  const [oldest] = shellAt.keys();
                  if (oldest !== undefined) shellAt.delete(oldest);
                }
              }
              // The one judgment this skips is the engine's permission
              // stage (a person's answer, the auto classifier). It comes
              // last so the allowlist, the admission guard and the ledger
              // record above still bind a trusted tool. Plan mode keeps
              // asking: it promises no side effects.
              if (
                "tool_name" in input &&
                (trustedTools.has(input.tool_name) ||
                  servedTools.has(input.tool_name)) &&
                config.permissionMode !== "plan"
              ) {
                decisions.admitted(
                  input.tool_use_id,
                  input.tool_name,
                  toolInput,
                  "trusted_tool",
                );
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "allow" as const,
                  },
                };
              }
              decisions.admitted(
                input.tool_use_id,
                toolName,
                toolInput,
                unattended ? "permission_mode" : "engine_internal",
              );
              return {};
            },
          ],
        },
      ],
      PostToolUse: [{ hooks: [settle] }],
      PostToolUseFailure: [{ hooks: [settle] }],
      PermissionDenied: [{ hooks: [settleRefused] }],
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
          plugins: config.plugins.map((plugin) => ({
            ...plugin,
            skipMcpDiscovery: true,
          })),
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
    settings,
    // A key of its own, beside the mode's settings: auto and plan modes
    // build theirs without permission rules, and a deny must hold in them too.
    ...(disallowed.length === 0 ? {} : { disallowedTools: disallowed }),
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
