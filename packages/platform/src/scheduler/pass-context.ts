import type { ExecutionIncarnation } from "../ports/worker-unit-of-work.ts";
import type {
  SchedulerLogger,
  SchedulerOptions,
  SchedulerRunSummary,
} from "./options.ts";
import type {
  ExecutionBackend,
  ExecutionObservation,
  ExecutionRef,
  LaunchIntent,
  TerminateOptions,
} from "./ports/execution-backend.ts";
import {
  LaunchOutcomeUnknownError,
  LaunchSpecMismatchError,
  launchSpecFingerprint,
} from "./ports/execution-backend.ts";
import type {
  ActiveExecution,
  SchedulerStore,
  StoredLaunchIntent,
} from "./ports/scheduler-store.ts";

/** What every step of one pass reads: its settings resolved, its lock. */
export type PassContext = {
  backend: ExecutionBackend;
  drainDeadlineMs: number;
  intentOf: (stored: StoredLaunchIntent, attempt: number) => LaunchIntent;
  launchFailureLimit: number;
  /** Aborted once the pass lock is lost; see `PassLock`. */
  lock: AbortSignal;
  logger: SchedulerLogger;
  now: () => Date;
  options: SchedulerOptions;
  replacementLimit: number;
  stopDeadlineMs: number;
  store: SchedulerStore;
  summary: SchedulerRunSummary;
};

/** Only these states mean the launch took; anything else is a failure. */
export function isLaunched(state: ExecutionObservation["state"]): boolean {
  return state === "running" || state === "pending";
}

export function storedIntentOf(
  execution: ActiveExecution,
): StoredLaunchIntent | null {
  if (execution.operationId === null) return null;
  return {
    executionId: execution.executionId,
    generation: execution.generation,
    image: execution.image,
    operationId: execution.operationId,
    resources: execution.resources,
    sessionId: execution.sessionId,
  };
}

/** The spec a launch was reserved with, or null when none was stored. */
export function storedSpecOf(
  stored: Pick<StoredLaunchIntent, "image" | "resources">,
): string | null {
  return stored.image === null || stored.resources === null
    ? null
    : launchSpecFingerprint(stored.image, stored.resources);
}

/**
 * The incarnation a pass saw go: the credential the resource was labelled
 * with. For a resource it did not see — or one from before the label — only
 * the row it read speaks, and the row names what a create meant to build
 * before anything is built: a worker that bound since may be bound to that,
 * so the claim the row showed is part of what was seen.
 */
export function seenIncarnation(
  execution: ActiveExecution,
  observed?: ExecutionObservation,
): ExecutionIncarnation {
  const label = observed?.credentialFingerprint;
  if (label != null) return { nonceFingerprint: label };
  return {
    claimed: execution.claimed,
    nonceFingerprint: execution.nonceFingerprint,
  };
}

/** The terminate option that pins a teardown to the resource inspected. */
export function pinnedTo(observed: ExecutionObservation): TerminateOptions {
  return observed.providerRef === null
    ? {}
    : { providerRef: observed.providerRef };
}

export function refOf(ref: ExecutionRef): ExecutionRef {
  return { executionId: ref.executionId, generation: ref.generation };
}

export function keyOf(ref: ExecutionRef): string {
  return `${ref.executionId}#${ref.generation}`;
}

export function fieldsOf(ref: ExecutionRef) {
  return { execution_id: ref.executionId, generation: ref.generation };
}

export function unknownObservation(observedAt: Date): ExecutionObservation {
  return { found: false, observedAt, providerRef: null, state: "unknown" };
}

/**
 * A resource refused for another launch spec was found, so no create went
 * out. Recorded as `unknown`, it would read as a create the provider never
 * answered, and the next pass would count a failure once the foreign
 * resource is gone.
 */
export function failedEnsureObservation(
  error: unknown,
  observedAt: Date,
): ExecutionObservation {
  return error instanceof LaunchSpecMismatchError
    ? { found: true, observedAt, providerRef: null, state: "pending" }
    : unknownObservation(observedAt);
}

/**
 * Whether an ensure that threw is this launch failing. A resource built from
 * another spec was found, not a launch that failed: the next pass replaces
 * it as a spec mismatch. A provider that did not answer may have created or
 * started the resource: the credential is kept and the next pass's inspect
 * adopts what landed or creates what did not.
 */
export function countsAsLaunchFailure(error: unknown): boolean {
  return !(
    error instanceof LaunchSpecMismatchError ||
    error instanceof LaunchOutcomeUnknownError
  );
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
