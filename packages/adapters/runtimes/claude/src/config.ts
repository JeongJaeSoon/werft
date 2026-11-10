import type { EngineSettings } from "@werft-ai/contracts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
} from "@werft-ai/runtime-claude-codec";
import type {
  GitEnvironment,
  TranscriptMirror,
  UserEnvironment,
} from "@werft-ai/runtime-core";

import type { DriverConfig } from "./driver.ts";

export { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION };

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "dontAsk"
  | "plan"
  | "bypassPermissions"
  | "auto";

export type RuntimePlugin = { path: string; type: "local" };

/**
 * Who a run acts for, said without any credential. A session belongs to an
 * owner partition (`AuthorizationContext.owner_scope` on the platform side),
 * so that partition is what a checkpoint belongs to as well: another user of
 * the same partition may resume it, the same endpoint under another partition
 * may not. It is hashed into the checkpoint fingerprint, which is why it must
 * be stable across credential rotation and must never be the secret itself.
 */
export type RuntimePrincipal = { ownerScope: string };

/**
 * What a worker holds in place of a provider credential: a token
 * the egress proxy at `transport` exchanges for the real one. `endpoint`
 * stays the upstream the proxy forwards to, which is what policy approves
 * and the checkpoint fingerprint names.
 */
export type EgressTokenAuth = {
  kind: "egress_token";
  token: string;
  transport: string;
};

export type RuntimeProfile = (
  | {
      auth: { kind: "api_key"; value: string } | EgressTokenAuth;
      endpoint: string;
      kind: "anthropic";
    }
  | {
      auth:
        | { kind: "api_key"; value: string }
        | { kind: "bearer"; value: string }
        | EgressTokenAuth;
      endpoint: string;
      kind: "litellm";
    }
) & { principal: RuntimePrincipal };

/**
 * Caller-asserted identities for the parts of a config the checkpoint
 * fingerprint cannot hash by value: an in-process MCP server is a live object
 * graph, and a local plugin is a path whose contents can change underneath
 * it. Each is keyed the way the SDK names it — MCP servers by registry name,
 * plugins by path — and the value is whatever the caller can keep stable for
 * one tool surface and change for another: a version, a content digest, a
 * release id. The fingerprint hashes the identity in place of the object, so
 * two runs claim compatibility exactly when their callers say so.
 */
export type ComponentIdentities = {
  mcpServers?: Record<string, string>;
  plugins?: Record<string, string>;
};

export type ClaudeRuntimeConfig = DriverConfig & {
  appendSystemPrompt?: string;
  claudeConfigDir: string;
  /**
   * Deny rules, in the engine's own spelling, given to the engine as
   * `disallowedTools` in every permission mode. Checked against the pinned
   * tool catalog before the run starts; a run whose rules the engine would
   * drop or that do not fit its arguments does not start. Not part of the
   * checkpoint fingerprint.
   */
  disallowedTools?: readonly string[];
  /**
   * The platform's merged permission and auto mode rules for this claim,
   * appended to the mode's baseline settings. `permissions.deny` is checked
   * like `disallowedTools` before the run starts. Not part of the checkpoint
   * fingerprint.
   */
  engineSettings?: EngineSettings;
  /**
   * The fixed answer language, given to the engine as its `language` setting
   * (the engine adds it to the message stream, not the system prompt). Not
   * part of the checkpoint fingerprint: a resumed session gets it fresh.
   */
  responseLanguage?: "ko" | "en" | "ja";
  /** Put into the engine's environment as it is; never into its arguments. */
  gitEnvironment?: GitEnvironment;
  /**
   * The session's user variables. Merged into the engine's environment
   * before the adapter's own keys, so a platform key always wins. Never in
   * the fingerprint: they are read from the claim at every start.
   */
  userEnvironment?: UserEnvironment;
  /**
   * Required for every plugin and for every MCP server that is not plain
   * data; a run missing one is refused before it starts, because no
   * checkpoint it took could say what it was compatible with.
   */
  identities?: ComponentIdentities;
  mcpServers?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  /**
   * `mcp__<server>__<tool>` names of a platform server's tools the server
   * judges itself. The run lets them past the engine's permission stage, after
   * its allowlist check and the checkpoint admission. Not part of the
   * checkpoint fingerprint: whether the engine asks changes no tool surface.
   */
  trustedTools?: readonly string[];
  plugins?: RuntimePlugin[];
  profile: RuntimeProfile;
  /**
   * The repository's own instruction file (AGENTS.md, else CLAUDE.md; the
   * caller picks), let into the system prompt by the caller
   * rather than loaded by the engine: the engine only reads it together with
   * the rest of the project source — settings.json with its hooks, env and
   * permission rules — so this requires `settingSources: []`. `contents` is
   * whatever the caller read (null when the repository has none); where it
   * reads it from is the trust decision, and it is the caller's.
   *
   * The checkpoint fingerprint takes the switch, not the text or the file's
   * name, so a branch that changed its instruction file, or moved it from
   * CLAUDE.md to AGENTS.md, does not make a session's checkpoints
   * unresumable. A resumed run keeps the text it started with anyway: the
   * engine replays the system prompt it recorded (`snapshot`) until the
   * conversation is compacted, and after that carries this run's `contents`.
   */
  repositoryClaudeMd?: { contents: string | null };
  /**
   * How many times the engine retries a failed Messages request (5xx,
   * overload, rate limit, connection) before the turn fails with
   * `terminal_reason: "api_error"`. Unset leaves the engine's own policy.
   */
  providerMaxRetries?: number;
  /**
   * Where the engine mirrors root and subagent transcripts. Without it the
   * transcript lives only on the container's disk, which no checkpoint can
   * outlive.
   */
  sessionStore?: TranscriptMirror;
  /**
   * Resume from the transcript on this container's own disk instead of from a
   * checkpoint. Only a local tool has any business setting it: a restore that
   * forgot to bind its mirror would otherwise look exactly like this and
   * silently replay whatever the disk happens to hold.
   */
  localTranscriptResume?: true;
  settingSources?: [] | ["project"];
  /**
   * PEM bundle the engine trusts in addition to the system store, for a
   * Messages endpoint behind a private CA or a TLS-terminating egress. It is
   * named here, by whoever composes the runtime, and never picked up from the
   * host environment: an ambient bundle would quietly become a trust root for
   * credential-bearing API traffic.
   */
  trustedCaBundle?: string;
};
