import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  authMeResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createSessionResponseSchema,
  loginResponseSchema,
  SESSION_SCOPE_VALUES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  memberships,
  users,
  webSessions,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSessionService,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  hashWebSessionToken,
  LoginLockout,
  WEB_SESSIONS_PER_USER,
} from "./auth.ts";
import { DatabaseApiKeyStore, issueApiKey } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { testCatalog } from "../test-support/catalog.ts";
import {
  allowRepositories,
  releaseIn,
  sessionReleases,
} from "../test-support/releases.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const WRONG = "an adequately wrong password";
const KEEPALIVE_MS = 300;

integration("auth API on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let apiKey: string;
  let now = Date.now();
  const sink = new MemoryLogSink();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "auth" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const keys = new DatabaseApiKeyStore(db);
    apiKey = (
      await issueApiKey(keys, {
        ownerId: "key-owner",
        scopes: [...SESSION_SCOPE_VALUES],
      })
    ).plaintext;
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [sink] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout({ now: () => now }),
      logger,
    };
    const catalog = testCatalog({
      repositories: {
        "sample-app": {
          url: "https://example.invalid/app.git",
          branch: "main",
          auth: { kind: "github_app", registered: true } as const,
        },
      },
    });
    const sessions = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy({
        identity: schema.createDatabaseIdentityReader(db),
        agents: schema.createDatabaseAgentAuthority(db),
        credentials: schema.createPostgresCredentialBindingStore(db),
        sessions: schema.createPostgresSessionShareStore(db),
      }),
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog,
      releases: sessionReleases(db, catalog),
    });
    app = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: keys,
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerSessionRoutes(router, sessions);
        registerEventRoutes(router, sessions, {
          // No NOTIFY source here: a wait lasts until the stream ends.
          wakeup: {
            wait: (_, signal) =>
              new Promise((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              ),
          },
          keepaliveMs: KEEPALIVE_MS,
          logger,
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const json = (path: string, body: unknown, headers: HeadersInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const bootstrapBody = {
    bootstrap_token: BOOTSTRAP_TOKEN,
    email: "Owner@Example.com",
    password: PASSWORD,
    display_name: "Owner",
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
  const login = (password = PASSWORD) =>
    json(
      "/v1/auth/login",
      { email: "owner@example.com", password },
      { "X-Requested-With": "werft-web" },
    );
  const cookieOf = (response: Response) =>
    (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  // The release is made once the workspace exists (first session below).
  const sessionBody = {
    agent_release_id: "",
    repository_id: "sample-app",
    message: "Inspect the failing unit test and propose a fix.",
  };

  let cookie = "";
  let workspaceId = "";

  test("bootstrap creates owner + workspace + membership once; second call is 409", async () => {
    const first = await json("/v1/auth/bootstrap", bootstrapBody);
    expect(first.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await first.json());
    workspaceId = body.workspace.id;
    const [user] = await db.select().from(users);
    expect(user?.email).toBe("owner@example.com");
    expect(user?.passwordHash).toStartWith("$argon2id$");
    const [membership] = await db.select().from(memberships);
    expect(membership).toMatchObject({
      userId: body.user_id,
      workspaceId,
      role: "owner",
    });

    const second = await json("/v1/auth/bootstrap", bootstrapBody);
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("BOOTSTRAP_DONE");
    expect(await db.$count(users)).toBe(1);
  });

  test("login sets the cookie, stores only the hash, and me reads it back", async () => {
    const response = await login();
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    expect(body.workspace_id).toBe(workspaceId);
    const header = response.headers.get("Set-Cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    cookie = cookieOf(response);
    const token = cookie.slice(`${WEB_SESSION_COOKIE_NAME}=`.length);
    const [row] = await db.select().from(webSessions);
    expect(Buffer.from(row?.tokenHash ?? [])).toEqual(
      Buffer.from(hashWebSessionToken(token)),
    );
    // Expiry comes from the database clock, ~14 days out.
    const days =
      ((row?.expiresAt.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);

    const me = await app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    const view = authMeResponseSchema.parse(await me.json());
    expect(view.principal).toMatchObject({
      kind: "user",
      id: body.user_id,
      workspace_id: workspaceId,
      role: "owner",
    });
    expect(view.workspace?.slug).toBe("acme");
    expect(view.user?.email).toBe("owner@example.com");
  });

  test("wrong password is 401 with the same body as an unknown user", async () => {
    const wrong = await login(WRONG);
    const unknown = await json(
      "/v1/auth/login",
      {
        email: "ghost@example.com",
        password: PASSWORD,
      },
      { "X-Requested-With": "werft-web" },
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await wrong.json()).error.message).toBe(
      (await unknown.json()).error.message,
    );
  });

  test("cookie-only POST /v1/sessions is 403 without the CSRF header, 201 with it; a key from before workspaces names no release", async () => {
    sessionBody.agent_release_id = await releaseIn(db, workspaceId);
    await allowRepositories(db, workspaceId, ["sample-app"]);
    const refused = await json("/v1/sessions", sessionBody, {
      Cookie: cookie,
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(refused.status).toBe(403);

    const allowed = await json("/v1/sessions", sessionBody, {
      Cookie: cookie,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(allowed.status).toBe(201);
    const created = createSessionResponseSchema.parse(await allowed.json());
    const [row] = await db
      .select({ ownerId: schema.sessions.ownerId })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, created.session_id));
    // The user's partition is the workspace.
    expect(row?.ownerId).toBe(workspaceId);

    const bearer = await json("/v1/sessions", sessionBody, {
      Authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(bearer.status).toBe(404);

    // The API key's session list is its own partition: the cookie's session
    // is not in it.
    const theirs = await app.request("/v1/sessions", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const ids = (await theirs.json()).items.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(created.session_id);
  });

  test("bearer wins over a cookie and a wrong bearer is not rescued", async () => {
    const both = await app.request("/v1/auth/me", {
      headers: { Authorization: `Bearer ${apiKey}`, Cookie: cookie },
    });
    expect((await both.json()).principal).toMatchObject({
      kind: "api_key",
      owner_id: "key-owner",
    });
    const wrong = await app.request("/v1/auth/me", {
      headers: { Authorization: "Bearer csp_nope", Cookie: cookie },
    });
    expect(wrong.status).toBe(401);
  });

  test("sixth failed login in the window is 429", async () => {
    // Earlier tests recorded 1 failure for owner@example.com; four more.
    for (let i = 0; i < 4; i += 1) {
      expect((await login(WRONG)).status).toBe(401);
    }
    const sixth = await login(WRONG);
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error.code).toBe("RATE_LIMITED");
    now += 16 * 60 * 1000;
    expect((await login()).status).toBe(200);
  });

  test("a session idle past the renew window slides in the DB and in the cookie", async () => {
    const fresh = cookieOf(await login());
    const hash = hashWebSessionToken(
      fresh.slice(`${WEB_SESSION_COOKIE_NAME}=`.length),
    );
    await db
      .update(webSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() + interval '1 day'`,
      })
      .where(eq(webSessions.tokenHash, hash));
    const me = await app.request("/v1/auth/me", { headers: { Cookie: fresh } });
    expect(me.status).toBe(200);
    const [row] = await db
      .select({ expiresAt: webSessions.expiresAt })
      .from(webSessions)
      .where(eq(webSessions.tokenHash, hash));
    const days =
      ((row?.expiresAt.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(13.9);
    const reissued = me.headers.get("Set-Cookie") ?? "";
    expect(reissued.split(";")[0]).toBe(fresh);
    expect(reissued).toContain(`Expires=${row?.expiresAt.toUTCString()}`);
    // Just renewed: the next request writes nothing and sets nothing.
    const again = await app.request("/v1/auth/me", {
      headers: { Cookie: fresh },
    });
    expect(again.headers.get("Set-Cookie")).toBeNull();
  });

  test("an expired row is refused by the database clock; logout revokes", async () => {
    await db
      .update(webSessions)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(
        eq(
          webSessions.tokenHash,
          hashWebSessionToken(
            cookie.slice(`${WEB_SESSION_COOKIE_NAME}=`.length),
          ),
        ),
      );
    const expired = await app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(expired.status).toBe(401);

    const fresh = cookieOf(await login());
    const logout = await app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: fresh, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
    expect(logout.status).toBe(204);
    const [row] = await db
      .select({ revokedAt: webSessions.revokedAt })
      .from(webSessions)
      .where(
        eq(
          webSessions.tokenHash,
          hashWebSessionToken(
            fresh.slice(`${WEB_SESSION_COOKIE_NAME}=`.length),
          ),
        ),
      );
    expect(row?.revokedAt).not.toBeNull();
    expect(
      (await app.request("/v1/auth/me", { headers: { Cookie: fresh } })).status,
    ).toBe(401);
  });

  test("login prunes expired and revoked rows and keeps at most WEB_SESSIONS_PER_USER live", async () => {
    // The previous test left one expired and one revoked row behind.
    const before = await db.$count(webSessions);
    expect(before).toBeGreaterThanOrEqual(2);
    const cookies: string[] = [];
    for (let i = 0; i < WEB_SESSIONS_PER_USER + 3; i += 1) {
      cookies.push(cookieOf(await login()));
    }
    const rows = await db
      .select({
        revokedAt: webSessions.revokedAt,
        live: sql<boolean>`${webSessions.expiresAt} > clock_timestamp()`,
      })
      .from(webSessions);
    expect(rows).toHaveLength(WEB_SESSIONS_PER_USER);
    expect(rows.every((row) => row.revokedAt === null && row.live)).toBe(true);
    const status = async (value: string) =>
      (await app.request("/v1/auth/me", { headers: { Cookie: value } })).status;
    expect(await status(cookies[0] ?? "")).toBe(401);
    expect(await status(cookies[2] ?? "")).toBe(401);
    expect(await status(cookies[3] ?? "")).toBe(200);
    expect(await status(cookies.at(-1) ?? "")).toBe(200);

    // A login whose row would sort oldest (it waited longest for the user
    // lock) still keeps the session it hands out.
    await db
      .update(webSessions)
      .set({ createdAt: sql`clock_timestamp() + interval '1 hour'` });
    const late = cookieOf(await login());
    expect(await status(late)).toBe(200);
    expect(await db.$count(webSessions)).toBe(WEB_SESSIONS_PER_USER);
  });

  // A cookie-opened stream, read up to its first frame so it is live.
  async function cookieStream(value: string) {
    const created = await json("/v1/sessions", sessionBody, {
      Cookie: value,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const { session_id } = createSessionResponseSchema.parse(
      await created.json(),
    );
    const response = await app.request(`/v1/sessions/${session_id}/events`, {
      headers: { Cookie: value },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    expect((await reader.read()).done).toBe(false);
    return reader;
  }

  // Resolves with the milliseconds from `since` to the end of the stream.
  async function endOf(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    since: number,
  ): Promise<number> {
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ done: false, value: undefined })),
      ]);
      if (chunk.value === undefined && !chunk.done) throw new Error("hung");
      if (chunk.done) return Date.now() - since;
    }
  }

  test("a cookie stream ends within one keepalive of a role change or a logout elsewhere", async () => {
    const value = cookieOf(await login());
    const demoted = await cookieStream(value);
    await db.update(memberships).set({ role: "member" });
    const demotedAt = Date.now();
    // The re-check runs every half interval, so one interval is the bound.
    expect(await endOf(demoted, demotedAt)).toBeLessThan(KEEPALIVE_MS + 50);
    await db.update(memberships).set({ role: "owner" });

    const loggedOut = await cookieStream(value);
    const logout = await app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: value, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
    expect(logout.status).toBe(204);
    const loggedOutAt = Date.now();
    expect(await endOf(loggedOut, loggedOutAt)).toBeLessThan(KEEPALIVE_MS + 50);
    expect(
      sink.records.filter(
        (record) =>
          record.message === "SSE stream closed" &&
          record.fields?.reason === "credential_revoked",
      ),
    ).toHaveLength(2);
  }, 15_000);

  test("a disabled user or membership cannot log in and its cookie stops working", async () => {
    const me = async (value: string) =>
      (await app.request("/v1/auth/me", { headers: { Cookie: value } })).status;
    for (const table of [users, memberships]) {
      const value = cookieOf(await login());
      expect(await me(value)).toBe(200);
      await db.update(table).set({ disabledAt: sql`clock_timestamp()` });
      expect((await login()).status).toBe(401);
      expect(await me(value)).toBe(401);
      await db.update(table).set({ disabledAt: null });
      expect(await me(value)).toBe(200);
    }
  });
});
