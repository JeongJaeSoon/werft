import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  DEFAULT_PULL_REQUEST_SETTINGS,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  githubSettingsResponseSchema,
  type PullRequestSettings,
  putGitHubPullRequestSettingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createGitHubSettingsService,
  GitHubAppCheckError,
  type GitHubAppDirectory,
  type GitHubAppStore,
  type GitHubSettingsStore,
  type IdentityStore,
  type MembershipRole,
  type PullRequestSettingsRead,
  type PullRequestSettingsStore,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { fakeGitHubClientSecret } from "@werft-ai/platform/testing/github";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerGitHubSettingsRoutes } from "./github-settings.ts";

const createApiApp = recordRouteErrors("routes/github/github-settings.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const AUTHOR_CONNECTION = "019a0000-0000-7000-8000-0000000000c9";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId,
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

// The Postgres store (CAS, receipts) is its own integration test.
function memoryStore() {
  let held = { ceiling: GITHUB_CEILING_NONE, revision: 0 };
  const writes: Array<{ updatedBy: string; ceiling: GitHubCeiling }> = [];
  const store: GitHubSettingsStore = {
    async get() {
      return held;
    },
    async agentsUsing() {
      return { workflows: 0, actions: 2, checks: 0, issues: 0, review: 0 };
    },
    async appPermissions() {
      return {
        author: { permissions: { contents: "write", actions: "write" } },
        reviewer: null,
      };
    },
    async putCeiling(input) {
      if (input.workspaceId !== WORKSPACE) {
        return { outcome: "workspace_not_found" };
      }
      if (input.revision !== held.revision) {
        return { outcome: "revision_conflict" };
      }
      held = { ceiling: input.ceiling, revision: held.revision + 1 };
      writes.push({ updatedBy: input.updatedBy, ceiling: input.ceiling });
      return { outcome: "stored", settings: held };
    },
  };
  let layout: PullRequestSettingsRead = {
    settings: DEFAULT_PULL_REQUEST_SETTINGS,
    revision: 0,
  };
  const layoutWrites: PullRequestSettings[] = [];
  const pullRequestSettings: Pick<PullRequestSettingsStore, "get" | "put"> = {
    async get() {
      return layout;
    },
    async put(input) {
      if (input.revision !== layout.revision) {
        return { outcome: "revision_conflict" };
      }
      layout = { settings: input.settings, revision: layout.revision + 1 };
      layoutWrites.push(input.settings);
      return { outcome: "stored", ...layout, receiptId: crypto.randomUUID() };
    },
  };
  return {
    store,
    pullRequestSettings,
    writes,
    layoutWrites,
    held: () => held,
  };
}

function appWith(
  options: {
    authorApp?: boolean;
    secretsOn?: boolean;
    /** Given, the author App accepts a secret and keeps it here. */
    stored?: string[];
    apps?: GitHubAppStore;
    directory?: GitHubAppDirectory;
  } = {},
) {
  const stored = options.stored;
  const memory = memoryStore();
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerGitHubSettingsRoutes(
        router,
        createGitHubSettingsService({
          authorization: createAuthorizationPolicy({}),
          store: memory.store,
          pullRequestSettings: memory.pullRequestSettings,
          oauth: {
            status: async () => ({
              authorApp: options.authorApp ?? false,
              connectionId: options.authorApp ? AUTHOR_CONNECTION : null,
              clientId: stored ? "Iv23liClient" : null,
              clientSecretSet: (stored?.length ?? 0) > 0,
            }),
            client: async () => null,
            putClientSecret: async (_workspaceId, secret, _audit, clientId) => {
              if (!stored) return { outcome: "no_author_app" };
              if (clientId !== "Iv23liClient") {
                return { outcome: "client_changed" };
              }
              stored.push(secret);
              return { outcome: "stored" };
            },
          },
          callbackUrl: null,
          secretsOn: options.secretsOn ?? true,
          apps: options.apps ?? null,
          directory: options.directory ?? ({} as GitHubAppDirectory),
        }),
      ),
  });
  const call = async (
    method: "GET" | "PUT",
    request: {
      cookie?: string;
      key?: boolean;
      body?: unknown;
      workspaceId?: string;
      path?: string;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${request.workspaceId ?? WORKSPACE}/github-settings${request.path ?? ""}`,
      {
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
      },
    );
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { call, memory };
}

const ACTIONS_ON = { ...GITHUB_CEILING_NONE, actions: true };
const code = (json: unknown) => apiErrorResponseSchema.parse(json).error;

function threeApps() {
  const at = new Date("2026-11-02T09:00:00.000Z");
  const rows = [
    { id: "conn-a", role: "author" as const, appId: 11 },
    { id: "conn-b", role: "author" as const, appId: 12 },
    { id: "conn-r", role: "reviewer" as const, appId: 13 },
  ];
  const apps = {
    list: async () =>
      rows.map((row) => ({
        id: row.id,
        role: row.role,
        workspaceId: WORKSPACE,
        appId: row.appId,
        slug: `app-${row.appId}`,
        name: `app-${row.appId}`,
        htmlUrl: `https://github.com/apps/app-${row.appId}`,
        permissions: { contents: "write" },
        permissionsCheckedAt: at,
        clientId: null,
        apiBase: "https://api.github.com",
        createdAt: at,
        updatedAt: at,
        privateKey: { updatedAt: at, updatedBy: null },
      })),
    credentials: async (role: string) =>
      rows
        .filter((row) => row.role === role)
        .map((row) => ({
          id: row.id,
          workspaceId: WORKSPACE,
          appId: row.appId,
          apiBase: "https://api.github.com",
          privateKey: "pem",
          updatedAt: at,
        })),
    recordPermissions: async () => {},
  } as unknown as GitHubAppStore;
  const answer = (appId: number) => {
    if (appId === 12) throw new GitHubAppCheckError("github_unreachable", 502);
  };
  const directory = {
    describe: async ({ appId }: { appId: number }) => {
      answer(appId);
      return {
        appId,
        slug: `app-${appId}`,
        name: `app-${appId}`,
        htmlUrl: `https://github.com/apps/app-${appId}`,
        permissions: { contents: "write" },
        clientId: null,
        owner: { login: "acme", type: "organization" },
      };
    },
    installations: async ({ appId }: { appId: number }) => {
      answer(appId);
      return [
        {
          id: appId * 10,
          account: "acme",
          accountType: "organization",
          accountId: 99,
          repositorySelection: "all",
          htmlUrl: `https://github.com/organizations/acme/settings/installations/${appId * 10}`,
          permissions: { contents: "write" },
          createdAt: at,
          suspendedAt: null,
        },
      ];
    },
    installationRepositoriesPage: async () => ({
      repositories: [],
      totalCount: 4,
    }),
  } as unknown as GitHubAppDirectory;
  return { apps, directory };
}

describe("the GitHub settings API", () => {
  test("connections: every App, two of one role too; a failed one beside the rest; members read no detail", async () => {
    const { call } = appWith(threeApps());
    const asOwner = githubSettingsResponseSchema.parse(
      (await call("GET", { cookie: cookieFor("owner") })).json,
    );
    expect(
      asOwner.connections.map((each) => [
        each.connection_id,
        each.role,
        each.check.state,
        each.installations.length,
      ]),
    ).toEqual([
      ["conn-a", "author", "ok", 1],
      ["conn-b", "author", "failed", 0],
      ["conn-r", "reviewer", "ok", 1],
    ]);
    expect(asOwner.connections[1]?.check).toEqual({
      state: "failed",
      reason_code: "github_unavailable",
      checked_at: expect.any(String),
    });
    expect(asOwner.connections[0]?.installations[0]?.detail).toMatchObject({
      connection_id: "conn-a",
      role: "author",
      account_id: 99,
      approval: "approved",
      repository_count: 4,
      repository_selection: "all",
      html_url:
        "https://github.com/organizations/acme/settings/installations/110",
      created_at: "2026-11-02T09:00:00.000Z",
      suspended_at: null,
    });

    const asMember = await call("GET", { cookie: cookieFor("member") });
    expect(asMember.status).toBe(200);
    const member = githubSettingsResponseSchema.parse(asMember.json);
    expect(member.connections[0]?.installations).toEqual([
      {
        id: 110,
        account: "acme",
        account_type: "organization",
        status: "active",
        detail: null,
      },
    ]);
  });

  test("an owner reads the ceiling and raises it at the revision read", async () => {
    const { call, memory } = appWith();
    const owner = cookieFor("owner");
    const read = await call("GET", { cookie: owner });
    expect(read.status).toBe(200);
    expect(githubSettingsResponseSchema.parse(read.json)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
      pull_request: DEFAULT_PULL_REQUEST_SETTINGS,
      pull_request_revision: 0,
      agents_using: {
        workflows: 0,
        actions: 2,
        checks: 0,
        issues: 0,
        review: 0,
      },
      oauth: {
        connection_id: null,
        client_id: null,
        client_secret_set: false,
        callback_url: null,
      },
      connections: [],
      apps: {
        author: { permissions: { contents: "write", actions: "write" } },
        reviewer: null,
      },
    });

    const put = await call("PUT", {
      cookie: owner,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    expect(put.status).toBe(200);
    expect(githubSettingsResponseSchema.parse(put.json)).toMatchObject({
      ceiling: ACTIONS_ON,
      revision: 1,
    });
    expect(memory.writes).toEqual([
      { updatedBy: expect.any(String), ceiling: ACTIONS_ON },
    ]);
    expect((await call("GET", { cookie: owner })).json.revision).toBe(1);
  });

  test("a stale revision is 409 REVISION_CONFLICT and changes nothing", async () => {
    const { call, memory } = appWith();
    const owner = cookieFor("owner");
    await call("PUT", {
      cookie: owner,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    const stale = await call("PUT", {
      cookie: cookieFor("admin"),
      body: { ceiling: GITHUB_CEILING_NONE, revision: 0 },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json).code).toBe("REVISION_CONFLICT");
    expect(memory.held()).toEqual({ ceiling: ACTIONS_ON, revision: 1 });
  });

  test("a member reads the ceiling but may not change it", async () => {
    const { call, memory } = appWith();
    const member = cookieFor("member");
    expect((await call("GET", { cookie: member })).status).toBe(200);
    const put = await call("PUT", {
      cookie: member,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    expect(put.status).toBe(403);
    expect(code(put.json).code).toBe("FORBIDDEN");
    expect(memory.writes).toEqual([]);
  });

  test("an API key may neither read nor change the ceiling", async () => {
    const { call, memory } = appWith();
    const read = await call("GET", { key: true });
    expect(read.status).toBe(403);
    expect(code(read.json).code).toBe("FORBIDDEN");
    const put = await call("PUT", {
      key: true,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    expect(put.status).toBe(403);
    expect(code(put.json).code).toBe("FORBIDDEN");
    expect(memory.writes).toEqual([]);
  });

  test("another workspace's path is not found; a malformed body is refused", async () => {
    const { call, memory } = appWith();
    const stranger = cookieFor("owner", OTHER_WORKSPACE);
    expect((await call("GET", { cookie: stranger })).status).toBe(404);
    expect(
      (
        await call("PUT", {
          cookie: stranger,
          body: { ceiling: ACTIONS_ON, revision: 0 },
        })
      ).status,
    ).toBe(404);
    const owner = cookieFor("owner");
    for (const body of [
      { ceiling: ACTIONS_ON },
      { ceiling: { actions: true }, revision: 0 },
      { ceiling: ACTIONS_ON, revision: -1 },
      { ceiling: ACTIONS_ON, revision: 0, extra: 1 },
    ]) {
      expect((await call("PUT", { cookie: owner, body })).status).toBe(400);
    }
    const huge = await call("PUT", {
      cookie: owner,
      body: {
        ceiling: ACTIONS_ON,
        revision: 0,
        pad: "a".repeat(REQUEST_BODY_MAX_BYTES),
      },
    });
    expect(huge.status).toBe(413);
    expect(memory.writes).toEqual([]);
  });

  test("unauthenticated calls are 401", async () => {
    const { call } = appWith();
    for (const method of ["GET", "PUT"] as const) {
      expect((await call(method)).status).toBe(401);
    }
  });
});

describe("PUT the pull request settings", () => {
  const LAYOUT = {
    formatting: "off",
    default_template: "## Summary\n",
    template_mode: "override",
    session_link: "id",
  } as const;
  const path = "/pull-request";

  test("a body past the request limit is 413", async () => {
    const { call } = appWith();
    const response = await call("PUT", {
      cookie: cookieFor("owner"),
      path,
      body: { pad: "a".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(response.status).toBe(413);
  });

  test("an owner saves them at their own revision; the ceiling's does not move", async () => {
    const { call, memory } = appWith();
    const owner = cookieFor("owner");
    const put = await call("PUT", {
      cookie: owner,
      path,
      body: { pull_request: LAYOUT, revision: 0 },
    });
    expect(put.status).toBe(200);
    expect(putGitHubPullRequestSettingsResponseSchema.parse(put.json)).toEqual({
      pull_request: LAYOUT,
      pull_request_revision: 1,
      receipt_id: expect.any(String),
    });
    expect(memory.layoutWrites).toEqual([LAYOUT]);
    const read = githubSettingsResponseSchema.parse(
      (await call("GET", { cookie: owner })).json,
    );
    expect(read.pull_request).toEqual(LAYOUT);
    expect(read.pull_request_revision).toBe(1);
    expect(read.revision).toBe(0);
    expect(memory.writes).toEqual([]);
  });

  test("a stale revision is 409 REVISION_CONFLICT", async () => {
    const { call, memory } = appWith();
    await call("PUT", {
      cookie: cookieFor("owner"),
      path,
      body: { pull_request: LAYOUT, revision: 0 },
    });
    const stale = await call("PUT", {
      cookie: cookieFor("admin"),
      path,
      body: {
        pull_request: { ...LAYOUT, formatting: "on" },
        revision: 0,
      },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json).code).toBe("REVISION_CONFLICT");
    expect(memory.layoutWrites).toHaveLength(1);
  });

  test("a template the platform would not use is 400 with its reason", async () => {
    const { call, memory } = appWith();
    const owner = cookieFor("owner");
    for (const [text, reason] of [
      ["# S\n<!-- open", "template_unsupported"],
      ["a".repeat(16 * 1024), null],
    ] as const) {
      const put = await call("PUT", {
        cookie: owner,
        path,
        body: {
          pull_request: { ...LAYOUT, default_template: text },
          revision: 0,
        },
      });
      expect(put.status).toBe(reason === null ? 200 : 400);
      if (reason !== null) {
        expect(code(put.json).details).toMatchObject({ reason_code: reason });
      }
    }
    // 16 KiB and one byte more never reaches the service: the schema stops it.
    const over = await call("PUT", {
      cookie: owner,
      path,
      body: {
        pull_request: {
          ...LAYOUT,
          default_template: "a".repeat(16 * 1024 + 1),
        },
        revision: 1,
      },
    });
    expect(over.status).toBe(400);
    expect(memory.layoutWrites).toHaveLength(1);
  });

  test("a member, an API key and another workspace are refused; a malformed body is 400", async () => {
    const { call, memory } = appWith();
    const body = { pull_request: LAYOUT, revision: 0 };
    expect(
      (await call("PUT", { cookie: cookieFor("member"), path, body })).status,
    ).toBe(403);
    expect((await call("PUT", { key: true, path, body })).status).toBe(403);
    expect(
      (
        await call("PUT", {
          cookie: cookieFor("owner", OTHER_WORKSPACE),
          path,
          body,
        })
      ).status,
    ).toBe(404);
    expect((await call("PUT", { path, body })).status).toBe(401);
    const owner = cookieFor("owner");
    for (const bad of [
      { pull_request: LAYOUT },
      { pull_request: { ...LAYOUT, session_link: "host" }, revision: 0 },
      { pull_request: { ...LAYOUT, formatting: "inherit" }, revision: 0 },
      { pull_request: { ...LAYOUT, extra: 1 }, revision: 0 },
      { pull_request: LAYOUT, revision: 0, extra: 1 },
    ]) {
      expect(
        (await call("PUT", { cookie: owner, path, body: bad })).status,
      ).toBe(400);
    }
    expect(memory.layoutWrites).toEqual([]);
  });
});

// Each refusal here comes before a client secret would be read, so no
// request carries one.
describe("PUT the GitHub OAuth client secret", () => {
  const path = "/oauth-client-secret";

  test("without an author App it is 409 GITHUB_LINK_NOT_CONFIGURED", async () => {
    const { call } = appWith();
    const response = await call("PUT", {
      cookie: cookieFor("owner"),
      path,
      body: {},
    });
    expect(response.status).toBe(409);
    expect(code(response.json)).toMatchObject({
      code: "GITHUB_LINK_NOT_CONFIGURED",
      details: { reason_code: "no_author_app" },
    });
  });

  test("a member is 403, an API key 403, another workspace 404, no login 401", async () => {
    const { call } = appWith({ authorApp: true });
    expect(
      (await call("PUT", { cookie: cookieFor("member"), path, body: {} }))
        .status,
    ).toBe(403);
    expect((await call("PUT", { key: true, path, body: {} })).status).toBe(403);
    expect(
      (
        await call("PUT", {
          cookie: cookieFor("owner", OTHER_WORKSPACE),
          path,
          body: {},
        })
      ).status,
    ).toBe(404);
    expect((await call("PUT", { path, body: {} })).status).toBe(401);
  });

  test("a body without a secret is 400 and an oversized one 413", async () => {
    const { call } = appWith({ authorApp: true });
    const owner = cookieFor("owner");
    expect((await call("PUT", { cookie: owner, path, body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await call("PUT", {
          cookie: owner,
          path,
          body: { pad: "a".repeat(REQUEST_BODY_MAX_BYTES) },
        })
      ).status,
    ).toBe(413);
  });

  test("with the secret store off it is 503", async () => {
    const { call } = appWith({ authorApp: true, secretsOn: false });
    const response = await call("PUT", {
      cookie: cookieFor("owner"),
      path,
      body: {},
    });
    expect(response.status).toBe(503);
    expect(code(response.json).code).toBe("BACKEND_UNAVAILABLE");
  });
});

describe("PUT the App people link their accounts with", () => {
  const path = "/user-link-app";
  const CONNECTION = "019a0000-0000-7000-8000-0000000000d7";
  const REVIEWER = "019a0000-0000-7000-8000-0000000000d8";
  const apps = {
    setUserLink: async (_workspaceId: string, connectionId: string) =>
      connectionId === CONNECTION
        ? { outcome: "stored", before: null, changed: true }
        : connectionId === REVIEWER
          ? { outcome: "role_mismatch" }
          : { outcome: "not_found" },
  } as unknown as GitHubAppStore;

  test("an owner names an author connection; a reviewer one is 400, an unknown one 404", async () => {
    const { call } = appWith({ authorApp: true, apps });
    const owner = cookieFor("owner");
    const stored = await call("PUT", {
      cookie: owner,
      path,
      body: { connection_id: CONNECTION },
    });
    expect(stored.status).toBe(200);
    expect(stored.json.receipt_id).toEqual(expect.any(String));
    expect(stored.json.oauth.connection_id).toBe(AUTHOR_CONNECTION);
    const reviewer = await call("PUT", {
      cookie: owner,
      path,
      body: { connection_id: REVIEWER },
    });
    expect(reviewer.status).toBe(400);
    expect(code(reviewer.json).details).toEqual({
      reason_code: "role_mismatch",
    });
    expect(
      (
        await call("PUT", {
          cookie: owner,
          path,
          body: { connection_id: crypto.randomUUID() },
        })
      ).status,
    ).toBe(404);
  });

  test("a member, an API key, another workspace, a bad or oversized body and no secret store are refused", async () => {
    const { call } = appWith({ authorApp: true, apps });
    const body = { connection_id: CONNECTION };
    expect(
      (await call("PUT", { cookie: cookieFor("member"), path, body })).status,
    ).toBe(403);
    expect((await call("PUT", { key: true, path, body })).status).toBe(403);
    expect((await call("PUT", { path, body })).status).toBe(401);
    expect(
      (
        await call("PUT", {
          cookie: cookieFor("owner"),
          path,
          body,
          workspaceId: OTHER_WORKSPACE,
        })
      ).status,
    ).toBe(404);
    for (const bad of [{}, { connection_id: "conn-a" }]) {
      expect(
        (await call("PUT", { cookie: cookieFor("owner"), path, body: bad }))
          .status,
      ).toBe(400);
    }
    expect(
      (
        await call("PUT", {
          cookie: cookieFor("owner"),
          path,
          body: { connection_id: "a".repeat(REQUEST_BODY_MAX_BYTES) },
        })
      ).status,
    ).toBe(413);
    const off = appWith({ authorApp: true });
    expect(
      (await off.call("PUT", { cookie: cookieFor("owner"), path, body }))
        .status,
    ).toBe(503);
  });
});

describe("storing the GitHub OAuth client secret", () => {
  test("an owner's secret is stored and the response says only that it is set", async () => {
    const stored: string[] = [];
    const { call } = appWith({ authorApp: true, stored });
    const typed = fakeGitHubClientSecret();
    const response = await call("PUT", {
      cookie: cookieFor("owner"),
      path: "/oauth-client-secret",
      body: { client_id: "Iv23liClient", client_secret: typed },
    });
    expect(response.status).toBe(200);
    // Field by field: a matcher handed the whole body would print it.
    const oauth = (
      response.json as {
        oauth?: { client_id?: unknown; client_secret_set?: unknown };
      }
    ).oauth;
    expect(oauth?.client_id).toBe("Iv23liClient");
    expect(oauth?.client_secret_set).toBe(true);
    expect(JSON.stringify(response.json).includes(typed)).toBe(false);
    expect(stored.length === 1 && stored[0] === typed).toBe(true);
  });
});
