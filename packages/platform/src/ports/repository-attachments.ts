import type {
  AgentGitHub,
  ApiErrorCode,
  ReceiptActor,
  RepositoryAttachFailure,
  RepositoryAttachResult,
} from "@werft-ai/contracts";
import type { FenceRejection, WorkerFence } from "./worker-unit-of-work.ts";

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
   * row's receipt, changes nothing, so a resent one is safe.
   */
  settle(sessionId: string, results: RepositoryAttachResult[]): Promise<void>;
}

/**
 * The commit a session first fetched each attached repository at, by
 * repository id. Written once: a later pin of the same repository keeps the
 * first commit.
 */
export interface RepositoryPinStore {
  list(sessionId: string): Promise<Map<string, string>>;
  /**
   * Pins what is not pinned yet and answers the kept commit of each one
   * asked, in the same transaction that holds the fence: a pin outlives the
   * attempt, so only the session's owner writes one.
   */
  pin(
    fence: WorkerFence,
    pins: ReadonlyArray<{ repositoryId: string; commit: string }>,
  ): Promise<{ outcome: "ok"; pins: Map<string, string> } | FenceRejection>;
}
