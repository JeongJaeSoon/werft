import type {
  AdmissionState,
  ControlAcceptedResponse,
  RecoveryDecisionRequest,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

export type TerminateSessionInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  expectedRevision: number;
  reason: string | null;
  now: Date;
};

export type TerminateSessionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  // expected_revision does not match the row: the caller decided on a
  // state it no longer sees.
  | { outcome: "revision_conflict"; currentRevision: number }
  // A closed session has nothing left to terminate.
  | { outcome: "rejected"; admissionState: Extract<AdmissionState, "closed"> }
  // Bound through the legacy pod lifecycle, which has no kill path; the
  // command is refused rather than accepted on a promise nothing can keep.
  | { outcome: "unsupported" };

export type RecoveryDecisionInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  decision: RecoveryDecisionRequest;
  now: Date;
};

export type RecoveryDecisionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  | { outcome: "revision_conflict"; currentRevision: number }
  // A closed session takes no further decision.
  | { outcome: "rejected"; admissionState: Extract<AdmissionState, "closed"> }
  // abandon/confirm_completed while the previous execution is not yet
  // confirmed gone: the decision would race the exit observation.
  | { outcome: "execution_unconfirmed" }
  // The target turn is not one awaiting a decision; null when the session
  // has no such turn at all.
  | { outcome: "turn_not_unknown"; turnStatus: string | null }
  // Legacy pod binding: no execution to confirm gone, no kill path.
  | { outcome: "unsupported" }
  // confirm_completed with no trusted committed checkpoint that reaches the target
  // turn: the session could only resume from a state that lacks the work
  // being confirmed, so the decision is refused (abandon or close instead).
  | { outcome: "checkpoint_not_covering" }
  // close through recovery-decisions on a session with nothing to recover:
  // it is the operator's answer to an unknown outcome, a pending kill or a
  // session left without a restorable checkpoint, not an ordinary close
  // (interface-drafts dd-dispatch § 8.3).
  | { outcome: "not_in_recovery"; admissionState: AdmissionState }
  // start_fresh or retry_restore over a turn whose outcome is still
  // unknown: abandon or confirm_completed settles it first.
  | { outcome: "unknown_turn_left"; turnId: string }
  // start_fresh or retry_restore on a session whose workspace GC has
  // claimed and not yet settled, as for resume.
  | { outcome: "workspace_reclaiming" }
  // start_fresh on a session that cannot go live under an authoritative
  // spec pin, as for resume.
  | { outcome: "pin_required" }
  // start_fresh or retry_restore on a session whose execution authority an
  // operator revoked; only the operator's restore lifts it.
  | { outcome: "execution_revoked" }
  // retry_restore on a session its failed restores did not stop: restoring
  // the same checkpoint again answers nothing else.
  | { outcome: "not_restore_failed"; admissionState: AdmissionState };

export type PauseSessionInput = TerminateSessionInput;

export type PauseSessionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  | { outcome: "revision_conflict"; currentRevision: number }
  // Only an active session pauses; every other state keeps its own answer.
  | { outcome: "rejected"; admissionState: Exclude<AdmissionState, "active"> }
  // Nothing is running, so nothing will ever checkpoint, and the committed
  // one does not reach the last turn that ran (or a blocker leaves it
  // untrusted): pausing now would promise a restore point that is not there.
  | { outcome: "checkpoint_unavailable" }
  // Legacy pod binding, as for terminate.
  | { outcome: "unsupported" };

export type CloseSessionInput = TerminateSessionInput;

export type CloseSessionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  | { outcome: "revision_conflict"; currentRevision: number }
  // active, paused and a resumable stopped close; every other state keeps
  // its own answer.
  | {
      outcome: "rejected";
      admissionState: Exclude<
        AdmissionState,
        "active" | "paused" | "stopped" | "recovery_required"
      >;
    }
  // recovery_required, or a stopped session that cannot be resumed: a
  // recovery close is the way to end it.
  | { outcome: "recovery_required" }
  // Nothing is left to drain and no trusted checkpoint covers the last turn
  // that ran, so the close would end the session on work it cannot show.
  | { outcome: "checkpoint_unavailable" }
  // Legacy pod binding, as for terminate.
  | { outcome: "unsupported" };

export type ResumeSessionInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  expectedRevision: number;
  now: Date;
};

export type ResumeSessionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  | { outcome: "revision_conflict"; currentRevision: number }
  // Nothing to resume from: closed, still active, or already resuming.
  | {
      outcome: "rejected";
      admissionState: Exclude<
        AdmissionState,
        "stopped" | "stopping" | "recovery_required" | "paused" | "pausing"
      >;
    }
  // A pause whose stop intent is written (or whose drainer is gone) can no
  // longer be cancelled; it settles `paused` and is resumed from there.
  | { outcome: "pause_committing" }
  // An unknown turn or an unconfirmed exit still needs an operator.
  | { outcome: "recovery_required"; unconfirmedTurnId: string | null }
  // No committed checkpoint to restore; the client closes or starts anew.
  // No committed checkpoint, or one a durable checkpoint blocker leaves
  // untrusted (checkpoint_pending_reason).
  | { outcome: "checkpoint_unavailable" }
  // Legacy pod binding, as for terminate.
  | { outcome: "unsupported" }
  // GC has claimed the stopped session's workspace and not yet settled the
  // removal; the same request succeeds once it has.
  | { outcome: "workspace_reclaiming" }
  // The spec pin is authoritative and the session has no release or no pin
  // on its own model, so it cannot go live again; retrying changes nothing.
  | { outcome: "pin_required" }
  // An operator revoked the session's execution authority.
  | { outcome: "execution_revoked" }
  // The parked turn still waits on requests nobody answered and that have
  // not expired.
  | { outcome: "pending_requests_open"; waitingFor: number };

// The states a profile change is accepted in: nothing is on its way in or
// out. A pausing or resuming session settles first.
export const PROFILE_CHANGE_ADMISSION_STATES = [
  "active",
  "paused",
  "stopped",
] as const satisfies readonly AdmissionState[];

export type ChangeProfileInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  expectedRevision: number;
  // Judged against the catalog for the session's repository and its
  // profile `judgedFrom`; null when the catalog refuses it, which is
  // answered only after a replay of the same key has been.
  profile: {
    id: string;
    fingerprint: string;
    // The new profile's default, which the session runs from the change on.
    model: string;
    unmetered: boolean;
  } | null;
  // The session's profile the judgement was made against; another one under
  // the lock means the session moved since it was read.
  judgedFrom: string | null;
  now: Date;
};

export type RenameSessionInput = {
  principal: Principal;
  sessionId: string;
  // Already normalised (normalizeSessionTitle).
  title: string;
  now: Date;
};

export type RenameSessionResult =
  | { outcome: "not_found" }
  | { outcome: "actor_inactive" }
  | { outcome: "renamed"; changed: boolean };

export type ChangeProfileResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  | { outcome: "revision_conflict"; currentRevision: number }
  | {
      outcome: "rejected";
      admissionState: Exclude<
        AdmissionState,
        (typeof PROFILE_CHANGE_ADMISSION_STATES)[number]
      >;
    }
  // The session belongs to an agent release, whose profile it runs.
  | { outcome: "release_bound"; releaseId: string }
  // `billing: none` on one side only: the session's cost limit would start
  // or stop applying mid-session, so the change is refused.
  | { outcome: "billing_mismatch" }
  // The catalog refused the profile for this session (input.profile null).
  | { outcome: "unsupported" };

/**
 * api.md § 승인·중단·강제 종료: the terminate transaction blocks dispatch,
 * discards the epoch, cancels queued input, invalidates pending requests and
 * records the generation-specific kill intent. The kill itself happens
 * outside, and the receipt only succeeds once the execution is seen gone.
 */
export interface SessionControl {
  terminateAtomic(
    input: TerminateSessionInput,
  ): Promise<TerminateSessionResult>;
  /**
   * api.md § 일시 중지와 저장 상태: admission goes pausing and the bound
   * worker is asked to drain. Queued input and open questions stay. The
   * receipt succeeds only once the execution is seen gone with a committed
   * checkpoint covering every turn that ran.
   */
  pauseAtomic(input: PauseSessionInput): Promise<PauseSessionResult>;
  /**
   * The owner's ordinary close. A bound worker drains as for a pause and the
   * session goes `closing`; it is `closed` once the execution is seen gone
   * with a checkpoint covering every turn that ran. A session with nothing
   * left to drain is closed in this transaction. Queued input is cancelled
   * in the transaction that closes the session.
   */
  closeAtomic(input: CloseSessionInput): Promise<CloseSessionResult>;
  /**
   * api.md § 최소 운영 복구: abandon, confirm_completed or close, decided
   * under the session lock against the operator's expected_revision, with
   * the receipt and audit event in the same transaction. No decision
   * dispatches anything: the operator resumes explicitly afterwards.
   */
  decideRecoveryAtomic(
    input: RecoveryDecisionInput,
  ): Promise<RecoveryDecisionResult>;
  /**
   * Resume from `stopped`: the session admits input again and, if input is
   * queued, is signalled for a new worker that restores the committed
   * checkpoint. Input cancelled by terminate stays cancelled.
   *
   * From `paused`: the session goes `resuming` and the receipt
   * stays accepted until the new worker reports it restored the checkpoint
   * (WorkerUnitOfWork.readyAtomic). From `pausing`, while the drainer still
   * holds the session and no stop intent is written, the pause is cancelled
   * instead and the session is active again with the same worker.
   */
  resumeAtomic(input: ResumeSessionInput): Promise<ResumeSessionResult>;
  /**
   * Moves the session onto another profile, effective at its next claim:
   * the bound attempt, if any, finishes the turn it holds on its own
   * profile and is handed no more input. Settles at once.
   */
  changeProfileAtomic(input: ChangeProfileInput): Promise<ChangeProfileResult>;
  /**
   * Sets the title in any admission state and, when it changed, writes a
   * `status` event carrying it. Neither the revision nor a receipt moves:
   * a name is no control.
   */
  renameAtomic(input: RenameSessionInput): Promise<RenameSessionResult>;
}
