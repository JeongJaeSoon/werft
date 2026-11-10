import type {
  EngineSettings,
  PermissionMode,
  RuntimeConfig,
} from "@werft-ai/contracts";

import type { AgentRun } from "./agent-run.ts";
import type { TranscriptMirror } from "./checkpoint-manifest.ts";
import type { RuntimeDescriptor } from "./descriptor.ts";
import type { GitEnvironment } from "./git-environment.ts";
import type { ToolDecisionObserver } from "./tool-decision.ts";
import type { UserEnvironment } from "./user-environment.ts";

export type AgentInput = {
  message: string;
  uuid: string;
};

/**
 * A run either starts a fresh engine session or resumes one from the handle
 * a previous checkpoint produced. There is deliberately no separate open()
 * entry point: the mode travels with the config.
 */
export type RuntimeMode =
  | { mode: "new"; resume?: undefined }
  | {
      mode: "resume";
      resume: string;
      /**
       * Resume from the transcript on this container's own disk instead of
       * from a checkpoint; only a local tool sets it.
       */
      localTranscriptResume?: true;
    };

export type RuntimeStartConfig = RuntimeMode & {
  correlationId: string;
  cwd: string;
  /**
   * Git settings every process the engine starts inherits in its
   * environment (`gitEnvironment`); the adapter puts them there unchanged.
   * Read from the claim at every start, so never part of a checkpoint's
   * fingerprint.
   */
  gitEnvironment?: GitEnvironment;
  home: string;
  /**
   * The most this run may spend, in USD, as the engine estimates it. The
   * engine ends the turn that crosses it. It counts from zero for every run,
   * resumed ones included, so a caller holding a longer budget passes what
   * is left of it.
   */
  maxBudgetUsd?: number;
  maxTurns?: number;
  model: string;
  permissionMode: PermissionMode;
  /**
   * The user variables the session's engine side runs with, from the claim's
   * `runtime_config.env`. An adapter applies them the way its descriptor's
   * `toolEnv` says, merges them before its own keys so a platform key always
   * wins, and checks them with `assertUserEnvironment`. Absent when the
   * session has none. Never part of a checkpoint's fingerprint.
   */
  userEnvironment?: UserEnvironment;
  /**
   * Deny rules in the engine's rule spelling, from the claim's
   * `runtime_config.disallowed_tools`, that hold in every permission mode.
   * An adapter that cannot enforce them in every mode must refuse to start
   * instead of dropping them. Absent when nothing is denied. Never part of a
   * checkpoint's fingerprint.
   */
  disallowedTools?: readonly string[];
  /**
   * The workspace's and the agent's permission and auto mode rules, merged
   * by the platform for this claim (`runtime_config.engine_settings`). An
   * adapter appends them after its own baseline rules and never lets them
   * take a baseline rule away. Absent when neither sets any. Never part of a
   * checkpoint's fingerprint: the workspace can change them between claims.
   */
  engineSettings?: EngineSettings;
  /**
   * The language the agent's release asks the engine to answer in
   * (`runtime_config.response_language`). An adapter passes it through the
   * engine's own language setting, never as prompt text; the Claude adapter
   * does, the Codex adapter does not use it yet. Absent for
   * `follow-user` and for a release that predates the field. Never part of a
   * checkpoint's fingerprint, so a session resumes on any worker.
   */
  responseLanguage?: "ko" | "en" | "ja";
  tools: readonly string[];
};

/**
 * What a worker holds in place of a provider credential: a token the egress
 * proxy at `transport` exchanges for the real one.
 */
export type EgressTokenAuth = {
  kind: "egress_token";
  token: string;
  transport: string;
};

export type ProviderAuth =
  | { kind: "api_key"; value: string }
  | { kind: "bearer"; value: string }
  | EgressTokenAuth;

/**
 * Who and what a run acts against. `principal` is the session's owner
 * partition, never a credential: it is hashed into every checkpoint
 * fingerprint, so it must survive credential rotation.
 */
export type RuntimeBindings = {
  principal: { ownerScope: string };
  provider: {
    auth: ProviderAuth;
    endpoint: string;
    /** The claim's provider kind; which ones an engine speaks is its adapter's to say. */
    kind: RuntimeConfig["provider"]["kind"];
  };
  /** Where the engine mirrors its transcript; without one no checkpoint outlives the container. */
  transcript?: TranscriptMirror;
};

/** A piece of the platform's own wording to the engine. */
export type InstructionPart = { text: string };

/** A remote MCP server, reached through the egress proxy with the attempt's token. */
export type PlatformMcpServer = {
  name: string;
  /** What the server is for the fingerprint: its release binding. */
  binding: string;
  url: string;
  token: string;
  /** The tool allowlist; the run exposes only this server's share of it. */
  tools: readonly string[];
  /** The platform's own server, not a remote one an administrator named. */
  platform?: boolean;
  /**
   * Tools of a `platform` server whose every call the server judges itself.
   * An adapter runs them with no judgment of the engine's (a person's answer
   * or a classifier's) and only after its own allowlist check, the
   * checkpoint admission and the ledger record. Absent means the engine
   * judges every tool as it always did.
   */
  trusted?: readonly string[];
};

export type RuntimeBundle = {
  instructions: readonly InstructionPart[];
  /**
   * The repository's own instructions file as committed (the first of
   * `files` it has), let in by the profile; `text` is null when the
   * repository has none. Null when the profile keeps it out.
   */
  repoInstructions: { files: readonly string[]; text: string | null } | null;
  mcpServers: readonly PlatformMcpServer[];
  /**
   * Extension bundles the worker published read-only at `path`, identified by
   * their content digest. Absent when the session has none, so a profile
   * without extensions describes exactly what it did before the field.
   */
  extensions?: readonly RuntimeExtensionBundle[];
};

export type RuntimeExtensionBundle = {
  /** The bundle's slug: the name its skills carry in the engine (`<name>:<skill>`). */
  name: string;
  digest: string;
  /** Absolute directory of the published tree. */
  path: string;
};

export type RuntimeStart = {
  config: RuntimeStartConfig;
  bindings: RuntimeBindings;
  bundle: RuntimeBundle;
  /** Told of each judgment on a tool call; absent, none is reported. */
  toolDecisions?: ToolDecisionObserver;
};

export interface AgentRuntime {
  readonly descriptor: RuntimeDescriptor;
  start(start: RuntimeStart): AgentRun;
}
