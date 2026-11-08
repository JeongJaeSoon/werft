import type { SessionEvent } from "@werft-ai/contracts";
import type {
  AdmissionHold,
  AgentInput,
  CheckpointLeaseGrant,
  CheckpointPoint,
  CheckpointPreparation,
  ParkReadiness,
} from "@werft-ai/runtime-core";

/** A message as the Claude Agent SDK emits it; nothing outside this adapter reads one. */
export type NativeSdkMessage = {
  [key: string]: unknown;
  type: string;
};

export type NativeEnvelope = {
  correlation_id: string;
  message: NativeSdkMessage;
  schema_version: "sdk-envelope/v1";
  sdk_version: string;
};

export type AgentFrame = {
  envelope: NativeEnvelope;
  events: SessionEvent[];
  /**
   * The input uuids the driver says this frame is for, read only when its
   * native message names none, as a scripted engine's messages do.
   */
  inputs?: readonly string[];
};

/** An engine permission rule, as the engine names its fields. */
export type EngineRule = { toolName: string; ruleContent?: string };

/**
 * The one permission update the adapter ever hands back: allow rules kept
 * for the session. Nothing else the engine proposes (a mode change, a
 * directory, a deny rule) is passed on.
 */
export type SessionRuleUpdate = {
  type: "addRules";
  behavior: "allow";
  destination: "session";
  rules: EngineRule[];
};

export type PermissionRequest = {
  input: Record<string, unknown>;
  requestId: string;
  signal: AbortSignal;
  tool: string;
  toolUseId: string;
  /**
   * The allow rules the engine proposed that the run may offer to keep for
   * the session, already filtered; empty when there are none.
   */
  suggestedRules?: readonly EngineRule[];
};

export type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: SessionRuleUpdate[];
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type RuntimeHooks = {
  onPermission(request: PermissionRequest): Promise<PermissionDecision>;
};

export type DriverMode =
  | { mode: "new"; resume?: undefined }
  | { mode: "resume"; resume: string };

export type DriverConfig = DriverMode & {
  correlationId: string;
  cwd: string;
  home: string;
  /**
   * The most this run may spend, in USD, as the engine estimates it. It
   * counts from zero for every run, resumed ones included.
   */
  maxBudgetUsd?: number;
  maxTurns?: number;
  model: string;
  tools: string[];
};

/**
 * One engine execution as a driver runs it: frames, and permission requests
 * through `RuntimeHooks`. Iterating `events()` a second time throws.
 */
export interface DriverRun extends AsyncIterable<AgentFrame> {
  abort(): void;
  close(): void;
  events(): AsyncIterable<AgentFrame>;
  finishInput(): void;
  holdsInput(uuid: string): Promise<boolean>;
  ready(): Promise<void>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  leaseCheckpoint(point?: CheckpointPoint): Promise<CheckpointLeaseGrant>;
  /** Nothing runs but tools waiting on a permission callback. */
  parkable(): ParkReadiness;
  prepareCheckpoint(point?: CheckpointPoint): Promise<CheckpointPreparation>;
  /**
   * The running cost a resumed session had saved, which the engine's totals
   * continue from. Absent or undefined: none is known.
   */
  priorCostUsd?(): Promise<number | undefined>;
  /**
   * True when `approval_wait` checkpoints can be taken: the driver watches
   * a transcript mirror it can wait on. Absent is false.
   */
  readonly approvalCheckpoints?: boolean;
  /** Absent: the driver admits tools through no gate a host can hold. */
  holdAdmission?(guard: (toolCallId: string) => Promise<void>): AdmissionHold;
  send(input: AgentInput): void;
}
