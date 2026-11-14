import type { GitHubReviewEvent } from "@werft-ai/contracts";
import type {
  ForgeComment,
  ForgePullRequest,
  ForgePullRequestDetail,
  ForgePullRequestWithBody,
  ForgeRepository,
} from "./forge.ts";

export type GitHubWorkflowRun = {
  id: number;
  path: string;
  head_branch: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
};

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
   * with `title` in the same write when one is given. When `edit` answers
   * null nothing is written, the title included.
   */
  updatePullRequestBody(
    number: number,
    edit: (body: string) => string | null,
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
