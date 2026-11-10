import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  type AgentGitHub,
  apiErrorResponseSchema,
  dispatchWorkflowResponseSchema,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  githubWorkflowRunSchema,
  listSessionGitHubRefusalsResponseSchema,
  listSessionOutcomesResponseSchema,
  rerunWorkflowResponseSchema,
  type SessionGitHubRefusal,
  type SessionOutcome,
  type SessionScope,
  sessionGitHubAttributionSchema,
  submitPullRequestReviewResponseSchema,
} from "@werft-ai/contracts";
import { createGitHubConnection } from "@werft-ai/forge-github";
import {
  MemoryLogSink,
  StructuredLogger,
  sanitizeText,
} from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createGitHubGate,
  createGitHubWorkService,
  createSessionAttributionService,
  createSessionOutcomeService,
  type GitHubConnection,
  type GitHubDispatchRecord,
  type GitHubGateReceipt,
  type SessionAttributionRecord,
  type SessionCatalog,
  type SessionOutcomeStore,
} from "@werft-ai/platform";
import { releasePolicy } from "@werft-ai/platform/testing/github";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import {
  registerGitHubWorkRoutes,
  registerSessionAttributionRoutes,
  registerSessionOutcomeRoutes,
} from "./github-work.ts";

const createApiApp = recordRouteErrors("routes/github-work.test.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const AGENT = "019a0000-0000-7000-8000-0000000000e1";
const RELEASE = "019a0000-0000-7000-8000-0000000000f1";
// Pull requests the author App opened, and one the reviewer App did.
const OPENED = 1;
const OPENED_BY_REVIEWER = 2;
const COMMIT = "a".repeat(40);
const KEYS: Record<string, readonly SessionScope[]> = {
  csp_writer: ["sessions:read", "sessions:write"],
  csp_reader: ["sessions:read"],
};
// Values no receipt, log or response may repeat.
const SECRET_INPUTS = {
  environment: "preview-input-value-7f3a",
  note: "second-input-value-c91e",
};

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const reviewerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const reviewerPrivateKey = reviewerKeys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({
    appId: 101,
    publicKey,
    installationId: 202,
    secondApp: {
      appId: 303,
      publicKey: reviewerKeys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      installationId: 404,
    },
  });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  for (const [number, author] of [
    [OPENED, 101],
    [OPENED_BY_REVIEWER, 303],
  ] as const) {
    github.pullRequests("acme", "app").push({
      number,
      head: `agent/${number}`,
      head_sha: COMMIT,
      base: "main",
      title: "",
      body: "",
      state: "open",
      merged_at: null,
      closed_at: null,
      author_app_id: author,
      html_url: `${github.origin}/acme/app/pull/${number}`,
    });
  }
});
afterAll(async () => {
  await github.stop();
});

const ACTIONS_ON: GitHubCeiling = {
  ...GITHUB_CEILING_NONE,
  actions: true,
  review: true,
};
const SETTINGS: AgentGitHub = {
  repositories: ["app"],
  push_approval: true,
  features: ACTIONS_ON,
  actions_allow: [
    { workflow: "ci.yml", ref: "feature/*" },
    { workflow: "deploy.yml" },
  ],
};

function app(
  options: {
    ceiling?: GitHubCeiling;
    repository?: "github" | "elsewhere";
    reviewer?: boolean;
    reviewerInstallationId?: number;
    settings?: AgentGitHub;
  } = {},
) {
  const catalog: SessionCatalog = {
    connections: {},
    repositories: {
      app: {
        url: `${github.origin}/acme/app.git`,
        branch: "main",
        auth: {
          kind: "github_app",
          app_id: 101,
          installation_id: 202,
          api_base: github.origin,
          value: privateKey,
          ref: { value_env: "GITHUB_APP_PRIVATE_KEY" },
        },
      },
    },
  };
  const warnings: string[] = [];
  const connection = createGitHubConnection({
    apiBase: github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    retryAfterBaseMs: 1,
    paced: false,
    logger: {
      warn: (message: string, fields?: Record<string, unknown>) =>
        warnings.push(JSON.stringify({ message, fields })),
    },
  });
  // The fake serves on localhost; the gate allows Actions on github.com only.
  const onGitHubCom: GitHubConnection = { ...connection, githubCom: true };
  const reviewer: GitHubConnection = {
    ...createGitHubConnection({
      apiBase: github.origin,
      credentials: {
        kind: "app",
        appId: 303,
        installationId: options.reviewerInstallationId ?? 404,
        privateKey: reviewerPrivateKey,
      },
      retryAfterBaseMs: 1,
      paced: false,
    }),
    githubCom: true,
  };
  const receipts: GitHubGateReceipt[] = [];
  const dispatches: GitHubDispatchRecord[] = [];
  let receiptCount = 0;
  const nextReceipt = () =>
    `44444444-4444-4444-8444-${String(++receiptCount).padStart(12, "0")}`;
  const gate = createGitHubGate({
    catalog,
    connections: (id, role) => {
      if (id !== "app" || options.repository === "elsewhere") return null;
      if (role === "author") return { kind: "fixed", connection: onGitHubCom };
      return options.reviewer === false
        ? null
        : { kind: "fixed", connection: reviewer };
    },
    store: {
      context: async (sessionId) =>
        sessionId === SESSION
          ? {
              ownerId: "owner-a",
              sessionId,
              repositoryId: "app",
              profileId: null,
              attachedRepositoryIds: null,
              repository: {
                url: catalog.repositories.app?.url ?? "",
                branch: "main",
              },
              startedBy: null,
              agent: { id: AGENT, workspaceId: "owner-a", githubEnabled: true },
              release: { id: RELEASE },
              policy: releasePolicy(options.settings ?? SETTINGS),
              ceiling: options.ceiling ?? ACTIONS_ON,
              repositoryCeiling: null,
              ceilingRevision: 0,
            }
          : null,
      findDispatch: async (repositoryId, runId) =>
        dispatches.find(
          (row) => row.repositoryId === repositoryId && row.runId === runId,
        ) ?? null,
      recordReceipt: async (receipt) => {
        receipts.push(receipt);
        return nextReceipt();
      },
    },
  });
  const service = createGitHubWorkService({
    authorization: createAuthorizationPolicy({
      sessions: {
        visibleTo: async (_ownerId, sessionId) => sessionId === SESSION,
        originOf: async () => null,
      },
    }),
    gate,
    redact: sanitizeText,
    store: {
      recordReceipt: async (receipt) => {
        receipts.push(receipt);
        return nextReceipt();
      },
      recordReview: async ({ context, actor, result }) => {
        receipts.push({
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          actor,
          operation: "review_pull_request",
          status: "succeeded",
          result,
          error: null,
        });
        return nextReceipt();
      },
      recordDispatch: async ({ context, actor, result, run }) => {
        receipts.push({
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          actor,
          operation: "dispatch_workflow",
          status: "succeeded",
          result,
          error: null,
        });
        if (run !== null) {
          dispatches.push({
            runId: run.id,
            repositoryId: context.repositoryId,
            workflow: run.workflow,
            ref: run.ref,
          });
        }
        return nextReceipt();
      },
      pullRequestOpener: async (_ownerId, _repositoryId, number) =>
        number === OPENED ? { sessionId: SESSION, agentId: AGENT } : null,
    },
  });
  const logs = new MemoryLogSink();
  const api = createApiApp({
    authMode: "api-key",
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    keyStore: {
      async find(hash) {
        const key = Object.keys(KEYS).find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        return key
          ? {
              id: `key-${key}`,
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: [...(KEYS[key] ?? [])],
            }
          : null;
      },
    },
    registerRoutes: (router) => registerGitHubWorkRoutes(router, service),
  });
  const send = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    key = "csp_writer",
    session = SESSION,
  ) => {
    const response = await api.request(
      `/v1/sessions/${session}/github${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      },
    );
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) : null,
    };
  };
  const dispatch = (body: unknown, key?: string) =>
    send("POST", "/workflow-dispatches", body, key);
  return {
    send,
    dispatch,
    receipts,
    dispatches,
    // Everything a caller or an operator could read back.
    seen: () => [
      ...warnings,
      ...logs.records.map((record) => JSON.stringify(record)),
      JSON.stringify(receipts),
    ],
  };
}

const errorOf = (json: unknown) => apiErrorResponseSchema.parse(json).error;

describe("GitHub work routes", () => {
  test("an allow-listed dispatch starts the run, and its receipt names the inputs but keeps none of their values", async () => {
    const target = app();
    const response = await target.dispatch({
      workflow: "ci.yml",
      ref: "feature/login",
      inputs: SECRET_INPUTS,
    });
    expect(response.status).toBe(201);
    const { run, receipt_id } = dispatchWorkflowResponseSchema.parse(
      response.json,
    );
    const [started] = github
      .workflowRuns("acme", "app")
      .filter((entry) => entry.id === run?.id);
    expect(started).toMatchObject({
      path: ".github/workflows/ci.yml",
      head_branch: "feature/login",
      event: "workflow_dispatch",
      inputs: SECRET_INPUTS,
    });
    if (run === null) throw new Error("GitHub named no run");
    expect(run.html_url).toBe(started?.html_url ?? "");
    expect(receipt_id).toMatch(/^44444444-/);
    expect(target.dispatches).toEqual([
      {
        runId: run.id,
        repositoryId: "app",
        workflow: "ci.yml",
        ref: "feature/login",
      },
    ]);
    const dispatched = target.receipts.find(
      (receipt) => receipt.operation === "dispatch_workflow",
    );
    expect(dispatched).toMatchObject({
      status: "succeeded",
      result: {
        session_id: SESSION,
        agent_id: AGENT,
        agent_release_id: RELEASE,
        repository_id: "app",
        workflow: "ci.yml",
        ref: "feature/login",
        input_keys: ["environment", "note"],
        run_id: run?.id,
        allowed_by: { workflow: "ci.yml", ref: "feature/*" },
      },
    });
    expect(
      target.receipts.find(
        (receipt) => receipt.operation === "mint_github_token",
      ),
    ).toMatchObject({
      status: "succeeded",
      result: { purpose: "dispatch", permissions: { actions: "write" } },
    });
    for (const text of target.seen()) {
      for (const value of Object.values(SECRET_INPUTS)) {
        expect(text).not.toContain(value);
      }
    }
  });

  test("a workflow or ref outside the allow-list, or an agent/ ref, is refused before GitHub hears of it", async () => {
    const target = app();
    const before = github.workflowRuns("acme", "app").length;
    for (const [body, reason] of [
      [{ workflow: "release.yml", ref: "main" }, "workflow_not_allowed"],
      [{ workflow: "ci.yml", ref: "main" }, "workflow_not_allowed"],
      [{ workflow: "deploy.yml", ref: "feature/x" }, "workflow_not_allowed"],
      [{ workflow: "ci.yml", ref: "feature/a/b" }, "workflow_not_allowed"],
      [{ workflow: "ci.yml", ref: `agent/${SESSION}` }, "agent_ref_refused"],
    ] as const) {
      const response = await target.dispatch(body);
      expect(response.status).toBe(403);
      expect(errorOf(response.json)).toMatchObject({
        code: "GITHUB_REFUSED",
        details: { reason_code: reason, receipt_id: expect.any(String) },
      });
    }
    expect(github.workflowRuns("acme", "app")).toHaveLength(before);
    expect(target.receipts.map((receipt) => receipt.status)).toEqual(
      Array(5).fill("failed"),
    );
    expect(target.receipts.at(-1)).toMatchObject({
      operation: "dispatch_workflow",
      result: { reason_code: "agent_ref_refused" },
      error: { code: "GITHUB_REFUSED" },
    });
  });

  test("GitHub refusing a dispatch is a 503 that repeats none of the inputs, in the answer, the logs or the receipts", async () => {
    const target = app();
    github.failDispatches(true);
    try {
      const response = await target.dispatch({
        workflow: "deploy.yml",
        ref: "main",
        inputs: SECRET_INPUTS,
      });
      expect(response.status).toBe(503);
      expect(errorOf(response.json)).toMatchObject({
        code: "BACKEND_UNAVAILABLE",
        details: { receipt_id: expect.any(String) },
      });
      for (const value of Object.values(SECRET_INPUTS)) {
        expect(response.text).not.toContain(value);
      }
    } finally {
      github.failDispatches(false);
    }
    expect(
      target.receipts.find(
        (receipt) =>
          receipt.operation === "dispatch_workflow" &&
          receipt.status === "failed",
      ),
    ).toMatchObject({
      result: {
        workflow: "deploy.yml",
        ref: "main",
        input_keys: ["environment", "note"],
        status: 422,
      },
    });
    expect(target.dispatches).toEqual([]);
    const seen = target.seen();
    expect(seen.join("\n")).toContain("workflow dispatch");
    for (const text of seen) {
      for (const value of Object.values(SECRET_INPUTS)) {
        expect(text).not.toContain(value);
      }
    }
  });

  test("a run the platform dispatched is rerun; one a push started is not", async () => {
    const target = app();
    const dispatched = await target.dispatch({
      workflow: "deploy.yml",
      ref: "main",
    });
    const runId = dispatchWorkflowResponseSchema.parse(dispatched.json).run?.id;
    const rerun = await target.send("POST", `/workflow-runs/${runId}/rerun`, {
      failed_only: true,
    });
    expect(rerun.status).toBe(201);
    rerunWorkflowResponseSchema.parse(rerun.json);
    expect(
      github.workflowRuns("acme", "app").find((run) => run.id === runId)
        ?.reruns,
    ).toEqual([{ failedOnly: true }]);
    expect(target.receipts.at(-1)).toMatchObject({
      operation: "rerun_workflow",
      status: "succeeded",
      result: { run_id: runId, failed_only: true, workflow: "deploy.yml" },
    });

    const pushed = github.addWorkflowRun("acme", "app", {
      path: ".github/workflows/deploy.yml",
      head_branch: "main",
    });
    const refused = await target.send(
      "POST",
      `/workflow-runs/${pushed}/rerun`,
      {},
    );
    expect(refused.status).toBe(403);
    expect(errorOf(refused.json).details).toMatchObject({
      reason_code: "run_ref_unprovable",
    });
    expect(
      github.workflowRuns("acme", "app").find((run) => run.id === pushed)
        ?.reruns,
    ).toEqual([]);
  });

  test("with Actions off under the workspace ceiling, every piece of work is refused 409", async () => {
    const target = app({ ceiling: GITHUB_CEILING_NONE });
    const before = github.workflowRuns("acme", "app").length;
    const dispatched = await target.dispatch({
      workflow: "deploy.yml",
      ref: "main",
    });
    expect(dispatched.status).toBe(409);
    expect(errorOf(dispatched.json)).toMatchObject({
      code: "GITHUB_REFUSED",
      details: { reason_code: "over_workspace_ceiling" },
    });
    const read = await target.send("GET", "/workflow-runs/1");
    expect(read.status).toBe(409);
    expect(errorOf(read.json).details).toMatchObject({
      reason_code: "over_workspace_ceiling",
    });
    const rerun = await target.send("POST", "/workflow-runs/1/rerun", {});
    expect(rerun.status).toBe(409);
    expect(github.workflowRuns("acme", "app")).toHaveLength(before);
  });

  test("with Actions on, any run in the repository can be read; one GitHub does not know is 404", async () => {
    const target = app();
    const pushed = github.addWorkflowRun("acme", "app", {
      path: ".github/workflows/ci.yml",
      head_branch: "feature/x",
    });
    const read = await target.send(
      "GET",
      `/workflow-runs/${pushed}`,
      undefined,
      "csp_reader",
    );
    expect(read.status).toBe(200);
    expect(githubWorkflowRunSchema.parse(read.json)).toEqual({
      id: pushed,
      path: ".github/workflows/ci.yml",
      head_branch: "feature/x",
      status: "completed",
      conclusion: "failure",
      html_url: `${github.origin}/acme/app/actions/runs/${pushed}`,
    });
    expect(target.receipts).toMatchObject([
      {
        operation: "mint_github_token",
        result: { purpose: "actions_read", permissions: { actions: "read" } },
      },
    ]);
    const missing = await target.send("GET", "/workflow-runs/123");
    expect(missing.status).toBe(404);
    expect(errorOf(missing.json).code).toBe("NOT_FOUND");
  });

  test("a session the caller cannot see is 404 on every route, before the gate", async () => {
    const target = app();
    const other = "99999999-9999-4999-8999-999999999999";
    for (const response of [
      await target.send(
        "POST",
        "/workflow-dispatches",
        { workflow: "deploy.yml", ref: "main" },
        "csp_writer",
        other,
      ),
      await target.send(
        "GET",
        "/workflow-runs/1",
        undefined,
        "csp_writer",
        other,
      ),
      await target.send(
        "POST",
        "/workflow-runs/1/rerun",
        {},
        "csp_writer",
        other,
      ),
    ]) {
      expect(response.status).toBe(404);
      expect(errorOf(response.json).code).toBe("NOT_FOUND");
    }
    expect(target.receipts).toEqual([]);
  });

  test("a missing App connection is unavailable; a read-only key may not dispatch or rerun", async () => {
    const elsewhere = app({ repository: "elsewhere" });
    for (const [response, status, code] of [
      [
        await elsewhere.dispatch({ workflow: "deploy.yml", ref: "main" }),
        503,
        "BACKEND_UNAVAILABLE",
      ],
      [
        await elsewhere.send("GET", "/workflow-runs/1"),
        503,
        "BACKEND_UNAVAILABLE",
      ],
      [
        await elsewhere.send("POST", "/workflow-runs/1/rerun", {}),
        403,
        "GITHUB_REFUSED",
      ],
    ] as const) {
      expect(response.status).toBe(status);
      expect(errorOf(response.json).code).toBe(code);
    }
    const target = app();
    for (const response of [
      await target.dispatch(
        { workflow: "deploy.yml", ref: "main" },
        "csp_reader",
      ),
      await target.send("POST", "/workflow-runs/1/rerun", {}, "csp_reader"),
    ]) {
      expect(response.status).toBe(403);
      expect(errorOf(response.json).code).toBe("FORBIDDEN");
    }
    expect(target.receipts.filter((r) => r.status === "succeeded")).toEqual([]);
  });

  test("a bad body is 400, a bad run id 404, and an oversized body 413", async () => {
    const target = app();
    for (const body of [
      { workflow: "../x.yml", ref: "main" },
      { workflow: "deploy.yml", ref: "refs/heads/main" },
      { workflow: "deploy.yml", ref: "main", extra: 1 },
      {
        workflow: "deploy.yml",
        ref: "main",
        inputs: Object.fromEntries(
          Array.from({ length: 26 }, (_, index) => [`k${index}`, "v"]),
        ),
      },
    ]) {
      expect((await target.dispatch(body)).status).toBe(400);
    }
    expect(
      (
        await target.send("POST", "/workflow-runs/1/rerun", {
          failed_only: "yes",
        })
      ).status,
    ).toBe(400);
    // A run id that cannot be one names no resource.
    for (const id of ["0", "abc"]) {
      expect((await target.send("GET", `/workflow-runs/${id}`)).status).toBe(
        404,
      );
    }
    expect(
      (
        await target.dispatch({
          workflow: "deploy.yml",
          ref: "main",
          inputs: { big: "x".repeat(70 * 1024) },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await target.send("POST", "/workflow-runs/1/rerun", {
          pad: "x".repeat(70 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(target.receipts).toEqual([]);
  });
});

describe("GET /v1/sessions/{id}/github/attribution", () => {
  const OTHER_OWNERS = "22222222-2222-4222-8222-222222222222";
  const DOWN = "33333333-3333-4333-8333-333333333333";
  let lastRequester: {
    userId: string | null;
    github: { id: string; login: string } | null;
  } | null = null;
  const records: Record<string, SessionAttributionRecord> = {
    [SESSION]: {
      ownerId: "owner-a",
      trigger: "personal_key",
      agentId: AGENT,
      agentReleaseId: RELEASE,
      starter: { userId: "user-1", github: { id: "583231", login: "octocat" } },
      authorApp: null,
      authorPinned: false,
    },
    [OTHER_OWNERS]: {
      ownerId: "owner-b",
      trigger: "web",
      agentId: null,
      agentReleaseId: null,
      starter: null,
      authorApp: null,
      authorPinned: false,
    },
  };
  const api = createApiApp({
    authMode: "api-key",
    keyStore: {
      async find(hash) {
        const key = ["attr_reader", "attr_none"].find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        return key
          ? {
              id: `key-${key}`,
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: key === "attr_reader" ? ["sessions:read"] : [],
            }
          : null;
      },
    },
    registerRoutes: (router) =>
      registerSessionAttributionRoutes(
        router,
        createSessionAttributionService({
          authorization: createAuthorizationPolicy(),
          store: {
            lastRequesterOf: async () => lastRequester,
            attribution: async (sessionId) => {
              if (sessionId === DOWN) {
                throw Object.assign(new Error("connection refused"), {
                  code: "ECONNREFUSED",
                });
              }
              return records[sessionId] ?? null;
            },
          },
        }),
      ),
  });
  const read = async (session: string, key?: string) => {
    const response = await api.request(
      `/v1/sessions/${session}/github/attribution`,
      key === undefined ? {} : { headers: { Authorization: `Bearer ${key}` } },
    );
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  test("names the trigger and the linked starter's login", async () => {
    const answer = await read(SESSION.toUpperCase(), "attr_reader");
    expect(answer.status).toBe(200);
    expect(sessionGitHubAttributionSchema.parse(answer.json)).toEqual({
      trigger: "personal_key",
      attribution: "co_author",
      login: "octocat",
    });
  });

  test("goes by the latest turn's requester, not the starter (94S-1304)", async () => {
    try {
      lastRequester = { userId: "user-2", github: null };
      expect((await read(SESSION, "attr_reader")).json).toEqual({
        trigger: "personal_key",
        attribution: "unlinked",
        login: null,
      });
      lastRequester = {
        userId: "user-3",
        github: { id: "42", login: "hubot" },
      };
      expect((await read(SESSION, "attr_reader")).json).toEqual({
        trigger: "personal_key",
        attribution: "co_author",
        login: "hubot",
      });
      lastRequester = { userId: null, github: null };
      expect((await read(SESSION, "attr_reader")).json).toEqual({
        trigger: "personal_key",
        attribution: "app_only",
        login: null,
      });
    } finally {
      lastRequester = null;
    }
  });

  test("another owner's session or none is 404; no scope 403; no key 401; a store outage 503", async () => {
    expect((await read(OTHER_OWNERS, "attr_reader")).status).toBe(404);
    expect(
      (await read("44444444-4444-4444-8444-444444444444", "attr_reader"))
        .status,
    ).toBe(404);
    expect((await read(SESSION, "attr_none")).status).toBe(403);
    expect((await read(SESSION)).status).toBe(401);
    expect((await read(DOWN, "attr_reader")).status).toBe(503);
  });
});

describe("GET /v1/sessions/{id}/outcomes and …/github/refusals", () => {
  const DOWN = "33333333-3333-4333-8333-333333333333";
  const outcome: SessionOutcome = {
    id: "019a0000-0000-7000-8000-0000000000a1",
    type: "github_pull_request",
    url: "https://github.com/acme/app/pull/7",
    repository_id: "app",
    external_id: "7",
    state: "merged",
    state_changed_at: "2026-10-31T01:00:00.000Z",
    merged_at: "2026-10-31T01:00:00.000Z",
    closed_at: "2026-10-31T01:00:00.000Z",
    state_checked_at: "2026-10-31T01:02:00.000Z",
    check_error: null,
    metadata: {
      title: "Retry failed payments",
      head: `agent/${SESSION}`,
      base: "main",
      adopted: false,
      merge_commit_sha: "d".repeat(40),
      additions: 2,
      deletions: 1,
      changed_files: 1,
      commits: 1,
    },
    created_at: "2026-10-31T00:00:00.000Z",
  };
  const review: SessionOutcome = {
    id: "019a0000-0000-7000-8000-0000000000a2",
    type: "github_review",
    url: "https://github.com/acme/app/pull/9#pullrequestreview-77",
    repository_id: "app",
    external_id: "77",
    state: "submitted",
    state_changed_at: "2026-10-31T02:00:00.000Z",
    merged_at: null,
    closed_at: null,
    state_checked_at: null,
    check_error: null,
    metadata: {
      number: 9,
      event: "APPROVE",
      commit_id: "e".repeat(40),
      opened_by_session_id: null,
    },
    created_at: "2026-10-31T02:00:00.000Z",
  };
  const refusal: SessionGitHubRefusal = {
    receipt_id: "019a0000-0000-7000-8000-0000000000b1",
    operation: "mint_github_token",
    purpose: "push",
    reason_code: "github_disabled",
    created_at: "2026-10-31T00:30:00.000Z",
  };
  const asked: Array<[string, string, number?]> = [];
  const answer = <T>(owner: string, session: string, items: T[]) => {
    if (session === DOWN) {
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    }
    return owner === "owner-a" && session === SESSION ? items : null;
  };
  const api = createApiApp({
    authMode: "api-key",
    keyStore: {
      async find(hash) {
        const key = ["out_reader", "out_none"].find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        return key
          ? {
              id: `key-${key}`,
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: key === "out_reader" ? ["sessions:read"] : [],
            }
          : null;
      },
    },
    registerRoutes: (router) =>
      registerSessionOutcomeRoutes(
        router,
        createSessionOutcomeService({
          authorization: createAuthorizationPolicy(),
          store: {
            list: async (owner, session) => {
              asked.push([owner, session]);
              return answer(owner, session, [outcome, review]);
            },
            refusals: async (owner, session, limit) => {
              asked.push([owner, session, limit]);
              return answer(owner, session, [refusal]);
            },
          } as SessionOutcomeStore,
        }),
      ),
  });
  const read = async (path: string, key?: string) => {
    const response = await api.request(
      path,
      key === undefined ? {} : { headers: { Authorization: `Bearer ${key}` } },
    );
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  test("lists the session's outcomes and its latest ten refusals", async () => {
    const outcomes = await read(
      `/v1/sessions/${SESSION.toUpperCase()}/outcomes`,
      "out_reader",
    );
    expect(outcomes.status).toBe(200);
    expect(listSessionOutcomesResponseSchema.parse(outcomes.json)).toEqual({
      items: [outcome, review],
    });
    const refusals = await read(
      `/v1/sessions/${SESSION}/github/refusals`,
      "out_reader",
    );
    expect(refusals.status).toBe(200);
    expect(
      listSessionGitHubRefusalsResponseSchema.parse(refusals.json),
    ).toEqual({ items: [refusal] });
    expect(asked.slice(-2)).toEqual([
      ["owner-a", SESSION],
      ["owner-a", SESSION, 10],
    ]);
  });

  test("an unseen session is 404; no scope 403; no key 401; a store outage 503", async () => {
    for (const path of ["outcomes", "github/refusals"]) {
      const at = (session: string) => `/v1/sessions/${session}/${path}`;
      expect(
        (await read(at("44444444-4444-4444-8444-444444444444"), "out_reader"))
          .status,
        path,
      ).toBe(404);
      expect((await read(at("not-a-uuid"), "out_reader")).status, path).toBe(
        404,
      );
      expect((await read(at(SESSION), "out_none")).status, path).toBe(403);
      expect((await read(at(SESSION))).status, path).toBe(401);
      expect((await read(at(DOWN), "out_reader")).status, path).toBe(503);
    }
  });
});

describe("reviewing a pull request", () => {
  const review = (
    target: ReturnType<typeof app>,
    body: unknown,
    number: number | string = OPENED,
    key?: string,
  ) => target.send("POST", `/pull-requests/${number}/reviews`, body, key);

  test("the review goes out with the reviewer App's token and names the commit; its receipt keeps no body", async () => {
    const target = app();
    const approved = await review(target, {
      event: "APPROVE",
      commit_id: COMMIT,
    });
    expect(approved.status).toBe(201);
    const { receipt_id, review: sent } =
      submitPullRequestReviewResponseSchema.parse(approved.json);
    expect(receipt_id).toMatch(/^44444444-/);
    const changes = await review(target, {
      event: "REQUEST_CHANGES",
      commit_id: COMMIT,
      body: "review-body-value-5d2b",
    });
    expect(changes.status).toBe(201);
    expect(
      github.reviews("acme", "app", OPENED).map(({ id: _id, ...rest }) => rest),
    ).toEqual([
      {
        pull_number: OPENED,
        commit_id: COMMIT,
        event: "APPROVE",
        body: null,
        app_id: 303,
      },
      {
        pull_number: OPENED,
        commit_id: COMMIT,
        event: "REQUEST_CHANGES",
        body: "review-body-value-5d2b",
        app_id: 303,
      },
    ]);
    expect(sent.id).toBe(github.reviews("acme", "app", OPENED)[0]?.id ?? 0);
    expect(target.receipts).toMatchObject([
      {
        operation: "mint_github_token",
        status: "succeeded",
        result: {
          role: "reviewer",
          app_id: 303,
          permissions: { pull_requests: "write" },
        },
      },
      {
        operation: "review_pull_request",
        status: "succeeded",
        result: {
          session_id: SESSION,
          repository_id: "app",
          number: OPENED,
          commit_id: COMMIT,
          event: "APPROVE",
          opened_by_session_id: SESSION,
          opened_by_agent_id: AGENT,
          review_id: sent.id,
        },
      },
      { operation: "review_pull_request", status: "succeeded" },
    ]);
    for (const text of target.seen()) {
      expect(text).not.toContain("review-body-value-5d2b");
    }
  });

  test("a body with a mention and a secret-shaped line reaches GitHub cleaned", async () => {
    const target = app();
    const sent = await review(target, {
      event: "COMMENT",
      commit_id: COMMIT,
      body: "ping @octocat please\ntoken ghp_abc123\nfine line",
    });
    expect(sent.status).toBe(201);
    const posted = github.reviews("acme", "app", OPENED).at(-1)?.body;
    expect(posted).toBe("ping @​octocat please\n[REDACTED]\nfine line");
  });

  test("a head that is not the commit is a 409 stale_commit and no review goes to GitHub", async () => {
    const before = github.reviews("acme", "app", OPENED).length;
    const target = app();
    // Token mints are not in this log; only the calls made for the review are.
    const requestsBefore = github.apiRequests.length;
    const stale = await review(target, {
      event: "APPROVE",
      commit_id: "b".repeat(40),
    });
    expect(stale.status).toBe(409);
    expect(errorOf(stale.json)).toMatchObject({
      code: "GITHUB_REFUSED",
      details: {
        reason_code: "stale_commit",
        head_sha: COMMIT,
        receipt_id: expect.any(String),
      },
    });
    expect(target.receipts.at(-1)).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: { number: OPENED, reason_code: "stale_commit" },
    });
    expect(github.reviews("acme", "app", OPENED).length).toBe(before);
    // The forge call record: the pull request was read, no review was posted.
    const calls = github.apiRequests
      .slice(requestsBefore)
      .map((call) => `${call.method} ${call.path}`);
    console.log("forge calls during the stale review:", calls);
    expect(calls).toEqual([`GET /repos/acme/app/pulls/${OPENED}`]);
  });

  test("GitHub refusing the review is a 503 with a failed receipt", async () => {
    const target = app();
    const response = await review(
      target,
      { event: "APPROVE", commit_id: COMMIT },
      OPENED_BY_REVIEWER,
    );
    expect(response.status).toBe(503);
    expect(errorOf(response.json)).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: expect.any(String) },
    });
    expect(target.receipts.at(-1)).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: {
        number: OPENED_BY_REVIEWER,
        opened_by_session_id: null,
        status: 422,
      },
    });
    expect(github.reviews("acme", "app", OPENED_BY_REVIEWER)).toEqual([]);
  });

  test("a reviewer App not installed on the repository is a 503 that still leaves the review's failed receipt", async () => {
    const before = github.reviews("acme", "app", OPENED).length;
    const target = app({ reviewerInstallationId: 999 });
    const response = await review(target, {
      event: "APPROVE",
      commit_id: COMMIT,
    });
    expect(response.status).toBe(503);
    expect(errorOf(response.json)).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: expect.any(String) },
    });
    expect(target.receipts).toMatchObject([
      {
        operation: "review_pull_request",
        status: "failed",
        result: {
          role: "reviewer",
          app_id: 303,
          number: OPENED,
          commit_id: COMMIT,
          event: "APPROVE",
        },
      },
    ]);
    expect(github.reviews("acme", "app", OPENED)).toHaveLength(before);
  });

  test("no reviewer App, review off for the agent, or over the ceiling: refused before GitHub hears of it", async () => {
    const before = github.reviews("acme", "app", OPENED).length;
    const approve = { event: "APPROVE", commit_id: COMMIT };
    for (const [target, status, reason] of [
      [app({ reviewer: false }), 409, "no_reviewer_app"],
      [
        app({
          settings: {
            ...SETTINGS,
            features: { ...ACTIONS_ON, review: false },
          },
        }),
        403,
        "feature_off",
      ],
      [
        app({ ceiling: { ...ACTIONS_ON, review: false } }),
        409,
        "over_workspace_ceiling",
      ],
    ] as const) {
      const response = await review(target, approve);
      expect(response.status).toBe(status);
      expect(errorOf(response.json)).toMatchObject({
        code: "GITHUB_REFUSED",
        details: { reason_code: reason, receipt_id: expect.any(String) },
      });
      expect(target.receipts).toMatchObject([
        {
          operation: "review_pull_request",
          status: "failed",
          result: {
            reason_code: reason,
            number: OPENED,
            commit_id: COMMIT,
            event: "APPROVE",
          },
        },
      ]);
    }
    expect(github.reviews("acme", "app", OPENED)).toHaveLength(before);
  });

  test("bad bodies, missing sessions, oversized bodies, read-only keys and missing App connections are refused", async () => {
    const target = app();
    for (const body of [
      { event: "APPROVE" },
      { event: "APPROVE", commit_id: "abc" },
      { event: "COMMENT", commit_id: COMMIT },
      { event: "DISMISS", commit_id: COMMIT },
      { event: "APPROVE", commit_id: COMMIT, extra: 1 },
    ]) {
      expect((await review(target, body)).status).toBe(400);
    }
    const approve = { event: "APPROVE", commit_id: COMMIT };
    for (const number of ["0", "abc"]) {
      expect((await review(target, approve, number)).status).toBe(404);
    }
    const unseen = await target.send(
      "POST",
      `/pull-requests/${OPENED}/reviews`,
      approve,
      "csp_writer",
      "99999999-9999-4999-8999-999999999999",
    );
    expect(unseen.status).toBe(404);
    expect(
      (
        await review(target, {
          ...approve,
          body: "x".repeat(70 * 1024),
        })
      ).status,
    ).toBe(413);
    const reader = await review(target, approve, OPENED, "csp_reader");
    expect(reader.status).toBe(403);
    expect(errorOf(reader.json).code).toBe("FORBIDDEN");
    expect(target.receipts).toEqual([]);
    const elsewhere = await review(app({ repository: "elsewhere" }), approve);
    expect(elsewhere.status).toBe(409);
    expect(errorOf(elsewhere.json)).toMatchObject({
      code: "GITHUB_REFUSED",
      details: { reason_code: "no_reviewer_app" },
    });
  });
});
