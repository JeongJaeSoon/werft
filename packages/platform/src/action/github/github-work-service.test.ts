import { describe, expect, test } from "bun:test";
import type { Principal } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import { createAuthorizationPolicy } from "../../musterrolle/policy.ts";
import {
  GitHubCallError,
  type GitHubGate,
  GitHubGateError,
  type GitHubGateReceipt,
  type GitHubGrant,
  type GitHubWork,
} from "../../ports/github-gate.ts";
import { SessionServiceError } from "../../sessions/session-service.ts";
import { ForgeCredentialError } from "../ports/forge.ts";
import type { GitHubApi } from "../ports/github-api.ts";
import {
  createGitHubWorkService,
  type GitHubWorkStore,
} from "./github-work-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const SECRET_INPUT = "s3cret-input-value";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const principal: Principal = {
  kind: "api_key",
  id: "owner-a",
  owner_id: "owner-a",
  workspace_id: null,
  scopes: ["sessions:read", "sessions:write"],
};
const actor = {
  caller: testCaller("owner-a"),
  principal,
  ownerId: "owner-a",
  verified: true,
};

function harness(
  options: {
    refuse?: GitHubGateError | ForgeCredentialError;
    fail?: GitHubCallError;
    run?: { id: number; html_url: string } | null;
    /** The status of each successive run read; the last one repeats. */
    statuses?: string[];
    /** Which call never answers: the grant, the first read or a later one. */
    hang?: "grant" | "read" | "later-read";
    /** Fails the pull request read only; `fail` fails the writes. */
    failRead?: GitHubCallError;
    /** The head the forge reports; the reviewed commit by default. */
    head?: string;
  } = {},
) {
  let clock = 0;
  const works: GitHubWork[] = [];
  const calls: string[] = [];
  const receipts: GitHubGateReceipt[] = [];
  const dispatches: Parameters<GitHubWorkStore["recordDispatch"]>[0][] = [];
  const reviews: Parameters<GitHubWorkStore["recordReview"]>[0][] = [];
  const fail = () => {
    if (options.fail) throw options.fail;
  };
  const api: GitHubApi = {
    maxBodyLength: 65_536,
    getRepository: async () => {
      throw new Error("not used");
    },
    getBranchHead: async () => {
      throw new Error("not used");
    },
    readTree: async () => {
      throw new Error("not used");
    },
    readBlob: async () => {
      throw new Error("not used");
    },
    findPullRequestForBranch: async () => {
      throw new Error("not used");
    },
    findPullRequestsForBranch: async () => {
      throw new Error("not used");
    },
    isAncestor: async () => {
      throw new Error("not used");
    },
    createPullRequest: async () => {
      throw new Error("not used");
    },
    getPullRequest: async (number) => {
      calls.push(`pull ${number}`);
      if (options.failRead) throw options.failRead;
      return {
        pullRequest: {
          number,
          url: `https://github.com/acme/app/pull/${number}`,
          state: "open",
          head: "agent/x",
          headSha: ("head" in options ? options.head : HEAD) as string,
          base: "main",
          mergedAt: null,
          closedAt: null,
          title: "t",
          mergeCommitSha: null,
          additions: null,
          deletions: null,
          changedFiles: null,
          commits: null,
        },
        rateLimit: {} as never,
      };
    },
    updatePullRequestBody: async () => {
      throw new Error("not used");
    },
    setPullRequestState: async () => {
      throw new Error("not used");
    },
    mergePullRequest: async () => {
      throw new Error("not used");
    },
    upsertComment: async () => {
      throw new Error("not used");
    },
    dispatchWorkflow: async (input) => {
      calls.push(`dispatch ${input.workflow} ${input.ref}`);
      fail();
      return options.run === undefined
        ? { id: 42, html_url: "https://github.com/acme/app/actions/runs/42" }
        : options.run;
    },
    getWorkflowRun: async (runId) => {
      calls.push(`run ${runId}`);
      fail();
      const reads = calls.filter((call) => call.startsWith("run ")).length;
      if (
        (options.hang === "read" && reads === 1) ||
        (options.hang === "later-read" && reads > 1)
      ) {
        return new Promise<never>(() => {});
      }
      const statuses = options.statuses ?? ["completed"];
      const status = statuses[Math.min(reads, statuses.length) - 1] ?? null;
      return {
        id: runId,
        path: ".github/workflows/ci.yml",
        head_branch: "main",
        status,
        conclusion: status === "completed" ? "success" : null,
        html_url: `https://github.com/acme/app/actions/runs/${runId}`,
      };
    },
    rerunWorkflow: async (runId, failedOnly) => {
      calls.push(`rerun ${runId} ${failedOnly}`);
      fail();
    },
    submitReview: async (input) => {
      calls.push(
        `review ${input.number} ${input.event} ${input.commitId} ${input.body ?? "-"}`,
      );
      fail();
      return {
        id: 77,
        html_url: `https://github.com/acme/app/pull/${input.number}#pullrequestreview-77`,
      };
    },
  };
  const gate: GitHubGate = {
    grant: async (work) => {
      works.push(work);
      if (options.hang === "grant") return new Promise<never>(() => {});
      if (options.refuse) throw options.refuse;
      const grant: GitHubGrant = {
        role: "author",
        repo: { owner: "acme", name: "app" },
        permissions: { actions: "write" },
        gitCredential: { username: "x-access-token", password: "issued" },
        api,
        unit: async () => "app:test:1",
        allowedBy: { workflow: "ci.yml" },
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: "agent-1",
          agentReleaseId: "release-1",
          repositoryId: "app",
          policy: {},
        },
      };
      return grant;
    },
  };
  const store: GitHubWorkStore = {
    recordReceipt: async (receipt) => {
      receipts.push(receipt);
      return `receipt-${receipts.length}`;
    },
    recordDispatch: async (input) => {
      dispatches.push(input);
      return "receipt-dispatch";
    },
    recordReview: async (input) => {
      reviews.push(input);
      receipts.push({
        ownerId: input.context.ownerId,
        sessionId: input.context.sessionId,
        actor: input.actor,
        operation: "review_pull_request",
        status: "succeeded",
        result: input.result,
        error: null,
      });
      return `receipt-${receipts.length}`;
    },
    pullRequestOpener: async (ownerId, repositoryId, number) => {
      calls.push(`opener ${ownerId} ${repositoryId} ${number}`);
      return number === 12
        ? {
            sessionId: "33333333-3333-4333-8333-333333333333",
            agentId: "agent-1",
          }
        : null;
    },
  };
  const service = createGitHubWorkService({
    authorization: createAuthorizationPolicy(),
    gate,
    store,
    redact: (line) => (line.includes("ghp_") ? "[REDACTED]" : line),
    pollMs: 1_000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return {
    service,
    works,
    calls,
    receipts,
    dispatches,
    reviews,
    elapsedMs: () => clock,
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SessionServiceError);
  const { code, details } = error as SessionServiceError;
  return { code, details };
}

describe("dispatching a workflow", () => {
  test("records the dispatch with input names only", async () => {
    const { service, works, calls, dispatches, receipts } = harness();
    const answered = await service.dispatch(actor, SESSION.toUpperCase(), {
      workflow: "ci.yml",
      ref: "main",
      inputs: { target: SECRET_INPUT, env: "staging" },
    });
    expect(answered).toEqual({
      receipt_id: "receipt-dispatch",
      run: { id: 42, html_url: "https://github.com/acme/app/actions/runs/42" },
    });
    expect(works).toMatchObject([
      {
        sessionId: SESSION,
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "main" },
      },
    ]);
    expect(calls).toEqual(["dispatch ci.yml main"]);
    expect(receipts).toEqual([]);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      run: { id: 42, workflow: "ci.yml", ref: "main" },
      result: {
        session_id: SESSION,
        repository_id: "app",
        workflow: "ci.yml",
        ref: "main",
        input_keys: ["env", "target"],
        run_id: 42,
        allowed_by: { workflow: "ci.yml" },
      },
    });
    expect(JSON.stringify(dispatches)).not.toContain(SECRET_INPUT);
    expect(JSON.stringify(dispatches)).not.toContain("staging");
  });

  test("a run GitHub does not name is recorded without a run row", async () => {
    const { service, dispatches } = harness({ run: null });
    expect(
      await service.dispatch(actor, SESSION, {
        workflow: "ci.yml",
        ref: "main",
      }),
    ).toEqual({ receipt_id: "receipt-dispatch", run: null });
    expect(dispatches[0]).toMatchObject({
      run: null,
      result: { run_id: null, input_keys: [] },
    });
  });

  test("a GitHub failure is BACKEND_UNAVAILABLE with a failed receipt that keeps no input value", async () => {
    const { service, receipts, dispatches } = harness({
      fail: new GitHubCallError("dispatch", 422, "req-1"),
    });
    expect(
      await refusal(
        service.dispatch(actor, SESSION, {
          workflow: "ci.yml",
          ref: "main",
          inputs: { target: SECRET_INPUT },
        }),
      ),
    ).toEqual({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: "receipt-1" },
    });
    expect(dispatches).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      operation: "dispatch_workflow",
      status: "failed",
      result: {
        workflow: "ci.yml",
        input_keys: ["target"],
        status: 422,
        github_request_id: "req-1",
      },
    });
    expect(JSON.stringify(receipts)).not.toContain(SECRET_INPUT);
  });

  test("a gate refusal is GITHUB_REFUSED with its reason_code and receipt_id, and GitHub is not called", async () => {
    for (const reason of [
      "workflow_not_allowed",
      "over_workspace_ceiling",
    ] as const) {
      const { service, calls } = harness({
        refuse: new GitHubGateError(reason, "receipt-gate"),
      });
      expect(
        await refusal(
          service.dispatch(actor, SESSION, { workflow: "ci.yml", ref: "main" }),
        ),
      ).toEqual({
        code: "GITHUB_REFUSED",
        details: { reason_code: reason, receipt_id: "receipt-gate" },
      });
      expect(calls).toEqual([]);
    }
  });

  test("no connection reaching the repository is BACKEND_UNAVAILABLE with the gate's receipt", async () => {
    const { service, calls } = harness({
      refuse: new ForgeCredentialError("unreachable", "receipt-gate"),
    });
    expect(
      await refusal(
        service.dispatch(actor, SESSION, { workflow: "ci.yml", ref: "main" }),
      ),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: "receipt-gate" },
    });
    expect(calls).toEqual([]);
  });

  test("a caller without session.submit is refused before the gate", async () => {
    const { service, works } = harness();
    const reader = {
      ...actor,
      caller: testCaller("owner-a", ["sessions:read"]),
    };
    expect(
      (
        await refusal(
          service.dispatch(reader, SESSION, {
            workflow: "ci.yml",
            ref: "main",
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect((await refusal(service.rerun(reader, SESSION, 42, {}))).code).toBe(
      "FORBIDDEN",
    );
    expect(works).toEqual([]);
  });
});

describe("reading a run", () => {
  test("asks the gate for actions_read and answers GitHub's run", async () => {
    const { service, works } = harness();
    expect(await service.getRun(actor, SESSION, 7)).toMatchObject({
      id: 7,
      conclusion: "success",
    });
    expect(works[0]?.purpose).toBe("actions_read");
  });

  test("reads once and does not wait when no wait is asked for", async () => {
    const { service, calls, elapsedMs } = harness({
      statuses: ["in_progress"],
    });
    const run = await service.getRun(actor, SESSION, 7);
    expect(run.status).toBe("in_progress");
    expect(calls).toEqual(["run 7"]);
    expect(elapsedMs()).toBe(0);
  });

  test("a spent budget is a deadline that has passed, not a call that never waits", async () => {
    for (const hang of ["read", "grant"] as const) {
      const { service } = harness({ hang });
      const started = performance.now();
      const error = await refusal(
        service.getRun(actor, SESSION, 7, { waitMs: 0 }),
      );
      expect(error.code).toBe("BACKEND_UNAVAILABLE");
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  test("waits until the run completes and answers the finished run", async () => {
    const { service, calls, elapsedMs } = harness({
      statuses: ["queued", "in_progress", "completed"],
    });
    const run = await service.getRun(actor, SESSION, 7, { waitMs: 8_000 });
    expect(run).toMatchObject({ status: "completed", conclusion: "success" });
    expect(calls).toEqual(["run 7", "run 7", "run 7"]);
    expect(elapsedMs()).toBe(2_000);
  });

  test("answers the last read when the run is still going at the deadline", async () => {
    const { service, calls, elapsedMs } = harness({
      statuses: ["in_progress"],
    });
    const run = await service.getRun(actor, SESSION, 7, { waitMs: 3_000 });
    expect(run.status).toBe("in_progress");
    // Reads at 0, 1, 2 and 3 seconds; the last one lands on the deadline.
    expect(calls.length).toBe(4);
    expect(elapsedMs()).toBe(3_000);
  });

  test("a first read or a grant that outlasts the deadline is cut at it", async () => {
    for (const hang of ["read", "grant"] as const) {
      const { service } = harness({ hang });
      const started = performance.now();
      const error = await refusal(
        service.getRun(actor, SESSION, 7, { waitMs: 100 }),
      );
      expect(error.code).toBe("BACKEND_UNAVAILABLE");
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  test("a later read that outlasts the deadline is dropped and the last run answered", async () => {
    const { service } = harness({ statuses: ["queued"], hang: "later-read" });
    const started = performance.now();
    const run = await service.getRun(actor, SESSION, 7, { waitMs: 100 });
    expect(run.status).toBe("queued");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a run GitHub does not have is NOT_FOUND", async () => {
    const { service } = harness({
      fail: new GitHubCallError("run", 404, null),
    });
    expect((await refusal(service.getRun(actor, SESSION, 7))).code).toBe(
      "NOT_FOUND",
    );
  });

  test("another GitHub failure is BACKEND_UNAVAILABLE", async () => {
    const { service } = harness({
      fail: new GitHubCallError("run", 500, null),
    });
    expect((await refusal(service.getRun(actor, SESSION, 7))).code).toBe(
      "BACKEND_UNAVAILABLE",
    );
  });
});

describe("rerunning a run", () => {
  test("reruns and records a succeeded receipt", async () => {
    const { service, works, calls, receipts } = harness();
    expect(
      await service.rerun(actor, SESSION, 42, { failed_only: true }),
    ).toEqual({ receipt_id: "receipt-1" });
    expect(works).toMatchObject([{ purpose: "rerun", runId: 42 }]);
    expect(calls).toEqual(["rerun 42 true"]);
    expect(receipts).toEqual([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        actor: {
          principal: { kind: "api_key", id: "owner-a" },
          actor_user_id: null,
          agent_id: null,
        },
        operation: "rerun_workflow",
        status: "succeeded",
        result: {
          session_id: SESSION,
          agent_id: "agent-1",
          agent_release_id: "release-1",
          repository_id: "app",
          allowed_by: { workflow: "ci.yml" },
          run_id: 42,
          failed_only: true,
          workflow: "ci.yml",
        },
        error: null,
      },
    ]);
  });

  test("a gate refusal is GITHUB_REFUSED", async () => {
    const { service, calls } = harness({
      refuse: new GitHubGateError("run_ref_unprovable", "receipt-gate"),
    });
    expect(await refusal(service.rerun(actor, SESSION, 42, {}))).toEqual({
      code: "GITHUB_REFUSED",
      details: {
        reason_code: "run_ref_unprovable",
        receipt_id: "receipt-gate",
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("reviewing a pull request", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const REVIEW_BODY = "looks-good-private-note";

  test("submits on the commit read and records who opened the pull request, never the body", async () => {
    const { service, works, calls, receipts, reviews } = harness();
    expect(
      await service.review(actor, SESSION, 12, {
        event: "REQUEST_CHANGES",
        commit_id: COMMIT,
        body: REVIEW_BODY,
      }),
    ).toEqual({
      receipt_id: "receipt-1",
      review: {
        id: 77,
        html_url: "https://github.com/acme/app/pull/12#pullrequestreview-77",
      },
    });
    expect(works).toMatchObject([
      {
        purpose: "review",
        review: { number: 12, commitId: COMMIT, event: "REQUEST_CHANGES" },
      },
    ]);
    expect(calls).toEqual([
      "opener owner-a app 12",
      "pull 12",
      `review 12 REQUEST_CHANGES ${COMMIT} ${REVIEW_BODY}`,
    ]);
    expect(receipts).toEqual([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        actor: {
          principal: { kind: "api_key", id: "owner-a" },
          actor_user_id: null,
          agent_id: null,
        },
        operation: "review_pull_request",
        status: "succeeded",
        result: {
          session_id: SESSION,
          agent_id: "agent-1",
          agent_release_id: "release-1",
          repository_id: "app",
          number: 12,
          commit_id: COMMIT,
          event: "REQUEST_CHANGES",
          opened_by_session_id: "33333333-3333-4333-8333-333333333333",
          opened_by_agent_id: "agent-1",
          review_id: 77,
        },
        error: null,
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain(REVIEW_BODY);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.review).toEqual({
      id: 77,
      url: "https://github.com/acme/app/pull/12#pullrequestreview-77",
    });
    expect(reviews[0]?.context.repositoryId).toBe("app");
    expect(Object.keys(reviews[0]?.metadata ?? {}).sort()).toEqual([
      "commit_id",
      "event",
      "number",
      "opened_by_session_id",
    ]);
    expect(reviews[0]?.metadata).toEqual({
      number: 12,
      event: "REQUEST_CHANGES",
      commit_id: COMMIT,
      opened_by_session_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(JSON.stringify(reviews)).not.toContain(REVIEW_BODY);
  });

  test("a head that is not the commit ends as stale_commit: no review is submitted, a failed receipt keeps no body", async () => {
    const moved = "f".repeat(40);
    const { service, calls, receipts, reviews } = harness({ head: moved });
    expect(
      await refusal(
        service.review(actor, SESSION, 12, {
          event: "APPROVE",
          commit_id: COMMIT,
          body: REVIEW_BODY,
        }),
      ),
    ).toEqual({
      code: "GITHUB_REFUSED",
      details: {
        reason_code: "stale_commit",
        receipt_id: "receipt-1",
        head_sha: moved,
      },
    });
    console.log("forge calls on a moved head:", calls);
    expect(calls.some((call) => call.startsWith("review "))).toBe(false);
    expect(calls).toContain("pull 12");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: { number: 12, commit_id: COMMIT, reason_code: "stale_commit" },
    });
    expect(reviews).toEqual([]);
    expect(JSON.stringify(receipts)).not.toContain(REVIEW_BODY);
  });

  test("a failing pull request read is BACKEND_UNAVAILABLE and nothing is submitted", async () => {
    const { service, calls } = harness({
      failRead: new GitHubCallError("pull request read", 502, "req-3"),
    });
    expect(
      (
        await refusal(
          service.review(actor, SESSION, 12, {
            event: "APPROVE",
            commit_id: COMMIT,
          }),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(calls.some((call) => call.startsWith("review "))).toBe(false);
  });

  // A wrong head check may only fail toward not submitting.
  const badHeads: Array<[string, string | undefined]> = [
    ["an empty head sha", ""],
    ["a missing head sha", undefined],
    ["an upper-case head sha", COMMIT.toUpperCase()],
    ["an abbreviated head sha", COMMIT.slice(0, 7)],
    ["a head sha with trailing whitespace", `${COMMIT} `],
  ];
  for (const [name, head] of badHeads) {
    test(`${name} is stale_commit and nothing is submitted`, async () => {
      const { service, calls, reviews } = harness({ head: head as string });
      const failure = await refusal(
        service.review(actor, SESSION, 12, {
          event: "APPROVE",
          commit_id: COMMIT,
        }),
      );
      expect(failure.code).toBe("GITHUB_REFUSED");
      expect(failure.details).toMatchObject({ reason_code: "stale_commit" });
      expect(calls.filter((call) => call.startsWith("review "))).toEqual([]);
      expect(reviews).toEqual([]);
    });
  }

  test("an unexpected error from the pull request read propagates and nothing is submitted", async () => {
    const { service, calls, reviews } = harness({
      failRead: new TypeError("boom") as never,
    });
    await expect(
      service.review(actor, SESSION, 12, {
        event: "APPROVE",
        commit_id: COMMIT,
      }),
    ).rejects.toThrow("boom");
    expect(calls.filter((call) => call.startsWith("review "))).toEqual([]);
    expect(reviews).toEqual([]);
  });

  test("the body goes out with mentions neutralized and a secret-shaped line redacted", async () => {
    const { service, calls } = harness();
    await service.review(actor, SESSION, 12, {
      event: "COMMENT",
      commit_id: COMMIT,
      body: "cc @octocat, fixes acme/other#4\nghp_leaked\nplain",
    });
    expect(calls.at(-1)).toBe(
      `review 12 COMMENT ${COMMIT} cc @​octocat, f​ixes acme/other#​4\n[REDACTED]\nplain`,
    );
  });

  test("a pull request the platform did not open names no opener", async () => {
    const { service, receipts } = harness();
    await service.review(actor, SESSION, 5, {
      event: "APPROVE",
      commit_id: COMMIT,
    });
    expect(receipts[0]?.result).toMatchObject({
      number: 5,
      event: "APPROVE",
      opened_by_session_id: null,
      opened_by_agent_id: null,
    });
  });

  test("GitHub refusing the review is BACKEND_UNAVAILABLE with a failed receipt and no body", async () => {
    const { service, receipts, reviews } = harness({
      fail: new GitHubCallError("pull request review", 422, "req-9"),
    });
    expect(
      await refusal(
        service.review(actor, SESSION, 12, {
          event: "COMMENT",
          commit_id: COMMIT,
          body: REVIEW_BODY,
        }),
      ),
    ).toEqual({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: "receipt-1" },
    });
    expect(receipts[0]).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: { number: 12, status: 422, github_request_id: "req-9" },
    });
    expect(reviews).toEqual([]);
    expect(JSON.stringify(receipts)).not.toContain(REVIEW_BODY);
  });

  test("a gate refusal (no reviewer App) is GITHUB_REFUSED and GitHub is not called", async () => {
    const { service, calls } = harness({
      refuse: new GitHubGateError("no_reviewer_app", "receipt-gate"),
    });
    expect(
      await refusal(
        service.review(actor, SESSION, 12, {
          event: "APPROVE",
          commit_id: COMMIT,
        }),
      ),
    ).toEqual({
      code: "GITHUB_REFUSED",
      details: { reason_code: "no_reviewer_app", receipt_id: "receipt-gate" },
    });
    expect(calls).toEqual([]);
  });

  test("a caller without session.submit is refused before the gate", async () => {
    const { service, works } = harness();
    const reader = {
      ...actor,
      caller: testCaller("owner-a", ["sessions:read"]),
    };
    expect(
      (
        await refusal(
          service.review(reader, SESSION, 12, {
            event: "APPROVE",
            commit_id: COMMIT,
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(works).toEqual([]);
  });
});
