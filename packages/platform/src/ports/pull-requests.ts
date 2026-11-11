import type {
  ApiErrorCode,
  PullRequest,
  PullRequestReceiptResult,
  PullRequestRefusal,
  PullRequestStage,
  PullRequestTemplateRecord,
  PushRequestState,
  ReceiptActor,
} from "@werft-ai/contracts";
import { GITHUB_SETTINGS_UNSUPPORTED } from "../github/ports/github-settings.ts";

/** What every refused pull request operation answers, and its receipt records. */
export const PULL_REQUEST_REFUSAL_ERRORS: Record<
  PullRequestRefusal,
  { code: ApiErrorCode; message: string }
> = {
  missing_scope: {
    code: "FORBIDDEN",
    message: "This credential does not hold sessions:approve",
  },
  unverified_principal: {
    code: "FORBIDDEN",
    message:
      "A pull request needs a verified human credential: an API key or a signed-in user",
  },
  not_found: { code: "NOT_FOUND", message: "Resource not found" },
  not_pushed: {
    code: "PUSH_NOT_PUSHED",
    message: "The push request has not been pushed",
  },
  catalog_changed: {
    code: "CATALOG_MISMATCH",
    message:
      "The catalog entry for the repository changed after the push request pinned it",
  },
  no_forge: {
    code: "FORBIDDEN",
    message:
      "The repository has no GitHub credential to open pull requests with",
  },
  no_pull_request: {
    code: "PULL_REQUEST_MISSING",
    message: "No pull request was opened from this push request",
  },
  forge_failed: {
    code: "BACKEND_UNAVAILABLE",
    message: "The repository host did not take the call",
  },
  github_settings_unsupported: GITHUB_SETTINGS_UNSUPPORTED,
  github_refused: {
    code: "GITHUB_REFUSED",
    message: "The GitHub gate refused the pull request",
  },
  pull_request_merged: {
    code: "PULL_REQUEST_MERGED",
    message: "The pull request was merged; it cannot be closed or reopened",
  },
  merge_blocked: {
    code: "PULL_REQUEST_MERGE_BLOCKED",
    message: "GitHub will not merge the pull request now",
  },
  pull_request_closed: {
    code: "PULL_REQUEST_CLOSED",
    message: "The pull request was closed without being merged",
  },
  superseded: {
    code: "PUSH_REQUEST_RESOLVED",
    message:
      "A later push request to the same target exists; attach the pull request content to it",
  },
  intent_ended: {
    code: "PUSH_REQUEST_RESOLVED",
    message: "The push intent ended before it became a push request",
  },
  head_moved: {
    code: "PUSH_REQUEST_RESOLVED",
    message:
      "The branch's open pull request holds another commit than this push request; it was not adopted",
  },
};

export type PullRequestOperation =
  | "open_pull_request"
  | "update_pull_request"
  | "comment_pull_request"
  | "close_pull_request"
  | "reopen_pull_request"
  | "merge_pull_request";

/** The push request a pull request is opened from, as stored. */
export type PullRequestSource = {
  id: string;
  sessionId: string;
  repositoryId: string;
  /** Null on a request made before the binding was pinned. */
  repositoryBinding: string | null;
  state: PushRequestState;
  targetBranch: string;
  gitCommit: string;
  /** The pull request stage, `failed` with `head_moved` being final. */
  prState: PullRequestStage | null;
  prError: string | null;
  prErrorDetails: Record<string, unknown> | null;
};

/** What a pull request is scheduled against: one id, never both. */
export type ScheduleRef =
  | { pushRequestId: string; pushIntentId?: undefined }
  | { pushIntentId: string; pushRequestId?: undefined };

export type ScheduleOutcome =
  /** The content is held; the drain opens the pull request after the push. */
  | {
      kind: "scheduled";
      pushRequestId: string | null;
      pushIntentId: string | null;
      /** Written in the transaction that held the content. */
      receiptId: string;
    }
  /**
   * The push request is past scheduling (a pull request is recorded, or its
   * stage ended); the caller answers through the open path, which also
   * retries a failed stage on an explicit call.
   */
  | { kind: "open_now"; pushRequestId: string }
  | {
      kind: "refused";
      refusal: PullRequestRefusal;
      /** Set for `not_pushed`, so the caller can tell rejected from failed. */
      pushRequestState?: PushRequestState;
      details?: Readonly<Record<string, unknown>>;
    };

export type PullRequestReceipt = {
  ownerId: string;
  sessionId: string;
  pushRequestId: string;
  /** Null for the pull request drain, which acts for no caller. */
  actor: ReceiptActor | null;
  operation: PullRequestOperation;
  result: PullRequestReceiptResult;
};

export interface PullRequestStore {
  /**
   * Holds `content` for a pull request that cannot be opened yet, in one
   * transaction that takes the session row, then the intent, then the push
   * request. `create`, `finish` and the drain's settle take the session
   * first too. `claimNextApproved` and the drain's claim lock a request row
   * alone; the claim takes the session after it only to fail an invalid
   * intent, and then with SKIP LOCKED, never waiting. A new writer must not
   * wait for a session lock while holding a request row. The first content stays: a second
   * call answers `scheduled` and changes nothing, and no call moves a
   * finished stage back. An already `pushed` request with no stage becomes
   * `due` here. A later request to the same repository and target refuses
   * `superseded`, judged by `created_at` under the session lock. The
   * `scheduled` receipt is written in the same transaction; a refusal or
   * `open_now` writes none (the caller does).
   */
  schedule(input: {
    ownerId: string;
    sessionId: string;
    ref: ScheduleRef;
    content: unknown;
    actor: ReceiptActor | null;
  }): Promise<ScheduleOutcome>;
  /** null when the owner has no such push request in the session. */
  findSource(
    ownerId: string,
    sessionId: string,
    pushRequestId: string,
  ): Promise<PullRequestSource | null>;
  findPullRequest(
    ownerId: string,
    pushRequestId: string,
  ): Promise<PullRequest | null>;
  /**
   * The latest pull request recorded for the session's branch in this
   * repository, whichever of its push requests opened it.
   */
  findBranchPullRequest(
    ownerId: string,
    sessionId: string,
    repositoryId: string,
    head: string,
  ): Promise<PullRequest | null>;
  /**
   * Writes the receipt and returns its id: `failed` with the refusal's
   * error when `result.refusal` is set, `succeeded` otherwise.
   */
  recordReceipt(
    input: Omit<PullRequestReceipt, "pushRequestId"> & {
      // Null for a refusal on a push intent that has no push request yet.
      pushRequestId: string | null;
    },
  ): Promise<string>;
  /**
   * The receipt of a close or reopen GitHub took, and in the same
   * transaction the session's outcome for `url` made due for the
   * refresher's next read: it no longer reads one closed over 30 days ago.
   */
  recordStateChange(
    input: PullRequestReceipt & { url: string },
  ): Promise<string>;
  /**
   * Ends the pull request stage as `failed` with `head_moved`, keeping the
   * pull request the call made on a moved head (`number`, `url`) in the
   * details: the open path then refuses without asking the forge, so a person
   * closing that pull request cannot make a retry create another. Does
   * nothing when a pull request is recorded.
   */
  failHeadMoved(input: {
    ownerId: string;
    pushRequestId: string;
    details: Record<string, unknown>;
  }): Promise<void>;
  /**
   * Records the pull request opened from the push request, with its
   * `open_pull_request` receipt. When one is already recorded (a racing
   * call), keeps that one and the receipt says `created: false`. The first
   * write of a pull request writes its `github_pull_request` outcome in the
   * same transaction; `created: false` (the forge answered one it did not
   * make) marks that outcome adopted.
   */
  savePullRequest(
    input: Omit<PullRequestReceipt, "operation" | "result"> & {
      repositoryId: string;
      number: number;
      url: string;
      // The title the platform sent; null for one it did not create.
      title: string | null;
      head: string;
      base: string;
      created: boolean;
      // Which template the body was laid out on; absent: none was read.
      template?: PullRequestTemplateRecord | null | undefined;
    },
  ): Promise<{ pullRequest: PullRequest; created: boolean; receiptId: string }>;
}
