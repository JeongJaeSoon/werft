import type {
  AgentGitHub,
  ApiErrorCode,
  AttributionMismatchDetail,
  DeciderKey,
  GitHubPolicyReceiptFields,
  GitHubPolicySource,
  PushAttached,
  PushDecision,
  PushReasonCode,
  PushReceiptResult,
  PushRefusal,
  PushRequest,
  PushRequestFlow,
  PushRequestOrigin,
  PushRequestSnapshot,
  ReceiptActor,
  RepositoryCeiling,
} from "@werft-ai/contracts";
import { GITHUB_SETTINGS_UNSUPPORTED } from "./github-settings.ts";

/** What every refused push operation answers, and its receipt records. */
export const PUSH_REFUSAL_ERRORS: Record<
  PushRefusal,
  { code: ApiErrorCode; message: string }
> = {
  missing_scope: {
    code: "FORBIDDEN",
    message: "This credential does not hold sessions:approve",
  },
  self_approval: {
    code: "FORBIDDEN",
    message:
      "The key that started this session cannot approve its push requests; another key or a person approves them",
  },
  unverified_principal: {
    code: "FORBIDDEN",
    message:
      "A push decision needs a verified human credential: an API key or a signed-in user on an authenticating deployment",
  },
  not_found: { code: "NOT_FOUND", message: "Resource not found" },
  no_repository: {
    code: "PUSH_SOURCE_MISSING",
    message: "The session has no repository to push to",
  },
  no_checkpoint: {
    code: "PUSH_SOURCE_MISSING",
    message: "The session has no committed checkpoint to push",
  },
  checkpoint_unavailable: {
    code: "CHECKPOINT_UNAVAILABLE",
    message: "The session's latest checkpoint could not be verified",
  },
  request_open: {
    code: "PUSH_REQUEST_OPEN",
    message:
      "The session already has an open push request to this repository and branch",
  },
  already_resolved: {
    code: "PUSH_REQUEST_RESOLVED",
    message: "The push request was already approved or rejected",
  },
  // Only in older receipts; nothing refuses with it now.
  already_decided: {
    code: "PUSH_REQUEST_RESOLVED",
    message: "The push request was already approved or rejected",
  },
  checkpoint_moved: {
    code: "CHECKPOINT_MOVED",
    message:
      "The session checkpointed again after the request pinned its commit; reject it and request a push of the new checkpoint",
  },
  commit_mismatch: {
    code: "CHECKPOINT_MOVED",
    message: "git_commit is not the commit this request pinned",
  },
  catalog_changed: {
    code: "CATALOG_MISMATCH",
    message:
      "The catalog entry for the repository changed after the request pinned it; request a push again",
  },
  target_refused: {
    code: "FORBIDDEN",
    message:
      "The platform pushes only to agent/<session-id> or agent/<session-id>-<branch>",
  },
  default_branch: {
    code: "FORBIDDEN",
    message: "The target is the repository's default branch",
  },
  non_fast_forward: {
    code: "REVISION_CONFLICT",
    message:
      "The remote branch holds a commit the pinned commit does not build on; the platform never force-pushes",
  },
  no_push_credential: {
    code: "FORBIDDEN",
    message: "The repository has no credential the platform can push with",
  },
  lease_expired: {
    code: "LEASE_EXPIRED",
    message: "The push was taken up and dropped too many times",
  },
  push_failed: {
    code: "BACKEND_UNAVAILABLE",
    message: "The repository host did not take the push",
  },
  github_settings_unsupported: GITHUB_SETTINGS_UNSUPPORTED,
  github_refused: {
    code: "GITHUB_REFUSED",
    message: "The GitHub gate refused the push",
  },
  repository_not_allowed: {
    code: "FORBIDDEN",
    message: "The session's release does not let it work on this repository",
  },
  attribution_mismatch: {
    code: "FORBIDDEN",
    message:
      "A commit lacks the author or trailers the platform issues for this session; details lists the commits",
  },
  // The agent reads this text: it says what to do, and that the retry comes a
  // turn later because a checkpoint is taken when a turn ends.
  uncommitted_changes: {
    code: "FORBIDDEN",
    message:
      "The last checkpoint holds uncommitted changes to tracked files, so its commit is a platform snapshot, not yours. Commit them, then call request_push again in a later turn, after the turn in which you committed has ended",
  },
  unrelated_history: {
    code: "FORBIDDEN",
    message:
      "The commit shares no history with the repository's default branch",
  },
  approval_required: {
    code: "FORBIDDEN",
    message:
      "The agent's settings no longer push without approval; the request waits for a person again",
  },
  pinned_source_invalid: {
    code: "CHECKPOINT_UNAVAILABLE",
    message:
      "The checkpoint this request pinned no longer verifies for the session; reject it and request a push again",
  },
};

export type PushOperation = "request_push" | "resolve_push";

export type PushRefusalRecord = {
  ownerId: string;
  sessionId: string;
  /** Null: no one acted, the policy's approval lapsed. */
  actor: ReceiptActor | null;
  operation: PushOperation;
  refusal: PushRefusal;
  result: PushReceiptResult;
};

export type CreatePushRequestInput = {
  ownerId: string;
  sessionId: string;
  actor: ReceiptActor;
  idempotencyKey: string;
  payloadHash: string;
  repositoryId: string;
  /** `repositoryBinding` of the catalog entry when the request was made. */
  repositoryBinding: string;
  /** `pushBranchFor` of the session; absent, the one without a suffix. */
  targetBranch?: string;
  checkpointRevision: number;
  gitCommit: string;
  /**
   * `intent`: made by the intent runner from the revision a finished turn
   * pinned, so the create-time "pointer still on this revision" check does
   * not apply. Absent is `direct`.
   */
  origin?: PushRequestOrigin;
  /** Fixed at creation. Absent is `legacy`. */
  flow?: PushRequestFlow;
  /** The pull request the intent asked for once pushed; the PR drain runs it. */
  pullRequestIntent?: unknown;
  /**
   * The session's policy pushes without a person's approval: the request is
   * approved in the same transaction, decided by that policy.
   */
  policyApproval: PushPolicyApproval | null;
  /** The policy the request ran under, for its receipt. */
  policyFields: GitHubPolicyReceiptFields;
};

/** The policy that approved a push on its own. */
export type PushPolicyApproval = {
  releaseId: string;
  source: GitHubPolicySource;
  /** The agent settings' revision; null on a `release` session. */
  settingsRevision: number | null;
};

export type DecidePushRequestInput = {
  ownerId: string;
  sessionId: string;
  pushRequestId: string;
  actor: ReceiptActor;
  decision: PushDecision;
  gitCommit: string;
  reason: string | null;
  idempotencyKey: string;
  payloadHash: string;
  /**
   * The session's last checkpoint as read before the decision; absent or
   * null when it was not read. An approval after the session checkpointed
   * again stands when the checkpoint is still this one and holds the pinned
   * commit.
   */
  latest?: { revision: number; gitCommit: string } | null;
  /** The deciding API key, for the receipt; null for a person. */
  deciderKey?: DeciderKey | null;
};

export type PushWriteResult =
  | { outcome: "written" | "replayed"; request: PushRequest }
  | { outcome: "conflict" }
  // The receipt recording the refusal is already committed.
  | {
      outcome: "refused";
      refusal: PushRefusal;
      receiptId: string;
      /** `pull_request_pending`: `request_open` because of an unfinished PR stage. */
      reason?: "pull_request_pending";
    };

/** An approved request the platform has taken to push. */
export type PushJob = {
  id: string;
  ownerId: string;
  sessionId: string;
  repositoryId: string;
  /** Null on a request made before the binding was pinned. */
  repositoryBinding: string | null;
  checkpointRevision: number;
  gitCommit: string;
  targetBranch: string;
  /** 1 on the first claim; each claim of an expired lease adds one. */
  attempt: number;
};

export type PushOutcome =
  | {
      state: "pushed";
      remoteUrl: string;
      remoteRef: string;
      /** What the remote ref held before, or null when it was created. */
      previousCommit: string | null;
    }
  | {
      state: "failed";
      refusal: PushRefusal;
      reasonCode?: PushReasonCode;
      /** `attribution_mismatch` only. */
      mismatches?: AttributionMismatchDetail[];
      /** Set once the remote is known, so the receipt can name it. */
      remoteUrl?: string;
      remoteRef?: string;
    };

/**
 * A push request as a card shows it. `repositoryName`: the catalog's
 * owner/name, null when the catalog has no row for the id.
 */
export type PushRequestDisplay = {
  repositoryId: string;
  repositoryName: string | null;
  targetBranch: string;
  gitCommit: string;
  state: PushRequest["state"];
  decidedByUserId: string | null;
  createdAt: string;
};

export interface PushRequestDisplayReader {
  /** The request for display; null outside the owner's sessions. */
  displayOf(
    ownerId: string,
    sessionId: string,
    pushRequestId: string,
  ): Promise<PushRequestDisplay | null>;
}

export interface PushRequestStore {
  /** null when the session is not visible to the owner. */
  findSession(
    ownerId: string,
    sessionId: string,
  ): Promise<{
    repositoryId: string | null;
    profileId: string | null;
    /** The session row's attached list; null leaves the release's whole. */
    attached: string[] | null;
    /** `effectiveGitHubPolicy`'s, for another repository's push. */
    policySource: GitHubPolicySource;
    github: AgentGitHub | "invalid" | null;
    repositoryCeiling: RepositoryCeiling | null;
    /** False without an agent, or with its GitHub switch off. */
    githubEnabled: boolean;
    /** Set when the policy says `push_approval: false`, and only then. */
    policyApproval: PushPolicyApproval | null;
    /** `push_attached` as it applies to this session now. */
    pushAttached: PushAttached;
    /** Set when `pushAttached` is `allow`, and only then. */
    attachedApproval: PushPolicyApproval | null;
    policyFields: GitHubPolicyReceiptFields;
  } | null>;
  /** Writes the refusal receipt and returns its id. */
  recordRefusal(input: PushRefusalRecord): Promise<string>;
  /**
   * The answer an earlier create with this Idempotency-Key gave, or null when
   * the key is new. Lets a retry replay without re-reading the checkpoint.
   */
  replayCreate(input: {
    ownerId: string;
    sessionId: string;
    idempotencyKey: string;
    payloadHash: string;
  }): Promise<PushWriteResult | null>;
  /**
   * Pins the request in one transaction with its receipt. Refuses a session
   * that already has an open request or whose pointer moved off
   * `checkpointRevision` since the caller read it.
   */
  create(input: CreatePushRequestInput): Promise<PushWriteResult>;
  list(ownerId: string, sessionId: string): Promise<PushRequest[] | null>;
  get(
    ownerId: string,
    sessionId: string,
    pushRequestId: string,
  ): Promise<PushRequest | null>;
  /**
   * Where one push stands (intent, push request, pull request stage), read
   * in one repeatable-read transaction so an intent turning into a request
   * cannot show two different pictures. Either id finds the same push once
   * they are linked. Null outside the owner's session.
   */
  snapshot(
    ownerId: string,
    sessionId: string,
    ref: { pushRequestId: string } | { pushIntentId: string },
  ): Promise<PushRequestSnapshot | null>;
  /**
   * requested → approved | rejected. An approval is refused when the
   * session's checkpoint pointer no longer names the pinned revision; the
   * request then stays `requested`.
   */
  decide(input: DecidePushRequestInput): Promise<PushWriteResult>;
  /**
   * approved → pushing for the oldest approved request no one else holds,
   * or a `pushing` one whose lease ran out (its pusher died), or null. The
   * claimer owns the row for `leaseMs`.
   *
   * A policy's approval on an `agent` session is judged again here, in the
   * claim's transaction: one the settings no longer give goes back to
   * `requested`, with a receipt, for a person. Its attempts stay counted, so
   * a pusher still alive from before cannot finish it after a new approval.
   */
  claimNextApproved(leaseMs: number): Promise<PushJob | null>;
  /**
   * pushing → pushed | failed, with a `push` receipt. False when the row is
   * no longer this attempt's: not pushing, or claimed again after its lease
   * ran out.
   */
  finish(
    job: Pick<PushJob, "id" | "attempt">,
    outcome: PushOutcome,
  ): Promise<boolean>;
}
