import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJsonOfJson, type PermissionMode } from "@werft-ai/contracts";
import {
  CODEX_BUILTIN_TOOLS,
  CODEX_DESCRIPTOR,
} from "@werft-ai/runtime-codex-codec";
import {
  assertGitEnvironment,
  assertUserEnvironment,
  type RuntimeHostDeps,
  type RuntimeProfileInput,
  type RuntimeStart,
} from "@werft-ai/runtime-core";

/** The one provider the engine is configured with; its name appears in the rollout. */
export const PROVIDER_ID = "werft";

/**
 * The variable the engine reads the egress token from. It is in the engine's
 * own environment and nowhere else: the tools it starts get an environment
 * of their own (`shell_environment_policy`), which carries no token.
 */
export const EGRESS_TOKEN_VARIABLE = "WERFT_EGRESS_TOKEN";

/**
 * How a permission mode runs the engine. `untrusted` approval asks for every
 * command the engine does not know to be read-only and for every file change;
 * `on-request` and `never` run them unasked (seen with 0.167.0, see the
 * adapter's PR), so only `bypassPermissions` uses `never`.
 *
 * `answers` is who answers what the engine asks: the person (`ask`), the
 * adapter accepting file changes only (`edits`), or the adapter declining all
 * (`none`). The sandbox is off in every mode: the container is the boundary
 * (a user namespace for bwrap would widen it), and approval is independent.
 */
const MODES = {
  default: { approval: "untrusted", answers: "ask" },
  acceptEdits: { approval: "untrusted", answers: "edits" },
  dontAsk: { approval: "untrusted", answers: "none" },
  bypassPermissions: { approval: "never", answers: "none" },
} as const satisfies Record<
  string,
  { approval: "untrusted" | "never"; answers: "ask" | "edits" | "none" }
>;

export type ModeRun = (typeof MODES)[keyof typeof MODES];

export function modeRunOf(mode: PermissionMode): ModeRun {
  const support = CODEX_DESCRIPTOR.capabilities.permissionModes[mode];
  if (support === "none" || !(mode in MODES)) {
    throw new Error(`The Codex engine does not run in ${mode} mode`);
  }
  return MODES[mode as keyof typeof MODES];
}

export type CodexConnection = {
  /** `<egress>/provider/v1`; the engine appends `/responses`. */
  baseUrl: string;
  endpoint: string;
  ownerScope: string;
  token: string;
  transportHost: string;
};

function trimSlash(text: string): string {
  return text.replace(/\/+$/, "");
}

/**
 * The engine talks to the egress proxy with the attempt's token and to
 * nothing else; a provider key (an `api_key` auth) is refused so it can never
 * be put in front of the engine, and neither can another provider kind.
 */
export function connectionOf(
  bindings: RuntimeProfileInput["bindings"],
): CodexConnection {
  const { auth, endpoint, kind } = bindings.provider;
  if (kind !== "openai_responses") {
    throw new Error("The Codex engine speaks only the Responses API");
  }
  if (auth.kind !== "egress_token") {
    throw new Error("The Codex engine takes an egress token, never a key");
  }
  const transport = new URL(auth.transport);
  return {
    baseUrl: `${trimSlash(transport.toString())}/v1`,
    endpoint: trimSlash(new URL(endpoint).toString()),
    ownerScope: bindings.principal.ownerScope,
    token: auth.token,
    transportHost: transport.hostname,
  };
}

/**
 * Settings the engine cannot honor are refused at start, never dropped: a
 * deny rule that is silently ignored is a promise broken. A budget is not on
 * the list: the platform's egress meters every Responses call and answers
 * BUDGET_EXCEEDED, so the engine has nothing to enforce.
 */
export function assertStartable(
  config: RuntimeStart["config"],
  bundle: RuntimeStart["bundle"],
): void {
  const refuse = (what: string) => {
    throw new Error(`The Codex engine cannot honor ${what}`);
  };
  if (config.maxTurns !== undefined) refuse("a turn limit");
  if ((config.disallowedTools ?? []).length > 0) refuse("deny rules");
  if (config.engineSettings !== undefined) refuse("engine permission rules");
  if (bundle.mcpServers.length > 0) refuse("MCP servers");
  if ((bundle.extensions ?? []).length > 0) refuse("extension bundles");
  const unknown = config.tools.filter(
    (tool) => !(CODEX_BUILTIN_TOOLS as readonly string[]).includes(tool),
  );
  if (unknown.length > 0) refuse(`the tools ${unknown.join(", ")}`);
  for (const tool of CODEX_BUILTIN_TOOLS) {
    if (!config.tools.includes(tool)) refuse(`a session without ${tool}`);
  }
}

/**
 * Everything the engine is told beyond the conversation. The repository's own
 * instructions come only as the bundle says (the engine's own reading of
 * AGENTS.md is off), so a profile that keeps them out is believed.
 *
 * `config.responseLanguage` is deliberately not used: the owner ruled out
 * appending it to the prompt, and this engine has no setting for it, so a
 * Codex session answers in whatever language the person writes in.
 */
export function developerInstructionsOf(
  start: Pick<RuntimeStart, "bundle">,
): string | undefined {
  const parts = start.bundle.instructions.map((part) => part.text);
  const repo = start.bundle.repoInstructions?.text;
  if (repo !== null && repo !== undefined) parts.push(repo);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

type TomlValue = string | number | boolean | readonly TomlValue[] | TomlTable;
type TomlTable = { readonly [key: string]: TomlValue };

/** A TOML value for `-c key=value`; a JSON string is a valid TOML basic string. */
export function toml(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  const table = value as TomlTable;
  return `{${Object.entries(table)
    .map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`)
    .join(", ")}}`;
}

export type CodexLaunch = {
  /** The arguments after the executable: no secret and no claim data. */
  args: string[];
  approvalPolicy: "untrusted" | "never";
  answers: ModeRun["answers"];
  /** `config` for `thread/start` and `thread/resume`, not on any command line. */
  threadConfig: Record<string, unknown>;
  developerInstructions: string | undefined;
  /** The engine process's whole environment. */
  env: Record<string, string>;
  /** `CODEX_HOME`: on the volume the worker moves transcripts onto. */
  home: string;
};

/** The engine's home inside the directory the host keeps transcripts in (`<state dir>/projects`). */
export function codexHomeIn(engineDirectory: string): string {
  return join(engineDirectory, "codex");
}

/** Where the engine keeps its state: on the volume the worker moves `<state dir>/projects` to. */
export function codexHomeOf(stateDir: string): string {
  return codexHomeIn(join(stateDir, "projects"));
}

const HOST_PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function codexLaunch(
  start: RuntimeStart,
  deps: Pick<RuntimeHostDeps, "stateDir">,
  host: NodeJS.ProcessEnv = process.env,
): CodexLaunch {
  const { bindings, bundle, config } = start;
  assertStartable(config, bundle);
  const connection = connectionOf(bindings);
  const run = modeRunOf(config.permissionMode);
  const home = codexHomeOf(deps.stateDir);

  const provider = {
    name: PROVIDER_ID,
    base_url: connection.baseUrl,
    env_key: EGRESS_TOKEN_VARIABLE,
    wire_api: "responses",
    requires_openai_auth: false,
  };
  // Every setting here was seen to be accepted by the pinned build (it logs
  // "ignoring unrecognized configuration" for one it does not know, which the
  // integration test fails on).
  const overrides: Array<[string, TomlValue]> = [
    ["model_provider", PROVIDER_ID],
    [`model_providers.${PROVIDER_ID}`, provider],
    // Nothing leaves for a host other than the provider.
    ["check_for_update_on_startup", false],
    ["analytics.enabled", false],
    ["feedback.enabled", false],
    ["history.persistence", "none"],
    // Tools the platform has no approval path for.
    ["web_search", "disabled"],
    ["features.multi_agent", false],
    ["features.goals", false],
    ["features.hooks", false],
    ["features.image_generation", false],
    ["features.browser_use", false],
    ["features.browser_use_external", false],
    ["features.computer_use", false],
    // Reached out on start with the defaults (seen at the network level):
    // the plugin marketplace is cloned from github.com into CODEX_HOME, and
    // connectors and plugin listings go to chatgpt.com.
    ["features.plugins", false],
    ["features.plugin_discovery_prefetch", false],
    ["features.remote_plugin", false],
    ["features.plugin_sharing", false],
    ["features.apps", false],
    ["features.skill_search", false],
    ["features.skill_mcp_dependency_install", false],
    ["features.tool_suggest", false],
    ["features.daemon_auto_start", false],
    // The repository's instructions come from the bundle, as committed.
    ["project_doc_max_bytes", 0],
  ];

  const noProxy = host.NO_PROXY ?? host.no_proxy;
  const env: Record<string, string> = {
    CODEX_HOME: home,
    HOME: config.home,
    LANG: host.LANG ?? "en_US.UTF-8",
    PATH: host.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: host.TMPDIR ?? "/tmp",
    [EGRESS_TOKEN_VARIABLE]: connection.token,
  };
  for (const name of HOST_PROXY_VARIABLES) {
    const value = host[name];
    if (value !== undefined && !name.toLowerCase().startsWith("no_")) {
      env[name] = value;
    }
  }
  // The egress route is plain HTTP on the worker network and not to be sent
  // through the forward proxy.
  const bypass = [noProxy, connection.transportHost]
    .filter((entry) => entry !== undefined && entry !== "")
    .join(",");
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;

  // What the engine's tools run with: this and nothing inherited. User
  // variables first, so a platform key always wins.
  const toolEnv: Record<string, string> = {
    ...(config.userEnvironment === undefined
      ? {}
      : assertUserEnvironment(config.userEnvironment)),
    HOME: config.home,
    LANG: env.LANG as string,
    PATH: env.PATH as string,
    TMPDIR: env.TMPDIR as string,
    ...(config.gitEnvironment === undefined
      ? {}
      : assertGitEnvironment(config.gitEnvironment)),
  };

  return {
    args: [
      "app-server",
      ...overrides.flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]),
    ],
    approvalPolicy: run.approval,
    answers: run.answers,
    threadConfig: {
      shell_environment_policy: { inherit: "none", set: toolEnv },
    },
    developerInstructions: developerInstructionsOf(start),
    env,
    home,
  };
}

/**
 * The digest a checkpoint is stamped with: what fixes how the stored thread
 * replays. The credential and where the proxy listens are left out, so
 * rotating a token or moving the proxy does not orphan a checkpoint.
 */
export function codexProfileDigest(profile: RuntimeProfileInput): string {
  const connection = connectionOf(profile.bindings);
  return createHash("sha256")
    .update(
      canonicalJsonOfJson({
        scheme: 1,
        cwd: profile.config.cwd,
        endpoint: connection.endpoint,
        instructions:
          developerInstructionsOf({ bundle: profile.bundle }) ?? null,
        model: profile.config.model,
        ownerScope: connection.ownerScope,
        permissionMode: profile.config.permissionMode,
        tools: [...profile.config.tools].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}
