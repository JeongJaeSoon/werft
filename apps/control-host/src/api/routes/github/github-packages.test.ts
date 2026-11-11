import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type GitHubPackagesAllowEntry,
  githubPackagesSettingsResponseSchema,
  githubPackagesWriteResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createGitHubPackagesService,
  type GitHubPackagesStore,
  type GitHubPackagesTokenVerifier,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerGitHubPackagesRoutes } from "./github-packages.ts";

const createApiApp = recordRouteErrors("routes/github/github-packages.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
// A value of the shape a test double takes, never a real token.
const GOOD = "fake-read-packages-credential";
const WIDE = "fake-wide-scope-credential";
const BAD = "fake-refused-credential";
const DOWN = "fake-github-down-credential";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const value = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(value)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${value}`;
}

const identity = {
  resolveWebSession: async (hash: Uint8Array) =>
    sessions.get(Buffer.from(hash).toString("hex")) ?? null,
  renewWebSession: async () => null,
} as unknown as IdentityStore;

const KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const keyStore = {
  find: async (candidate: Uint8Array) => {
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

// GitHub's `GET /user` as the verifier reads it, keyed by the value sent.
const verifier: GitHubPackagesTokenVerifier = {
  async verify(value) {
    if (value === GOOD) {
      return {
        outcome: "ok",
        facts: {
          login: "acme-packages-bot",
          expiresAt: new Date("2027-01-30T00:00:00Z"),
        },
      };
    }
    if (value === WIDE) {
      return {
        outcome: "rejected",
        reason: "scopes",
        scopes: ["read:packages", "repo"],
      };
    }
    if (value === DOWN) return { outcome: "unavailable" };
    return { outcome: "rejected", reason: "invalid", scopes: [] };
  },
};

// The Postgres store (locks, receipts) is its own integration test.
function memoryStore() {
  let stored: string | null = null;
  let allowlist: GitHubPackagesAllowEntry[] = [];
  let revision = 0;
  const store = {
    get: async () => ({
      token:
        stored === null
          ? null
          : {
              last4: stored.slice(-4),
              secretVersion: 1,
              updatedAt: new Date("2026-11-01T09:00:00Z"),
              updatedBy: null,
              login: "acme-packages-bot",
              expiresAt: new Date("2027-01-30T00:00:00Z"),
            },
      allowlist,
      revision,
    }),
    putToken: async (input: { workspaceId: string; token: string }) => {
      if (input.workspaceId !== WORKSPACE) {
        return { outcome: "workspace_not_found" as const };
      }
      stored = input.token;
      return { outcome: "stored" as const };
    },
    deleteToken: async () => {
      if (stored === null) return { outcome: "not_found" as const };
      stored = null;
      return { outcome: "deleted" as const };
    },
    putAllowlist: async (input: {
      allowlist: GitHubPackagesAllowEntry[];
      revision: number;
    }) => {
      if (input.revision !== revision) {
        return { outcome: "revision_conflict" as const };
      }
      allowlist = input.allowlist;
      revision += 1;
      return { outcome: "stored" as const };
    },
  } as unknown as GitHubPackagesStore;
  return { store, stored: () => stored };
}

function appWith(options: { secretsOn?: boolean } = {}) {
  const memory = memoryStore();
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerGitHubPackagesRoutes(
        router,
        createGitHubPackagesService({
          authorization: createAuthorizationPolicy({}),
          store: memory.store,
          verifier,
          secretsOn: options.secretsOn ?? true,
        }),
      ),
  });
  const call = async (
    method: "GET" | "PUT" | "DELETE",
    path: "" | "/token" | "/allowlist",
    request: {
      cookie?: string;
      key?: boolean;
      body?: unknown;
      workspaceId?: string;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${request.workspaceId ?? WORKSPACE}/github-packages${path}`,
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
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) : null,
    };
  };
  return { call, memory };
}

const error = (json: unknown) => apiErrorResponseSchema.parse(json).error;
const ENTRY: GitHubPackagesAllowEntry = {
  registry: "npm",
  owner: "acme",
  name: "*",
  repository_id: null,
  agent_id: null,
};

describe("the GitHub Packages API", () => {
  test("an owner registers a token, sees only its summary, and removes it", async () => {
    const { call, memory } = appWith();
    const owner = cookieFor("owner");
    const empty = await call("GET", "", { cookie: owner });
    expect(empty.status).toBe(200);
    expect(githubPackagesSettingsResponseSchema.parse(empty.json)).toEqual({
      token: {
        configured: false,
        last4: null,
        login: null,
        expires_at: null,
        updated_at: null,
        updated_by: null,
      },
      allowlist: [],
      revision: 0,
    });

    const put = await call("PUT", "/token", {
      cookie: owner,
      body: { token: GOOD },
    });
    expect(put.status).toBe(200);
    expect(githubPackagesWriteResponseSchema.parse(put.json).token).toEqual({
      configured: true,
      last4: GOOD.slice(-4),
      login: "acme-packages-bot",
      expires_at: "2027-01-30T00:00:00.000Z",
      updated_at: "2026-11-01T09:00:00.000Z",
      updated_by: null,
    });
    expect(memory.stored()).toBe(GOOD);
    const read = await call("GET", "", { cookie: cookieFor("member") });
    expect(read.text).not.toContain(GOOD);

    const removed = await call("DELETE", "/token", { cookie: owner });
    expect(removed.status).toBe(200);
    expect(removed.json.token.configured).toBe(false);
    expect((await call("DELETE", "/token", { cookie: owner })).status).toBe(
      404,
    );
  });

  test("a token GitHub refuses, or one with another scope, is not stored", async () => {
    const { call, memory } = appWith();
    const admin = cookieFor("admin");
    const wide = await call("PUT", "/token", {
      cookie: admin,
      body: { token: WIDE },
    });
    expect(wide.status).toBe(400);
    expect(error(wide.json)).toMatchObject({
      code: "BAD_REQUEST",
      details: { reason_code: "token_scopes" },
    });
    expect(wide.text).not.toContain(WIDE);
    const bad = await call("PUT", "/token", {
      cookie: admin,
      body: { token: BAD },
    });
    expect(bad.status).toBe(400);
    expect(error(bad.json)).toMatchObject({
      details: { reason_code: "token_invalid" },
    });
    const down = await call("PUT", "/token", {
      cookie: admin,
      body: { token: DOWN },
    });
    expect(down.status).toBe(503);
    expect(memory.stored()).toBeNull();
    for (const body of [{}, { token: "short" }, { token: "has space x" }]) {
      expect(
        (await call("PUT", "/token", { cookie: admin, body })).status,
      ).toBe(400);
    }
    const huge = await call("PUT", "/token", {
      cookie: admin,
      body: { token: GOOD, pad: "a".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(huge.status).toBe(413);
  });

  test("without a secret key no token is taken or removed", async () => {
    const { call } = appWith({ secretsOn: false });
    const owner = cookieFor("owner");
    expect(
      (await call("PUT", "/token", { cookie: owner, body: { token: GOOD } }))
        .status,
    ).toBe(503);
    expect((await call("DELETE", "/token", { cookie: owner })).status).toBe(
      503,
    );
  });

  test("the allowlist is replaced at the revision read; a stale one is 409", async () => {
    const { call } = appWith();
    const owner = cookieFor("owner");
    const put = await call("PUT", "/allowlist", {
      cookie: owner,
      body: { allowlist: [ENTRY], revision: 0 },
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ allowlist: [ENTRY], revision: 1 });
    const stale = await call("PUT", "/allowlist", {
      cookie: owner,
      body: { allowlist: [], revision: 0 },
    });
    expect(stale.status).toBe(409);
    expect(error(stale.json).code).toBe("REVISION_CONFLICT");
    for (const allowlist of [
      [{ ...ENTRY, registry: "maven" }],
      [{ ...ENTRY, owner: "-acme" }],
      [{ ...ENTRY, name: "a b" }],
      [{ ...ENTRY, agent_id: "not-a-uuid" }],
      [{ ...ENTRY, extra: 1 }],
      Array.from({ length: 201 }, () => ENTRY),
    ]) {
      expect(
        (
          await call("PUT", "/allowlist", {
            cookie: owner,
            body: { allowlist, revision: 1 },
          })
        ).status,
      ).toBe(400);
    }
    const huge = await call("PUT", "/allowlist", {
      cookie: owner,
      body: {
        allowlist: [],
        revision: 1,
        pad: "a".repeat(REQUEST_BODY_MAX_BYTES),
      },
    });
    expect(huge.status).toBe(413);
  });

  test("a member reads but changes nothing; an API key does neither", async () => {
    const { call, memory } = appWith();
    const member = cookieFor("member");
    expect((await call("GET", "", { cookie: member })).status).toBe(200);
    for (const [method, path, body] of [
      ["PUT", "/token", { token: GOOD }],
      ["DELETE", "/token", undefined],
      ["PUT", "/allowlist", { allowlist: [], revision: 0 }],
    ] as const) {
      const asMember = await call(method, path, { cookie: member, body });
      expect(asMember.status).toBe(403);
      const asKey = await call(method, path, { key: true, body });
      expect(asKey.status).toBe(403);
    }
    expect((await call("GET", "", { key: true })).status).toBe(403);
    expect(memory.stored()).toBeNull();
  });

  test("another workspace's path is not found; no cookie is 401", async () => {
    const { call } = appWith();
    const stranger = cookieFor("owner", OTHER_WORKSPACE);
    for (const [method, path, body] of [
      ["GET", "", undefined],
      ["PUT", "/token", { token: GOOD }],
      ["DELETE", "/token", undefined],
      ["PUT", "/allowlist", { allowlist: [], revision: 0 }],
    ] as const) {
      expect(
        (await call(method, path, { cookie: stranger, body })).status,
      ).toBe(404);
      expect((await call(method, path, { body })).status).toBe(401);
    }
  });
});
