import type {
  OpenPullRequestRequest,
  PullRequestTemplateRecord,
} from "@werft-ai/contracts";

/**
 * Why a push request's pull request stage ended without a recorded pull
 * request, or what the stage wants to be asked about again. Public: it lands
 * in `push_requests.pr_error`, the receipts and the notices.
 */
export const PULL_REQUEST_STAGE_ERRORS = [
  // The branch no longer points at the commit that was pushed.
  "head_moved",
  // A pull request carrying this request's marker was closed or merged
  // before the platform recorded it.
  "closed_unrecorded",
  // Two pull requests (or a recorded one and a new one) fit the request.
  "duplicate_pull_request",
  "catalog_changed",
  "target_refused",
  "github_refused",
  "no_forge",
  "forge_failed",
  // The forge could not be asked whether a pull request already exists, or
  // an answer to a create never arrived; the platform does not guess.
  "lookup_failed",
  "lease_expired",
  "intent_invalid",
] as const;
export type PullRequestStageError = (typeof PULL_REQUEST_STAGE_ERRORS)[number];

/** Claims of one stage before an unclear outcome is left `uncertain`. */
export const PULL_REQUEST_MAX_ATTEMPTS = 3;

/** How long a failed attempt waits before the next claim. */
export function pullRequestBackoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** Math.max(attempt - 1, 0), 15 * 60_000);
}

/** A claimed push request whose pull request is due. */
export type PullRequestJob = {
  id: string;
  ownerId: string;
  sessionId: string;
  repositoryId: string;
  /** Null on a request made before the binding was pinned. */
  repositoryBinding: string | null;
  targetBranch: string;
  gitCommit: string;
  /** What the agent asked the pull request to say; null when it said nothing. */
  intent: OpenPullRequestRequest | null;
  /** Fences every write of this claim; a later claim has another token. */
  claimToken: string;
  /** Claims of this stage so far, this one included. */
  attempt: number;
  /** When this claim's lease ends, by the database's clock. */
  leaseExpiresAt: Date;
};

export type OpenedPullRequest = {
  number: number;
  url: string;
  head: string;
  base: string;
  /** The commit the head branch pointed at when the forge answered. */
  headSha: string;
  /** The title the platform sent; null for one it did not create. */
  title: string | null;
  /** False for a pull request the platform found instead of creating. */
  created: boolean;
  /** How the body was laid out; null for a pull request the platform did not create. */
  template?: PullRequestTemplateRecord | null | undefined;
};

export type PullRequestDrainOutcome =
  | { kind: "opened"; pullRequest: OpenedPullRequest }
  // Ask again later; the claim is given back.
  | { kind: "retry"; error: PullRequestStageError; delayMs: number }
  | {
      kind: "stop";
      stage: "failed" | "closed_unrecorded" | "uncertain" | "cancelled";
      error: PullRequestStageError;
      details?: Readonly<Record<string, unknown>>;
    };

export type PullRequestSettled =
  | { result: "fenced" }
  | { result: "settled" }
  /**
   * The push request already has a different pull request on record; the
   * stage ended `uncertain` with both on its details.
   */
  | {
      result: "duplicate";
      recorded: { number: number; url: string };
    };

export interface PullRequestDrainStore {
  /**
   * Takes the oldest due push request (or an `opening` one whose lease
   * lapsed), counts the attempt and starts the lease. Null when none is
   * waiting.
   */
  claimNextDue(leaseMs: number): Promise<PullRequestJob | null>;
  /**
   * Ends or returns the claim. Every write is conditioned on the job's
   * token while the row is `opening`; a claim that was taken over writes
   * nothing and answers `fenced`.
   */
  settle(
    job: PullRequestJob,
    outcome: PullRequestDrainOutcome,
  ): Promise<PullRequestSettled>;
}
