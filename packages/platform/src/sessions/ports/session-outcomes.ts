import type {
  GitHubPullRequestOutcomeState,
  SessionGitHubRefusal,
  SessionOutcome,
  SessionOutcomeCheckError,
} from "@werft-ai/contracts";

/** A pull request outcome the refresher holds the lease of. */
export type ClaimedOutcome = {
  id: string;
  sessionId: string;
  repositoryId: string;
  number: number;
  state: GitHubPullRequestOutcomeState;
  leaseToken: string;
};

/** What one read of a claimed outcome found. */
export type OutcomeCheck =
  | {
      kind: "state";
      state: GitHubPullRequestOutcomeState;
      mergedAt: Date | null;
      closedAt: Date | null;
      metadata: {
        title: string;
        merge_commit_sha: string | null;
        additions: number | null;
        deletions: number | null;
        changed_files: number | null;
        commits: number | null;
      };
    }
  | { kind: "error"; checkError: SessionOutcomeCheckError }
  // No answer worth keeping (a rate limit): the lease goes, nothing else moves.
  | { kind: "release" };

export interface SessionOutcomeStore {
  /**
   * Writes the outcome of each pull_requests row a push request opened that
   * has none yet (one an earlier image opened). Returns how many.
   */
  fillMissing(limit: number): Promise<number>;
  /** The repositories with a pull request outcome due for a read and unleased. */
  dueRepositories(): Promise<string[]>;
  /**
   * In one transaction holding the quota row: resets a window older than an
   * hour, takes nothing while paused, then leases at most `max` and the
   * budget left of the due outcomes of `repositoryIds`, oldest check first,
   * adding how many to `used`.
   */
  claim(input: {
    quotaKey: string;
    repositoryIds: readonly string[];
    max: number;
    leaseMs: number;
  }): Promise<ClaimedOutcome[]>;
  /**
   * Writes the check under the lease, clearing it. False when the lease was
   * taken over meanwhile: a late answer never overwrites a newer one.
   */
  finish(outcome: ClaimedOutcome, check: OutcomeCheck): Promise<boolean>;
  /**
   * Writes `checkError` and the check time on at most `limit` due, unleased
   * outcomes of `repositoryIds`, state kept, for a repository no read can
   * reach (its App gone or uninstalled). Returns how many.
   */
  failDue(
    repositoryIds: readonly string[],
    checkError: SessionOutcomeCheckError,
    limit: number,
  ): Promise<number>;
  /** Keeps the last `x-ratelimit-limit` seen and, with `until`, pauses the unit. */
  noteRateLimit(
    quotaKey: string,
    input: { limit: number | null; pausedUntil: Date | null },
  ): Promise<void>;
  /** The session's outcomes, oldest first; null when the owner has no such session. */
  list(ownerId: string, sessionId: string): Promise<SessionOutcome[] | null>;
  /** The session's latest GitHub gate refusals, newest first; null as for list. */
  refusals(
    ownerId: string,
    sessionId: string,
    limit: number,
  ): Promise<SessionGitHubRefusal[] | null>;
}
