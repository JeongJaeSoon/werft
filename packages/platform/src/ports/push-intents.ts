import type {
  PushClass,
  PushIntent,
  PushIntentRefusal,
  ReceiptActor,
} from "@werft-ai/contracts";
import type { CreatePushRequestInput } from "./push-requests.ts";

export type CreatePushIntentInput = {
  ownerId: string;
  sessionId: string;
  /** The running turn the model asked in (`turns.id`). */
  turnId: number;
  attemptId: string;
  repositoryId: string;
  targetBranch: string;
  /**
   * Who asked. The runner makes the push request as this actor and holds no
   * more authority than the session's `session.read` / `session.submit`; it
   * never gains `session.approve`.
   */
  actor: ReceiptActor;
  /**
   * The class the push was recorded under when the model asked. Audit only:
   * the runner judges the push again with the policy of that moment.
   */
  pushClass: PushClass;
  /** `effectiveGitHubPolicy` source at that time, for the receipt. */
  policySource: string;
  /** The pull request content to open once pushed; the PR drain reads it. */
  pullRequest?: unknown;
  /**
   * The local branch whose commit the push carries; null or absent is the
   * checkpoint's snapshot (HEAD).
   */
  sourceRef?: string | null;
};

export type PushIntentWrite =
  | { outcome: "created" | "existing"; intent: PushIntent }
  /** The turn is no longer running: finalize already ended it. */
  | { outcome: "turn_not_running" }
  /**
   * Two intents of a turn would both mean the snapshot (HEAD): every intent
   * of a turn pins the same turn-end checkpoint, so each must name its own
   * source. `targetBranch` is the target that lacks one.
   */
  | { outcome: "source_ref_required"; targetBranch: string };

/** A pinned intent the runner holds under a lease. */
export type PushIntentJob = {
  id: string;
  ownerId: string;
  sessionId: string;
  repositoryId: string;
  targetBranch: string;
  pinnedRevision: number;
  /** The local branch to push, or null for the snapshot. */
  sourceRef: string | null;
  actor: ReceiptActor;
  pushClass: PushClass;
  pullRequest: unknown;
  /** Fences every write of this claim: a dropped claim writes nothing. */
  claimToken: string;
  /** closed or archived: the runner cancels instead of pushing. */
  sessionClosed: boolean;
};

export type PushIntentTransition =
  /** The push request exists and the intent is `requested`. */
  | { outcome: "requested"; pushRequestId: string }
  /** The same target is busy; the intent stays `pinned` for a later drain. */
  | { outcome: "waiting" }
  /** The intent ended without a request (`failed`/`cancelled`). */
  | { outcome: "ended"; code: string }
  /** The claim was lost: another runner or the finalize owns the row now. */
  | { outcome: "lost" };

/**
 * The control-host action-broker's record of "push what this turn ends with".
 * Lock order is session row first, then intent rows, everywhere: finalize,
 * creation and the runner's transition all take them in that order, so none
 * of them can deadlock with another.
 */
export interface PushIntentStore {
  /**
   * Writes a `deferred` intent for the turn, under the session row lock and
   * only while the turn still runs. The same turn, repository and target
   * again return the same row (`existing`), whatever its status; while it is
   * still `deferred`, a call that names a `sourceRef` sets it. A turn with
   * two intents needs a source on each (`source_ref_required` otherwise).
   */
  createDeferred(input: CreatePushIntentInput): Promise<PushIntentWrite>;
  list(ownerId: string, sessionId: string): Promise<PushIntent[]>;
  /**
   * Leases the oldest `pinned` intent no one holds (`FOR UPDATE SKIP
   * LOCKED`). A session that is paused, draining or in takeover is skipped
   * and left pinned; a closed one is returned for the runner to cancel.
   */
  claimNext(leaseMs: number): Promise<PushIntentJob | null>;
  /** Ends a claimed intent without a request. False when the claim is lost. */
  end(
    job: Pick<PushIntentJob, "id" | "claimToken">,
    status: "failed" | "cancelled",
    code: PushIntentRefusal,
  ): Promise<boolean>;
  /**
   * Cancels `deferred` intents that no running turn can pin any more: the
   * turn ended without finalize pinning them (a replica that did not know
   * intents) or the session closed. Returns how many it ended.
   */
  settleStale(): Promise<number>;
  /**
   * The one transaction that turns a claimed intent into a push request:
   * session row lock, then the intent row (status and claim token checked),
   * then the common create (same-target checks included). `input` is the
   * request to make; its origin is forced to `intent`.
   */
  transition(
    job: PushIntentJob,
    input: Omit<CreatePushRequestInput, "origin" | "idempotencyKey">,
  ): Promise<PushIntentTransition>;
}
