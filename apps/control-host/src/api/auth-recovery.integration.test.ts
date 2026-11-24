import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapResponseSchema,
  issuePasswordResetResponseSchema,
  passwordResetResponseSchema,
  receiptSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  memberships,
  passwordResets,
  receipts,
  setupLinks,
  users,
  webSessions,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSessionService,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  issueTestSetupToken as issueSetupToken,
  liveSetupToken,
} from "../testing/setup-link.ts";
import { createApiApp } from "./app.ts";
import {
  DatabaseIdentityStore,
  hashPassword,
  hashWebSessionToken,
} from "./auth.ts";
import { PasswordChecks } from "./password-checks.ts";
import {
  registerAuthRoutes,
  registerPublicAuthRoutes,
} from "./routes/musterrolle/auth.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const PASSWORD = "an adequately long password";
const NEW_PASSWORD = "a different adequately long password";
const BROWSER = { "X-Requested-With": "werft-web" };

integration("account recovery on PostgreSQL", () => {
  const opened: Array<{ pool: Pool; database: TempDatabase }> = [];
  // Migrating takes about a second; each test copies this migrated database
  // instead, so its own time is spent on what it checks.
  let template: TempDatabase | undefined;

  beforeAll(async () => {
    template = await createTempDatabase({ prefix: "recovery_tpl" });
  }, 30_000);

  afterAll(async () => {
    await template?.drop();
  });

  afterEach(async () => {
    for (const { pool, database } of opened.splice(0)) {
      await pool.end();
      await database.drop();
    }
  });

  async function install() {
    if (template === undefined) throw new Error("no template database");
    const database = await createTempDatabase({
      prefix: "recovery",
      template: template.name,
    });
    const pool = new Pool({ connectionString: database.url, max: 8 });
    opened.push({ pool, database });
    const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });
    const sink = new MemoryLogSink();
    // An operator recovers by running the setup-link command again; a
    // bootstrap without a token uses a link issued just for it.
    const start = () => {
      const identity = new DatabaseIdentityStore(db);
      const logger = new StructuredLogger({ sinks: [sink] });
      const auth = {
        identity,
        passwords: new PasswordChecks(),
        logger,
      };
      const app = createApiApp({
        authMode: "api-key",
        logger,
        identity,
        registerPublicRoutes: (router) =>
          registerPublicAuthRoutes(router, auth),
        registerRoutes: (router) => {
          registerAuthRoutes(router, auth);
          // Only the receipt read is exercised; the session ports are unused.
          registerReceiptRoutes(
            router,
            createSessionService({
              limits: {
                queuedInputLimitPerSession: 1,
                storageLimitBytes: 1,
                sessionCostLimitUsd: 1,
                sessionTokenLimit: null,
              },
              authorization: createAuthorizationPolicy(),
              inputs: createPostgresSessionUnitOfWork(db),
              controls: createPostgresSessionControl(db),
              reader: createPostgresSessionReader(db),
              catalog: { connections: {}, repositories: {} },
            }),
          );
        },
      });
      const json = (path: string, body: unknown, headers: HeadersInit = {}) =>
        app.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      return {
        app,
        json,
        bootstrap: async (email = "Owner@Example.com", setupToken?: string) =>
          json("/v1/auth/bootstrap", {
            setup_token: setupToken ?? (await liveSetupToken(db, email)),
            email,
            password: PASSWORD,
            display_name: "Owner",
            workspace_name: "Acme",
            workspace_slug: "acme",
          }),
        login: async (email: string, password = PASSWORD) =>
          json("/v1/auth/login", { email, password }, BROWSER),
        issue: (cookie: string, workspaceId: string, userId: string) =>
          json(
            `/v1/workspaces/${workspaceId}/members/${userId}/password-reset`,
            { current_password: PASSWORD },
            { Cookie: cookie, ...BROWSER },
          ),
      };
    };
    const first = start();
    const installToken = await liveSetupToken(db);
    const created = await first.bootstrap(undefined, installToken);
    expect(created.status).toBe(201);
    const { user_id: ownerId, workspace } = bootstrapResponseSchema.parse(
      await created.json(),
    );
    const memberId = randomUUID();
    await db.insert(users).values({
      id: memberId,
      email: "member@example.com",
      passwordHash: await hashPassword(PASSWORD),
      displayName: "Member",
    });
    await db.insert(memberships).values({
      workspaceId: workspace.id,
      userId: memberId,
      role: "member",
    });
    return {
      db,
      pool,
      sink,
      start,
      first,
      installToken,
      ownerId,
      memberId,
      workspace,
    };
  }

  const cookieOf = (response: Response) =>
    (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

  test("reset link: old cookie 401, new password logs in, the token works once", async () => {
    const { db, sink, first, ownerId, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    const memberCookie = cookieOf(await first.login("member@example.com"));
    const otherMemberCookie = cookieOf(await first.login("member@example.com"));

    const issued = await first.issue(ownerCookie, workspace.id, memberId);
    expect(issued.status).toBe(201);
    const { token, expires_at } = issuePasswordResetResponseSchema.parse(
      await issued.json(),
    );
    const [stored] = await db.select().from(passwordResets);
    expect(Buffer.from(stored?.tokenHash ?? []).toString("hex")).toBe(
      Buffer.from(hashWebSessionToken(token)).toString("hex"),
    );
    expect(stored?.issuedBy).toBe(ownerId);
    const ttl = (stored?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(new Date(expires_at)).toEqual(stored?.expiresAt ?? new Date(0));

    // Both redemptions race; the row lock lets exactly one through.
    const [a, b] = await Promise.all([
      first.json("/v1/auth/password-reset", { token, password: NEW_PASSWORD }),
      first.json("/v1/auth/password-reset", {
        token,
        password: "a third adequately long password",
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    const winner = a.status === 200 ? a : b;
    const winningPassword =
      a.status === 200 ? NEW_PASSWORD : "a third adequately long password";
    const body = passwordResetResponseSchema.parse(await winner.json());
    expect(body.user_id).toBe(memberId);

    for (const cookie of [memberCookie, otherMemberCookie]) {
      const me = await first.app.request("/v1/auth/me", {
        headers: { Cookie: cookie },
      });
      expect(me.status).toBe(401);
    }
    const liveMember = await db
      .select()
      .from(webSessions)
      .where(eq(webSessions.userId, memberId));
    expect(liveMember.every((row) => row.revokedAt !== null)).toBe(true);
    // Only the user's sessions end; the owner's stays.
    const ownerMe = await first.app.request("/v1/auth/me", {
      headers: { Cookie: ownerCookie },
    });
    expect(ownerMe.status).toBe(200);

    expect((await first.login("member@example.com")).status).toBe(401);
    expect(
      (await first.login("member@example.com", winningPassword)).status,
    ).toBe(200);

    const third = await first.json("/v1/auth/password-reset", {
      token,
      password: "a fourth adequately long password",
    });
    expect(third.status).toBe(401);

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, body.receipt_id));
    expect(receipt).toMatchObject({
      ownerId: workspace.id,
      operation: "reset_password",
      targetRef: { user_id: memberId, workspace_id: workspace.id },
      status: "succeeded",
      result: { issued_by: ownerId, sessions_revoked: 2 },
    });
    const read = await first.app.request(`/v1/receipts/${body.receipt_id}`, {
      headers: { Cookie: ownerCookie },
    });
    expect(read.status).toBe(200);
    expect(receiptSchema.parse(await read.json()).target_ref).toEqual({
      user_id: memberId,
      workspace_id: workspace.id,
    });
    expect(JSON.stringify(sink.records)).not.toContain(token);
  });

  for (const how of ["account", "membership"] as const) {
    test(`owner ${how} disabled: a new setup link restores the owner, ends every session, then works no more`, async () => {
      const { db, start, first, installToken, ownerId, memberId, workspace } =
        await install();
      await first.login("owner@example.com");
      await first.login("member@example.com");

      // A live owner exists: no link is issued.
      const identity = new DatabaseIdentityStore(db);
      expect(await issueSetupToken(identity)).toBeNull();
      expect(await db.$count(setupLinks)).toBe(0);

      if (how === "account") {
        await db
          .update(users)
          .set({ disabledAt: new Date() })
          .where(eq(users.id, ownerId));
      } else {
        await db
          .update(memberships)
          .set({ disabledAt: new Date() })
          .where(eq(memberships.userId, ownerId));
      }

      // The link that made the first owner is spent for good.
      const refused = await start().bootstrap(undefined, installToken);
      expect(refused.status).toBe(401);

      const recovery = start();
      const recoveryToken = await liveSetupToken(db);
      const restored = await recovery.bootstrap(undefined, recoveryToken);
      expect(restored.status).toBe(201);
      const body = bootstrapResponseSchema.parse(await restored.json());
      expect(body.user_id).toBe(ownerId);
      expect(body.workspace.id).toBe(workspace.id);
      expect(await db.$count(schema.workspaces)).toBe(1);
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, ownerId));
      expect(owner?.disabledAt).toBeNull();
      const [membership] = await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, ownerId));
      expect(membership).toMatchObject({ role: "owner", disabledAt: null });
      expect(await db.$count(webSessions, isNull(webSessions.revokedAt))).toBe(
        0,
      );

      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.operation, "recover_owner"));
      expect(receipt).toMatchObject({
        ownerId: workspace.id,
        targetRef: {
          resource: { kind: "workspace", id: workspace.id },
          workspace_id: workspace.id,
        },
        status: "succeeded",
        result: { user_id: ownerId, existing_user: true, sessions_revoked: 2 },
      });
      expect(
        receiptSchema.shape.target_ref.safeParse(receipt?.targetRef).success,
      ).toBe(true);

      // The member was not promoted, and with a live owner again it is done.
      const [member] = await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, memberId));
      expect(member?.role).toBe("member");
      const done = await start().bootstrap(undefined, recoveryToken);
      expect(done.status).toBe(401);
      expect(await issueSetupToken(identity)).toBeNull();
      expect((await recovery.login("owner@example.com")).status).toBe(200);
    });
  }

  test("a login that checked the old password before a reset lands gets no session", async () => {
    const { db, first, ownerId, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    const [before] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, memberId));
    const { token } = issuePasswordResetResponseSchema.parse(
      await (await first.issue(ownerCookie, workspace.id, memberId)).json(),
    );
    expect(
      (
        await first.json("/v1/auth/password-reset", {
          token,
          password: NEW_PASSWORD,
        })
      ).status,
    ).toBe(200);
    // What the in-flight login would do next, with the hash it verified.
    const identity = new DatabaseIdentityStore(db);
    const late = await identity.createWebSession({
      id: randomUUID(),
      userId: memberId,
      verifiedPasswordHash: before?.passwordHash ?? "",
      tokenHash: hashWebSessionToken("aps_late"),
      ttlMs: 60_000,
      userAgent: null,
      maxLive: 10,
    });
    expect(late).toBeNull();
    expect(await db.$count(webSessions, eq(webSessions.userId, memberId))).toBe(
      0,
    );
    expect(ownerId).not.toBe(memberId);
  });

  test("with no live owner, a newer link replaces the older one, and an expired link is refused", async () => {
    const { db, start, ownerId } = await install();
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    const identity = new DatabaseIdentityStore(db);
    const older = await issueSetupToken(identity);
    const newer = await issueSetupToken(identity);
    if (older === null || newer === null) throw new Error("no link issued");
    expect(await db.$count(setupLinks)).toBe(1);
    expect((await start().bootstrap(undefined, older)).status).toBe(401);

    await db.execute(
      sql`UPDATE setup_links SET expires_at = clock_timestamp() - interval '1 second'`,
    );
    const app = start();
    const expired = await app.json("/v1/auth/setup-link/check", {
      setup_token: newer,
    });
    expect(expired.status).toBe(401);
    expect((await app.bootstrap(undefined, newer)).status).toBe(401);
    expect((await start().bootstrap()).status).toBe(201);
  });

  test("racing redemptions of one link make one owner; a racing issue never outlives the owner", async () => {
    const { db, start, ownerId } = await install();
    const disableOwner = () =>
      db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, ownerId));
    const identity = new DatabaseIdentityStore(db);

    await disableOwner();
    const link = await issueSetupToken(identity);
    if (link === null) throw new Error("no link issued");
    const raced = await Promise.all([
      start().bootstrap(undefined, link),
      start().bootstrap(undefined, link),
    ]);
    // The loser sees either the live owner (409) or the spent link (401).
    const [won, lost] = raced.map((r) => r.status).sort();
    expect(won).toBe(201);
    expect([401, 409]).toContain(lost ?? 0);
    expect(await db.$count(setupLinks)).toBe(0);

    await disableOwner();
    const older = await issueSetupToken(identity);
    if (older === null) throw new Error("no link issued");
    const [redeemed, newer] = await Promise.all([
      start().bootstrap(undefined, older),
      issueSetupToken(identity),
    ]);
    if (redeemed.status === 201) {
      // Bootstrap went first: the issue waited for it and saw the live owner.
      expect(await db.$count(setupLinks)).toBe(0);
    } else {
      // The issue went first and replaced the link the bootstrap carried.
      expect(redeemed.status).toBe(401);
      expect(newer).not.toBeNull();
      expect(await db.$count(setupLinks)).toBe(1);
    }
  });

  for (const comeback of ["account", "membership", "promotion"] as const) {
    test(`an owner made live by ${comeback} shuts the open setup link, and losing every owner again keeps it shut`, async () => {
      const { db, start, ownerId, memberId } = await install();
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, ownerId));
      if (comeback === "membership") {
        await db
          .update(memberships)
          .set({ disabledAt: new Date() })
          .where(eq(memberships.userId, ownerId));
        await db
          .update(users)
          .set({ disabledAt: null })
          .where(eq(users.id, ownerId));
      }
      const link = await issueSetupToken(new DatabaseIdentityStore(db));
      if (link === null) throw new Error("no link issued");
      const check = () =>
        start().json("/v1/auth/setup-link/check", { setup_token: link });
      expect((await check()).status).toBe(204);

      if (comeback === "account") {
        await db
          .update(users)
          .set({ disabledAt: null })
          .where(eq(users.id, ownerId));
      } else if (comeback === "membership") {
        await db
          .update(memberships)
          .set({ disabledAt: null })
          .where(eq(memberships.userId, ownerId));
      } else {
        await db
          .update(memberships)
          .set({ role: "owner" })
          .where(eq(memberships.userId, memberId));
      }
      expect((await check()).status).toBe(401);

      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(isNull(users.disabledAt));
      expect((await check()).status).toBe(401);
      expect((await start().bootstrap(undefined, link)).status).toBe(401);
      expect((await start().bootstrap()).status).toBe(201);
    });
  }

  test("an owner restored while an issue is in flight never lets that link reopen recovery", async () => {
    const { db, pool, start, ownerId } = await install();
    const setOwnerDisabled = (disabledAt: Date | null) =>
      db.update(users).set({ disabledAt }).where(eq(users.id, ownerId));
    await setOwnerDisabled(new Date());
    const link = randomBytes(32).toString("base64url");
    // An issue between its owner count and its commit.
    const issue = await pool.connect();
    try {
      await issue.query("BEGIN");
      await issue.query(
        "SELECT pg_advisory_xact_lock(hashtext('auth.bootstrap'))",
      );
      await issue.query(
        "INSERT INTO setup_links (token_hash, expires_at, epoch) VALUES ($1, now() + interval '1 day', (SELECT last_value FROM setup_link_epoch))",
        [Buffer.from(hashWebSessionToken(link))],
      );
      // The owner comes back meanwhile; the issue never sees it.
      await setOwnerDisabled(null);
      await issue.query("COMMIT");
    } finally {
      issue.release();
    }
    const check = () =>
      start().json("/v1/auth/setup-link/check", { setup_token: link });
    expect((await check()).status).toBe(401);

    await setOwnerDisabled(new Date());
    expect((await check()).status).toBe(401);
    expect((await start().bootstrap(undefined, link)).status).toBe(401);
  });

  test("account and membership restored by two overlapping transactions never let the old link reopen recovery", async () => {
    const { db, pool, start, ownerId } = await install();
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, ownerId));
    const link = await issueSetupToken(new DatabaseIdentityStore(db));
    if (link === null) throw new Error("no link issued");

    // Each restore sees the other half still disabled.
    const account = await pool.connect();
    const membership = await pool.connect();
    try {
      await account.query("BEGIN");
      await membership.query("BEGIN");
      await account.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [
        ownerId,
      ]);
      await membership.query(
        "UPDATE memberships SET disabled_at = NULL WHERE user_id = $1",
        [ownerId],
      );
      await account.query("COMMIT");
      await membership.query("COMMIT");
    } finally {
      account.release();
      membership.release();
    }
    const check = () =>
      start().json("/v1/auth/setup-link/check", { setup_token: link });
    expect((await check()).status).toBe(401);

    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    expect((await check()).status).toBe(401);
    expect((await start().bootstrap(undefined, link)).status).toBe(401);
    expect((await start().bootstrap()).status).toBe(201);
  });

  for (const loss of ["disable", "demotion", "deletion"] as const) {
    test(`a link left beside a live owner stays shut once the owner is lost by ${loss}`, async () => {
      const { db, start, ownerId } = await install();
      // Left over from an overlap: issued at the epoch the migration set, while
      // the owner is live, so this loss is the sequence's first advance.
      const link = randomBytes(32).toString("base64url");
      await db.execute(
        sql`INSERT INTO setup_links (token_hash, expires_at, epoch) VALUES (${Buffer.from(hashWebSessionToken(link))}, now() + interval '1 day', (SELECT last_value FROM setup_link_epoch))`,
      );
      const check = () =>
        start().json("/v1/auth/setup-link/check", { setup_token: link });
      expect((await check()).status).toBe(401);

      if (loss === "disable") {
        await db
          .update(users)
          .set({ disabledAt: new Date() })
          .where(eq(users.id, ownerId));
      } else if (loss === "demotion") {
        await db
          .update(memberships)
          .set({ role: "member" })
          .where(eq(memberships.userId, ownerId));
      } else {
        await db.delete(memberships).where(eq(memberships.userId, ownerId));
      }
      expect((await check()).status).toBe(401);
      expect((await start().bootstrap(undefined, link)).status).toBe(401);
      expect((await start().bootstrap()).status).toBe(201);
    });
  }

  test("recovery waits for a member login in flight and revokes its session too", async () => {
    const { db, pool, start, ownerId, memberId } = await install();
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    // A login between its user-row lock and its commit.
    const login = await pool.connect();
    try {
      await login.query("BEGIN");
      await login.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        memberId,
      ]);
      const sessionId = randomUUID();
      await login.query(
        `INSERT INTO web_sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [sessionId, memberId, Buffer.from(hashWebSessionToken("aps_inflight"))],
      );
      const recovery = start().bootstrap();
      await Bun.sleep(300);
      await login.query("COMMIT");
      expect((await recovery).status).toBe(201);
      const [row] = await db
        .select({ revokedAt: webSessions.revokedAt })
        .from(webSessions)
        .where(eq(webSessions.id, sessionId));
      expect(row?.revokedAt).not.toBeNull();
    } finally {
      login.release();
    }
  });

  test("recovery and a reset issue already in flight do not deadlock", async () => {
    const { db, pool, start, ownerId, memberId, workspace } = await install();
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    // issuePasswordReset by the old owner, between its issuer and target
    // locks and the insert of the link.
    const issue = await pool.connect();
    try {
      await issue.query("BEGIN");
      await issue.query(
        "SELECT 1 FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [[ownerId, memberId]],
      );
      const recovery = start().bootstrap();
      await Bun.sleep(300);
      await issue.query(
        `INSERT INTO password_resets
           (id, workspace_id, user_id, token_hash, issued_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [
          randomUUID(),
          workspace.id,
          memberId,
          Buffer.from(hashWebSessionToken("apr_inflight")),
          ownerId,
        ],
      );
      await issue.query("COMMIT");
      expect((await recovery).status).toBe(201);
      // Issued before recovery took the links, so recovery revoked it.
      const [link] = await db.select().from(passwordResets);
      expect(link?.revokedAt).not.toBeNull();
    } finally {
      issue.release();
    }
  });

  test("recovery restoring a user an in-flight issue is about to lock does not deadlock", async () => {
    const { db, pool, start, ownerId, workspace } = await install();
    // Sorts after the issuer, so an issue locks the issuer first and this
    // user second.
    const lateId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    await db.insert(users).values({
      id: lateId,
      email: "late@example.com",
      passwordHash: await hashPassword(PASSWORD),
      displayName: "Late",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: workspace.id, userId: lateId, role: "member" });
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, ownerId));
    const issue = await pool.connect();
    try {
      await issue.query("BEGIN");
      await issue.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        ownerId,
      ]);
      const recovery = start().bootstrap("late@example.com");
      await Bun.sleep(300);
      await issue.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        lateId,
      ]);
      await issue.query("COMMIT");
      expect((await recovery).status).toBe(201);
    } finally {
      issue.release();
    }
  });

  test("recovery revokes a reset link issued before it", async () => {
    const { db, start, first, ownerId, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    const issued = await first.issue(ownerCookie, workspace.id, memberId);
    const { token } = issuePasswordResetResponseSchema.parse(
      await issued.json(),
    );
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    const recovery = start();
    expect((await recovery.bootstrap()).status).toBe(201);
    const stale = await recovery.json("/v1/auth/password-reset", {
      token,
      password: NEW_PASSWORD,
    });
    expect(stale.status).toBe(401);
    expect((await recovery.login("member@example.com")).status).toBe(200);
  });

  test("issuing a link while the user's open one is redeemed never deadlocks", async () => {
    const { first, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    const issue = () => first.issue(ownerCookie, workspace.id, memberId);
    for (let round = 0; round < 4; round += 1) {
      const { token } = issuePasswordResetResponseSchema.parse(
        await (await issue()).json(),
      );
      const [issued, redeemed] = await Promise.all([
        issue(),
        first.json("/v1/auth/password-reset", {
          token,
          password: NEW_PASSWORD,
        }),
      ]);
      expect(issued.status).toBe(201);
      // Either order is fine; a 500 from an aborted transaction is not.
      expect([200, 401]).toContain(redeemed.status);
    }
  });

  test("recovery with a new email adds a second owner to the existing workspace", async () => {
    const { db, start, ownerId, workspace } = await install();
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    const recovery = start();
    const restored = await recovery.bootstrap("rescuer@example.com");
    expect(restored.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await restored.json());
    expect(body.user_id).not.toBe(ownerId);
    expect(body.workspace.id).toBe(workspace.id);
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, body.user_id));
    expect(membership).toMatchObject({
      workspaceId: workspace.id,
      role: "owner",
    });
    // The disabled owner stays disabled; recovery does not resurrect it.
    const [old] = await db.select().from(users).where(eq(users.id, ownerId));
    expect(old?.disabledAt).not.toBeNull();
  });

  test("issuing needs the issuer's password, never targets the issuer, and is recorded", async () => {
    const { db, first, ownerId, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    const path = `/v1/workspaces/${workspace.id}/members/${memberId}/password-reset`;
    const headers = { Cookie: ownerCookie, ...BROWSER };
    expect((await first.json(path, {}, headers)).status).toBe(400);
    expect(
      (await first.json(path, { current_password: NEW_PASSWORD }, headers))
        .status,
    ).toBe(403);
    expect((await first.issue(ownerCookie, workspace.id, ownerId)).status).toBe(
      403,
    );
    expect(await db.$count(passwordResets)).toBe(0);

    await db
      .update(memberships)
      .set({ role: "owner" })
      .where(eq(memberships.userId, memberId));
    expect(
      (await first.issue(ownerCookie, workspace.id, memberId)).status,
    ).toBe(201);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "issue_password_reset"));
    expect(receipt).toMatchObject({
      ownerId: workspace.id,
      targetRef: { user_id: memberId, workspace_id: workspace.id },
      status: "succeeded",
      result: { target_role: "owner" },
      actor: {
        principal: { kind: "user", id: ownerId },
        actor_user_id: ownerId,
        agent_id: null,
      },
    });
  });

  test("a member who owns another workspace cannot be reset from this one", async () => {
    const { db, first, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    const elsewhere = randomUUID();
    await db
      .insert(schema.workspaces)
      .values({ id: elsewhere, slug: "elsewhere", name: "Elsewhere" });
    await db
      .insert(memberships)
      .values({ workspaceId: elsewhere, userId: memberId, role: "owner" });
    expect(
      (await first.issue(ownerCookie, workspace.id, memberId)).status,
    ).toBe(403);
    expect(await db.$count(passwordResets)).toBe(0);
  });

  test("failed redemptions never lock out a valid link; a disabled membership kills it", async () => {
    const { db, first, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    for (let i = 0; i < 10; i += 1) {
      const wrong = await first.json("/v1/auth/password-reset", {
        token: `apr_guess-${i}`,
        password: NEW_PASSWORD,
      });
      expect(wrong.status).toBe(401);
    }
    const issue = async () =>
      issuePasswordResetResponseSchema.parse(
        await (await first.issue(ownerCookie, workspace.id, memberId)).json(),
      ).token;
    const valid = await first.json("/v1/auth/password-reset", {
      token: await issue(),
      password: NEW_PASSWORD,
    });
    expect(valid.status).toBe(200);

    const token = await issue();
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, memberId));
    const dead = await first.json("/v1/auth/password-reset", {
      token,
      password: PASSWORD,
    });
    expect(dead.status).toBe(401);
  });
});
