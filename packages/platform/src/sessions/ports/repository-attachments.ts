import type {
  AgentGitHub,
  ApiErrorCode,
  ReceiptActor,
  RepositoryAttachFailure,
  RepositoryAttachResult,
} from "@werft-ai/contracts";
import type {
  FenceRejection,
  WorkerFence,
} from "../../ports/worker-unit-of-work.ts";

/** One repository the agent attached mid-session, as its row stands. */
export type RepositoryAttachmentRow = {
  repositoryId: string;
  attemptId: string;
  branch: string;
  status: "pending" | "attached" | "failed";
  commit: string | null;
  failure: RepositoryAttachFailure | null;
  receiptId: string;
};

export type RepositoryAttachmentRequest = {
  ownerId: string;
  sessionId: string;
  attemptId: string;
  repositoryId: string;
  branch: string;
  actor: ReceiptActor;
  /** The receipt's `result` as accepted; the worker's report fills the rest. */
  result: Record<string, unknown>;
};

export type RepositoryAttachmentOutcome =
  /** The attempt has ended, or is not this session's. */
  | { outcome: "attempt_ended" }
  | { outcome: "requested"; row: RepositoryAttachmentRow }
  /** Already attached or still being fetched: nothing changed. */
  | { outcome: "unchanged"; row: RepositoryAttachmentRow }
  /**
   * On the session's list with no row: chosen at the start, or a null list
   * (the release's whole list). Every claim fetches it already.
   */
  | { outcome: "preattached" };

export type RepositoryAttachmentRefusal = {
  ownerId: string;
  sessionId: string;
  actor: ReceiptActor;
  result: Record<string, unknown>;
  error: { code: ApiErrorCode; message: string };
};

export interface RepositoryAttachmentStore {
  /**
   * In one transaction with the session row locked: refuses an ended
   * attempt, answers a pending or attached row unchanged, a repository on
   * the list without a row preattached, and otherwise
   * writes the accepted receipt, the row (back to pending for a failed one)
   * and the repository onto the session's attached list when it has one.
   */
  request(
    input: RepositoryAttachmentRequest,
  ): Promise<RepositoryAttachmentOutcome>;
  find(
    sessionId: string,
    repositoryId: string,
  ): Promise<RepositoryAttachmentRow | null>;
  recordRefusal(input: RepositoryAttachmentRefusal): Promise<string>;
  /** Every row of the session, oldest first. */
  list(sessionId: string): Promise<RepositoryAttachmentRow[]>;
  /**
   * The GitHub settings of the active release of the agent
   * whose release the session runs, in one read; null without one. Read
   * only to tell a repository allowed in a newer release apart: the session
   * keeps its own.
   */
  activeRelease(sessionId: string): Promise<{
    id: string;
    github: AgentGitHub | "invalid" | null;
  } | null>;
  /** The session's pending rows, oldest first. */
  pending(sessionId: string): Promise<RepositoryAttachmentRow[]>;
  /**
   * Settles pending rows from a worker's reports and their receipts; a
   * failed fetch also takes the repository off the attached list, and a
   * fetched one pins its commit unless the session has pinned one already.
   * A report for a row no longer pending, or for an earlier request than the
   * row's receipt, changes nothing, so a resent one is safe. Each report is
   * settled under the reporting attempt's fence; once it no longer holds,
   * the rest are left pending for the attempt that owns the session.
   */
  settle(
    fence: WorkerFence,
    results: RepositoryAttachResult[],
  ): Promise<{ outcome: "ok" } | FenceRejection>;
}

/** A repository and a commit of it, as a pin or a failure names them. */
export type RepositoryPin = { repositoryId: string; commit: string };

/**
 * The commit a session first fetched each attached repository at, by
 * repository id. Written once: a later pin of the same repository keeps the
 * first commit. A pin a worker could not fetch again stays as a restore
 * failure until the agent attaches the repository anew.
 */
export interface RepositoryPinStore {
  /** The pins still in force, restore failures left out. */
  list(sessionId: string): Promise<Map<string, string>>;
  /** The pins a worker could not fetch again, with the commit each named. */
  restoreFailures(sessionId: string): Promise<Map<string, string>>;
  /**
   * Pins what is not pinned yet and answers the kept commit of each one
   * asked, in the same transaction that holds the fence: a pin outlives the
   * attempt, so only the session's owner writes one. Each restore failure
   * marks its pin when the commit is still the pin's and records the
   * session's `repository_restore_failed` event, both once.
   */
  pin(
    fence: WorkerFence,
    pins: ReadonlyArray<RepositoryPin>,
    restoreFailed?: ReadonlyArray<RepositoryPin>,
  ): Promise<{ outcome: "ok"; pins: Map<string, string> } | FenceRejection>;
}
