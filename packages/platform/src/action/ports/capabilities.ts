import type { GitHubApi } from "./github-api.ts";

// GitHubApi keeps one implementation; a service takes only what it calls.
// Each name is one thing a caller can ask the forge to do (surface-action-modules.md 6.2).

/** Repository metadata and file reads: the PR template and the push executor's default branch. */
export type RepositoryReadable = Pick<
  GitHubApi,
  "getRepository" | "getBranchHead" | "readTree" | "readBlob"
>;

export type PullRequestReadable = Pick<
  GitHubApi,
  | "getPullRequest"
  | "findPullRequestForBranch"
  | "findPullRequestsForBranch"
  | "isAncestor"
>;

export type PullRequestWritable = Pick<
  GitHubApi,
  | "maxBodyLength"
  | "createPullRequest"
  | "updatePullRequestBody"
  | "setPullRequestState"
>;

export type PullRequestMergeable = Pick<GitHubApi, "mergePullRequest">;

export type Commentable = Pick<GitHubApi, "maxBodyLength" | "upsertComment">;

export type Reviewable = Pick<GitHubApi, "maxBodyLength" | "submitReview">;

export type WorkflowRunnable = Pick<
  GitHubApi,
  "dispatchWorkflow" | "getWorkflowRun" | "rerunWorkflow"
>;
