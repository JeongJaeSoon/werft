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
import { joinFixtureTeam } from "@werft-ai/db/testing/fixture-team";
import { memberManageAllow } from "@werft-ai/db/testing/member-manage-allow";
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
import { liveSetupToken } from "../testing/setup-link.ts";
import { createApiApp } from "./app.ts";
import { DatabaseIdentityStore } from "./auth.ts";
import { DatabaseApiKeyStore, issueApiKey } from "./keys.ts";
import { PasswordChecks } from "./password-checks.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerInviteRoutes } from "./routes/musterrolle/invites.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";
import { registerEventRoutes } from "./routes/sessions/events.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions/sessions.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

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
      passwords: new PasswordChecks(),
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
      sessions: schema.createPostgresSessionShareStore(db),
    });
    const invites = createInviteService({
      authorization,
      store: createPostgresInviteStore(db),
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
        registerMemberRoutes(router, members, invites);
        registerInviteRoutes(router, invites);
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
      setup_token: await liveSetupToken(db),
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
    // Inside the agent, so the member's own starts are taken.
    await joinFixtureTeam(db, workspaceId, memberId);
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
        reason: schema.authzDecisions.reasonCode,
        actor: schema.authzDecisions.actorUserId,
      })
      .from(schema.authzDecisions)
      .where(eq(schema.authzDecisions.action, "member.manage"))
      .orderBy(schema.authzDecisions.at);
    // One row per request: the owner turning themselves off is kept as the
    // refusal it was, not as the role's allow.
    expect(kept.slice(decisionsBefore)).toEqual([
      { outcome: "deny", reason: "role", actor: memberId },
      { outcome: "deny", reason: "self_protected", actor: ownerId },
      { outcome: "allow", reason: "ok", actor: ownerId },
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

  const rowsFor = (requestId: string) =>
    db
      .select({
        outcome: schema.authzDecisions.outcome,
        reason: schema.authzDecisions.reasonCode,
      })
      .from(schema.authzDecisions)
      .where(eq(schema.authzDecisions.requestId, requestId));

  // The request's decision rows, by the id the response names.
  const decisionsOf = (response: Response) =>
    rowsFor(response.headers.get("X-Request-Id") ?? "");

  const access = (
    action: "disable" | "enable",
    userId: string,
    cookie: string,
  ) =>
    app.request(`/v1/members/${userId}/${action}`, {
      method: "POST",
      headers: { ...asCookie(cookie), "Content-Type": "application/json" },
      body: "{}",
    });

  test("a rule the store refuses under its locks is the request's one decision, a deny", async () => {
    const adminId = await addMember("admin@example.com");
    await db
      .update(memberships)
      .set({ role: "admin" })
      .where(sql`workspace_id = ${workspaceId} AND user_id = ${adminId}`);
    const adminCookie = await login("admin@example.com");

    const outranked = await access("disable", ownerId, adminCookie);
    expect(outranked.status).toBe(403);
    expect(await decisionsOf(outranked)).toEqual([
      { outcome: "deny", reason: "owner_protected" },
    ]);
    const self = await access("disable", adminId, adminCookie);
    expect(self.status).toBe(403);
    expect(await decisionsOf(self)).toEqual([
      { outcome: "deny", reason: "self_protected" },
    ]);
    // Already enabled: the act was allowed and found nothing to change.
    const unchanged = await access("enable", adminId, ownerCookie);
    expect(unchanged.status).toBe(200);
    expect(await decisionsOf(unchanged)).toEqual([
      { outcome: "allow", reason: "ok" },
    ]);
  });

  async function owner(email: string) {
    const userId = await addMember(email);
    await db
      .update(memberships)
      .set({ role: "owner" })
      .where(sql`workspace_id = ${workspaceId} AND user_id = ${userId}`);
    return userId;
  }

  test("the emergency admin is not turned off, and that refusal is the one row", async () => {
    // The bootstrap owner is the emergency admin.
    await owner("third-owner@example.com");
    const otherCookie = await login("third-owner@example.com");
    const refused = await access("disable", ownerId, otherCookie);
    expect(refused.status).toBe(409);
    expect(await decisionsOf(refused)).toEqual([
      { outcome: "deny", reason: "emergency_admin" },
    ]);
  });

  test("two owners turning each other off at once: one change, one refusal, a row each", async () => {
    const a = await owner("owner-a@example.com");
    const b = await owner("owner-b@example.com");
    const store = createPostgresMemberStore(db);
    // Both past the policy, so the store's locks decide between them.
    const off = (by: string, target: string) => {
      const allowed = memberManageAllow({ workspaceId, actorUserId: by });
      return store
        .setAccess({
          decision: allowed,
          actor: {
            principal: {
              ownerId: workspaceId,
              requestId: allowed.request.request_id,
              actor: {
                principal: { kind: "user", id: by },
                userId: by,
                workspaceId,
                apiKeyId: null,
              },
            },
            workspaceId,
            userId: by,
          },
          userId: target,
          scope: "membership",
          disabled: true,
          reason: null,
          receiptId: crypto.randomUUID(),
        })
        .then((result) => ({ result, requestId: allowed.request.request_id }));
    };
    // Both owners' rows held, so the two changes are sure to queue on them
    // together rather than run one after the other.
    const holder = await pool.connect();
    let settled: Awaited<ReturnType<typeof off>>[];
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = ANY($2) FOR UPDATE",
        [workspaceId, [a, b]],
      );
      const racing = Promise.all([off(a, b), off(b, a)]);
      for (let waited = 0; ; waited += 20) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (rows[0].n >= 2) break;
        if (waited > 5_000) throw new Error("the two changes never queued");
        await Bun.sleep(20);
      }
      await holder.query("COMMIT");
      settled = await racing;
    } finally {
      holder.release();
    }
    expect(settled.map(({ result }) => result.outcome).sort()).toEqual([
      "actor_inactive",
      "changed",
    ]);
    for (const { result, requestId } of settled) {
      expect(await rowsFor(requestId)).toEqual([
        result.outcome === "changed"
          ? { outcome: "allow", reason: "ok" }
          : { outcome: "deny", reason: "role" },
      ]);
    }
  });

  test("a store that throws leaves the request a deny error, and nothing it wrote", async () => {
    const allowed = memberManageAllow({ workspaceId, actorUserId: ownerId });
    const run = schema.decidedTransaction<{ outcome: "changed" }>(
      db,
      allowed,
      () => null,
    );
    await expect(
      run(async (tx) => {
        await tx
          .update(memberships)
          .set({ role: "admin" })
          .where(sql`workspace_id = ${workspaceId} AND user_id = ${ownerId}`);
        throw new Error("receipt insert failed");
      }),
    ).rejects.toThrow("receipt insert failed");
    expect(await rowsFor(allowed.request.request_id)).toEqual([
      { outcome: "deny", reason: "error" },
    ]);
    const [kept] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(sql`workspace_id = ${workspaceId} AND user_id = ${ownerId}`);
    expect(kept?.role).toBe("owner");
  });

  const managing = (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    cookie: string,
    body: unknown = {},
  ) =>
    app.request(path, {
      method,
      headers: { ...asCookie(cookie), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("invites and roles: each refusal the store decides is the request's one row, a deny", async () => {
    const adminId = await addMember("role-admin@example.com");
    await db
      .update(memberships)
      .set({ role: "admin" })
      .where(sql`workspace_id = ${workspaceId} AND user_id = ${adminId}`);
    const adminCookie = await login("role-admin@example.com");
    await owner("role-owner@example.com");
    const otherOwnerCookie = await login("role-owner@example.com");
    await addMember("role-member@example.com");
    const memberCookie = await login("role-member@example.com");

    const cases: [Response, number, { outcome: string; reason: string }][] = [
      [
        await managing("POST", "/v1/invites", memberCookie, {
          email: "by-member@example.com",
          role: "member",
        }),
        403,
        { outcome: "deny", reason: "role" },
      ],
      [
        await managing("POST", "/v1/invites", adminCookie, {
          email: "new-owner@example.com",
          role: "owner",
        }),
        403,
        { outcome: "deny", reason: "owner_protected" },
      ],
      [
        await managing("PATCH", `/v1/members/${ownerId}`, adminCookie, {
          role: "member",
        }),
        403,
        { outcome: "deny", reason: "owner_protected" },
      ],
      [
        await managing("PATCH", `/v1/members/${adminId}`, adminCookie, {
          role: "member",
        }),
        403,
        { outcome: "deny", reason: "self_protected" },
      ],
      [
        // The bootstrap owner is the emergency admin.
        await managing("PATCH", `/v1/members/${ownerId}`, otherOwnerCookie, {
          role: "admin",
        }),
        409,
        { outcome: "deny", reason: "emergency_admin" },
      ],
      [
        await managing("POST", "/v1/invites", ownerCookie, {
          email: "by-owner@example.com",
          role: "member",
        }),
        201,
        { outcome: "allow", reason: "ok" },
      ],
      [
        // Gone already: the act was allowed and found nothing to revoke.
        await managing(
          "DELETE",
          `/v1/invites/${crypto.randomUUID()}`,
          ownerCookie,
        ),
        404,
        { outcome: "allow", reason: "ok" },
      ],
    ];
    for (const [response, status, row] of cases) {
      expect(response.status).toBe(status);
      expect(await decisionsOf(response)).toEqual([row]);
    }
  });
});
