import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listPushRequestsResponseSchema,
  type PushRequest,
  pushRequestSchema,
  type SessionScope,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  authenticatedIdentity,
  type CreatePushRequestInput,
  createAuthorizationPolicy,
  createPushRequestService,
  type DecidePushRequestInput,
  type IdentityReader,
  type IdentityStore,
  type PushRefusalRecord,
  type PushRequestStore,
  type PushSourceResult,
  type ResolvedWebSession,
  type SessionCatalog,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerPushRequestRoutes } from "./push-requests.ts";

const createApiApp = recordRouteErrors("routes/push-requests.test.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const RECEIPT = "33333333-3333-4333-8333-333333333333";
const COMMIT = "a".repeat(40);
// A session whose release has no GitHub settings: its own repository only.
const NO_GITHUB = {
  profileId: null,
  attached: null,
  policySource: "release" as const,
  github: null,
  repositoryCeiling: null,
  githubEnabled: false,
  pushAttached: "ask" as const,
  attachedApproval: null,
  policyFields: { policy_source: "release" as const },
};
const KEYS: Record<string, readonly SessionScope[]> = {
  csp_writer: ["sessions:read", "sessions:write"],
  csp_approver: ["sessions:read", "sessions:approve"],
  csp_service: ["sessions:read", "sessions:write", "sessions:approve"],
  csp_agent: ["sessions:read", "sessions:write"],
};
// An agent key: it calls as its agent, and its receipts say so.
const AGENT_KEY = "csp_agent";
const AGENT = "019a0000-0000-7000-8000-0000000000e1";
// A key a person issued in the workspace; it stands for that person.
const PERSONAL = "csp_personal";
const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const ISSUER = "019a0000-0000-7000-8000-0000000000c1";
const SIGNED_IN = "019a0000-0000-7000-8000-0000000000d1";

const webSessions = new Map<string, ResolvedWebSession>();
function cookieFor(userId: string): string {
  const token = generateWebSessionToken();
  webSessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId,
    email: "owner@example.com",
    displayName: "owner",
    locale: null,
    workspaceId: WORKSPACE,
    role: "owner",
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}
const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return webSessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;
// As the database reader does: a personal key is judged as its issuer.
const keyIssuers: IdentityReader = {
  async reread(subject) {
    const { principal } = subject;
    return principal.kind === "api_key" && principal.id === `key-${PERSONAL}`
      ? {
          status: "ok",
          principal,
          keyCreator: { userId: ISSUER, role: "owner" },
        }
      : authenticatedIdentity.reread(subject);
  },
};

const PINNED: PushRequest = {
  id: PUSH,
  session_id: SESSION,
  repository_id: "sample-app",
  checkpoint_revision: 2,
  git_commit: COMMIT,
  target_branch: `agent/${SESSION}`,
  state: "requested",
  requested_by: {
    principal: { kind: "api_key", id: "key-csp_writer" },
    actor_user_id: null,
    agent_id: null,
  },
  requested_at: "2026-10-13T00:00:00.000Z",
  resolved_by: null,
  resolved_at: null,
  resolution_reason: null,
  request_receipt_id: RECEIPT,
  resolution_receipt_id: null,
  finished_at: null,
  push_receipt_id: null,
  origin: "direct",
  flow: "legacy",
  pr_state: null,
  pr_error: null,
  pr_number: null,
  pr_url: null,
};

const CATALOG = {
  profiles: {},
  repositories: {
    "sample-app": {
      url: "https://git.example/acme/sample-app.git",
      branch: "main",
      profiles: ["default"],
      auth: { kind: "github_app", registered: true } as const,
    },
    docs: {
      url: "https://git.example/acme/docs.git",
      branch: "main",
      auth: { kind: "github_app", registered: true } as const,
      profiles: ["default"],
    },
  },
} satisfies SessionCatalog;

type Seen = {
  created: CreatePushRequestInput[];
  decided: DecidePushRequestInput[];
  refusals: PushRefusalRecord[];
};

function app(
  options: {
    store?: Partial<PushRequestStore>;
    source?: PushSourceResult;
    authMode?: "none";
    startedBy?: string | null;
  } = {},
) {
  const seen: Seen = { created: [], decided: [], refusals: [] };
  const store: PushRequestStore = {
    findSession: async (ownerId, sessionId) =>
      ownerId === "owner-a" && sessionId === SESSION
        ? { ...NO_GITHUB, repositoryId: "sample-app", policyApproval: null }
        : null,
    recordRefusal: async (input) => {
      seen.refusals.push(input);
      return RECEIPT;
    },
    replayCreate: async () => null,
    create: async (input) => {
      seen.created.push(input);
      return { outcome: "written", request: PINNED };
    },
    list: async (ownerId, sessionId) =>
      ownerId === "owner-a" && sessionId === SESSION ? [PINNED] : null,
    snapshot: async () => null,
    get: async (ownerId, _sessionId, id) =>
      ownerId === "owner-a" && id === PUSH ? PINNED : null,
    decide: async (input) => {
      seen.decided.push(input);
      return {
        outcome: "written",
        request: { ...PINNED, state: "approved" },
      };
    },
    claimNextApproved: async () => null,
    finish: async () => false,
    ...options.store,
  };
  const service = createPushRequestService({
    authorization: createAuthorizationPolicy({
      identity: keyIssuers,
      sessions: {
        visibleTo: async () => true,
        originOf: async () => ({
          creatorUserId: options.startedBy ? null : ISSUER,
          creatorApiKeyId: options.startedBy ?? null,
        }),
      },
    }),
    store,
    catalog: CATALOG,
    intents: { list: async () => [] } as never,
    source: {
      readPushSource: async () =>
        options.source ?? { status: "ready", revision: 2, gitCommit: COMMIT },
      readPushSourceAt: async () =>
        options.source ?? { status: "ready", revision: 2, gitCommit: COMMIT },
    },
  });
  const api = createApiApp({
    authMode: options.authMode ?? "api-key",
    keyStore: {
      async find(hash) {
        const token = [...Object.keys(KEYS), PERSONAL].find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        if (!token) return null;
        const personal = token === PERSONAL;
        const agent = token === AGENT_KEY;
        return {
          id: `key-${token}`,
          ownerId: personal ? WORKSPACE : "owner-a",
          workspaceId: personal ? WORKSPACE : null,
          kind: personal
            ? ("personal" as const)
            : agent
              ? ("agent" as const)
              : ("operator" as const),
          agentId: agent ? AGENT : null,
          createdByUserId: personal ? ISSUER : null,
          creatorRole: personal ? ("owner" as const) : null,
          scopes: [
            ...(KEYS[token] ?? [
              "sessions:read",
              "sessions:write",
              "sessions:approve",
            ]),
          ],
        };
      },
    },
    identity,
    registerRoutes: (router) => registerPushRequestRoutes(router, service),
  });
  return { api, seen };
}

function post(
  target: ReturnType<typeof app>,
  path: string,
  body: unknown,
  token = "csp_writer",
  headers: Record<string, string> = { "Idempotency-Key": "key-1" },
) {
  return target.api.request(`/v1/sessions/${SESSION}/push-requests${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const resolve = (
  target: ReturnType<typeof app>,
  action: "approve" | "reject",
  body: unknown,
  token = "csp_approver",
  headers?: Record<string, string>,
) => post(target, `/${PUSH}/${action}`, body, token, headers);

async function errorOf(response: Response | Promise<Response>) {
  const settled = await response;
  const { error } = apiErrorResponseSchema.parse(await settled.json());
  return { status: settled.status, code: error.code, details: error.details };
}

describe("push request routes", () => {
  test("POST pins the latest checkpoint and the platform's branch", async () => {
    const target = app();
    const response = await post(target, "", {});
    expect(response.status).toBe(201);
    expect(pushRequestSchema.parse(await response.json()).id).toBe(PUSH);
    expect(target.seen.created).toEqual([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        actor: {
          principal: { kind: "api_key", id: "key-csp_writer" },
          actor_user_id: null,
          agent_id: null,
        },
        idempotencyKey: "key-1",
        payloadHash: expect.any(String),
        repositoryId: "sample-app",
        repositoryBinding: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        targetBranch: `agent/${SESSION}`,
        checkpointRevision: 2,
        gitCommit: COMMIT,
        policyApproval: null,
        policyFields: { policy_source: "release" },
      },
    ]);
  });

  test("POST with a branch pins agent/<session-id>-<branch>; a bad branch is a 400", async () => {
    const target = app();
    const send = (body: unknown, key: string) =>
      post(target, "", body, undefined, { "Idempotency-Key": key });
    expect((await send({ branch: "docs-fix" }, "branch-1")).status).toBe(201);
    expect(target.seen.created.at(-1)?.targetBranch).toBe(
      `agent/${SESSION}-docs-fix`,
    );
    for (const branch of ["", "Upper", "a/b", "-lead", "x".repeat(41)]) {
      expect((await send({ branch }, `bad-${branch}`)).status).toBe(400);
    }
    expect(target.seen.created).toHaveLength(1);
  });

  test("POST to another repository needs the release to list it and the profile to allow it", async () => {
    const github = {
      repositories: ["sample-app", "docs"],
      features: {
        workflows: false,
        actions: false,
        checks: false,
        issues: false,
        review: false,
      },
      actions_allow: [],
      push_approval: true,
    };
    const toDocs = (target: ReturnType<typeof app>, key: string) =>
      post(target, "", { repository_id: "docs" }, undefined, {
        "Idempotency-Key": key,
      });
    const session = {
      repositoryId: "sample-app",
      profileId: "default",
      attached: null,
      policySource: "release" as const,
      github,
      repositoryCeiling: null,
      githubEnabled: true,
      policyApproval: null,
      pushAttached: "ask" as const,
      attachedApproval: null,
      policyFields: {},
    };

    // The release does not list it: refused with a receipt, nothing created.
    const unlisted = app({
      store: {
        findSession: async () => ({
          ...session,
          github: { ...github, repositories: ["sample-app"] },
        }),
      },
    });
    const refused = await toDocs(unlisted, "other-1");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        details: { refusal: "repository_not_allowed", receipt_id: RECEIPT },
      },
    });
    expect(unlisted.seen.refusals.at(-1)?.result).toMatchObject({
      repository_id: "docs",
      refusal: "repository_not_allowed",
    });
    expect(unlisted.seen.created).toEqual([]);

    // Listed, but the catalog does not let the session's profile run it.
    const listed = app({ store: { findSession: async () => session } });
    expect((await toDocs(listed, "other-2")).status).toBe(403);
    expect(listed.seen.created).toEqual([]);

    // GitHub off for the agent.
    const off = app({
      store: {
        findSession: async () => ({ ...session, githubEnabled: false }),
      },
    });
    expect((await toDocs(off, "other-3")).status).toBe(403);
  });

  test("POST from a session whose release pushes without approval passes that release on", async () => {
    const approval = {
      releaseId: "019a0000-0000-7000-8000-0000000000f1",
      source: "release" as const,
      settingsRevision: null,
    };
    const target = app({
      store: {
        findSession: async () => ({
          ...NO_GITHUB,
          repositoryId: "sample-app",
          policyApproval: approval,
        }),
      },
    });
    expect((await post(target, "", {})).status).toBe(201);
    expect(target.seen.created).toMatchObject([{ policyApproval: approval }]);
  });

  test("an agent key's request and its receipt name the agent, and a refusal's too", async () => {
    const target = app();
    const response = await post(target, "", {}, AGENT_KEY);
    expect(response.status).toBe(201);
    const actor = {
      principal: { kind: "api_key" as const, id: `key-${AGENT_KEY}` },
      actor_user_id: null,
      agent_id: AGENT,
    };
    expect(target.seen.created.map((input) => input.actor)).toEqual([actor]);
    const refused = app({ source: { status: "none" } });
    await post(refused, "", {}, AGENT_KEY);
    expect(refused.seen.refusals.map((input) => input.actor)).toEqual([actor]);
  });

  test("POST takes no say over the commit, repository or branch", async () => {
    const target = app();
    expect(
      await errorOf(post(target, "", { target_branch: "main" })),
    ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await errorOf(post(target, "", {}, "csp_writer", {}))).toMatchObject(
      { status: 400, code: "BAD_REQUEST" },
    );
    expect(
      await errorOf(post(target, "", { pad: "x".repeat(65 * 1024) })),
    ).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(target.seen.created).toEqual([]);
  });

  test("POST refuses a session with nothing to push and records why", async () => {
    const cases: Array<[Parameters<typeof app>[0], string, string]> = [
      [
        {
          store: {
            findSession: async () => ({
              ...NO_GITHUB,
              repositoryId: null,
              policyApproval: null,
            }),
          },
        },
        "PUSH_SOURCE_MISSING",
        "no_repository",
      ],
      [{ source: { status: "none" } }, "PUSH_SOURCE_MISSING", "no_checkpoint"],
      [
        { source: { status: "unavailable", reason: "manifest missing" } },
        "CHECKPOINT_UNAVAILABLE",
        "checkpoint_unavailable",
      ],
    ];
    for (const [options, code, refusal] of cases) {
      const target = app(options);
      expect(await errorOf(post(target, "", {}))).toEqual({
        status: 409,
        code: code as never,
        details: { refusal, receipt_id: RECEIPT },
      });
      expect(target.seen.refusals).toMatchObject([
        {
          ownerId: "owner-a",
          sessionId: SESSION,
          operation: "request_push",
          refusal,
          result: { verdict: "refuse", refusal, git_commit: null },
        },
      ]);
      expect(target.seen.created).toEqual([]);
    }
  });

  test("POST maps the store's refusals and conflicts", async () => {
    const refusedOpen = app({
      store: {
        create: async () => ({
          outcome: "refused",
          refusal: "request_open",
          receiptId: RECEIPT,
        }),
      },
    });
    expect(await errorOf(post(refusedOpen, "", {}))).toEqual({
      status: 409,
      code: "PUSH_REQUEST_OPEN",
      details: { refusal: "request_open", receipt_id: RECEIPT },
    });
    const moved = app({
      store: {
        create: async () => ({
          outcome: "refused",
          refusal: "checkpoint_moved",
          receiptId: RECEIPT,
        }),
      },
    });
    expect(await errorOf(post(moved, "", {}))).toMatchObject({
      status: 409,
      code: "CHECKPOINT_MOVED",
    });
    const conflict = app({
      store: { create: async () => ({ outcome: "conflict" }) },
    });
    expect(await errorOf(post(conflict, "", {}))).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  test("POST answers 404 for another owner's session, with no receipt", async () => {
    const target = app({ store: { findSession: async () => null } });
    expect(await errorOf(post(target, "", {}))).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(target.seen.refusals).toEqual([]);
  });

  test("POST replays a created request without re-reading the checkpoint", async () => {
    const target = app({
      store: {
        replayCreate: async () => ({ outcome: "replayed", request: PINNED }),
      },
      source: { status: "unavailable", reason: "object store down" },
    });
    const response = await post(target, "", {});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(PINNED);
    expect(target.seen.refusals).toEqual([]);
    expect(target.seen.created).toEqual([]);
  });

  test("GET lists and reads the owner's requests", async () => {
    const target = app();
    const listed = await target.api.request(
      `/v1/sessions/${SESSION}/push-requests`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(listed.status).toBe(200);
    expect(
      listPushRequestsResponseSchema.parse(await listed.json()).items,
    ).toHaveLength(1);
    const one = await target.api.request(
      `/v1/sessions/${SESSION}/push-requests/${PUSH}`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(pushRequestSchema.parse(await one.json()).git_commit).toBe(COMMIT);
    const otherSession = await target.api.request(
      `/v1/sessions/${PUSH}/push-requests`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(otherSession.status).toBe(404);
    const unknown = await target.api.request(
      `/v1/sessions/${SESSION}/push-requests/${RECEIPT}`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(unknown.status).toBe(404);
  });

  test("approve: a holder of sessions:approve approves the reviewed commit", async () => {
    const target = app();
    const response = await resolve(target, "approve", {
      git_commit: COMMIT,
      reason: "looks right",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Deprecation")).toBeNull();
    expect(pushRequestSchema.parse(await response.json()).state).toBe(
      "approved",
    );
    expect(target.seen.decided).toMatchObject([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        pushRequestId: PUSH,
        decision: "approve",
        gitCommit: COMMIT,
        reason: "looks right",
        idempotencyKey: "key-1",
      },
    ]);
  });

  test("approve: a credential without sessions:approve is refused with a receipt, body unread", async () => {
    const target = app();
    expect(
      await errorOf(resolve(target, "approve", "{not json", "csp_writer")),
    ).toEqual({
      status: 403,
      code: "FORBIDDEN",
      details: { refusal: "missing_scope", receipt_id: RECEIPT },
    });
    expect(target.seen.refusals).toMatchObject([
      {
        operation: "resolve_push",
        refusal: "missing_scope",
        actor: { principal: { kind: "api_key", id: "key-csp_writer" } },
        result: { push_request_id: PUSH, verdict: "refuse" },
      },
    ]);
    expect(target.seen.decided).toEqual([]);
  });

  test("approve: an unverified caller (AUTH_MODE=none) approves nothing and writes nothing", async () => {
    const target = app({ authMode: "none" });
    for (const response of [
      resolve(target, "approve", { git_commit: COMMIT }, "", {
        "Idempotency-Key": "key-1",
        "X-Owner-Id": "owner-a",
      }),
      target.api.request(`/v1/sessions/${SESSION}/push-requests`, {
        method: "POST",
        headers: {
          "X-Owner-Id": "owner-a",
          "Idempotency-Key": "key-1",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ]) {
      expect(await errorOf(response)).toEqual({
        status: 403,
        code: "FORBIDDEN",
        details: { refusal: "unverified_principal" },
      });
    }
    expect(target.seen).toEqual({ created: [], decided: [], refusals: [] });
  });

  test("every path maps the store's refusals to 409 and 404", async () => {
    const cases = [
      ["already_resolved", 409, "PUSH_REQUEST_RESOLVED"],
      ["checkpoint_moved", 409, "CHECKPOINT_MOVED"],
      ["commit_mismatch", 409, "CHECKPOINT_MOVED"],
      ["not_found", 404, "NOT_FOUND"],
    ] as const;
    for (const [refusal, status, code] of cases) {
      const target = app({
        store: {
          decide: async () => ({
            outcome: "refused",
            refusal,
            receiptId: RECEIPT,
          }),
        },
      });
      for (const [path, body] of [
        ["approve", { git_commit: COMMIT }],
        ["reject", { git_commit: COMMIT }],
      ] as const) {
        expect(await errorOf(resolve(target, path, body))).toEqual({
          status,
          code,
          details: { refusal, receipt_id: RECEIPT },
        });
      }
    }
  });

  test("approve, reject: body, key and size are checked; the old /decision path is gone", async () => {
    const target = app();
    for (const body of [
      {},
      { git_commit: "HEAD" },
      // The path names the action; the body may not.
      { decision: "approve", git_commit: COMMIT },
    ]) {
      expect(await errorOf(resolve(target, "approve", body))).toMatchObject({
        status: 400,
        code: "BAD_REQUEST",
      });
    }
    expect(
      await errorOf(
        resolve(target, "reject", { git_commit: COMMIT }, undefined, {}),
      ),
    ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    for (const path of ["approve", "reject"] as const) {
      expect(
        await errorOf(
          resolve(target, path, {
            git_commit: COMMIT,
            reason: "x".repeat(65 * 1024),
          }),
        ),
      ).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    }
    const conflict = app({
      store: { decide: async () => ({ outcome: "conflict" }) },
    });
    expect(
      await errorOf(resolve(conflict, "reject", { git_commit: COMMIT })),
    ).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      (
        await post(target, `/${PUSH}/decision`, {
          decision: "approve",
          git_commit: COMMIT,
        })
      ).status,
    ).toBe(404);
    expect(target.seen.decided).toEqual([]);
  });
});

describe("a key approving the session it started (GA-8)", () => {
  test("is refused 403 self_approval with a resolve_push receipt naming the key and its issuer, body unread", async () => {
    const owners = new Set(["owner-a", WORKSPACE]);
    const target = app({
      startedBy: `key-${PERSONAL}`,
      store: {
        findSession: async (ownerId) =>
          owners.has(ownerId)
            ? {
                ...NO_GITHUB,
                repositoryId: "sample-app",
                policyApproval: null,
              }
            : null,
      },
    });
    const response = await target.api.request(
      `/v1/sessions/${SESSION}/push-requests/${PUSH}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PERSONAL}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ git_commit: COMMIT }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        details: { refusal: "self_approval", receipt_id: RECEIPT },
      },
    });
    expect(target.seen.decided).toEqual([]);
    expect(target.seen.refusals).toMatchObject([
      {
        operation: "resolve_push",
        refusal: "self_approval",
        actor: { principal: { kind: "api_key", id: `key-${PERSONAL}` } },
        result: {
          decider_key: {
            id: `key-${PERSONAL}`,
            kind: "personal",
            issued_by_user_id: ISSUER,
          },
        },
      },
    ]);
  });
});

describe("push receipts name the person behind the credential", () => {
  const cases = [
    {
      name: "a personal key: its issuer",
      auth: { Authorization: "Bearer csp_personal" },
      principal: { kind: "api_key", id: "key-csp_personal" },
      person: ISSUER,
    },
    {
      name: "a service key (the CLI's, no issuer): no one",
      auth: { Authorization: "Bearer csp_service" },
      principal: { kind: "api_key", id: "key-csp_service" },
      person: null,
    },
    {
      name: "a signed-in session: that person",
      auth: {
        Cookie: cookieFor(SIGNED_IN),
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      },
      principal: { kind: "user", id: SIGNED_IN },
      person: SIGNED_IN,
    },
  ] as const;

  for (const { name, auth, principal, person } of cases) {
    test(name, async () => {
      // A workspace credential's partition is the workspace.
      const owners = new Set(["owner-a", WORKSPACE]);
      const target = app({
        store: {
          findSession: async (ownerId) =>
            owners.has(ownerId)
              ? {
                  ...NO_GITHUB,
                  repositoryId: "sample-app",
                  policyApproval: null,
                }
              : null,
          get: async (ownerId) => (owners.has(ownerId) ? PINNED : null),
        },
      });
      const send = (path: string, body: unknown) =>
        target.api.request(`/v1/sessions/${SESSION}/push-requests${path}`, {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        });
      expect((await send("", {})).status).toBe(201);
      expect(
        (await send(`/${PUSH}/approve`, { git_commit: COMMIT })).status,
      ).toBe(200);
      const actor = { principal, actor_user_id: person, agent_id: null };
      expect(target.seen.created.map((input) => input.actor)).toEqual([actor]);
      expect(target.seen.decided.map((input) => input.actor)).toEqual([actor]);
    });
  }
});
