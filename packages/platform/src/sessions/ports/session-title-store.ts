/**
 * Where a session's title came from. Only a `derived` one (cut from the
 * first message) is ever replaced by a generated one: a title the user gave
 * at create or set by rename is theirs.
 */
export type SessionTitleSource = "derived" | "user" | "generated";

// The one title request a session gets, recorded for the attempt whose first
// turn it summarizes, so its provider usage lands on that attempt.
export type TitleRequestIssue =
  | {
      outcome: "issued";
      // The first turn's message and the text it ended with, if any.
      message: string;
      result: string | null;
      profileId: string | null;
      profileFingerprint: string | null;
      model: string | null;
    }
  // The title is not derived, a request was already made, or the first turn
  // did not complete on this attempt.
  | { outcome: "skipped" };

export type TitleEgressAuthorization =
  | {
      outcome: "ok";
      sessionId: string;
      attemptId: string;
      profileId: string | null;
      profileFingerprint: string | null;
      model: string | null;
      costUsd: number;
      providerTokens: number;
    }
  // Unknown, already claimed, settled, expired, or the session's
  // authorization moved since.
  | { outcome: "invalid_token" };

export interface SessionTitleStore {
  issueAtomic(input: {
    sessionId: string;
    attemptId: string;
    tokenHash: Uint8Array;
    ttlMs: number;
  }): Promise<TitleRequestIssue>;
  authorizeAtomic(input: {
    tokenHash: Uint8Array;
  }): Promise<TitleEgressAuthorization>;
  // Ends the request; a title is written only while the session's is still
  // the derived one it was issued with, so a rename that landed first wins.
  settleAtomic(input: {
    tokenHash: Uint8Array;
    title: string | null;
    now: Date;
  }): Promise<{ outcome: "applied" | "kept" }>;
}
