import type {
  DeciderKey,
  ParkDeclinedRequest,
  ParkedDelivery,
  PendingQuestion,
  PendingRequest,
  PendingSettlement,
  PostSessionAnswerRequest,
  PostSessionAnswerResponse,
  RegisterPendingRequest,
  SurfaceKind,
} from "@werft-ai/contracts";
import type { RuntimeFingerprint } from "@werft-ai/runtime-core";
import type { Principal } from "../../musterrolle/index.ts";
import type {
  FenceRejection,
  WorkerFence,
} from "../../ports/worker-unit-of-work.ts";

export type AnswerRequestInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  answer: PostSessionAnswerRequest;
  // What the approval row keeps besides the principal: where the answer
  // came from and the session.approve decision that let it through.
  approval: { surface: SurfaceKind; decisionId: string };
};

export type AnswerRequestResult =
  | { outcome: "accepted" | "replayed"; response: PostSessionAnswerResponse }
  | { outcome: "conflict" | "not_found" }
  // Already answered, given up on by the worker, or past its expiry.
  | { outcome: "expired" }
  // The attempt that asked no longer owns the session, so its callback is
  // gone even if the row is still open.
  | { outcome: "stale" }
  // The answer names something the request never offered.
  | { outcome: "invalid"; reason: string }
  // A parked request whose session could not be resumed from it: refused
  // before the answer is kept, so no group is left closed on a session
  // that cannot carry it on.
  | { outcome: "recovery_required"; unconfirmedTurnId: string | null }
  | { outcome: "checkpoint_unavailable" }
  // GC holds a claim on the parked session's workspace: refused before the
  // answer is kept, so the resume it may start never mounts a volume being
  // removed. The same request goes through once the claim settles.
  | { outcome: "workspace_reclaiming" }
  // Re-judged inside the write: the requester is gone, or no longer answers
  // for this session.
  | { outcome: "actor_inactive" | "role" };

export type PendingRequestOutcome =
  | { state: "open" | "closed"; kind: "permission" | "question" }
  | { state: "answered"; kind: "question" }
  | {
      state: "answered";
      kind: "permission";
      decision: "allow" | "deny";
      remember?: "session";
    };

/**
 * What a tool's input points at, read from the platform's own rows: the
 * repository's catalog name and the branch. A GitHub tool's input carries
 * only ids, so a card has nothing readable to show without it.
 */
export type ToolSummaryContext = { repository?: string; branch?: string };

/**
 * A request as a card shows it, settled or not. The input is the stored
 * one, already redacted for display. A typed answer is never here: only
 * whether there was one, since the card is read by the whole thread.
 */
export type PendingRequestDisplay = (
  | {
      kind: "permission";
      tool: string;
      input: unknown;
      context: ToolSummaryContext;
    }
  | {
      kind: "question";
      questions: PendingQuestion[];
      answers: {
        question_id: string;
        selected_option_ids: string[];
        typed: boolean;
      }[];
    }
) & {
  state: "open" | "answered" | "closed";
  decision: "allow" | "deny" | null;
  /** The allow was also kept for the session; absent or null, it was not. */
  remember?: "session" | null;
  decidedByUserId: string | null;
  /** Why a request no one answered closed. */
  closedReason: "expired" | "session_closed" | "stale" | null;
  createdAt: string;
  expiresAt: string;
};

export interface PendingRequestDisplayReader {
  /** The request for display; null outside the owner's sessions. */
  displayOf(
    ownerId: string,
    sessionId: string,
    requestId: string,
  ): Promise<PendingRequestDisplay | null>;
}

/** The public half: what clients see and how they answer it. */
export interface PendingRequestStore {
  // null when the session is not visible to the owner.
  listOpen(
    ownerId: string,
    sessionId: string,
  ): Promise<PendingRequest[] | null>;
  answerAtomic(input: AnswerRequestInput): Promise<AnswerRequestResult>;
  /**
   * Where one request stands: `open` while a client can still answer it,
   * `answered` with how a permission was answered, else `closed` (expired,
   * withdrawn or invalidated). Null when the session or request is unknown.
   */
  requestOutcome(
    ownerId: string,
    sessionId: string,
    requestId: string,
  ): Promise<PendingRequestOutcome | null>;
  /**
   * Writes the failed `answer` receipt of a key refused for answering the
   * session it started (GA-8) and returns its id.
   */
  recordSelfApproval(input: {
    principal: Principal;
    sessionId: string;
    requestId: string;
    deciderKey: DeciderKey | null;
  }): Promise<string>;
}

export type RegisterPendingInput = {
  fence: WorkerFence;
  turnId: string;
  requestId: string;
  inputHash: string;
  request: RegisterPendingRequest["request"];
  // Present: the store writes the `question` event with the row.
  announce?: RegisterPendingRequest["announce"];
  // A lifetime on the storage clock, never a caller deadline.
  ttlMs: number;
  // The approval-wait checkpoint taken while the engine waits on this
  // request, already verified like a finalize's.
  checkpoint?: ApprovalCheckpointCommit;
  // Why it waits without one the worker tried to take: a new row records
  // the `approval_checkpoint_failed` event with it.
  checkpointFailure?: RegisterPendingRequest["checkpoint_failure"];
};

export type ApprovalCheckpointCommit = {
  revision: number;
  manifestRef: string;
  manifestSha256: string;
  manifestVersion?: string;
  versionsHeld: boolean;
  transcriptBytes?: number;
  runtime?: RuntimeFingerprint;
  answersThrough: number;
};

export type RegisterPendingResult =
  | {
      outcome: "registered" | "replayed";
      expiresAt: Date;
      expiresInMs: number;
    }
  | { outcome: "turn_not_found" }
  // The turn has an interrupt waiting on it: nothing new may hold it open.
  | { outcome: "turn_interrupted" }
  // The id is taken by a different request, or by this one after it closed.
  | { outcome: "conflict" }
  | FenceRejection;

export type DeliveredAnswer = {
  sequence: number;
  answer: PostSessionAnswerRequest;
  inputHash: string;
  answerSurface?: SurfaceKind | null;
};

export type PendingControlInput = {
  fence: WorkerFence;
  answersAfter: number;
  settled: PendingSettlement[];
  // How parked answers reached the turn this attempt carries on with.
  delivered?: ParkedDelivery[];
};

/**
 * A control intent the attempt owes an answer to. An interrupt names its
 * turn (the public turn id); a pause names none: it asks the attempt to
 * finish the one it has and take no other, and its id is the pause receipt's.
 * A park is the platform's pause for a turn left waiting on its requests,
 * and stops that turn where it waits.
 */
export type DeliveredControl =
  | { controlId: string; kind: "interrupt"; turnId: string; issuedAt: Date }
  | { controlId: string; kind: "pause" | "park"; turnId: null; issuedAt: Date };

export type ParkDeclinedInput = {
  fence: WorkerFence;
  pauseControlId: string;
  reason: ParkDeclinedRequest["reason"];
};

// `reverted`: the park was the open pause and the session is active again.
export type ParkDeclinedResult =
  | { outcome: "ok"; reverted: boolean }
  | FenceRejection;

export type RequestParkInput = {
  fence: WorkerFence;
  // The public turn id the worker is parking.
  turnId: string;
};

// `refused`: the session is not one this park may pause (a person's pause,
// a close, another state), or the turn has nothing left that only a person
// can end: no open request, or an answer the worker has not settled yet.
export type RequestParkResult =
  | { outcome: "ok"; pauseControlId: string }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: string }
  | FenceRejection;

export type InvalidateApprovalCheckpointInput = {
  fence: WorkerFence;
  manifestRef: string;
};

// `invalidated` is false when this attempt committed no such checkpoint.
export type InvalidateApprovalCheckpointResult =
  | { outcome: "ok"; invalidated: boolean }
  | FenceRejection;

export type PendingControlResult =
  | {
      outcome: "ok";
      answers: DeliveredAnswer[];
      control: DeliveredControl | null;
    }
  | FenceRejection;

/** The worker half, fenced like every other post-claim call. */
export interface WorkerPendingStore {
  registerAtomic(input: RegisterPendingInput): Promise<RegisterPendingResult>;
  pendingControlAtomic(
    input: PendingControlInput,
  ): Promise<PendingControlResult>;
  parkDeclinedAtomic(input: ParkDeclinedInput): Promise<ParkDeclinedResult>;
  requestParkAtomic(input: RequestParkInput): Promise<RequestParkResult>;
  invalidateApprovalCheckpointAtomic(
    input: InvalidateApprovalCheckpointInput,
  ): Promise<InvalidateApprovalCheckpointResult>;
  // A hint for heartbeat: an answer or a control intent is waiting for this
  // attempt to take it.
  hasUndelivered(fence: WorkerFence): Promise<boolean>;
}
