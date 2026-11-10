import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  commentPullRequestResponseSchema,
  DEFAULT_PULL_REQUEST_SETTINGS,
  GITHUB_CEILING_NONE,
  openPullRequestResponseSchema,
  openPullRequestResultSchema,
  type PullRequest,
  type SessionScope,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createGitHubGate,
  createPullRequestService,
  ForgeCredentialError,
  type GitHubApi,
  type GitHubConnection,
  type GitHubGateReceipt,
  type GitHubSessionContext,
  type PullRequestReceipt,
  type PullRequestSource,
  type PullRequestStore,
  repositoryBinding,
  type ScheduleOutcome,
  type SessionCatalog,
} from "@werft-ai/platform";
import { releasePolicy } from "@werft-ai/platform/testing/github";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerPullRequestRoutes } from "./pull-requests.ts";

const createApiApp = recordRouteErrors("routes/pull-requests.test.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const AGENT = "019a0000-0000-7000-8000-0000000000e1";
const KEYS: Record<string, readonly SessionScope[]> = {
  csp_reader: ["sessions:read"],
  csp_writer: ["sessions:read", "sessions:write"],
  csp_approver: ["sessions:read", "sessions:approve"],
  csp_agent: ["sessions:read", "sessions:write"],
};
const CATALOG = {
  connections: {},
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true } as const,
    },
  },
} satisfies SessionCatalog;

function app(
  options: {
    state?: PullRequestSource["state"];
    binding?: string;
    failing?: "lookup" | "comment";
    authMode?: "none";
    release?: GitHubSessionContext["release"];
    policy?: GitHubSessionContext["policy"];
    schedule?: ScheduleOutcome;
  } = {},
) {
  const receipts: PullRequestReceipt[] = [];
  const scheduleCalls: Array<Parameters<PullRequestStore["schedule"]>[0]> = [];
  const gateReceipts: GitHubGateReceipt[] = [];
  let recorded: PullRequest | null = null;
  const source: PullRequestSource = {
    id: PUSH,
    sessionId: SESSION,
    repositoryId: "app",
    repositoryBinding:
      options.binding ?? repositoryBinding("app", CATALOG.repositories.app),
    state: options.state ?? "pushed",
    targetBranch: `agent/${SESSION}`,
    gitCommit: "a".repeat(40),
    prState: null,
    prError: null,
    prErrorDetails: null,
  };
  const fail = (call: "lookup" | "comment" | "compare") => {
    if (options.failing === call) {
      throw new ForgeCredentialError("GitHub failed (502)");
    }
  };
  let comments = 0;
  const forge: GitHubApi = {
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
      fail("lookup");
      return null;
    },
    findPullRequestsForBranch: async () => {
      fail("lookup");
      return [];
    },
    isAncestor: async () => {
      fail("compare");
      return false;
    },
    createPullRequest: async (input) => ({
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      state: "open",
      head: input.head,
      headSha: "a".repeat(40),
      base: input.base,
      mergedAt: null,
      closedAt: null,
      created: true,
    }),
    getPullRequest: () => {
      throw new Error("not used");
    },
    setPullRequestState: async () => {
      throw new Error("not used");
    },
    mergePullRequest: async () => {
      throw new Error("not used");
    },
    upsertComment: async () => {
      fail("comment");
      comments += 1;
      return {
        id: 77,
        url: "https://github.com/acme/app/pull/5#issuecomment-77",
        created: comments === 1,
      };
    },
    updatePullRequestBody: async () => {
      throw new Error("not used");
    },
    dispatchWorkflow: async () => {
      throw new Error("not used");
    },
    getWorkflowRun: async () => {
      throw new Error("not used");
    },
    submitReview: async () => {
      throw new Error("not used");
    },
    rerunWorkflow: async () => {
      throw new Error("not used");
    },
  };
  const connection: GitHubConnection = {
    kind: "app",
    githubCom: true,
    appId: 101,
    installedOn: async (repos) =>
      new Map(
        repos.map((repo) => [`${repo.owner}/${repo.name}`.toLowerCase(), true]),
      ),
    quotaKey: () => {
      throw new Error("not used");
    },
    installed: async () => true,
    credential: async () => ({
      credential: { username: "x-access-token", password: "fixture" },
      fresh: false,
    }),
    api: () => forge,
  };
  const gate = createGitHubGate({
    catalog: CATALOG,
    connections: (_id, role) =>
      role === "author" ? { kind: "fixed", connection } : null,
    store: {
      context: async (sessionId) => ({
        ownerId: "owner-a",
        sessionId,
        repositoryId: "app",
        attachedRepositoryIds: null,
        repository: { url: "https://github.com/acme/app.git", branch: "main" },
        startedBy: null,
        agent: null,
        release: options.release ?? null,
        policy: options.policy ?? releasePolicy(null),
        ceiling: GITHUB_CEILING_NONE,
        repositoryCeiling: {
          repository_ids: ["app"],
          github_app_repositories: "listed",
        },
        ceilingRevision: 0,
      }),
      findDispatch: async () => null,
      recordReceipt: async (receipt) => {
        gateReceipts.push(receipt);
        return "66666666-6666-4666-8666-666666666666";
      },
    },
  });
  const service = createPullRequestService({
    authorization: createAuthorizationPolicy(),
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
      failHeadMoved: async () => {},
      schedule: async (input) => {
        scheduleCalls.push(input);
        if (options.schedule === undefined) throw new Error("not used");
        return options.schedule;
      },
      findSource: async (ownerId, sessionId, pushRequestId) =>
        ownerId === "owner-a" && sessionId === SESSION && pushRequestId === PUSH
          ? source
          : null,
      findPullRequest: async () => recorded,
      findBranchPullRequest: async () => null,
      recordReceipt: async (input) => {
        receipts.push(input as PullRequestReceipt);
        return "44444444-4444-4444-8444-444444444444";
      },
      recordStateChange: async () => {
        throw new Error("not used");
      },
      savePullRequest: async (input) => {
        recorded = {
          push_request_id: input.pushRequestId,
          session_id: input.sessionId,
          repository_id: input.repositoryId,
          number: input.number,
          url: input.url,
          head: input.head,
          base: input.base,
          created_at: "2026-10-13T00:00:00.000Z",
          receipt_id: "55555555-5555-4555-8555-555555555555",
        };
        return {
          pullRequest: recorded,
          created: input.created,
          receiptId: recorded.receipt_id,
        };
      },
    },
  });
  const api = createApiApp({
    authMode: options.authMode ?? "api-key",
    keyStore: {
      async find(hash) {
        const key = Object.keys(KEYS).find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        if (!key) return null;
        const agent = key === "csp_agent";
        return {
          id: `key-${key}`,
          ownerId: "owner-a",
          workspaceId: null,
          kind: agent ? ("agent" as const) : ("operator" as const),
          agentId: agent ? AGENT : null,
          createdByUserId: null,
          creatorRole: null,
          scopes: [...(KEYS[key] ?? [])],
        };
      },
    },
    registerRoutes: (router) => registerPullRequestRoutes(router, service),
  });
  return { api, receipts, gateReceipts, scheduleCalls };
}

function post(
  target: ReturnType<typeof app>,
  path: string,
  body: unknown,
  key = "csp_approver",
  push = PUSH,
) {
  return target.api.request(
    `/v1/sessions/${SESSION}/push-requests/${push}/pull-request${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

async function errorOf(response: Response | Promise<Response>) {
  const settled = await response;
  const { error } = apiErrorResponseSchema.parse(await settled.json());
  return { status: settled.status, code: error.code, details: error.details };
}

describe("pull request routes", () => {
  test("opens with 201, answers the same pull request with 200 after", async () => {
    const target = app();
    const first = await post(target, "", { title: "Result" });
    expect(first.status).toBe(201);
    expect(
      openPullRequestResponseSchema.parse(await first.json()),
    ).toMatchObject({
      created: true,
      pull_request: { number: 5, head: `agent/${SESSION}`, base: "main" },
    });
    const again = await post(target, "", {});
    expect(again.status).toBe(200);
    expect(
      openPullRequestResponseSchema.parse(await again.json()).created,
    ).toBe(false);
  });

  describe("?schedule=true", () => {
    const SCHEDULED: ScheduleOutcome = {
      kind: "scheduled",
      pushRequestId: PUSH,
      pushIntentId: null,
      receiptId: "66666666-6666-4666-8666-666666666666",
    };

    test("without the query a push that is not finished is still 409 not_pushed", async () => {
      const target = app({ state: "approved", schedule: SCHEDULED });
      expect(await errorOf(post(target, "", { title: "T" }))).toMatchObject({
        status: 409,
        code: "PUSH_NOT_PUSHED",
      });
      expect(target.scheduleCalls).toEqual([]);
    });

    test("with the query it answers 202 scheduled and holds the content", async () => {
      const target = app({ state: "approved", schedule: SCHEDULED });
      const response = await post(target, "?schedule=true", { title: "T" });
      expect(response.status).toBe(202);
      expect(openPullRequestResultSchema.parse(await response.json())).toEqual({
        status: "scheduled",
        push_request_id: PUSH,
        push_intent_id: null,
        receipt_id: SCHEDULED.receiptId,
      });
      expect(target.scheduleCalls).toMatchObject([
        {
          sessionId: SESSION,
          ref: { pushRequestId: PUSH },
          content: { title: "T" },
        },
      ]);
    });

    test("a request past scheduling is answered through the open path (200/201)", async () => {
      const target = app({
        schedule: { kind: "open_now", pushRequestId: PUSH },
      });
      const response = await post(target, "?schedule=true", { title: "T" });
      expect(response.status).toBe(201);
      expect(
        openPullRequestResponseSchema.parse(await response.json()),
      ).toMatchObject({ created: true });
    });

    test("a superseded request is 409 PUSH_REQUEST_RESOLVED with the later id", async () => {
      const LATER = "33333333-3333-4333-8333-333333333333";
      const target = app({
        schedule: {
          kind: "refused",
          refusal: "superseded",
          details: { push_request_id: LATER },
        },
      });
      expect(await errorOf(post(target, "?schedule=true", {}))).toMatchObject({
        status: 409,
        code: "PUSH_REQUEST_RESOLVED",
        details: { refusal: "superseded", push_request_id: LATER },
      });
    });

    test("only the string true is accepted", async () => {
      const target = app({ schedule: SCHEDULED });
      for (const query of [
        "?schedule=false",
        "?schedule=1",
        "?schedule=true&x=1",
      ]) {
        expect((await post(target, query, {})).status).toBe(400);
      }
      expect(target.scheduleCalls).toEqual([]);
    });
  });

  test("comments with 201, edits the marked one with 200", async () => {
    const target = app();
    await post(target, "", {});
    const first = await post(target, "/comments", { body: "Started" });
    expect(first.status).toBe(201);
    expect(
      commentPullRequestResponseSchema.parse(await first.json()).comment,
    ).toMatchObject({ id: 77, marker: "status", created: true });
    expect((await post(target, "/comments", { body: "Done" })).status).toBe(
      200,
    );
  });

  test("an agent key that may only submit to the session opens and comments on a pushed request", async () => {
    const target = app();
    const opened = await post(target, "", { title: "Result" }, "csp_agent");
    expect(opened.status).toBe(201);
    expect(
      openPullRequestResponseSchema.parse(await opened.json()).pull_request,
    ).toMatchObject({ number: 5, head: `agent/${SESSION}` });
    expect(
      (await post(target, "/comments", { body: "Done" }, "csp_agent")).status,
    ).toBe(201);
    expect(target.receipts.at(0)?.actor).toMatchObject({
      principal: { kind: "api_key", id: "key-csp_agent" },
      agent_id: AGENT,
    });
    // Before the push lands, only someone who may decide it may open one.
    expect(
      await errorOf(post(app({ state: "approved" }), "", {}, "csp_agent")),
    ).toMatchObject({
      status: 409,
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed" },
    });
  });

  test("refusals map to their statuses, each with a receipt", async () => {
    expect(
      await errorOf(post(app({ state: "approved" }), "", {})),
    ).toMatchObject({
      status: 409,
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed" },
    });
    expect(
      await errorOf(post(app({ binding: "sha256:old" }), "", {})),
    ).toMatchObject({ status: 409, code: "CATALOG_MISMATCH" });
    expect(
      await errorOf(post(app(), "/comments", { body: "x" })),
    ).toMatchObject({
      status: 409,
      code: "PULL_REQUEST_MISSING",
    });
    const unknown = app();
    expect(
      await errorOf(
        post(
          unknown,
          "",
          {},
          "csp_approver",
          "66666666-6666-4666-8666-666666666666",
        ),
      ),
    ).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(
      await errorOf(
        post(
          unknown,
          "/comments",
          { body: "x" },
          "csp_approver",
          "66666666-6666-4666-8666-666666666666",
        ),
      ),
    ).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(unknown.receipts.map((r) => r.result.refusal)).toEqual([
      "not_found",
      "not_found",
    ]);
    expect(
      await errorOf(post(app({ failing: "lookup" }), "", {})),
    ).toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });
    const invalid = app({
      release: { id: crypto.randomUUID() },
      policy: releasePolicy("invalid"),
    });
    expect(await errorOf(post(invalid, "", {}))).toMatchObject({
      status: 409,
      code: "GITHUB_REFUSED",
      details: {
        refusal: "github_refused",
        reason_code: "github_settings_unsupported",
      },
    });
    expect(invalid.receipts.map((r) => r.result.refusal)).toEqual([
      "github_refused",
    ]);
    expect(invalid.gateReceipts).toMatchObject([
      {
        operation: "mint_github_token",
        status: "failed",
        result: {
          purpose: "pull_request",
          reason_code: "github_settings_unsupported",
        },
      },
    ]);
  });

  test("a forge failure on a comment is a 503", async () => {
    const target = app({ failing: "comment" });
    await post(target, "", {});
    expect(
      await errorOf(post(target, "/comments", { body: "x" })),
    ).toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });
  });

  test("a read-only key, an unverified caller and a bad body are refused", async () => {
    for (const path of ["", "/comments"]) {
      const reader = app();
      expect(
        await errorOf(post(reader, path, { body: "x" }, "csp_reader")),
      ).toMatchObject({
        status: 403,
        code: "FORBIDDEN",
        details: { refusal: "missing_scope" },
      });
      expect(reader.receipts).toHaveLength(1);
      const open = app({ authMode: "none" });
      expect(
        (
          await open.api.request(
            `/v1/sessions/${SESSION}/push-requests/${PUSH}/pull-request${path}`,
            {
              method: "POST",
              headers: {
                "X-Owner-Id": "owner-a",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ body: "x" }),
            },
          )
        ).status,
      ).toBe(403);
      expect(open.receipts).toEqual([]);
      expect(
        await errorOf(post(app(), path, { body: "x", head: "main" })),
      ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
      expect(
        await errorOf(post(app(), path, { body: "x".repeat(70 * 1024) })),
      ).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    }
    expect(
      await errorOf(
        post(app(), "/comments", { body: "x", marker: "Bad Marker" }),
      ),
    ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });
});
