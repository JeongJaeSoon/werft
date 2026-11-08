import type { PermissionMode, RUNTIME_KIND_VALUES } from "@werft-ai/contracts";

export type RuntimeKind = (typeof RUNTIME_KIND_VALUES)[number];

export type Support = "native" | "emulated" | "none";

/** What an engine offers beyond the capability table. */
export type FeatureKey =
  | "approval_park"
  | "classifier_review"
  | "mcp"
  | "session_resume"
  | "skills"
  | "subagents"
  | "user_hooks";

export interface RuntimeCapabilityTable {
  /** The engine can stop an in-flight turn and report what stayed queued. */
  interrupt: boolean;
  /** A turn-end checkpoint yields a handle a later resume accepts. */
  checkpoint: boolean;
  /** A checkpoint can be taken while an approval waits. */
  approvalCheckpoint: boolean;
  /** start() honours `mode: "resume"`. */
  resume: boolean;
  mcp: Support;
  skills: Support;
  permissionModes: Readonly<Record<PermissionMode, Support>>;
}

/**
 * Plain data: the control plane reads it without importing an engine SDK.
 * `kind` is the session's wire identifier, `checkpointEngine` the one stored
 * manifests carry; they stay separate because manifests already written name
 * the engine their own way.
 */
export interface RuntimeDescriptor {
  contractVersion: "runtime-contract/v1";
  kind: RuntimeKind;
  checkpointEngine: string;
  runtimeVersion: string;
  engineVersion: string;
  capabilities: RuntimeCapabilityTable;
  extraFeatures: Partial<Record<FeatureKey, Support>>;
  toolEnv: "engine_inherited" | "tool_scoped";
  /**
   * Whether the runtime may be given a secret variable. `none` until its
   * transcript is scrubbed before it is first stored; the control plane
   * refuses to deliver a secret to a runtime that says `none`.
   */
  secretEnv: "supported" | "none";
  /**
   * Repository files the engine takes as instructions, in order of
   * preference: the first the repository has is read. Which file was read is
   * not part of any checkpoint fingerprint.
   */
  instructionFiles: readonly string[];
}

/** What a started run actually offers; at most what its descriptor declares. */
export type NegotiatedCapabilities = {
  effective: RuntimeCapabilityTable;
  effectiveExtraFeatures: Partial<Record<FeatureKey, Support>>;
};
