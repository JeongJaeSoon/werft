import type {
  AgentGitHub,
  EffectiveGitHubPolicy,
  GitHubAppRole,
  GitHubCeiling,
  GitHubPolicyReceiptFields,
  GitHubPurpose,
  GitHubRefusal,
  GitHubReviewEvent,
  ReceiptActor,
  RepositoryCeiling,
} from "@werft-ai/contracts";
import type {
  ForgeComment,
  ForgePullRequest,
  ForgePullRequestDetail,
  ForgePullRequestWithBody,
  ForgeRepository,
  GitCredential,
  RepoRef,
} from "./forge.ts";

export type GitHubPermissions = Readonly<Record<string, "read" | "write">>;

/** One piece of a session's GitHub work, as a caller asks the gate for it. */
export type GitHubWork = {
  sessionId: string;
  purpose: GitHubPurpose;
  /**
   * Absent: the session's own repository, read off the session row. Another
   * one only as its release lists it (session-multi-repository.md decision 5).
   */
  repositoryId?: string;
  /** dispatch only: a branch name, never `refs/...`. */
  workflow?: { file: string; ref: string };
  /** rerun only: the gate finds its workflow and ref in github_workflow_dispatches. */
  runId?: number;
  /** review only: what a refusal's receipt names. */
  review?: { number: number; commitId: string; event: GitHubReviewEvent };
  /**
   * Who the receipts name. Absent: the human who started the session (a
   * clone has no caller). Null: no one (the push executor).
   */
  actor?: ReceiptActor | null;
};

export type GitHubWorkflowRun = {
  id: number;
  path: string;
  head_branch: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
};

/**
 * A failed call to GitHub. Carries GitHub's status and request id only:
 * never its message, which may echo what the request sent (dispatch inputs).
 */
export class GitHubCallError extends Error {
  override readonly name = "GitHubCallError";
  constructor(
    readonly what: string,
    readonly status: number | null,
    readonly requestId: string | null,
    /** What the failed response said of the rate limit, when it said it. */
    readonly rateLimit: GitHubRateLimit | null = null,
  ) {
    super(`GitHub ${what} failed${status === null ? "" : ` (${status})`}`);
  }
}

/** A response's `x-ratelimit-*` and `retry-after` headers; null when absent. */
export type GitHubRateLimit = {
  limit: number | null;
  remaining: number | null;
  reset: Date | null;
  retryAfterSeconds: number | null;
};

export type GitTreeEntry = {
  name: string;
  /** Octal mode: 100644 and 100755 are files, 120000 a symlink, 160000 a submodule. */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
};

/** REST calls with the one credential a grant holds. */
export interface GitHubApi {
  /** Longest pull request or comment body GitHub takes. */
  readonly maxBodyLength: number;
  getRepository(): Promise<ForgeRepository>;
  getBranchHead(
    branch: string,
  ): Promise<{ commitSha: string; treeSha: string }>;
  /** One level of a tree, never recursive. `truncated`: GitHub cut the list. */
  readTree(
    treeSha: string,
  ): Promise<{ entries: GitTreeEntry[]; truncated: boolean }>;
  /** A blob's bytes, never followed through a link. Failures are GitHubCallError. */
  readBlob(blobSha: string): Promise<Uint8Array>;
  findPullRequestForBranch(branch: string): Promise<ForgePullRequest | null>;
  /**
   * Every pull request whose head is the branch, in any state, newest first
   * (at most `limit`, default 10). The drain reads this to tell a pull
   * request it opened but could not record from one a person closed.
   */
  findPullRequestsForBranch(
    branch: string,
    options?: { limit?: number },
  ): Promise<ForgePullRequestWithBody[]>;
  /**
   * True when `descendant` is `ancestor` itself or a commit built on it.
   * One compare request; a failure throws and the caller reads it as "no".
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /**
   * `created` is false when GitHub refused to create one because the head
   * already has an open pull request, and that one is answered instead.
   */
  createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<ForgePullRequest & { created: boolean }>;
  /**
   * One request, never retried or held back for a rate limit: a failure is
   * GitHubCallError carrying the response's rate limit.
   */
  getPullRequest(number: number): Promise<{
    pullRequest: ForgePullRequestDetail;
    rateLimit: GitHubRateLimit;
  }>;
  /**
   * Reads the pull request's body and writes back what `edit` makes of it,
   * with `title` in the same write when one is given.
   */
  updatePullRequestBody(
    number: number,
    edit: (body: string) => string,
    title?: string,
  ): Promise<void>;
  /**
   * Squash-merges it on `sha`, which GitHub checks against the head, with
   * rule bypass off. No auto-merge, no other method. A 400 or 405 (not
   * mergeable now) is GitHubCallError with that status. `already` is a pull
   * request GitHub found merged before this call did anything.
   */
  mergePullRequest(input: { number: number; sha: string }): Promise<{
    merged: boolean;
    sha: string | null;
    already?: boolean;
  }>;
  /** Closes or reopens it; answers the pull request as GitHub left it. */
  setPullRequestState(
    number: number,
    state: "open" | "closed",
  ): Promise<ForgePullRequest>;
  upsertComment(
    number: number,
    marker: string,
    body: string,
  ): Promise<ForgeComment>;
  /** `ref` is sent as `refs/heads/<ref>`. Null when GitHub names no run. */
  dispatchWorkflow(input: {
    workflow: string;
    ref: string;
    inputs: Readonly<Record<string, string>>;
  }): Promise<{ id: number; html_url: string } | null>;
  getWorkflowRun(runId: number): Promise<GitHubWorkflowRun>;
  rerunWorkflow(runId: number, failedOnly: boolean): Promise<void>;
  /** Always on `commitId`: GitHub files the review on that commit. */
  submitReview(input: {
    number: number;
    commitId: string;
    event: GitHubReviewEvent;
    body?: string;
  }): Promise<{ id: number; html_url: string }>;
}

/**
 * What a granted piece of work may call: one repository, one connection,
 * one credential the gate issued. Nothing here issues a credential.
 */
export interface GitHubGrant {
  readonly role: GitHubAppRole;
  readonly repo: RepoRef;
  readonly permissions: GitHubPermissions;
  /** For git over HTTP (clone, push). */
  readonly gitCredential: GitCredential;
  readonly api: GitHubApi;
  /** The rate-limit unit `api` spends from: the connection's `quotaKey`. */
  unit(): Promise<string>;
  /** dispatch and rerun: the allow-list entry that matched. */
  readonly allowedBy: AgentGitHub["actions_allow"][number] | null;
  /** What the receipts of the work name. */
  readonly context: GitHubWorkContext;
}

export type GitHubWorkContext = {
  ownerId: string;
  sessionId: string;
  agentId: string | null;
  agentReleaseId: string | null;
  repositoryId: string;
  /** The policy that allowed it, for the receipts of the work. */
  policy: GitHubPolicyReceiptFields;
};

/** A refusal before any GitHub call; its receipt is already written. */
export class GitHubGateError extends Error {
  override readonly name = "GitHubGateError";
  constructor(
    readonly reasonCode: GitHubRefusal,
    readonly receiptId: string | null,
  ) {
    super(`GitHub work refused: ${reasonCode}`);
  }
}

/**
 * The repository has a GitHub App behind it, but no credential could
 * be issued (no App registered, GitHub failing). The adapter logged why.
 */
export class GitHubUnavailableError extends Error {
  override readonly name = "GitHubUnavailableError";
  constructor(
    message: string,
    readonly receiptId: string | null = null,
  ) {
    super(message);
  }
}

export interface GitHubGate {
  /**
   * Null when the session's repository is not on GitHub (another host, a
   * bearer token, a public repository): the caller keeps the catalog's
   * credential.
   * Refuses with GitHubGateError before any GitHub call.
   */
  grant(work: GitHubWork): Promise<GitHubGrant | null>;
  /**
   * The catalog ids of the repositories besides its own the session may
   * work on now, in its release's order; absent, none.
   */
  additionalRepositories?(sessionId: string): Promise<string[]>;
}

/** What the gate reads of a session at every grant. */
export type GitHubSessionContext = {
  ownerId: string;
  sessionId: string;
  repositoryId: string | null;
  profileId: string | null;
  /** Null: none given at creation, so the release's list applies whole. */
  attachedRepositoryIds: string[] | null;
  /** The URL and branch the session pinned at creation. */
  repository: { url: string; branch: string } | null;
  /** The human who started the session, for the receipts of clone. */
  startedBy: string | null;
  agent: {
    id: string;
    workspaceId: string;
    githubEnabled: boolean;
  } | null;
  release: { id: string } | null;
  /** What judges the session's GitHub work: read nothing else for it. */
  policy: EffectiveGitHubPolicy;
  /** The agent workspace's ceiling; all false without a settings row. */
  ceiling: GitHubCeiling;
  /** The session workspace's repositories; null allows none. */
  repositoryCeiling: RepositoryCeiling | null;
  /** `github_workspace_settings.revision`; 0 without a row. */
  ceilingRevision: number;
};

export type GitHubDispatchRecord = {
  runId: number;
  repositoryId: string;
  workflow: string;
  ref: string;
};

export type GitHubGateReceipt = {
  ownerId: string;
  sessionId: string;
  actor: ReceiptActor | null;
  operation:
    | "mint_github_token"
    | "dispatch_workflow"
    | "rerun_workflow"
    | "review_pull_request"
    | "merge_pull_request";
  status: "succeeded" | "failed";
  result: Record<string, unknown>;
  error: { code: "GITHUB_REFUSED"; message: string } | null;
};

export interface GitHubGateStore {
  context(sessionId: string): Promise<GitHubSessionContext | null>;
  findDispatch(
    repositoryId: string,
    runId: number,
  ): Promise<GitHubDispatchRecord | null>;
  recordReceipt(receipt: GitHubGateReceipt): Promise<string>;
}

/** A GitHub connection: one App and its own token cache. */
export interface GitHubConnection {
  readonly kind: "app";
  /** False for a GHES `api_base`. */
  readonly githubCom: boolean;
  readonly appId: number | null;
  /**
   * A credential for one repository and permission set; `fresh` when it was
   * issued now rather than taken from the cache. GitHub refusing the
   * permissions is GitHubPermissionError.
   */
  credential(
    repo: RepoRef,
    permissions: GitHubPermissions,
  ): Promise<{ credential: GitCredential; fresh: boolean }>;
  /**
   * Whether the App is installed on `repo`, asked with its own JWT; null for
   * a PAT. Issues no installation token.
   */
  installed(repo: RepoRef): Promise<boolean | null>;
  /**
   * `installed` for many repositories at once, from the App's installations
   * rather than one lookup per repository. Keyed by `repoKeyOf`; a
   * repository GitHub could not tell about maps to null. Rejects when
   * GitHub does not answer at all.
   */
  installedOn(
    repos: readonly RepoRef[],
  ): Promise<ReadonlyMap<string, boolean | null>>;
  /**
   * The GitHub rate-limit unit a request for `repo` spends from:
   * `app:<api_base>:<installation id>`, or `pat:<api_base>:<user id>` for
   * the user `GET /user` names. Throws when that cannot be told now.
   */
  quotaKey(repo: RepoRef): Promise<string>;
  api(repo: RepoRef, credential: GitCredential): GitHubApi;
}

/** GitHub refused to issue a token with the permissions asked (422). */
export class GitHubPermissionError extends Error {
  override readonly name = "GitHubPermissionError";
}

/** A connection registered in the console: a `github_apps` row. */
export type RegisteredGitHubConnection = {
  id: string;
  appId: number;
  connection: GitHubConnection;
};

/**
 * What can serve a catalog repository for a role: its own connection (a
 * catalog App), or the console's connections of that role, of which
 * the repository's pin picks one (decision github-agent.md 11).
 */
export type GitHubConnectionSource =
  | { kind: "fixed"; connection: GitHubConnection }
  | {
      kind: "registered";
      candidates: readonly RegisteredGitHubConnection[];
    };

/** The connections of a catalog repository for `role`, or null for none. */
export type GitHubConnections = (
  repositoryId: string,
  role: GitHubAppRole,
) => GitHubConnectionSource | null;
