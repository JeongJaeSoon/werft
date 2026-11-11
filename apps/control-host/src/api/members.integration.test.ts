import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  authMeResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createSessionResponseSchema,
  getReceiptResponseSchema,
  listTakeoversResponseSchema,
  SESSION_SCOPE_VALUES,
  type SessionScope,
  scopesForRole,
  setAccessResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  createPostgresInviteStore,
  createPostgresMemberStore,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  memberships,
  sessions,
  users,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createInviteService,
  createMemberService,
  createSessionService,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { testCatalog } from "../testing/catalog.ts";
import {
  allowRepositories,
  releaseIn,
  sessionReleases,
} from "../testing/releases.ts";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore, issueApiKey } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";
import { registerEventRoutes } from "./routes/sessions/events.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const KEEPALIVE_MS = 300;
const ALL = [...SESSION_SCOPE_VALUES] as SessionScope[];

integration("members and actors over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let keys: DatabaseApiKeyStore;
  const sink = new MemoryLogSink();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "members_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    keys = new DatabaseApiKeyStore(db);
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [sink] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger,
    };
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: schema.createDatabaseAgentAuthority(db),
      credentials: schema.createPostgresCredentialBindingStore(db),
      sessions: schema.createPostgresSessionShareStore(db),
      decisions: createPostgresDecisionLog(db),
    });
    const catalog = testCatalog({
      repositories: {
        "sample-app": {
          url: "https://example.invalid/app.git",
          branch: "main",
          auth: { kind: "github_app", registered: true } as const,
        },
      },
    });
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization,
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog,
      releases: sessionReleases(db, catalog),
    });
    const members = createMemberService({
      authorization,
      store: createPostgresMemberStore(db),
    });
    app = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: keys,
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerSessionRoutes(router, service);
        registerReceiptRoutes(router, service);
        registerMemberRoutes(
          router,
          members,
          createInviteService({
            authorization,
            store: createPostgresInviteStore(db),
          }),
        );
        registerEventRoutes(router, service, {
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

  const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, headers: HeadersInit) =>
    app.request(path, { headers });
  const bearer = (plaintext: string) => ({
    Authorization: `Bearer ${plaintext}`,
  });
  const cookieOf = (response: Response) =>
    (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  // Its release is made with the workspace (setup below).
  const sessionBody = {
    agent_release_id: "",
    repository_id: "sample-app",
    message: "Inspect the failing unit test and propose a fix.",
  };

  async function login(email: string) {
    const response = await post(
      "/v1/auth/login",
      { email, password: PASSWORD },
      { "X-Requested-With": "werft-web" },
    );
    expect(response.status).toBe(200);
    return cookieOf(response);
  }

  async function createSession(headers: HeadersInit) {
    const response = await post("/v1/sessions", sessionBody, {
      ...headers,
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(response.status).toBe(201);
    return createSessionResponseSchema.parse(await response.json());
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  async function stream(sessionId: string, headers: HeadersInit) {
    const response = await get(`/v1/sessions/${sessionId}/events`, headers);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no stream body");
    return reader;
  }

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

  let workspaceId = "";
  let ownerId = "";
  let ownerCookie = "";
  let memberId = "";

  async function addMember(email: string) {
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(PASSWORD, {
          algorithm: "argon2id",
        }),
        displayName: email,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    await db
      .insert(memberships)
      .values({ workspaceId, userId: user.id, role: "member" });
    return user.id;
  }

  test("setup: an owner, a member, and their cookies", async () => {
    const boot = await post("/v1/auth/bootstrap", {
      bootstrap_token: BOOTSTRAP_TOKEN,
      email: "owner@example.com",
      password: PASSWORD,
      display_name: "Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    });
    expect(boot.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await boot.json());
    workspaceId = body.workspace.id;
    ownerId = body.user_id;
    ownerCookie = await login("owner@example.com");
    memberId = await addMember("member@example.com");
    sessionBody.agent_release_id = await releaseIn(db, workspaceId);
    await allowRepositories(db, workspaceId, ["sample-app"]);
  });

  test("a legacy key answers /auth/me as before and starts no session", async () => {
    const legacy = await issueApiKey(keys, {
      ownerId: "legacy-owner",
      scopes: ALL,
    });
    const me = authMeResponseSchema.parse(
      await (await get("/v1/auth/me", bearer(legacy.plaintext))).json(),
    );
    expect(me).toEqual({
      principal: {
        kind: "api_key",
        id: legacy.keyId,
        owner_id: "legacy-owner",
        workspace_id: null,
        scopes: ALL,
      },
      user: null,
      workspace: null,
      scopes: ALL,
      permissions: [],
    });
    // It names no workspace, so no release: it starts nothing now.
    const refused = await post("/v1/sessions", sessionBody, {
      ...bearer(legacy.plaintext),
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(refused.status).toBe(404);
  });

  test("a member's key sees the sessions they made on the web, and /auth/me names the workspace", async () => {
    const others = await issueApiKey(keys, {
      workspaceId,
      scopes: ALL,
      personalFor: ownerId,
    });
    const byCookie = await createSession(asCookie(ownerCookie));
    const listed = await get("/v1/sessions", bearer(others.plaintext));
    expect(listed.status).toBe(200);
    const ids = (
      (await listed.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(ids).toContain(byCookie.session_id);
    const me = authMeResponseSchema.parse(
      await (await get("/v1/auth/me", bearer(others.plaintext))).json(),
    );
    expect(me.workspace?.id).toBe(workspaceId);
  });

  test("an API key takes no management action, whatever its scopes", async () => {
    const personal = await issueApiKey(keys, {
      workspaceId,
      scopes: ALL,
      personalFor: ownerId,
    });
    expect(
      (await get("/v1/takeovers", bearer(personal.plaintext))).status,
    ).toBe(403);
    expect((await get("/v1/takeovers", { Cookie: ownerCookie })).status).toBe(
      200,
    );
  });

  test("a personal key stops when its creator is disabled; another member's does not", async () => {
    const creatorId = await addMember("creator@example.com");
    const personal = await issueApiKey(keys, {
      workspaceId,
      scopes: ALL,
      personalFor: creatorId,
    });
    const others = await issueApiKey(keys, {
      workspaceId,
      scopes: ALL,
      personalFor: ownerId,
    });
    expect((await get("/v1/sessions", bearer(personal.plaintext))).status).toBe(
      200,
    );
    const me = authMeResponseSchema.parse(
      await (await get("/v1/auth/me", bearer(personal.plaintext))).json(),
    );
    const memberScopes = scopesForRole("member");
    expect(memberScopes.length).toBeLessThan(ALL.length);
    expect(me.scopes).toEqual(ALL.filter((s) => memberScopes.includes(s)));

    await db
      .update(users)
      .set({ disabledAt: sql`clock_timestamp()` })
      .where(eq(users.id, creatorId));
    expect((await get("/v1/sessions", bearer(personal.plaintext))).status).toBe(
      401,
    );
    expect((await get("/v1/sessions", bearer(others.plaintext))).status).toBe(
      200,
    );
  });

  test("disabling a member blocks the web session and personal key, cuts open streams, and parks what they asked for", async () => {
    const memberCookie = await login("member@example.com");
    const personal = await issueApiKey(keys, {
      workspaceId,
      scopes: ALL,
      personalFor: memberId,
    });
    // The owner's key: what the offboarding must leave running.
    const others = await issueApiKey(keys, {
      workspaceId,
      scopes: ALL,
      personalFor: ownerId,
    });
    const asked = await createSession(asCookie(memberCookie));
    const row = await sessionRow(asked.session_id);
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.createdByUserId).toBe(memberId);
    expect(row.createdByApiKeyId).toBeNull();
    const byKey = await createSession(bearer(personal.plaintext));
    expect((await sessionRow(byKey.session_id)).createdByUserId).toBe(memberId);

    const cookieStream = await stream(asked.session_id, {
      Cookie: memberCookie,
    });
    const keyStream = await stream(
      asked.session_id,
      bearer(personal.plaintext),
    );
    const othersStream = await stream(
      asked.session_id,
      bearer(others.plaintext),
    );

    const setAccess = (
      base: "members" | "users",
      action: "disable" | "enable",
      userId: string,
      cookie: string,
      body: unknown = {},
    ) =>
      app.request(`/v1/${base}/${userId}/${action}`, {
        method: "POST",
        headers: { ...asCookie(cookie), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const decisionsBefore = await db.$count(
      schema.authzDecisions,
      eq(schema.authzDecisions.action, "member.manage"),
    );
    expect(
      (await setAccess("members", "disable", ownerId, memberCookie)).status,
    ).toBe(403);
    const self = await setAccess("members", "disable", ownerId, ownerCookie);
    expect(self.status).toBe(403);
    expect(
      ((await self.json()) as { error: { code: string } }).error.code,
    ).toBe("SELF_PROTECTED");
    const disabled = await setAccess(
      "members",
      "disable",
      memberId,
      ownerCookie,
      { reason: "left the team" },
    );
    expect(disabled.status).toBe(200);
    const change = setAccessResponseSchema.parse(await disabled.json());
    expect(change.member.disabled_at).not.toBeNull();
    if (!change.receipt_id) throw new Error("no receipt");
    const receipt = getReceiptResponseSchema.parse(
      await (
        await get(`/v1/receipts/${change.receipt_id}`, { Cookie: ownerCookie })
      ).json(),
    );
    expect(receipt).toMatchObject({
      operation: "disable_member",
      status: "succeeded",
      target_ref: { user_id: memberId, workspace_id: workspaceId },
      actor: {
        principal: { kind: "user", id: ownerId },
        actor_user_id: ownerId,
        agent_id: null,
      },
      result: {
        reason: "left the team",
        revoked_web_sessions: 1,
        revoked_personal_keys: 1,
        revoked_linked_accounts: 0,
        sessions_awaiting_takeover: 2,
      },
    });
    const offboardedAt = Date.now();
    const kept = await db
      .select({
        outcome: schema.authzDecisions.outcome,
        actor: schema.authzDecisions.actorUserId,
      })
      .from(schema.authzDecisions)
      .where(eq(schema.authzDecisions.action, "member.manage"))
      .orderBy(schema.authzDecisions.at);
    expect(kept.slice(decisionsBefore)).toEqual([
      { outcome: "deny", actor: memberId },
      { outcome: "allow", actor: ownerId },
      { outcome: "allow", actor: ownerId },
    ]);

    expect(await endOf(cookieStream, offboardedAt)).toBeLessThan(
      KEEPALIVE_MS + 50,
    );
    expect(await endOf(keyStream, offboardedAt)).toBeLessThan(
      KEEPALIVE_MS + 50,
    );
    expect((await get("/v1/sessions", { Cookie: memberCookie })).status).toBe(
      401,
    );
    expect((await get("/v1/sessions", bearer(personal.plaintext))).status).toBe(
      401,
    );
    expect((await get("/v1/sessions", bearer(others.plaintext))).status).toBe(
      200,
    );
    const alive = await Promise.race([
      othersStream.read().then(() => true),
      Bun.sleep(KEEPALIVE_MS * 2).then(() => false),
    ]);
    expect(alive).toBe(true);
    await othersStream.cancel();

    const refused = await post(
      `/v1/sessions/${asked.session_id}/messages`,
      { message: "continue" },
      { ...asCookie(ownerCookie), "Idempotency-Key": crypto.randomUUID() },
    );
    expect(refused.status).toBe(409);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("TAKEOVER_REQUIRED");

    const listed = listTakeoversResponseSchema.parse(
      await (await get("/v1/takeovers", { Cookie: ownerCookie })).json(),
    );
    expect(listed.items.map((item) => item.session_id).sort()).toEqual(
      [asked.session_id, byKey.session_id].sort(),
    );
    expect(
      listed.items.every((item) => item.departed_user_id === memberId),
    ).toBe(true);
  });

  test("an owner's takeover leaves them on the receipt and as the requester", async () => {
    const listed = listTakeoversResponseSchema.parse(
      await (await get("/v1/takeovers", { Cookie: ownerCookie })).json(),
    );
    const sessionId = listed.items[0]?.session_id;
    if (!sessionId) throw new Error("nothing awaiting takeover");

    const noCsrf = await app.request(`/v1/sessions/${sessionId}/takeover`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    expect(noCsrf.status).toBe(403);

    const taken = await app.request(`/v1/sessions/${sessionId}/takeover`, {
      method: "POST",
      headers: asCookie(ownerCookie),
    });
    expect(taken.status).toBe(200);
    const { receipt_id } = (await taken.json()) as { receipt_id: string };
    const receipt = getReceiptResponseSchema.parse(
      await (
        await get(`/v1/receipts/${receipt_id}`, { Cookie: ownerCookie })
      ).json(),
    );
    expect(receipt).toMatchObject({
      operation: "takeover",
      status: "succeeded",
      actor: {
        principal: { kind: "user", id: ownerId },
        actor_user_id: ownerId,
        agent_id: null,
      },
    });
    const row = await sessionRow(sessionId);
    expect(row.createdByUserId).toBe(ownerId);
    expect(row.takeoverRequiredAt).toBeNull();

    const accepted = await post(
      `/v1/sessions/${sessionId}/messages`,
      { message: "continue" },
      { ...asCookie(ownerCookie), "Idempotency-Key": crypto.randomUUID() },
    );
    expect(accepted.status).toBe(202);
    const again = await app.request(`/v1/sessions/${sessionId}/takeover`, {
      method: "POST",
      headers: asCookie(ownerCookie),
    });
    expect(again.status).toBe(409);
  });

  test("enabling the member again brings back neither the old cookie nor the old key; a new login works", async () => {
    const personal = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.createdByUserId, memberId));
    expect(personal).toHaveLength(1);
    const enabled = await app.request(`/v1/members/${memberId}/enable`, {
      method: "POST",
      headers: { ...asCookie(ownerCookie), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(enabled.status).toBe(200);
    const change = setAccessResponseSchema.parse(await enabled.json());
    expect(change.member.disabled_at).toBeNull();
    const [receipt] = await db
      .select({
        operation: schema.receipts.operation,
        result: schema.receipts.result,
      })
      .from(schema.receipts)
      .where(eq(schema.receipts.id, change.receipt_id ?? ""));
    // The takeover above took one of the two; the other goes back to them.
    expect(receipt).toEqual({
      operation: "enable_member",
      result: { reason: null, sessions_released: 1 },
    });
    expect(
      await db.$count(
        schema.apiKeys,
        sql`revoked_at IS NULL AND created_by_user_id = ${memberId}`,
      ),
    ).toBe(0);
    const revokedCookies = await db.$count(
      schema.webSessions,
      sql`user_id = ${memberId} AND revoked_at IS NULL`,
    );
    expect(revokedCookies).toBe(0);
    const fresh = await login("member@example.com");
    expect((await get("/v1/sessions", { Cookie: fresh })).status).toBe(200);
  });

  test("an account is suspended only by someone who owns every workspace it is in", async () => {
    const userId = await addMember("two-places@example.com");
    const elsewhere = crypto.randomUUID();
    await db.insert(schema.workspaces).values({
      id: elsewhere,
      slug: "elsewhere",
      name: "Elsewhere",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: elsewhere, userId, role: "member" });
    const cookie = await login("two-places@example.com");
    const suspend = () =>
      app.request(`/v1/users/${userId}/disable`, {
        method: "POST",
        headers: {
          ...asCookie(ownerCookie),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "security review" }),
      });
    expect((await suspend()).status).toBe(403);
    expect((await get("/v1/sessions", { Cookie: cookie })).status).toBe(200);

    await db
      .update(memberships)
      .set({ disabledAt: sql`clock_timestamp()` })
      .where(sql`workspace_id = ${elsewhere} AND user_id = ${userId}`);
    const suspended = await suspend();
    expect(suspended.status).toBe(200);
    const change = setAccessResponseSchema.parse(await suspended.json());
    expect(change.member.disabled_at).not.toBeNull();
    expect((await get("/v1/sessions", { Cookie: cookie })).status).toBe(401);
    const refused = await post(
      "/v1/auth/login",
      { email: "two-places@example.com", password: PASSWORD },
      { "X-Requested-With": "werft-web" },
    );
    expect(refused.status).toBe(401);

    const lifted = await app.request(`/v1/users/${userId}/enable`, {
      method: "POST",
      headers: { ...asCookie(ownerCookie), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(lifted.status).toBe(200);
    expect((await get("/v1/sessions", { Cookie: cookie })).status).toBe(401);
    const operations = await db
      .select({ operation: schema.receipts.operation })
      .from(schema.receipts)
      .where(sql`target_ref->>'user_id' = ${userId}`)
      .orderBy(schema.receipts.createdAt);
    expect(operations.map((row) => row.operation)).toEqual([
      "disable_user",
      "enable_user",
    ]);
    await login("two-places@example.com");
  });
});
