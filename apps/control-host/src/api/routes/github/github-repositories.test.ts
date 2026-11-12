import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  type AgentDetail,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  getGitHubRepositoryAppPinsResponseSchema,
  githubRepositoryWriteResponseSchema,
  listAgentGitHubRepositoriesResponseSchema,
  listGitHubRepositoriesResponseSchema,
  pickAgentGitHubRepositoryResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  type RepositoryCeiling,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { createGitHubAppDirectory } from "@werft-ai/forge-github";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  type CatalogRepositoryRow,
  type CatalogRepositoryStore,
  createAuthorizationPolicy,
  createGitHubRepositoryService,
  type GitHubAppStore,
  type GitHubPinStore,
  type GitHubRepositoryPin,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerGitHubRepositoryRoutes } from "./github-repositories.ts";

const createApiApp = recordRouteErrors(
  "routes/github/github-repositories.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const LISTED_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const APP_ID = 4242;
const INSTALLATION = 77;
const APP_ROW = "019a0000-0000-7000-8000-0000000000e1";

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

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

let github: FakeGitHub;
let appRegistered = true;

function appStore(): GitHubAppStore {
  const at = new Date();
  const record = {
    id: APP_ROW,
    workspaceId: WORKSPACE,
    appId: APP_ID,
    slug: "werft-test",
    name: "Werft test",
    htmlUrl: "https://github.com/apps/werft-test",
    clientId: null,
    permissions: {},
    permissionsCheckedAt: at,
    createdAt: at,
    updatedAt: at,
    privateKey: { updatedAt: at, updatedBy: null },
  };
  const registered = (workspaceId: string) =>
    appRegistered && workspaceId === WORKSPACE;
  return {
    async get(workspaceId: string, id: string) {
      return registered(workspaceId) && id === record.id
        ? { ...record, apiBase: github.origin, role: "author" }
        : null;
    },
    async list(workspaceId: string) {
      return registered(workspaceId)
        ? [{ ...record, apiBase: github.origin, role: "author" }]
        : [];
    },
    async credentials(role: string) {
      if (!appRegistered || role !== "author") return [];
      return [
        {
          id: record.id,
          workspaceId: WORKSPACE,
          appId: APP_ID,
          apiBase: github.origin,
          privateKey: keys.privateKey,
          updatedAt: at,
        },
      ];
    },
  } as unknown as GitHubAppStore;
}

// The Postgres store's locking and numbering are its own integration test;
// this one keeps what the routes need.
function memoryRepositories() {
  const rows = new Map<string, CatalogRepositoryRow>();
  const receipts: Array<{ operation: string; id: string; receipt: string }> =
    [];
  const counts = new Map<string, { author: number; reviewer: number }>();
  const store: CatalogRepositoryStore = {
    async listActive() {
      return [...rows.values()];
    },
    async listAgentChoosable() {
      return store.listActive();
    },
    async readCatalog() {
      return rows.size === 0 ? null : store.listActive();
    },
    async resolve(input) {
      const held = [...rows.values()].find(
        (row) =>
          row.github_repository_id === input.githubRepositoryId ||
          `${row.owner}/${row.name}`.toLowerCase() ===
            `${input.owner}/${input.name}`.toLowerCase(),
      );
      if (held) {
        held.github_repository_id ??= input.githubRepositoryId;
        return {
          outcome: "resolved",
          repository: held,
          created: false,
          changed: false,
        };
      }
      let id = input.base;
      for (let n = 2; rows.has(id); n += 1) {
        id = `${input.base}-${n}`;
      }
      const at = new Date().toISOString();
      const row = {
        id,
        github_repository_id: input.githubRepositoryId,
        owner: input.owner,
        name: input.name,
        url: input.url,
        branch: input.branch,
        source: "selection" as const,
        version: 1,
        created_at: at,
        updated_at: at,
      };
      rows.set(id, row);
      receipts.push({
        operation: "resolve_repository",
        id,
        receipt: input.receiptId,
      });
      return {
        outcome: "resolved",
        repository: row,
        created: true,
        changed: true,
      };
    },
    async setBranch(input) {
      const row = rows.get(input.id);
      if (row === undefined) return { outcome: "not_found" };
      if (row.version !== input.version) {
        return { outcome: "revision_conflict" };
      }
      row.branch = input.branch;
      row.version += 1;
      receipts.push({
        operation: "set_repository_branch",
        id: input.id,
        receipt: input.receiptId,
      });
      return { outcome: "stored", repository: { ...row } };
    },
    async agentCounts() {
      return counts;
    },
  };
  return { store, receipts, rows, counts };
}

function memoryPins() {
  const rows: GitHubRepositoryPin[] = [];
  const held = (repositoryId: string, role: string) =>
    rows.find((pin) => pin.repositoryId === repositoryId && pin.role === role);
  const store: GitHubPinStore = {
    async get(repositoryId, role) {
      return held(repositoryId, role) ?? null;
    },
    async list() {
      return [...rows];
    },
    async pinFirst(input) {
      const before = held(input.repositoryId, input.role);
      if (before !== undefined) return { pin: before, created: false };
      const pin = { ...input, pinnedBy: input.pinnedBy };
      rows.push({
        repositoryId: pin.repositoryId,
        role: pin.role,
        connectionId: pin.connectionId,
        appId: pin.appId,
        pinnedBy: pin.pinnedBy,
      });
      return { pin: rows.at(-1) as GitHubRepositoryPin, created: true };
    },
    async set(input) {
      const before = held(input.repositoryId, input.role);
      if (before?.connectionId === input.connectionId) {
        return {
          outcome: "stored",
          before: input.connectionId,
          changed: false,
        };
      }
      if (before !== undefined) rows.splice(rows.indexOf(before), 1);
      rows.push({
        repositoryId: input.repositoryId,
        role: input.role,
        connectionId: input.connectionId,
        appId: APP_ID,
        pinnedBy: "admin",
      });
      return {
        outcome: "stored",
        before: before?.connectionId ?? null,
        changed: true,
      };
    },
  };
  return { store, rows };
}

const logs = new MemoryLogSink();
const memory = memoryRepositories();
const pins = memoryPins();
let changes = 0;

// The workspace's ceiling; the listed-ceiling test swaps it for its own run.
let workspaceCeiling: RepositoryCeiling = {
  repository_ids: [],
  github_app_repositories: "installed",
};
const LISTED_CEILING: RepositoryCeiling = {
  repository_ids: [],
  github_app_repositories: "listed",
};

function appWith() {
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerRoutes: (router) =>
      registerGitHubRepositoryRoutes(
        router,
        createGitHubRepositoryService({
          authorization: createAuthorizationPolicy({}),
          store: memory.store,
          apps: appStore(),
          pins: pins.store,
          directory: createGitHubAppDirectory({ retryAfterBaseMs: 1 }),
          agents: {
            async get(_workspaceId, agentId) {
              return agentId === AGENT || agentId === LISTED_AGENT
                ? ({ active_release: null } as unknown as AgentDetail)
                : null;
            },
          },
          repositoryCeiling: async () => workspaceCeiling,
          changed: async () => {
            changes += 1;
          },
        }),
      ),
  });
  return async (
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    request: {
      cookie?: string;
      key?: boolean;
      body?: unknown;
    } = {},
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
}

const workspacePath = (suffix = "", workspaceId = WORKSPACE) =>
  `/v1/workspaces/${workspaceId}/github-repositories${suffix}`;
const agentPath = (agentId = AGENT, query = "") =>
  `/v1/agents/${agentId}/github/repositories${query}`;

let call: ReturnType<typeof appWith>;
const ids = new Map<string, number>();
beforeAll(async () => {
  github = await startFakeGitHub({
    appId: APP_ID,
    publicKey: keys.publicKey,
    installationId: INSTALLATION,
  });
  for (const name of ["App", "other", "tool"]) {
    await github.createRepository("acme", name, { "README.md": "hi\n" });
  }
  call = appWith();
  const listed = listGitHubRepositoriesResponseSchema.parse(
    (await call("GET", workspacePath(), { cookie: cookieFor("owner") })).json,
  );
  for (const repository of listed.repositories) {
    ids.set(repository.full_name, repository.github_repository_id);
  }
});
afterAll(async () => {
  await github.stop();
});

const code = (json: unknown) => apiErrorResponseSchema.parse(json).error;
const idOf = (fullName: string) => {
  const id = ids.get(fullName);
  if (id === undefined) throw new Error(`fake GitHub lists no ${fullName}`);
  return id;
};
const bodyFor = (method: "GET" | "POST" | "PATCH") =>
  method === "POST"
    ? { installation_id: INSTALLATION, github_repository_id: 1 }
    : method === "PATCH"
      ? { branch: "main", version: 1 }
      : undefined;

describe("the GitHub repository API", () => {
  test("an owner reads the App's repositories a page at a time with the catalog beside them", async () => {
    const owner = cookieFor("owner");
    const first = listGitHubRepositoriesResponseSchema.parse(
      (await call("GET", workspacePath("?per_page=2"), { cookie: owner })).json,
    );
    expect(first).toMatchObject({
      installations: [
        {
          id: INSTALLATION,
          account: "acme",
          connection_id: APP_ROW,
          role: "author",
          repository_count: 3,
        },
      ],
      installation_id: INSTALLATION,
      page: 1,
      per_page: 2,
      total_count: 3,
      unavailable: null,
    });
    expect(first.repositories.map((r) => r.full_name)).toEqual([
      "acme/App",
      "acme/other",
    ]);
    expect(first.repositories[0]).toMatchObject({
      default_branch: "main",
      catalog_id: null,
      agent_count: 0,
    });
    const second = listGitHubRepositoriesResponseSchema.parse(
      (
        await call(
          "GET",
          workspacePath(`?installation_id=${INSTALLATION}&page=2&per_page=2`),
          { cookie: owner },
        )
      ).json,
    );
    expect(second.repositories).toEqual([
      expect.objectContaining({ full_name: "acme/tool", catalog_id: null }),
    ]);
    expect(second.catalog).toEqual([]);

    const elsewhere = await call("GET", workspacePath("?installation_id=5"), {
      cookie: owner,
    });
    expect(elsewhere.status).toBe(404);
    expect(code(elsewhere.json).details).toEqual({
      reason_code: "installation_not_found",
    });
    const elsewhereForAgent = await call(
      "GET",
      agentPath(AGENT, "?installation_id=5"),
      { cookie: owner },
    );
    expect(elsewhereForAgent.status).toBe(404);
    expect(code(elsewhereForAgent.json).details).toEqual({
      reason_code: "installation_not_found",
    });
    for (const bad of ["?per_page=101", "?page=0", "?installation_id=x"]) {
      expect(
        (await call("GET", workspacePath(bad), { cookie: owner })).status,
        bad,
      ).toBe(400);
    }
  });

  test("a manager picks a repository for the agent: one catalog id, one receipt", async () => {
    const owner = cookieFor("owner");
    const page = listAgentGitHubRepositoriesResponseSchema.parse(
      (await call("GET", agentPath(), { cookie: owner })).json,
    );
    expect(page.unavailable).toBeNull();
    expect(page.total_count).toBe(3);

    const body = {
      installation_id: INSTALLATION,
      github_repository_id: idOf("acme/App"),
    };
    const picked = await call("POST", agentPath(), { cookie: owner, body });
    expect(picked.status).toBe(200);
    const first = pickAgentGitHubRepositoryResponseSchema.parse(picked.json);
    expect(first.catalog_id).toBe("app");
    expect(first.receipt_id).not.toBeNull();
    expect(memory.receipts.at(-1)).toEqual({
      operation: "resolve_repository",
      id: "app",
      receipt: first.receipt_id ?? "",
    });
    // The URL and branch are GitHub's.
    expect(memory.rows.get("app")).toMatchObject({
      url: "https://github.com/acme/App.git",
      branch: "main",
      source: "selection",
    });
    expect(changes).toBeGreaterThan(0);

    const again = pickAgentGitHubRepositoryResponseSchema.parse(
      (await call("POST", agentPath(), { cookie: owner, body })).json,
    );
    expect(first.connection_id).toBe(APP_ROW);
    expect(again).toEqual({
      catalog_id: "app",
      receipt_id: null,
      connection_id: APP_ROW,
    });

    memory.counts.set("app", { author: 2, reviewer: 1 });
    const listed = listGitHubRepositoriesResponseSchema.parse(
      (await call("GET", workspacePath(), { cookie: owner })).json,
    );
    expect(
      listed.repositories.find((r) => r.full_name === "acme/App"),
    ).toMatchObject({ catalog_id: "app", agent_count: 2 });
    expect(listed.catalog.find((r) => r.id === "app")).toMatchObject({
      source: "selection",
      installed: true,
      pins: { author: APP_ROW, reviewer: null },
    });
  });

  test("an owner reads a repository's pins and pins it to a connection whose App reaches it", async () => {
    const owner = cookieFor("owner");
    const pinsPath = workspacePath("/app/app-pins");
    await call("POST", agentPath(), {
      cookie: owner,
      body: {
        installation_id: INSTALLATION,
        github_repository_id: idOf("acme/App"),
      },
    });
    const read = await call("GET", pinsPath, { cookie: owner });
    expect(read.status).toBe(200);
    expect(getGitHubRepositoryAppPinsResponseSchema.parse(read.json)).toEqual({
      catalog_id: "app",
      pins: { author: APP_ROW, reviewer: null },
      candidates: [
        {
          connection_id: APP_ROW,
          role: "author",
          name: "Werft test",
          app_id: APP_ID,
          installed: true,
        },
      ],
    });
    const set = await call("PUT", `${pinsPath}/author`, {
      cookie: owner,
      body: { connection_id: APP_ROW },
    });
    expect(set.status).toBe(200);
    expect(set.json).toEqual({
      catalog_id: "app",
      role: "author",
      connection_id: APP_ROW,
      receipt_id: null,
    });

    const refusals = [
      [
        `${pinsPath}/reviewer`,
        { connection_id: APP_ROW },
        400,
        "role_mismatch",
      ],
      [`${pinsPath}/author`, { connection_id: crypto.randomUUID() }, 404, null],
      [`${pinsPath}/author`, { connection_id: "app-row" }, 400, null],
      [
        `${pinsPath}/author`,
        { connection_id: "a".repeat(REQUEST_BODY_MAX_BYTES) },
        413,
        null,
      ],
    ] as const;
    for (const [path, body, status, reason] of refusals) {
      const refused = await call("PUT", path, { cookie: owner, body });
      expect(refused.status, path).toBe(status);
      if (reason !== null) {
        expect(code(refused.json).details).toEqual({ reason_code: reason });
      }
    }
    expect(
      (await call("GET", workspacePath("/missing/app-pins"), { cookie: owner }))
        .status,
    ).toBe(404);
    expect(
      (await call("GET", pinsPath, { cookie: cookieFor("member") })).status,
    ).toBe(403);

    github.failApp(APP_ID, 500);
    try {
      const failed = await call("PUT", `${pinsPath}/author`, {
        cookie: owner,
        body: { connection_id: APP_ROW },
      });
      expect(failed.status).toBe(502);
    } finally {
      github.failApp(APP_ID, undefined);
    }
    expect(pins.rows.filter((pin) => pin.repositoryId === "app")).toEqual([
      {
        repositoryId: "app",
        role: "author",
        connectionId: APP_ROW,
        appId: APP_ID,
        pinnedBy: "selection",
      },
    ]);
  });

  test("a pick outside the installation, a file entry's repository or a listed ceiling is refused", async () => {
    const owner = cookieFor("owner");
    const absent = await call("POST", agentPath(), {
      cookie: owner,
      body: { installation_id: INSTALLATION, github_repository_id: 999_999 },
    });
    expect(absent.status).toBe(400);
    expect(code(absent.json).details).toEqual({ reason_code: "not_installed" });

    workspaceCeiling = LISTED_CEILING;
    let listed: Awaited<ReturnType<typeof call>>;
    try {
      expect(
        listAgentGitHubRepositoriesResponseSchema.parse(
          (await call("GET", agentPath(LISTED_AGENT), { cookie: owner })).json,
        ),
      ).toMatchObject({ repositories: [], unavailable: "ceiling_listed" });
      listed = await call("POST", agentPath(LISTED_AGENT), {
        cookie: owner,
        body: {
          installation_id: INSTALLATION,
          github_repository_id: idOf("acme/other"),
        },
      });
    } finally {
      workspaceCeiling = {
        repository_ids: [],
        github_app_repositories: "installed",
      };
    }
    expect(listed.status).toBe(400);
    expect(code(listed.json).details).toEqual({
      reason_code: "repository_not_allowed",
    });
    const huge = "x".repeat(REQUEST_BODY_MAX_BYTES + 1);
    expect(
      (await call("POST", agentPath(), { cookie: owner, body: { huge } }))
        .status,
    ).toBe(413);
    expect(
      (
        await call("POST", agentPath(), {
          cookie: owner,
          body: { installation_id: INSTALLATION },
        })
      ).status,
    ).toBe(400);
  });

  test("an owner changes a resolved row's branch; a file entry and bad branches are refused", async () => {
    const owner = cookieFor("owner");
    const branch = await call("PATCH", workspacePath("/app"), {
      cookie: owner,
      body: { branch: "develop", version: 1 },
    });
    expect(branch.status).toBe(200);
    expect(
      githubRepositoryWriteResponseSchema.parse(branch.json).repository,
    ).toMatchObject({ branch: "develop", version: 2, installed: true });

    const stale = await call("PATCH", workspacePath("/app"), {
      cookie: owner,
      body: { branch: "main", version: 1 },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json).code).toBe("REVISION_CONFLICT");

    for (const bad of [
      "",
      "-x",
      "a..b",
      "has space",
      "end/",
      "nul\u0000",
      "a@{1}",
      "/lead",
      "a//b",
      "a/.hidden",
      ".dot",
    ]) {
      const refused = await call("PATCH", workspacePath("/app"), {
        cookie: owner,
        body: { branch: bad, version: 2 },
      });
      expect(refused.status, bad).toBe(400);
    }
    const huge = "x".repeat(REQUEST_BODY_MAX_BYTES + 1);
    expect(
      (
        await call("PATCH", workspacePath("/app"), {
          cookie: owner,
          body: { branch: huge },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call("PATCH", workspacePath("/missing"), {
          cookie: owner,
          body: { branch: "main", version: 1 },
        })
      ).status,
    ).toBe(404);
  });

  test("without the author App the pages say so and a pick is refused", async () => {
    const owner = cookieFor("owner");
    appRegistered = false;
    try {
      const listed = listGitHubRepositoriesResponseSchema.parse(
        (await call("GET", workspacePath(), { cookie: owner })).json,
      );
      expect(listed).toMatchObject({
        installations: [],
        installation_id: null,
        repositories: [],
        unavailable: "no_author_app",
      });
      expect(listed.catalog.find((r) => r.id === "app")?.installed).toBe(null);
      const pick = await call("POST", agentPath(), {
        cookie: owner,
        body: {
          installation_id: INSTALLATION,
          github_repository_id: idOf("acme/other"),
        },
      });
      expect(pick.status).toBe(400);
      expect(code(pick.json).details).toEqual({ reason_code: "no_author_app" });
    } finally {
      appRegistered = true;
    }
  });

  test("GitHub failing is an error by cause for a named installation; the default page keeps the catalog", async () => {
    const owner = cookieFor("owner");
    const pickBody = {
      installation_id: INSTALLATION,
      github_repository_id: idOf("acme/other"),
    };
    const reads = [
      ["GET", `${workspacePath()}?installation_id=${INSTALLATION}`],
      ["GET", `${agentPath()}?installation_id=${INSTALLATION}`],
      ["POST", agentPath()],
    ] as const;
    for (const [status, reason] of [
      [401, "github_app_auth_failed"],
      [500, "github_unavailable"],
    ] as const) {
      github.failApp(APP_ID, status);
      try {
        const page = await call("GET", workspacePath(), { cookie: owner });
        expect(page.status).toBe(200);
        expect(page.json).toMatchObject({
          installations: [],
          unavailable: reason,
        });
        expect(
          (page.json as { catalog: unknown[] }).catalog.length,
        ).toBeGreaterThan(0);
        for (const [method, path] of reads) {
          const failed = await call(method, path, {
            cookie: owner,
            ...(method === "POST" ? { body: pickBody } : {}),
          });
          expect(failed.status, `${method} ${path} ${status}`).toBe(502);
          expect(code(failed.json)).toMatchObject({
            code: "GITHUB_UNAVAILABLE",
            details: { reason_code: reason },
          });
        }
      } finally {
        github.failApp(APP_ID, undefined);
      }
    }

    github.suspendInstallations(true);
    try {
      for (const path of [workspacePath(), agentPath()]) {
        const page = await call("GET", path, { cookie: owner });
        expect(page.status, path).toBe(200);
        expect(page.json, path).toMatchObject({
          unavailable: "installation_suspended",
          installations: [expect.objectContaining({ id: INSTALLATION })],
        });
        if (path === workspacePath()) {
          expect(
            (page.json as { catalog: unknown[] }).catalog.length,
          ).toBeGreaterThan(0);
        }
        const suspended = await call(
          "GET",
          `${path}?installation_id=${INSTALLATION}`,
          { cookie: owner },
        );
        expect(suspended.status, path).toBe(409);
        expect(code(suspended.json)).toMatchObject({
          code: "INSTALLATION_SUSPENDED",
          details: { reason_code: "installation_suspended" },
        });
      }
    } finally {
      github.suspendInstallations(false);
    }
  });

  test("members, API keys and other workspaces are refused", async () => {
    const member = cookieFor("member");
    const routes = [
      ["GET", workspacePath()],
      ["PATCH", workspacePath("/app")],
      ["GET", agentPath()],
      ["POST", agentPath()],
    ] as const;
    for (const [method, path] of routes) {
      const body = bodyFor(method);
      const refused = await call(method, path, { cookie: member, body });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect((await call(method, path, { body })).status).toBe(401);
    }
    // A key never manages the workspace's repositories or picks one.
    for (const [method, path] of [routes[0], routes[1], routes[3]]) {
      expect(
        (await call(method, path, { key: true, body: bodyFor(method) })).status,
        `${method} ${path} key`,
      ).toBe(403);
    }
    expect(
      (
        await call("GET", workspacePath("", OTHER_WORKSPACE), {
          cookie: cookieFor("owner"),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("GET", agentPath(crypto.randomUUID()), {
          cookie: cookieFor("owner"),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", agentPath(crypto.randomUUID()), {
          cookie: cookieFor("owner"),
          body: { installation_id: 1, github_repository_id: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("GET", agentPath(AGENT, "?per_page=0"), {
          cookie: cookieFor("owner"),
        })
      ).status,
    ).toBe(400);
  });
});
