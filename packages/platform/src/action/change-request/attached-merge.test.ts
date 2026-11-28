import { describe, expect, test } from "bun:test";
import {
  type AgentGitHubFeatures,
  type AgentGitHubSettingsRow,
  DEFAULT_PULL_REQUEST_SETTINGS,
  effectiveGitHubPolicy,
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  type GitHubPolicyStart,
  type Principal,
  type PullRequest,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import {
  repositoryBinding,
  type SessionCatalog,
} from "../../catalog/catalog.ts";
import {
  GitHubCallError,
  type GitHubConnection,
  type GitHubGateReceipt,
} from "../../github/ports/github-gate.ts";
import { createGitHubGate } from "../../github/service/github-gate.ts";
import { SessionServiceError } from "../../musterrolle/index.ts";
import { createAuthorizationPolicy } from "../../musterrolle/policy.ts";
import type { GitHubApi } from "../ports/github-api.ts";
import type {
  PullRequestReceipt,
  PullRequestSource,
} from "../ports/pull-requests.ts";
import { createPullRequestService } from "./pull-request-service.ts";

// 94S-2556: a DM session with no repository of its own merges, in a
// repository it attached, the pull request it opened, through the real gate.
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "33333333-3333-4333-8333-333333333333";
const PUSH = "22222222-2222-4222-8222-222222222222";
const OTHER_PUSH = "44444444-4444-4444-8444-444444444444";
const OUTSIDE_PUSH = "55555555-5555-4555-8555-555555555555";
const PUSHED = "a".repeat(40);
const CATALOG = {
  connections: {},
  repositories: {
    sandbox: {
      url: "https://github.com/acme/sandbox.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
    outside: {
      url: "https://github.com/acme/outside.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
} satisfies SessionCatalog;
const human: Principal = {
  kind: "api_key",
  id: "key-1",
  owner_id: "owner-a",
  workspace_id: null,
  scopes: ["sessions:approve"],
};
const actor = {
  caller: testCaller("owner-a"),
  principal: human,
  ownerId: "owner-a",
  verified: true,
};

const features = (merge: boolean): AgentGitHubFeatures => ({
  ...GITHUB_FEATURES_NONE,
  merge,
});
const row = (merge: boolean): AgentGitHubSettingsRow => ({
  repositories: ["sandbox"],
  pushApproval: false,
  features: features(merge),
  actionsAllow: [],
  startRepositoryId: null,
  pushAttached: "allow",
  revision: 2,
  updatedBy: "user-1",
});

function harness(
  options: {
    agentMerge?: boolean;
    ceilingMerge?: boolean;
    /** The switch as the session read it when it started; absent, no snapshot. */
    startMerge?: boolean;
    mergeableState?: string;
    /** The pull request of PUSH was found on the branch, not made by the platform. */
    adopted?: boolean;
  } = {},
) {
  const state = {
    agentMerge: options.agentMerge ?? true,
    ceilingMerge: options.ceilingMerge ?? true,
  };
  const source = (
    id: string,
    sessionId: string,
    repositoryId: "sandbox" | "outside",
  ): PullRequestSource => ({
    id,
    sessionId,
    repositoryId,
    repositoryBinding: repositoryBinding(
      repositoryId,
      CATALOG.repositories[repositoryId],
    ),
    state: "pushed",
    targetBranch: `agent/${sessionId}`,
    gitCommit: PUSHED,
    prState: "opened",
    prError: null,
    prErrorDetails: null,
  });
  // What the server recorded: each push request, and the pull request it opened.
  const sources = [
    source(PUSH, SESSION, "sandbox"),
    source(OTHER_PUSH, OTHER_SESSION, "sandbox"),
    source(OUTSIDE_PUSH, SESSION, "outside"),
  ];
  const pullRequests: PullRequest[] = sources.map((pushed, index) => ({
    push_request_id: pushed.id,
    session_id: pushed.sessionId,
    repository_id: pushed.repositoryId,
    number: 7 + index,
    url: `https://github.com/acme/${pushed.repositoryId}/pull/${7 + index}`,
    head: pushed.targetBranch,
    base: "main",
    created_at: "2026-11-28T00:00:00.000Z",
    receipt_id: `receipt-open-${index}`,
  }));
  const calls: string[] = [];
  const minted: string[] = [];
  const merged = new Set<number>();
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const forgeFor = (repository: string): GitHubApi => ({
    maxBodyLength: 65_536,
    getRepository: unused,
    getBranchHead: unused,
    readTree: unused,
    readBlob: unused,
    findPullRequestForBranch: async () => null,
    findPullRequestsForBranch: unused,
    isAncestor: unused,
    createPullRequest: unused,
    getPullRequest: async (number) => {
      calls.push(`read ${repository}#${number}`);
      const recorded = pullRequests.find(
        (entry) =>
          entry.number === number && entry.repository_id === repository,
      );
      if (recorded === undefined) {
        throw new GitHubCallError("pull request read", 404, null);
      }
      const done = merged.has(number);
      return {
        pullRequest: {
          number,
          url: recorded.url,
          state: done ? "closed" : "open",
          head: recorded.head,
          headSha: PUSHED,
          base: recorded.base,
          mergedAt: done ? "2026-11-28T01:00:00Z" : null,
          closedAt: done ? "2026-11-28T01:00:00Z" : null,
          title: "t",
          body: "",
          mergeCommitSha: done ? "c".repeat(40) : null,
          mergeableState: options.mergeableState ?? "clean",
          mergeable: (options.mergeableState ?? "clean") === "clean",
          draft: false,
          additions: null,
          deletions: null,
          changedFiles: null,
          commits: null,
        },
        rateLimit: {
          limit: null,
          remaining: null,
          reset: null,
          retryAfterSeconds: null,
        },
      };
    },
    updatePullRequestBody: unused,
    setPullRequestState: unused,
    mergePullRequest: async ({ number, sha }) => {
      calls.push(`merge ${repository}#${number} ${sha}`);
      merged.add(number);
      return { merged: true, sha: "c".repeat(40) };
    },
    upsertComment: unused,
    dispatchWorkflow: unused,
    getWorkflowRun: unused,
    getCommitCi: unused,
    rerunWorkflow: unused,
    submitReview: unused,
  });
  const connection: GitHubConnection = {
    kind: "app",
    githubCom: true,
    appId: 7,
    installedOn: async (repos) =>
      new Map(repos.map((repo) => [`${repo.owner}/${repo.name}`, true])),
    quotaKey: async () => "author:quota",
    installed: async () => true,
    credential: async (repo, permissions) => {
      minted.push(`${repo.name} ${JSON.stringify(permissions)}`);
      return {
        credential: { username: "x-access-token", password: "test-value" },
        fresh: true,
      };
    },
    api: (repo) => forgeFor(repo.name),
  };
  const start = (merge: boolean): GitHubPolicyStart => ({
    enabled: true,
    revision: 1,
    settings: {
      repositories: ["sandbox"],
      push_approval: false,
      features: features(merge),
      actions_allow: [],
    },
  });
  const gateReceipts: GitHubGateReceipt[] = [];
  const ownPullRequestReads: string[] = [];
  const gate = createGitHubGate({
    catalog: CATALOG,
    connections: (_id, role) =>
      role === "author" ? { kind: "fixed", connection } : null,
    store: {
      context: async (sessionId) => ({
        ownerId: "owner-a",
        sessionId,
        // A DM session: no repository of its own.
        repositoryId: null,
        attachedRepositoryIds: ["sandbox", "outside"],
        repository: null,
        startedBy: null,
        agent: { id: "agent-1", workspaceId: "owner-a", githubEnabled: true },
        release: { id: "release-1" },
        policy: effectiveGitHubPolicy({
          source: "agent",
          releasePin: null,
          agentRow: row(state.agentMerge),
          ...(options.startMerge === undefined
            ? {}
            : { start: start(options.startMerge) }),
          attachedRepositoryIds: ["sandbox", "outside"],
        }),
        ceiling: { ...GITHUB_CEILING_NONE, merge: state.ceilingMerge },
        repositoryCeiling: {
          repository_ids: ["sandbox", "outside"],
          github_app_repositories: "listed",
        },
        ceilingRevision: 1,
      }),
      findDispatch: async () => null,
      recordReceipt: async (receipt) => {
        gateReceipts.push(receipt);
        return `gate-receipt-${gateReceipts.length}`;
      },
      ownPullRequest: async (sessionId, pushRequestId, url) => {
        ownPullRequestReads.push(pushRequestId);
        const pushed = sources.find(
          (entry) =>
            entry.id === pushRequestId && entry.sessionId === sessionId,
        );
        return pushed !== undefined &&
          pullRequests.some(
            (entry) => entry.push_request_id === pushed.id && entry.url === url,
          )
          ? {
              repositoryId: pushed.repositoryId,
              opened: !(options.adopted === true && pushed.id === PUSH),
            }
          : null;
      },
    },
  });
  const receipts: PullRequestReceipt[] = [];
  const service = createPullRequestService({
    authorization: createAuthorizationPolicy({
      sessions: { visibleTo: async () => true, originOf: async () => null },
    }),
    catalog: CATALOG,
    gate,
    redact: (line) => line,
    attribution: {
      attribution: async () => null,
      githubLinkOf: async () => null,
      lastRequesterOf: async () => null,
      requesterOfPushRequest: async () => null,
    },
    settings: {
      get: async () => ({
        settings: DEFAULT_PULL_REQUEST_SETTINGS,
        revision: 0,
      }),
      agentOfSession: async () => null,
    },
    consoleOrigin: null,
    logger: { warn: () => {} },
    store: {
      previewAgent: async () => null,
      failHeadMoved: async () => {},
      schedule: unused,
      findSource: async (_owner, sessionId, pushRequestId) =>
        sources.find(
          (entry) =>
            entry.id === pushRequestId && entry.sessionId === sessionId,
        ) ?? null,
      findPullRequest: async (_owner, pushRequestId) =>
        pullRequests.find((entry) => entry.push_request_id === pushRequestId) ??
        null,
      findBranchPullRequest: async () => null,
      recordReceipt: async (input) => {
        receipts.push(input as PullRequestReceipt);
        return `receipt-${receipts.length}`;
      },
      recordStateChange: async ({ url: _url, ...input }) => {
        receipts.push(input);
        return `receipt-${receipts.length}`;
      },
      savePullRequest: unused,
    },
  });
  const merge = (push: string, session = SESSION) =>
    service.merge(actor, session, push);
  return {
    state,
    merge,
    calls,
    minted,
    gateReceipts,
    receipts,
    ownPullRequestReads,
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SessionServiceError);
  const { code, details } = error as SessionServiceError;
  return { code, details };
}

describe("merging in a repository the session attached (94S-2556)", () => {
  test("its own pull request is squash-merged on the pushed commit, with a merge token for that repository alone", async () => {
    const h = harness();
    expect(await h.merge(PUSH)).toMatchObject({
      merged: true,
      changed: true,
      head_sha: PUSHED,
      method: "squash",
      pull_request: { number: 7, repository_id: "sandbox" },
    });
    expect(h.calls).toEqual(["read sandbox#7", `merge sandbox#7 ${PUSHED}`]);
    expect(h.minted).toEqual([
      'sandbox {"contents":"write","pull_requests":"read"}',
    ]);
    expect(h.ownPullRequestReads).toEqual([PUSH]);
    expect(h.gateReceipts.at(-1)).toMatchObject({
      operation: "mint_github_token",
      status: "succeeded",
      result: {
        purpose: "merge",
        repository_id: "sandbox",
        push_request_id: PUSH,
      },
    });
  });

  test("another session's pull request in the same repository is refused before any token or GitHub call", async () => {
    const h = harness();
    // Named by this session: the server has no such push request of its own.
    expect(await refusal(h.merge(OTHER_PUSH))).toMatchObject({
      code: "NOT_FOUND",
      details: { refusal: "not_found" },
    });
    expect(h.calls).toEqual([]);
    expect(h.minted).toEqual([]);
    expect(h.gateReceipts).toEqual([]);
  });

  test("with a switch off it is merge_off naming the side, not repository_not_allowed, and no token is asked for", async () => {
    for (const [agentMerge, ceilingMerge, offIn] of [
      [false, true, "agent"],
      [true, false, "ceiling"],
      [false, false, "both"],
    ] as const) {
      const h = harness({ agentMerge, ceilingMerge });
      expect((await refusal(h.merge(PUSH))).details).toMatchObject({
        refusal: "github_refused",
        reason_code: "merge_off",
        off_in: offIn,
      });
      expect(h.calls).toEqual([]);
      expect(h.minted).toEqual([]);
      expect(h.gateReceipts.at(-1)).toMatchObject({
        operation: "merge_pull_request",
        status: "failed",
        result: { reason_code: "merge_off", off_in: offIn },
      });
    }
  });

  test("a session started with the switch off stays off after it is turned on", async () => {
    const h = harness({ startMerge: false });
    expect((await refusal(h.merge(PUSH))).details).toMatchObject({
      reason_code: "merge_off",
      off_in: "agent",
    });
    expect(h.calls).toEqual([]);
    expect(h.minted).toEqual([]);
    // One that started with it on merges.
    expect(await harness({ startMerge: true }).merge(PUSH)).toMatchObject({
      merged: true,
    });
  });

  test("a pull request on the session's branch that someone else opened, and the platform adopted, is not_own_pull_request", async () => {
    const h = harness({ adopted: true });
    expect((await refusal(h.merge(PUSH))).details).toMatchObject({
      refusal: "github_refused",
      reason_code: "not_own_pull_request",
    });
    expect(h.calls).toEqual([]);
    expect(h.minted).toEqual([]);
    expect(h.gateReceipts.at(-1)).toMatchObject({
      operation: "merge_pull_request",
      status: "failed",
      result: { reason_code: "not_own_pull_request", push_request_id: PUSH },
    });
  });

  test("a repository outside the agent's list is repository_not_allowed, with both switches on", async () => {
    const h = harness();
    expect((await refusal(h.merge(OUTSIDE_PUSH))).details).toMatchObject({
      refusal: "github_refused",
      reason_code: "repository_not_allowed",
    });
    expect(h.calls).toEqual([]);
    expect(h.minted).toEqual([]);
  });

  test("a pull request held by a required review is merge_blocked after no merge request, and not sent again", async () => {
    const h = harness({ mergeableState: "blocked" });
    for (let call = 0; call < 2; call += 1) {
      expect((await refusal(h.merge(PUSH))).details).toMatchObject({
        refusal: "merge_blocked",
        mergeable_state: "blocked",
      });
    }
    expect(h.calls).toEqual(["read sandbox#7", "read sandbox#7"]);
  });
});
