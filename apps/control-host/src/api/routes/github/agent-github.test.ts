import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  agentGitHubActivityResponseSchema,
  agentGitHubResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  putAgentGitHubEnabledResponseSchema,
  putAgentGitHubRepositoryAccessResponseSchema,
  putAgentGitHubSettingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  repositoryRefOf,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AgentGitHubStore,
  createAgentGitHubService,
  createAuthorizationPolicy,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
  type SessionCatalog,
  SessionServiceError,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerAgentGitHubRoutes } from "./agent-github.ts";

const createApiApp = recordRouteErrors("routes/github/agent-github.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const MISSING = "019a0000-0000-7000-8000-0000000000c9";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId: WORKSPACE,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

const STALE_REVISION = 99;
const KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const keyStore = {
  async find(candidate: Uint8Array) {
    if (!Buffer.from(hashApiKey(KEY.plaintext)).equals(Buffer.from(candidate)))
      return null;
    return {
      id: crypto.randomUUID(),
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: "personal" as const,
      agentId: null,
      createdByUserId: crypto.randomUUID(),
      creatorRole: "owner" as const,
      scopes: ["sessions:read" as const, "sessions:write" as const],
    };
  },
};

const catalog = {
  repositories: {
    "sample-app": {
      url: "https://github.com/acme/sample-app",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
} as unknown as SessionCatalog;

// The Postgres store (receipts, the visibility filter) is its own
// integration test (agent-github.integration.test.ts).
function appWith(
  options: {
    ceiling?: GitHubCeiling;
    reviewer?: { permissions: Record<string, "read" | "write"> } | null;
  } = {},
) {
  let enabled = true;
  const writes: boolean[] = [];
  const store: AgentGitHubStore = {
    settings: () => Promise.resolve(null),
    repositoryCeiling: () => Promise.resolve(null),
    repositoryNames: () => Promise.resolve(new Map()),
    async enabled(_workspaceId, agentId) {
      return agentId === AGENT ? enabled : null;
    },
    async setEnabled(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      const changed = enabled !== input.enabled;
      enabled = input.enabled;
      if (changed) writes.push(input.enabled);
      return {
        outcome: "saved",
        receiptId: changed ? crypto.randomUUID() : null,
      };
    },
    async putSettings(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      // The real store runs the service's check under its lock, on the held row.
      input.check(null, {
        repository_ids: [],
        github_app_repositories: "installed",
      });
      if (input.expectedRevision === STALE_REVISION) {
        return { outcome: "conflict", revision: 1 };
      }
      return { outcome: "saved", revision: 1, receiptId: null };
    },
    async setRepository(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      if (input.expectedRevision === STALE_REVISION) {
        return { outcome: "conflict", revision: 1 };
      }
      return {
        outcome: "saved",
        revision: 2,
        receiptId: null,
        repository: {
          id: "sample-app",
          owner: "octo",
          name: "sample",
          label: "octo/sample",
        },
        catalogChanged: false,
      };
    },
    async activity() {
      return [];
    },
  };
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerAgentGitHubRoutes(
        router,
        createAgentGitHubService({
          authorization: createAuthorizationPolicy({}),
          agents: {
            async get(_workspaceId, agentId) {
              return agentId === AGENT
                ? ({ active_release: null } as unknown as AgentDetail)
                : null;
            },
          },
          store,
          catalog,
          // GitHub does not answer for a pick from an installation.
          selection: async () => {
            throw new SessionServiceError(
              "GITHUB_UNAVAILABLE",
              "GitHub could not be reached",
              undefined,
              { reason_code: "github_unavailable" },
            );
          },
          githubSettings: {
            async get() {
              return {
                ceiling: options.ceiling ?? GITHUB_CEILING_NONE,
                revision: 0,
              };
            },
            async appPermissions() {
              return {
                author: { permissions: { contents: "write" } },
                reviewer: options.reviewer ?? null,
              };
            },
          },
        }),
      ),
  });
  const call = async (
    method: "GET" | "PUT",
    path: string,
    request: { cookie?: string; key?: boolean; body?: unknown } = {},
  ) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(request.cookie ? { Cookie: request.cookie } : {}),
        ...(request.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        ...(request.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { call, writes };
}

const code = (json: unknown) => apiErrorResponseSchema.parse(json).error.code;
const github = (id = AGENT) => `/v1/agents/${id}/github`;

describe("the agent GitHub API", () => {
  test("an admin reads the tab and its activity; an agent with no row starts from the first-save defaults", async () => {
    const { call } = appWith();
    const admin = cookieFor("admin");
    const read = await call("GET", github(), { cookie: admin });
    expect(read.status).toBe(200);
    expect(agentGitHubResponseSchema.parse(read.json)).toMatchObject({
      enabled: true,
      github: null,
      settings_revision: null,
      start_repository_id: null,
      legacy_defaults: { repositories: [], push_approval: false },
    });
    const activity = await call("GET", `${github()}/activity`, {
      cookie: admin,
    });
    expect(activity.status).toBe(200);
    expect(agentGitHubActivityResponseSchema.parse(activity.json)).toEqual({
      items: [],
      receipt_repositories: [],
    });
  });

  test("without a reviewer App, review is unavailable for no_reviewer_app; with one it is available", async () => {
    const ceiling = { ...GITHUB_CEILING_NONE, review: true };
    const admin = cookieFor("admin");
    const none = await appWith({ ceiling }).call("GET", github(), {
      cookie: admin,
    });
    expect(none.status).toBe(200);
    expect(
      agentGitHubResponseSchema.parse(none.json).options.features.review,
    ).toEqual({ available: false, reason: "no_reviewer_app" });
    const registered = await appWith({
      ceiling,
      reviewer: { permissions: { contents: "read", pull_requests: "write" } },
    }).call("GET", github(), { cookie: admin });
    expect(
      agentGitHubResponseSchema.parse(registered.json).options.features.review,
    ).toEqual({ available: true, reason: null });
  });

  test("the switch turns off once and reports no receipt the second time", async () => {
    const { call, writes } = appWith();
    const admin = cookieFor("admin");
    const off = await call("PUT", `${github()}/enabled`, {
      cookie: admin,
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect(putAgentGitHubEnabledResponseSchema.parse(off.json)).toMatchObject({
      enabled: false,
      receipt_id: expect.any(String),
    });
    const again = await call("PUT", `${github()}/enabled`, {
      cookie: admin,
      body: { enabled: false },
    });
    expect(again.json.receipt_id).toBeNull();
    expect(writes).toEqual([false]);
    expect((await call("GET", github(), { cookie: admin })).json.enabled).toBe(
      false,
    );
  });

  test("a member who manages no agent is refused; an API key may not turn the switch", async () => {
    const { call, writes } = appWith();
    const member = cookieFor("member");
    for (const path of [github(), `${github()}/activity`]) {
      const read = await call("GET", path, { cookie: member });
      expect(read.status).toBe(403);
      expect(code(read.json)).toBe("FORBIDDEN");
    }
    expect(
      (
        await call("PUT", `${github()}/enabled`, {
          cookie: member,
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    const byKey = await call("PUT", `${github()}/enabled`, {
      key: true,
      body: { enabled: false },
    });
    expect(byKey.status).toBe(403);
    expect(code(byKey.json)).toBe("FORBIDDEN");
    expect(writes).toEqual([]);
  });

  test("an unknown agent is not found; a malformed body is refused", async () => {
    const { call, writes } = appWith();
    const owner = cookieFor("owner");
    expect((await call("GET", github(MISSING), { cookie: owner })).status).toBe(
      404,
    );
    expect(
      (await call("GET", `${github(MISSING)}/activity`, { cookie: owner }))
        .status,
    ).toBe(404);
    expect(
      (
        await call("PUT", `${github(MISSING)}/enabled`, {
          cookie: owner,
          body: { enabled: false },
        })
      ).status,
    ).toBe(404);
    for (const body of [{}, { enabled: "no" }, { enabled: true, extra: 1 }]) {
      expect(
        (await call("PUT", `${github()}/enabled`, { cookie: owner, body }))
          .status,
      ).toBe(400);
    }
    const huge = await call("PUT", `${github()}/enabled`, {
      cookie: owner,
      body: { enabled: true, pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(huge.status).toBe(413);
    expect(writes).toEqual([]);
  });

  describe("saving the settings", () => {
    const settings = {
      repositories: [],
      push_approval: false,
      features: {
        workflows: false,
        actions: false,
        checks: false,
        issues: false,
        review: false,
      },
      actions_allow: [],
    };
    const body = (expected_revision: number | null = null) => ({
      expected_revision,
      settings,
      start_repository_id: null,
    });
    const put = `${github()}/settings`;

    test("an admin saves and gets the revision back", async () => {
      const { call } = appWith();
      const saved = await call("PUT", put, {
        cookie: cookieFor("admin"),
        body: body(),
      });
      expect(saved.status).toBe(200);
      expect(putAgentGitHubSettingsResponseSchema.parse(saved.json)).toEqual({
        settings_revision: 1,
        receipt_id: null,
      });
    });

    test("a stale revision is a 409 conflict", async () => {
      const { call } = appWith();
      const stale = await call("PUT", put, {
        cookie: cookieFor("admin"),
        body: body(STALE_REVISION),
      });
      expect(stale.status).toBe(409);
      expect(code(stale.json)).toBe("REVISION_CONFLICT");
    });

    test("a member and an API key are refused", async () => {
      const { call } = appWith();
      const member = await call("PUT", put, {
        cookie: cookieFor("member"),
        body: body(),
      });
      expect(member.status).toBe(403);
      const byKey = await call("PUT", put, { key: true, body: body() });
      expect(byKey.status).toBe(403);
      expect(code(byKey.json)).toBe("FORBIDDEN");
    });

    test("an unknown agent is not found; a malformed or huge body is refused", async () => {
      const { call } = appWith();
      const owner = cookieFor("owner");
      expect(
        (
          await call("PUT", `${github(MISSING)}/settings`, {
            cookie: owner,
            body: body(),
          })
        ).status,
      ).toBe(404);
      for (const bad of [
        {},
        { ...body(), expected_revision: "1" },
        { ...body(), extra: 1 },
        { ...body(), settings: { ...settings, push_approval: "yes" } },
      ]) {
        expect(
          (await call("PUT", put, { cookie: owner, body: bad })).status,
        ).toBe(400);
      }
      const huge = await call("PUT", put, {
        cookie: owner,
        body: { ...body(), pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
      });
      expect(huge.status).toBe(413);
    });

    describe("turning one repository on or off", () => {
      const toggle = `${github()}/repository-access`;
      const ref = repositoryRefOf("sample-app");
      const on = { repository: { ref }, enabled: true };

      test("an admin toggles by ref and gets the revision and the name back", async () => {
        const { call } = appWith();
        const saved = await call("PUT", toggle, {
          cookie: cookieFor("admin"),
          body: on,
        });
        expect(saved.status).toBe(200);
        expect(
          putAgentGitHubRepositoryAccessResponseSchema.parse(saved.json),
        ).toEqual({
          settings_revision: 2,
          receipt_id: null,
          enabled: true,
          repository: { ref, repository: "octo/sample", private: null },
        });
      });

      test("a stale expected revision is a 409 conflict", async () => {
        const { call } = appWith();
        const stale = await call("PUT", toggle, {
          cookie: cookieFor("admin"),
          body: { ...on, expected_revision: STALE_REVISION },
        });
        expect(stale.status).toBe(409);
        expect(code(stale.json)).toBe("REVISION_CONFLICT");
      });

      test("a member and an API key are refused", async () => {
        const { call } = appWith();
        expect(
          (await call("PUT", toggle, { cookie: cookieFor("member"), body: on }))
            .status,
        ).toBe(403);
        const byKey = await call("PUT", toggle, { key: true, body: on });
        expect(byKey.status).toBe(403);
      });

      test("an unknown agent is not found; a bad or huge body is refused", async () => {
        const { call } = appWith();
        const owner = cookieFor("owner");
        expect(
          (
            await call("PUT", `${github(MISSING)}/repository-access`, {
              cookie: owner,
              body: on,
            })
          ).status,
        ).toBe(404);
        for (const bad of [
          {},
          { repository: { ref }, enabled: "yes" },
          { ...on, extra: 1 },
          { repository: { ref, installation_id: 1 }, enabled: true },
          // A repository is turned off by its ref only.
          {
            repository: { installation_id: 1, github_repository_id: 2 },
            enabled: false,
          },
          { ...on, repository: { ref: "sample-app" } },
        ]) {
          expect(
            (await call("PUT", toggle, { cookie: owner, body: bad })).status,
          ).toBe(400);
        }
        const huge = await call("PUT", toggle, {
          cookie: owner,
          body: { ...on, pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
        });
        expect(huge.status).toBe(413);
      });

      test("GitHub not answering for a pick is a 502 and nothing is written", async () => {
        const { call } = appWith();
        const down = await call("PUT", toggle, {
          cookie: cookieFor("owner"),
          body: {
            repository: { installation_id: 1, github_repository_id: 2 },
            enabled: true,
          },
        });
        expect(down.status).toBe(502);
        expect(code(down.json)).toBe("GITHUB_UNAVAILABLE");
      });
    });

    test("a start repository outside the list is a 400 before the store", async () => {
      const { call } = appWith();
      const refused = await call("PUT", put, {
        cookie: cookieFor("owner"),
        body: { ...body(), start_repository_id: "elsewhere" },
      });
      expect(refused.status).toBe(400);
    });
  });
});
