import type { AttributionExpectation } from "@werft-ai/runtime-core";

/**
 * What each claim of a session asked its commits to carry. A push is checked
 * against all of a session's bundles (any one passes a commit), so the values
 * the server issued, not what a worker reports, decide.
 */
export interface CommitAttributionLedger {
  /** Idempotent: the same bundle twice is one row. */
  record(sessionId: string, expectation: AttributionExpectation): Promise<void>;
  /**
   * A turn's requester as co-author (or none): each author and `Agent-Session`
   * the session was already issued, with this co-author. Idempotent. The
   * ledger is per session, so it does not prove a commit is that turn's.
   */
  recordTurnCoAuthor(
    sessionId: string,
    coAuthor: { name: string; email: string } | null,
  ): Promise<void>;
  list(sessionId: string): Promise<AttributionExpectation[]>;
}
