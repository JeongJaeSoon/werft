import type {
  ApiErrorCode,
  AttemptState,
  CheckpointBlockReason,
  CheckpointRef,
  FinalizeRequest,
  ModelCutCause,
  PauseBlockedReason,
  PermissionGrant,
  PlatformPrompt,
  WorkerEvent,
  WorkspaceRepository,
} from "@werft-ai/contracts";
import type { ImageRuntime, RuntimeFingerprint } from "@werft-ai/runtime-core";
import type { PricedBy, ProviderUsage } from "../limits/model-prices.ts";
import type { SessionGitHubMcp, SessionMcp } from "../sessions/catalog.ts";
import type { CheckpointPointer } from "./checkpoint-store.ts";
import type { CheckpointOutputObject } from "./checkpoint-verifier.ts";

// The identity every post-claim write is fenced on. The storage adapter puts
// these values in the WHERE clause of each write; a row that no longer
// matches means another epoch owns the session.
export type WorkerFence = {
  sessionId: string;
  attemptId: string;
  leaseEpoch: number;
  executionGeneration: number;
  authRevision: number;
};

export type FenceRejection = {
  outcome: "stale_epoch" | "lease_expired";
};

export type WorkerBinding = {
  sessionId: string;
  attemptId: string;
  leaseEpoch: number;
  executionGeneration: number;
  authRevision: number;
  leaseExpiresAt: Date;
  // The lease left on the database clock at an instant read after the claim
  // arrived; what the worker tracks, on its own monotonic clock.
  leaseRemainingMs: number;
  profileId: string | null;
  // With `model`, pins what the session runs (catalog.ts sessionProfile).
  profileFingerprint: string | null;
  model: string | null;
  // The session's profile declared `billing: none` when it was accepted.
  unmetered: boolean;
  // The session's owner partition, straight from the row; the claim hands
  // it to the worker as the checkpoint principal.
  ownerScope: string;
  // As fixed when the session was accepted; the catalog is not consulted.
  // Null for a session accepted without a repository.
  repository: WorkspaceRepository | null;
  restore: CheckpointRef | null;
  // The profiles the session's checkpoints up to `restore` were committed
  // under, where the rows record one; more than the session's own once its
  // profile was changed. Empty without a restore.
  restoreProfiles: ReadonlyArray<{
    profileId: string;
    profileFingerprint: string;
    model: string | null;
  }>;
  // What the session had spent when bound, read under the claim's row lock.
  costUsd: number;
  providerTokens: number;
  mcp?: SessionMcp | null;
  githubMcp?: SessionGitHubMcp | null;
  // The built-in tools the session's release resolved from its card
  // (runtime_config_snapshot.tools); `[]` is a release that allows none.
  // Null, or absent, for a session without a release.
  releaseTools?: readonly string[] | null;
  // The session row's platform prompt as stored. Null, or absent, for a
  // revision 0 session.
  platformPrompt?: PlatformPrompt | null;
  // The allows a parked turn's answers left for the turn carrying it on,
  // not yet spent.
  grants?: readonly PermissionGrant[];
  // The combination the launch was reserved under; absent when it assumed
  // none. The claim's engine version comes from it, not the catalog: a
  // launch on the previous image runs that image's engine.
  launchRuntime?: ImageRuntime;
  // The plain values the session took when it was accepted, by name. Absent
  // when it took none, so a session without variables binds as before.
  env?: Readonly<Record<string, string>>;
};

// A profile and repository this host may run together, with the URL and
// branch the repository is registered under now. A session binds only when
// its row matches one exactly: a host that does not know the profile cannot
// pick the runtime, a pair the repository no longer allows must not carry
// the profile's trust to it, a repository id re-pointed at
// another URL must not carry the old grant to the new one, and a profile id
// whose settings changed must not run a session created under the old ones
// its fingerprint here must equal the one the session was
// accepted with, and its model the session's unless null (a version 1
// fingerprint names its model itself).
export type RepositoryPair = {
  policy?: never;
  profileId: string;
  profileFingerprint: string;
  model: string | null;
  repositoryId: string;
  url: string;
  branch: string;
};

export type RunnablePair =
  | RepositoryPair
  // A profile this host may run without a repository: it matches only a row
  // of repository_mode none, never one whose repository_id is null because
  // it predates the catalog.
  | {
      policy?: never;
      profileId: string;
      profileFingerprint: string;
      model: string | null;
      repositoryId: null;
    }
  | PolicyPair;

/**
 * A profile on any catalog repository, or none, for a session the workspace's
 * ceiling judges (`usesWorkspaceCeiling`): one under the agent's settings, or
 * on a `workspaceScoped` profile for any session. The claim cannot read that
 * ceiling, so what holds these to it is the gate, at every grant.
 */
export type PolicyPair = {
  policy: true;
  profileId: string;
  profileFingerprint: string;
  model: string | null;
  workspaceScoped: boolean;
  repositoryId?: never;
  /** The same list on every pair of a catalog read. */
  repositories: readonly Pick<
    RepositoryPair,
    "repositoryId" | "url" | "branch"
  >[];
};

export type ClaimInput = {
  runnable: RunnablePair[];
  // The installation settings generation that catalog was read at; null
  // before its first read. A replica behind the database's gives up on
  // nothing but a blocked ceiling: the row a pair needs may be one it has
  // not read.
  settingsGeneration: number | null;
  // Repositories the settings hold that this replica could not resolve
  // (a credential it cannot read): another may, so a session on one is not
  // given up on here.
  unsettledRepositoryIds: ReadonlySet<string>;
  // The profile ids whose runnability here is every replica's: this host's
  // runnable profiles and the workspace versions over them. A pinned launch
  // of any other id is not given up on: another replica may have made it
  // since, or hold the connection or setting it needs, and runs it.
  settledProfileIds: ReadonlySet<string>;
  // A session that has spent this much is not bound: it would only be told
  // to release again at its first nextInput.
  costLimitUsd: number;
  // SESSION_TOKEN_LIMIT, held the same way; null, none.
  tokenLimit: number | null;
  nonceHash: Uint8Array;
  executionId: string;
  executionGeneration: number;
  /**
   * What the worker's own image says it runs. Held to the combination its
   * launch was reserved under; absent from a worker that predates it.
   */
  imageRuntime?: ImageRuntime;
  attemptId: string;
  credentialHash: Uint8Array;
  // The attempt's egress tokens, issued, extended and revoked with
  // the session credential. `bindingsOf` names what the claimed session runs
  // at this moment, which each token is then held to.
  egress: EgressIssue;
  // Lifetimes, not deadlines: the storage clock is the one authority on when
  // a lease or token has ended, so the caller says how long, never until when.
  // `now` only stamps audit columns.
  credentialTtlMs: number;
  leaseTtlMs: number;
  now: Date;
  // The worker announced `user_env`. A session that holds variables is not
  // bound to one that did not: its claim could not carry them.
  userEnv?: true;
};

export type EgressPurpose =
  | "provider"
  | "repository"
  | "object_store"
  | "mcp"
  | "packages";

export type EgressIssue = {
  providerHash: Uint8Array;
  repositoryHash: Uint8Array;
  objectStoreHash: Uint8Array;
  mcpHash?: Uint8Array;
  packagesHash?: Uint8Array;
  // `repository` is null for a session that may reach no repository (a
  // `none` profile): no repository token is issued, and `repositoryHash`
  // goes unused.
  bindingsOf(session: {
    id: string;
    profileId: string | null;
    profileFingerprint: string | null;
    model: string | null;
    repositoryMode: "repository" | "none";
    repositoryId: string | null;
    githubPolicySource: string;
    mcp?: SessionMcp | null;
    githubMcp?: SessionGitHubMcp | null;
  }): EgressBindings;
};

export type EgressBindings = {
  provider: string;
  repository: string | null;
  object_store: string;
  mcp?: string;
  packages?: string;
};

// What an egress token stands for once the attempt it belongs to still owns
// its session: the proxy is told where to go from this, never from anything
// the worker says.
export type EgressAuthorization =
  | {
      outcome: "ok";
      sessionId: string;
      attemptId: string;
      binding: string;
      profileId: string | null;
      // The model the attempt claimed with; null where `binding` names it.
      model: string | null;
      repository: { id: string | null; url: string; branch: string } | null;
      githubPolicySource: string;
      // What the session has spent as of this answer.
      costUsd: number;
      providerTokens: number;
    }
  // Unknown, revoked, expired, or presented for another purpose.
  | { outcome: "invalid_token" }
  | FenceRejection;

// One Messages call the egress proxy metered. The ids are the ones the
// proxy's grant carried, so the attempt may have ended since. `priceFor` is
// asked with the session row locked, since whether the session is billed
// decides the price.
export type ProviderUsageInput = {
  exchangeId: string;
  sessionId: string;
  attemptId: string;
  usage: ProviderUsage;
  priceFor(session: { unmetered: boolean }): {
    costUsd: number;
    pricedBy: PricedBy;
  };
};

export type ProviderUsageResult =
  // `replayed`: the same report again, counted the first time only. The
  // cost is what was charged: rounded up to the micro-dollar, at the rates
  // `pricedBy` names.
  | {
      outcome: "recorded" | "replayed";
      costUsd: number;
      pricedBy: PricedBy;
    }
  // No such attempt of that session.
  | { outcome: "unknown_attempt" }
  // The exchange id was recorded with other contents.
  | { outcome: "conflict" };

export type ClaimResult =
  | { outcome: "claimed" | "replayed"; binding: WorkerBinding }
  // Unknown, expired, or presented for a different execution identity.
  | { outcome: "invalid_credential" }
  // The bound session's profile, as the session was accepted with it, is not
  // in this host's catalog, so the replay is refused before it rotates
  // anything.
  | { outcome: "profile_unavailable" }
  // The session's last ran turn has no trusted checkpoint covering it
  // Nothing was bound: the session went to recovery_required in
  // the same transaction and the launch was asked to go.
  | { outcome: "context_gap" }
  // The launch was reserved for a session whose (profile, repository, url,
  // branch) this host's catalog no longer allows, or whose profile id this
  // catalog defines with other settings. The launch was given up on
  // in the same transaction: the session is `failed` with CATALOG_MISMATCH
  // and the launch is asked to go.
  | { outcome: "catalog_mismatch" }
  // The session's variable snapshot is refused under the names the platform
  // reserves now. The session is `failed` and its launch given up in the same
  // transaction, one `reject_session_env` receipt written; nothing was bound.
  | { outcome: "variables_refused" }
  // The session holds variables and this worker did not announce `user_env`.
  // Nothing was bound and nothing changed: another worker, or this one after
  // an update, claims it later.
  | { outcome: "user_env_unsupported" }
  // The worker runs another combination than its launch was reserved under:
  // the image's configured runtime is wrong. Nothing was bound and the
  // session is untouched; the launch was asked to go and the image refused
  // under that assumption (`WorkerImageRefusal`).
  | { outcome: "image_mismatch"; assumed: ImageRuntime }
  | { outcome: "no_session" };

// The fence as it stood when the token was issued. A request body may not
// name any other one: the numbers are guessable, so without this a holder of
// a token that is about to be revoked could pre-address the next revision.
export type ResolvedCredential =
  // `profileId` is the session's, which names its runtime.
  | ({ kind: "session"; profileId?: string | null } & WorkerFence)
  // A launch nonce: valid only for bootstrapClaim.
  | { kind: "bootstrap" }
  | null;

export type NextInputInput = {
  fence: WorkerFence;
  now: Date;
  // A session that has spent this much is handed no new turn.
  costLimitUsd: number;
  tokenLimit: number | null;
};
export type DeliveredInput = {
  turnId: string;
  inputId: string;
  message: string;
  deliveryStartedAt: Date;
};
export type NextInputResult =
  | {
      outcome: "ok";
      input: DeliveredInput | null;
      leaseExpiresAt: Date;
      /**
       * Nothing new is coming, so stop polling: the attempt is draining, or
       * the session's profile changed after it claimed.
       */
      draining?: true;
      /**
       * Nothing new will come for a reason outside the attempt: the session
       * has spent its budget. The worker should release its slot.
       */
      blocked?: "BUDGET_EXCEEDED";
    }
  | FenceRejection;

export type HeartbeatInput = {
  // A worker that keeps heartbeating keeps its token: the credential's
  // lifetime follows the lease instead of cutting a healthy attempt off at a
  // fixed horizon. Both are lifetimes measured on the storage clock.
  credentialTtlMs: number;
  fence: WorkerFence;
  now: Date;
  leaseTtlMs: number;
  attemptState: AttemptState;
  // The worker's transcript mirror as of this heartbeat. `persistedAt` only
  // ever moves the stored value forward; `mirrorError` becomes the session's
  // durable pending reason (mirror_error) until a checkpoint commits.
  transcript?: { persistedAt: Date | null; mirrorError: string | null };
};
export type HeartbeatResult =
  | {
      outcome: "ok";
      leaseExpiresAt: Date;
      // As in WorkerBinding: counted from after the heartbeat arrived.
      leaseRemainingMs: number;
      authRevision: number;
    }
  | FenceRejection;

export type CommitEventsInput = {
  fence: WorkerFence;
  turnId: string | null;
  now: Date;
  events: WorkerEvent[];
  // The engine-neutral fields stored beside a new event's data, never in it:
  // a resend is compared against the data as the worker sent it.
  neutral?: (event: WorkerEvent) => Record<string, unknown> | null;
};
export type CommitEventsResult =
  | { outcome: "ok"; acceptedThrough: number; cursor: string }
  | { outcome: "turn_not_found" }
  // A source_sequence this attempt already stored, with different content.
  | { outcome: "event_conflict" }
  // New events for a turn that already reached its terminal.
  | { outcome: "turn_finalized" }
  // The batch does not continue the durable prefix; acceptedThrough says
  // where the worker has to resume.
  | { outcome: "sequence_gap"; acceptedThrough: number }
  | FenceRejection;

export type FinalizeInput = {
  fence: WorkerFence;
  now: Date;
  turnId: string;
  finalizeKey: string;
  finalSourceSequence: number;
  terminal: FinalizeRequest["terminal"];
  checkpoint: CheckpointRef | null;
  // A provider failure on a session that has spent this much is recorded as
  // the budget ending the turn, whatever the engine made of the refusal.
  costLimitUsd: number;
  tokenLimit: number | null;
  // The verifier's verdict on `checkpoint`, never the worker's say.
  checkpointVersionsHeld?: boolean;
  checkpointTranscriptBytes?: number;
  checkpointOutputs?: readonly CheckpointOutputObject[];
  checkpointOutputsDigest?: string | null;
  checkpointRuntime?: RuntimeFingerprint;
};
export type FinalizeOutcome = {
  turnId: string;
  status: FinalizeRequest["terminal"]["status"];
  checkpointRevision: number | null;
};
export type FinalizeResult =
  | { outcome: "finalized" | "replayed"; result: FinalizeOutcome }
  | { outcome: "turn_not_found" }
  // The turn already reached a terminal state under a different key or body.
  | { outcome: "finalize_conflict" }
  | { outcome: "checkpoint_rejected"; reason: string }
  // The checkpoint names a revision other than the pointer's next one:
  // another finalize moved it first. Ask again, upload, finalize again.
  | { outcome: "checkpoint_conflict"; currentRevision: number | null }
  // A completed terminal was offered without a checkpoint while the session
  // carries a blocking pending reason: the turn cannot be reported as durably
  // finished. Interrupted/failed/unknown terminals are never held back.
  | { outcome: "checkpoint_required"; reason: CheckpointBlockReason }
  // The stream is not durable through final_source_sequence (or holds more
  // than the worker claims); acceptedThrough says what is actually stored.
  | { outcome: "events_incomplete"; acceptedThrough: number }
  | FenceRejection;

export type PeekFinalizeResult = FinalizeResult | { outcome: "open" };

export type CheckpointStateInput = {
  fence: WorkerFence;
  now: Date;
  // A reason to record (durability.ts checkpointPendingReason); undefined
  // leaves the stored one alone, and an advisory reason never replaces a
  // blocking one. Only a committed checkpoint clears it (finalizeAtomic).
  pendingReason?: CheckpointBlockReason;
};
export type CheckpointStateResult =
  | {
      outcome: "ok";
      // The pointer from the same snapshot as the fence; the protocol works
      // from this rather than re-reading it unfenced.
      pointer: CheckpointPointer | null;
      // Whether that pointer may be restored from (hasRestorePoint): not
      // under a blocking reason, and not retired by a start_fresh decision
      // . The next revision still counts from `pointer` either way.
      restorable: boolean;
      pendingReason: CheckpointBlockReason | null;
    }
  | FenceRejection;

/**
 * What a served restore plan was built on. `fallback` is set when
 * the plan restores an earlier revision because the pointer's checkpoint was
 * damaged, and null when it restores the pointer itself.
 */
export type RestoreBaseInput = {
  fence: WorkerFence;
  now: Date;
  /** The pointer revision the plan was judged against. */
  pointerRevision: number;
  fallback: {
    revision: number;
    skipped: readonly { reason: string; revision: number }[];
  } | null;
};
export type RestoreBaseResult =
  | { outcome: "ok" }
  // The pointer is no longer the one the plan was judged against.
  | { outcome: "pointer_moved"; currentRevision: number | null }
  // This attempt was already handed a different revision, the pointer's or
  // an earlier one, for the same pointer; it must not restore two.
  | { outcome: "base_changed"; recordedRevision: number }
  | FenceRejection;

export type ReleaseInput = {
  fence: WorkerFence;
  now: Date;
  reason: string;
  /**
   * Set when the release answers a pause: the attempt drained and asks the
   * coordinator to commit the pause. It is refused, and the attempt keeps
   * its lease and engine, unless the pause can be committed now.
   */
  pauseControlId?: string;
  /** The worker was asked to stop rather than failing. */
  drained?: boolean;
};
export type ReleaseResult =
  | { released: boolean }
  // The pause it answers is no longer the session's open one.
  | { released: false; refused: "pause_stale" }
  // Not at a safe boundary: the checkpoint the pause needs is not there.
  | { released: false; refused: "pause_blocked"; reason: PauseBlockedReason }
  | { released: false; refused: "lease_expired" };

export type ReadyInput = {
  fence: WorkerFence;
  now: Date;
  /** The checkpoint revision the worker restored (its claim's); null when it started fresh. */
  restoredRevision: number | null;
};
export type ReadyResult =
  // `activated` when this report completed a resume from `paused`.
  | { outcome: "ok"; activated: boolean }
  // A resuming session whose trusted pointer is not what the worker
  // restored: the resume is failed and the session left to an operator.
  | { outcome: "restore_mismatch" }
  | FenceRejection;

export type FailResumeInput = {
  fence: WorkerFence;
  now: Date;
  /** The pointer revision the restore verdict was reached on. */
  pointerRevision: number | null;
  error: { code: ApiErrorCode; message: string };
};
export type FailResumeResult =
  // `failed` when the session was still resuming from that pointer.
  { outcome: "ok"; failed: boolean } | FenceRejection;

/**
 * Which resource a caller saw go, told apart from any other built for the
 * same launch: the fingerprint of the bootstrap credential it was created
 * with (`launchNonceFingerprint`; null for none). Every create issues a new
 * credential before the resource exists and a claim keeps it, so the launch
 * row names its current incarnation before a worker can bind to it, and no
 * later write by a stale observer can put an old one back.
 *
 * A fingerprint read off the resource itself is that resource. One read off
 * the launch row is only what the row meant to run: a create may have issued
 * it and not yet built anything, so a caller that saw nothing also says
 * whether the launch was `claimed` — a worker that bound since is bound to
 * something the caller never saw.
 */
export type ExecutionIncarnation = {
  nonceFingerprint: string | null;
  claimed?: boolean;
};

export type ConfirmExecutionGoneInput = {
  executionId: string;
  now: Date;
  /**
   * Given, the confirmation holds only while the launch still names this
   * incarnation. A scheduler pass that lost its lock can have watched an old
   * resource go while another pass built a replacement a worker has since
   * bound; confirming that would hand back the new binding and its slot.
   * Left out, it speaks for the launch whatever it runs now, which only a
   * kill intent may.
   */
  incarnation?: ExecutionIncarnation;
  /** What the attempts it ends record; `execution_gone` when left out. */
  endReason?: string;
};
export type ConfirmExecutionGoneResult = {
  sessionReleased: boolean;
  slotReleased: boolean;
  /** Present when `incarnation` no longer matched; nothing was changed. */
  superseded?: true;
  /**
   * Present when a replacement is pending and nothing was changed: the
   * resource being gone is the rebuild in progress, not an exit.
   */
  deferred?: true;
};

export interface WorkerUnitOfWork {
  claimAtomic(input: ClaimInput): Promise<ClaimResult>;
  // Expiry is judged on the storage clock, so no caller time is taken.
  resolveCredential(tokenHash: Uint8Array): Promise<ResolvedCredential>;
  // The egress proxy's check, on every request: the token is live for this
  // purpose and its attempt holds the lease under the session's current
  // fence. The first one also closes the claim replay, like any other
  // accepted call.
  authorizeEgressAtomic(input: {
    tokenHash: Uint8Array;
    purpose: EgressPurpose;
  }): Promise<EgressAuthorization>;
  // Says on the session's stream why the proxy is cutting this attempt's
  // provider access: its model was taken off the profile's list. Written once
  // per attempt however many exchanges are refused; `recorded` is true only
  // for the call that wrote it, which is the one that may tell people.
  recordModelCutAtomic(input: {
    sessionId: string;
    attemptId: string;
    model: string;
    cause: ModelCutCause;
  }): Promise<{ recorded: boolean }>;
  // Adds a metered call's cost to its session, once per exchange id.
  recordProviderUsageAtomic(
    input: ProviderUsageInput,
  ): Promise<ProviderUsageResult>;
  nextInputAtomic(input: NextInputInput): Promise<NextInputResult>;
  heartbeatAtomic(input: HeartbeatInput): Promise<HeartbeatResult>;
  commitEventsAtomic(input: CommitEventsInput): Promise<CommitEventsResult>;
  // The same question finalizeAtomic answers, without committing anything:
  // it lets a caller settle a replay before doing work that can fail.
  peekFinalizeAtomic(input: FinalizeInput): Promise<PeekFinalizeResult>;
  finalizeAtomic(input: FinalizeInput): Promise<FinalizeResult>;
  // The fenced read behind the checkpoint protocol: proves the caller still
  // owns the session before a pointer is read on its behalf, and records the
  // runtime's durable refusal when it reports one.
  checkpointStateAtomic(
    input: CheckpointStateInput,
  ): Promise<CheckpointStateResult>;
  // Records which revision a restore plan hands the attempt, before the
  // plan is returned: a fallback is written to the session and announced on
  // its event stream, and a plan on the pointer clears an earlier fallback.
  recordRestoreBaseAtomic(input: RestoreBaseInput): Promise<RestoreBaseResult>;
  releaseAtomic(input: ReleaseInput): Promise<ReleaseResult>;
  // The attempt restored what its claim named and its engine loaded it.
  // For a `resuming` session that completes the resume: active, and the
  // resume receipt succeeds. Any other session is left as it is.
  readyAtomic(input: ReadyInput): Promise<ReadyResult>;
  // A restore verdict that refuses the checkpoint a resuming session was
  // resumed onto: recovery_required, and the resume receipt fails with it.
  failResumeAtomic(input: FailResumeInput): Promise<FailResumeResult>;
  // Called once the backend has observed the execution is gone; only then
  // does the session become claimable again and the launch slot return.
  confirmExecutionGoneAtomic(
    input: ConfirmExecutionGoneInput,
  ): Promise<ConfirmExecutionGoneResult>;
}
