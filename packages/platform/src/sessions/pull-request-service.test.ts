import { describe, expect, test } from "bun:test";
import {
  type AgentPullRequestSettings,
  DEFAULT_PULL_REQUEST_SETTINGS,
  type GitHubRefusal,
  type Principal,
  type PullRequest,
  type PullRequestSettings,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import {
  type AuthorizationPolicy,
  callerFor,
  createAuthorizationPolicy,
  type SessionAccess,
} from "../musterrolle/policy.ts";
import { ForgeCredentialError, type ForgePullRequest } from "../ports/forge.ts";
import {
  type GitHubApi,
  GitHubCallError,
  type GitHubGate,
  GitHubGateError,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type {
  PullRequestReceipt,
  PullRequestSource,
  PullRequestStore,
} from "../ports/pull-requests.ts";
import type { SessionAttributionRecord } from "../ports/session-attribution.ts";
import { fakeRepositoryReads } from "../testing/repository-tree-fake.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import {
  PULL_REQUEST_TAIL_END_MARKER,
  PULL_REQUEST_TAIL_MARKER,
} from "./git-attribution.ts";
import {
  commentMarker,
  createPullRequestService,
} from "./pull-request-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const HEAD = `agent/${SESSION}`;
// No session here was started by the calling key.
const UNTRACED_SESSIONS: SessionAccess = {
  visibleTo: async () => true,
  originOf: async () => null,
};
const ZWSP = "​";
const CATALOG = {
  profiles: {},
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "develop",
      profiles: ["default"],
      auth: { kind: "github_app", registered: true },
    },
  },
} satisfies SessionCatalog;
const LINKED: SessionAttributionRecord = {
  ownerId: "owner-a",
  trigger: "web",
  agentId: "agent-1",
  agentReleaseId: "release-1",
  starter: { userId: "user-1", github: { id: "583231", login: "octocat" } },
  authorApp: null,
  authorPinned: false,
};
const TAIL = [
  "---",
  PULL_REQUEST_TAIL_MARKER,
  `<!-- agent-platform:push-request ${PUSH} -->`,
  `Opened in a Werft session · [session](<https://console.example.com/sessions/${SESSION}>) · commit \`aaaaaaa\``,
  "",
  "<details><summary>Details</summary>",
  "",
  `- Session: \`${SESSION}\``,
  "- Agent: `agent-1`, release `release-1`",
  `- Push request: \`${PUSH}\``,
  "- Trigger: web",
  "- Started by: GitHub account linked (octocat)",
  "</details>",
  "",
  "Co-authored-by: octocat <583231+octocat@users.noreply.github.com>",
  PULL_REQUEST_TAIL_END_MARKER,
].join("\n");
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

function harness(
  options: {
    state?: PullRequestSource["state"];
    binding?: string;
    authorization?: AuthorizationPolicy;
    gateRefusal?: GitHubRefusal;
    attribution?: SessionAttributionRecord | null;
    failUpdate?: boolean;
    /** Someone opened #9 for the head between the find and the create. */
    raced?: boolean;
    /** The head the forge reports for a pull request this call creates or races. */
    madeHead?: string;
    /** The repository's default branch, as the tree and blob reads see it. */
    repository?: ReturnType<typeof fakeRepositoryReads>;
    maxBodyLength?: number;
    /** The workspace's pull request layout; the defaults when absent. */
    layout?: Partial<PullRequestSettings>;
    /** The row of the agent the session ran under; none when absent. */
    agent?: AgentPullRequestSettings;
  } = {},
) {
  const attribution =
    options.attribution === undefined ? LINKED : options.attribution;
  const bodies = new Map<number, string>();
  const titles = new Map<number, string>();
  const warnings: string[] = [];
  const receipts: PullRequestReceipt[] = [];
  const dueAgain: string[] = [];
  const saved: PullRequest[] = [];
  const calls: string[] = [];
  const sourceReads: string[] = [];
  const settingsReads: string[] = [];
  const agentReads: string[] = [];
  const source: PullRequestSource = {
    id: PUSH,
    sessionId: SESSION,
    repositoryId: "app",
    repositoryBinding:
      options.binding ?? repositoryBinding("app", CATALOG.repositories.app),
    state: options.state ?? "pushed",
    targetBranch: HEAD,
    gitCommit: "a".repeat(40),
    prState: null,
    prError: null,
    prErrorDetails: null,
  };
  const failed: Array<Record<string, unknown>> = [];
  const store: PullRequestStore = {
    failHeadMoved: async ({ details }) => {
      failed.push(details);
      source.prState = "failed";
      source.prError = "head_moved";
      source.prErrorDetails = details;
    },
    schedule: async () => {
      throw new Error("not used");
    },
    findSource: async (_owner, session, push) => {
      sourceReads.push(session);
      return session === SESSION && push === PUSH ? source : null;
    },
    findPullRequest: async (_owner, push) =>
      saved.find((entry) => entry.push_request_id === push) ?? null,
    findBranchPullRequest: async (_owner, session, repositoryId, head) =>
      [...saved]
        .reverse()
        .find(
          (entry) =>
            entry.session_id === session &&
            entry.repository_id === repositoryId &&
            entry.head === head,
        ) ?? null,
    recordReceipt: async (input) => {
      receipts.push(input as PullRequestReceipt);
      return `receipt-${receipts.length}`;
    },
    recordStateChange: async ({ url, ...input }) => {
      receipts.push(input);
      dueAgain.push(url);
      return `receipt-${receipts.length}`;
    },
    savePullRequest: async (input) => {
      receipts.push({ ...input, operation: "open_pull_request" } as never);
      const pullRequest: PullRequest = {
        push_request_id: input.pushRequestId,
        session_id: input.sessionId,
        repository_id: input.repositoryId,
        number: input.number,
        url: input.url,
        head: input.head,
        base: input.base,
        created_at: "2026-10-13T00:00:00.000Z",
        receipt_id: `receipt-${receipts.length}`,
      };
      saved.push(pullRequest);
      return {
        pullRequest,
        created: input.created,
        receiptId: pullRequest.receipt_id,
      };
    },
  };
  let open: ForgePullRequest | null = null;
  const created: Array<{
    head: string;
    base: string;
    title: string;
    body: string;
  }> = [];
  const comments: Array<{ marker: string; body: string }> = [];
  let failing = false;
  let compareFails = false;
  const ancestors = new Set<string>();
  let readStatus: number | null = null;
  let patchAnswer: ForgePullRequest["state"] | null = null;
  let mergeable: string | null = "clean";
  let mergeStatus: number | null = null;
  let mergesLater = false;
  let declined: { headMoves: boolean } | null = null;
  let raced: { headMoves: boolean } | null = null;
  /** Open pull requests of other sessions, by their head branch. */
  const parents = new Map<string, ForgePullRequest>();
  let gateRefusal = options.gateRefusal ?? null;
  const works: GitHubWork[] = [];
  const fail = () => {
    if (failing) throw new ForgeCredentialError("GitHub call failed (502)");
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const repository = options.repository ?? fakeRepositoryReads({});
  const forge: GitHubApi = {
    maxBodyLength: options.maxBodyLength ?? 65_536,
    ...repository.reads,
    dispatchWorkflow: unused,
    getWorkflowRun: unused,
    rerunWorkflow: unused,
    submitReview: unused,
    findPullRequestsForBranch: unused,
    isAncestor: async (ancestor, descendant) => {
      calls.push(`ancestor ${ancestor.slice(0, 1)} ${descendant.slice(0, 1)}`);
      if (compareFails) throw new ForgeCredentialError("compare failed (502)");
      return ancestors.has(ancestor);
    },
    findPullRequestForBranch: async (branch) => {
      calls.push(`find ${branch}`);
      fail();
      const parent = parents.get(branch);
      if (parent !== undefined) return parent;
      return open !== null && open.head === branch ? open : null;
    },
    createPullRequest: async (input) => {
      calls.push(`create ${input.head}`);
      fail();
      if (options.raced) {
        return {
          number: 9,
          url: "https://github.com/acme/app/pull/9",
          state: "open",
          head: input.head,
          headSha: options.madeHead ?? "a".repeat(40),
          base: input.base,
          mergedAt: null,
          closedAt: null,
          created: false,
        };
      }
      created.push(input);
      bodies.set(7, input.body);
      open = {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        state: "open",
        head: input.head,
        headSha: options.madeHead ?? "a".repeat(40),
        base: input.base,
        mergedAt: null,
        closedAt: null,
      };
      return { ...open, created: true };
    },
    getPullRequest: async (number) => {
      calls.push(`read ${number}`);
      if (readStatus !== null) {
        throw new GitHubCallError("pull request read", readStatus, null);
      }
      if (open?.number !== number) {
        throw new GitHubCallError("pull request read", 404, null);
      }
      return {
        pullRequest: {
          ...open,
          title: "t",
          mergeCommitSha: open.mergedAt === null ? null : "c".repeat(40),
          mergeableState: mergeable,
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
    setPullRequestState: async (number, state) => {
      calls.push(`state ${number} ${state}`);
      fail();
      if (open === null || open.number !== number) {
        throw new ForgeCredentialError("GitHub call failed (404)");
      }
      const now = patchAnswer ?? state;
      open = {
        ...open,
        state: now,
        closedAt: now === "closed" ? "2026-11-04T00:00:00Z" : null,
      };
      return open;
    },
    mergePullRequest: async ({ number, sha }) => {
      calls.push(`merge ${number} ${sha.slice(0, 1)}`);
      if (mergeStatus !== null) {
        if (mergesLater && open !== null) {
          open = { ...open, state: "closed", mergedAt: "2026-11-08T00:00:00Z" };
        }
        throw new GitHubCallError("pull request merge", mergeStatus, null);
      }
      if (open === null || open.number !== number) {
        throw new GitHubCallError("pull request merge", 404, null);
      }
      if (declined !== null) {
        if (declined.headMoves) open = { ...open, headSha: "f".repeat(40) };
        return { merged: false, sha: null };
      }
      if (raced !== null) {
        open = {
          ...open,
          state: "closed",
          mergedAt: "2026-11-08T00:00:00Z",
          ...(raced.headMoves ? { headSha: "f".repeat(40) } : {}),
        };
        return { merged: true, sha: "e".repeat(40), already: true };
      }
      open = { ...open, state: "closed", mergedAt: "2026-11-08T00:00:00Z" };
      return { merged: true, sha: "c".repeat(40) };
    },
    updatePullRequestBody: async (number, edit, title) => {
      calls.push(`update ${number}`);
      fail();
      if (options.failUpdate) {
        throw new ForgeCredentialError("GitHub call failed (502)");
      }
      bodies.set(number, edit(bodies.get(number) ?? ""));
      if (title !== undefined) titles.set(number, title);
    },
    upsertComment: async (number, marker, body) => {
      calls.push(`comment ${number}`);
      fail();
      comments.push({ marker, body });
      return {
        id: 99,
        url: "https://github.com/acme/app/pull/7#issuecomment-99",
        created: comments.length === 1,
      };
    },
  };
  const gate: GitHubGate = {
    grant: async (work) => {
      works.push(work);
      if (gateRefusal !== null) {
        throw new GitHubGateError(gateRefusal, "gate-receipt");
      }
      return {
        role: "author",
        repo: { owner: "acme", name: "app" },
        permissions: { contents: "read", pull_requests: "write" },
        gitCredential: { username: "x-access-token", password: "issued" },
        api: forge,
        unit: async () => "app:test:1",
        allowedBy: null,
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: null,
          agentReleaseId: null,
          repositoryId: "app",
          policy: {},
        },
      };
    },
  };
  const service = createPullRequestService({
    authorization:
      options.authorization ??
      createAuthorizationPolicy({ sessions: UNTRACED_SESSIONS }),
    store,
    catalog: CATALOG,
    gate,
    redact: (line) => (line.includes("ghp_") ? "[REDACTED]" : line),
    attribution: { attribution: async () => attribution },
    settings: {
      get: async (workspaceId) => {
        settingsReads.push(workspaceId);
        return {
          settings: { ...DEFAULT_PULL_REQUEST_SETTINGS, ...options.layout },
          revision: 1,
        };
      },
      agentOfSession: async (workspaceId, sessionId) => {
        agentReads.push(`${workspaceId}/${sessionId}`);
        return options.agent ?? null;
      },
    },
    consoleOrigin: "https://console.example.com",
    logger: { warn: (message) => warnings.push(message) },
  });
  return {
    settingsReads,
    agentReads,
    service,
    bodies,
    titles,
    warnings,
    receipts,
    sourceReads,
    saved,
    calls,
    repository,
    works,
    created,
    comments,
    /** Commits the forge reports as ancestors of the pushed one. */
    ancestors,
    failCompare: () => {
      compareFails = true;
    },
    failed,
    setOpen: (
      pull: Omit<ForgePullRequest, "mergedAt" | "closedAt" | "headSha">,
      headSha = "a".repeat(40),
    ) => {
      open = {
        ...pull,
        headSha,
        mergedAt: null,
        closedAt: null,
      };
    },
    dueAgain,
    forgePullRequest: () => open,
    /** GitHub answers every state change with this state. */
    answerState: (state: ForgePullRequest["state"]) => {
      patchAnswer = state;
    },
    merge: () => {
      if (open !== null) {
        open = { ...open, state: "closed", mergedAt: "2026-11-04T00:00:00Z" };
      }
    },
    failRead: (status: number | null) => {
      readStatus = status;
    },
    setMergeable: (state: string | null) => {
      mergeable = state;
    },
    /** The merge call fails with `status`; the pull request may merge anyway. */
    failMerge: (status: number, merges = false) => {
      mergeStatus = status;
      mergesLater = merges;
    },
    /** Another open pull request has `branch` as its head. */
    stackOn: (branch: string) => {
      parents.set(branch, {
        number: 3,
        url: "https://github.com/acme/app/pull/3",
        state: "open",
        head: branch,
        headSha: "9".repeat(40),
        base: "main",
        mergedAt: null,
        closedAt: null,
      });
    },
    /** Someone merged it between our read and our request. */
    raceMerge: (headMoves: boolean) => {
      raced = { headMoves };
    },
    /** GitHub answers that nothing merged; the head may have moved by then. */
    declineMerge: (headMoves: boolean) => {
      declined = { headMoves };
    },
    failForge: () => {
      failing = true;
    },
    refuseGitHub: (reason: GitHubRefusal) => {
      gateRefusal = reason;
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SessionServiceError);
  const { code, details } = error as SessionServiceError;
  return { code, details };
}

describe("opening a pull request", () => {
  test("a session the caller cannot see is NOT_FOUND, and neither the store nor the forge is touched", async () => {
    const hidden: AuthorizationPolicy = {
      authorize: async () => ({
        outcome: "deny",
        reason_code: "not_found",
        effective_scopes: [],
        policy_version: "test",
        decision_id: crypto.randomUUID(),
      }),
    };
    const { service, receipts, calls, sourceReads } = harness({
      authorization: hidden,
    });
    for (const attempt of [
      service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      service.comment(actor, SESSION, PUSH, {
        readBody: async () => ({ body: "hi" }),
      }),
    ]) {
      expect((await refusal(attempt)).code).toBe("NOT_FOUND");
    }
    expect(sourceReads).toEqual([]);
    expect(receipts).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("opens one from agent/<session-id> into the catalog branch with cleaned text, then answers it again", async () => {
    const { service, created, calls, receipts } = harness();
    const first = await service.open(actor, SESSION.toUpperCase(), PUSH, {
      readBody: async () => ({
        title: "Fix for @octocat",
        body: "Closes #3\ntoken ghp_abc\nsee acme/other#4",
      }),
    });
    expect(first).toMatchObject({
      created: true,
      pull_request: { number: 7, head: HEAD, base: "develop" },
    });
    expect(created).toEqual([
      {
        head: HEAD,
        base: "develop",
        title: `Fix for @${ZWSP}octocat`,
        body: `C${ZWSP}loses #3\n[REDACTED]\nsee acme/other#${ZWSP}4\n\n${TAIL}`,
      },
    ]);

    const again = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(again).toMatchObject({
      created: false,
      pull_request: { number: 7 },
    });
    expect(calls).toEqual([`find ${HEAD}`, `create ${HEAD}`]);
    expect(receipts.at(-1)?.result).toMatchObject({
      verdict: "allow",
      created: false,
      number: 7,
    });
  });

  test("a personal key's receipts name its issuer, as the policy resolved them", async () => {
    const issuer = "019a0000-0000-7000-8000-0000000000c1";
    const { service, receipts } = harness({
      authorization: createAuthorizationPolicy({
        identity: {
          reread: async ({ principal }) => ({
            status: "ok",
            principal,
            keyCreator: { userId: issuer, role: "owner" },
          }),
        },
        sessions: UNTRACED_SESSIONS,
      }),
    });
    const caller = callerFor(human, { kind: "api" }, "request-1", {
      creatorId: issuer,
    });
    await service.open({ ...actor, caller }, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(receipts.map((receipt) => receipt.actor)).toEqual([
      {
        principal: { kind: "api_key", id: "key-1" },
        actor_user_id: issuer,
        agent_id: null,
      },
    ]);
  });

  test("an open pull request the forge already has for the branch is recorded, not opened again", async () => {
    const { service, setOpen, calls } = harness();
    setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(opened).toMatchObject({
      created: false,
      pull_request: { number: 3 },
    });
    expect(calls).toEqual([`find ${HEAD}`, "update 3"]);
  });

  describe("an open pull request on another commit than the pushed one", () => {
    const BRANCH_PR = {
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open" as const,
      head: HEAD,
      base: "develop",
    };
    const MOVED = "b".repeat(40);

    test("a head that is not an ancestor ends head_moved, with both commits; nothing is adopted or recorded", async () => {
      const { service, setOpen, calls, saved, receipts } = harness();
      setOpen(BRANCH_PR, MOVED);
      const caught = await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      );
      expect(caught.code).toBe("PUSH_REQUEST_RESOLVED");
      expect(caught.details).toMatchObject({
        refusal: "head_moved",
        number: 3,
        expected_sha: "a".repeat(40),
        actual_sha: MOVED,
      });
      expect(calls).toEqual([`find ${HEAD}`, "ancestor b a"]);
      expect(saved).toEqual([]);
      expect(receipts.at(-1)).toMatchObject({
        result: { verdict: "refuse", refusal: "head_moved", number: 3 },
      });
    });

    test("a head that is an ancestor is GitHub's lag: a retryable forge_failed, nothing recorded", async () => {
      const { service, setOpen, ancestors, saved, calls } = harness();
      setOpen(BRANCH_PR, MOVED);
      ancestors.add(MOVED);
      const caught = await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      );
      expect(caught.code).toBe("BACKEND_UNAVAILABLE");
      expect(saved).toEqual([]);
      expect(calls).not.toContain("update 3");
    });

    test("a pull request answered to a 422 on a moved head is not recorded either", async () => {
      const { service, saved } = harness({ madeHead: MOVED, raced: true });
      const caught = await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      );
      expect(caught.details).toMatchObject({ refusal: "head_moved" });
      expect(saved).toEqual([]);
    });

    test("a pull request this call created on a moved head ends the stage head_moved for good: its number is kept, nothing is recorded, and no later call creates another", async () => {
      const { service, saved, failed, calls, ancestors, forgePullRequest } =
        harness({ madeHead: MOVED });
      // Even a head that only lags is final here: the pull request exists.
      ancestors.add(MOVED);
      const first = await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      );
      expect(first.details).toMatchObject({
        refusal: "head_moved",
        number: 7,
        expected_sha: "a".repeat(40),
        actual_sha: MOVED,
      });
      expect(failed).toEqual([
        {
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          expected_sha: "a".repeat(40),
          actual_sha: MOVED,
        },
      ]);
      expect(saved).toEqual([]);
      // A person closes it; the next call must not reach the forge at all.
      const before = calls.length;
      expect(forgePullRequest()).not.toBeNull();
      const again = await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      );
      expect(again.details).toMatchObject({
        refusal: "head_moved",
        number: 7,
      });
      expect(calls.length).toBe(before);
      expect(saved).toEqual([]);
    });

    test("a compare GitHub fails closes the same way as a head that is not an ancestor", async () => {
      const { service, setOpen, failCompare, saved } = harness();
      setOpen(BRANCH_PR, MOVED);
      failCompare();
      const caught = await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      );
      expect(caught.details).toMatchObject({ refusal: "head_moved" });
      expect(saved).toEqual([]);
    });
  });

  test("a pull request the forge did not create is saved as not created on both paths: found open, and GitHub's 422", async () => {
    const savedAs = (receipts: PullRequestReceipt[]) =>
      receipts
        .filter((receipt) => receipt.operation === "open_pull_request")
        .map((receipt) => (receipt as unknown as { created: boolean }).created);

    const found = harness();
    found.setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    await found.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(savedAs(found.receipts)).toEqual([false]);

    const raced = harness({ raced: true });
    const opened = await raced.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(opened).toMatchObject({
      created: false,
      pull_request: { number: 9 },
    });
    expect(savedAs(raced.receipts)).toEqual([false]);
    // The one GitHub answered is someone's open pull request: its tail is
    // replaced as for one found open.
    expect(raced.calls).toEqual([`find ${HEAD}`, `create ${HEAD}`, "update 9"]);

    const fresh = harness();
    await fresh.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(savedAs(fresh.receipts)).toEqual([true]);
  });

  test("a reused pull request gets its tail replaced, the text above it kept", async () => {
    const { service, setOpen, bodies } = harness();
    setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    const old = TAIL.replace("a".repeat(40), "b".repeat(40)).replace(
      PUSH,
      "33333333-3333-4333-8333-333333333333",
    );
    bodies.set(3, `Edited by a person\r\n\r\n${old.replaceAll("\n", "\r\n")}`);
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    expect(bodies.get(3)).toBe(`Edited by a person\n\n${TAIL}`);
  });

  test("a tail GitHub refuses to update is logged; the pull request is still recorded", async () => {
    const { service, setOpen, warnings, saved } = harness({ failUpdate: true });
    setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(opened).toMatchObject({
      created: false,
      pull_request: { number: 3 },
    });
    expect(warnings).toEqual(["Pull request tail not updated"]);
    expect(saved.map((entry) => entry.number)).toEqual([3]);
  });

  test("a body without the marker keeps all it has and gets the tail added", async () => {
    const { service, setOpen, bodies } = harness();
    setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    bodies.set(3, "Opened by hand");
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    expect(bodies.get(3)).toBe(`Opened by hand\n\n${TAIL}`);
  });

  test("an agent-key session's tail names no one and carries no Co-authored-by", async () => {
    const { service, created } = harness({
      attribution: { ...LINKED, trigger: "agent_key", starter: null },
    });
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    const body = created[0]?.body ?? "";
    expect(body).toContain("- Trigger: agent_key");
    expect(body).toContain("- Started by: none (App only)");
    expect(body).not.toContain("Co-authored-by");
  });

  test("a starter without a GitHub link is named unlinked, with no Co-authored-by", async () => {
    const { service, created } = harness({
      attribution: {
        ...LINKED,
        starter: { userId: "user-1", github: null },
      },
    });
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    const body = created[0]?.body ?? "";
    expect(body).toContain(
      "- Started by: GitHub account not linked (App only)",
    );
    expect(body).not.toContain("Co-authored-by");
  });

  test("only a pushed request opens one", async () => {
    for (const state of [
      "requested",
      "approved",
      "pushing",
      "failed",
    ] as const) {
      const { service, calls, receipts } = harness({ state });
      expect(
        await refusal(
          service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
        ),
      ).toEqual({
        code: "PUSH_NOT_PUSHED",
        // The model tells a push waiting for a person from one still running
        // by this state.
        details: {
          refusal: "not_pushed",
          receipt_id: "receipt-1",
          push_request_state: state,
        },
      });
      expect(calls).toEqual([]);
      expect(receipts[0]).toMatchObject({
        operation: "open_pull_request",
        result: {
          verdict: "refuse",
          refusal: "not_pushed",
          repository_id: "app",
        },
      });
    }
  });

  test("a catalog entry changed since the push request pinned it is refused", async () => {
    const { service, calls } = harness({ binding: "stale" });
    expect(
      (
        await refusal(
          service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
        )
      ).code,
    ).toBe("CATALOG_MISMATCH");
    expect(calls).toEqual([]);
  });

  test("asks the gate for a pull_request grant as the caller", async () => {
    const { service, works } = harness();
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    expect(works).toEqual([
      {
        sessionId: SESSION,
        purpose: "pull_request",
        repositoryId: "app",
        actor: {
          principal: { kind: "api_key", id: "key-1" },
          actor_user_id: null,
          agent_id: null,
        },
      },
    ]);
  });

  test("a gate refusal is GITHUB_REFUSED with its reason_code and a receipt before the forge is asked", async () => {
    const { service, calls, receipts } = harness({
      gateRefusal: "repository_not_allowed",
    });
    expect(
      await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      ),
    ).toEqual({
      code: "GITHUB_REFUSED",
      details: {
        refusal: "github_refused",
        receipt_id: "receipt-1",
        reason_code: "repository_not_allowed",
      },
    });
    expect(calls).toEqual([]);
    expect(receipts[0]?.result).toMatchObject({
      verdict: "refuse",
      refusal: "github_refused",
      reason_code: "repository_not_allowed",
      repository_id: "app",
    });
  });

  test("a credential without sessions:approve or sessions:write, or not a human's, is refused with a receipt before the body is read", async () => {
    for (const principal of [
      { ...human, scopes: ["sessions:read"] },
      { ...human, kind: "installation" },
    ] as Principal[]) {
      const { service, receipts } = harness();
      let read = false;
      const { code } = await refusal(
        service.open(
          {
            ...actor,
            caller: testCaller("owner-a", ["sessions:read"]),
            principal,
          },
          SESSION,
          PUSH,
          {
            readBody: async () => {
              read = true;
              return {};
            },
          },
        ),
      );
      expect(code).toBe("FORBIDDEN");
      expect(read).toBe(false);
      expect(receipts).toHaveLength(1);
    }
    const { service, receipts } = harness();
    expect(
      (
        await refusal(
          service.open({ ...actor, verified: false }, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(receipts).toEqual([]);
  });

  test("a forge failure is a 503 with a receipt", async () => {
    const { service, failForge, receipts } = harness();
    failForge();
    expect(
      await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      ),
    ).toEqual({
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed", receipt_id: "receipt-1" },
    });
    expect(receipts[0]?.result).toMatchObject({
      head: HEAD,
      base: "develop",
    });
  });
});

describe("commenting on the pull request", () => {
  test("needs the pull request first", async () => {
    const { service, calls } = harness();
    expect(
      (
        await refusal(
          service.comment(actor, SESSION, PUSH, {
            readBody: async () => ({ body: "hi" }),
          }),
        )
      ).code,
    ).toBe("PULL_REQUEST_MISSING");
    expect(calls).toEqual([]);
  });

  test("a gate refusal comments on nothing", async () => {
    const { service, calls, comments, refuseGitHub } = harness();
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    refuseGitHub("github_disabled");
    const asked = calls.length;
    expect(
      (
        await refusal(
          service.comment(actor, SESSION, PUSH, {
            readBody: async () => ({ body: "hi" }),
          }),
        )
      ).details,
    ).toMatchObject({
      refusal: "github_refused",
      reason_code: "github_disabled",
    });
    expect(calls).toHaveLength(asked);
    expect(comments).toEqual([]);
  });

  test("upserts by marker with cleaned text and records each comment", async () => {
    const { service, comments, receipts } = harness();
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    const first = await service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Done, @team please look" }),
    });
    const second = await service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Updated", marker: "status" }),
    });
    expect(first.comment).toMatchObject({
      id: 99,
      created: true,
      marker: "status",
    });
    expect(second.comment.created).toBe(false);
    expect(comments).toEqual([
      {
        marker: commentMarker(SESSION, "status"),
        body: `Done, @${ZWSP}team please look`,
      },
      { marker: commentMarker(SESSION, "status"), body: "Updated" },
    ]);
    expect(receipts.at(-1)).toMatchObject({
      operation: "comment_pull_request",
      result: {
        verdict: "allow",
        number: 7,
        comment_id: 99,
        marker: "status",
        created: false,
      },
    });
  });

  test("a later pushed request of the session comments on the pull request an earlier one opened", async () => {
    const earlier: PullRequest = {
      push_request_id: "33333333-3333-4333-8333-333333333333",
      session_id: SESSION,
      repository_id: "app",
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      head: HEAD,
      base: "develop",
      created_at: "2026-10-13T00:00:00.000Z",
      receipt_id: "receipt-0",
    };
    const pushed = harness();
    pushed.saved.push(earlier);
    const answered = await pushed.service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Pushed again" }),
    });
    expect(answered.pull_request).toEqual(earlier);
    expect(pushed.calls).toEqual(["comment 7"]);

    const requested = harness({ state: "requested" });
    requested.saved.push(earlier);
    expect(
      (
        await refusal(
          requested.service.comment(actor, SESSION, PUSH, {
            readBody: async () => ({ body: "Not pushed" }),
          }),
        )
      ).code,
    ).toBe("PULL_REQUEST_MISSING");
  });
});

describe("updating the pull request", () => {
  test("needs the pull request first, and asks GitHub nothing", async () => {
    const { service, calls, receipts } = harness();
    expect(
      (
        await refusal(
          service.update(actor, SESSION, PUSH, {
            readBody: async () => ({ title: "New" }),
          }),
        )
      ).code,
    ).toBe("PULL_REQUEST_MISSING");
    expect(calls).toEqual([]);
    expect(receipts.at(-1)).toMatchObject({
      operation: "update_pull_request",
      result: { verdict: "refuse", refusal: "no_pull_request" },
    });
  });

  test("replaces the title and the person's text, keeping the platform's tail", async () => {
    const { service, bodies, titles, receipts } = harness();
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ title: "First", body: "Draft" }),
    });
    const opened = bodies.get(7) ?? "";
    expect(opened.startsWith("Draft\n\n")).toBe(true);
    const tail = opened.slice("Draft\n\n".length);
    const updated = await service.update(actor, SESSION, PUSH, {
      readBody: async () => ({
        title: "Final, @team",
        body: "What changed, with ghp_x",
      }),
    });
    expect(updated.pull_request.number).toBe(7);
    expect(titles.get(7)).toBe(`Final, @${ZWSP}team`);
    expect(bodies.get(7)).toBe(`[REDACTED]\n\n${tail}`);
    expect(receipts.at(-1)).toMatchObject({
      operation: "update_pull_request",
      result: { verdict: "allow", number: 7, created: false },
    });
  });

  test("the recorded pull request closed, or another open on the branch, is refused before an edit", async () => {
    for (const open of [
      { number: 7, state: "closed" as const },
      { number: 8, state: "open" as const },
    ]) {
      const h = harness();
      await h.service.open(actor, SESSION, PUSH, {
        readBody: async () => ({ body: "Draft" }),
      });
      h.setOpen({
        ...open,
        url: `https://github.com/acme/app/pull/${open.number}`,
        head: HEAD,
        base: "develop",
      });
      const calls = h.calls.length;
      expect(
        (
          await refusal(
            h.service.update(actor, SESSION, PUSH, {
              readBody: async () => ({ title: "Late" }),
            }),
          )
        ).details,
      ).toMatchObject({ refusal: "no_pull_request" });
      expect(h.calls.slice(calls)).toEqual([`find ${HEAD}`]);
      expect(h.titles.size).toBe(0);
    }
  });

  test("a title alone leaves the body as GitHub has it", async () => {
    const { service, bodies, titles } = harness();
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Kept" }),
    });
    const before = bodies.get(7);
    await service.update(actor, SESSION, PUSH, {
      readBody: async () => ({ title: "Renamed" }),
    });
    expect(bodies.get(7)).toBe(before);
    expect(titles.get(7)).toBe("Renamed");
  });
});

describe("closing and reopening the pull request", () => {
  const OTHER_SESSION = "33333333-3333-4333-8333-333333333333";
  const OTHER_PUSH = "44444444-4444-4444-8444-444444444444";
  const recorded: PullRequest = {
    push_request_id: PUSH,
    session_id: SESSION,
    repository_id: "app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    head: HEAD,
    base: "develop",
    created_at: "2026-10-13T00:00:00.000Z",
    receipt_id: "receipt-0",
  };
  const withPullRequest = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness(options);
    h.saved.push(recorded);
    h.setOpen({ ...recorded, state: "open" });
    return h;
  };

  test("closes, then reopens, the pull request this session's push request has, each with a receipt", async () => {
    const h = withPullRequest();
    expect(await h.service.setState(actor, SESSION, PUSH, "closed")).toEqual({
      pull_request: recorded,
      state: "closed",
      changed: true,
      receipt_id: "receipt-1",
    });
    expect(h.forgePullRequest()?.state).toBe("closed");
    expect(await h.service.setState(actor, SESSION, PUSH, "open")).toEqual({
      pull_request: recorded,
      state: "open",
      changed: true,
      receipt_id: "receipt-2",
    });
    expect(h.forgePullRequest()?.state).toBe("open");
    expect(h.calls).toEqual([
      "read 7",
      "state 7 closed",
      "read 7",
      "state 7 open",
    ]);
    expect(h.receipts).toEqual([
      expect.objectContaining({
        operation: "close_pull_request",
        pushRequestId: PUSH,
        result: expect.objectContaining({
          verdict: "allow",
          refusal: null,
          push_request_id: PUSH,
          repository_id: "app",
          number: 7,
          url: recorded.url,
          head: HEAD,
          state: "closed",
          changed: true,
        }),
      }),
      expect.objectContaining({
        operation: "reopen_pull_request",
        result: expect.objectContaining({
          verdict: "allow",
          state: "open",
          changed: true,
        }),
      }),
    ]);
    expect(h.works.map((work) => work.purpose)).toEqual([
      "pull_request",
      "pull_request",
    ]);
    // Each change makes the outcome due again, however long it was closed.
    expect(h.dueAgain).toEqual([recorded.url, recorded.url]);
  });

  test("the state and changed come from GitHub's answer, not from the request", async () => {
    const h = withPullRequest();
    h.answerState("open");
    expect(
      await h.service.setState(actor, SESSION, PUSH, "closed"),
    ).toMatchObject({ state: "open", changed: false });
    expect(h.calls).toEqual(["read 7", "state 7 closed"]);
    expect(h.receipts.at(-1)?.result).toMatchObject({
      verdict: "allow",
      state: "open",
      changed: false,
    });
    expect(h.dueAgain).toEqual([]);
  });

  test("a pull request already in that state is answered unchanged, with a receipt and no write", async () => {
    const h = withPullRequest();
    expect(
      await h.service.setState(actor, SESSION, PUSH, "open"),
    ).toMatchObject({ state: "open", changed: false });
    await h.service.setState(actor, SESSION, PUSH, "closed");
    expect(
      await h.service.setState(actor, SESSION, PUSH, "closed"),
    ).toMatchObject({ state: "closed", changed: false });
    expect(h.calls).toEqual(["read 7", "read 7", "state 7 closed", "read 7"]);
    expect(h.dueAgain).toEqual([recorded.url]);
    expect(h.receipts.map((receipt) => receipt.result)).toEqual([
      expect.objectContaining({
        verdict: "allow",
        state: "open",
        changed: false,
      }),
      expect.objectContaining({
        verdict: "allow",
        state: "closed",
        changed: true,
      }),
      expect.objectContaining({
        verdict: "allow",
        state: "closed",
        changed: false,
      }),
    ]);
  });

  test("another session's push request, or one this session does not have, is NOT_FOUND before GitHub is asked", async () => {
    for (const [session, push] of [
      [OTHER_SESSION, PUSH],
      [SESSION, OTHER_PUSH],
    ] as const) {
      const h = withPullRequest();
      expect(
        await refusal(h.service.setState(actor, session, push, "closed")),
      ).toMatchObject({ code: "NOT_FOUND", details: { refusal: "not_found" } });
      expect(h.calls).toEqual([]);
      expect(h.works).toEqual([]);
      expect(h.receipts).toEqual([
        expect.objectContaining({
          operation: "close_pull_request",
          sessionId: session,
          result: expect.objectContaining({
            verdict: "refuse",
            refusal: "not_found",
          }),
        }),
      ]);
    }
  });

  test("a repository the catalog or the release no longer allows is refused before GitHub is asked", async () => {
    const moved = withPullRequest({ binding: "moved" });
    expect(
      await refusal(moved.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "CATALOG_MISMATCH",
      details: { refusal: "catalog_changed" },
    });
    expect(moved.calls).toEqual([]);

    const refused = withPullRequest({ gateRefusal: "repository_not_allowed" });
    expect(
      await refusal(refused.service.setState(actor, SESSION, PUSH, "open")),
    ).toMatchObject({
      code: "GITHUB_REFUSED",
      details: {
        refusal: "github_refused",
        reason_code: "repository_not_allowed",
      },
    });
    expect(refused.calls).toEqual([]);
    expect(refused.receipts.at(-1)).toMatchObject({
      operation: "reopen_pull_request",
      result: {
        verdict: "refuse",
        refusal: "github_refused",
        reason_code: "repository_not_allowed",
        number: 7,
      },
    });
  });

  test("needs the pull request first", async () => {
    const h = harness();
    expect(
      await refusal(h.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "PULL_REQUEST_MISSING",
      details: { refusal: "no_pull_request" },
    });
    expect(h.calls).toEqual([]);
  });

  test("a merged pull request is PULL_REQUEST_MERGED either way, and nothing is written", async () => {
    for (const state of ["closed", "open"] as const) {
      const h = withPullRequest();
      h.merge();
      expect(
        await refusal(h.service.setState(actor, SESSION, PUSH, state)),
      ).toMatchObject({
        code: "PULL_REQUEST_MERGED",
        details: { refusal: "pull_request_merged" },
      });
      expect(h.calls).toEqual(["read 7"]);
      expect(h.receipts.at(-1)?.result).toMatchObject({
        verdict: "refuse",
        refusal: "pull_request_merged",
        state: "closed",
      });
    }
  });

  test("GitHub's pull request on another head, or none at that number, is no_pull_request", async () => {
    const moved = withPullRequest();
    moved.setOpen({ ...recorded, head: "feature", state: "open" });
    expect(
      (await refusal(moved.service.setState(actor, SESSION, PUSH, "closed")))
        .details,
    ).toMatchObject({ refusal: "no_pull_request" });

    const gone = withPullRequest();
    gone.failRead(404);
    expect(
      (await refusal(gone.service.setState(actor, SESSION, PUSH, "closed")))
        .details,
    ).toMatchObject({ refusal: "no_pull_request" });
    expect([...moved.calls, ...gone.calls]).toEqual(["read 7", "read 7"]);
  });

  test("a read or a write GitHub fails is forge_failed with a receipt", async () => {
    const reading = withPullRequest();
    reading.failRead(502);
    expect(
      await refusal(reading.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });

    const writing = withPullRequest();
    writing.failForge();
    expect(
      await refusal(writing.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });
    expect(writing.receipts.at(-1)?.result).toMatchObject({
      verdict: "refuse",
      refusal: "forge_failed",
      state: "open",
    });
    expect(writing.forgePullRequest()?.state).toBe("open");
  });
});

describe("a caller that may submit to the session", () => {
  const AGENT = "019a0000-0000-7000-8000-0000000000c1";
  const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
  const agentKey: Principal = {
    kind: "api_key",
    id: "agent-key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: ["sessions:read", "sessions:write"],
  };
  const submitter = {
    caller: callerFor(agentKey, { kind: "api" }, "request-1", {
      creatorId: null,
      agentId: AGENT,
    }),
    principal: agentKey,
    ownerId: WORKSPACE,
    verified: true,
  };
  const policy = createAuthorizationPolicy({
    identity: {
      reread: async ({ principal }) => ({
        status: "ok",
        principal,
        keyAgentId: AGENT,
      }),
    },
    agents: {
      agentOf: async (_workspace, resource) =>
        resource.kind === "session" && resource.id === SESSION ? AGENT : null,
      isAdmin: async () => false,
    },
    sessions: UNTRACED_SESSIONS,
  });
  const pulled: PullRequest = {
    push_request_id: PUSH,
    session_id: SESSION,
    repository_id: "app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    head: HEAD,
    base: "develop",
    created_at: "2026-10-13T00:00:00.000Z",
    receipt_id: "receipt-0",
  };

  test("an agent key opens a pull request for a pushed request and comments on it", async () => {
    const { service, calls, receipts } = harness({ authorization: policy });
    expect(
      await service.open(submitter, SESSION, PUSH, {
        readBody: async () => ({}),
      }),
    ).toMatchObject({ created: true, pull_request: { number: 7 } });
    await service.comment(submitter, SESSION, PUSH, {
      readBody: async () => ({ body: "Ready" }),
    });
    expect(calls).toEqual([`find ${HEAD}`, `create ${HEAD}`, "comment 7"]);
    expect(receipts[0]?.actor).toMatchObject({
      principal: { kind: "api_key", id: "agent-key-1" },
      agent_id: AGENT,
    });
  });

  test("an agent key updates the pull request of a pushed request only", async () => {
    const pushed = harness({ authorization: policy });
    pushed.saved.push(pulled);
    pushed.setOpen({ ...pulled, state: "open" });
    await pushed.service.update(submitter, SESSION, PUSH, {
      readBody: async () => ({ title: "Ready" }),
    });
    expect(pushed.titles.get(7)).toBe("Ready");

    const pushing = harness({ authorization: policy, state: "pushing" });
    pushing.saved.push(pulled);
    expect(
      await refusal(
        pushing.service.update(submitter, SESSION, PUSH, {
          readBody: async () => ({ title: "Not yet" }),
        }),
      ),
    ).toMatchObject({
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed", push_request_state: "pushing" },
    });
    expect(pushing.calls).toEqual([]);
  });

  test("an agent key closes and reopens the pull request of a pushed request only, and not on another agent's session", async () => {
    const pushed = harness({ authorization: policy });
    pushed.saved.push(pulled);
    pushed.setOpen({ ...pulled, state: "open" });
    await pushed.service.setState(submitter, SESSION, PUSH, "closed");
    await pushed.service.setState(submitter, SESSION, PUSH, "open");
    expect(pushed.calls).toEqual([
      "read 7",
      "state 7 closed",
      "read 7",
      "state 7 open",
    ]);
    expect(pushed.receipts[0]?.actor).toMatchObject({
      principal: { kind: "api_key", id: "agent-key-1" },
      agent_id: AGENT,
    });

    const pushing = harness({ authorization: policy, state: "pushing" });
    pushing.saved.push(pulled);
    expect(
      await refusal(
        pushing.service.setState(submitter, SESSION, PUSH, "closed"),
      ),
    ).toMatchObject({
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed", push_request_state: "pushing" },
    });
    expect(pushing.calls).toEqual([]);

    const otherAgent = createAuthorizationPolicy({
      identity: {
        reread: async ({ principal }) => ({
          status: "ok",
          principal,
          keyAgentId: "019a0000-0000-7000-8000-0000000000c2",
        }),
      },
      agents: {
        agentOf: async () => AGENT,
        isAdmin: async () => false,
      },
    });
    const foreign = harness({ authorization: otherAgent });
    foreign.saved.push(pulled);
    foreign.setOpen({ ...pulled, state: "open" });
    expect(
      (
        await refusal(
          foreign.service.setState(submitter, SESSION, PUSH, "closed"),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(foreign.calls).toEqual([]);
    expect(foreign.forgePullRequest()?.state).toBe("open");
  });

  test("a submitter cannot open or comment for a request that is not pushed, where an approver may comment", async () => {
    const opening = harness({ authorization: policy, state: "pushing" });
    expect(
      (
        await refusal(
          opening.service.open(submitter, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("PUSH_NOT_PUSHED");
    expect(opening.calls).toEqual([]);

    const commenting = harness({ authorization: policy, state: "pushing" });
    commenting.saved.push(pulled);
    expect(
      await refusal(
        commenting.service.comment(submitter, SESSION, PUSH, {
          readBody: async () => ({ body: "Not yet" }),
        }),
      ),
    ).toMatchObject({
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed", push_request_state: "pushing" },
    });
    expect(commenting.calls).toEqual([]);

    const approving = harness({ state: "pushing" });
    approving.saved.push(pulled);
    await approving.service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Approver note" }),
    });
    expect(approving.calls).toEqual(["comment 7"]);
  });

  test("a caller with sessions:approve whose share only lets it submit opens as a submitter", async () => {
    const asked: string[] = [];
    const allowing =
      (allowed: readonly string[]): AuthorizationPolicy["authorize"] =>
      async ({ action }) => {
        asked.push(action);
        return {
          outcome: allowed.includes(action) ? "allow" : "deny",
          reason_code: allowed.includes(action) ? "ok" : "role",
          effective_scopes: [],
          policy_version: "test",
          decision_id: crypto.randomUUID(),
        };
      };
    const submitOnly: AuthorizationPolicy = {
      authorize: allowing(["session.submit"]),
    };
    const pushed = harness({ authorization: submitOnly });
    expect(
      await pushed.service.open(actor, SESSION, PUSH, {
        readBody: async () => ({}),
      }),
    ).toMatchObject({ created: true });
    expect(asked).toEqual(["session.approve", "session.submit"]);

    const pushing = harness({ authorization: submitOnly, state: "pushing" });
    expect(
      (
        await refusal(
          pushing.service.open(actor, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("PUSH_NOT_PUSHED");
    expect(pushing.calls).toEqual([]);

    const neither = harness({ authorization: { authorize: allowing([]) } });
    expect(
      (
        await refusal(
          neither.service.open(actor, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(neither.calls).toEqual([]);
  });

  test("an agent key on another agent's session is FORBIDDEN before GitHub is asked", async () => {
    const other = createAuthorizationPolicy({
      identity: {
        reread: async ({ principal }) => ({
          status: "ok",
          principal,
          keyAgentId: "019a0000-0000-7000-8000-0000000000c2",
        }),
      },
      agents: {
        agentOf: async () => AGENT,
        isAdmin: async () => false,
      },
    });
    const { service, calls } = harness({ authorization: other });
    expect(
      (
        await refusal(
          service.open(submitter, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(calls).toEqual([]);
  });
});

const SIGNATURE =
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

describe("structured fields", () => {
  test("open writes the default template, in Korean, then the tail", async () => {
    const { service, created } = harness();
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({
        title: "Add login",
        summary: "Adds the login form.",
        changes: ["Form", "Route"],
        testing: "bun test",
        related: [{ number: 12, closes: true }],
      }),
    });
    expect(opened.body_source).toEqual({ kind: "platform" });
    expect(created[0]?.body).toBe(
      [
        "## 요약",
        "Adds the login form.",
        "",
        "## 변경 사항",
        `- ${ZWSP}Form`,
        `- ${ZWSP}Route`,
        "",
        "## 테스트",
        "bun test",
        "",
        "## 관련 이슈",
        "- Closes #12",
        "",
        TAIL,
      ].join("\n"),
    );
  });

  test("a related repository outside the catalog is dropped and reported", async () => {
    const { service, created } = harness();
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({
        summary: "x",
        related: [
          { number: 1, repository_id: "ghost", closes: true },
          { number: 2, repository_id: "app", closes: false },
        ],
      }),
    });
    expect(opened.body_source).toEqual({
      kind: "platform",
      related_dropped: 1,
    });
    expect(created[0]?.body).toContain("- Refs #2");
    expect(created[0]?.body).not.toContain("#1");
  });

  test("update writes the whole body again from the fields; a field left out is empty", async () => {
    const { service, bodies } = harness();
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ summary: "First", notes: "Old note" }),
    });
    expect(bodies.get(7)).toContain("Old note");
    const updated = await service.update(actor, SESSION, PUSH, {
      readBody: async () => ({ summary: "Second" }),
    });
    expect(updated.body_source).toEqual({ kind: "platform" });
    expect(bodies.get(7)).toBe(`## 요약\nSecond\n\n${TAIL}`);
  });

  test("update with a legacy body or a title alone reports where the body came from", async () => {
    const { service } = harness();
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ summary: "First" }),
    });
    expect(
      (
        await service.update(actor, SESSION, PUSH, {
          readBody: async () => ({ body: "Plain" }),
        })
      ).body_source,
    ).toEqual({ kind: "agent" });
    expect(
      (
        await service.update(actor, SESSION, PUSH, {
          readBody: async () => ({ title: "Only" }),
        })
      ).body_source,
    ).toBeNull();
  });

  test("a pull request that was already open keeps its body and reports none written", async () => {
    const h = harness();
    await h.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ summary: "First" }),
    });
    const again = await h.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ summary: "Second" }),
    });
    expect(again).toMatchObject({ created: false, body_source: null });
  });
});

describe("the repository's pull request template", () => {
  const TEMPLATE = [
    "## Summary",
    "<!-- What is this -->",
    "",
    "## Changes",
    "- [ ] Docs updated",
    "",
    "## Testing",
    "<!-- How was it tested -->",
  ].join("\n");
  const FIELDS = {
    summary: "Adds the login form.",
    changes: ["Form"],
    testing: "bun test",
  };

  test("fields fill the sections of the default branch's template; the comments and the checkbox stay, and the receipt names the template", async () => {
    const repository = fakeRepositoryReads({
      ".github/pull_request_template.md": TEMPLATE,
    });
    const { service, created, receipts } = harness({ repository });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    expect(opened.body_source).toEqual({
      kind: "repository",
      path: ".github/pull_request_template.md",
    });
    expect(created[0]?.body).toBe(
      [
        "## Summary",
        "<!-- What is this -->",
        "",
        "Adds the login form.",
        "",
        "## Changes",
        "",
        `- ${ZWSP}Form`,
        "",
        "- [ ] Docs updated",
        "",
        "## Testing",
        "<!-- How was it tested -->",
        "",
        "bun test",
        "",
        TAIL,
      ].join("\n"),
    );
    expect(receipts.at(-1)).toMatchObject({
      template: {
        commit: "c1",
        path: ".github/pull_request_template.md",
        blob_sha: "c1:blob:.github/pull_request_template.md",
      },
    });
  });

  test("the pull request's own base is not where the template is read: the default branch is", async () => {
    // The catalog's base is `develop`; the repository's default branch is `trunk`.
    const repository = fakeRepositoryReads(
      { "pull_request_template.md": "## Summary\n" },
      { defaultBranch: "trunk" },
    );
    const { service, created, calls } = harness({ repository });
    await service.open(actor, SESSION, PUSH, { readBody: async () => FIELDS });
    expect(created[0]?.base).toBe("develop");
    expect(repository.calls).toContain("branch trunk");
    expect(repository.calls).not.toContain("branch develop");
    expect(repository.calls.some((call) => call.includes(HEAD))).toBe(false);
    expect(calls).not.toContain(`read ${HEAD}`);
  });

  test("two templates in the directory: the platform's layout, and the receipt says why", async () => {
    const repository = fakeRepositoryReads({
      "docs/PULL_REQUEST_TEMPLATE/a.md": "## A",
      "docs/PULL_REQUEST_TEMPLATE/b.md": "## B",
    });
    const { service, created, receipts } = harness({ repository });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    expect(opened.body_source).toEqual({
      kind: "platform",
      path: "docs/PULL_REQUEST_TEMPLATE",
      skipped: "multiple",
    });
    expect(created[0]?.body.startsWith("## 요약\nAdds the login form.")).toBe(
      true,
    );
    expect(receipts.at(-1)).toMatchObject({
      template: { commit: "c1", skipped: "multiple" },
    });
  });

  test("a repository with no template is laid out as before and the receipt names the commit read", async () => {
    const { service, receipts } = harness();
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    expect(opened.body_source).toEqual({ kind: "platform" });
    expect(receipts.at(-1)).toMatchObject({ template: { commit: "c1" } });
  });

  test("a template that cannot be read does not stop the pull request: it opens on the default layout", async () => {
    const repository = fakeRepositoryReads(
      { ".github/pull_request_template.md": TEMPLATE },
      { failing: { tree: 502 } },
    );
    const { service, created, warnings } = harness({ repository });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    expect(opened.created).toBe(true);
    expect(opened.body_source).toEqual({
      kind: "platform",
      skipped: "read_failed",
    });
    expect(created[0]?.body.startsWith("## 요약\n")).toBe(true);
    expect(warnings).toContain("Pull request template not read");
  });

  test("a legacy body is kept as written and the repository is not read for it", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": TEMPLATE,
    });
    const { service, created, receipts } = harness({ repository });
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "As written" }),
    });
    expect(created[0]?.body).toBe(`As written\n\n${TAIL}`);
    expect(repository.calls).toEqual([]);
    expect(
      (receipts.at(-1) as { template?: unknown }).template ?? null,
    ).toBeNull();
  });

  test("a hostile template does not reach the pull request live: no mention, no closing keyword, no tail or co-author of its own", async () => {
    const hostile = [
      "## Summary",
      "Thanks @octocat, Fixes #1",
      PULL_REQUEST_TAIL_MARKER,
      "Co-authored-by: Mallory <m@example.com>",
      PULL_REQUEST_TAIL_END_MARKER,
    ].join("\n");
    const repository = fakeRepositoryReads({
      "pull_request_template.md": hostile,
    });
    const { service, created } = harness({ repository });
    await service.open(actor, SESSION, PUSH, { readBody: async () => FIELDS });
    const body = created[0]?.body ?? "";
    expect(body).toContain(`@${ZWSP}octocat`);
    expect(body).toContain(`F${ZWSP}ixes #${ZWSP}1`);
    expect(body).not.toContain("\nCo-authored-by: Mallory");
    const lines = body.split("\n");
    expect(lines.filter((l) => l === PULL_REQUEST_TAIL_MARKER)).toHaveLength(1);
    expect(body.endsWith(TAIL)).toBe(true);
  });

  test("update reads the default branch again and records the template it used", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\n",
    });
    const { service, bodies, receipts } = harness({ repository });
    await service.open(actor, SESSION, PUSH, { readBody: async () => FIELDS });
    repository.move({ "docs/pull_request_template.md": "## Testing\n" });
    const updated = await service.update(actor, SESSION, PUSH, {
      readBody: async () => ({ testing: "bun test", summary: "Later" }),
    });
    expect(updated.body_source).toEqual({
      kind: "repository",
      path: "docs/pull_request_template.md",
    });
    expect(bodies.get(7)).toContain("## Testing\n\nbun test");
    expect(bodies.get(7)).toContain("## 요약\nLater");
    expect(receipts.at(-1)).toMatchObject({
      operation: "update_pull_request",
      result: {
        template: { commit: "c2", path: "docs/pull_request_template.md" },
      },
    });
  });

  test("a pull request that was already open records no template: its body was not written", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\n",
    });
    const h = harness({ repository });
    h.setOpen({
      number: 9,
      url: "https://github.com/acme/app/pull/9",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    await h.service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    expect(
      (h.receipts.at(-1) as { template?: unknown }).template ?? null,
    ).toBeNull();
  });

  test("a template too long beside the fields falls back to the platform's layout and says so", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": `## Summary\n${"x".repeat(3000)}`,
    });
    const { service, created } = harness({ repository, maxBodyLength: 1500 });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    expect(opened.body_source).toMatchObject({
      kind: "platform",
      path: "pull_request_template.md",
      skipped: "too_large",
    });
    expect(created[0]?.body.length).toBeLessThanOrEqual(1500);
    expect(created[0]?.body).not.toContain("xxxx");
  });
});

describe("the workspace's pull request settings", () => {
  const FIELDS = { summary: "Adds the login form.", testing: "bun test" };
  const bodyOf = async (options: Parameters<typeof harness>[0]) => {
    const made = harness(options);
    const opened = await made.service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    return { ...made, opened, body: made.created[0]?.body ?? "" };
  };

  test("the settings are read for the workspace that owns the session", async () => {
    const { settingsReads } = await bodyOf({});
    expect(settingsReads).toEqual(["owner-a"]);
  });

  test("with `override`, the workspace's template is used and the repository's is not even read", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\nrepository's\n",
    });
    const { opened, body, receipts } = await bodyOf({
      repository,
      layout: {
        template_mode: "override",
        default_template: "## Summary\n<!-- ours -->\n\n## Testing\n",
      },
    });
    expect(opened.body_source).toEqual({ kind: "workspace" });
    expect(body).toContain("<!-- ours -->\n\nAdds the login form.");
    expect(body).toContain("## Testing\n\nbun test");
    expect(body).not.toContain("repository's");
    expect(repository.calls).toEqual([]);
    expect(receipts.at(-1)).toMatchObject({ template: { commit: null } });
  });

  test("with `override` and no template of its own, the platform's default is laid out", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\nrepository's\n",
    });
    const { opened, body } = await bodyOf({
      repository,
      layout: { template_mode: "override" },
    });
    expect(opened.body_source).toEqual({ kind: "platform" });
    expect(body.startsWith("## 요약\nAdds the login form.")).toBe(true);
    expect(repository.calls).toEqual([]);
  });

  test("`repository_first` uses the workspace's template only where the repository has none", async () => {
    const layout = { default_template: "## Summary\n<!-- ours -->\n" };
    const bare = await bodyOf({ layout });
    expect(bare.opened.body_source).toEqual({ kind: "workspace" });
    expect(bare.body).toContain("<!-- ours -->\n\nAdds the login form.");

    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\n<!-- theirs -->\n",
    });
    const held = await bodyOf({ layout, repository });
    expect(held.opened.body_source).toEqual({
      kind: "repository",
      path: "pull_request_template.md",
    });
    expect(held.body).toContain("<!-- theirs -->");
    expect(held.body).not.toContain("<!-- ours -->");
  });

  test("with `formatting: off`, no template is read or used, and the fields still land on the platform's layout", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\nrepository's\n",
    });
    const { opened, body } = await bodyOf({
      repository,
      layout: {
        formatting: "off",
        template_mode: "override",
        default_template: "## Summary\n<!-- ours -->\n",
      },
    });
    expect(opened.body_source).toEqual({ kind: "platform" });
    expect(body.startsWith("## 요약\nAdds the login form.")).toBe(true);
    expect(body).not.toContain("<!-- ours -->");
    expect(repository.calls).toEqual([]);
  });

  test("a legacy body is kept as written whatever the settings say", async () => {
    const { service, created } = harness({
      layout: {
        template_mode: "override",
        default_template: "## Summary\n<!-- ours -->\n",
      },
    });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Plain words" }),
    });
    expect(opened.body_source).toEqual({ kind: "agent" });
    expect(created[0]?.body).toBe(`Plain words\n\n${TAIL}`);
  });

  test("the workspace's template goes through the same cleaning as the repository's: no mention, keyword, tail or co-author of its own", async () => {
    const hostile = [
      "## Summary",
      "Thanks @octocat, Fixes #1",
      PULL_REQUEST_TAIL_MARKER,
      "Co-authored-by: Mallory <m@example.com>",
      PULL_REQUEST_TAIL_END_MARKER,
    ].join("\n");
    const { body } = await bodyOf({
      layout: { template_mode: "override", default_template: hostile },
    });
    expect(body).toContain(`@${ZWSP}octocat`);
    expect(body).toContain(`F${ZWSP}ixes #${ZWSP}1`);
    expect(body).not.toContain("\nCo-authored-by: Mallory");
    const lines = body.split("\n");
    expect(lines.filter((l) => l === PULL_REQUEST_TAIL_MARKER)).toHaveLength(1);
    expect(body.endsWith(TAIL)).toBe(true);
  });

  test("a stored template the platform would not use falls back to the default layout and the receipt says why", async () => {
    // The save refuses these; a row from another image, or edited by hand, must not stop the pull request.
    for (const [text, skipped] of [
      ["x".repeat(16 * 1024 + 1), "too_large"],
      ["## Summary\n<!-- never closed", "unbalanced_comment"],
    ] as const) {
      const { opened, body, receipts } = await bodyOf({
        layout: { template_mode: "override", default_template: text },
      });
      expect(opened.body_source).toEqual({ kind: "platform", skipped });
      expect(body.startsWith("## 요약\nAdds the login form.")).toBe(true);
      expect(receipts.at(-1)).toMatchObject({
        template: { commit: null, skipped },
      });
    }
  });

  test("`session_link: id` leaves the console's address out of the tail on open and on update", async () => {
    const { service, created, bodies } = harness({
      layout: { session_link: "id" },
    });
    await service.open(actor, SESSION, PUSH, { readBody: async () => FIELDS });
    const opened = created[0]?.body ?? "";
    expect(opened).not.toContain("console.example.com");
    expect(opened).toContain(`- Session: \`${SESSION}\``);
    expect(opened).toContain("Opened in a Werft session · commit `aaaaaaa`");

    await service.update(actor, SESSION, PUSH, {
      readBody: async () => ({ summary: "Again" }),
    });
    expect([...bodies.values()].join("\n")).not.toContain(
      "console.example.com",
    );
  });

  test("the default still links the session", async () => {
    const { body } = await bodyOf({});
    expect(body).toContain("console.example.com/sessions/");
  });
});

describe("a session that still sends the legacy body", () => {
  test("opens with the body as written, cleaned, and the tail below it", async () => {
    const { service, created } = harness();
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ title: "Old way", body: "## Summary\n- one" }),
    });
    expect(opened.body_source).toEqual({ kind: "agent" });
    expect(created[0]?.body).toBe(`## Summary\n- one\n\n${TAIL}`);
  });

  test("the engine's own signature line is removed from the body and from a comment", async () => {
    const { service, created, comments } = harness();
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ body: `Work done\n\n${SIGNATURE}` }),
    });
    expect(created[0]?.body).toBe(`Work done\n\n${TAIL}`);
    await service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: `Looks fine\n\n${SIGNATURE}` }),
    });
    expect(comments[0]?.body).toBe("Looks fine");
  });

  test("no content at all opens with the tail alone, as before", async () => {
    const { service, created } = harness();
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(opened.body_source).toEqual({ kind: "platform" });
    expect(created[0]?.body).toBe(TAIL);
  });
});

describe("the agent's pull request settings", () => {
  const FIELDS = { summary: "Adds the login form.", testing: "bun test" };
  const agent = (over: Partial<AgentPullRequestSettings>) => ({
    formatting: "inherit" as const,
    template: null,
    template_name: null,
    ...over,
  });
  const bodyOf = async (options: Parameters<typeof harness>[0]) => {
    const made = harness(options);
    const opened = await made.service.open(actor, SESSION, PUSH, {
      readBody: async () => FIELDS,
    });
    return { ...made, opened, body: made.created[0]?.body ?? "" };
  };

  test("the agent is looked up through the session, in the session's workspace", async () => {
    const { agentReads } = await bodyOf({});
    expect(agentReads).toEqual([`owner-a/${SESSION}`]);
  });

  test("its template beats the workspace's under `override`, and the body says whose it is", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\nrepository's\n",
    });
    const { opened, body, receipts } = await bodyOf({
      repository,
      layout: {
        template_mode: "override",
        default_template: "## Summary\n<!-- workspace -->\n",
      },
      agent: agent({ template: "## Summary\n<!-- agent -->\n" }),
    });
    expect(opened.body_source).toEqual({ kind: "agent" });
    expect(body).toContain("<!-- agent -->\n\nAdds the login form.");
    expect(body).not.toContain("workspace");
    expect(repository.calls).toEqual([]);
    expect(receipts.at(-1)).toMatchObject({ template: { commit: null } });
  });

  test("under `repository_first` it stands in only where the repository has none", async () => {
    const own = agent({ template: "## Summary\n<!-- agent -->\n" });
    const bare = await bodyOf({ agent: own });
    expect(bare.opened.body_source).toEqual({ kind: "agent" });
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\n<!-- theirs -->\n",
    });
    const held = await bodyOf({ agent: own, repository });
    expect(held.opened.body_source).toMatchObject({ kind: "repository" });
    expect(held.body).toContain("<!-- theirs -->");
  });

  test("`formatting: off` on the agent beats a workspace that has formatting on; `on` beats an `off` one", async () => {
    const repository = fakeRepositoryReads({
      "pull_request_template.md": "## Summary\nrepository's\n",
    });
    const off = await bodyOf({
      repository,
      agent: agent({ formatting: "off", template: "## Summary\n<!-- a -->\n" }),
    });
    expect(off.opened.body_source).toEqual({ kind: "platform" });
    expect(repository.calls).toEqual([]);
    const on = await bodyOf({
      layout: { formatting: "off" },
      agent: agent({ formatting: "on", template: "## Summary\n<!-- a -->\n" }),
    });
    expect(on.opened.body_source).toEqual({ kind: "agent" });
  });

  test("`template_name` picks one file of a directory that holds several", async () => {
    const files = {
      "docs/PULL_REQUEST_TEMPLATE/bug.md": "## Summary\n<!-- bug -->\n",
      "docs/PULL_REQUEST_TEMPLATE/feature.md": "## Summary\n<!-- feature -->\n",
    };
    const none = await bodyOf({ repository: fakeRepositoryReads(files) });
    expect(none.opened.body_source).toMatchObject({ skipped: "multiple" });
    const named = await bodyOf({
      repository: fakeRepositoryReads(files),
      agent: agent({ template_name: "Feature.MD" }),
    });
    expect(named.opened.body_source).toEqual({
      kind: "repository",
      path: "docs/PULL_REQUEST_TEMPLATE/feature.md",
    });
    expect(named.body).toContain("<!-- feature -->");
    expect(named.body).not.toContain("<!-- bug -->");
  });
});

describe("merging the pull request", () => {
  const recorded: PullRequest = {
    push_request_id: PUSH,
    session_id: SESSION,
    repository_id: "app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    head: HEAD,
    base: "develop",
    created_at: "2026-10-13T00:00:00.000Z",
    receipt_id: "receipt-0",
  };
  const withPullRequest = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness(options);
    h.saved.push(recorded);
    h.setOpen({ ...recorded, state: "open" });
    return h;
  };
  const merge = (h: ReturnType<typeof harness>, push = PUSH) =>
    h.service.merge(actor, SESSION, push);

  test("squash-merges on the pushed commit, asks the gate for a merge, and records it", async () => {
    const h = withPullRequest();
    expect(await merge(h)).toMatchObject({
      merged: true,
      changed: true,
      head_sha: "a".repeat(40),
      merge_commit_sha: "c".repeat(40),
      method: "squash",
    });
    expect(h.calls).toEqual(["read 7", "find develop", `merge 7 a`]);
    expect(h.works.map((work) => work.purpose)).toEqual(["merge"]);
    expect(h.receipts.at(-1)).toMatchObject({
      operation: "merge_pull_request",
      result: { verdict: "allow", merged: true, method: "squash" },
    });
    expect(h.dueAgain).toEqual([recorded.url]);
  });

  test("a gate refusal (merge_off) ends it before the forge is called", async () => {
    const h = withPullRequest();
    h.refuseGitHub("merge_off");
    expect(await refusal(merge(h))).toMatchObject({
      code: "GITHUB_REFUSED",
      details: { refusal: "github_refused", reason_code: "merge_off" },
    });
    expect(h.calls).toEqual([]);
    expect(h.receipts.at(-1)).toMatchObject({
      operation: "merge_pull_request",
      result: { verdict: "refuse", refusal: "github_refused" },
    });
  });

  test("only the push request of this session: another id is NOT_FOUND and nothing is read", async () => {
    const h = withPullRequest();
    expect(
      await refusal(merge(h, "55555555-5555-4555-8555-555555555555")),
    ).toMatchObject({ code: "NOT_FOUND", details: { refusal: "not_found" } });
    expect(h.calls).toEqual([]);
    expect(h.works).toEqual([]);
  });

  test("a pull request that is not recorded, or a push request not pushed, is refused first", async () => {
    const none = harness();
    expect((await refusal(merge(none))).details).toMatchObject({
      refusal: "no_pull_request",
    });
    const waiting = withPullRequest({ state: "approved" });
    expect((await refusal(merge(waiting))).details).toMatchObject({
      refusal: "not_pushed",
    });
    expect(waiting.calls).toEqual([]);
  });

  test("a head that is not the pushed commit is head_moved, and no PUT is sent", async () => {
    const h = withPullRequest();
    h.setOpen({ ...recorded, state: "open" }, "f".repeat(40));
    expect(await refusal(merge(h))).toMatchObject({
      code: "PUSH_REQUEST_RESOLVED",
      details: { refusal: "head_moved" },
    });
    expect(h.calls).toEqual(["read 7"]);
  });

  test("a state GitHub does not call mergeable is merge_blocked without a PUT", async () => {
    for (const state of ["blocked", "dirty", "draft", "behind", "unknown"]) {
      const h = withPullRequest();
      h.setMergeable(state);
      expect(await refusal(merge(h))).toMatchObject({
        code: "PULL_REQUEST_MERGE_BLOCKED",
        details: { refusal: "merge_blocked" },
      });
      expect(h.calls).toEqual(["read 7"]);
    }
    const unread = withPullRequest();
    unread.setMergeable(null);
    expect((await refusal(merge(unread))).details).toMatchObject({
      refusal: "merge_blocked",
    });
  });

  test("a merge GitHub did not do is head_moved when the head moved meanwhile and merge_blocked when it did not", async () => {
    const blocked = withPullRequest();
    blocked.declineMerge(false);
    expect((await refusal(merge(blocked))).details).toMatchObject({
      refusal: "merge_blocked",
    });
    expect(blocked.calls).toEqual([
      "read 7",
      "find develop",
      "merge 7 a",
      "read 7",
    ]);
    const moved = withPullRequest();
    moved.declineMerge(true);
    expect((await refusal(merge(moved))).details).toMatchObject({
      refusal: "head_moved",
    });
  });

  test("a pull request whose base is another open pull request's head is not sent, since GitHub would merge that one too", async () => {
    const h = withPullRequest();
    h.stackOn("develop");
    expect((await refusal(merge(h))).details).toMatchObject({
      refusal: "merge_blocked",
    });
    expect(h.calls).toEqual(["read 7", "find develop"]);
  });

  test("a merge still queued when the wait ends is forge_failed unless it has merged by then, and the retry finds it merged", async () => {
    const queued = withPullRequest();
    queued.failMerge(202);
    expect((await refusal(merge(queued))).details).toMatchObject({
      refusal: "forge_failed",
    });
    const done = withPullRequest();
    done.failMerge(202, true);
    // Found merged, it cannot be told whose merge or which method.
    expect(await merge(done)).toMatchObject({
      merged: true,
      changed: false,
      method: null,
      head_sha: "a".repeat(40),
    });
    const retry = await merge(done);
    expect(retry).toMatchObject({ merged: true, changed: false, method: null });
  });

  test("a pull request merged by someone between the read and the request is answered unchanged, with no method", async () => {
    const h = withPullRequest();
    h.raceMerge(false);
    expect(await merge(h)).toMatchObject({
      merged: true,
      changed: false,
      method: null,
      head_sha: "a".repeat(40),
      merge_commit_sha: "e".repeat(40),
    });
    const moved = withPullRequest();
    moved.raceMerge(true);
    expect((await refusal(merge(moved))).details).toMatchObject({
      refusal: "head_moved",
    });
  });

  test("a pull request retargeted since it was opened is not sent, since GitHub would merge what it is stacked on", async () => {
    const h = withPullRequest();
    h.setOpen({ ...recorded, state: "open", base: "someone-elses-branch" });
    expect((await refusal(merge(h))).details).toMatchObject({
      refusal: "merge_blocked",
    });
    expect(h.calls).toEqual(["read 7"]);
  });

  test("GitHub's 400 and 405 are merge_blocked and its 409 is head_moved", async () => {
    const closedOrDraft = withPullRequest();
    closedOrDraft.failMerge(400);
    expect((await refusal(merge(closedOrDraft))).details).toMatchObject({
      refusal: "merge_blocked",
    });
    const blocked = withPullRequest();
    blocked.failMerge(405);
    expect((await refusal(merge(blocked))).details).toMatchObject({
      refusal: "merge_blocked",
    });
    const moved = withPullRequest();
    moved.failMerge(409);
    expect((await refusal(merge(moved))).details).toMatchObject({
      refusal: "head_moved",
    });
    const down = withPullRequest();
    down.failMerge(502);
    expect(
      (await refusal(down.service.merge(actor, SESSION, PUSH))).details,
    ).toMatchObject({ refusal: "forge_failed" });
  });

  test("a pull request closed without a merge is pull_request_closed", async () => {
    const h = withPullRequest();
    h.setOpen({ ...recorded, state: "closed" });
    expect(await refusal(merge(h))).toMatchObject({
      code: "PULL_REQUEST_CLOSED",
      details: { refusal: "pull_request_closed" },
    });
    expect(h.calls).toEqual(["read 7"]);
  });

  test("an already merged pull request is answered when it merged the pushed commit, with no method", async () => {
    const h = withPullRequest();
    h.merge();
    expect(await merge(h)).toMatchObject({
      merged: true,
      changed: false,
      head_sha: "a".repeat(40),
      merge_commit_sha: "c".repeat(40),
      method: null,
    });
    expect(h.calls).toEqual(["read 7"]);
    expect(h.dueAgain).toEqual([]);
  });

  test("an already merged pull request on another commit is head_moved", async () => {
    const h = withPullRequest();
    h.setOpen({ ...recorded, state: "open" }, "f".repeat(40));
    h.merge();
    expect((await refusal(merge(h))).details).toMatchObject({
      refusal: "head_moved",
    });
  });
});
