import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  completeGitHubInstallationResponseSchema,
  deleteGitHubAppResponseSchema,
  type GitHubAppRole,
  getGitHubAppResponseSchema,
  listGitHubAppsResponseSchema,
  putGitHubAppResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  startGitHubInstallationResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { createGitHubAppDirectory } from "@werft-ai/forge-github";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createGitHubAppService,
  type GitHubAppCredential,
  type GitHubAppRecord,
  type GitHubAppStore,
  type GitHubAppTarget,
  type GitHubInstallationState,
  type GitHubInstallationStore,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerGitHubAppRoutes } from "./github-app.ts";

const createApiApp = recordRouteErrors("routes/github-app.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const APP_ID = 4242;
const REVIEWER_APP_ID = 4343;

const rsaPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
const keys = rsaPair();
const privateKey = keys.privateKey;
const reviewerKeys = rsaPair();
const REVIEWER_FAKE = {
  appId: REVIEWER_APP_ID,
  publicKey: reviewerKeys.publicKey,
  installationId: 88,
  slug: "werft-reviewer",
  permissions: {
    contents: "read",
    metadata: "read",
    pull_requests: "write",
  } as const,
};
const strangerKey = rsaPair().privateKey;

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

// The Postgres store's behaviour (audit, receipts, sealing) is its own
// integration test; this one only remembers.
function memoryStore() {
  type Held = { record: GitHubAppRecord; key: string; role: GitHubAppRole };
  const held: Held[] = [];
  const receipts: Array<{ operation: string; app_id: number }> = [];
  const permissionReads: Array<{ id: string; permissions: unknown }> = [];
  let seeding = false;
  const mine = (workspaceId: string | undefined, role: GitHubAppRole) =>
    held.filter(
      (row) =>
        row.role === role &&
        (workspaceId === undefined || row.record.workspaceId === workspaceId),
    );
  const resolve = (
    workspaceId: string,
    target: GitHubAppTarget,
  ): Held | null | "ambiguous" => {
    if (target.kind === "connection") {
      return (
        held.find(
          (row) =>
            row.record.id === target.id &&
            row.record.workspaceId === workspaceId,
        ) ?? null
      );
    }
    if (target.kind === "add") return null;
    const rows = mine(workspaceId, target.role);
    return rows.length > 1 ? "ambiguous" : (rows[0] ?? null);
  };
  const withRole = (row: Held) => ({ ...row.record, role: row.role });
  const store: GitHubAppStore = {
    async ofRole(workspaceId, role) {
      return mine(workspaceId, role).map(withRole);
    },
    async get(workspaceId, id) {
      const row = resolve(workspaceId, { kind: "connection", id });
      return row === null || row === "ambiguous" ? null : withRole(row);
    },
    async list(workspaceId) {
      return (["author", "reviewer"] as const).flatMap((role) =>
        mine(workspaceId, role).map(withRole),
      );
    },
    async put(workspaceId, target, app, key, audit) {
      const at = new Date();
      const by = audit.principal.actor?.userId ?? "";
      const before = resolve(workspaceId, target);
      if (before === "ambiguous") return { outcome: "ambiguous_role" };
      if (target.kind === "connection" && before === null) {
        return { outcome: "not_found" };
      }
      if (
        target.kind === "connection" &&
        before !== null &&
        before.record.appId !== app.appId
      ) {
        return { outcome: "app_id_mismatch" };
      }
      const role = before?.role ?? (target as { role: GitHubAppRole }).role;
      // As the Postgres store decides it, under the workspace's lock.
      if (
        !seeding &&
        role === "reviewer" &&
        mine(workspaceId, "author").length === 0
      ) {
        return { outcome: "no_author_app" };
      }
      if (
        held.some((row) => row !== before && row.record.appId === app.appId)
      ) {
        return { outcome: "same_app" };
      }
      const row: Held = {
        key,
        role,
        record: {
          ...app,
          id: before?.record.id ?? crypto.randomUUID(),
          workspaceId,
          createdAt: before?.record.createdAt ?? at,
          updatedAt: at,
          permissionsCheckedAt: at,
          privateKey: {
            updatedAt: at,
            updatedBy: { userId: by, displayName: "owner" },
          },
        },
      };
      if (before === null) held.push(row);
      else held[held.indexOf(before)] = row;
      receipts.push({ operation: "set_github_app", app_id: app.appId });
      return {
        outcome: "stored",
        app: withRole(row),
        pinsCleared: 0,
        pinsRestored: 0,
      };
    },
    async delete(workspaceId, target) {
      const row = resolve(workspaceId, target);
      if (row === "ambiguous") return { outcome: "ambiguous_role" };
      if (row === null) return { outcome: "not_found" };
      held.splice(held.indexOf(row), 1);
      receipts.push({
        operation: "delete_github_app",
        app_id: row.record.appId,
      });
      return {
        outcome: "deleted",
        appId: row.record.appId,
        usage: {
          pinned_repository_count: 0,
          agent_count: 0,
          active_session_count: 0,
          user_link: false,
        },
      };
    },
    async usage() {
      return {
        pinned_repository_count: 0,
        agent_count: 0,
        active_session_count: 0,
        user_link: false,
      };
    },
    async setUserLink() {
      return { outcome: "not_found" };
    },
    async recordPermissions(id, appId, permissions) {
      permissionReads.push({ id, permissions });
      for (const row of held) {
        if (row.record.id === id && row.record.appId === appId) {
          row.record = {
            ...row.record,
            permissions,
            permissionsCheckedAt: new Date(),
          };
        }
      }
    },
    async credentials(
      role: GitHubAppRole,
      workspaceId?: string,
    ): Promise<GitHubAppCredential[]> {
      return mine(workspaceId, role).map((row) => ({
        id: row.record.id,
        workspaceId: row.record.workspaceId,
        appId: row.record.appId,
        apiBase: row.record.apiBase,
        privateKey: row.key,
        updatedAt: row.record.updatedAt,
      }));
    },
  };
  return {
    store,
    /** `store.put` without the role checks: a row the routes never made. */
    async seed(...args: Parameters<GitHubAppStore["put"]>) {
      seeding = true;
      try {
        return await store.put(...args);
      } finally {
        seeding = false;
      }
    },
    receipts,
    permissionReads,
    held: () => mine(undefined, "author")[0] ?? null,
    reviewer: () => mine(undefined, "reviewer")[0] ?? null,
    authors: () => mine(undefined, "author"),
    clear: () => held.splice(0),
  };
}

function memoryInstallations() {
  const states = new Map<string, GitHubInstallationState>();
  const links: Array<{
    connectionId: string;
    installationId: number;
    connectedBy: string;
  }> = [];
  const store = {
    async issueState(hash: Uint8Array, state: GitHubInstallationState) {
      states.set(Buffer.from(hash).toString("hex"), state);
    },
    async consumeState(hash: Uint8Array) {
      const key = Buffer.from(hash).toString("hex");
      const state = states.get(key) ?? null;
      states.delete(key);
      return state;
    },
    async recordLink(input: {
      connectionId: string;
      installationId: number;
      connectedBy: string;
    }) {
      if (
        links.some(
          (link) =>
            link.connectionId === input.connectionId &&
            link.installationId === input.installationId,
        )
      ) {
        return false;
      }
      links.push({
        connectionId: input.connectionId,
        installationId: input.installationId,
        connectedBy: input.connectedBy,
      });
      return true;
    },
  } as unknown as GitHubInstallationStore;
  return { store, links, clear: () => links.splice(0) };
}

const installs = memoryInstallations();
let installClock = Date.parse("2026-11-02T10:00:00.500Z");

let github: FakeGitHub;
const logs = new MemoryLogSink();
const responses: string[] = [];
const memory = memoryStore();
let changes = 0;

function appWith(options: { enabled?: boolean; apiBase?: string } = {}) {
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerRoutes: (router) =>
      registerGitHubAppRoutes(
        router,
        createGitHubAppService({
          authorization: createAuthorizationPolicy({}),
          store: options.enabled === false ? null : memory.store,
          directory: createGitHubAppDirectory({ retryAfterBaseMs: 1 }),
          apiBase: options.apiBase ?? github.origin,
          repositories: () => [
            { id: "app", url: "https://github.com/acme/app.git" },
            { id: "absent", url: "https://github.com/acme/absent.git" },
          ],
          changed: async () => {
            changes += 1;
          },
          installations: {
            store: installs.store,
            now: () => new Date(installClock),
          },
        }),
      ),
  });
  return async (
    method: "GET" | "PUT" | "POST" | "DELETE",
    request: {
      cookie?: string;
      key?: boolean;
      csrf?: boolean;
      body?: string;
      workspaceId?: string;
      path?: string;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${request.workspaceId ?? WORKSPACE}/${request.path ?? "github-app"}`,
      {
        method,
        headers: {
          ...(request.cookie ? { Cookie: request.cookie } : {}),
          ...(request.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
          ...(request.csrf === false
            ? {}
            : { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }),
          ...(request.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
      },
    );
    const text = await response.text();
    responses.push(text);
    return {
      status: response.status,
      json: text ? JSON.parse(text) : null,
      referrer: response.headers.get("Referrer-Policy"),
    };
  };
}

let call: ReturnType<typeof appWith>;
beforeAll(async () => {
  github = await startFakeGitHub({
    appId: APP_ID,
    publicKey: keys.publicKey,
    installationId: 77,
    slug: "werft-test",
    secondApp: REVIEWER_FAKE,
  });
  await github.createRepository("acme", "app", { "README.md": "hi\n" });
  call = appWith();
});
afterAll(async () => {
  await github.stop();
});

const body = (fields: Record<string, unknown>) => JSON.stringify(fields);
const code = (json: unknown) => apiErrorResponseSchema.parse(json).error;

describe("the GitHub App API", () => {
  test("an owner registers the App, sees where it is installed, replaces and removes it", async () => {
    const owner = cookieFor("owner");
    const empty = await call("GET", { cookie: owner });
    expect(getGitHubAppResponseSchema.parse(empty.json)).toEqual({
      github_app: null,
      check: null,
      installations: [],
      // This service is built without manifests.
      manifest_blocked: "console_origin_unset",
      repositories: [
        {
          id: "app",
          url: "https://github.com/acme/app.git",
          installation_id: null,
        },
        {
          id: "absent",
          url: "https://github.com/acme/absent.git",
          installation_id: null,
        },
      ],
      usage: null,
    });

    const set = await call("PUT", {
      cookie: owner,
      // Windows line ends and a trailing newline, as a pasted file may have.
      body: body({
        app_id: APP_ID,
        private_key: `${privateKey.replace(/\n/g, "\r\n")}\r\n`,
      }),
    });
    expect(set.status).toBe(200);
    expect(putGitHubAppResponseSchema.parse(set.json).github_app).toMatchObject(
      {
        app_id: APP_ID,
        slug: "werft-test",
        name: "Fake werft-test",
        html_url: `${github.origin}/apps/werft-test`,
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
        permissions_checked_at: expect.any(String),
        warnings: [],
      },
    );
    expect(memory.held()?.key).toBe(privateKey.trim());
    expect(changes).toBe(1);

    const read = await call("GET", { cookie: owner });
    expect(getGitHubAppResponseSchema.parse(read.json)).toMatchObject({
      github_app: { app_id: APP_ID },
      check: { state: "ok" },
      installations: [
        { id: 77, account: "acme", repository_selection: "selected" },
      ],
      repositories: [
        { id: "app", installation_id: 77 },
        { id: "absent", installation_id: null },
      ],
    });

    const replaced = await call("PUT", {
      cookie: cookieFor("admin"),
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    expect(replaced.status).toBe(200);

    const deleted = await call("DELETE", { cookie: owner });
    expect(deleted.status).toBe(200);
    deleteGitHubAppResponseSchema.parse(deleted.json);
    expect(memory.receipts.map(({ operation }) => operation)).toEqual([
      "set_github_app",
      "set_github_app",
      "delete_github_app",
    ]);
    expect((await call("GET", { cookie: owner })).json.github_app).toBeNull();
    expect((await call("DELETE", { cookie: owner })).status).toBe(404);
  });

  test("the routes are the author App's: a reviewer row is never read, replaced or deleted", async () => {
    const owner = cookieFor("owner");
    await memory.seed(
      WORKSPACE,
      { kind: "add", role: "reviewer" },
      {
        appId: APP_ID + 1,
        slug: "reviewer",
        name: "Reviewer",
        htmlUrl: "https://github.com/apps/reviewer",
        clientId: null,
        permissions: {},
        apiBase: github.origin,
      },
      strangerKey,
      { principal: { ownerId: WORKSPACE }, receiptId: "r", roles: [] },
    );
    const reviewer = memory.reviewer();
    expect((await call("GET", { cookie: owner })).json.github_app).toBeNull();
    expect((await call("DELETE", { cookie: owner })).status).toBe(404);
    const set = await call("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: keys.privateKey }),
    });
    expect(set.json.github_app.app_id).toBe(APP_ID);
    expect((await call("DELETE", { cookie: owner })).status).toBe(200);
    expect(memory.reviewer()).toBe(reviewer);
    expect(memory.reviewer()?.key).toBe(strangerKey);
    await memory.store.delete(
      WORKSPACE,
      { kind: "role", role: "reviewer" },
      {
        principal: { ownerId: WORKSPACE },
        receiptId: "r",
        roles: [],
      },
    );
  });

  test("a read keeps the App's permissions as GitHub reports them now, and warns of any wider than the guidance", async () => {
    const owner = cookieFor("owner");
    await call("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    const id = memory.held()?.record.id;
    github.setPermissions({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      administration: "write",
    });
    try {
      const read = await call("GET", { cookie: owner });
      expect(
        getGitHubAppResponseSchema.parse(read.json).github_app,
      ).toMatchObject({
        permissions: { administration: "write", contents: "write" },
        permissions_checked_at: expect.any(String),
        warnings: [
          { permission: "administration", level: "write", guided: null },
        ],
      });
      expect(memory.permissionReads.at(-1)).toEqual({
        id: id as string,
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
          administration: "write",
        },
      });
      expect(memory.held()?.record.permissions).toMatchObject({
        administration: "write",
      });
    } finally {
      github.setPermissions(undefined);
      await call("DELETE", { cookie: owner });
    }
  });

  test("a key that is not RSA, or that GitHub does not take for the id, is refused and nothing is stored", async () => {
    const owner = cookieFor("owner");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    for (const [privateKeyText, appId, reason] of [
      ["not a key", APP_ID, "invalid_private_key"],
      [ec, APP_ID, "invalid_private_key"],
      [strangerKey, APP_ID, "github_app_rejected"],
      [privateKey, APP_ID + 1, "github_app_rejected"],
    ] as const) {
      const refused = await call("PUT", {
        cookie: owner,
        body: body({ app_id: appId, private_key: privateKeyText }),
      });
      expect(refused.status).toBe(400);
      expect(code(refused.json)).toMatchObject({
        code: "BAD_REQUEST",
        details: { reason_code: reason },
      });
    }
    expect(memory.held()).toBeNull();
  });

  test("GitHub not answering is 503 on register and a failed check on read", async () => {
    const owner = cookieFor("owner");
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const down = appWith({ apiBase: `http://127.0.0.1:${closed.port}` });
    closed.stop(true);
    const refused = await down("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    expect(refused.status).toBe(503);
    expect(code(refused.json).details).toEqual({
      reason_code: "github_unreachable",
    });
    expect(memory.held()).toBeNull();

    await call("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    await github.stop();
    const read = await call("GET", { cookie: owner });
    expect(read.json).toMatchObject({
      github_app: { app_id: APP_ID },
      check: { state: "failed", reason_code: "github_unreachable" },
      installations: [],
    });
    github = await startFakeGitHub({
      appId: APP_ID,
      publicKey: keys.publicKey,
      port: Number(new URL(github.origin).port),
      installationId: 77,
      slug: "werft-test",
      secondApp: REVIEWER_FAKE,
    });
    await call("DELETE", { cookie: owner });
  });

  test("a member is refused on every method", async () => {
    const member = cookieFor("member");
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        cookie: member,
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(403);
    }
    expect(memory.held()).toBeNull();
  });

  test("an API key is refused", async () => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        key: true,
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(memory.held()).toBeNull();
  });

  test("another workspace's path is not found", async () => {
    const stranger = cookieFor("owner", OTHER_WORKSPACE);
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        cookie: stranger,
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  test("a malformed or oversized body is refused", async () => {
    const owner = cookieFor("owner");
    for (const text of [
      body({ app_id: "4242", private_key: privateKey }),
      body({ app_id: APP_ID }),
      body({ app_id: APP_ID, private_key: privateKey, extra: 1 }),
      '{"app_id": 1',
    ]) {
      expect((await call("PUT", { cookie: owner, body: text })).status).toBe(
        400,
      );
    }
    const huge = await call("PUT", {
      cookie: owner,
      body: body({
        app_id: APP_ID,
        private_key: "a".repeat(REQUEST_BODY_MAX_BYTES),
      }),
    });
    expect(huge.status).toBe(413);
  });

  test("a cookie write without the CSRF header is refused", async () => {
    const response = await call("DELETE", {
      cookie: cookieFor("owner"),
      csrf: false,
    });
    expect(response.status).toBe(403);
  });

  test("without a master key every method answers 503", async () => {
    const off = appWith({ enabled: false });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await off(method, {
        cookie: cookieFor("owner"),
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(503);
      expect(code(response.json).message).toContain("PLATFORM_SECRET_KEY");
    }
  });

  test("unauthenticated calls are 401", async () => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect((await call(method)).status).toBe(401);
    }
  });
});

describe("the GitHub App API by role", () => {
  const author = body({ app_id: APP_ID, private_key: keys.privateKey });
  const reviewer = body({
    app_id: REVIEWER_APP_ID,
    private_key: reviewerKeys.privateKey,
  });
  const conflict = (json: unknown) => code(json);
  // An earlier test restarts the fake, which forgets its repositories.
  beforeAll(async () => {
    await github.createRepository("acme", "app", { "README.md": "hi\n" });
  });

  test("a reviewer App needs an author App first and may not be it; then each role is read, replaced and removed alone", async () => {
    const owner = cookieFor("owner");
    const early = await call("PUT", {
      cookie: owner,
      path: "github-apps/reviewer",
      body: reviewer,
    });
    expect(early.status).toBe(409);
    expect(conflict(early.json)).toMatchObject({
      code: "GITHUB_APP_CONFLICT",
      details: { reason_code: "no_author_app" },
    });
    expect(memory.reviewer()).toBeNull();

    const set = await call("PUT", {
      cookie: owner,
      path: "github-apps/author",
      body: author,
    });
    expect(set.status).toBe(200);
    expect(set.json.github_app).toMatchObject({
      app_id: APP_ID,
      role: "author",
    });
    const same = await call("PUT", {
      cookie: owner,
      path: "github-apps/reviewer",
      body: author,
    });
    expect(same.status).toBe(409);
    expect(conflict(same.json)).toMatchObject({
      code: "GITHUB_APP_CONFLICT",
      details: { reason_code: "same_app" },
    });

    const second = await call("PUT", {
      cookie: owner,
      path: "github-apps/reviewer",
      body: reviewer,
    });
    expect(second.status).toBe(200);
    expect(
      putGitHubAppResponseSchema.parse(second.json).github_app,
    ).toMatchObject({
      app_id: REVIEWER_APP_ID,
      role: "reviewer",
      slug: "werft-reviewer",
      permissions: REVIEWER_FAKE.permissions,
    });
    // The alias is the author App's; the author may not become the reviewer.
    const swapped = await call("PUT", { cookie: owner, body: reviewer });
    expect(swapped.status).toBe(409);
    expect(conflict(swapped.json).details).toEqual({ reason_code: "same_app" });

    const read = await call("GET", {
      cookie: owner,
      path: "github-apps/reviewer",
    });
    expect(getGitHubAppResponseSchema.parse(read.json)).toMatchObject({
      github_app: { app_id: REVIEWER_APP_ID, role: "reviewer" },
      check: { state: "ok" },
      installations: [{ id: 88, account: "acme" }],
      repositories: [
        {
          id: "app",
          installation_id: 88,
          installation_permissions: REVIEWER_FAKE.permissions,
        },
        { id: "absent", installation_id: null },
      ],
    });
    expect(
      (await call("GET", { cookie: owner })).json.github_app,
    ).toMatchObject({ app_id: APP_ID, role: "author" });

    const removed = await call("DELETE", {
      cookie: owner,
      path: "github-apps/reviewer",
    });
    expect(removed.status).toBe(200);
    expect(memory.reviewer()).toBeNull();
    expect(memory.held()?.record.appId).toBe(APP_ID);
    expect(
      (await call("DELETE", { cookie: owner, path: "github-apps/reviewer" }))
        .status,
    ).toBe(404);
    expect(
      (await call("DELETE", { cookie: owner, path: "github-apps/author" }))
        .status,
    ).toBe(200);
    expect(memory.held()).toBeNull();
  });

  test("the role routes refuse as the alias does; an unknown role is not found", async () => {
    const path = "github-apps/reviewer";
    const off = appWith({ enabled: false });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const withBody = method === "PUT" ? { body: reviewer } : {};
      expect((await call(method, { path, ...withBody })).status).toBe(401);
      const member = await call(method, {
        cookie: cookieFor("member"),
        path,
        ...withBody,
      });
      expect(member.status).toBe(403);
      expect(
        (
          await call(method, {
            cookie: cookieFor("owner", OTHER_WORKSPACE),
            path,
            ...withBody,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call(method, {
            cookie: cookieFor("owner"),
            path: "github-apps/owner",
            ...withBody,
          })
        ).status,
      ).toBe(404);
      expect(
        (await off(method, { cookie: cookieFor("owner"), path, ...withBody }))
          .status,
      ).toBe(503);
    }
    const owner = cookieFor("owner");
    expect(
      (
        await call("PUT", {
          cookie: owner,
          path,
          body: body({ app_id: "4343" }),
        })
      ).status,
    ).toBe(400);
    const huge = await call("PUT", {
      cookie: owner,
      path,
      body: body({
        app_id: REVIEWER_APP_ID,
        private_key: "a".repeat(REQUEST_BODY_MAX_BYTES),
      }),
    });
    expect(huge.status).toBe(413);
    expect(memory.reviewer()).toBeNull();
  });

  test("several Apps a role: added, listed and addressed by id; the role address refuses while ambiguous", async () => {
    memory.clear();
    const owner = cookieFor("owner");
    const second = body({
      role: "author",
      app_id: REVIEWER_APP_ID,
      private_key: reviewerKeys.privateKey,
    });
    expect(
      (
        await call("PUT", {
          cookie: owner,
          path: "github-apps/author",
          body: author,
        })
      ).status,
    ).toBe(200);
    const added = await call("POST", {
      cookie: owner,
      path: "github-apps",
      body: second,
    });
    expect(added.status).toBe(200);
    const app = putGitHubAppResponseSchema.parse(added.json).github_app;
    expect(app).toMatchObject({ role: "author", app_id: REVIEWER_APP_ID });
    const listed = listGitHubAppsResponseSchema.parse(
      (await call("GET", { cookie: owner, path: "github-apps" })).json,
    );
    expect(listed.github_apps.map((each) => each.app_id)).toEqual([
      APP_ID,
      REVIEWER_APP_ID,
    ]);

    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const refused = await call(method, {
        cookie: owner,
        path: "github-apps/author",
        ...(method === "PUT" ? { body: author } : {}),
      });
      expect(refused.status).toBe(409);
      expect(code(refused.json)).toMatchObject({
        code: "GITHUB_APP_CONFLICT",
        details: { reason_code: "ambiguous_role" },
      });
    }
    const again = await call("POST", {
      cookie: owner,
      path: "github-apps",
      body: body({ role: "reviewer", app_id: APP_ID, private_key: privateKey }),
    });
    expect(again.status).toBe(409);
    expect(code(again.json).details).toEqual({ reason_code: "same_app" });

    const path = `github-apps/${app.connection_id}`;
    const read = await call("GET", { cookie: owner, path });
    expect(read.status).toBe(200);
    expect(getGitHubAppResponseSchema.parse(read.json)).toMatchObject({
      github_app: { app_id: REVIEWER_APP_ID, connection_id: app.connection_id },
      usage: { pinned_repository_count: 0, user_link: false },
    });
    expect((await call("DELETE", { cookie: owner, path })).status).toBe(200);
    expect(
      (await call("GET", { cookie: owner, path: "github-apps/author" })).json
        .github_app.app_id,
    ).toBe(APP_ID);
    memory.clear();
  });

  test("the connection list and the add are refused as the role routes are", async () => {
    const add = body({
      role: "author",
      app_id: REVIEWER_APP_ID,
      private_key: reviewerKeys.privateKey,
    });
    const off = appWith({ enabled: false });
    for (const [method, withBody] of [
      ["GET", {}],
      ["POST", { body: add }],
    ] as const) {
      const path = "github-apps";
      expect((await call(method, { path, ...withBody })).status).toBe(401);
      expect(
        (await call(method, { cookie: cookieFor("member"), path, ...withBody }))
          .status,
      ).toBe(403);
      expect(
        (
          await call(method, {
            cookie: cookieFor("owner", OTHER_WORKSPACE),
            path,
            ...withBody,
          })
        ).status,
      ).toBe(404);
      expect(
        (await off(method, { cookie: cookieFor("owner"), path, ...withBody }))
          .status,
      ).toBe(503);
    }
    const owner = cookieFor("owner");
    for (const text of [
      body({ app_id: REVIEWER_APP_ID, private_key: reviewerKeys.privateKey }),
      body({ role: "owner", app_id: REVIEWER_APP_ID, private_key: "k" }),
    ]) {
      expect(
        (await call("POST", { cookie: owner, path: "github-apps", body: text }))
          .status,
      ).toBe(400);
    }
    const huge = await call("POST", {
      cookie: owner,
      path: "github-apps",
      body: body({
        role: "author",
        app_id: REVIEWER_APP_ID,
        private_key: "a".repeat(REQUEST_BODY_MAX_BYTES),
      }),
    });
    expect(huge.status).toBe(413);
    expect(memory.authors()).toEqual([]);
  });
});

function userOfCookie(cookie: string): string {
  const token = cookie.split("=")[1] ?? "";
  const session = sessions.get(
    Buffer.from(hashWebSessionToken(token)).toString("hex"),
  );
  if (session === undefined) throw new Error("no such session");
  return session.userId;
}

async function registered(owner: string): Promise<string> {
  memory.clear();
  installs.clear();
  const set = await call("PUT", {
    cookie: owner,
    path: "github-apps/author",
    body: body({ app_id: APP_ID, private_key: privateKey }),
  });
  expect(set.status).toBe(200);
  const connectionId = putGitHubAppResponseSchema.parse(set.json).github_app
    .connection_id;
  if (connectionId === undefined) throw new Error("no connection id");
  return connectionId;
}

describe("a new key for a connection's own App", () => {
  test("a key GitHub takes for the App replaces the old one with a receipt; any other is refused and the old key stays", async () => {
    const owner = cookieFor("owner");
    const connectionId = await registered(owner);
    const path = `github-apps/${connectionId}`;
    const next = rsaPair();
    github.addAppKey(next.publicKey);
    const receiptsBefore = memory.receipts.length;

    const rotated = await call("PUT", {
      cookie: owner,
      path,
      body: body({ app_id: APP_ID, private_key: next.privateKey }),
    });
    expect(rotated.status).toBe(200);
    const answer = putGitHubAppResponseSchema.parse(rotated.json);
    expect(answer.github_app).toMatchObject({
      app_id: APP_ID,
      connection_id: connectionId,
    });
    expect(answer.receipt_id).toEqual(expect.any(String));
    expect(memory.held()?.key).toBe(next.privateKey.trim());
    expect(memory.receipts.length).toBe(receiptsBefore + 1);

    for (const [refused, reason] of [
      [{ app_id: APP_ID, private_key: strangerKey }, "github_app_rejected"],
      [
        { app_id: APP_ID, private_key: reviewerKeys.privateKey },
        "github_app_rejected",
      ],
      [
        { app_id: REVIEWER_APP_ID, private_key: reviewerKeys.privateKey },
        "app_id_mismatch",
      ],
    ] as const) {
      const answered = await call("PUT", {
        cookie: owner,
        path,
        body: body(refused),
      });
      expect(answered.status).toBe(400);
      expect(code(answered.json).details).toEqual({ reason_code: reason });
      expect(memory.held()?.key).toBe(next.privateKey.trim());
    }
    expect(memory.receipts.length).toBe(receiptsBefore + 1);

    const line = next.privateKey.split("\n")[1] ?? "";
    expect(line.length).toBeGreaterThan(20);
    const seen = [...responses, ...logs.records.map((r) => JSON.stringify(r))];
    for (const text of seen) expect(text).not.toContain(line);
    memory.clear();
  });
});

describe("who connected an installation started in the console", () => {
  async function start(cookie: string, connectionId: string) {
    const started = await call("POST", {
      cookie,
      path: `github-apps/${connectionId}/installations/start`,
    });
    expect(started.status).toBe(200);
    const parsed = startGitHubInstallationResponseSchema.parse(started.json);
    const url = new URL(parsed.install_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${memory.held()?.record.htmlUrl}/installations/new`,
    );
    expect(new Date(parsed.expires_at).getTime()).toBe(
      installClock + 3_600_000,
    );
    return url.searchParams.get("state") ?? "";
  }

  const complete = (
    cookie: string,
    fields: Record<string, unknown>,
    workspaceId?: string,
  ) =>
    call("POST", {
      cookie,
      path: "github-apps/installations/complete",
      body: body(fields),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });

  test("the state's own caller, back from GitHub with an installation made after it, is recorded once", async () => {
    const owner = cookieFor("owner");
    const connectionId = await registered(owner);
    github.setInstallationCreatedAt(new Date("2026-11-02T10:00:00Z"));
    try {
      const sameSecond = await complete(owner, {
        state: await start(owner, connectionId),
        installation_id: 77,
      });
      expect(sameSecond.json).toMatchObject({ recorded: false });
      expect(installs.links).toEqual([]);
      github.setInstallationCreatedAt(new Date("2026-11-02T10:00:01Z"));
      const state = await start(owner, connectionId);
      const done = await complete(owner, { state, installation_id: 77 });
      expect(done.status).toBe(200);
      expect(done.referrer).toBe("no-referrer");
      expect(completeGitHubInstallationResponseSchema.parse(done.json)).toEqual(
        { connection_id: connectionId, installation_id: 77, recorded: true },
      );
      expect(installs.links).toEqual([
        { connectionId, installationId: 77, connectedBy: userOfCookie(owner) },
      ]);
      const replay = await complete(owner, { state, installation_id: 77 });
      expect(replay.status).toBe(400);
      expect(code(replay.json).details).toEqual({
        reason_code: "state_invalid",
      });
      const admin = cookieFor("admin");
      const again = await complete(admin, {
        state: await start(admin, connectionId),
        installation_id: 77,
      });
      expect(again.json).toMatchObject({ recorded: false });
      expect(installs.links).toEqual([
        { connectionId, installationId: 77, connectedBy: userOfCookie(owner) },
      ]);
    } finally {
      github.setInstallationCreatedAt(new Date("2026-10-01T09:00:00Z"));
    }
  });

  test("a forged, expired, other workspace's or other person's state, an installation that was there before, another App's installation and GitHub not answering record nothing", async () => {
    const owner = cookieFor("owner");
    const connectionId = await registered(owner);
    const stateInvalid = { reason_code: "state_invalid" };

    const forged = await complete(owner, {
      state: "A".repeat(43),
      installation_id: 77,
    });
    expect(forged.status).toBe(400);
    expect(code(forged.json).details).toEqual(stateInvalid);

    const late = await start(owner, connectionId);
    installClock += 3_600_000;
    try {
      const expired = await complete(owner, {
        state: late,
        installation_id: 77,
      });
      expect(code(expired.json).details).toEqual(stateInvalid);
    } finally {
      installClock -= 3_600_000;
    }

    const otherOwner = cookieFor("owner", OTHER_WORKSPACE);
    const elsewhere = await complete(
      otherOwner,
      { state: await start(owner, connectionId), installation_id: 77 },
      OTHER_WORKSPACE,
    );
    expect(code(elsewhere.json).details).toEqual(stateInvalid);

    const someoneElse = await complete(cookieFor("admin"), {
      state: await start(owner, connectionId),
      installation_id: 77,
    });
    expect(code(someoneElse.json).details).toEqual(stateInvalid);

    const before = await complete(owner, {
      state: await start(owner, connectionId),
      installation_id: 77,
    });
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ recorded: false });

    const foreign = await complete(owner, {
      state: await start(owner, connectionId),
      installation_id: REVIEWER_FAKE.installationId,
    });
    expect(foreign.status).toBe(404);
    expect(code(foreign.json).details).toEqual({
      reason_code: "installation_not_found",
    });

    github.failApp(APP_ID, 500);
    try {
      const down = await complete(owner, {
        state: await start(owner, connectionId),
        installation_id: 77,
      });
      expect(down.status).toBe(502);
      expect(code(down.json)).toMatchObject({
        code: "GITHUB_UNAVAILABLE",
        details: { reason_code: "github_unavailable" },
      });
    } finally {
      github.failApp(APP_ID, undefined);
    }

    const orphan = await start(owner, connectionId);
    memory.clear();
    const removed = await complete(owner, {
      state: orphan,
      installation_id: 77,
    });
    expect(code(removed.json).details).toEqual(stateInvalid);
    expect(installs.links).toEqual([]);
  });

  test("starting is a manager's, in a signed-in console, for the workspace's own connection", async () => {
    const owner = cookieFor("owner");
    const connectionId = await registered(owner);
    const startPath = `github-apps/${connectionId}/installations/start`;
    expect(
      (await call("POST", { cookie: cookieFor("member"), path: startPath }))
        .status,
    ).toBe(403);
    expect((await call("POST", { key: true, path: startPath })).status).toBe(
      403,
    );
    expect((await call("POST", { path: startPath })).status).toBe(401);
    expect(
      (
        await call("POST", {
          cookie: owner,
          path: `github-apps/${crypto.randomUUID()}/installations/start`,
        })
      ).status,
    ).toBe(404);
    const completePath = "github-apps/installations/complete";
    expect(
      (
        await call("POST", {
          cookie: cookieFor("member"),
          path: completePath,
          body: body({ state: "x", installation_id: 77 }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("POST", {
          path: completePath,
          body: body({ state: "x", installation_id: 77 }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("POST", {
          cookie: owner,
          path: completePath,
          body: body({ state: "x", installation_id: 0 }),
        })
      ).status,
    ).toBe(400);
    memory.clear();
  });

  test("without a master key both answer 503", async () => {
    const off = appWith({ enabled: false });
    const owner = cookieFor("owner");
    expect(
      (
        await off("POST", {
          cookie: owner,
          path: `github-apps/${crypto.randomUUID()}/installations/start`,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await off("POST", {
          cookie: owner,
          path: "github-apps/installations/complete",
          body: body({ state: "x", installation_id: 77 }),
        })
      ).status,
    ).toBe(503);
  });
});

afterAll(() => {
  const seen = [...responses, ...logs.records.map((r) => JSON.stringify(r))];
  const body = privateKey.split("\n")[1] ?? "";
  expect(body.length).toBeGreaterThan(20);
  for (const text of seen) expect(text).not.toContain(body);
});
