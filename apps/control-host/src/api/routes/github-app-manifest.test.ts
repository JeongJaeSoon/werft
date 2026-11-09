import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  completeGitHubAppManifestResponseSchema,
  getGitHubAppResponseSchema,
  startGitHubAppManifestResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createGitHubAppService,
  GitHubAppCheckError,
  type GitHubAppManifestConversion,
  type GitHubAppManifestPut,
  type GitHubAppManifestState,
  type GitHubAppRecord,
  type GitHubAppStore,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { createGitHubManifestConverter } from "../forge-github.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerGitHubAppRoutes } from "./github-app.ts";

const createApiApp = recordRouteErrors("routes/github-app-manifest.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const ORIGIN = "https://console.example.com";
const CALLBACK = `${ORIGIN}/settings/linked-accounts/github`;
const PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const CLIENT_SECRET = `cs_${crypto.randomUUID()}`;
const WEBHOOK_SECRET = `wh_${crypto.randomUUID()}`;

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

// The Postgres store's transaction is its own integration test; this one
// decides `replaces` as it does and remembers what it was handed.
function memoryStore() {
  const held: GitHubAppRecord[] = [];
  const puts: Array<{ key: string; manifest?: GitHubAppManifestPut }> = [];
  const states = new Map<string, GitHubAppManifestState>();
  let failing = false;
  let outranked = false;
  const record = (appId: number, slug: string): GitHubAppRecord => {
    const at = new Date();
    return {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE,
      appId,
      slug,
      name: slug,
      htmlUrl: `https://github.com/apps/${slug}`,
      apiBase: "https://api.github.com",
      permissions: { contents: "write", metadata: "read" },
      permissionsCheckedAt: at,
      clientId: "Iv1.test",
      createdAt: at,
      updatedAt: at,
      privateKey: { updatedAt: at, updatedBy: null },
    };
  };
  const authors = () =>
    held.map((row) => ({ ...row, role: "author" as const }));
  const store: GitHubAppStore = {
    async ofRole(_workspaceId, role) {
      return role === "author" ? authors() : [];
    },
    async get(_workspaceId, id) {
      return authors().find((row) => row.id === id) ?? null;
    },
    async list() {
      return authors();
    },
    async put(_workspaceId, target, app, key, _audit, manifest) {
      if (failing) throw new Error("database went away");
      if (outranked) return { outcome: "outranked" };
      if (target.kind !== "add" || target.role !== "author") {
        throw new Error(`not reached: ${target.kind}`);
      }
      puts.push({ key, ...(manifest ? { manifest } : {}) });
      const row = { ...record(app.appId, app.slug), ...app };
      held.push(row);
      return {
        outcome: "stored",
        app: { ...row, role: "author" },
        pinsCleared: 0,
        pinsRestored: 0,
      };
    },
    async delete() {
      throw new Error("not reached: delete");
    },
    async usage() {
      return null;
    },
    async setUserLink() {
      return { outcome: "not_found" };
    },
    async recordPermissions() {},
    async credentials() {
      return [];
    },
  };
  return {
    store,
    puts,
    states: {
      async issueState(hash: Uint8Array, state: GitHubAppManifestState) {
        states.set(Buffer.from(hash).toString("hex"), state);
      },
      async consumeState(hash: Uint8Array) {
        const key = Buffer.from(hash).toString("hex");
        const state = states.get(key) ?? null;
        states.delete(key);
        return state;
      },
    },
    /** An App someone registered outside this flow. */
    hold: (appId: number) => held.push(record(appId, `held-${appId}`)),
    clear: () => held.splice(0),
    held: () => held.map((row) => row.appId),
    fail: (on: boolean) => {
      failing = on;
    },
    outrank: (on: boolean) => {
      outranked = on;
    },
  };
}

const logs = new MemoryLogSink();
const responses: string[] = [];
let clock = Date.now();
let nextApp = 9100;
const conversions: string[] = [];
let conversion: "ok" | "rejected" | "unreachable" = "ok";

async function convert(
  _apiBase: string,
  code: string,
): Promise<GitHubAppManifestConversion> {
  conversions.push(code);
  if (conversion === "rejected")
    throw new GitHubAppCheckError("github_rejected");
  if (conversion === "unreachable") {
    throw new GitHubAppCheckError("github_unreachable");
  }
  const appId = nextApp++;
  return {
    appId,
    slug: `werft-acme-${appId}`,
    name: `werft-acme-${appId}`,
    htmlUrl: `https://github.com/apps/werft-acme-${appId}`,
    permissions: {
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    },
    clientId: `Iv1.${appId}`,
    clientSecret: CLIENT_SECRET,
    privateKey: PEM,
    owner: "acme",
  };
}

function appWith(
  memory: ReturnType<typeof memoryStore>,
  options: { origin?: string | null; enabled?: boolean } = {},
) {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const logger = new StructuredLogger({ sinks: [logs], level: "debug" });
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger,
    registerRoutes: (router) =>
      registerGitHubAppRoutes(
        router,
        createGitHubAppService({
          authorization: createAuthorizationPolicy({}),
          store: options.enabled === false ? null : memory.store,
          directory: {} as never,
          apiBase: "https://api.github.com",
          repositories: () => [],
          changed: async () => {},
          manifests: {
            states: memory.states,
            convert,
            consoleOrigin: origin,
            callbackUrl: origin === null ? null : CALLBACK,
            webBase: "https://github.com",
            now: () => new Date(clock),
            refused: (check) =>
              logger.warn("GitHub App manifest state refused", { check }),
          },
        }),
        logger,
      ),
  });
  return async (
    path: "manifest" | "manifest/complete" | "get",
    request: {
      cookie?: string;
      key?: boolean;
      body?: unknown;
      raw?: string;
      workspaceId?: string;
    } = {},
  ) => {
    const get = path === "get";
    const text =
      request.raw ??
      (request.body === undefined ? undefined : JSON.stringify(request.body));
    const response = await app.request(
      `/v1/workspaces/${request.workspaceId ?? WORKSPACE}/github-apps/author${get ? "" : `/${path}`}`,
      {
        method: get ? "GET" : "POST",
        headers: {
          ...(request.cookie ? { Cookie: request.cookie } : {}),
          ...(request.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          ...(text === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(text === undefined ? {} : { body: text }),
      },
    );
    const body = await response.text();
    responses.push(body);
    return {
      status: response.status,
      json: body ? JSON.parse(body) : null,
      referrer: response.headers.get("Referrer-Policy"),
    };
  };
}

const error = (json: unknown) => apiErrorResponseSchema.parse(json).error;
const ORG = { owner: { kind: "organization", login: "acme" } };

/** Starts as `cookie` and returns the state GitHub would send back. */
async function started(
  call: ReturnType<typeof appWith>,
  cookie: string,
  body: Record<string, unknown> = ORG,
) {
  const start = await call("manifest", { cookie, body });
  expect(start.status).toBe(200);
  const parsed = startGitHubAppManifestResponseSchema.parse(start.json);
  const state = new URL(parsed.action_url).searchParams.get("state") ?? "";
  return { ...parsed, state };
}

const newCode = () => crypto.randomUUID().replaceAll("-", "");

describe("making the author GitHub App from a manifest", () => {
  const memory = memoryStore();
  const call = appWith(memory);

  test("an owner starts with an organization, private by default, and gets GitHub's form target and the manifest", async () => {
    memory.clear();
    const owner = cookieFor("owner");
    const start = await started(call, owner);
    const url = new URL(start.action_url);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/organizations/acme/settings/apps/new",
    );
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(start.expires_at).getTime()).toBe(clock + 3_600_000);
    const manifest = JSON.parse(start.manifest);
    expect(manifest).toEqual({
      name: expect.stringMatching(/^werft-acme-[0-9a-f]{4}$/),
      url: ORIGIN,
      redirect_url: `${ORIGIN}/settings/workspace/integrations/github/new-app`,
      callback_urls: [CALLBACK],
      setup_url: `${ORIGIN}/settings/workspace/integrations/github`,
      public: false,
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
      },
      default_events: [],
      request_oauth_on_install: false,
    });
  });

  test("a personal account posts to the user's own new-App page; public and Actions are opt-in", async () => {
    memory.clear();
    const start = await started(call, cookieFor("admin"), {
      owner: { kind: "user" },
      public: true,
      actions: true,
    });
    const url = new URL(start.action_url);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/settings/apps/new",
    );
    const manifest = JSON.parse(start.manifest);
    expect(manifest.name).toMatch(/^werft-agent-[0-9a-f]{4}$/);
    expect(manifest.public).toBe(true);
    expect(manifest.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      actions: "write",
      workflows: "write",
    });
  });

  test("completing stores the App with its key and client secret, once; the state cannot be spent again", async () => {
    memory.clear();
    const owner = cookieFor("owner");
    const { state } = await started(call, owner);
    const code = newCode();
    const done = await call("manifest/complete", {
      cookie: owner,
      body: { code, state },
    });
    expect(done.status).toBe(200);
    expect(done.referrer).toBe("no-referrer");
    const body = completeGitHubAppManifestResponseSchema.parse(done.json);
    expect(body.install_url).toBe(
      `${body.github_app.html_url}/installations/new`,
    );
    expect(body.github_app.app_id).toBe(nextApp - 1);
    expect(memory.puts.at(-1)).toEqual({
      key: PEM,
      manifest: {
        clientSecret: CLIENT_SECRET,
        owner: "acme",
        public: false,
      },
    });
    expect(conversions.at(-1)).toBe(code);

    const again = await call("manifest/complete", {
      cookie: owner,
      body: { code, state },
    });
    expect(again.status).toBe(400);
    expect(again.referrer).toBe("no-referrer");
    expect(error(again.json).details).toEqual({ reason_code: "state_invalid" });
    // The spent state never reached GitHub again.
    expect(conversions.filter((sent) => sent === code)).toHaveLength(1);
  });

  test("an expired state, or one another person started, is refused before GitHub is asked", async () => {
    memory.clear();
    const owner = cookieFor("owner");
    const sent = conversions.length;

    const expired = await started(call, owner);
    clock += 3_600_000;
    const late = await call("manifest/complete", {
      cookie: owner,
      body: { code: newCode(), state: expired.state },
    });
    clock -= 3_600_000;
    expect(late.status).toBe(400);
    expect(error(late.json).details).toEqual({ reason_code: "state_invalid" });

    const theirs = await started(call, owner);
    const other = await call("manifest/complete", {
      cookie: cookieFor("owner"),
      body: { code: newCode(), state: theirs.state },
    });
    expect(other.status).toBe(400);
    expect(error(other.json).details).toEqual({ reason_code: "state_invalid" });

    const unknown = await call("manifest/complete", {
      cookie: owner,
      body: { code: newCode(), state: "not-a-state-we-issued" },
    });
    expect(unknown.status).toBe(400);

    expect(conversions.length).toBe(sent);
    expect(
      logs.records
        .filter(
          (entry) => entry.message === "GitHub App manifest state refused",
        )
        .map((entry) => entry.fields?.check),
    ).toEqual(expect.arrayContaining(["expired", "actor", "not_found"]));
  });

  test("with an author App registered, a manifest adds another author connection", async () => {
    memory.clear();
    memory.hold(5001);
    const owner = cookieFor("owner");
    for (const replace of [false, true]) {
      const begun = await started(call, owner, { ...ORG, replace });
      const done = await call("manifest/complete", {
        cookie: owner,
        body: { code: newCode(), state: begun.state },
      });
      expect(done.status).toBe(200);
    }
    expect(memory.held()).toEqual([5001, nextApp - 2, nextApp - 1]);
    const raced = await started(call, owner, ORG);
    memory.hold(5002);
    const done = await call("manifest/complete", {
      cookie: owner,
      body: { code: newCode(), state: raced.state },
    });
    expect(done.status).toBe(200);
    expect(memory.held()).toEqual([
      5001,
      nextApp - 3,
      nextApp - 2,
      5002,
      nextApp - 1,
    ]);
  });

  test("GitHub refusing the code is 400, not answering is 503, and a failed save names the App left on GitHub", async () => {
    memory.clear();
    const owner = cookieFor("owner");
    conversion = "rejected";
    const rejected = await call("manifest/complete", {
      cookie: owner,
      body: { code: newCode(), state: (await started(call, owner)).state },
    });
    expect(rejected.status).toBe(400);
    expect(error(rejected.json).details).toEqual({
      reason_code: "code_rejected",
    });

    conversion = "unreachable";
    const away = await call("manifest/complete", {
      cookie: owner,
      body: { code: newCode(), state: (await started(call, owner)).state },
    });
    conversion = "ok";
    expect(away.status).toBe(503);
    expect(error(away.json).details).toEqual({
      reason_code: "github_unreachable",
    });

    memory.fail(true);
    const lost = await call("manifest/complete", {
      cookie: owner,
      body: { code: newCode(), state: (await started(call, owner)).state },
    });
    memory.fail(false);
    expect(lost.status).toBe(503);
    expect(error(lost.json).details).toEqual({
      reason_code: "store_failed",
      app_id: nextApp - 1,
      html_url: `https://github.com/apps/werft-acme-${nextApp - 1}`,
    });

    memory.outrank(true);
    const refused = await call("manifest/complete", {
      cookie: owner,
      body: { code: newCode(), state: (await started(call, owner)).state },
    });
    memory.outrank(false);
    expect(refused.status).toBe(403);
    expect(error(refused.json).details).toMatchObject({
      app_id: nextApp - 1,
      html_url: `https://github.com/apps/werft-acme-${nextApp - 1}`,
    });
  });

  test("a member is refused, an API key is refused, another workspace is not found, and a bad body is 400", async () => {
    const member = cookieFor("member");
    for (const path of ["manifest", "manifest/complete"] as const) {
      const body =
        path === "manifest" ? ORG : { code: newCode(), state: "abc" };
      expect((await call(path, { cookie: member, body })).status).toBe(403);
      expect((await call(path, { key: true, body })).status).toBe(403);
      expect(
        (
          await call(path, {
            cookie: cookieFor("owner"),
            body,
            workspaceId: OTHER_WORKSPACE,
          })
        ).status,
      ).toBe(404);
      expect((await call(path, { body })).status).toBe(401);
      expect(
        (await call(path, { cookie: cookieFor("owner"), raw: "{" })).status,
      ).toBe(400);
    }
    const badLogin = await call("manifest", {
      cookie: cookieFor("owner"),
      body: { owner: { kind: "organization", login: "-bad" } },
    });
    expect(badLogin.status).toBe(400);
  });

  test("no code, state, key or secret reaches a response or the log", () => {
    const seen = [...responses, JSON.stringify(logs.records)].join("\n");
    for (const value of [CLIENT_SECRET, WEBHOOK_SECRET, PEM.split("\n")[1]]) {
      expect(seen).not.toContain(value);
    }
    const log = JSON.stringify(logs.records);
    for (const code of conversions) expect(log).not.toContain(code);
  });
});

describe("when a manifest cannot be made", () => {
  test("without CONSOLE_ORIGIN the read says why and a start is 503", async () => {
    const memory = memoryStore();
    const call = appWith(memory, { origin: null });
    const owner = cookieFor("owner");
    const read = await call("get", { cookie: owner });
    expect(read.status).toBe(200);
    expect(getGitHubAppResponseSchema.parse(read.json).manifest_blocked).toBe(
      "console_origin_unset",
    );
    const start = await call("manifest", { cookie: owner, body: ORG });
    expect(start.status).toBe(503);
    expect(error(start.json).details).toEqual({
      reason_code: "console_origin_unset",
    });

    const ready = await appWith(memory)("get", { cookie: owner });
    expect(getGitHubAppResponseSchema.parse(ready.json).manifest_blocked).toBe(
      null,
    );
  });

  test("without a master key both routes answer 503", async () => {
    const call = appWith(memoryStore(), { enabled: false });
    const owner = cookieFor("owner");
    expect((await call("manifest", { cookie: owner, body: ORG })).status).toBe(
      503,
    );
    expect(
      (
        await call("manifest/complete", {
          cookie: owner,
          body: { code: newCode(), state: "abc" },
        })
      ).status,
    ).toBe(503);
  });
});

describe("the manifest conversion call", () => {
  let server: ReturnType<typeof Bun.serve>;
  const hits: string[] = [];
  let answer = 201;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        hits.push(`${request.method} ${url.pathname}`);
        if (answer !== 201) {
          return Response.json({ message: "nope" }, { status: answer });
        }
        return Response.json(
          {
            id: 777,
            slug: "werft-acme-ab12",
            name: "werft-acme-ab12",
            html_url: "https://github.com/apps/werft-acme-ab12",
            owner: { login: "acme" },
            permissions: { contents: "write", metadata: "read", bogus: "x" },
            client_id: "Iv1.777",
            client_secret: CLIENT_SECRET,
            webhook_secret: WEBHOOK_SECRET,
            pem: PEM.replaceAll("\n", "\r\n"),
          },
          { status: 201 },
        );
      },
    });
  });
  afterAll(() => server.stop(true));

  test("posts the code once and maps GitHub's answer; refusals and failures are not retried", async () => {
    const sink = new MemoryLogSink();
    const convertWith = createGitHubManifestConverter({
      logger: new StructuredLogger({ sinks: [sink], level: "debug" }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const app = await convertWith(base, "abc123");
    expect(hits).toEqual(["POST /app-manifests/abc123/conversions"]);
    expect(app).toEqual({
      appId: 777,
      slug: "werft-acme-ab12",
      name: "werft-acme-ab12",
      htmlUrl: "https://github.com/apps/werft-acme-ab12",
      permissions: { contents: "write", metadata: "read" },
      clientId: "Iv1.777",
      clientSecret: CLIENT_SECRET,
      privateKey: PEM.trim(),
      owner: "acme",
    });

    for (const [status, reason] of [
      [404, "github_rejected"],
      [422, "github_rejected"],
      [500, "github_unreachable"],
    ] as const) {
      hits.length = 0;
      answer = status;
      const failed = await convertWith(base, "def456").catch((e) => e);
      expect(failed).toBeInstanceOf(GitHubAppCheckError);
      expect(failed.reason).toBe(reason);
      expect(hits).toHaveLength(1);
    }
    answer = 201;
    const log = JSON.stringify(sink.records);
    expect(log).not.toContain("abc123");
    expect(log).not.toContain("def456");
  });
});
