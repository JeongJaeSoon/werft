import { afterAll, beforeAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { RepoRef } from "@werft-ai/platform";
import { describeCommentableContract } from "@werft-ai/platform/testing/commentable";
import type { ForgeContractSubject } from "@werft-ai/platform/testing/forge-subject";
import { describePullRequestMergeableContract } from "@werft-ai/platform/testing/pull-request-mergeable";
import { describePullRequestReadableContract } from "@werft-ai/platform/testing/pull-request-readable";
import { describePullRequestWritableContract } from "@werft-ai/platform/testing/pull-request-writable";
import { describeRepositoryReadableContract } from "@werft-ai/platform/testing/repository-readable";
import { describeReviewableContract } from "@werft-ai/platform/testing/reviewable";
import { describeWorkflowRunnableContract } from "@werft-ai/platform/testing/workflow-runnable";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { createGitHubConnection } from "./forge-github.ts";

// The forge capabilities' contract, run against the GitHub adapter over the
// testkit's fake GitHub. GitHub itself is not reachable from a test, so the
// fake is what the adapter's answers come from: a contract that fails here
// fails the adapter or the fake, and the contract text says which promise.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const FILES = { "README.md": "hello\n" };
const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  actions: "write",
} as const;

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
});
afterAll(async () => {
  await github.stop();
});

let repositories = 0;

/** A new repository on the fake, and the adapter's `GitHubApi` pointed at it. */
async function subject(): Promise<ForgeContractSubject> {
  repositories += 1;
  // The fake's failures are the server's, not the subject's: clear what a
  // contract left unspent.
  github.failNext(0, 500);
  const repo: RepoRef = { owner: "acme", name: `app-${repositories}` };
  await github.createRepository(repo.owner, repo.name, FILES);
  const connection = createGitHubConnection({
    apiBase: github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    retryAfterBaseMs: 1,
    paced: false,
  });
  const { credential } = await connection.credential(repo, PERMISSIONS);
  const api = connection.api(repo, credential);
  const started = github.apiRequests.length;
  let branches = 0;
  const pull = (number: number) =>
    github
      .pullRequests(repo.owner, repo.name)
      .find((entry) => entry.number === number);
  return {
    api,
    repository: { defaultBranch: "main", files: FILES },
    async newBranch() {
      branches += 1;
      const branch = `agent/${branches}`;
      await github.writeUnrelatedCommit(repo.owner, repo.name, branch);
      return branch;
    },
    async headOf(branch) {
      const commit = (await github.refs(repo.owner, repo.name))[
        `refs/heads/${branch}`
      ];
      if (commit === undefined) throw new Error(`no branch ${branch}`);
      return commit;
    },
    appendCommit: (branch) =>
      github.appendCommit(repo.owner, repo.name, branch),
    async openPullRequest(head) {
      const opened = await api.createPullRequest({
        head,
        base: "main",
        title: "Agent result",
        body: "What the session did.",
      });
      return opened.number;
    },
    pullRequestOnForge(number) {
      const found = pull(number);
      return found === undefined
        ? null
        : {
            title: found.title,
            body: found.body,
            state: found.state,
            merged: found.merged_at !== null,
          };
    },
    // The fake answers one placeholder head for every pull request.
    pullRequestHeadSha: (number) => pull(number)?.head_sha ?? "1".repeat(40),
    settleOnForge: (number, state) =>
      github.setPullRequestState(repo.owner, repo.name, number, state),
    commentsOnForge: (number) =>
      github
        .comments(repo.owner, repo.name, number)
        .map(({ id, body }) => ({ id, body })),
    commentAsPerson: (number, body) => {
      github.addComment(repo.owner, repo.name, number, body);
    },
    reviewsOnForge: (number) =>
      github
        .reviews(repo.owner, repo.name, number)
        .map(({ commit_id, event }) => ({ commitId: commit_id, event })),
    workflowRunsOnForge: () =>
      github
        .workflowRuns(repo.owner, repo.name)
        .map(({ id, reruns }) => ({ id, reruns })),
    failNext: (status, times = 1) => github.failNext(times, status),
    requestCount: () => github.apiRequests.length - started,
  };
}

describeRepositoryReadableContract(subject);
describePullRequestReadableContract(subject);
describePullRequestWritableContract(subject);
describePullRequestMergeableContract(subject);
describeCommentableContract(subject);
describeReviewableContract(subject);
describeWorkflowRunnableContract(subject);
