import { describe, expect, test } from "bun:test";
import { WORKER_EXIT_LEASE_LOST } from "@werft-ai/contracts";
import type { ImageRuntime } from "@werft-ai/runtime-core";
import type { ExecutionIncarnation } from "../ports/worker-unit-of-work.ts";
import {
  hashWorkerToken,
  launchNonceFingerprint,
} from "../workers/worker-gateway.ts";
import type {
  EnsureExecutionResult,
  ExecutionBackend,
  ExecutionObservation,
  ExecutionRef,
  LaunchCredentialState,
  LaunchIntent,
  ManagedExecution,
  ManagedWorkspace,
  NetworkReconcileResult,
  TerminateExecutionResult,
  TerminateOptions,
  WorkspaceRemovalResult,
} from "./ports/execution-backend.ts";
import {
  LaunchOutcomeUnknownError,
  LaunchSpecMismatchError,
  launchSpecFingerprint,
} from "./ports/execution-backend.ts";
import type {
  ActiveExecution,
  HoldIncompatibleInput,
  LaunchFailureInput,
  LaunchFailureOutcome,
  PendingWorkspaceReclaim,
  ReplaceReason,
  ReserveLaunchInput,
  SchedulerStore,
  StoredLaunchIntent,
  WorkerImageRefusal,
  WorkspaceReclaimClaim,
} from "./ports/scheduler-store.ts";
import {
  DEFAULT_LAUNCH_FAILURE_LIMIT,
  DEFAULT_STOPPED_WORKSPACE_TTL_MS,
  launchRetryDelayMs,
  reclaimNetworks,
  reclaimWorkspaces,
  runScheduler,
  type SchedulerLogger,
  type SchedulerRunSummary,
} from "./session-scheduler.ts";
import type { PointerRuntime } from "./worker-images.ts";

const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 };
const NONCE_TTL_MS = 10 * 60 * 1000;

/** What the registry computes from its column, and the label carries. */
function fingerprintOf(nonce: string | null | undefined): string | null {
  return nonce == null ? null : launchNonceFingerprint(hashWorkerToken(nonce));
}

/** A launch row: the slot it holds and the credential it has handed out. */
type Launch = ActiveExecution & {
  slotReleased: boolean;
  nonce: string | null;
  /** On the storage clock, once a drain was asked of its worker. */
  drainRequestedAt?: number;
};

class MemoryStore implements SchedulerStore {
  readonly executions = new Map<string, Launch>();
  readonly unassigned = new Set<string>();
  readonly confirmedGone: string[] = [];
  locked = false;
  /** Aborting it models the lock connection dropping mid-pass. */
  lockLost = new AbortController();
  /** Models the store itself failing, distinct from one row's provider. */
  failList = false;
  private sequence = 0;
  /** The storage clock, as far ahead of this process's as a test moves it. */
  clockOffsetMs = 0;
  /** Sessions a quarantine gave up on, with the error their input failed on. */
  readonly quarantined = new Map<string, string>();
  readonly launchFailures: Array<{ executionId: string } & LaunchFailureInput> =
    [];
  /** Sessions with a turn that has not ended, as a drain sees them. */
  readonly busySessions = new Set<string>();
  readonly pointers = new Map<
    string,
    { pointer: PointerRuntime; checkpointRevision: number }
  >();
  readonly refusals: WorkerImageRefusal[] = [];
  /** Sessions stopped before launch, with the detail they were held on. */
  readonly held = new Map<string, string>();
  /** The runtime each reservation assumed, by session. */
  readonly reservedRuntimes = new Map<string, ImageRuntime | undefined>();

  async pointerRuntimeOf(sessionId: string) {
    return (
      this.pointers.get(sessionId) ?? {
        pointer: { kind: "none" } as const,
        checkpointRevision: 0,
      }
    );
  }

  async workerImageRefusals() {
    return [...this.refusals];
  }

  async holdIncompatibleBeforeLaunch(input: HoldIncompatibleInput) {
    if (!this.unassigned.has(input.sessionId)) return "stale" as const;
    this.unassigned.delete(input.sessionId);
    this.held.set(input.sessionId, input.detail);
    return "held" as const;
  }

  private storageNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /** Moves the storage clock past every backoff recorded so far. */
  elapse(ms: number): void {
    this.clockOffsetMs += ms;
  }

  async acquirePassLock() {
    if (this.locked) return null;
    this.locked = true;
    this.lockLost = new AbortController();
    return {
      signal: this.lockLost.signal,
      release: async () => {
        this.locked = false;
      },
    };
  }

  loseLock(): void {
    this.lockLost.abort(new Error("Scheduler pass lock connection ended"));
  }

  addUnassigned(count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = crypto.randomUUID();
      this.unassigned.add(id);
      ids.push(id);
    }
    return ids;
  }

  seedActive(overrides: Partial<Launch> = {}): Launch {
    const sessionId = overrides.sessionId ?? crypto.randomUUID();
    const execution: Launch = {
      backend: "local_docker",
      claimed: false,
      desiredState: "running",
      executionId: `exec-${++this.sequence}`,
      generation: 1,
      // A launch reserved before the spec was stored, unless a test says so.
      image: null,
      nonce: null,
      nonceExpiresAt: null,
      nonceExpired: false,
      nonceFingerprint: null,
      observedAt: null,
      observedState: "pending",
      operationId: crypto.randomUUID(),
      pendingReplacement: null,
      providerRef: null,
      replacementCount: 0,
      resources: null,
      launchAttempts: 0,
      launchFailureCount: 0,
      launchRetryAt: null,
      launchRetryDue: true,
      sessionId,
      slotReleased: false,
      ...overrides,
    };
    this.executions.set(execution.executionId, execution);
    return execution;
  }

  /** The ledger: a launch holds its slot until it is confirmed gone. */
  private live(): Launch[] {
    return [...this.executions.values()].filter((e) => !e.slotReleased);
  }

  async inspectDemand({
    limit,
    excluding = [],
  }: {
    limit: number;
    excluding?: readonly string[];
  }) {
    const liveSessions = new Set(this.live().map((e) => e.sessionId));
    return {
      activeExecutionCount: this.live().length,
      eligibleSessionIds: [...this.unassigned]
        .filter((id) => !liveSessions.has(id) && !excluding.includes(id))
        .slice(0, limit),
    };
  }

  async reserveLaunch(
    input: ReserveLaunchInput,
  ): Promise<StoredLaunchIntent | null> {
    if (!this.unassigned.has(input.sessionId)) return null;
    if (this.live().some((e) => e.sessionId === input.sessionId)) return null;
    if (this.live().length >= input.slotLimit) return null;
    this.reservedRuntimes.set(input.sessionId, input.imageRuntime);
    const generation =
      Math.max(
        0,
        ...[...this.executions.values()]
          .filter((e) => e.sessionId === input.sessionId)
          .map((e) => e.generation),
      ) + 1;
    const seeded = this.seedActive({
      backend: input.backend,
      generation,
      image: input.image,
      resources: input.resources,
      sessionId: input.sessionId,
    });
    if (seeded.operationId === null) {
      throw new Error("seeded intent is complete");
    }
    return { ...seeded, operationId: seeded.operationId };
  }

  async requestReplacement(
    ref: ExecutionRef,
    reason: ReplaceReason,
    expectedCount: number,
    expectedNonceFingerprint?: string | null,
  ): Promise<number | null> {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.claimed ||
      row.slotReleased ||
      row.desiredState !== "running" ||
      row.replacementCount !== expectedCount ||
      (expectedNonceFingerprint !== undefined &&
        fingerprintOf(row.nonce) !== expectedNonceFingerprint)
    ) {
      return null;
    }
    row.pendingReplacement = reason;
    row.replacementCount += 1;
    // The door shuts with the record, as in the real store.
    row.nonce = null;
    return row.replacementCount;
  }

  async recordLaunchFailure(
    ref: ExecutionRef,
    input: LaunchFailureInput,
  ): Promise<LaunchFailureOutcome> {
    this.launchFailures.push({ executionId: ref.executionId, ...input });
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.claimed ||
      row.slotReleased ||
      row.desiredState !== "running" ||
      row.launchFailureCount !== input.expectedCount ||
      row.launchAttempts !== input.expectedAttempts ||
      (input.expectedNonceFingerprint !== undefined &&
        fingerprintOf(row.nonce) !== input.expectedNonceFingerprint)
    ) {
      return "stale";
    }
    row.launchFailureCount += 1;
    row.launchAttempts += 1;
    row.nonce = null;
    if (!input.quarantine) {
      row.launchRetryAt = new Date(this.storageNow() + input.retryDelayMs);
      return "backing_off";
    }
    row.launchRetryAt = null;
    row.pendingReplacement = null;
    row.desiredState = "terminated";
    this.unassigned.delete(row.sessionId);
    this.quarantined.set(row.sessionId, input.error);
    return "quarantined";
  }

  async beginLaunchAttempt(
    ref: ExecutionRef,
    expectedAttempts: number,
  ): Promise<number | null> {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.slotReleased ||
      row.launchAttempts !== expectedAttempts
    ) {
      return null;
    }
    row.launchAttempts += 1;
    return row.launchAttempts;
  }

  async settleReplacement(
    ref: ExecutionRef,
    expectedCount: number,
  ): Promise<void> {
    const row = this.executions.get(ref.executionId);
    if (!row || row.generation !== ref.generation) return;
    if (row.replacementCount !== expectedCount) return;
    row.pendingReplacement = null;
  }

  async issueBootstrapNonce(
    ref: ExecutionRef,
    attempt?: number,
  ): Promise<string> {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      (attempt !== undefined && row.launchAttempts !== attempt) ||
      row.claimed ||
      row.slotReleased ||
      row.desiredState !== "running" ||
      (row.launchRetryAt !== null &&
        row.launchRetryAt.getTime() > this.storageNow())
    ) {
      throw new Error(`no credential for ${ref.executionId}`);
    }
    row.nonce = `nonce-${crypto.randomUUID()}`;
    row.nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS);
    return row.nonce;
  }

  async revokeBootstrapNonce(ref: ExecutionRef): Promise<boolean> {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.claimed ||
      row.slotReleased ||
      row.nonceExpiresAt === null ||
      row.nonceExpiresAt.getTime() > Date.now()
    ) {
      return false;
    }
    row.nonce = null;
    return true;
  }

  async bootstrapCredentialState(
    ref: ExecutionRef,
  ): Promise<LaunchCredentialState> {
    const row = this.executions.get(ref.executionId);
    if (!row || row.generation !== ref.generation || row.slotReleased) {
      throw new Error(`no launch for ${ref.executionId}`);
    }
    if (row.claimed) return { claimed: true };
    return { claimed: false, fingerprint: fingerprintOf(row.nonce) };
  }

  /** Confirmations refused because the launch had moved on. */
  readonly supersededConfirms: string[] = [];
  /** The end reason each confirmation was given, by execution. */
  readonly confirmEndReasons = new Map<string, string | undefined>();
  /** Runs as a confirmation reaches the store, before it is judged. */
  duringConfirm: ((executionId: string) => void) | null = null;

  async confirmExecutionGone(
    executionId: string,
    _now: Date,
    incarnation: ExecutionIncarnation | null,
    endReason?: string,
  ): Promise<"confirmed" | "deferred" | "superseded"> {
    this.duringConfirm?.(executionId);
    this.confirmEndReasons.set(executionId, endReason);
    const row = this.executions.get(executionId);
    if (
      incarnation !== null &&
      (!row ||
        fingerprintOf(row.nonce) !== incarnation.nonceFingerprint ||
        (incarnation.claimed !== undefined &&
          row.claimed !== incarnation.claimed))
    ) {
      this.supersededConfirms.push(executionId);
      return "superseded";
    }
    if (
      row &&
      row.pendingReplacement !== null &&
      !row.claimed &&
      row.desiredState !== "terminated"
    ) {
      return "deferred";
    }
    this.confirmedGone.push(executionId);
    if (!row) return "confirmed";
    row.slotReleased = true;
    row.observedState = "terminated";
    return "confirmed";
  }

  async requestDrain(ref: ExecutionRef, deadlineMs: number) {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.slotReleased ||
      !row.claimed ||
      row.desiredState !== "running"
    ) {
      return null;
    }
    row.drainRequestedAt ??= this.storageNow();
    return {
      busy: this.busySessions.has(row.sessionId),
      overdue: row.drainRequestedAt + deadlineMs <= this.storageNow(),
    };
  }

  async desiredStateOf(ref: ExecutionRef) {
    const row = this.executions.get(ref.executionId);
    return row && row.generation === ref.generation ? row.desiredState : null;
  }

  /** Terminate receipts as the store would hold them: created_at only. */
  readonly terminateReceipts: { createdAt: Date; status: string }[] = [];

  async markOverdueTerminations({
    now,
    deadlineMs,
  }: {
    now: Date;
    deadlineMs: number;
  }) {
    let flipped = 0;
    for (const receipt of this.terminateReceipts) {
      if (
        receipt.status === "accepted" &&
        receipt.createdAt.getTime() <= now.getTime() - deadlineMs
      ) {
        receipt.status = "unknown";
        flipped += 1;
      }
    }
    return flipped;
  }

  async listActiveExecutions(backend: ActiveExecution["backend"]) {
    if (this.failList) throw new Error("database down");
    // Copies, like a query result: what the caller carries is a snapshot and
    // stays behind whatever the rows do while the pass runs.
    // The store, not the scheduler, judges expiry — on its own clock.
    return this.live()
      .filter((e) => e.backend === backend)
      .map((e) => ({
        ...e,
        launchRetryDue:
          e.launchRetryAt === null ||
          e.launchRetryAt.getTime() <= this.storageNow(),
        nonceExpired:
          e.nonceExpiresAt !== null && e.nonceExpiresAt.getTime() <= Date.now(),
        nonceFingerprint: fingerprintOf(e.nonce),
      }));
  }

  async filterKnown(refs: ExecutionRef[], backend: ActiveExecution["backend"]) {
    return refs.filter((ref) => {
      const row = this.executions.get(ref.executionId);
      return (
        row !== undefined &&
        row.backend === backend &&
        row.generation === ref.generation &&
        !row.slotReleased
      );
    });
  }

  async recordObservation(
    ref: ExecutionRef,
    observation: ExecutionObservation,
  ) {
    const row = this.executions.get(ref.executionId);
    if (!row) throw new Error(`unknown execution ${ref.executionId}`);
    row.observedState = observation.state;
    row.observedAt = observation.observedAt;
    row.providerRef = observation.providerRef;
  }

  /** Sessions whose workspace must survive; everything else is reclaimable. */
  readonly retainedSessions = new Set<string>();
  /** What GC asked about, in order, so the ordering can be asserted. */
  readonly retainedQueries: string[][] = [];
  failRetained = false;
  /** What each filter was asked with, for the TTL it carried. */
  readonly retainedTtls: number[] = [];

  async filterRetainedSessions(
    sessionIds: string[],
    options: { stoppedTtlMs: number },
  ): Promise<string[]> {
    this.retainedQueries.push([...sessionIds]);
    this.retainedTtls.push(options.stoppedTtlMs);
    if (this.failRetained) throw new Error("database down");
    return sessionIds.filter((id) => this.retainedSessions.has(id));
  }

  /** Sessions the database proves closed, for name-derived workspaces. */
  readonly closedLegacySessions = new Set<string>();
  readonly closedLegacyQueries: string[][] = [];
  failClosedLegacy = false;

  async filterClosedLegacySessions(sessionIds: string[]): Promise<string[]> {
    this.closedLegacyQueries.push([...sessionIds]);
    if (this.failClosedLegacy) throw new Error("database down");
    return sessionIds.filter((id) => this.closedLegacySessions.has(id));
  }

  /**
   * The verdict a claim gets under the session lock, per session; absent is
   * a finished session, which needs no claim.
   */
  readonly claimVerdicts = new Map<string, "claimed" | "retained">();
  readonly pendingClaims = new Map<string, PendingWorkspaceReclaim>();
  readonly settledClaims: Array<{
    claimId: string;
    outcome: "removed" | "released";
  }> = [];
  failClaim = false;
  failFinish = false;

  async claimWorkspaceReclaim(input: {
    sessionId: string;
    workspaceId: string;
    stoppedTtlMs: number;
  }): Promise<WorkspaceReclaimClaim> {
    if (this.failClaim) throw new Error("database down");
    const verdict = this.claimVerdicts.get(input.sessionId);
    if (verdict === undefined) return { kind: "unclaimed" };
    if (verdict === "retained" || this.pendingClaims.has(input.sessionId)) {
      return { kind: "retained" };
    }
    const claimId = `claim-${crypto.randomUUID()}`;
    this.pendingClaims.set(input.sessionId, {
      claimId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    });
    return { kind: "claimed", claimId };
  }

  async finishWorkspaceReclaim(input: {
    claimId: string;
    sessionId: string;
    outcome: "removed" | "released";
  }): Promise<void> {
    if (this.failFinish) throw new Error("database down");
    if (this.pendingClaims.get(input.sessionId)?.claimId !== input.claimId) {
      return;
    }
    this.pendingClaims.delete(input.sessionId);
    this.settledClaims.push({
      claimId: input.claimId,
      outcome: input.outcome,
    });
  }

  async listPendingWorkspaceReclaims(): Promise<PendingWorkspaceReclaim[]> {
    return [...this.pendingClaims.values()];
  }
}

type Container = {
  exited: boolean;
  generation: number;
  /** The provider's own id; each create gets a new one, like Docker. */
  id?: string;
  /** The `launchSpec` label; absent on one built without a stored spec. */
  launchSpec?: string;
  /**
   * What the resource was built with, exactly as an env var would be. Only
   * containers this backend created have one; a hand-seeded fixture stands
   * for a container that was already there.
   */
  nonce?: string;
  operationId: string;
  /** true models Docker `removing`: a teardown the daemon has not finished. */
  removing?: boolean;
  /** How an exited one ended; absent is a clean exit 0. */
  failure?: { exitCode: number; terminationReason: string; logTail: string };
  sessionId: string;
  /** false models Docker `created`: create succeeded, start never ran. */
  started?: boolean;
};

/**
 * A worker traded the launch's nonce for a binding: from here on its exit is
 * an ordinary one. An exit before this is a failed launch attempt.
 */
function claimLaunchOf(store: MemoryStore, name: string): Launch {
  const row = store.executions.get(name.split("#")[0] ?? "");
  if (!row) throw new Error(`no launch for ${name}`);
  row.claimed = true;
  return row;
}

function nameOf(ref: ExecutionRef): string {
  return `${ref.executionId}#${ref.generation}`;
}

class FakeBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  /** Keyed like Docker names the containers: execution id plus generation. */
  readonly containers = new Map<string, Container>();
  readonly ensureCalls: LaunchIntent[] = [];
  readonly terminateCalls: ExecutionRef[] = [];
  readonly terminateOptions: TerminateOptions[] = [];
  readonly assertReplaceableCalls: LaunchIntent[] = [];
  /** What each configured reference pins to; a moved tag is a new entry. */
  readonly imageIds = new Map<string, string>();
  readonly resolveCalls: string[] = [];
  failResolveImage = false;
  failEnsureFor = new Set<string>();
  /** Session ids whose container dies right after start (bad image). */
  exitOnStartFor = new Set<string>();
  /** Session ids whose create is taken but whose start the daemon cannot show. */
  createPendingFor = new Set<string>();
  /**
   * Session ids whose create gets no answer from the daemon: one that never
   * took, or one that did and was never started.
   */
  unansweredFor = new Map<string, "not_created" | "created">();
  /** Execution ids whose inspect throws (ownership conflict, stuck daemon call). */
  failInspectFor = new Set<string>();
  failTerminateFor = new Set<string>();
  /**
   * Containers whose worker is still draining its turn: a terminate that
   * does not wait for the exit finds them still there.
   */
  drainingFor = new Set<string>();
  /** Containers whose `stop` succeeds and whose `remove` then fails. */
  failRemoveFor = new Set<string>();
  /** Containers the provider reports as built on an older isolation contract. */
  staleFor = new Set<string>();
  /** Session ids whose replacement the provider says it could not create. */
  refuseReplacementFor = new Set<string>();
  mismatchTerminateFor = new Set<string>();
  duringInspect: ((ref: ExecutionRef) => void) | null = null;
  /** Runs after the pass decided to terminate and before the fake does. */
  duringTerminate: ((ref: ExecutionRef) => void) | null = null;
  /**
   * Runs after the pinned id matched and before the stop and remove by that
   * id — the window the real backend has between its name lookup and the
   * calls. Docker answers a stop or remove of an id that is gone with 404,
   * which counts as done.
   */
  afterPinCheck: ((ref: ExecutionRef) => void) | null = null;
  private created = 0;
  /** Volume name -> the session label on it, null when it carries none. */
  readonly workspaces = new Map<string, string | null>();
  /** Workspaces whose session comes from their name, not a label. */
  readonly legacyWorkspaces = new Set<string>();
  readonly workspacesInUse = new Set<string>();
  failListWorkspaces = false;
  failRemoveWorkspaceFor = new Set<string>();
  listWorkspaces?: () => Promise<ManagedWorkspace[]>;
  removeWorkspace?: (
    id: string,
    owner?: { sessionId: string },
  ) => Promise<WorkspaceRemovalResult>;
  reconcileNetworks?: () => Promise<NetworkReconcileResult>;

  /** `workspaceGc: false` is a backend that does not own its workspaces. */
  constructor(options: { workspaceGc?: boolean } = {}) {
    if (options.workspaceGc === false) return;
    this.listWorkspaces = async () => {
      if (this.failListWorkspaces) throw new Error("daemon unreachable");
      return [...this.workspaces.entries()].map(([id, sessionId]) => ({
        createdAt: new Date(0),
        id,
        sessionId,
        ...(this.legacyWorkspaces.has(id)
          ? { sessionFrom: "name" as const }
          : {}),
      }));
    };
    this.removeWorkspace = async (id, owner) => {
      if (this.failRemoveWorkspaceFor.has(id)) {
        throw new Error("volume remove failed");
      }
      if (this.workspacesInUse.has(id)) return { outcome: "in_use" };
      if (!this.workspaces.has(id)) return { outcome: "absent" };
      if (owner && this.workspaces.get(id) !== owner.sessionId) {
        return { outcome: "not_ours" };
      }
      this.workspaces.delete(id);
      return { outcome: "removed" };
    };
  }

  capabilities() {
    return { suspend: false };
  }

  async resolveImage(reference: string): Promise<string> {
    this.resolveCalls.push(reference);
    if (this.failResolveImage) {
      throw new Error(`Image ${reference} is not on this daemon`);
    }
    return this.imageIds.get(reference) ?? `sha256:${reference}`;
  }

  duringEnsure?: (intent: LaunchIntent) => void;
  /** Awaited on the create path just before the credential is asked for. */
  beforeCreate?: (intent: LaunchIntent) => Promise<void>;

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    this.ensureCalls.push(intent);
    this.duringEnsure?.(intent);
    if (this.failEnsureFor.has(intent.sessionId)) {
      throw new Error("docker unavailable");
    }
    const existing = this.containers.get(nameOf(intent));
    if (existing) {
      if (existing.operationId !== intent.operationId) {
        throw new Error("operation id mismatch");
      }
      // Refused, never removed, like the real backend.
      if (
        intent.launchSpec !== null &&
        existing.launchSpec !== undefined &&
        existing.launchSpec !== intent.launchSpec
      ) {
        throw new LaunchSpecMismatchError(intent, existing.launchSpec);
      }
      existing.started = true;
      return {
        created: false,
        providerRef: this.providerRefOf(nameOf(intent), existing),
        state: "running",
      };
    }
    const exited = this.exitOnStartFor.has(intent.sessionId);
    const pending = this.createPendingFor.has(intent.sessionId);
    await this.beforeCreate?.(intent);
    // A fresh container is built on the contract this backend speaks now.
    this.staleFor.delete(nameOf(intent));
    const container: Container = {
      exited,
      generation: intent.generation,
      id: `ctr-${intent.executionId}-${++this.created}`,
      ...(intent.launchSpec === null ? {} : { launchSpec: intent.launchSpec }),
      // Only the create path asks for one, like the real backend.
      nonce: await intent.issueBootstrapNonce(),
      operationId: intent.operationId,
      sessionId: intent.sessionId,
      ...(pending ? { started: false } : {}),
    };
    const unanswered = this.unansweredFor.get(intent.sessionId);
    const timedOut = new LaunchOutcomeUnknownError(intent, {
      cause: new Error("Docker API POST /containers/create timed out"),
    });
    if (unanswered === "not_created") throw timedOut;
    this.containers.set(nameOf(intent), container);
    if (unanswered === "created") {
      container.started = false;
      throw timedOut;
    }
    return {
      created: true,
      providerRef: this.providerRefOf(nameOf(intent), container),
      state: exited ? "terminated" : pending ? "pending" : "running",
    };
  }

  async assertReplaceable(intent: LaunchIntent): Promise<void> {
    this.assertReplaceableCalls.push(intent);
    if (this.refuseReplacementFor.has(intent.sessionId)) {
      throw new Error("Image worker:test is not on this daemon");
    }
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    // The one place a pass is demonstrably out on the network, and so the
    // place a test can make the rows move underneath it.
    this.duringInspect?.(ref);
    if (this.failInspectFor.has(ref.executionId)) {
      throw new Error("ownership conflict");
    }
    const container = this.containers.get(nameOf(ref));
    if (!container) {
      return {
        found: false,
        observedAt: new Date(),
        providerRef: null,
        state: "unknown",
      };
    }
    return {
      ...(container.exited ? (container.failure ?? { exitCode: 0 }) : {}),
      ...(this.staleFor.has(nameOf(ref)) ? { stale: true } : {}),
      // Labelled the way the real backend labels: from the nonce it was
      // created with, and nothing on a hand-seeded container.
      credentialFingerprint: fingerprintOf(container.nonce),
      found: true,
      launchSpec: container.launchSpec ?? null,
      observedAt: new Date(),
      providerRef: this.providerRefOf(nameOf(ref), container),
      state: container.exited
        ? "terminated"
        : container.removing
          ? "terminating"
          : container.started === false
            ? "pending"
            : "running",
    };
  }

  async listManaged(): Promise<ManagedExecution[]> {
    return [...this.containers.entries()].map(([name, c]) => ({
      executionId: name.split("#")[0] ?? name,
      generation: c.generation,
      providerRef: this.providerRefOf(name, c),
      sessionId: c.sessionId,
      state: c.exited ? "terminated" : "running",
    }));
  }

  /** Hand-seeded containers have no id; they are named like before. */
  private providerRefOf(name: string, container: Container): string {
    return container.id ?? `ctr-${name.split("#")[0] ?? name}`;
  }

  async terminate(
    ref: ExecutionRef,
    options: TerminateOptions = {},
  ): Promise<TerminateExecutionResult> {
    this.terminateCalls.push(ref);
    this.terminateOptions.push(options);
    if (this.failTerminateFor.has(nameOf(ref))) {
      throw new Error("docker stop failed");
    }
    this.duringTerminate?.(ref);
    const pinned = this.containers.get(nameOf(ref));
    if (
      pinned &&
      options.providerRef !== undefined &&
      this.providerRefOf(nameOf(ref), pinned) !== options.providerRef
    ) {
      return {
        foundProviderRef: this.providerRefOf(nameOf(ref), pinned),
        outcome: "provider_mismatch",
      };
    }
    if (pinned && options.providerRef !== undefined && this.afterPinCheck) {
      this.afterPinCheck(ref);
      const now = this.containers.get(nameOf(ref));
      if (
        !now ||
        this.providerRefOf(nameOf(ref), now) !== options.providerRef
      ) {
        return { outcome: "terminated", providerRef: options.providerRef };
      }
    }
    const stopped = this.containers.get(nameOf(ref));
    if (stopped && this.failRemoveFor.has(nameOf(ref))) {
      // Half a teardown: the container is exited and still there.
      stopped.exited = true;
      throw new Error("docker rm failed");
    }
    if (this.mismatchTerminateFor.has(nameOf(ref))) {
      return { foundGeneration: 99, outcome: "generation_mismatch" };
    }
    const container = this.containers.get(nameOf(ref));
    if (!container) {
      const other = [...this.containers.entries()].find(([name]) =>
        name.startsWith(`${ref.executionId}#`),
      );
      return other
        ? {
            foundGeneration: other[1].generation,
            outcome: "generation_mismatch",
          }
        : { outcome: "absent" };
    }
    if (options.waitForExit === false && this.drainingFor.has(nameOf(ref))) {
      return {
        outcome: "stopping",
        providerRef: this.providerRefOf(nameOf(ref), container),
      };
    }
    this.containers.delete(nameOf(ref));
    return { outcome: "terminated", providerRef: `ctr-${nameOf(ref)}` };
  }
}

function recordingLogger() {
  const records: Array<{ level: string; message: string; fields?: unknown }> =
    [];
  const logger: SchedulerLogger = {
    error: (message, fields) =>
      records.push({ level: "error", message, fields }),
    info: (message, fields) => records.push({ level: "info", message, fields }),
    warn: (message, fields) => records.push({ level: "warn", message, fields }),
  };
  return { logger, records };
}

function harness(
  slotLimit = 10,
  options: {
    drainDeadlineMs?: number;
    imageRuntime?: ImageRuntime;
    previousImage?: { image: string; runtime: ImageRuntime };
    stop?: AbortSignal;
    stopDeadlineMs?: number;
    stoppedWorkspaceTtlMs?: number;
    workspaceGc?: boolean;
  } = {},
) {
  const store = new MemoryStore();
  const backend = new FakeBackend(options);
  const { logger, records } = recordingLogger();
  const run = () =>
    runScheduler({
      backend,
      image: "worker:test",
      logger,
      resources: RESOURCES,
      slotLimit,
      ...(options.stoppedWorkspaceTtlMs === undefined
        ? {}
        : { stoppedWorkspaceTtlMs: options.stoppedWorkspaceTtlMs }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.imageRuntime === undefined
        ? {}
        : { imageRuntime: options.imageRuntime }),
      ...(options.previousImage === undefined
        ? {}
        : { previousImage: options.previousImage }),
      ...(options.drainDeadlineMs === undefined
        ? {}
        : { drainDeadlineMs: options.drainDeadlineMs }),
      ...(options.stopDeadlineMs === undefined
        ? {}
        : { stopDeadlineMs: options.stopDeadlineMs }),
      store,
    });
  const reclaim = () => reclaimWorkspaces({ backend, logger, store });
  return { backend, logger, reclaim, records, run, store };
}

describe("worker image per session", () => {
  const current: ImageRuntime = {
    engine: "claude",
    sdkVersion: "0.3.280",
    cliVersion: "2.1.280",
    profileDigestScheme: 1,
  };
  const previous: ImageRuntime = {
    ...current,
    sdkVersion: "0.3.270",
    cliVersion: "2.1.270",
  };
  const twoImages = {
    imageRuntime: current,
    previousImage: { image: "worker:previous", runtime: previous },
  };
  const launchedImageOf = (store: MemoryStore, sessionId: string) =>
    [...store.executions.values()].find((e) => e.sessionId === sessionId)
      ?.image;

  test("old checkpoints resume on the previous image; new sessions, ones with no checkpoint and unrecorded pointers on the current one", async () => {
    const { run, store } = harness(10, twoImages);
    const [sealedOld, sealedNew, fresh, unrecorded] = store.addUnassigned(4);
    store.pointers.set(sealedOld as string, {
      pointer: { kind: "recorded", runtime: previous },
      checkpointRevision: 3,
    });
    store.pointers.set(sealedNew as string, {
      pointer: { kind: "recorded", runtime: current },
      checkpointRevision: 1,
    });
    store.pointers.set(unrecorded as string, {
      pointer: { kind: "unrecorded" },
      checkpointRevision: 2,
    });
    const summary = await run();
    expect(summary.launched).toHaveLength(4);
    expect(launchedImageOf(store, sealedOld as string)).toBe(
      "sha256:worker:previous",
    );
    expect(store.reservedRuntimes.get(sealedOld as string)).toEqual(previous);
    for (const id of [sealedNew, fresh, unrecorded]) {
      expect(launchedImageOf(store, id as string)).toBe("sha256:worker:test");
      expect(store.reservedRuntimes.get(id as string)).toEqual(current);
    }
  });

  test("without a previous image, a session sealed on it is stopped before launch", async () => {
    const { backend, run, store } = harness(10, { imageRuntime: current });
    const [sealedOld] = store.addUnassigned(1);
    store.pointers.set(sealedOld as string, {
      pointer: { kind: "recorded", runtime: previous },
      checkpointRevision: 3,
    });
    const summary = await run();
    expect(summary.launched).toHaveLength(0);
    expect(summary.heldIncompatible).toEqual([sealedOld as string]);
    expect(backend.containers.size).toBe(0);
    expect(store.held.get(sealedOld as string)).toContain("sdk 0.3.270");
  });

  test("an image a worker refused under its configured runtime launches nothing; the other one still does", async () => {
    const { run, store } = harness(10, twoImages);
    store.refusals.push({ image: "sha256:worker:previous", assumed: previous });
    const [sealedOld, fresh] = store.addUnassigned(2);
    store.pointers.set(sealedOld as string, {
      pointer: { kind: "recorded", runtime: previous },
      checkpointRevision: 3,
    });
    const summary = await run();
    expect(summary.imagesRefused).toEqual(["sha256:worker:previous"]);
    expect(summary.launched).toHaveLength(1);
    expect(launchedImageOf(store, fresh as string)).toBe("sha256:worker:test");
    expect(launchedImageOf(store, sealedOld as string)).toBeUndefined();
    // The session waits for the image to be fixed; it is not stopped.
    expect(store.held.size).toBe(0);
    expect(store.unassigned.has(sealedOld as string)).toBe(true);
    // A refusal under another assumed runtime is not this one.
    store.refusals.length = 0;
    store.refusals.push({
      image: "sha256:worker:previous",
      assumed: { ...previous, cliVersion: "2.1.269" },
    });
    expect((await run()).imagesRefused).toEqual([]);
    expect(launchedImageOf(store, sealedOld as string)).toBe(
      "sha256:worker:previous",
    );
  });

  test("sessions waiting on a refused image do not keep the next in line from a free slot", async () => {
    const { run, store } = harness(1, twoImages);
    store.refusals.push({ image: "sha256:worker:previous", assumed: previous });
    const [first, second, fresh] = store.addUnassigned(3);
    for (const id of [first, second]) {
      store.pointers.set(id as string, {
        pointer: { kind: "recorded", runtime: previous },
        checkpointRevision: 3,
      });
    }
    const summary = await run();
    expect(summary.launched).toHaveLength(1);
    expect(launchedImageOf(store, fresh as string)).toBe("sha256:worker:test");
    expect(store.unassigned.has(first as string)).toBe(true);
    expect(store.unassigned.has(second as string)).toBe(true);
  });

  test("one digest configured under two runtimes is refused only under the one a worker contradicted", async () => {
    const { run, store } = harness(10, {
      imageRuntime: current,
      previousImage: { image: "worker:test", runtime: previous },
    });
    store.refusals.push({ image: "sha256:worker:test", assumed: previous });
    const [sealedOld, fresh] = store.addUnassigned(2);
    store.pointers.set(sealedOld as string, {
      pointer: { kind: "recorded", runtime: previous },
      checkpointRevision: 3,
    });
    const summary = await run();
    expect(summary.imagesRefused).toEqual(["sha256:worker:test"]);
    expect(summary.launched).toHaveLength(1);
    expect(store.reservedRuntimes.get(fresh as string)).toEqual(current);
    expect(launchedImageOf(store, sealedOld as string)).toBeUndefined();
  });

  test("without an image runtime every session launches on the configured image, as before", async () => {
    const { run, store } = harness(10);
    const [sealedOld] = store.addUnassigned(1);
    store.pointers.set(sealedOld as string, {
      pointer: { kind: "recorded", runtime: previous },
      checkpointRevision: 3,
    });
    expect((await run()).launched).toHaveLength(1);
    expect(store.reservedRuntimes.get(sealedOld as string)).toBeUndefined();
  });

  test("an image that cannot be pinned admits nothing", async () => {
    const { backend, run, store } = harness(10, twoImages);
    store.addUnassigned(1);
    backend.failResolveImage = true;
    const summary = await run();
    expect(summary.imageUnresolved).toBe(true);
    expect(summary.launched).toHaveLength(0);
    expect(store.held.size).toBe(0);
  });
});

describe("runScheduler", () => {
  test("never launches past the slot limit and fills freed slots later", async () => {
    const { backend, run, store } = harness(10);
    store.addUnassigned(15);

    const first = await run();
    expect(first.launched).toHaveLength(10);
    expect(backend.containers.size).toBe(10);
    expect(first.activeAfter).toBe(10);

    const second = await run();
    expect(second.launched).toHaveLength(0);
    expect(backend.containers.size).toBe(10);

    for (const [name, container] of [...backend.containers.entries()].slice(
      0,
      3,
    )) {
      claimLaunchOf(store, name);
      container.exited = true;
    }
    const third = await run();
    expect(third.terminatedObserved).toHaveLength(3);
    expect(third.launched).toHaveLength(3);
    expect(backend.containers.size).toBe(10);
    expect(
      [...store.executions.values()].filter(
        (e) => e.observedState === "terminated",
      ),
    ).toHaveLength(3);
  });

  test("a failed exit's reason and log tail are logged before the resource goes", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(2);
    await run();
    const failure = {
      exitCode: 137,
      logTail: "allocating\n",
      terminationReason: "OOMKilled",
    };
    const [claimed, unclaimed] = [...backend.containers.entries()];
    if (!claimed || !unclaimed) throw new Error("no containers");
    claimLaunchOf(store, claimed[0]);
    for (const [, container] of [claimed, unclaimed]) {
      container.exited = true;
      container.failure = failure;
    }
    const present: boolean[] = [];
    backend.duringTerminate = (ref) => {
      present.push(
        records.some(
          (r) =>
            r.message === "Execution resource failed; log tail kept" &&
            (r.fields as { execution_id: string }).execution_id ===
              ref.executionId,
        ),
      );
    };
    await run();
    expect(present).toEqual([true, true]);
    const kept = records.filter(
      (r) => r.message === "Execution resource failed; log tail kept",
    );
    expect(kept.map((r) => r.fields)).toEqual(
      [claimed, unclaimed].map(([name]) =>
        expect.objectContaining({
          execution_id: name.split("#")[0],
          exit_code: 137,
          log_tail: "allocating\n",
          termination_reason: "OOMKilled",
        }),
      ),
    );
    expect(
      records.find((r) => r.message === "Execution exited; resource reclaimed")
        ?.fields,
    ).toMatchObject({ exit_code: 137, termination_reason: "OOMKilled" });
    expect(
      records.find(
        (r) => r.message === "Launch attempt failed; retrying after a backoff",
      )?.fields,
    ).toMatchObject({
      error:
        "resource exited before a worker claimed it (exit code 137, OOMKilled)",
    });
  });

  test("a worker that exited for a lost lease ends its attempt saying so; any other exit is just gone", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(2);
    await run();
    const [leaseLost, failed] = [...backend.containers.entries()];
    if (!leaseLost || !failed) throw new Error("no containers");
    for (const [name, container] of [leaseLost, failed]) {
      claimLaunchOf(store, name);
      container.exited = true;
    }
    leaseLost[1].failure = {
      exitCode: WORKER_EXIT_LEASE_LOST,
      logTail: "lease given up\n",
      terminationReason: "Error",
    };
    failed[1].failure = {
      exitCode: 1,
      logTail: "failed\n",
      terminationReason: "Error",
    };
    await run();

    expect(store.confirmEndReasons.get(leaseLost[0].split("#")[0] ?? "")).toBe(
      "worker_lease_lost",
    );
    expect(store.confirmEndReasons.has(failed[0].split("#")[0] ?? "")).toBe(
      true,
    );
    expect(
      store.confirmEndReasons.get(failed[0].split("#")[0] ?? ""),
    ).toBeUndefined();
  });

  test("a session with a live execution is not launched twice", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    await run();
    await run();
    await run();
    expect(
      backend.ensureCalls.filter((i) => i.sessionId === sessionId).length,
    ).toBeGreaterThan(0);
    expect(backend.containers.size).toBe(1);
    expect(
      [...store.executions.values()].filter((e) => e.sessionId === sessionId),
    ).toHaveLength(1);
  });

  test("an intent whose resource is missing is re-created with the same intent", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    expect(intent).toBeDefined();
    if (!intent) throw new Error("no intent");

    const firstNonce = [...backend.containers.values()][0]?.nonce;
    expect(firstNonce).toBeString();

    // Control host restart after commit but before Docker created anything.
    backend.containers.clear();
    const summary = await run();

    expect(summary.reensured).toEqual([
      { executionId: intent.executionId, generation: intent.generation },
    ]);
    expect(summary.launched).toHaveLength(0);
    expect(backend.containers.size).toBe(1);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(intent.operationId);
    // The identity is the same launch; the credential is not. The container
    // that held the old nonce is gone, so nothing is cut off by rotating it.
    const replacement = [...backend.containers.values()][0];
    expect(replacement?.nonce).not.toBe(firstNonce);
    expect(store.executions.get(intent.executionId)?.nonce).toBe(
      replacement?.nonce,
    );
    expect(
      records.some(
        (r) =>
          r.level === "warn" && r.message.includes("re-created from intent"),
      ),
    ).toBe(true);
  });

  test("a running resource on an older isolation contract is replaced", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };

    // The control host was upgraded; the container it launched was not.
    backend.staleFor.add(`${intent.executionId}#1`);
    const summary = await run();

    expect(summary.replaced).toEqual([ref]);
    expect(summary.reensured).toEqual([ref]);
    expect(backend.terminateCalls).toEqual([ref]);
    expect(backend.containers.size).toBe(1);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(intent.operationId);
    expect(store.executions.get(intent.executionId)?.observedState).toBe(
      "running",
    );
    expect(
      records.some((r) =>
        r.message.includes("predates the isolation contract"),
      ),
    ).toBe(true);

    // The replacement is current, so the next pass leaves it alone.
    const after = await run();
    expect(after.replaced).toHaveLength(0);
    expect(after.reensured).toHaveLength(0);
  });

  describe("a claimed resource on an older isolation contract", () => {
    function claimedStale(
      store: MemoryStore,
      backend: FakeBackend,
    ): { ref: ExecutionRef; sessionId: string } {
      const row = store.seedActive({
        claimed: true,
        executionId: "exec-1",
        observedState: "running",
      });
      backend.containers.set("exec-1#1", {
        exited: false,
        generation: 1,
        operationId: row.operationId ?? "op",
        sessionId: row.sessionId,
      });
      backend.staleFor.add("exec-1#1");
      return {
        ref: { executionId: "exec-1", generation: 1 },
        sessionId: row.sessionId,
      };
    }

    test("is left running while its turn runs, and replaced on the pass after the turn ends", async () => {
      const { backend, records, run, store } = harness();
      const { ref, sessionId } = claimedStale(store, backend);
      store.busySessions.add(sessionId);

      const first = await run();
      expect(first.draining).toEqual([ref]);
      expect(first.replaced).toEqual([]);
      expect(backend.terminateCalls).toEqual([]);
      expect(backend.containers.get("exec-1#1")?.exited).toBe(false);
      expect(store.confirmedGone).toEqual([]);
      const requestedAt = store.executions.get("exec-1")?.drainRequestedAt;
      expect(requestedAt).toBeDefined();

      // Still running: the request keeps its first time.
      store.elapse(1_000);
      expect((await run()).draining).toEqual([ref]);
      expect(store.executions.get("exec-1")?.drainRequestedAt).toBe(
        requestedAt,
      );

      store.busySessions.delete(sessionId);
      const after = await run();
      expect(after.draining).toEqual([]);
      expect(after.drainsOverdue).toEqual([]);
      expect(after.replaced).toEqual([ref]);
      expect(backend.terminateCalls).toEqual([ref]);
      expect(store.confirmedGone).toEqual(["exec-1"]);
      // Nothing is rebuilt from a claimed launch; the session gets a new one.
      expect(backend.ensureCalls).toEqual([]);
      expect(
        records.filter((r) => r.message.includes("Drain deadline passed")),
      ).toEqual([]);
    });

    test("with no turn open is replaced at once, as before", async () => {
      const { backend, run, store } = harness();
      const { ref } = claimedStale(store, backend);
      const summary = await run();
      expect(summary.draining).toEqual([]);
      expect(summary.replaced).toEqual([ref]);
      expect(store.confirmedGone).toEqual(["exec-1"]);
    });

    test("is replaced with its turn still open once the drain deadline passes, and says so", async () => {
      const { backend, records, run, store } = harness(10, {
        drainDeadlineMs: 60_000,
      });
      const { ref, sessionId } = claimedStale(store, backend);
      store.busySessions.add(sessionId);
      expect((await run()).draining).toEqual([ref]);

      store.elapse(60_000);
      const overdue = await run();
      expect(overdue.draining).toEqual([]);
      expect(overdue.drainsOverdue).toEqual([ref]);
      expect(overdue.replaced).toEqual([ref]);
      expect(backend.terminateCalls).toEqual([ref]);
      expect(store.confirmedGone).toEqual(["exec-1"]);
      expect(
        records.filter(
          (r) =>
            r.level === "warn" && r.message.includes("Drain deadline passed"),
        ),
      ).toHaveLength(1);
    });

    test("past the drain deadline is not waited on while it winds down", async () => {
      const { backend, records, run, store } = harness(10, {
        drainDeadlineMs: 60_000,
      });
      const { ref, sessionId } = claimedStale(store, backend);
      store.busySessions.add(sessionId);
      await run();
      store.elapse(60_000);
      backend.drainingFor.add("exec-1#1");

      const stopping = await run();
      expect(stopping.drainsOverdue).toEqual([ref]);
      expect(stopping.replaced).toEqual([]);
      expect(stopping.reconcileFailed).toEqual([]);
      expect(store.confirmedGone).toEqual([]);
      expect(records.filter((r) => r.level === "error")).toEqual([]);

      backend.drainingFor.clear();
      const replaced = await run();
      expect(replaced.replaced).toEqual([ref]);
      expect(store.confirmedGone).toEqual(["exec-1"]);
    });
  });

  test("a stale-isolation replacement does not revoke a credential issued since it was judged", async () => {
    // Every reason is fenced on the credential, not only a mismatch: another
    // pass's `ensureExecution` issues anew without counting a replacement,
    // so a matching count says nothing about the credential.
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const row = store.executions.get(intent.executionId);
    if (!row) throw new Error("no row");
    backend.staleFor.add(`${intent.executionId}#1`);
    const fresh = `nonce-${crypto.randomUUID()}`;
    backend.duringInspect = () => {
      row.nonce = fresh;
      backend.duringInspect = null;
    };

    const summary = await run();

    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(row.nonce).toBe(fresh);
    expect(row.replacementCount).toBe(0);
    expect(row.pendingReplacement).toBeNull();
    expect(
      records.some((r) => r.level === "info" && r.message.includes("moved on")),
    ).toBe(true);
  });

  test("a stale resource whose replacement cannot be built is left running", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };

    // The upgrade marks it stale, but the image it would be rebuilt from is
    // gone. Tearing it down here would leave the session with no worker and
    // nothing to retry into, so the stale one keeps running.
    backend.staleFor.add(`${intent.executionId}#1`);
    backend.refuseReplacementFor.add(intent.sessionId);
    const summary = await run();

    // A launch that cannot be built is a failed attempt: counted, and the
    // credential the stale resource holds is revoked with the record.
    expect(summary.failedLaunches).toEqual([ref]);
    expect(summary.replaced).toHaveLength(0);
    expect(backend.terminateCalls).toHaveLength(0);
    expect(backend.containers.size).toBe(1);
    expect(backend.ensureCalls).toHaveLength(1);
    expect(store.executions.get(intent.executionId)?.launchFailureCount).toBe(
      1,
    );
    expect(
      records.some((r) => r.message.includes("Replacement would not launch")),
    ).toBe(true);

    // The image comes back. The stale resource can no longer bind, so it is
    // cleared as what the failed attempt left behind — without spending the
    // replacement budget on it — and the backoff holds the rebuild.
    backend.refuseReplacementFor.clear();
    const waiting = await run();
    expect(waiting.launchesBackingOff).toEqual([ref]);
    expect(waiting.replaced).toEqual([]);
    expect(backend.terminateCalls).toHaveLength(1);
    expect(backend.containers.size).toBe(0);

    // Once the backoff allows, the launch is built again.
    store.elapse(60_000);
    const after = await run();
    expect(after.reensured).toEqual([ref]);
    expect(after.replaced).toEqual([]);
    expect(store.executions.get(intent.executionId)?.replacementCount).toBe(0);
    expect(backend.containers.get(`${intent.executionId}#1`)?.nonce).toBe(
      store.executions.get(intent.executionId)?.nonce ?? "missing",
    );
  });

  test("a stale resource the provider will not terminate keeps its slot", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };

    backend.staleFor.add(`${intent.executionId}#1`);
    backend.failTerminateFor.add(`${intent.executionId}#1`);
    const summary = await run();

    expect(summary.reconcileFailed).toEqual([ref]);
    expect(summary.replaced).toHaveLength(0);
    expect(backend.containers.size).toBe(1);
    expect(backend.ensureCalls).toHaveLength(1);
  });

  test("a replacement whose teardown only half happened is finished by the next pass with the same intent", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };
    const name = `${intent.executionId}#1`;

    // `stop` goes through, `rm` does not: the container is left exited.
    backend.staleFor.add(name);
    backend.failRemoveFor.add(name);
    const first = await run();
    expect(first.reconcileFailed).toEqual([ref]);
    expect(first.replaced).toHaveLength(0);
    expect(backend.containers.get(name)?.exited).toBe(true);
    // The intent to rebuild was written before the teardown began.
    const row = store.executions.get(intent.executionId);
    expect(row?.pendingReplacement).toBe("stale_isolation");
    expect(row?.replacementCount).toBe(1);
    expect(row?.slotReleased).toBe(false);
    expect(store.confirmedGone).toEqual([]);

    // The next pass sees an exited container. Without the record it would
    // close the launch and reschedule the session under generation 2.
    backend.failRemoveFor.clear();
    const second = await run();
    expect(second.replaced).toEqual([ref]);
    expect(second.reensured).toEqual([ref]);
    expect(second.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.executionId).toBe(intent.executionId);
    expect(again?.generation).toBe(1);
    expect(again?.operationId).toBe(intent.operationId);
    expect(backend.containers.size).toBe(1);
    expect(backend.containers.get(name)?.exited).toBe(false);
    expect(store.executions.size).toBe(1);
    expect(row?.pendingReplacement).toBeNull();
    // Finishing the replacement the first pass recorded is not another one.
    expect(row?.replacementCount).toBe(1);
    expect(row?.observedState).toBe("running");

    // Settled: the next pass leaves the replacement alone.
    const third = await run();
    expect(third.replaced).toHaveLength(0);
    expect(third.reensured).toHaveLength(0);
    expect(backend.terminateCalls).toHaveLength(2);
  });

  test("an expired-nonce replacement survives a half teardown and gets a fresh credential", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const name = `${intent.executionId}#1`;
    const row = store.executions.get(intent.executionId);
    if (!row?.nonceExpiresAt) throw new Error("no nonce");
    const oldNonce = backend.containers.get(name)?.nonce;
    row.nonceExpiresAt = new Date(Date.now() - 1);

    backend.failRemoveFor.add(name);
    const first = await run();
    expect(first.reconcileFailed).toHaveLength(1);
    expect(row.pendingReplacement).toBe("nonce_expired");

    backend.failRemoveFor.clear();
    const second = await run();
    expect(second.reensured).toEqual([
      { executionId: intent.executionId, generation: 1 },
    ]);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.containers.get(name)?.nonce).not.toBe(oldNonce);
    expect(row.nonceExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.pendingReplacement).toBeNull();
  });

  test("a control host that died between the record and the teardown loses nothing", async () => {
    const { backend, run, store } = harness();
    // Recorded, never torn down: the stale container is still running.
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    backend.staleFor.add("exec-1#1");
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.replaced).toEqual([ref]);
    expect(summary.reensured).toEqual([ref]);
    expect(store.confirmedGone).toEqual([]);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(row.operationId ?? undefined);
    expect(row.pendingReplacement).toBeNull();
    // Unlabelled, it cannot be shown to be the old resource, so the
    // replacement is asked for, and counted, again.
    expect(row.replacementCount).toBe(2);
  });

  test("a control host that died after the teardown rebuilds instead of closing the launch", async () => {
    const { backend, run, store } = harness();
    // Torn down, not rebuilt, not recorded: nothing on the provider, and
    // the row still says running. Without the record this is "missing" and
    // would be re-ensured anyway; with the row saying `terminating` it would
    // be read as reclaimed and closed.
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "terminating",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.reensured).toEqual([ref]);
    expect(summary.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(row.operationId ?? undefined);
    expect(row.pendingReplacement).toBeNull();
  });

  test("a replacement that landed before the host died is settled, not rebuilt again", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    // Current contract, running: this is the replacement itself.
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });

    const summary = await run();
    expect(summary.replaced).toHaveLength(0);
    expect(summary.reensured).toHaveLength(0);
    expect(backend.terminateCalls).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(1);
  });

  test("a replacement caught on its way out is rebuilt, not settled into an exit", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      pendingReplacement: "stale_isolation",
      replacementCount: 1,
    });
    // Docker `removing`: the half-torn-down old container, still visible.
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      removing: true,
      sessionId: row.sessionId,
    });
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.replaced).toEqual([ref]);
    expect(summary.reensured).toEqual([ref]);
    expect(store.confirmedGone).toEqual([]);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(2);
    expect(backend.containers.get("exec-1#1")?.removing).toBeUndefined();
  });

  test("a replacement created but never started is started, not rebuilt or counted", async () => {
    const { backend, run, store } = harness();
    // The host died between Docker create and start, with the count already
    // at the limit: tearing this one down would strand a startable
    // container behind an exhausted launch.
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      pendingReplacement: "stale_isolation",
      replacementCount: 3,
    });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
      started: false,
    });
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.reensured).toEqual([ref]);
    expect(summary.replaced).toEqual([]);
    expect(summary.replacementsExhausted).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(backend.containers.get("exec-1#1")?.started).toBe(true);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(3);
  });

  test("a rebuilt resource the daemon cannot yet show running keeps the intent until it can", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent || !sessionId) throw new Error("no intent");
    const name = `${intent.executionId}#1`;
    const row = store.executions.get(intent.executionId);
    if (!row) throw new Error("no row");

    // Start accepted, post-start inspect comes back `created`: launched,
    // but not yet proven. Settling here would make a container that dies
    // in the next second an ordinary exit.
    backend.staleFor.add(name);
    backend.createPendingFor.add(sessionId);
    const first = await run();
    expect(first.reensured).toEqual([
      { executionId: intent.executionId, generation: 1 },
    ]);
    expect(row.pendingReplacement).toBe("stale_isolation");
    expect(row.replacementCount).toBe(1);

    // Next pass: still `created`, adopted and started, and only then settled.
    backend.createPendingFor.clear();
    const second = await run();
    expect(second.reensured).toHaveLength(1);
    expect(second.replaced).toHaveLength(0);
    expect(backend.containers.get(name)?.started).toBe(true);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(1);
  });

  test("a claimed launch ignores a pending replacement and is closed like any exit", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      claimed: true,
      executionId: "exec-1",
      observedState: "running",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    backend.containers.set("exec-1#1", {
      exited: true,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });

    const summary = await run();
    expect(summary.terminatedObserved).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toHaveLength(0);
    expect(store.confirmedGone).toEqual(["exec-1"]);
    expect(backend.ensureCalls).toEqual([]);
  });

  test("a launch that keeps needing replacement is left alone at the limit", async () => {
    const { backend, records, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent || !sessionId) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };
    const name = `${intent.executionId}#1`;
    const row = store.executions.get(intent.executionId);
    if (!row) throw new Error("no row");

    // Every rebuild comes up and is judged replaceable again, so every pass
    // replaces it. (A rebuild that fails is a launch failure instead, and
    // spends the launch's failure budget, not this one.)
    for (const count of [1, 2, 3]) {
      backend.staleFor.add(name);
      const pass = await run();
      expect(pass.replaced).toEqual([ref]);
      expect(pass.reensured).toEqual([ref]);
      expect(row.replacementCount).toBe(count);
    }
    expect(store.confirmedGone).toEqual([]);

    // DEFAULT_REPLACEMENT_LIMIT rebuilds are spent. Nothing is torn down,
    // nothing is built, nothing is released: the launch keeps its slot and
    // the pass keeps failing until someone looks.
    backend.staleFor.add(name);
    for (const _ of [1, 2]) {
      const exhausted = await run();
      expect(exhausted.replacementsExhausted).toEqual([ref]);
      expect(exhausted.replaced).toHaveLength(0);
      expect(exhausted.reensured).toHaveLength(0);
      expect(exhausted.terminatedObserved).toHaveLength(0);
      expect(exhausted.launched).toHaveLength(0);
    }
    expect(store.confirmedGone).toEqual([]);
    expect(row.replacementCount).toBe(3);
    expect(row.slotReleased).toBe(false);
    expect(backend.containers.get(name)?.exited).toBe(false);
    expect(backend.terminateCalls).toHaveLength(3);
    expect(backend.ensureCalls).toHaveLength(4);
    expect(
      records.filter((r) => r.message.includes("Replacement limit reached")),
    ).toHaveLength(2);
  });

  test("the replacement count survives a settle, so a launch cannot be rebuilt forever", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      pendingReplacement: null,
      replacementCount: 3,
    });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    // Rebuilt three times already, judged stale once more.
    backend.staleFor.add("exec-1#1");

    const summary = await run();
    expect(summary.replacementsExhausted).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.terminateCalls).toEqual([]);
    expect(backend.containers.get("exec-1#1")?.exited).toBe(false);
  });

  test("hung unclaimed workers are not waited on, and each replacement is counted once", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(2);
    await run();
    const names = backend.ensureCalls.map((i) => `${i.executionId}#1`);
    const rows = [...store.executions.values()];
    expect(names).toHaveLength(2);
    // Neither answers its SIGTERM: a pass that waited would sit out both
    // stops back to back.
    for (const name of names) {
      backend.staleFor.add(name);
      backend.drainingFor.add(name);
    }

    for (const _ of [1, 2, 3, 4]) {
      const pass = await run();
      expect(pass.replaced).toEqual([]);
      expect(pass.replacementsExhausted).toEqual([]);
      expect(pass.reconcileFailed).toEqual([]);
    }
    expect(backend.terminateOptions.length).toBeGreaterThan(0);
    expect(backend.terminateOptions.every((o) => o.waitForExit === false)).toBe(
      true,
    );
    for (const row of rows) {
      expect(row.pendingReplacement).toBe("stale_isolation");
      expect(row.replacementCount).toBe(1);
    }

    backend.drainingFor.clear();
    const done = await run();
    expect(done.replaced).toHaveLength(2);
    expect(done.reensured).toHaveLength(2);
    for (const row of rows) {
      expect(row.pendingReplacement).toBeNull();
      expect(row.replacementCount).toBe(1);
    }
  });

  /** A replacement rebuilt but not yet seen running, so still pending. */
  async function unsettledRebuild() {
    const fixture = harness();
    const { backend, run, store } = fixture;
    const [sessionId] = store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent || !sessionId) throw new Error("no intent");
    const name = `${intent.executionId}#1`;
    const row = store.executions.get(intent.executionId);
    if (!row) throw new Error("no row");
    backend.staleFor.add(name);
    backend.createPendingFor.add(sessionId);
    await run();
    backend.createPendingFor.clear();
    expect(row.pendingReplacement).toBe("stale_isolation");
    expect(row.replacementCount).toBe(1);
    expect(row.nonce).not.toBeNull();
    return { ...fixture, name, row };
  }

  test("an unlabelled unclaimed resource is waited on, so its replacement is counted once", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
    });
    // Built before the credential label: nothing shows a later pass that it
    // is the old resource, so a teardown left stopping would be asked for,
    // and counted, again.
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    backend.staleFor.add("exec-1#1");
    backend.drainingFor.add("exec-1#1");

    for (const _ of [1, 2, 3]) await run();
    expect(backend.terminateOptions[0]?.waitForExit).toBe(true);
    expect(row.replacementCount).toBe(1);
  });

  test("a rebuilt replacement judged again is a new replacement and is counted", async () => {
    const { backend, run, name, row } = await unsettledRebuild();
    backend.staleFor.add(name);
    const again = await run();
    expect(again.replaced).toHaveLength(1);
    expect(row.replacementCount).toBe(2);
  });

  test("a rebuilt replacement a worker binds to while it is judged again is left to it", async () => {
    const { backend, run, store, name, row } = await unsettledRebuild();
    backend.staleFor.add(name);
    backend.duringInspect = () => {
      claimLaunchOf(store, name);
    };
    const raced = await run();
    expect(raced.replaced).toEqual([]);
    expect(backend.containers.has(name)).toBe(true);
    expect(row.replacementCount).toBe(1);
  });

  test("a created-but-never-started resource is started through the same intent", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({ executionId: "exec-1" });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
      started: false,
    });
    const summary = await run();
    expect(summary.reensured).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.containers.get("exec-1#1")?.started).toBe(true);
    expect(store.executions.get("exec-1")?.observedState).toBe("running");
    // Adopting is not creating: the container's own nonce is still the only
    // credential for this launch, so nothing was issued behind its back.
    expect(store.executions.get("exec-1")?.nonce).toBeNull();
  });

  test("a running resource whose nonce expired before it claimed is replaced", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    const first = container.nonce;

    // The bootstrap door shut and nobody came through it. The container still
    // runs, so without this it would hold its slot and its session for good.
    row.nonceExpiresAt = new Date(Date.now() - 1);
    const summary = await run();

    expect(summary.replaced).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(summary.reensured).toHaveLength(1);
    expect(store.confirmedGone).toEqual([]);
    const replacement = [...backend.containers.values()][0];
    expect(replacement?.nonce).not.toBe(first);
    expect(row.nonceExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      records.some(
        (r) => r.level === "warn" && r.message.includes("Launch nonce expired"),
      ),
    ).toBe(true);
  });

  test("a running resource whose credential the launch rotated past is replaced", async () => {
    // A create from an earlier pass that landed late, after the registry had
    // already issued again — and no `ensureExecution` in between to judge it
    // (the pass that would have crashed, or lost its lock). The container
    // can never claim with what it holds.
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    const held = container.nonce;
    row.nonce = `nonce-${crypto.randomUUID()}`;

    const summary = await run();

    expect(summary.replaced).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(summary.reensured).toHaveLength(1);
    expect(store.confirmedGone).toEqual([]);
    expect(row.replacementCount).toBe(1);
    expect(row.pendingReplacement).toBeNull();
    const replacement = [...backend.containers.values()][0];
    expect(replacement?.nonce).not.toBe(held);
    expect(fingerprintOf(replacement?.nonce)).toBe(fingerprintOf(row.nonce));
    expect(
      records.some(
        (r) =>
          r.level === "warn" &&
          r.message.includes("credential the launch no longer accepts"),
      ),
    ).toBe(true);
  });

  test("a credential mismatch is not acted on once the launch has moved on", async () => {
    // Another pass (one that still held the lock) replaced the resource and
    // its worker claimed while this pass was out inspecting: the snapshot
    // says mismatch, the registry says bound. The replacement record is
    // refused, and the terminate that would have taken the new worker never
    // runs.
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.nonce = `nonce-${crypto.randomUUID()}`;
    backend.duringInspect = () => {
      row.nonce = `nonce-${crypto.randomUUID()}`;
      row.claimed = true;
      backend.duringInspect = null;
    };

    const summary = await run();

    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(
      records.some((r) => r.level === "info" && r.message.includes("moved on")),
    ).toBe(true);
  });

  test("a replacement built by another pass after the record is not torn down", async () => {
    // The replacement was recorded and, before this pass got to the
    // terminate, a pass that still held the lock replaced the resource and
    // its worker claimed. The teardown is pinned to the resource this pass
    // inspected, so the replacement — the one that is bound — is refused
    // and left running.
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.nonce = `nonce-${crypto.randomUUID()}`;
    const replacementNonce = `nonce-${crypto.randomUUID()}`;
    backend.duringTerminate = () => {
      backend.containers.set(name, {
        ...container,
        id: `${container.id}-replacement`,
        nonce: replacementNonce,
      });
      row.nonce = replacementNonce;
      row.claimed = true;
      backend.duringTerminate = null;
    };

    const summary = await run();

    expect(summary.replaced).toEqual([]);
    expect(summary.reconcileFailed).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.containers.get(name)?.nonce).toBe(replacementNonce);
    expect(
      records.some(
        (r) =>
          r.level === "error" &&
          r.message.includes("would not terminate") &&
          (r.fields as { outcome?: string } | undefined)?.outcome ===
            "provider_mismatch",
      ),
    ).toBe(true);
  });

  test("a credential mismatch on a claimed launch is left alone", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name] = [...backend.containers.keys()];
    const row = store.executions.get(name?.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.claimed = true;
    row.nonce = `nonce-${crypto.randomUUID()}`;

    const summary = await run();
    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
  });

  test("a resource without a credential label is not judged by one", async () => {
    const { backend, run, store } = harness();
    const seeded = store.seedActive({
      nonce: "nonce-issued",
      nonceExpiresAt: new Date(Date.now() + NONCE_TTL_MS),
    });
    // A container from before the label: adopted as it always was.
    backend.containers.set(nameOf(seeded), {
      exited: false,
      generation: 1,
      operationId: seeded.operationId ?? "",
      sessionId: seeded.sessionId,
    });

    const summary = await run();
    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
  });

  test("a resource left running by a pass that died after recording its replacement is replaced, not settled", async () => {
    // `requestReplacement` shut the door and the host died before the
    // teardown: the registry accepts nothing, the old container is still up
    // with its old label. The pending branch would read it as the
    // replacement and settle it, stranding a launch nothing can claim.
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    const held = container.nonce;
    row.nonce = null;
    row.pendingReplacement = "credential_mismatch";
    row.replacementCount = 1;

    const summary = await run();

    expect(summary.replaced).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(1);
    expect(row.nonce).not.toBeNull();
    const replacement = [...backend.containers.values()][0];
    expect(replacement?.nonce).not.toBe(held);
    expect(fingerprintOf(replacement?.nonce)).toBe(fingerprintOf(row.nonce));
    expect(
      records.some((r) => r.message.includes("already running; settled")),
    ).toBe(false);
  });

  test("a credential mismatch does not revoke a credential issued since it was judged", async () => {
    // Another pass rebuilt the resource through `ensureExecution` — which
    // issues anew without counting a replacement — while this pass was out
    // inspecting. The count still matches; only the fingerprint says the
    // snapshot is stale. The record is refused, the fresh credential stands.
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.nonce = `nonce-${crypto.randomUUID()}`;
    const fresh = `nonce-${crypto.randomUUID()}`;
    backend.duringInspect = () => {
      row.nonce = fresh;
      backend.duringInspect = null;
    };

    const summary = await run();

    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(row.nonce).toBe(fresh);
    expect(row.replacementCount).toBe(0);
    expect(
      records.some((r) => r.level === "info" && r.message.includes("moved on")),
    ).toBe(true);
  });

  test("an expired nonce on a claimed launch is left alone", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name] = [...backend.containers.keys()];
    const row = store.executions.get(name?.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    // A worker already traded the nonce: its expiry says nothing any more.
    row.claimed = true;
    row.nonceExpiresAt = new Date(Date.now() - 1);

    const summary = await run();
    expect(summary.replaced).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
  });

  test("a claim that lands mid-pass keeps its container off the replacement path", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    const claimedNonce = container.nonce;
    row.nonceExpiresAt = new Date(Date.now() - 1);
    // A worker gets through the door after the pass read the rows and before
    // it decides: the expiry the pass is holding is already out of date.
    backend.duringInspect = () => {
      row.claimed = true;
      backend.duringInspect = null;
    };

    const summary = await run();

    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    // Same container, same credential: the binding it made still stands.
    expect([...backend.containers.keys()]).toEqual([name]);
    expect(row.nonce).toBe(claimedNonce ?? null);
    expect(
      records.some(
        (r) => r.level === "info" && r.message.includes("already been claimed"),
      ),
    ).toBe(true);
  });

  test("a claimed launch whose resource vanished is confirmed gone, never re-created", async () => {
    const { backend, records, run, store } = harness();
    store.seedActive({
      claimed: true,
      executionId: "exec-1",
      observedState: "running",
    });
    const summary = await run();
    expect(store.confirmedGone).toEqual(["exec-1"]);
    expect(summary.terminatedObserved).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(
      records.some((r) => r.level === "warn" && r.message.includes("vanished")),
    ).toBe(true);
  });

  test("an exited resource's reclaim does not take a replacement another pass built", async () => {
    // Between the inspect that saw the exit and the terminate, a pass that
    // still held the lock replaced the resource under the same name and its
    // worker bound. The exit was unclaimed, so it was counted as a failed
    // attempt; clearing it is pinned to the exited resource, so the
    // replacement is refused and neither the slot nor the binding is given
    // back.
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    container.exited = true;
    backend.duringTerminate = () => {
      backend.containers.set(name, {
        ...container,
        exited: false,
        id: `${container.id}-replacement`,
      });
      row.claimed = true;
      backend.duringTerminate = null;
    };

    const summary = await run();

    expect(summary.reconcileFailed).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(row.launchFailureCount).toBe(1);
    expect(summary.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(row.slotReleased).toBe(false);
    expect(backend.containers.get(name)?.id).toBe(
      `${container.id}-replacement`,
    );
    expect(row.observedState).not.toBe("terminating");
  });

  test("an exited resource's reclaim that races a replacement past the id check keeps the replacement's binding", async () => {
    // The pinned id matched; before the stop and remove by that id, a pass
    // that still held the lock removed the exited resource, built a
    // replacement under the same name and its worker bound. The stop and
    // remove answer 404, which reads as done. The unclaimed exit was counted
    // as a failed attempt, not confirmed as an exit, so there is no release
    // for the replacement's binding to be lost to.
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    container.exited = true;
    backend.afterPinCheck = () => {
      backend.containers.delete(name);
      // The create path issues before it creates, as the real backend does.
      row.nonce = `nonce-${crypto.randomUUID()}`;
      backend.containers.set(name, {
        ...container,
        exited: false,
        id: `${container.id}-replacement`,
        nonce: row.nonce,
      });
      row.claimed = true;
      backend.afterPinCheck = null;
    };

    const summary = await run();

    expect(backend.terminateCalls).toHaveLength(1);
    expect(summary.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(row.slotReleased).toBe(false);
    expect(row.claimed).toBe(true);
    expect(backend.containers.get(name)?.id).toBe(
      `${container.id}-replacement`,
    );

    // The next pass sees what the launch runs now and leaves it be.
    const next = await run();
    expect(next.terminatedObserved).toEqual([]);
    expect(row.slotReleased).toBe(false);
    expect(row.observedState).toBe("running");
  });

  test("an exited resource's reclaim that finds the name empty mid-replacement keeps the launch", async () => {
    // Between the other pass's delete and its create the name resolves to
    // nothing, so the terminate says `absent`. The unclaimed exit was counted
    // as a failed attempt rather than confirmed, so the launch the other pass
    // is rebuilding keeps its slot.
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    container.exited = true;
    const replacementNonce = `nonce-${crypto.randomUUID()}`;
    backend.duringTerminate = () => {
      backend.containers.delete(name);
      row.nonce = replacementNonce;
      backend.duringTerminate = null;
    };

    const summary = await run();

    expect(summary.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(row.slotReleased).toBe(false);

    // The other pass finishes its create and the worker binds; the launch
    // still holds the slot the binding needs.
    backend.containers.set(name, {
      ...container,
      exited: false,
      id: `${container.id}-replacement`,
      nonce: replacementNonce,
    });
    row.claimed = true;
    const next = await run();
    expect(next.terminatedObserved).toEqual([]);
    expect(row.slotReleased).toBe(false);
    expect(row.observedState).toBe("running");
  });

  test("a resource marked terminating that is absent mid-replacement is not confirmed on the old row", async () => {
    // The row was read as `terminating`; by the inspect, another pass had
    // removed the resource and issued the replacement's credential. Absent
    // on its own would read as "the previous pass removed it".
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.observedState = "terminating";
    backend.duringInspect = () => {
      backend.containers.delete(name);
      row.nonce = `nonce-${crypto.randomUUID()}`;
      backend.duringInspect = null;
    };

    const summary = await run();

    expect(summary.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(store.supersededConfirms).toEqual([row.executionId]);
    expect(row.slotReleased).toBe(false);
  });

  test("an absent resource whose launch a worker bound since is not confirmed on the credential alone", async () => {
    // The row was read `terminating`, unclaimed, naming a credential a
    // create had already issued and not yet built. By the confirmation that
    // create has landed and its worker bound — on the very credential the
    // row named, so the fingerprint matches; the claim this pass never saw
    // is what refuses it.
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    backend.containers.delete(name);
    row.observedState = "terminating";
    row.nonce = `nonce-${crypto.randomUUID()}`;
    const issued = row.nonce;
    store.duringConfirm = () => {
      backend.containers.set(name, {
        ...container,
        id: `${container.id}-replacement`,
        nonce: issued,
      });
      row.claimed = true;
      store.duringConfirm = null;
    };

    const summary = await run();

    expect(summary.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(store.supersededConfirms).toEqual([row.executionId]);
    expect(row.slotReleased).toBe(false);
    expect(row.claimed).toBe(true);
  });

  test("a kill confirms a launch whose replacement is still pending", async () => {
    // A replacement recorded, then a terminate: the launch is killed, not
    // rebuilt, and nothing holds its slot for a rebuild that will not come.
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name] = [...backend.containers.keys()];
    const row = store.executions.get(name?.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.pendingReplacement = "stale_isolation";
    row.replacementCount = 1;
    row.desiredState = "terminated";

    const summary = await run();

    expect(summary.killed).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(row.slotReleased).toBe(true);
    expect(backend.containers.has(name ?? "")).toBe(false);
  });

  test("a replacement names its new incarnation before the resource exists", async () => {
    // What a worker could bind to is only ever created after the launch row
    // names it, so a pass still holding the old resource's incarnation can
    // never confirm the new one's binding away, however early it claims.
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, before] = [...backend.containers.entries()][0] ?? [];
    if (!name || !before) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    const oldIncarnation = { nonceFingerprint: fingerprintOf(before.nonce) };
    backend.staleFor.add(name);
    let namedBeforeCreate: string | null | undefined;
    backend.duringEnsure = () => {
      // The create has not happened yet: the old one is torn down, the new
      // one not built.
      expect(backend.containers.has(name)).toBe(false);
      namedBeforeCreate = fingerprintOf(row.nonce);
    };

    const summary = await run();

    expect(summary.replaced).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    const after = backend.containers.get(name);
    expect(after?.id).not.toBe(before.id);
    // The fake issues inside ensure, before it stores the container.
    expect(namedBeforeCreate).toBeNull();
    expect(fingerprintOf(row.nonce)).toBe(fingerprintOf(after?.nonce));
    expect(fingerprintOf(row.nonce)).not.toBe(oldIncarnation.nonceFingerprint);
    row.claimed = true;
    expect(
      await store.confirmExecutionGone(
        row.executionId,
        new Date(),
        oldIncarnation,
      ),
    ).toBe("superseded");
    expect(row.slotReleased).toBe(false);
  });

  test("an exited resource whose removal fails stays live and is retried", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    claimLaunchOf(store, name);
    container.exited = true;
    backend.failTerminateFor.add(name);

    const first = await run();
    expect(first.terminatedObserved).toEqual([]);
    expect(first.reclaimFailed).toHaveLength(1);
    expect(backend.containers.has(name)).toBe(true);
    expect([...store.executions.values()][0]?.observedState).not.toBe(
      "terminated",
    );
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("Reclaiming"),
      ),
    ).toBe(true);
    // The slot is still held, so nothing new is launched meanwhile.
    expect(first.launched).toEqual([]);

    backend.failTerminateFor.clear();
    const second = await run();
    expect(second.terminatedObserved).toHaveLength(1);
    expect(backend.containers.has(name)).toBe(false);
    expect([...store.executions.values()][0]?.observedState).toBe("terminated");
  });

  test("a generation mismatch on reclaim keeps the slot occupied", async () => {
    const { backend, records, run, store } = harness(1);
    store.addUnassigned(2);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    claimLaunchOf(store, name);
    container.exited = true;
    backend.mismatchTerminateFor.add(name);

    const summary = await run();
    expect(summary.terminatedObserved).toEqual([]);
    expect(summary.reclaimFailed).toHaveLength(1);
    expect(summary.launched).toEqual([]);
    expect([...store.executions.values()][0]?.observedState).toBe(
      "terminating",
    );
    expect(
      records.some(
        (r) =>
          r.level === "error" &&
          r.message.includes("left it in place") &&
          (r.fields as { outcome?: string } | undefined)?.outcome ===
            "generation_mismatch",
      ),
    ).toBe(true);
  });

  test("an absent resource after a terminating mark is recorded terminated, not relaunched", async () => {
    const { backend, run, store } = harness();
    // Previous pass: marked terminating, removed the container, then crashed.
    store.seedActive({ executionId: "exec-1", observedState: "terminating" });
    const summary = await run();
    expect(summary.terminatedObserved).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(store.executions.get("exec-1")?.observedState).toBe("terminated");
  });

  test("a resource whose launch already gave its slot back is an orphan", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "terminated",
      slotReleased: true,
    });
    backend.containers.set("exec-1#1", {
      exited: true,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    const summary = await run();
    expect(summary.orphansTerminated).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.containers.size).toBe(0);
  });

  test("a terminated observation does not free the slot; only confirming it gone does", async () => {
    const { backend, run, store } = harness(1);
    // Two sessions, one slot: the second can only start once the first
    // launch's slot comes back, and the ledger is the launch row alone.
    store.addUnassigned(2);
    const first = await run();
    expect(first.launched).toHaveLength(1);

    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    // A row recorded terminated by hand is not a released slot.
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.observedState = "terminated";
    expect((await run()).launched).toEqual([]);

    row.claimed = true;
    container.exited = true;
    const third = await run();
    expect(store.confirmedGone).toEqual([row.executionId]);
    expect(third.terminatedObserved).toHaveLength(1);
    expect(third.launched).toHaveLength(1);
  });

  test("the store refuses a reservation past the slot limit even when the pass thought a slot was free", async () => {
    const { backend, run, store } = harness(2);
    store.addUnassigned(3);
    // Another pass took a slot between this pass's demand check and reserve.
    const original = store.reserveLaunch.bind(store);
    let injected = false;
    store.reserveLaunch = async (input) => {
      if (!injected) {
        injected = true;
        store.seedActive({ observedState: "running" });
      }
      return original(input);
    };
    const summary = await run();
    expect(summary.launched).toHaveLength(1);
    expect(store.executions.size).toBe(2);
    expect(backend.containers.size).toBe(1);
  });

  test("a resource with no launch intent is logged and terminated", async () => {
    const { backend, records, run, store } = harness();
    backend.containers.set("exec-ghost#4", {
      exited: false,
      generation: 4,
      operationId: "op-ghost",
      sessionId: "session-ghost",
    });
    const summary = await run();
    expect(summary.orphansTerminated).toEqual([
      { executionId: "exec-ghost", generation: 4 },
    ]);
    expect(backend.containers.has("exec-ghost#4")).toBe(false);
    expect(store.executions.size).toBe(0);
    expect(
      records.find((r) => r.message.includes("no launch intent")),
    ).toMatchObject({
      level: "warn",
      fields: expect.objectContaining({
        execution_id: "exec-ghost",
        generation: 4,
        session_id: "session-ghost",
      }),
    });
  });

  test("a resource whose generation does not match its row is an orphan", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({ executionId: "exec-1", generation: 2 });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: "stale",
      sessionId: row.sessionId,
    });
    const summary = await run();
    // Generation 2 had no resource, so it was re-ensured, and the stale
    // generation-1 container was terminated as an orphan.
    expect(summary.orphansTerminated).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toEqual([
      { executionId: "exec-1", generation: 2 },
    ]);
  });

  test("an orphan the provider will not terminate still occupies a slot", async () => {
    const { backend, run, store } = harness(1);
    backend.containers.set("stray#1", {
      exited: false,
      generation: 1,
      operationId: "op-stray",
      sessionId: "s-stray",
    });
    backend.mismatchTerminateFor.add("stray#1");
    store.addUnassigned(1);

    const summary = await run();
    expect(summary.orphansTerminated).toEqual([]);
    expect(summary.orphansUnresolved).toEqual([
      { executionId: "stray", generation: 1 },
    ]);
    expect(summary.launched).toEqual([]);
    expect(backend.containers.size).toBe(1);

    backend.mismatchTerminateFor.clear();
    const next = await run();
    expect(next.orphansTerminated).toHaveLength(1);
    expect(next.launched).toHaveLength(1);
  });

  test("a busy orphan is not waited on, and holds its slot until it is gone", async () => {
    const { backend, records, run, store } = harness(1);
    backend.containers.set("stray#1", {
      exited: false,
      generation: 1,
      operationId: "op-stray",
      sessionId: "s-stray",
    });
    backend.drainingFor.add("stray#1");
    store.addUnassigned(1);

    const summary = await run();
    expect(summary.orphansStopping).toEqual([
      { executionId: "stray", generation: 1 },
    ]);
    expect(summary.orphansUnresolved).toEqual([]);
    expect(summary.launched).toEqual([]);
    expect(records.filter((r) => r.level === "error")).toEqual([]);

    backend.drainingFor.clear();
    const next = await run();
    expect(next.orphansTerminated).toHaveLength(1);
    expect(next.launched).toHaveLength(1);
  });

  test("another backend's intent is never recreated on this provider", async () => {
    const { backend, run, store } = harness();
    store.seedActive({ backend: "kubernetes", observedState: "running" });
    const summary = await run();
    expect(summary.activeBefore).toBe(0);
    expect(summary.reensured).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(backend.containers.size).toBe(0);
  });

  test("a resource that dies right after launch is a failed launch, not a success", async () => {
    const { backend, records, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.exitOnStartFor.add(sessionId);

    const summary = await run();
    expect(summary.launched).toEqual([]);
    expect(summary.failedLaunches).toHaveLength(1);
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("right after launch"),
      ),
    ).toBe(true);
    const [row] = store.executions.values();
    if (!row) throw new Error("no row");
    expect(row.launchFailureCount).toBe(1);
    // The launch still holds its slot. The next pass clears the dead
    // resource as its own — no orphan, no exit, and not counted twice — and
    // waits out the backoff before building it again.
    backend.exitOnStartFor.clear();
    const next = await run();
    expect(next.terminatedObserved).toEqual([]);
    expect(next.orphansTerminated).toEqual([]);
    expect(next.launchesBackingOff).toHaveLength(1);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.containers.size).toBe(0);
    expect(row.launchFailureCount).toBe(1);

    store.elapse(60_000);
    const retried = await run();
    expect(retried.reensured).toHaveLength(1);
    expect(row.generation).toBe(1);
    expect(store.executions.size).toBe(1);
  });

  test("an orphan whose termination throws is unresolved and holds a slot", async () => {
    const { backend, records, run, store } = harness(1);
    backend.containers.set("stray#1", {
      exited: false,
      generation: 1,
      operationId: "op-stray",
      sessionId: "s-stray",
    });
    backend.failTerminateFor.add("stray#1");
    store.addUnassigned(1);

    const summary = await run();
    expect(summary.orphansUnresolved).toEqual([
      { executionId: "stray", generation: 1 },
    ]);
    expect(summary.launched).toEqual([]);
    expect(
      records.some((r) => r.level === "error" && r.message.includes("orphan")),
    ).toBe(true);
  });

  test("a legacy row without an intent is inspected and closed, never relaunched", async () => {
    const { backend, run, store } = harness();
    const gone = store.seedActive({
      executionId: "legacy-gone",
      observedState: "running",
      operationId: null,
    });
    const exited = store.seedActive({
      executionId: "legacy-exited",
      observedState: "running",
      operationId: null,
    });
    backend.containers.set("legacy-exited#1", {
      exited: true,
      generation: 1,
      operationId: "op-old",
      sessionId: exited.sessionId,
    });

    const summary = await run();
    expect(backend.ensureCalls).toEqual([]);
    expect(summary.terminatedObserved.map((r) => r.executionId).sort()).toEqual(
      ["legacy-exited", "legacy-gone"],
    );
    expect(store.executions.get(gone.executionId)?.observedState).toBe(
      "terminated",
    );
    expect(backend.containers.size).toBe(0);
  });

  test("a failed launch keeps the intent and is retried next pass", async () => {
    const { backend, records, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.failEnsureFor.add(sessionId);

    const first = await run();
    expect(first.failedLaunches).toHaveLength(1);
    expect(first.launched).toHaveLength(0);
    const [row] = store.executions.values();
    expect(row?.observedState).toBe("unknown");
    expect(
      records.some((r) => r.level === "error" && r.message.includes("kept")),
    ).toBe(true);

    expect(row?.launchFailureCount).toBe(1);

    // Too soon: the pass leaves it alone and says so.
    backend.failEnsureFor.clear();
    const early = await run();
    expect(early.launchesBackingOff).toHaveLength(1);
    expect(early.reensured).toHaveLength(0);
    expect(backend.ensureCalls).toHaveLength(1);

    store.elapse(30_000);
    const second = await run();
    expect(second.reensured).toHaveLength(1);
    expect(second.launched).toHaveLength(0);
    expect(store.executions.size).toBe(1);
    expect(backend.containers.size).toBe(1);
  });

  test("a create the daemon never answered is adopted by the next pass, not counted", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.unansweredFor.set(sessionId, "created");

    const first = await run();
    expect(first.failedLaunches).toHaveLength(1);
    expect(first.launched).toHaveLength(0);
    const [row] = store.executions.values();
    const [container] = backend.containers.values();
    expect(row?.observedState).toBe("unknown");
    expect(row?.launchFailureCount).toBe(0);
    expect(store.launchFailures).toEqual([]);
    // The credential the container was built with is still the accepted one.
    expect(row?.nonce).toBe(container?.nonce ?? "missing");

    // No backoff to wait out: the next pass inspects, finds the container
    // the create left behind, and starts it rather than building another.
    const second = await run();
    expect(second.failedLaunches).toEqual([]);
    expect(second.reensured).toHaveLength(1);
    expect(backend.terminateCalls).toEqual([]);
    expect(backend.containers.size).toBe(1);
    expect(container?.started).toBe(true);
    expect(row?.observedState).toBe("running");
    expect(row?.launchFailureCount).toBe(0);
    expect(row?.nonce).toBe(container?.nonce ?? "missing");
  });

  test("a start the daemon never answered but carried out is recorded running next pass", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.unansweredFor.set(sessionId, "created");
    await run();
    const [container] = backend.containers.values();
    if (!container) throw new Error("no container");
    container.started = true;

    const second = await run();
    expect(second.failedLaunches).toEqual([]);
    expect(second.reensured).toEqual([]);
    expect(backend.ensureCalls).toHaveLength(1);
    expect(store.executions.values().next().value?.observedState).toBe(
      "running",
    );
    expect(store.launchFailures).toEqual([]);
  });

  test("an unanswered create that never took is counted by the next pass, and bounded", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.unansweredFor.set(sessionId, "not_created");

    const first = await run();
    expect(first.failedLaunches).toHaveLength(1);
    expect(backend.containers.size).toBe(0);
    expect(store.launchFailures).toEqual([]);

    // Inspect finds nothing: the create failed after all.
    const second = await run();
    expect(second.reensured).toEqual([]);
    expect(backend.ensureCalls).toHaveLength(1);
    const [row] = store.executions.values();
    expect(row?.launchFailureCount).toBe(1);
    expect(row?.nonce).toBeNull();
    expect(store.launchFailures[0]?.error).toContain("never answered");

    // A create that never takes runs into the limit like any failure.
    for (let pass = 0; pass < 2 * DEFAULT_LAUNCH_FAILURE_LIMIT; pass += 1) {
      store.elapse(11 * 60_000);
      await run();
    }
    expect(store.quarantined.has(sessionId)).toBe(true);
    expect(row?.launchFailureCount).toBe(DEFAULT_LAUNCH_FAILURE_LIMIT);
  });

  test("an unanswered create that lands after its failure was counted is torn down, not adopted", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.unansweredFor.set(sessionId, "not_created");
    await run();
    await run();
    const [row] = store.executions.values();
    const [intent] = backend.ensureCalls;
    if (!row || !intent) throw new Error("no launch");
    expect(row.launchFailureCount).toBe(1);
    // The daemon carries the lost create out after all, with the credential
    // the failure record revoked.
    backend.containers.set(nameOf(intent), {
      exited: false,
      generation: intent.generation,
      id: "ctr-late",
      nonce: "nonce-revoked",
      operationId: intent.operationId,
      sessionId,
    });
    backend.unansweredFor.clear();
    store.elapse(11 * 60_000);
    await run();
    expect(backend.terminateCalls).toHaveLength(1);
    expect(row.launchFailureCount).toBe(1);
  });

  test("a pass that cannot take the lock does nothing and says so", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(2);
    store.locked = true;
    const summary = await run();
    expect(summary.skipped).toBe(true);
    expect(summary.launched).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(records.some((r) => r.message.includes("holds the lock"))).toBe(
      true,
    );

    store.locked = false;
    const next = await run();
    expect(next.skipped).toBe(false);
    expect(next.launched).toHaveLength(2);
    expect(store.locked).toBe(false);
  });

  test("the lock is released even when the pass throws", async () => {
    const { run, store } = harness();
    store.failList = true;
    await expect(run()).rejects.toThrow("database down");
    expect(store.locked).toBe(false);
  });

  test("a pass whose lock connection drops stops before tearing anything down", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(2);
    await run();
    for (const container of backend.containers.values()) {
      container.exited = true;
    }
    // Lost while the pass is out at the provider: another pass may now be
    // judging the same rows.
    backend.duringInspect = () => {
      store.loseLock();
      backend.duringInspect = null;
    };
    const ensuresBefore = backend.ensureCalls.length;

    await expect(run()).rejects.toThrow("pass lock connection ended");

    expect(backend.terminateCalls).toEqual([]);
    expect(backend.ensureCalls).toHaveLength(ensuresBefore);
    expect(store.confirmedGone).toEqual([]);
    expect([...store.executions.values()].every((e) => !e.slotReleased)).toBe(
      true,
    );
    // Nothing is marked on the way out either.
    expect([...store.executions.values()].map((e) => e.observedState)).toEqual([
      "running",
      "running",
    ]);
    expect(store.locked).toBe(false);
  });

  test("a lock lost after the last change still fails the pass", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.clear();
    store.addUnassigned(1);
    backend.duringEnsure = () => {
      store.loseLock();
      delete backend.duringEnsure;
    };

    await expect(run()).rejects.toThrow("pass lock connection ended");
    expect(store.locked).toBe(false);
  });

  test("a stop request ends the pass before its next reservation and releases the lock", async () => {
    const stop = new AbortController();
    const { backend, run, store } = harness(10, { stop: stop.signal });
    store.addUnassigned(3);
    backend.duringEnsure = () => {
      stop.abort(new Error("SIGTERM received; the pass stopped early"));
      delete backend.duringEnsure;
    };

    await expect(run()).rejects.toThrow("the pass stopped early");
    // The launch in flight finished its call; nothing was reserved after it.
    expect(backend.ensureCalls).toHaveLength(1);
    expect(store.executions.size).toBe(1);
    expect(store.locked).toBe(false);
  });

  test("workspace reclaim stops when its lock connection drops", async () => {
    const { backend, reclaim, store } = harness();
    backend.workspaces.set("ap-ws-a", "session-a");
    backend.workspaces.set("ap-ws-b", "session-b");
    const list = backend.listWorkspaces;
    backend.listWorkspaces = async () => {
      store.loseLock();
      return (await list?.()) ?? [];
    };

    await expect(reclaim()).rejects.toThrow("pass lock connection ended");
    expect([...backend.workspaces.keys()]).toEqual(["ap-ws-a", "ap-ws-b"]);
  });

  test("one row's inspect failure does not stop the rest of the pass", async () => {
    const { backend, records, run, store } = harness();
    const bad = store.seedActive({
      executionId: "exec-bad",
      observedState: "running",
    });
    const good = store.seedActive({
      executionId: "exec-good",
      observedState: "running",
    });
    backend.containers.set("exec-good#1", {
      exited: false,
      generation: 1,
      operationId: good.operationId ?? "op",
      sessionId: good.sessionId,
    });
    backend.failInspectFor.add(bad.executionId);
    store.addUnassigned(1);

    const summary = await run();
    expect(summary.reconcileFailed).toEqual([
      { executionId: "exec-bad", generation: 1 },
    ]);
    expect(summary.launched).toHaveLength(1);
    expect(store.executions.get("exec-bad")?.observedState).toBe("running");
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("Reconciling"),
      ),
    ).toBe(true);
  });

  test("a kill intent tears the resource down before anything else and confirms it gone once", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    launch.desiredState = "terminated";
    launch.claimed = true;
    // A terminate also blocks dispatch, so the session is not waiting.
    store.unassigned.delete(launch.sessionId);

    const summary = await run();
    expect(summary.killed).toEqual([
      { executionId: launch.executionId, generation: launch.generation },
    ]);
    expect(summary.terminatedObserved).toEqual(summary.killed);
    expect(backend.terminateCalls).toEqual(summary.killed);
    expect(backend.containers.size).toBe(0);
    expect(store.confirmedGone).toEqual([launch.executionId]);
    expect(launch.slotReleased).toBe(true);
    // Not inspected, not re-ensured: the intent is to remove it.
    expect(backend.ensureCalls).toHaveLength(1);
    expect(
      records.some(
        (r) => r.message === "Execution killed on request; resource removed",
      ),
    ).toBe(true);
  });

  test("a kill still stopping past the stop deadline fails the pass", async () => {
    const { backend, records, run, store } = harness(10, {
      stopDeadlineMs: 60_000,
    });
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    const ref = { executionId: launch.executionId, generation: 1 };
    launch.desiredState = "terminated";
    launch.claimed = true;
    store.unassigned.delete(launch.sessionId);
    // The daemon answers inspects but never takes the stop.
    backend.drainingFor.add(`${launch.executionId}#1`);

    const asked = await run();
    expect(asked.killsStopping).toEqual([ref]);
    expect(asked.killFailed).toEqual([]);
    expect(launch.observedState).toBe("terminating");
    const firstAsked = launch.observedAt;

    // Asking again within the deadline is still a stop in progress, and
    // does not move the time the first one went out.
    const within = await run();
    expect(within.killsStopping).toEqual([ref]);
    expect(within.killFailed).toEqual([]);
    expect(launch.observedAt).toBe(firstAsked);

    if (!launch.observedAt) throw new Error("no first stop time");
    launch.observedAt = new Date(launch.observedAt.getTime() - 61_000);
    const overdue = await run();
    expect(overdue.killFailed).toEqual([ref]);
    expect(overdue.killsStopping).toEqual([]);
    expect(
      records.some(
        (r) =>
          r.level === "error" &&
          r.message === "Kill still stopping past the stop deadline",
      ),
    ).toBe(true);

    backend.drainingFor.clear();
    const confirmed = await run();
    expect(confirmed.killed).toEqual([ref]);
    expect(store.confirmedGone).toEqual([launch.executionId]);
  });

  test("a kill's deadline does not start from another resource's teardown", async () => {
    const { backend, run, store } = harness(10, { stopDeadlineMs: 60_000 });
    // An earlier resource of this launch was being reclaimed long ago; the
    // one the kill now stops is another.
    const row = store.seedActive({
      claimed: true,
      desiredState: "terminated",
      executionId: "exec-1",
      observedAt: new Date(Date.now() - 10 * 60_000),
      observedState: "terminating",
      providerRef: "ctr-old",
    });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      id: "ctr-new",
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    backend.drainingFor.add("exec-1#1");

    const asked = await run();
    expect(asked.killFailed).toEqual([]);
    expect(asked.killsStopping).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(row.providerRef).toBe("ctr-new");
    expect(row.observedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("a kill does not wait on a worker draining its turn, and a later pass confirms it gone", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    const ref = { executionId: launch.executionId, generation: 1 };
    launch.desiredState = "terminated";
    launch.claimed = true;
    store.unassigned.delete(launch.sessionId);
    backend.drainingFor.add(`${launch.executionId}#1`);

    const asked = await run();
    expect(asked.killsStopping).toEqual([ref]);
    expect(asked.killed).toEqual([]);
    expect(asked.killFailed).toEqual([]);
    expect(backend.containers.size).toBe(1);
    expect(store.confirmedGone).toEqual([]);
    expect(launch.slotReleased).toBe(false);
    expect(records.filter((r) => r.level === "error")).toEqual([]);

    // The daemon's SIGKILL, or the worker's own exit, ends the drain.
    backend.drainingFor.clear();
    const confirmed = await run();
    expect(confirmed.killsStopping).toEqual([]);
    expect(confirmed.killed).toEqual([ref]);
    expect(backend.containers.size).toBe(0);
    expect(store.confirmedGone).toEqual([launch.executionId]);
    expect(launch.slotReleased).toBe(true);
  });

  test("a kill that commits while the pass is out at the provider is honoured, not re-ensured", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    // The resource is gone and the row still says running: the pass would
    // re-create it, but a terminate lands during its inspect.
    backend.containers.clear();
    store.unassigned.delete(launch.sessionId);
    backend.duringInspect = () => {
      launch.desiredState = "terminated";
    };

    const summary = await run();
    expect(summary.reensured).toEqual([]);
    expect(summary.killed).toHaveLength(1);
    expect(backend.ensureCalls).toHaveLength(1);
    expect(launch.slotReleased).toBe(true);
  });

  test("a kill that commits while a live resource is being inspected is carried out this pass", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    store.unassigned.delete(launch.sessionId);
    backend.duringInspect = () => {
      launch.desiredState = "terminated";
    };

    const summary = await run();
    expect(summary.killed).toHaveLength(1);
    expect(summary.terminatedObserved).toHaveLength(1);
    expect(launch.slotReleased).toBe(true);
    expect(backend.containers.size).toBe(0);
  });

  test("a kill that commits while the first launch is being created takes it down in the same pass", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    backend.duringEnsure = (intent) => {
      const row = store.executions.get(intent.executionId);
      if (!row) throw new Error("launch row missing during ensure");
      row.desiredState = "terminated";
    };

    const summary = await run();
    // Asked to go before the create got its credential: nothing is built,
    // nothing counted, and the kill still lands this pass.
    expect(summary.launched).toHaveLength(0);
    expect(summary.failedLaunches).toHaveLength(0);
    expect(summary.killed).toHaveLength(1);
    expect(backend.containers.size).toBe(0);
    const [launch] = [...store.executions.values()];
    expect(launch?.slotReleased).toBe(true);
    expect(launch?.launchFailureCount).toBe(0);
  });

  test("a kill that commits while the resource is being re-created takes it down again", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    backend.containers.clear();
    store.unassigned.delete(launch.sessionId);
    backend.duringEnsure = () => {
      launch.desiredState = "terminated";
    };

    const summary = await run();
    expect(summary.reensured).toHaveLength(0);
    expect(summary.failedLaunches).toHaveLength(0);
    expect(summary.killed).toHaveLength(1);
    expect(launch.slotReleased).toBe(true);
    expect(launch.launchFailureCount).toBe(0);
    expect(backend.containers.size).toBe(0);
  });

  test("a kill the provider will not carry out keeps the slot and is retried next pass", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    launch.desiredState = "terminated";
    backend.failTerminateFor.add(nameOf(launch));

    const failed = await run();
    expect(failed.killFailed).toEqual([
      { executionId: launch.executionId, generation: launch.generation },
    ]);
    expect(failed.killed).toEqual([]);
    expect(launch.slotReleased).toBe(false);
    expect(store.confirmedGone).toEqual([]);
    expect(failed.launched).toEqual([]);

    backend.failTerminateFor.clear();
    const retried = await run();
    expect(retried.killed).toHaveLength(1);
    expect(launch.slotReleased).toBe(true);
  });

  test("a kill whose resource is already absent still confirms the execution gone", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [launch] = [...store.executions.values()];
    if (!launch) throw new Error("nothing launched");
    launch.desiredState = "terminated";
    backend.containers.clear();

    const summary = await run();
    expect(summary.killed).toHaveLength(1);
    expect(store.confirmedGone).toEqual([launch.executionId]);
    expect(summary.reensured).toEqual([]);
  });

  test("terminate receipts past the deadline are reported unknown, later ones are left alone", async () => {
    const { run, store } = harness();
    const start = new Date("2026-09-23T00:00:00.000Z");
    let clock = start;
    const summaryOf = () =>
      runScheduler({
        backend: new FakeBackend(),
        image: "worker:test",
        logger: recordingLogger().logger,
        now: () => clock,
        resources: RESOURCES,
        slotLimit: 10,
        store,
      });
    store.terminateReceipts.push(
      { createdAt: start, status: "accepted" },
      { createdAt: new Date(start.getTime() + 10_000), status: "accepted" },
    );
    clock = new Date(start.getTime() + 29_999);
    expect((await summaryOf()).terminationsOverdue).toBe(0);
    clock = new Date(start.getTime() + 30_000);
    expect((await summaryOf()).terminationsOverdue).toBe(1);
    expect(store.terminateReceipts.map((r) => r.status)).toEqual([
      "unknown",
      "accepted",
    ]);
    await run();
  });

  test("rejects a negative or fractional slot limit", async () => {
    const { backend, store } = harness();
    const { logger } = recordingLogger();
    for (const slotLimit of [-1, 1.5]) {
      await expect(
        runScheduler({
          backend,
          image: "worker:test",
          logger,
          resources: RESOURCES,
          slotLimit,
          store,
        }),
      ).rejects.toThrow("slotLimit");
    }
  });
});

describe("runScheduler launch failures", () => {
  /** Past any backoff the default schedule can hand out. */
  const PAST_ANY_BACKOFF = 11 * 60_000;

  function sessionOf(store: MemoryStore, ref: ExecutionRef): string {
    const row = store.executions.get(ref.executionId);
    if (!row) throw new Error(`no row for ${ref.executionId}`);
    return row.sessionId;
  }

  test("two launches that always fail give their slots back to a healthy session (slotLimit=2)", async () => {
    const { backend, records, run, store } = harness(2);
    const [badA, badB, good] = store.addUnassigned(3);
    if (!badA || !badB || !good) throw new Error("no sessions");
    backend.failEnsureFor.add(badA);
    backend.failEnsureFor.add(badB);

    const first = await run();
    expect(first.failedLaunches).toHaveLength(2);
    expect(first.launched).toEqual([]);

    // Inside the backoff the two hold their slots and the pass says why.
    const waiting = await run();
    expect(waiting.launchesBackingOff).toHaveLength(2);
    expect(waiting.launched).toEqual([]);
    expect(backend.ensureCalls).toHaveLength(2);
    expect(
      records.some(
        (r) =>
          r.message === "Scheduling pass completed" &&
          (r.fields as { launch_backoff_count?: number })
            .launch_backoff_count === 2,
      ),
    ).toBe(true);

    let healthy: ExecutionRef | undefined;
    for (let pass = 0; pass < DEFAULT_LAUNCH_FAILURE_LIMIT; pass += 1) {
      store.elapse(PAST_ANY_BACKOFF);
      const summary = await run();
      healthy ??= summary.launched.find(
        (ref) => sessionOf(store, ref) === good,
      );
    }
    expect(healthy).toBeDefined();
    // Each failing session was tried exactly as many times as the limit
    // allows and no more, all within its first generation.
    for (const session of [badA, badB]) {
      expect(
        backend.ensureCalls.filter((intent) => intent.sessionId === session),
      ).toHaveLength(DEFAULT_LAUNCH_FAILURE_LIMIT);
      expect(
        backend.ensureCalls
          .filter((intent) => intent.sessionId === session)
          .every((intent) => intent.generation === 1),
      ).toBe(true);
      expect(store.quarantined.get(session)).toBe("docker unavailable");
    }
    const failing = [...store.executions.values()].filter(
      (e) => e.sessionId !== good,
    );
    expect(failing.every((e) => e.slotReleased)).toBe(true);
    expect(failing.every((e) => e.launchFailureCount === 5)).toBe(true);

    // Given up on, they are not admitted again on their own.
    store.elapse(PAST_ANY_BACKOFF);
    const after = await run();
    expect(after.launched).toEqual([]);
    expect(after.failedLaunches).toEqual([]);
  });

  test("the pass that reaches the limit gives the slot back in that same pass", async () => {
    const { backend, run, store } = harness(1);
    const [bad, good] = store.addUnassigned(2);
    if (!bad || !good) throw new Error("no sessions");
    backend.failEnsureFor.add(bad);
    const quarantinedIn: number[] = [];
    for (let pass = 1; pass <= DEFAULT_LAUNCH_FAILURE_LIMIT; pass += 1) {
      const summary = await run();
      if (summary.launchesQuarantined.length > 0) {
        quarantinedIn.push(pass);
        expect(summary.killed).toEqual(summary.launchesQuarantined);
        expect(summary.launched).toHaveLength(1);
      } else {
        expect(summary.launched).toEqual([]);
      }
      store.elapse(PAST_ANY_BACKOFF);
    }
    expect(quarantinedIn).toEqual([DEFAULT_LAUNCH_FAILURE_LIMIT]);
  });

  test("a worker that crashes before it claims is retried in place, never cycled into new generations", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.exitOnStartFor.add(sessionId);

    for (let pass = 0; pass < 2 * DEFAULT_LAUNCH_FAILURE_LIMIT; pass += 1) {
      await run();
      store.elapse(PAST_ANY_BACKOFF);
    }
    expect(store.executions.size).toBe(1);
    const [row] = store.executions.values();
    expect(row?.launchFailureCount).toBe(DEFAULT_LAUNCH_FAILURE_LIMIT);
    expect(row?.slotReleased).toBe(true);
    expect(store.quarantined.has(sessionId)).toBe(true);
    expect(backend.ensureCalls).toHaveLength(DEFAULT_LAUNCH_FAILURE_LIMIT);
    expect(backend.containers.size).toBe(0);
  });

  test("an unclaimed exit whose launch a worker bound since is an ordinary exit", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    container.exited = true;
    // Bound after the rows were read, before the failure was recorded.
    backend.duringInspect = () => {
      claimLaunchOf(store, name);
    };

    const refused = await run();
    expect(refused.terminatedObserved).toEqual([]);
    expect(refused.failedLaunches).toEqual([]);
    const row = store.executions.get(name.split("#")[0] ?? "");
    expect(row?.launchFailureCount).toBe(0);
    expect(row?.slotReleased).toBe(false);
    expect(store.launchFailures.map((f) => f.expectedNonceFingerprint)).toEqual(
      [fingerprintOf(container.nonce)],
    );

    // Read afresh, the launch is claimed and its exit an ordinary one.
    backend.duringInspect = null;
    const summary = await run();
    expect(summary.terminatedObserved).toHaveLength(1);
    expect(row?.launchFailureCount).toBe(0);
    expect(row?.slotReleased).toBe(true);
  });

  test("an unclaimed exit of a launch asked to go is carried out as a kill, never rebuilt or counted", async () => {
    // A claim that refuses the session for recovery marks the launch to go
    // and the worker leaves without binding — before or while a pass looks.
    for (const when of ["before", "during"] as const) {
      const { backend, run, store } = harness();
      store.addUnassigned(1);
      await run();
      const [name, container] = [...backend.containers.entries()][0] ?? [];
      if (!name || !container) throw new Error("no container");
      const row = store.executions.get(name.split("#")[0] ?? "");
      if (!row) throw new Error("no row");
      container.exited = true;
      if (when === "before") row.desiredState = "terminated";
      else {
        backend.duringInspect = () => {
          row.desiredState = "terminated";
        };
      }
      backend.ensureCalls.length = 0;

      const summary = await run();
      expect(summary.killed).toHaveLength(1);
      expect(summary.failedLaunches).toEqual([]);
      // Whatever the session is launched for next, this launch is not rebuilt.
      expect(
        backend.ensureCalls.filter((i) => i.executionId === row.executionId),
      ).toEqual([]);
      expect(row.launchFailureCount).toBe(0);
      expect(row.slotReleased).toBe(true);
      expect(backend.containers.has(name)).toBe(false);
    }
  });

  test("an unclaimed exit judged on a snapshot another pass has since opened an attempt past is left alone", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    container.exited = true;
    // After this pass read the rows, a newer pass opened the next attempt,
    // adopting the resource on the credential it already holds.
    backend.duringInspect = () => {
      row.launchAttempts += 1;
    };

    const stale = await run();
    expect(stale.terminatedObserved).toEqual([]);
    expect(row.slotReleased).toBe(false);
    expect(row.launchFailureCount).toBe(0);
    expect(row.generation).toBe(1);

    // The next pass counts the exit against the attempt that is current.
    backend.duringInspect = null;
    const next = await run();
    expect(next.terminatedObserved).toEqual([]);
    expect(row.launchFailureCount).toBe(1);
    expect(row.slotReleased).toBe(false);
    expect(row.generation).toBe(1);
  });

  test("a rebuild that keeps failing spends the launch's failure budget, not the replacement budget", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    await run();
    const [row] = store.executions.values();
    if (!row) throw new Error("no row");
    backend.staleFor.add(`${row.executionId}#1`);
    backend.failEnsureFor.add(sessionId);

    const first = await run();
    expect(first.replaced).toHaveLength(1);
    expect(first.failedLaunches).toHaveLength(1);
    expect(row.replacementCount).toBe(1);
    expect(row.pendingReplacement).toBe("stale_isolation");

    for (let pass = 0; pass < DEFAULT_LAUNCH_FAILURE_LIMIT; pass += 1) {
      store.elapse(PAST_ANY_BACKOFF);
      const summary = await run();
      expect(summary.replacementsExhausted).toEqual([]);
    }
    expect(row.replacementCount).toBe(1);
    expect(row.launchFailureCount).toBe(DEFAULT_LAUNCH_FAILURE_LIMIT);
    expect(row.slotReleased).toBe(true);
    expect(store.quarantined.has(sessionId)).toBe(true);
  });

  test("a launch in backoff is refused a credential, so a stale pass cannot reopen it", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.failEnsureFor.add(sessionId);
    await run();
    const [row] = store.executions.values();
    if (!row) throw new Error("no row");
    await expect(store.issueBootstrapNonce(row)).rejects.toThrow(
      "no credential",
    );
    store.elapse(PAST_ANY_BACKOFF);
    await expect(store.issueBootstrapNonce(row)).resolves.toStartWith("nonce-");
  });

  test("a replacement that dies before it claims is a launch failure, not another replacement", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    await run();
    const [row] = store.executions.values();
    if (!row) throw new Error("no row");
    const name = `${row.executionId}#1`;
    // The rebuild is taken but not yet shown running, so the replacement
    // stays pending — and then its worker dies before claiming.
    backend.staleFor.add(name);
    backend.createPendingFor.add(sessionId);
    const replaced = await run();
    expect(replaced.replaced).toHaveLength(1);
    expect(row.pendingReplacement).toBe("stale_isolation");
    const rebuilt = backend.containers.get(name);
    if (!rebuilt) throw new Error("no rebuild");
    rebuilt.exited = true;

    const next = await run();
    expect(next.replaced).toEqual([]);
    expect(next.failedLaunches).toEqual([]);
    expect(next.terminatedObserved).toEqual([]);
    expect(row.replacementCount).toBe(1);
    expect(row.launchFailureCount).toBe(1);
    // Still pending: the gone resource is a rebuild in progress, not an exit.
    expect(row.pendingReplacement).toBe("stale_isolation");
    expect(row.slotReleased).toBe(false);
    expect(backend.containers.has(name)).toBe(false);
  });

  test("a failure reported for an attempt another pass has since opened is refused, even mid-ensure", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    // A pass that lost its lock read the launch before this pass opened its
    // attempt, and reports its own ensure failed while this one is still
    // out at the provider — before anything records this one's outcome.
    const stale: Array<Promise<string>> = [];
    backend.duringEnsure = (intent) => {
      const row = store.executions.get(intent.executionId);
      if (!row) throw new Error("no row");
      stale.push(
        store.recordLaunchFailure(row, {
          error: "docker timed out",
          expectedAttempts: row.launchAttempts - 1,
          expectedCount: 0,
          quarantine: false,
          retryDelayMs: 30_000,
        }),
      );
    };

    const summary = await run();
    expect(await Promise.all(stale)).toEqual(["stale"]);
    expect(summary.launched).toHaveLength(1);
    const [row] = store.executions.values();
    expect(row?.launchFailureCount).toBe(0);
    expect(row?.launchRetryAt).toBeNull();
    expect(backend.containers.get(`${row?.executionId}#1`)?.nonce).toBe(
      row?.nonce ?? "missing",
    );
  });

  test("a pass that lost its lock cannot rotate out the credential a newer attempt launched with", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    let newer: Promise<SchedulerRunSummary> | undefined;
    let launchedWith: string | undefined;
    backend.beforeCreate = async (intent) => {
      if (newer) return;
      // The stale pass stalls at the provider past its lock; another
      // scheduler takes the lock and opens the next attempt, which launches.
      store.loseLock();
      store.locked = false;
      newer = run();
      await newer;
      launchedWith = backend.containers.get(nameOf(intent))?.nonce;
    };

    await expect(run()).rejects.toThrow("pass lock connection ended");
    const summary = await newer;
    expect(summary?.reensured).toHaveLength(1);
    const [row] = store.executions.values();
    expect(row?.launchAttempts).toBe(2);
    // Resuming, the stale pass was refused a credential: the registry still
    // expects the one the newer attempt's resource was launched with.
    expect(launchedWith).toStartWith("nonce-");
    expect(row?.nonce).toBe(launchedWith ?? "missing");
    expect(backend.containers.size).toBe(1);
  });

  test("a resource refused for another launch spec is not a failed launch", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    const other = launchSpecFingerprint("sha256:other", RESOURCES);
    // Another hand built under this launch's name before the create got
    // there: the backend refuses to adopt it and leaves it standing.
    let planted = false;
    backend.duringEnsure = (intent) => {
      if (planted) return;
      planted = true;
      backend.containers.set(`${intent.executionId}#${intent.generation}`, {
        exited: false,
        generation: intent.generation,
        launchSpec: other,
        operationId: intent.operationId,
        sessionId: intent.sessionId,
      });
    };

    const summary = await run();
    expect(summary.failedLaunches).toHaveLength(1);
    const [row] = store.executions.values();
    expect(row?.launchFailureCount).toBe(0);
    expect(row?.launchRetryAt).toBeNull();
    expect(store.launchFailures).toEqual([]);

    // The next pass replaces it as the spec mismatch it is.
    const next = await run();
    expect(next.replaced).toHaveLength(1);
    expect(row?.launchFailureCount).toBe(0);
  });

  test("a resource refused for another launch spec that is gone by the next pass is not a failed launch", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    await run();
    const [row] = store.executions.values();
    const [intent] = backend.ensureCalls;
    if (!row || !intent) throw new Error("no launch");
    expect(row.nonce).not.toBeNull();
    // Ours goes away, and another hand builds under the name before the
    // re-create gets there.
    backend.containers.clear();
    const other = launchSpecFingerprint("sha256:other", RESOURCES);
    let planted = false;
    backend.duringEnsure = (ensuring) => {
      if (planted) return;
      planted = true;
      backend.containers.set(nameOf(ensuring), {
        exited: false,
        generation: ensuring.generation,
        launchSpec: other,
        operationId: ensuring.operationId,
        sessionId,
      });
    };
    const refused = await run();
    expect(refused.failedLaunches).toHaveLength(1);
    expect(row.launchFailureCount).toBe(0);

    // The foreign resource is gone again before the next look. No create was
    // ever sent for it, so nothing failed: the launch is simply built.
    backend.containers.clear();
    const next = await run();
    expect(store.launchFailures).toEqual([]);
    expect(row.launchFailureCount).toBe(0);
    expect(next.reensured).toHaveLength(1);
    expect(backend.containers.size).toBe(1);
  });

  test("the backoff doubles from its base and stops at its cap", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => launchRetryDelayMs(n))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000,
    ]);
    expect(launchRetryDelayMs(1_000)).toBe(600_000);
    expect(launchRetryDelayMs(3, 10, 1_000)).toBe(40);
  });

  test("rejects a launch failure limit or backoff that cannot be honoured", async () => {
    const { backend, store } = harness();
    const { logger } = recordingLogger();
    const base = {
      backend,
      image: "worker:test",
      logger,
      resources: RESOURCES,
      slotLimit: 1,
      store,
    };
    for (const launchFailureLimit of [0, 1.5]) {
      await expect(
        runScheduler({ ...base, launchFailureLimit }),
      ).rejects.toThrow("launchFailureLimit");
    }
    await expect(
      runScheduler({ ...base, launchRetryBaseMs: -1 }),
    ).rejects.toThrow("launchRetryBaseMs");
    await expect(
      runScheduler({ ...base, launchRetryCapMs: Number.NaN }),
    ).rejects.toThrow("launchRetryCapMs");
  });
});

describe("reclaimWorkspaces", () => {
  test("frees finished workspaces without starting or replacing anything", async () => {
    // The caller has just been refused admission. A pass with no free slots
    // would still re-ensure the missing container below and replace the stale
    // one; this must do neither.
    const { backend, reclaim, store } = harness();
    store.addUnassigned(2);
    await harness().run();
    const [live] = store.addUnassigned(1);
    if (live === undefined) throw new Error("fixture has no session");
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      image: "sha256:worker:test",
      now: new Date(),
      resources: RESOURCES,
      sessionId: live,
      slotLimit: 10,
    });
    if (!intent) throw new Error("reservation refused");
    backend.ensureCalls.length = 0;
    backend.workspaces.set("ap-ws-done", "session-done");
    backend.workspaces.set("ap-ws-live", live);
    store.retainedSessions.add(live);

    const summary = await reclaim();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-done"]);
    expect(backend.workspaces.has("ap-ws-live")).toBe(true);
    // Nothing was launched, adopted or torn down.
    expect(backend.ensureCalls).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(summary.launched).toEqual([]);
    expect(summary.reensured).toEqual([]);
    expect(summary.replaced).toEqual([]);
  });

  test("a held lock skips it, as it does a whole pass", async () => {
    const { backend, reclaim, store } = harness();
    backend.workspaces.set("ap-ws-done", "session-done");
    await store.acquirePassLock();

    const summary = await reclaim();

    expect(summary.skipped).toBe(true);
    expect(backend.workspaces.has("ap-ws-done")).toBe(true);
  });

  test("a failed scan is reported, not swallowed", async () => {
    const { backend, reclaim } = harness();
    backend.failListWorkspaces = true;

    expect((await reclaim()).workspaceScanFailed).toBe(true);
  });
});

describe("runScheduler worker network reconcile", () => {
  test("a backend without isolation resources is never asked", async () => {
    const { backend, run } = harness();
    expect(backend.reconcileNetworks).toBeUndefined();

    const summary = await run();

    expect(summary.networksReclaimed).toEqual([]);
    expect(summary.networkScanFailed).toBe(false);
  });

  test("runs after orphans are terminated and before any slot is filled", async () => {
    const { backend, run, store } = harness();
    const order: string[] = [];
    backend.containers.set("exec-orphan#1", {
      exited: false,
      generation: 1,
      operationId: "op-orphan",
      sessionId: "session-orphan",
    });
    backend.duringTerminate = () => order.push("terminate");
    backend.duringEnsure = () => order.push("ensure");
    backend.reconcileNetworks = async () => {
      order.push("reconcile");
      return { failed: [], removed: [], repaired: [] };
    };
    store.addUnassigned(1);

    await run();

    // Admission creates networks; a leak it could have waited behind is
    // cleared first.
    expect(order).toEqual(["terminate", "reconcile", "ensure"]);
  });

  test("what the backend reports lands in the summary and the log", async () => {
    const { backend, records, run } = harness();
    backend.reconcileNetworks = async () => ({
      failed: [{ error: "still has members", id: "ap-net-stuck" }],
      removed: ["ap-net-gone"],
      repaired: ["ap-net-cut"],
    });

    const summary = await run();

    expect(summary.networksReclaimed).toEqual(["ap-net-gone"]);
    expect(summary.networksRepaired).toEqual(["ap-net-cut"]);
    expect(summary.networksFailed).toEqual(["ap-net-stuck"]);
    expect(
      records.some(
        (record) =>
          record.level === "error" &&
          (record.fields as { network_id?: string } | undefined)?.network_id ===
            "ap-net-stuck",
      ),
    ).toBe(true);
  });

  test("a failed listing is a scan failure and does not stop the pass", async () => {
    const { backend, run, store } = harness();
    backend.reconcileNetworks = async () => {
      throw new Error("daemon unreachable");
    };
    store.addUnassigned(1);

    const summary = await run();

    expect(summary.networkScanFailed).toBe(true);
    expect(summary.launched).toHaveLength(1);
  });
});

describe("reclaimNetworks", () => {
  test("reconciles worker networks and nothing else", async () => {
    const { backend, logger, store } = harness();
    store.addUnassigned(1);
    backend.reconcileNetworks = async () => ({
      failed: [{ error: "2 running proxies", id: "ap-net-live" }],
      removed: ["ap-net-gone"],
      repaired: [],
    });

    const summary = await reclaimNetworks({ backend, logger, store });

    expect(summary.networksReclaimed).toEqual(["ap-net-gone"]);
    expect(summary.networksFailed).toEqual(["ap-net-live"]);
    expect(backend.ensureCalls).toEqual([]);
    expect(summary.launched).toEqual([]);
  });

  test("a held lock skips it, so it never races a pass", async () => {
    const { backend, logger, store } = harness();
    let asked = false;
    backend.reconcileNetworks = async () => {
      asked = true;
      return { failed: [], removed: [], repaired: [] };
    };
    await store.acquirePassLock();

    const summary = await reclaimNetworks({ backend, logger, store });

    expect(summary.skipped).toBe(true);
    expect(asked).toBe(false);
  });

  test("a lock lost before the reconcile touches no network", async () => {
    const { backend, logger, store } = harness();
    let asked = false;
    backend.reconcileNetworks = async () => {
      asked = true;
      return { failed: [], removed: [], repaired: [] };
    };
    const acquire = store.acquirePassLock.bind(store);
    store.acquirePassLock = async () => {
      const lock = await acquire();
      store.loseLock();
      return lock;
    };

    await expect(reclaimNetworks({ backend, logger, store })).rejects.toThrow(
      "pass lock connection ended",
    );
    expect(asked).toBe(false);
    expect(store.locked).toBe(false);
  });

  test("a lock lost during the reconcile still fails it", async () => {
    const { backend, logger, store } = harness();
    backend.reconcileNetworks = async () => {
      store.loseLock();
      return { failed: [], removed: ["ap-net-gone"], repaired: [] };
    };

    await expect(reclaimNetworks({ backend, logger, store })).rejects.toThrow(
      "pass lock connection ended",
    );
    expect(store.locked).toBe(false);
  });
});

describe("runScheduler workspace GC", () => {
  test("reclaims a finished session's workspace and keeps a live one's", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-live", "session-live");
    backend.workspaces.set("ap-ws-done", "session-done");
    store.retainedSessions.add("session-live");

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-done"]);
    expect([...backend.workspaces.keys()]).toEqual(["ap-ws-live"]);
  });

  test("asks the daemon before the database, never the other way round", async () => {
    // A session created between the two calls has to land in the retained
    // set. Listing after the query would make its brand-new workspace look
    // unowned by the time it was seen.
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-1", "session-1");
    const order: string[] = [];
    const listed = backend.listWorkspaces;
    if (!listed) throw new Error("fixture has no workspace GC");
    backend.listWorkspaces = async () => {
      order.push("list");
      return listed();
    };
    const filter = store.filterRetainedSessions.bind(store);
    store.filterRetainedSessions = async (ids, options) => {
      order.push("query");
      return filter(ids, options);
    };

    await run();

    expect(order).toEqual(["list", "query"]);
  });

  test("a workspace with no session label is left alone and reported", async () => {
    const { backend, records, run, store } = harness();
    backend.workspaces.set("ap-ws-unlabelled", null);

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspacesUnresolved).toEqual([]);
    expect(backend.workspaces.has("ap-ws-unlabelled")).toBe(true);
    // Never asked about: nothing here can turn it into a session id.
    expect(store.retainedQueries).toEqual([]);
    expect(records.some((r) => r.message.includes("carries no session"))).toBe(
      true,
    );
  });

  test("a legacy workspace goes only once the database proves its session closed", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-legacy-closed", "session-closed");
    backend.workspaces.set("ap-ws-legacy-open", "session-open");
    backend.legacyWorkspaces.add("ap-ws-legacy-closed");
    backend.legacyWorkspaces.add("ap-ws-legacy-open");
    store.closedLegacySessions.add("session-closed");
    // Stopped past its TTL, if it were labelled: a name is not enough for that.
    store.claimVerdicts.set("session-open", "claimed");

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-legacy-closed"]);
    expect([...backend.workspaces.keys()]).toEqual(["ap-ws-legacy-open"]);
    expect(store.closedLegacyQueries).toEqual([
      ["session-closed", "session-open"],
    ]);
    // Neither went near the labelled path: no retention query, no claim.
    expect(store.retainedQueries).toEqual([]);
    expect(store.pendingClaims.size).toBe(0);
  });

  test("a legacy workspace is removed for its own session only", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-legacy", "session-closed");
    backend.legacyWorkspaces.add("ap-ws-legacy");
    store.closedLegacySessions.add("session-closed");
    const removals: Array<[string, string | undefined]> = [];
    const remove = backend.removeWorkspace;
    if (!remove) throw new Error("fixture has no workspace GC");
    backend.removeWorkspace = async (id, owner) => {
      removals.push([id, owner?.sessionId]);
      return remove(id, owner);
    };

    await run();

    expect(removals).toEqual([["ap-ws-legacy", "session-closed"]]);
  });

  test("a failed legacy query reclaims nothing and fails the scan", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-done", "session-done");
    backend.workspaces.set("ap-ws-legacy", "session-closed");
    backend.legacyWorkspaces.add("ap-ws-legacy");
    store.closedLegacySessions.add("session-closed");
    store.failClosedLegacy = true;

    const summary = await run();

    expect(summary.workspaceScanFailed).toBe(true);
    expect(summary.workspacesReclaimed).toEqual([]);
    expect(backend.workspaces.size).toBe(2);
  });

  test("a mounted workspace stays and is counted unresolved", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-busy", "session-busy");
    backend.workspacesInUse.add("ap-ws-busy");
    void store;

    const summary = await run();

    expect(summary.workspacesUnresolved).toEqual(["ap-ws-busy"]);
    expect(backend.workspaces.has("ap-ws-busy")).toBe(true);
  });

  test("a removal that throws leaves the rest of GC running", async () => {
    const { backend, run } = harness();
    backend.workspaces.set("ap-ws-a", "session-a");
    backend.workspaces.set("ap-ws-b", "session-b");
    backend.failRemoveWorkspaceFor.add("ap-ws-a");

    const summary = await run();

    // A removal that threw is a fault, not a decision to leave it.
    expect(summary.workspacesFailed).toEqual(["ap-ws-a"]);
    expect(summary.workspacesUnresolved).toEqual([]);
    expect(summary.workspacesReclaimed).toEqual(["ap-ws-b"]);
  });

  test("a daemon that will not list reclaims nothing and does not fail the pass", async () => {
    const { backend, run, store } = harness();
    backend.failListWorkspaces = true;
    store.addUnassigned(1);

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspaceScanFailed).toBe(true);
    // The launches still happened; GC is the last step for exactly this reason.
    expect(summary.launched).toHaveLength(1);
  });

  test("a database that will not answer reclaims nothing", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-done", "session-done");
    store.failRetained = true;

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspaceScanFailed).toBe(true);
    expect(backend.workspaces.has("ap-ws-done")).toBe(true);
  });

  test("a backend that does not own its workspaces runs no GC", async () => {
    const { backend, run, store } = harness(10, { workspaceGc: false });
    expect(backend.listWorkspaces).toBeUndefined();

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(store.retainedQueries).toEqual([]);
  });

  test("a stopped session past its TTL loses its workspace through a claim", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-stopped", "session-stopped");
    store.claimVerdicts.set("session-stopped", "claimed");

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-stopped"]);
    expect(backend.workspaces.has("ap-ws-stopped")).toBe(false);
    expect(store.settledClaims.map((claim) => claim.outcome)).toEqual([
      "removed",
    ]);
    expect(store.pendingClaims.size).toBe(0);
    expect(store.retainedTtls).toEqual([DEFAULT_STOPPED_WORKSPACE_TTL_MS]);
  });

  test("the configured TTL is the one the store judges by", async () => {
    const { backend, run, store } = harness(10, { stoppedWorkspaceTtlMs: 0 });
    backend.workspaces.set("ap-ws-stopped", "session-stopped");

    await run();

    expect(store.retainedTtls).toEqual([0]);
  });

  test("the verdict under the session lock wins over the listing's", async () => {
    // Between the listing and the claim the session was resumed: its
    // workspace is the one the next launch mounts.
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-resumed", "session-resumed");
    store.claimVerdicts.set("session-resumed", "retained");

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspacesUnresolved).toEqual([]);
    expect(backend.workspaces.has("ap-ws-resumed")).toBe(true);
  });

  test("a claimed removal that throws keeps the claim until a later pass settles it", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-stopped", "session-stopped");
    store.claimVerdicts.set("session-stopped", "claimed");
    backend.failRemoveWorkspaceFor.add("ap-ws-stopped");

    const first = await run();

    expect(first.workspacesFailed).toEqual(["ap-ws-stopped"]);
    // Whether the volume went is unknown, so resume stays refused.
    expect(store.pendingClaims.has("session-stopped")).toBe(true);
    expect(store.settledClaims).toEqual([]);

    // The removal did go through; the daemon just never said so.
    backend.failRemoveWorkspaceFor.clear();
    backend.workspaces.delete("ap-ws-stopped");
    const second = await run();

    expect(second.workspacesReclaimed).toEqual(["ap-ws-stopped"]);
    expect(store.settledClaims.map((claim) => claim.outcome)).toEqual([
      "removed",
    ]);
    expect(store.pendingClaims.size).toBe(0);
  });

  test("a pending claim is not claimed twice while its workspace is still listed", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-stopped", "session-stopped");
    store.claimVerdicts.set("session-stopped", "claimed");
    backend.failRemoveWorkspaceFor.add("ap-ws-stopped");
    await run();

    const again = await run();

    // Once from the sweep; the listing's second look is turned away.
    expect(again.workspacesFailed).toEqual(["ap-ws-stopped"]);
    expect(store.pendingClaims.size).toBe(1);
  });

  test("a pending claim never removes a name that now holds another session's workspace", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-stopped", "session-stopped");
    store.claimVerdicts.set("session-stopped", "claimed");
    backend.failRemoveWorkspaceFor.add("ap-ws-stopped");
    await run();

    // Between the passes the name came to carry someone else's workspace.
    backend.failRemoveWorkspaceFor.clear();
    backend.workspaces.set("ap-ws-stopped", "session-other");
    store.retainedSessions.add("session-other");
    const summary = await run();

    expect(backend.workspaces.get("ap-ws-stopped")).toBe("session-other");
    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspacesUnresolved).toEqual(["ap-ws-stopped"]);
    expect(store.settledClaims.map((claim) => claim.outcome)).toEqual([
      "released",
    ]);
  });

  test("a mounted claimed workspace gives its claim back", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-busy", "session-busy");
    backend.workspacesInUse.add("ap-ws-busy");
    store.claimVerdicts.set("session-busy", "claimed");

    const summary = await run();

    expect(summary.workspacesUnresolved).toEqual(["ap-ws-busy"]);
    expect(store.settledClaims.map((claim) => claim.outcome)).toEqual([
      "released",
    ]);
    expect(store.pendingClaims.size).toBe(0);
  });

  test("a claim that cannot be settled is a failure and stays pending", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-stopped", "session-stopped");
    store.claimVerdicts.set("session-stopped", "claimed");
    store.failFinish = true;

    const summary = await run();

    expect(summary.workspacesFailed).toEqual(["ap-ws-stopped"]);
    expect(summary.workspacesReclaimed).toEqual([]);
    expect(store.pendingClaims.has("session-stopped")).toBe(true);
  });

  test("a claim the store cannot make leaves the workspace and fails the pass", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-done", "session-done");
    store.failClaim = true;

    const summary = await run();

    expect(summary.workspacesFailed).toEqual(["ap-ws-done"]);
    expect(backend.workspaces.has("ap-ws-done")).toBe(true);
  });

  test("pending claims that cannot be listed stop GC as a scan failure", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-done", "session-done");
    store.listPendingWorkspaceReclaims = async () => {
      throw new Error("database down");
    };

    const summary = await run();

    expect(summary.workspaceScanFailed).toBe(true);
    expect(backend.workspaces.has("ap-ws-done")).toBe(true);
  });

  test("a workspace whose volume is already gone counts as reclaimed", async () => {
    // The scheduler asks for a removal it cannot know has already happened;
    // `absent` is the same end state, not a failure to report.
    const { backend, run } = harness();
    backend.workspaces.set("ap-ws-gone", "session-gone");
    backend.workspaces.delete("ap-ws-gone");
    const listed = backend.listWorkspaces;
    if (!listed) throw new Error("fixture has no workspace GC");
    backend.listWorkspaces = async () => [
      { createdAt: new Date(0), id: "ap-ws-gone", sessionId: "session-gone" },
    ];

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-gone"]);
  });
});

describe("launch spec", () => {
  test("a new launch is pinned to what the image names when it is reserved, once per pass", async () => {
    const { backend, run, store } = harness();
    backend.imageIds.set("worker:test", "sha256:first");
    store.addUnassigned(3);

    await run();

    expect(backend.resolveCalls).toEqual(["worker:test"]);
    expect(backend.ensureCalls).toHaveLength(3);
    for (const intent of backend.ensureCalls) {
      expect(intent.image).toBe("sha256:first");
      expect(intent.resources).toEqual(RESOURCES);
      expect(intent.launchSpec).toBe(
        launchSpecFingerprint("sha256:first", RESOURCES),
      );
    }
    for (const row of store.executions.values()) {
      expect(row.image).toBe("sha256:first");
      expect(row.resources).toEqual(RESOURCES);
    }
  });

  test("a pass with nobody to admit does not ask for the image", async () => {
    const { backend, run } = harness();
    const summary = await run();
    expect(backend.resolveCalls).toEqual([]);
    expect(summary.imageUnresolved).toBe(false);
  });

  test("a launch re-created after a rollout runs what it was reserved with; only a new launch gets the new settings", async () => {
    const store = new MemoryStore();
    const backend = new FakeBackend();
    const { logger } = recordingLogger();
    const pass = (resources: typeof RESOURCES) =>
      runScheduler({
        backend,
        image: "worker:test",
        logger,
        resources,
        slotLimit: 10,
        store,
      });
    backend.imageIds.set("worker:test", "sha256:before");
    const [early] = store.addUnassigned(1);
    await pass(RESOURCES);

    // The tag moves and the limits change; then the early launch's
    // container disappears before any worker claimed it.
    backend.imageIds.set("worker:test", "sha256:after");
    const bigger = { ...RESOURCES, memoryBytes: RESOURCES.memoryBytes * 2 };
    backend.containers.clear();
    backend.ensureCalls.length = 0;
    const [late] = store.addUnassigned(1);
    const summary = await pass(bigger);

    expect(summary.reensured).toHaveLength(1);
    expect(summary.launched).toHaveLength(1);
    const rebuilt = backend.ensureCalls.find((i) => i.sessionId === early);
    const fresh = backend.ensureCalls.find((i) => i.sessionId === late);
    expect(rebuilt?.generation).toBe(1);
    expect(rebuilt?.image).toBe("sha256:before");
    expect(rebuilt?.resources).toEqual(RESOURCES);
    expect(fresh?.image).toBe("sha256:after");
    expect(fresh?.resources).toEqual(bigger);
  });

  test("an image that cannot be pinned admits nobody and fails the pass, and the rest of the pass still runs", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    backend.containers.clear();
    backend.ensureCalls.length = 0;
    store.addUnassigned(2);
    backend.failResolveImage = true;

    const summary = await run();

    expect(summary.imageUnresolved).toBe(true);
    expect(summary.launched).toEqual([]);
    // Reconciling what already exists does not need the configured image.
    expect(summary.reensured).toHaveLength(1);
    expect(backend.ensureCalls).toHaveLength(1);
    expect(store.executions.size).toBe(1);
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("could not be pinned"),
      ),
    ).toBe(true);
  });

  test("a running resource built from another spec is replaced with the one the launch was reserved with", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row?.image || !row.resources) throw new Error("no stored spec");
    container.launchSpec = launchSpecFingerprint("sha256:other", RESOURCES);

    const summary = await run();

    expect(summary.replaced).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(summary.reensured).toHaveLength(1);
    expect(row.replacementCount).toBe(1);
    expect(row.pendingReplacement).toBeNull();
    expect(store.confirmedGone).toEqual([]);
    const replacement = [...backend.containers.values()][0];
    expect(replacement?.launchSpec).toBe(
      launchSpecFingerprint(row.image, row.resources),
    );
    expect(
      records.some(
        (r) => r.level === "warn" && r.message.includes("another launch spec"),
      ),
    ).toBe(true);
  });

  test("a spec mismatch is left alone on a claimed launch, an unlabelled resource, and a launch with no stored spec", async () => {
    const { backend, run, store } = harness();
    const other = launchSpecFingerprint("sha256:other", RESOURCES);
    // Claimed: a worker is bound, so the resource finishes where it is.
    store.addUnassigned(1);
    await run();
    const [claimedName, claimedContainer] =
      [...backend.containers.entries()][0] ?? [];
    const claimed = store.executions.get(claimedName?.split("#")[0] ?? "");
    if (!claimed || !claimedContainer) throw new Error("no launch");
    claimed.claimed = true;
    claimedContainer.launchSpec = other;
    // Unlabelled: from before the label, adopted as it always was.
    const unlabelled = store.seedActive({
      image: "sha256:worker:test",
      nonce: "nonce-unlabelled",
      nonceExpiresAt: new Date(Date.now() + NONCE_TTL_MS),
      resources: RESOURCES,
    });
    backend.containers.set(nameOf(unlabelled), {
      exited: false,
      generation: 1,
      operationId: unlabelled.operationId ?? "",
      sessionId: unlabelled.sessionId,
    });
    // No stored spec: nothing durable says what it should run.
    const legacy = store.seedActive({
      nonce: "nonce-legacy",
      nonceExpiresAt: new Date(Date.now() + NONCE_TTL_MS),
    });
    backend.containers.set(nameOf(legacy), {
      exited: false,
      generation: 1,
      launchSpec: other,
      nonce: "nonce-legacy",
      operationId: legacy.operationId ?? "",
      sessionId: legacy.sessionId,
    });
    backend.terminateCalls.length = 0;

    const summary = await run();

    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
  });

  test("a launch reserved before the spec was stored is re-created on the host's current settings", async () => {
    const { backend, run, store } = harness();
    const legacy = store.seedActive({});
    const summary = await run();
    expect(summary.reensured).toEqual([
      { executionId: legacy.executionId, generation: 1 },
    ]);
    const [intent] = backend.ensureCalls;
    expect(intent?.image).toBe("worker:test");
    expect(intent?.resources).toEqual(RESOURCES);
    expect(intent?.launchSpec).toBeNull();
    expect([...backend.containers.values()][0]?.launchSpec).toBeUndefined();
  });

  test("limits the host could never launch are refused before any pass starts", async () => {
    const store = new MemoryStore();
    const { logger } = recordingLogger();
    await expect(
      runScheduler({
        backend: new FakeBackend(),
        image: "worker:test",
        logger,
        resources: { ...RESOURCES, pidsLimit: 0 },
        slotLimit: 10,
        store,
      }),
    ).rejects.toThrow("pidsLimit 0 is not a positive integer");
    expect(store.locked).toBe(false);
  });
});
