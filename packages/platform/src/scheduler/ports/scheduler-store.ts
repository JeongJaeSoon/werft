import type { ExecutionBackend as ExecutionBackendKind } from "@werft-ai/contracts";
import type { ImageRuntime } from "@werft-ai/runtime-core";
import type { ExecutionIncarnation } from "../../ports/worker-unit-of-work.ts";
import type { PointerRuntime } from "../worker-images.ts";
import type {
  ExecutionObservation,
  ExecutionRef,
  ExecutionResources,
  LaunchCredentialState,
  LaunchIntent,
} from "./execution-backend.ts";

/**
 * Why a resource that exists is torn down and built again.
 * `credential_mismatch`: it holds a bootstrap credential the registry has
 * rotated past, so it can never bind.
 * `spec_mismatch`: it runs an image or limits other than the ones its launch
 * was reserved with.
 */
export type ReplaceReason =
  | "credential_mismatch"
  | "nonce_expired"
  | "spec_mismatch"
  | "stale_isolation";

export type SchedulerDemand = {
  /** Reserved launch slots: rows that have not given their slot back. */
  activeExecutionCount: number;
  /** Unassigned, admission-active sessions with no open launch. */
  eligibleSessionIds: string[];
};

export type ReserveLaunchInput = {
  backend: ExecutionBackendKind;
  /** Already pinned by `ExecutionBackend.resolveImage`. */
  image: string;
  /**
   * The combination the scheduler was told `image` runs. The worker's claim
   * is held to it. Absent when no image runtime is configured.
   */
  imageRuntime?: ImageRuntime;
  now: Date;
  resources: ExecutionResources;
  sessionId: string;
  /**
   * Global cap on reserved launch slots, enforced inside the reservation
   * transaction so concurrent scheduler passes cannot both take the last slot.
   */
  slotLimit: number;
};

/**
 * A pinned image whose worker claimed under another combination than the
 * one its launches assumed: an install defect. The scheduler reserves no
 * launch on it under that assumption again.
 */
export type WorkerImageRefusal = {
  image: string;
  assumed: ImageRuntime;
};

export type HoldIncompatibleInput = {
  sessionId: string;
  /** The pointer revision the image was chosen against. */
  checkpointRevision: number;
  detail: string;
  now: Date;
};

/**
 * What the registry durably holds, image and limits included: the launch
 * runs what it was reserved with for as long as it lives, and only a new
 * reservation — a new generation — picks up changed host settings. Both are
 * null for a launch reserved before they were stored; the scheduler then
 * falls back to its current settings, the one exception to that rule.
 */
export type StoredLaunchIntent = Omit<
  LaunchIntent,
  | "image"
  | "resources"
  | "launchSpec"
  | "issueBootstrapNonce"
  | "bootstrapCredentialState"
> & {
  image: string | null;
  resources: ExecutionResources | null;
};

/**
 * A launch that still holds its slot. Rows written before the intent columns
 * existed carry a null `operationId`: they are inspected and reclaimed like
 * any other, but can never be relaunched.
 */
export type ActiveExecution = Omit<StoredLaunchIntent, "operationId"> & {
  backend: ExecutionBackendKind;
  operationId: string | null;
  /**
   * `terminated` is the kill outbox: a terminate command or the lease-expiry
   * reconciler asked for this generation to go, and the pass tears it down
   * before anything else. The row keeps its slot until the resource is
   * confirmed gone.
   */
  desiredState: "running" | "terminated";
  observedState: ExecutionObservation["state"];
  /**
   * When `observedState` was recorded, on the scheduler's clock; null until
   * a pass records one. For a kill left `terminating`, when its first stop
   * went out.
   */
  observedAt: Date | null;
  providerRef: string | null;
  /**
   * A worker already traded this launch's nonce for a binding. Its resource
   * is not something to re-create: the session belongs to an attempt, and
   * only confirming the execution gone can give either one back.
   */
  claimed: boolean;
  /**
   * When this launch's bootstrap credential stops being accepted, or null
   * while no container has been created for it. Past it and unclaimed, the
   * resource can never bind: the credential it holds is fixed in its
   * environment, so it has to be replaced rather than waited on.
   */
  nonceExpiresAt: Date | null;
  /**
   * `nonceExpiresAt` judged on the storage clock as the rows were listed.
   * The scheduler's own clock never decides this: a replica running ahead
   * would replace a resource whose credential is still good.
   */
  nonceExpired: boolean;
  /**
   * `launchNonceFingerprint` of the stored hash, or null while none is held.
   * What a resource's `credentialFingerprint` label is compared to.
   */
  nonceFingerprint: string | null;
  /**
   * A replacement the scheduler committed to before tearing the resource
   * down, until the one built from the intent is observed up. It survives a
   * teardown that only half happened and a control host that died between
   * the two halves: the next pass finishes it with the same intent instead
   * of reading the stopped resource as an ordinary exit.
   */
  pendingReplacement: ReplaceReason | null;
  /**
   * How many replacements this launch has ever been asked for. Never reset,
   * so a launch whose fresh resource keeps being judged replaceable runs into
   * the scheduler's limit instead of being rebuilt forever.
   */
  replacementCount: number;
  /**
   * Launch attempts that failed before any worker bound (see
   * `recordLaunchFailure`). Never reset: brief signs of life are not proof
   * of a launch, only a claim is, and a claimed launch is never re-ensured.
   */
  launchFailureCount: number;
  /**
   * Launch attempts whose outcome was recorded, success or failure. What a
   * failure record is fenced on (see `beginLaunchAttempt`).
   */
  launchAttempts: number;
  /** When the next attempt may be made, or null when nothing holds it back. */
  launchRetryAt: Date | null;
  /**
   * `launchRetryAt` judged on the storage clock as the rows were listed, like
   * `nonceExpired`: true when no failure holds the next attempt back.
   */
  launchRetryDue: boolean;
};

export type LaunchFailureInput = {
  /** What the provider said, as the operator will read it. */
  error: string;
  /** `launchFailureCount` as the caller judged the launch. */
  expectedCount: number;
  /**
   * `launchAttempts` as the caller judged the launch. An attempt another
   * pass has since recorded — a success above all — makes this one stale.
   */
  expectedAttempts: number;
  /**
   * When given, the launch must still accept exactly this credential, as in
   * `requestReplacement`. An exited resource is judged by the credential it
   * was built with: the record revokes it, so the same resource seen again
   * no longer matches and is never counted twice.
   */
  expectedNonceFingerprint?: string | null;
  /**
   * This failure is the last one: the launch is given up on in the same
   * write instead of being scheduled for another attempt.
   */
  quarantine: boolean;
  /** How long from now, on the storage clock, before the next attempt. */
  retryDelayMs: number;
};

/**
 * `stale`: the launch moved on since it was judged — a worker bound, it gave
 * its slot back, it was asked to go, or another failure was recorded — and
 * nothing was written.
 */
export type LaunchFailureOutcome = "backing_off" | "quarantined" | "stale";

/** The scheduling pass lock, while this pass holds it. */
export type PassLock = {
  /**
   * Aborted once the connection that holds the lock is gone. PostgreSQL has
   * then already released it, so another pass may be reconciling the same
   * rows from its own snapshot; the pass stops before its next provider or
   * binding change. A connection that dies silently is only noticed when
   * its socket says so, and the moment between a check and the change it
   * guards always remains: the durable fences — `requestReplacement`'s
   * count and credential, `confirmExecutionGone`'s incarnation — are what
   * keep a pass from undoing another's work, not this.
   */
  readonly signal: AbortSignal;
  /** Gives the lock back; on a lost lock, only the connection. */
  release(): Promise<void>;
};

/** How long a resumable session keeps its workspace, by admission state. */
export type WorkspaceTtls = {
  stoppedTtlMs: number;
  /** Absent: a paused session's workspace is never reclaimed. */
  pausedTtlMs?: number;
};

export type WorkspaceReclaimClaim =
  | { kind: "retained" }
  | { kind: "unclaimed" }
  | { kind: "claimed"; claimId: string };

export type PendingWorkspaceReclaim = {
  claimId: string;
  sessionId: string;
  workspaceId: string;
};

/**
 * Durable side of the scheduler. Every method is its own transaction so the
 * provider call always happens after the intent is committed.
 */
/** Where the drain of a claimed launch stands (`requestDrain`). */
export type DrainState = {
  /**
   * The worker is not at a boundary yet: a turn on the session it serves is
   * still open, or it has not asked for its first input (still starting up).
   */
  busy: boolean;
  /** The first request is at least the deadline old, on the storage clock. */
  overdue: boolean;
};

export interface SchedulerStore {
  /**
   * Serializes whole scheduling passes. Returns the held lock, or null when
   * another pass holds it, so overlapping runs never reconcile the same rows
   * from different snapshots.
   */
  acquirePassLock(): Promise<PassLock | null>;
  /** `excluding` pages past sessions this pass already passed over. */
  inspectDemand(input: {
    limit: number;
    excluding?: readonly string[];
  }): Promise<SchedulerDemand>;
  /**
   * Commits the launch intent for a session that is still eligible and a slot
   * is free, or returns null when either no longer holds (raced by a claim,
   * another launch, or another scheduler pass).
   */
  reserveLaunch(input: ReserveLaunchInput): Promise<StoredLaunchIntent | null>;
  /** The session's pointer runtime and the revision it was read at (0: none). */
  pointerRuntimeOf(
    sessionId: string,
  ): Promise<{ pointer: PointerRuntime; checkpointRevision: number }>;
  /** Every recorded image refusal (`WorkerImageRefusal`). */
  workerImageRefusals(): Promise<WorkerImageRefusal[]>;
  /**
   * Stops a session no configured image can resume before anything is
   * launched for it: `recovery_required` with `incompatible_checkpoint`, as
   * a restore that refused its checkpoint would. `stale` when the session is
   * no longer launchable or its pointer moved past `checkpointRevision`.
   */
  holdIncompatibleBeforeLaunch(
    input: HoldIncompatibleInput,
  ): Promise<"held" | "stale">;
  /**
   * Mints this launch's bootstrap nonce, stores only its hash, and returns
   * the plaintext. Refuses a launch that already bound a worker or gave its
   * slot back, so a credential is never issued for a binding that exists;
   * one asked to go; and one whose last failure still holds the next attempt
   * back, so a pass that lost its lock cannot reopen a launch another pass
   * has just failed or given up on. Given `attempt`, it also refuses once a
   * later attempt has been opened (see `beginLaunchAttempt`): a stale pass
   * must not rotate out the credential a newer attempt's resource holds.
   */
  issueBootstrapNonce(ref: ExecutionRef, attempt?: number): Promise<string>;
  /**
   * Shuts this launch's bootstrap door for good and says whether it was still
   * open: true only when the launch was unclaimed, still held its slot, and
   * its nonce had expired. Deciding and closing in one write is what makes it
   * safe to tear the resource down — a claim that commits either side of it
   * loses or wins outright, never both.
   */
  revokeBootstrapNonce(ref: ExecutionRef): Promise<boolean>;
  /**
   * Records, before anything is torn down, that this launch is to be rebuilt
   * from its stored intent, counts the request, and shuts the launch's
   * bootstrap door in the same write — the resource about to go must not
   * bind a worker between here and the teardown, and the one built next
   * gets a credential of its own. Returns the new count, or null when the
   * launch has bound a worker, given its slot back, been asked to go, or been
   * asked since the rows were read (`expectedCount` no longer matches): there
   * is then nothing to rebuild from this snapshot, and the caller must not
   * tear down. The count check is what stops a pass that lost its lock — a
   * dropped lock connection — from tearing down what a later pass built.
   *
   * `expectedNonceFingerprint`, when given, fences the write on the
   * credential too: the launch must still accept exactly that fingerprint
   * (`launchNonceFingerprint` of its stored hash; null for no credential).
   * `ensureExecution` on another pass rebuilds a resource with a fresh
   * credential without touching the count, so the count alone would let a
   * stale judgement — of any reason — shut the door on that fresh
   * credential. The scheduler always passes it; leaving it out
   * fences on the count alone.
   */
  requestReplacement(
    ref: ExecutionRef,
    reason: ReplaceReason,
    expectedCount: number,
    expectedNonceFingerprint?: string | null,
  ): Promise<number | null>;
  /**
   * Asks the worker a claimed launch bound to drain, before its resource is
   * replaced for a contract it no longer meets: from the first
   * call on, the worker is handed no new turn, so the one it runs is its
   * last. Idempotent — the first request's time is kept and the deadline
   * counts from it. Answered under the lock a worker's next-input takes, so
   * `busy: false` means no turn can start on it any more. Null when the
   * launch holds no binding, has given its slot back, or was asked to go.
   */
  requestDrain(
    ref: ExecutionRef,
    deadlineMs: number,
  ): Promise<DrainState | null>;
  /**
   * The replacement landed: the resource built from the intent is up. Clears
   * the pending reason and keeps the count — only while the count is still
   * `expectedCount`, the one the caller's replacement was recorded at, so a
   * replacement another pass asked for since is not cleared by this one's
   * settling. An operator who wants an
   * exhausted launch retried resets the count alone: clearing the reason as
   * well would turn its stopped resource back into an ordinary exit.
   */
  settleReplacement(ref: ExecutionRef, expectedCount: number): Promise<void>;
  /**
   * Counts one failed launch attempt, fenced on `expectedCount` (and on the
   * credential when given), and revokes the launch's bootstrap credential in
   * the same write: whatever that attempt left behind can then never bind,
   * and the next create mints its own. A pending replacement stays recorded,
   * so a launch waiting out its backoff is never read as an exit.
   *
   * With `quarantine`, the launch is given up on in the same transaction: its
   * kill intent is written (the pass carries it out, and confirming the
   * resource gone is what gives the slot back), the input queued for its
   * session so far fails with `LAUNCH_FAILED`, and the session is left
   * `failed` without an admission signal. Input appended afterwards signals
   * it again and gets a fresh launch.
   */
  recordLaunchFailure(
    ref: ExecutionRef,
    input: LaunchFailureInput,
  ): Promise<LaunchFailureOutcome>;
  /**
   * Opens a launch attempt before the provider is asked, and returns the
   * `launchAttempts` its failure must be recorded against; null when the
   * launch moved on since `expectedAttempts` was read, or was asked to go. A pass that lost its
   * lock while its ensure was out at the provider then reports a failure
   * for an attempt a later pass has already superseded, and is refused
   * instead of revoking the credential the later attempt's resource holds —
   * whether that attempt has finished yet or not.
   */
  beginLaunchAttempt(
    ref: ExecutionRef,
    expectedAttempts: number,
  ): Promise<number | null>;
  /**
   * Which credential this launch accepts right now, read without changing
   * anything: the fingerprint of the stored hash while the launch is open,
   * `claimed` once a worker has bound, and no fingerprint while it holds no
   * credential. Rejects a launch that is unknown or gave its slot back, the
   * same way `issueBootstrapNonce` does: its resource is an orphan, not
   * something to replace.
   */
  bootstrapCredentialState(ref: ExecutionRef): Promise<LaunchCredentialState>;
  /** Open launches for `backend` only; other backends' rows are theirs. */
  listActiveExecutions(
    backend: ExecutionBackendKind,
  ): Promise<ActiveExecution[]>;
  /**
   * The subset of `refs` that have a matching *open* launch. A launch that
   * already gave its slot back no longer owns its resource, so the resource
   * is reclaimed as an orphan if it still exists.
   */
  filterKnown(
    refs: ExecutionRef[],
    backend: ExecutionBackendKind,
  ): Promise<ExecutionRef[]>;
  recordObservation(
    ref: ExecutionRef,
    observation: ExecutionObservation,
  ): Promise<void>;
  /**
   * The provider resource is gone for good: the one place a launch slot and
   * its session are handed back. Idempotent, however many passes see it.
   * Refused, changing nothing, while an unclaimed launch has a replacement
   * pending: its resource being gone is the rebuild in progress, not an
   * exit.
   *
   * `incarnation` is the resource the caller saw go. `superseded` means the
   * launch has moved on to another since, and nothing was changed; null
   * speaks for the launch whatever it runs now, which only a kill intent
   * may. `deferred` is the pending replacement above; a launch asked to go
   * is never deferred, since it is killed rather than rebuilt.
   *
   * `endReason` is what the attempts it ends record, when the exit said more
   * than that the execution is gone.
   */
  confirmExecutionGone(
    executionId: string,
    now: Date,
    incarnation: ExecutionIncarnation | null,
    endReason?: string,
  ): Promise<"confirmed" | "deferred" | "superseded">;
  /**
   * The row's kill intent as it stands now, not as the pass's snapshot had
   * it. A terminate can commit while the pass is out at the provider, and
   * the pass must not re-create a resource that was just asked to go.
   */
  desiredStateOf(
    ref: ExecutionRef,
  ): Promise<ActiveExecution["desiredState"] | null>;
  /**
   * Terminate receipts still `accepted` after `deadlineMs` become `unknown`:
   * the caller is told the kill was not observed in time. The execution row
   * keeps its kill intent, so reconciliation goes on and a later
   * confirmation still settles the receipt. A call flips at most one batch
   * and leaves the rest to the next pass. Returns the receipts flipped.
   */
  markOverdueTerminations(input: {
    now: Date;
    deadlineMs: number;
  }): Promise<number>;

  /**
   * The subset of `sessionIds` whose workspace must be kept: a session row
   * that has not reached a terminal admission state — a paused or
   * recovery-required session is resumed into the same workspace — or one
   * whose launch still holds its slot. An id with no row at all is not
   * retained: nothing can come back to it.
   *
   * Ids the store cannot judge come back retained, so a workspace labelled
   * with something that is not a session id is left alone rather than reaped.
   *
   * A `stopped` session is retained until it has been stopped for
   * `stoppedTtlMs`; past that it is a candidate, and only a
   * `claimWorkspaceReclaim` decides whether its workspace goes. A `paused`
   * session with a checkpoint is the same past `pausedTtlMs` from its
   * `paused_at`; without `pausedTtlMs` every paused session is retained.
   */
  filterRetainedSessions(
    sessionIds: string[],
    options: WorkspaceTtls,
  ): Promise<string[]>;

  /**
   * The subset of `sessionIds` that the database proves done with their
   * workspace: a row exists, it is `closed`, and no launch holds its slot.
   * For workspaces whose session was read off a name rather than a label,
   * where a missing row is no evidence at all — the name may be a stranger's.
   */
  filterClosedLegacySessions(sessionIds: string[]): Promise<string[]>;

  /**
   * Decides, under the session's lock, whether this workspace may be removed.
   * `unclaimed`: nothing can come back to the session (closed, or no row), so
   * the removal needs no claim. `claimed`: a stopped session past its TTL, or
   * a paused one past its TTL with a checkpoint its resume would restore;
   * resume, an answer that would resume it and a parked turn's interrupt
   * refuse until `finishWorkspaceReclaim` settles the claim. Anything else —
   * resumed since, stopped or paused too recently, no restorable checkpoint,
   * a launch holding its slot, a claim already pending — is `retained`.
   */
  claimWorkspaceReclaim(
    input: {
      sessionId: string;
      workspaceId: string;
    } & WorkspaceTtls,
  ): Promise<WorkspaceReclaimClaim>;

  /**
   * Settles a claim by its id: `removed` records the workspace gone,
   * `released` gives the session its workspace back. A claim id that no
   * longer matches changes nothing.
   */
  finishWorkspaceReclaim(input: {
    claimId: string;
    sessionId: string;
    outcome: "removed" | "released";
  }): Promise<void>;

  /**
   * Claims a removal never settled — the pass died, or the daemon did not
   * answer. Asked apart from the workspace listing, because a removal that
   * went through leaves nothing to list.
   */
  listPendingWorkspaceReclaims(): Promise<PendingWorkspaceReclaim[]>;
}
