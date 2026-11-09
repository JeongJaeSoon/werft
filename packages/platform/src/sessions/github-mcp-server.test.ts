import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  GITHUB_MCP_FIXED_TOOLS,
  GITHUB_MCP_TOOL_CLASSES,
  GITHUB_MCP_TOOL_OUTPUTS,
  type GitHubMcpTool,
  LISTED_REPOSITORY_MEANING,
  type PushRequestState,
  type ReceiptActor,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import {
  type AuthorizationPolicy,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import {
  type GitHubApi,
  type GitHubGate,
  GitHubGateError,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type { GitHubMcpSessionState } from "../ports/github-mcp.ts";
import {
  PULL_REQUEST_REFUSAL_ERRORS,
  type ScheduleRef,
} from "../ports/pull-requests.ts";
import { PUSH_REFUSAL_ERRORS } from "../ports/push-requests.ts";
import {
  attachCatalog,
  attachmentContext,
  memoryAttachmentStore,
} from "../testing/repository-attachment-fakes.ts";
import {
  createGitHubMcpServer,
  type GitHubMcpServices,
  sessionBoundAuthorization,
  signGitHubMcpGrant,
  verifyGitHubMcpGrant,
} from "./github-mcp-server.ts";
import {
  createGitHubWorkService,
  type GitHubWorkStore,
} from "./github-work-service.ts";
import type { PushActor } from "./push-request-service.ts";
import { createRepositoryAttachmentService } from "./repository-attachment-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEY = new Uint8Array(32).fill(7);
const grant = { sessionId: SESSION, attemptId: "att_1" };

const creator: ReceiptActor = {
  principal: { kind: "user", id: "33333333-3333-4333-8333-333333333333" },
  actor_user_id: "33333333-3333-4333-8333-333333333333",
  agent_id: "44444444-4444-4444-8444-444444444444",
};

function github(features: Partial<AgentGitHub["features"]> = {}): AgentGitHub {
  return {
    repositories: ["app"],
    push_approval: true,
    features: {
      workflows: false,
      actions: false,
      checks: false,
      issues: false,
      review: false,
      ...features,
    },
    actions_allow: [],
  };
}

function unused(): never {
  throw new Error("not used");
}

function harness(state: Partial<GitHubMcpSessionState> = {}) {
  const works: GitHubWork[] = [];
  const dispatches: Parameters<GitHubWorkStore["recordDispatch"]>[0][] = [];
  const pushes: Array<{ actor: PushActor; sessionId: string }> = [];
  const opened: Array<{
    sessionId: string;
    pushRequestId: string;
    body: unknown;
  }> = [];
  const scheduled: Array<{ sessionId: string; ref: ScheduleRef }> = [];
  const snapshots: Array<{ sessionId: string; ref: unknown }> = [];
  const states: Array<{
    sessionId: string;
    pushRequestId: string;
    state: string;
  }> = [];
  const policies: AuthorizationPolicy[] = [];
  const control: {
    pushRefusal: "no_checkpoint" | "request_open" | "no_repository" | null;
    notPushed: PushRequestState | null;
    /** What the push request row holds as the decider's words. */
    resolutionReason: string | null;
    runningTurn: number | null;
    /** What a `request_push` made as an intent asked the service for. */
    intents: Array<{
      sessionId: string;
      turnId: number;
      branch?: string;
      sourceRef?: string;
    }>;
    intentStatus:
      | "deferred"
      | "github_disabled"
      | "turn_not_running"
      | "source_ref_required";
    /** The status each read of a workflow run answers. */
    runStatus: string;
    /** How long reading the session's state takes. */
    stateDelayMs: number;
    /** A read of a workflow run that never answers. */
    hangRun: boolean;
  } = {
    hangRun: false,
    stateDelayMs: 0,
    runStatus: "completed",
    pushRefusal: null,
    notPushed: null,
    resolutionReason: null,
    runningTurn: 7,
    intents: [],
    intentStatus: "deferred",
  };
  // What the forge says the head is, and the reviews it was sent.
  const forge = {
    head: "a".repeat(40),
    reviews: [] as Array<{ commitId: string; body: string | undefined }>,
  };
  const api: GitHubApi = {
    maxBodyLength: 65_536,
    getRepository: unused,
    getBranchHead: unused,
    readTree: unused,
    readBlob: unused,
    findPullRequestForBranch: unused,
    findPullRequestsForBranch: unused,
    isAncestor: unused,
    createPullRequest: unused,
    getPullRequest: async (number) => ({
      pullRequest: {
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        state: "open",
        head: "agent/x",
        headSha: forge.head,
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
    }),
    updatePullRequestBody: unused,
    setPullRequestState: unused,
    mergePullRequest: unused,
    upsertComment: unused,
    dispatchWorkflow: async () => ({
      id: 42,
      html_url: "https://github.com/acme/app/actions/runs/42",
    }),
    getWorkflowRun: async (runId) => {
      if (control.hangRun) return new Promise<never>(() => {});
      return {
        id: runId,
        path: ".github/workflows/ci.yml",
        head_branch: "main",
        status: control.runStatus,
        conclusion: control.runStatus === "completed" ? "success" : null,
        html_url: `https://github.com/acme/app/actions/runs/${runId}`,
      };
    },
    rerunWorkflow: unused,
    submitReview: async (input) => {
      forge.reviews.push({ commitId: input.commitId, body: input.body });
      return { id: 77, html_url: "https://github.com/acme/app/pull/1#r77" };
    },
  };
  const gate: GitHubGate = {
    grant: async (work) => {
      works.push(work);
      return {
        role: "author",
        repo: { owner: "acme", name: "app" },
        permissions: { actions: "write" },
        gitCredential: { username: "x", password: "y" },
        api,
        unit: async () => "app:test:1",
        allowedBy: { workflow: "ci.yml" },
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: creator.agent_id,
          agentReleaseId: "release-1",
          repositoryId: "app",
          policy: {},
        },
      };
    },
  };
  const workStore: GitHubWorkStore = {
    recordReceipt: async () => "receipt-1",
    recordDispatch: async (input) => {
      dispatches.push(input);
      return "receipt-dispatch";
    },
    recordReview: async () => "receipt-review",
    pullRequestOpener: async () => null,
  };
  const attachmentStore = memoryAttachmentStore();
  const attachContext = attachmentContext();
  const services = (authorization: AuthorizationPolicy): GitHubMcpServices => {
    policies.push(authorization);
    return {
      pushRequests: {
        create: async () => {
          throw new Error("request_push is an intent; it creates no request");
        },
        get: async () =>
          ({ resolution_reason: control.resolutionReason }) as never,
        snapshot: async (_actor, sessionId, ref) => {
          snapshots.push({ sessionId, ref });
          return {
            push_intent_id: "77777777-7777-4777-8777-777777777777",
            intent_status: "requested" as const,
            intent_refusal: null,
            push_request_id: "55555555-5555-4555-8555-555555555555",
            push_state: "pushed" as const,
            repository_id: "app",
            target_branch: "agent/s",
            pull_request_scheduled: true,
            pull_request_stage: "due" as const,
            pull_request_error: null,
            pull_request: null,
          };
        },
        requestIntent: async (actor, sessionId, input) => {
          pushes.push({ actor, sessionId });
          if (control.pushRefusal !== null) {
            // The turn ends and the next one starts while the refusal is
            // on its way back.
            if (control.runningTurn !== null) control.runningTurn += 1;
            const { code, message } = PUSH_REFUSAL_ERRORS[control.pushRefusal];
            throw new SessionServiceError(code, message, undefined, {
              refusal: control.pushRefusal,
              receipt_id: "receipt-push",
            });
          }
          control.intents.push({
            sessionId,
            turnId: input.turnId,
            ...(input.body.branch === undefined
              ? {}
              : { branch: input.body.branch }),
            ...(input.sourceRef === undefined
              ? {}
              : { sourceRef: input.sourceRef }),
          });
          if (control.intentStatus === "source_ref_required") {
            return {
              status: control.intentStatus,
              target_branch: `agent/${sessionId}`,
            };
          }
          if (control.intentStatus !== "deferred") {
            return { status: control.intentStatus };
          }
          return {
            status: "deferred" as const,
            intent: {
              id: "99999999-9999-4999-8999-999999999999",
              session_id: sessionId,
              repository_id: "sample-app",
              target_branch: `agent/${sessionId}`,
              status: "deferred" as const,
              refusal_code: null,
              push_request_id: null,
              source_ref: input.sourceRef ?? null,
              created_at: "2026-11-05T00:00:00.000Z",
            },
          };
        },
      },
      pullRequests: {
        // `open_pull_request` goes through the schedule; the fake answers it
        // as an open, which is what a pushed legacy request does.
        schedule(actor, sessionId, ref, input) {
          scheduled.push({ sessionId, ref });
          if (ref.pushIntentId !== undefined) {
            return Promise.resolve({
              status: "scheduled" as const,
              push_request_id: null,
              push_intent_id: ref.pushIntentId,
              receipt_id: "66666666-6666-4666-8666-666666666666",
            });
          }
          return this.open(actor, sessionId, ref.pushRequestId, input);
        },
        open: async (_actor, sessionId, pushRequestId, input) => {
          opened.push({
            sessionId,
            pushRequestId,
            body: await input.readBody(),
          });
          if (control.notPushed !== null) {
            const { code, message } = PULL_REQUEST_REFUSAL_ERRORS.not_pushed;
            throw new SessionServiceError(code, message, undefined, {
              refusal: "not_pushed",
              receipt_id: "receipt-pr",
              push_request_state: control.notPushed,
            });
          }
          return { created: true } as never;
        },
        update: unused,
        comment: unused,
        merge: unused,
        setState: async (_actor, sessionId, pushRequestId, state) => {
          states.push({ sessionId, pushRequestId, state });
          return { state, changed: true } as never;
        },
      },
      githubWork: createGitHubWorkService({
        authorization,
        gate,
        store: workStore,
        redact: (line) => (line.includes("ghp_") ? "[REDACTED]" : line),
        pollMs: 10,
      }),
      attachments: createRepositoryAttachmentService({
        store: attachmentStore,
        context: { context: async () => attachContext },
        catalog: attachCatalog,
      }),
    };
  };
  const handle = createGitHubMcpServer({
    store: {
      sessionState: async () => {
        if (control.stateDelayMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, control.stateDelayMs),
          );
        }
        return {
          ownerId: "owner-a",
          agentId: creator.agent_id ?? "",
          releaseId: "release-1",
          source: "release" as const,
          github: github(),
          enabled: true,
          actor: creator,
          ...state,
        };
      },
      runningTurn: async () => control.runningTurn,
    },
    services,
  });
  const call = (name: string, args: unknown) =>
    handle(
      grant,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      "req-1",
    );
  return {
    handle,
    call,
    works,
    dispatches,
    pushes,
    opened,
    scheduled,
    snapshots,
    states,
    policies,
    gate,
    workStore,
    attachmentStore,
    control,
    forge,
  };
}

function toolNames(answer: unknown): string[] {
  return (
    answer as { result: { tools: Array<{ name: string }> } }
  ).result.tools.map((tool) => tool.name);
}

/**
 * A tool's answer: its envelope, and `isError` when the call set it. The
 * `text` content must be the same JSON as `structuredContent`, and every
 * refusal must carry exactly code, by, retryable and, optionally, details:
 * never a `message`.
 */
function payload(answer: unknown): {
  isError?: boolean;
  body: { ok: boolean; result?: unknown; refusal?: Record<string, unknown> };
} {
  const result = (
    answer as {
      result: {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent: unknown;
      };
    }
  ).result;
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(
    result.structuredContent as never,
  );
  const body = result.structuredContent as {
    ok: boolean;
    result?: unknown;
    refusal?: Record<string, unknown>;
  };
  expect(Object.keys(body).sort()).toEqual(
    body.ok ? ["ok", "result"] : ["ok", "refusal"],
  );
  if (!body.ok) {
    expect(
      Object.keys(body.refusal ?? {}).every((key) =>
        ["code", "by", "retryable", "details"].includes(key),
      ),
    ).toBe(true);
    expect(typeof body.refusal?.code).toBe("string");
    expect(typeof body.refusal?.by).toBe("string");
    expect(typeof body.refusal?.retryable).toBe("boolean");
  }
  return { ...(result.isError ? { isError: true } : {}), body };
}

describe("the grant", () => {
  test("names the session and attempt it was signed for, until it expires", () => {
    const bearer = signGitHubMcpGrant(KEY, grant, 1_000);
    expect(verifyGitHubMcpGrant(KEY, bearer, 1_000)).toEqual(grant);
    expect(verifyGitHubMcpGrant(KEY, bearer, 61_000)).toBeNull();
    expect(
      verifyGitHubMcpGrant(new Uint8Array(32).fill(8), bearer, 1_000),
    ).toBeNull();
  });

  test("a payload naming another session does not verify", () => {
    const bearer = signGitHubMcpGrant(KEY, grant, 1_000);
    const [version, , mac] = bearer.split(".");
    const forged = Buffer.from(
      JSON.stringify({ session_id: OTHER, attempt_id: "att_1", exp: 61_000 }),
    ).toString("base64url");
    expect(
      verifyGitHubMcpGrant(KEY, `${version}.${forged}.${mac}`, 1_000),
    ).toBeNull();
  });
});

describe("tools/list", () => {
  const list = (features: Partial<AgentGitHub["features"]>) =>
    harness({ github: github(features) }).handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );

  test("lists only the default work when no feature is on", async () => {
    expect(toolNames(await list({}))).toEqual([
      "request_push",
      "open_pull_request",
      "get_push_request",
      "update_pull_request",
      "comment_pull_request",
      "close_pull_request",
      "reopen_pull_request",
      "merge_pull_request",
      "list_repositories",
      "attach_repository",
    ]);
  });

  test("a turned-off feature's tools are not listed", async () => {
    expect(toolNames(await list({ actions: true }))).toEqual([
      "request_push",
      "open_pull_request",
      "get_push_request",
      "update_pull_request",
      "comment_pull_request",
      "close_pull_request",
      "reopen_pull_request",
      "merge_pull_request",
      "dispatch_workflow",
      "get_workflow_run",
      "rerun_workflow",
      "list_repositories",
      "attach_repository",
    ]);
    expect(toolNames(await list({ review: true }))).toContain("submit_review");
    expect(toolNames(await list({ review: true }))).not.toContain(
      "dispatch_workflow",
    );
  });

  test("every listed tool carries its class, on a release session and on an agent session alike", async () => {
    const classes = (answer: unknown) =>
      Object.fromEntries(
        (
          answer as {
            result: {
              tools: Array<{ name: string; _meta: { class: string } }>;
            };
          }
        ).result.tools.map((tool) => [tool.name, tool._meta.class]),
      );
    const onRelease = classes(await list({ actions: true, review: true }));
    const onAgent = classes(
      await harness({
        github: github({}),
        source: "agent",
      }).handle(
        grant,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        "req-1",
      ),
    );
    for (const listed of [onRelease, onAgent]) {
      expect(Object.keys(listed).length).toBeGreaterThan(0);
      for (const [name, tool] of Object.entries(listed)) {
        expect(tool).toBe(GITHUB_MCP_TOOL_CLASSES[name as GitHubMcpTool]);
      }
    }
    expect(onRelease.request_push).toBe("push");
    expect(onRelease.submit_review).toBe("review");
    expect(onRelease.dispatch_workflow).toBe("workflow");
    expect(onRelease.list_repositories).toBe("repository.read");
  });

  test("a name that has no class is neither listed nor callable", async () => {
    const answer = await harness({ github: github({}) }).handle(
      grant,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "constructor", arguments: {} },
      },
      "req-2",
    );
    expect(answer).toMatchObject({ error: { code: -32602 } });
    expect(toolNames(await list({}))).not.toContain("constructor");
  });

  test("no argument schema takes a session id", async () => {
    const answer = (await list({ actions: true, review: true })) as {
      result: { tools: Array<{ inputSchema: { properties?: object } }> };
    };
    for (const tool of answer.result.tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain(
        "session_id",
      );
    }
  });

  test("a switched-off agent or a session without GitHub gets no tools", async () => {
    for (const state of [
      { enabled: false },
      { github: null },
      { actor: null },
    ]) {
      const answer = await harness(state).handle(
        grant,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        "req-1",
      );
      expect(answer).toMatchObject({ error: { code: -32001 } });
    }
  });
});

describe("a session under the agent's settings", () => {
  const under = (state: Partial<GitHubMcpSessionState> = {}) =>
    harness({ source: "agent", github: github(), ...state });

  test("lists the whole fixed surface, whatever the features say", async () => {
    const answer = await under().handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );
    expect(toolNames(answer)).toEqual([...GITHUB_MCP_FIXED_TOOLS]);
  });

  test("the list stays with the agent's switch off; each call is refused", async () => {
    const h = under({ enabled: false });
    const answer = await h.handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );
    expect(toolNames(answer)).toEqual([...GITHUB_MCP_FIXED_TOOLS]);
    const refused = payload(await h.call("request_push", {}));
    expect(refused).toEqual({
      body: {
        ok: false,
        refusal: { code: "github_disabled", by: "policy", retryable: false },
      },
    });
    expect(h.pushes).toEqual([]);
  });

  test("a tool of a feature off is refused in the turn, not hidden", async () => {
    const h = under();
    expect(
      payload(
        await h.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" }),
      ),
    ).toEqual({
      body: {
        ok: false,
        refusal: { code: "feature_off", by: "policy", retryable: false },
      },
    });
    expect(h.works).toEqual([]);
  });

  test("a feature on reaches the gate, unlike the release's tool off", async () => {
    const on = under({ github: github({ actions: true }) });
    await on.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" });
    expect(on.works).toHaveLength(1);
    const release = harness({ github: github() });
    expect(
      payload(
        await release.call("dispatch_workflow", {
          workflow: "ci.yml",
          ref: "main",
        }),
      ),
    ).toEqual({
      body: {
        ok: false,
        refusal: { code: "feature_off", by: "policy", retryable: false },
      },
    });
  });

  test("submit_review cleans the body, and a moved head is a stale_commit refusal with no review sent", async () => {
    const h = under({ github: github({ review: true }) });
    const ok = payload(
      await h.call("submit_review", {
        number: 1,
        event: "COMMENT",
        commit_id: "a".repeat(40),
        body: "cc @octocat\nghp_leak",
      }),
    );
    expect(ok.body.ok).toBe(true);
    expect(h.forge.reviews).toEqual([
      { commitId: "a".repeat(40), body: "cc @​octocat\n[REDACTED]" },
    ]);

    h.forge.head = "b".repeat(40);
    const stale = payload(
      await h.call("submit_review", {
        number: 1,
        event: "APPROVE",
        commit_id: "a".repeat(40),
      }),
    );
    expect(stale.body).toMatchObject({
      ok: false,
      refusal: {
        code: "stale_commit",
        by: "github",
        retryable: false,
        details: { head_sha: "b".repeat(40) },
      },
    });
    expect(h.forge.reviews).toHaveLength(1);
  });

  test("a row that cannot be read gets no tools", async () => {
    const answer = await under({ github: null }).handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );
    expect(answer).toMatchObject({ error: { code: -32001 } });
  });
});

describe("tools/call", () => {
  test("a session id among the arguments is refused, not followed", async () => {
    const h = harness({ github: github({ actions: true }) });
    const answer = payload(
      await h.call("dispatch_workflow", {
        workflow: "ci.yml",
        ref: "main",
        session_id: OTHER,
      }),
    );
    expect(answer).toMatchObject({
      isError: true,
      body: {
        ok: false,
        refusal: {
          code: "validation_error",
          by: "platform",
          retryable: false,
          details: { issues: [{ path: "" }] },
        },
      },
    });
    expect(h.works).toEqual([]);
  });

  test("every call acts on the grant's session", async () => {
    const h = harness({ github: github({ actions: true }) });
    await h.call("request_push", {});
    await h.call("open_pull_request", {
      push_request_id: "55555555-5555-4555-8555-555555555555",
      title: "Fix",
    });
    await h.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" });
    expect(h.pushes.map((push) => push.sessionId)).toEqual([SESSION]);
    expect(h.opened).toEqual([
      {
        sessionId: SESSION,
        pushRequestId: "55555555-5555-4555-8555-555555555555",
        body: { title: "Fix" },
      },
    ]);
    expect(h.works.map((work) => work.sessionId)).toEqual([SESSION]);
  });

  describe("scheduling a pull request (tools/call output)", () => {
    const INTENT = "77777777-7777-4777-8777-777777777777";
    const REQUEST = "55555555-5555-4555-8555-555555555555";

    test("open_pull_request with push_intent_id answers scheduled with that id", async () => {
      const h = harness();
      const answer = payload(
        await h.call("open_pull_request", {
          push_intent_id: INTENT,
          title: "Fix",
        }),
      );
      expect(answer).toMatchObject({
        body: {
          ok: true,
          result: {
            status: "scheduled",
            push_request_id: null,
            push_intent_id: INTENT,
          },
        },
      });
      expect(h.scheduled).toEqual([
        { sessionId: SESSION, ref: { pushIntentId: INTENT } },
      ]);
      expect(h.opened).toEqual([]);
    });

    test("open_pull_request with push_request_id goes through the schedule too", async () => {
      const h = harness();
      await h.call("open_pull_request", { push_request_id: REQUEST });
      expect(h.scheduled).toEqual([
        { sessionId: SESSION, ref: { pushRequestId: REQUEST } },
      ]);
    });

    test("both ids, or neither, are a validation error and reach no service", async () => {
      const h = harness();
      for (const args of [
        { push_request_id: REQUEST, push_intent_id: INTENT },
        { title: "Fix" },
      ]) {
        const answer = payload(await h.call("open_pull_request", args));
        expect(answer.isError).toBe(true);
        expect(answer.body.refusal).toMatchObject({ code: "validation_error" });
      }
      expect(h.scheduled).toEqual([]);
    });

    test("get_push_request answers the same push for either id", async () => {
      const h = harness();
      const byIntent = payload(
        await h.call("get_push_request", { push_intent_id: INTENT }),
      );
      const byRequest = payload(
        await h.call("get_push_request", { push_request_id: REQUEST }),
      );
      expect(byIntent.body.result).toEqual(byRequest.body.result);
      expect(byIntent.body.result).toMatchObject({
        push_intent_id: INTENT,
        push_request_id: REQUEST,
        pull_request_stage: "due",
      });
      expect(h.snapshots).toEqual([
        { sessionId: SESSION, ref: { pushIntentId: INTENT } },
        { sessionId: SESSION, ref: { pushRequestId: REQUEST } },
      ]);
      const neither = payload(await h.call("get_push_request", {}));
      expect(neither.body.refusal).toMatchObject({ code: "validation_error" });
    });

    test("request_push takes no pull_request: the argument is a validation error and nothing is created", async () => {
      const h = harness();
      for (const pull_request of [{ title: "Fix" }, {}]) {
        const answer = payload(await h.call("request_push", { pull_request }));
        expect(answer.body.ok).toBe(false);
        expect(answer.body.refusal).toMatchObject({
          code: "validation_error",
        });
      }
      expect(h.pushes).toEqual([]);
      expect(h.control.intents).toEqual([]);
    });

    test("a scheduled call on a request a person rejected carries their words", async () => {
      const h = harness();
      h.control.notPushed = "rejected";
      h.control.resolutionReason = "Not this way.";
      const answer = payload(
        await h.call("open_pull_request", { push_request_id: REQUEST }),
      );
      expect(answer.body.refusal).toMatchObject({
        code: "push_rejected",
        by: "person",
        details: { reason: "Not this way." },
      });
    });
  });

  test("a turned-off feature's tool is refused before any service", async () => {
    const h = harness();
    const answer = payload(
      await h.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" }),
    );
    expect(answer).toEqual({
      body: {
        ok: false,
        refusal: { code: "feature_off", by: "policy", retryable: false },
      },
    });
    expect(h.works).toEqual([]);
    expect(h.policies).toEqual([]);
  });

  test("acts as the session's creator and agent, holding no scope", async () => {
    const h = harness();
    await h.call("request_push", {});
    const [push] = h.pushes;
    expect(push?.actor.principal.scopes).toEqual([]);
    expect(push?.actor.caller.actor).toMatchObject({
      principal: creator.principal,
      userId: creator.actor_user_id,
      agentId: creator.agent_id,
    });
  });

  describe("request_push as a push intent", () => {
    test("inside a running turn it records an intent and answers deferred, with facts only", async () => {
      const h = harness();
      const answer = payload(await h.call("request_push", { branch: "docs" }));
      expect(answer).toEqual({
        body: {
          ok: true,
          result: {
            status: "deferred",
            push_intent_id: "99999999-9999-4999-8999-999999999999",
            waits_for: "reply_end",
            repository_id: "sample-app",
            target_branch: `agent/${SESSION}`,
            pull_request: "none",
          },
        },
      });
      expect(h.control.intents).toEqual([
        { sessionId: SESSION, turnId: 7, branch: "docs" },
      ]);
    });

    test("outside a running turn it is no_running_turn, whatever checkpoint was saved last", async () => {
      const h = harness();
      h.control.runningTurn = null;
      expect(payload(await h.call("request_push", {}))).toEqual({
        body: {
          ok: false,
          refusal: {
            code: "no_running_turn",
            by: "platform",
            retryable: false,
          },
        },
      });
      expect(h.control.intents).toEqual([]);
    });

    test("a turn that ended while the call was in flight is no_running_turn", async () => {
      const h = harness();
      h.control.intentStatus = "turn_not_running";
      expect(payload(await h.call("request_push", {}))).toMatchObject({
        body: { ok: false, refusal: { code: "no_running_turn" } },
      });
    });

    test("source_ref reaches the intent", async () => {
      const h = harness();
      const answer = payload(
        await h.call("request_push", {
          repository_id: "sample-app",
          source_ref: "guard-docs",
        }),
      );
      expect(answer).toMatchObject({ body: { ok: true } });
      expect(h.control.intents).toEqual([
        expect.objectContaining({ sourceRef: "guard-docs" }),
      ]);
    });

    test.each(["../x", "a b", "/abs", "x.lock", "refs/heads/x y"])(
      "source_ref %p is a validation error, and creates nothing",
      async (source_ref) => {
        const h = harness();
        expect(
          payload(await h.call("request_push", { source_ref })),
        ).toMatchObject({
          body: { ok: false, refusal: { code: "validation_error" } },
        });
        expect(h.control.intents).toEqual([]);
      },
    );

    test("a second push without a source_ref is refused with the target that lacks one named, so the model can repeat it", async () => {
      const h = harness();
      h.control.intentStatus = "source_ref_required";
      expect(
        payload(await h.call("request_push", { branch: "docs-overview" })),
      ).toEqual({
        body: {
          ok: false,
          refusal: {
            code: "source_ref_required",
            by: "platform",
            retryable: true,
            details: { target_branch: `agent/${SESSION}` },
          },
        },
      });
    });

    test("a release with GitHub switched off is github_disabled by policy", async () => {
      const h = harness();
      h.control.intentStatus = "github_disabled";
      expect(payload(await h.call("request_push", {}))).toEqual({
        body: {
          ok: false,
          refusal: { code: "github_disabled", by: "policy", retryable: false },
        },
      });
    });
  });

  test("writes the receipt the session API writes", async () => {
    const h = harness({ github: github({ actions: true }) });
    await h.call("dispatch_workflow", {
      workflow: "ci.yml",
      ref: "main",
      inputs: { target: "x" },
    });
    const viaApi = createGitHubWorkService({
      authorization: createAuthorizationPolicy(),
      gate: h.gate,
      store: h.workStore,
      redact: (line) => line,
    });
    await viaApi.dispatch(
      {
        caller: testCaller("owner-a"),
        principal: testCaller("owner-a").subject.principal as never,
        ownerId: "owner-a",
        verified: true,
      },
      SESSION,
      { workflow: "ci.yml", ref: "main", inputs: { target: "x" } },
    );
    const [mcp, api] = h.dispatches;
    expect(mcp?.result).toEqual(api?.result);
    expect(mcp?.run).toEqual(api?.run);
    expect(mcp?.actor).toEqual(creator);
    expect(h.works[0]?.actor).toEqual(creator);
  });

  test("a service refusal is a normal result with its code, by, retryable and details", async () => {
    const h = harness({ github: github({ actions: true }) });
    h.gate.grant = async () => {
      throw new GitHubGateError("workflow_not_allowed", "receipt-9");
    };
    const answer = payload(
      await h.call("dispatch_workflow", { workflow: "x.yml", ref: "main" }),
    );
    expect(answer).toEqual({
      body: {
        ok: false,
        refusal: {
          code: "github_refused",
          by: "github",
          retryable: false,
          details: {
            reason_code: "workflow_not_allowed",
            receipt_id: "receipt-9",
          },
        },
      },
    });
  });

  test("an exception inside a tool is internal_error with isError, logged, and never shown", async () => {
    const logged: unknown[] = [];
    const handle = createGitHubMcpServer({
      store: {
        sessionState: async () => ({
          ownerId: "owner-a",
          agentId: creator.agent_id ?? "",
          releaseId: "release-1",
          source: "release",
          github: github(),
          enabled: true,
          actor: creator,
        }),
        runningTurn: async () => 7,
      },
      services: () => ({
        ...({} as GitHubMcpServices),
        attachments: {
          list: async () => {
            throw new Error("database unavailable: secret detail");
          },
          attach: async () => {
            throw new Error("unused");
          },
        },
      }),
      onInternalError: (error, context) => logged.push({ error, context }),
    });
    const answer = payload(
      await handle(
        grant,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_repositories", arguments: {} },
        },
        "req-1",
      ),
    );
    expect(answer).toEqual({
      isError: true,
      body: {
        ok: false,
        refusal: { code: "internal_error", by: "platform", retryable: false },
      },
    });
    // The composition logs only the error's name, from this context.
    expect(logged).toEqual([
      {
        error: new Error("database unavailable: secret detail"),
        context: {
          tool: "list_repositories",
          sessionId: SESSION,
          requestId: "req-1",
        },
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain("secret detail");
  });

  test("a fault in the intent store, or in the logger, is still an internal_error answer", async () => {
    const handle = createGitHubMcpServer({
      store: {
        sessionState: async () => ({
          ownerId: "owner-a",
          agentId: creator.agent_id ?? "",
          releaseId: "release-1",
          source: "release",
          github: github(),
          enabled: true,
          actor: creator,
        }),
        runningTurn: async () => 7,
      },
      services: () => ({
        ...({} as GitHubMcpServices),
        pushRequests: {
          create: async () => {
            throw new Error("not used");
          },
          get: async () => {
            throw new Error("not used");
          },
          snapshot: async () => {
            throw new Error("not used");
          },
          requestIntent: async () => {
            throw new Error("database unavailable");
          },
        },
      }),
      onInternalError: () => {
        throw new Error("logger failed");
      },
    });
    const answer = payload(
      await handle(
        grant,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "request_push", arguments: {} },
        },
        "req-1",
      ),
    );
    expect(answer.isError).toBe(true);
    expect(answer.body.refusal).toMatchObject({ code: "internal_error" });
  });

  test("a session state that cannot be read is internal_error for a call, a thrown fault for the rest", async () => {
    const handle = createGitHubMcpServer({
      store: {
        sessionState: async () => {
          throw new Error("database unavailable");
        },
        runningTurn: async () => null,
      },
      services: () => ({}) as GitHubMcpServices,
    });
    const rpc = (method: string, params: unknown) =>
      handle(grant, { jsonrpc: "2.0", id: 1, method, params }, "req-1");
    expect(
      payload(await rpc("tools/call", { name: "list_repositories" })),
    ).toMatchObject({
      isError: true,
      body: { refusal: { code: "internal_error" } },
    });
    await expect(rpc("tools/list", {})).rejects.toThrow("database unavailable");
  });

  test("a call GitHub did not take is github and retryable", async () => {
    const h = harness({ github: github({ actions: true }) });
    h.gate.grant = async () => {
      throw new SessionServiceError(
        "BACKEND_UNAVAILABLE",
        "GitHub did not take the call",
      );
    };
    const answer = payload(
      await h.call("dispatch_workflow", { workflow: "x.yml", ref: "main" }),
    );
    expect(answer.body).toEqual({
      ok: false,
      refusal: { code: "backend_unavailable", by: "github", retryable: true },
    });
  });

  test("a policy refusal of the push names its code and policy as the refuser", async () => {
    const h = harness();
    h.control.pushRefusal = "no_repository";
    const answer = payload(await h.call("request_push", {}));
    expect(answer.body.refusal).toMatchObject({
      code: "no_repository",
      by: "policy",
      retryable: false,
    });
  });

  test("a service code no table names is the platform's and final", async () => {
    const h = harness({ github: github({ actions: true }) });
    h.gate.grant = async () => {
      throw new SessionServiceError("SESSION_STOPPED", "stopped");
    };
    const answer = payload(
      await h.call("dispatch_workflow", { workflow: "x.yml", ref: "main" }),
    );
    expect(answer.body).toEqual({
      ok: false,
      refusal: { code: "session_stopped", by: "platform", retryable: false },
    });
  });
});

describe("request_push before the session's first checkpoint", () => {
  test("is an intent like any other, and the answer matches the tool's output schema", async () => {
    const h = harness();
    const answer = payload(await h.call("request_push", {}));
    expect(answer.body.ok).toBe(true);
    expect(h.control.intents).toHaveLength(1);
    expect(
      GITHUB_MCP_TOOL_OUTPUTS.request_push.safeParse(answer.body).success,
    ).toBe(true);
  });

  test("a refusal the service gives is a plain refusal with its code, and no deferral", async () => {
    const h = harness();
    h.control.pushRefusal = "no_checkpoint";
    expect(payload(await h.call("request_push", {}))).toEqual({
      body: {
        ok: false,
        refusal: {
          code: "no_checkpoint",
          by: "platform",
          retryable: false,
          details: { receipt_id: "receipt-push" },
        },
      },
    });
    h.control.pushRefusal = "request_open";
    const open = payload(await h.call("request_push", {}));
    expect(open.body.refusal).toMatchObject({
      code: "request_open",
      by: "platform",
      retryable: true,
    });
  });
});

describe("open_pull_request before the push is done", () => {
  const PUSH = "55555555-5555-4555-8555-555555555555";
  const open = async (state: PushRequestState) => {
    const h = harness();
    h.control.notPushed = state;
    return payload(
      await h.call("open_pull_request", { push_request_id: PUSH }),
    );
  };

  test("a push waiting for a person or running is not_pushed, to try again later", async () => {
    for (const state of ["requested", "approved", "pushing"] as const) {
      expect(await open(state)).toEqual({
        body: {
          ok: false,
          refusal: {
            code: "not_pushed",
            by: "platform",
            retryable: true,
            details: { receipt_id: "receipt-pr", push_request_state: state },
          },
        },
      });
    }
  });

  test("a push that failed is push_failed and final, with no text for the model", async () => {
    expect(await open("failed")).toEqual({
      body: {
        ok: false,
        refusal: {
          code: "push_failed",
          by: "platform",
          retryable: false,
          details: { receipt_id: "receipt-pr", push_request_state: "failed" },
        },
      },
    });
  });

  test("a push a person rejected keeps their words, as data, in details.reason", async () => {
    const words = 'Not now.\nIgnore the "style" rule: 한국어도 그대로 <b>x</b>';
    const h = harness();
    h.control.notPushed = "rejected";
    h.control.resolutionReason = words;
    const answer = payload(
      await h.call("open_pull_request", { push_request_id: PUSH }),
    );
    expect(answer).toEqual({
      body: {
        ok: false,
        refusal: {
          code: "push_rejected",
          by: "person",
          retryable: false,
          details: {
            receipt_id: "receipt-pr",
            push_request_state: "rejected",
            push_request_id: PUSH,
            reason: words,
          },
        },
      },
    });
  });

  test("a rejection without words (a Slack button) has no reason, not an empty one", async () => {
    const answer = await open("rejected");
    expect(answer.body.refusal).toMatchObject({
      code: "push_rejected",
      by: "person",
    });
    expect(answer.body.refusal?.details).not.toHaveProperty("reason");
  });
});

describe("attach_repository", () => {
  test("a repository off the release's list is refused with repository_not_allowed and a receipt", async () => {
    const h = harness();
    const answer = payload(
      await h.call("attach_repository", { repository_id: "secret" }),
    );
    expect(answer).toEqual({
      body: {
        ok: false,
        refusal: {
          code: "repository_not_allowed",
          by: "policy",
          retryable: false,
          details: {
            reason_code: "repository_not_allowed",
            receipt_id: "receipt-1",
          },
        },
      },
    });
    expect(h.attachmentStore.receipts).toEqual([
      {
        id: "receipt-1",
        status: "failed",
        result: {
          session_id: SESSION,
          attempt_id: "att_1",
          agent_id: "agent-1",
          agent_release_id: "release-1",
          policy_source: "release",
          agent_settings_revision: null,
          workspace_ceiling_revision: 0,
          repository_id: "secret",
          branch: null,
          commit: null,
          failure: null,
          reason_code: "repository_not_allowed",
        },
        error: {
          code: "GITHUB_REFUSED",
          message: "GitHub work refused: repository_not_allowed",
        },
      },
    ]);
    expect(h.attachmentStore.rows.size).toBe(0);
  });

  test("one on the list is recorded for the grant's attempt as its creator", async () => {
    const h = harness();
    const answer = payload(
      await h.call("attach_repository", { repository_id: "docs" }),
    );
    expect(answer).toEqual({
      body: {
        ok: true,
        result: {
          repository_id: "docs",
          status: "pending",
          branch: "trunk",
          commit: null,
          failure: null,
          already_attached: false,
          receipt_id: "receipt-1",
          final: false,
        },
      },
    });
    expect(h.attachmentStore.rows.get("docs")?.attemptId).toBe("att_1");
  });

  test("a repository already attached answers final at once", async () => {
    const h = harness();
    await h.call("attach_repository", { repository_id: "docs" });
    await h.attachmentStore.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id: "receipt-1",
        status: "attached",
        commit: "c".repeat(40),
      },
    ]);
    const started = performance.now();
    const answer = payload(
      await h.call("attach_repository", {
        repository_id: "docs",
        wait_seconds: 7,
      }),
    );
    expect(answer.body.result).toMatchObject({
      status: "attached",
      already_attached: true,
      final: true,
    });
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("waits no longer than wait_seconds and answers final false", async () => {
    const h = harness();
    const started = performance.now();
    const answer = payload(
      await h.call("attach_repository", {
        repository_id: "docs",
        wait_seconds: 1,
      }),
    );
    const took = performance.now() - started;
    expect(answer.body.result).toMatchObject({
      status: "pending",
      final: false,
    });
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(1_500);
  });

  test("a wait over the cap, or not a whole number, is refused before the service", async () => {
    for (const wait_seconds of [8, -1, 1.5, "3"]) {
      const h = harness();
      const answer = payload(
        await h.call("attach_repository", {
          repository_id: "docs",
          wait_seconds,
        }),
      );
      expect(answer).toMatchObject({
        isError: true,
        body: { refusal: { code: "validation_error" } },
      });
      expect(h.attachmentStore.rows.size).toBe(0);
    }
  });

  test("anything but a repository id is refused before the service", async () => {
    const h = harness();
    const answer = payload(
      await h.call("attach_repository", {
        repository_id: "docs",
        session_id: OTHER,
      }),
    );
    expect(answer).toMatchObject({
      isError: true,
      body: { refusal: { code: "validation_error" } },
    });
    expect(h.attachmentStore.receipts).toEqual([]);
  });
});

describe("get_workflow_run", () => {
  const actionsOn = () =>
    harness({ github: github({ actions: true }) as never });

  test("without wait_seconds answers at once; a finished run is final", async () => {
    const h = actionsOn();
    h.control.runStatus = "completed";
    expect(
      payload(await h.call("get_workflow_run", { run_id: 7 })).body,
    ).toMatchObject({
      ok: true,
      result: { id: 7, status: "completed", final: true },
    });
    h.control.runStatus = "in_progress";
    for (const args of [{ run_id: 7 }, { run_id: 7, wait_seconds: 0 }]) {
      const started = performance.now();
      const answer = payload(await h.call("get_workflow_run", args));
      expect(answer.body.result).toMatchObject({
        status: "in_progress",
        final: false,
      });
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test("a run still going at the deadline answers final false at the deadline", async () => {
    const h = actionsOn();
    h.control.runStatus = "in_progress";
    const started = performance.now();
    const answer = payload(
      await h.call("get_workflow_run", { run_id: 7, wait_seconds: 1 }),
    );
    const took = performance.now() - started;
    expect(answer.body.result).toMatchObject({ final: false });
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(1_500);
  });

  test("a run that finishes inside the wait answers the finished run", async () => {
    const h = actionsOn();
    h.control.runStatus = "in_progress";
    setTimeout(() => {
      h.control.runStatus = "completed";
    }, 200);
    const started = performance.now();
    const answer = payload(
      await h.call("get_workflow_run", { run_id: 7, wait_seconds: 5 }),
    );
    expect(answer.body.result).toMatchObject({
      status: "completed",
      conclusion: "success",
      final: true,
    });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test("the wait is counted from the start of the call, state read included", async () => {
    const h = actionsOn();
    h.control.runStatus = "in_progress";
    h.control.stateDelayMs = 600;
    const started = performance.now();
    const answer = payload(
      await h.call("get_workflow_run", { run_id: 7, wait_seconds: 1 }),
    );
    const took = performance.now() - started;
    expect(answer.body.result).toMatchObject({ final: false });
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(1_300);
  });

  test("a budget spent before the service starts still ends at the deadline", async () => {
    const h = actionsOn();
    h.control.stateDelayMs = 1_100;
    h.control.hangRun = true;
    const started = performance.now();
    const answer = payload(
      await h.call("get_workflow_run", { run_id: 7, wait_seconds: 1 }),
    );
    expect(answer.body.refusal).toMatchObject({
      code: "backend_unavailable",
      retryable: true,
    });
    expect(performance.now() - started).toBeLessThan(1_800);
  });

  test("a wait over the cap is refused, and concurrent waits answer alike", async () => {
    const h = actionsOn();
    expect(
      payload(await h.call("get_workflow_run", { run_id: 7, wait_seconds: 8 })),
    ).toMatchObject({
      isError: true,
      body: { refusal: { code: "validation_error" } },
    });
    // The cap itself is accepted: a finished run answers at once.
    h.control.runStatus = "completed";
    expect(
      payload(await h.call("get_workflow_run", { run_id: 7, wait_seconds: 7 }))
        .body.result,
    ).toMatchObject({ final: true });
    h.control.runStatus = "queued";
    setTimeout(() => {
      h.control.runStatus = "completed";
    }, 100);
    const answers = await Promise.all(
      [1, 2, 3].map((_) =>
        h.call("get_workflow_run", { run_id: 7, wait_seconds: 3 }),
      ),
    );
    for (const answer of answers) {
      expect(payload(answer).body.result).toMatchObject({ final: true });
    }
  });
});

describe("list_repositories", () => {
  test("answers the session's repositories, an attach in flight included, and writes nothing", async () => {
    const h = harness();
    await h.call("attach_repository", { repository_id: "docs" });
    const receipts = h.attachmentStore.receipts.length;
    expect(payload(await h.call("list_repositories", {}))).toEqual({
      body: {
        ok: true,
        result: {
          repositories: [
            {
              id: "app",
              name: "acme/app",
              branch: "main",
              status: "attached",
              remote: "origin",
              meaning: LISTED_REPOSITORY_MEANING.attached,
            },
            {
              id: "docs",
              name: "acme/docs",
              branch: "trunk",
              status: "pending",
              meaning: LISTED_REPOSITORY_MEANING.pending,
            },
            {
              id: "tools",
              name: "acme/tools",
              branch: "main",
              status: "not_attached",
              meaning: LISTED_REPOSITORY_MEANING.not_attached,
            },
          ],
          next_cursor: null,
        },
      },
    });
    expect(h.attachmentStore.receipts).toHaveLength(receipts);
    expect(
      payload(await h.call("list_repositories", { repository_id: "docs" })),
    ).toMatchObject({
      isError: true,
      body: { refusal: { code: "validation_error" } },
    });
  });
});

describe("update_pull_request", () => {
  test("needs a title or a body", async () => {
    const h = harness();
    expect(
      payload(
        await h.call("update_pull_request", {
          push_request_id: "55555555-5555-4555-8555-555555555555",
        }),
      ),
    ).toMatchObject({
      isError: true,
      body: { refusal: { code: "validation_error" } },
    });
  });
});

describe("close_pull_request and reopen_pull_request", () => {
  const PUSH = "55555555-5555-4555-8555-555555555555";

  test("close asks for closed and reopen for open, on the grant's session", async () => {
    const h = harness();
    expect(
      payload(await h.call("close_pull_request", { push_request_id: PUSH })),
    ).toEqual({
      body: { ok: true, result: { state: "closed", changed: true } },
    });
    expect(
      payload(await h.call("reopen_pull_request", { push_request_id: PUSH })),
    ).toEqual({
      body: { ok: true, result: { state: "open", changed: true } },
    });
    expect(h.states).toEqual([
      { sessionId: SESSION, pushRequestId: PUSH, state: "closed" },
      { sessionId: SESSION, pushRequestId: PUSH, state: "open" },
    ]);
  });

  test("take a push request id and nothing else", async () => {
    const h = harness();
    for (const args of [{}, { push_request_id: PUSH, number: 7 }]) {
      expect(payload(await h.call("close_pull_request", args))).toMatchObject({
        isError: true,
        body: { refusal: { code: "validation_error" } },
      });
    }
    expect(h.states).toEqual([]);
  });
});

describe("the protocol", () => {
  test("answers initialize and ping, and nothing for a notification", async () => {
    const { handle } = harness();
    expect(
      await handle(
        grant,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        },
        "r",
      ),
    ).toMatchObject({
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "github" },
      },
    });
    expect(
      await handle(grant, { jsonrpc: "2.0", id: 2, method: "ping" }, "r"),
    ).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(
      await handle(
        grant,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        "r",
      ),
    ).toBeNull();
    expect(
      await handle(
        grant,
        { jsonrpc: "2.0", id: 3, method: "resources/list" },
        "r",
      ),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await handle(grant, { jsonrpc: "2.0", id: 4, result: {} }, "r"),
    ).toBeNull();
    expect(await handle(grant, { jsonrpc: "2.0", id: 5 }, "r")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
  });
});

describe("sessionBoundAuthorization", () => {
  test("allows reading and submitting to its own session only", async () => {
    const policy = sessionBoundAuthorization(SESSION);
    const ask = (action: string, id: string) =>
      policy.authorize({
        subject: testCaller("owner-a").subject,
        action: action as never,
        resource: { kind: "session", id, owner_scope: "owner-a" },
        request_id: "r",
      });
    expect((await ask("session.submit", SESSION)).outcome).toBe("allow");
    expect((await ask("session.read", SESSION)).outcome).toBe("allow");
    expect((await ask("session.submit", OTHER)).outcome).toBe("deny");
    expect((await ask("session.approve", SESSION)).outcome).toBe("deny");
  });
});
