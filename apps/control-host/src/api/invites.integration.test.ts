import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acceptInviteResponseSchema,
  authMeResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createInviteResponseSchema,
  listInvitesResponseSchema,
  listMembersResponseSchema,
  receiptActorSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresInviteStore,
  createPostgresMemberStore,
  invites,
  memberships,
  receipts,
  users,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  createAuthorizationPolicy,
  createInviteService,
  createMemberService,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  hashWebSessionToken,
  LoginLockout,
  WorkGate,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import {
  registerInviteRoutes,
  registerPublicInviteRoutes,
} from "./routes/musterrolle/invites.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const browser = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

integration("invites and roles over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "invites_api" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const lockout = new LoginLockout();
    // Wide enough that the race tests below are not shed.
    const passwordWork = new WorkGate(8, 8);
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout,
      passwordWork,
    };
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    });
    const inviteStore = createPostgresInviteStore(db);
    const inviteService = createInviteService({
      authorization,
      store: inviteStore,
    });
    app = createApiApp({
      authMode: "api-key",
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      registerPublicRoutes: (router) => {
        registerPublicAuthRoutes(router, auth);
        registerPublicInviteRoutes(router, {
          invites: inviteStore,
          identity,
          lockout,
          passwordWork,
        });
      },
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerInviteRoutes(router, inviteService);
        registerMemberRoutes(
          router,
          createMemberService({
            authorization,
            store: createPostgresMemberStore(db),
          }),
          inviteService,
        );
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const send = (
    method: string,
    path: string,
    body: unknown,
    headers: HeadersInit = {},
  ) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cookieOf = (response: Response) =>
    (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const as = (cookie: string) => ({ Cookie: cookie, ...browser });

  async function login(email: string, password = PASSWORD) {
    const response = await send(
      "POST",
      "/v1/auth/login",
      { email, password },
      browser,
    );
    expect(response.status).toBe(200);
    return cookieOf(response);
  }

  async function invite(cookie: string, email: string, role = "member") {
    const response = await send(
      "POST",
      "/v1/invites",
      { email, role },
      as(cookie),
    );
    expect(response.status).toBe(201);
    return createInviteResponseSchema.parse(await response.json());
  }

  const accept = (token: string, password = PASSWORD, name?: string) =>
    send(
      "POST",
      "/v1/invites/accept",
      { token, password, ...(name ? { display_name: name } : {}) },
      browser,
    );

  async function receiptsOf(operation: string) {
    return db.select().from(receipts).where(eq(receipts.operation, operation));
  }

  async function liveOwners() {
    const rows = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.role, "owner"),
        ),
      );
    return rows.length;
  }

  let workspaceId = "";
  let ownerId = "";
  let ownerCookie = "";

  test("setup: an owner and their cookie", async () => {
    const boot = await send("POST", "/v1/auth/bootstrap", {
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
  });

  let memberId = "";
  let memberCookie = "";

  test("an invite's token is shown once and stored only as its hash", async () => {
    const issued = await invite(ownerCookie, "New.Person@Example.com");
    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, issued.invite_id));
    expect(row?.email).toBe("new.person@example.com");
    expect(
      Buffer.from(row?.tokenHash ?? []).equals(
        Buffer.from(hashWebSessionToken(issued.invite_token)),
      ),
    ).toBe(true);
    const [plain] = await db
      .execute<{ hits: string }>(
        sql`SELECT count(*)::text AS hits FROM invites WHERE row_to_json(invites)::text LIKE ${`%${issued.invite_token.slice(4)}%`}`,
      )
      .then((result) => result.rows);
    expect(plain?.hits).toBe("0");
    // Seven days, on the database clock.
    const days =
      (new Date(issued.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);

    const listed = await send("GET", "/v1/invites", undefined, as(ownerCookie));
    const raw = await listed.text();
    expect(raw).not.toContain(issued.invite_token);
    expect(
      listInvitesResponseSchema
        .parse(JSON.parse(raw))
        .items.find((item) => item.id === issued.invite_id)?.status,
    ).toBe("pending");

    const [receipt] = await receiptsOf("invite_member");
    expect(receiptActorSchema.parse(receipt?.actor)).toEqual({
      principal: { kind: "user", id: ownerId },
      actor_user_id: ownerId,
      agent_id: null,
    });
  });

  test("re-inviting revokes the earlier token; the new one makes an account and logs it in", async () => {
    const first = await invite(ownerCookie, "member@example.com");
    const second = await invite(ownerCookie, "member@example.com");
    const stale = await accept(first.invite_token);
    expect(stale.status).toBe(410);
    expect((await stale.json()).error.code).toBe("INVITE_EXPIRED");

    const accepted = await accept(second.invite_token, PASSWORD, "Member");
    expect(accepted.status).toBe(200);
    memberCookie = cookieOf(accepted);
    expect(memberCookie).toStartWith("__Host-werft_session=");
    const body = acceptInviteResponseSchema.parse(await accepted.json());
    expect(body).toMatchObject({
      role: "member",
      workspace: { id: workspaceId },
    });
    memberId = body.user_id;

    const me = await send("GET", "/v1/auth/me", undefined, as(memberCookie));
    expect(me.status).toBe(200);
    expect(authMeResponseSchema.parse(await me.json()).user).toMatchObject({
      id: memberId,
      display_name: "Member",
    });
    // The same person can log in on their own afterwards.
    await login("member@example.com");

    const again = await accept(second.invite_token);
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("INVITE_USED");

    const [receipt] = await receiptsOf("accept_invite");
    expect(receipt?.ownerId).toBe(workspaceId);
    expect(receipt?.actor).toEqual({
      principal: { kind: "user", id: memberId },
      actor_user_id: memberId,
      agent_id: null,
    });
    const statuses = listInvitesResponseSchema
      .parse(
        await (
          await send("GET", "/v1/invites", undefined, as(ownerCookie))
        ).json(),
      )
      .items.filter((item) => item.email === "member@example.com")
      .map((item) => item.status);
    expect(statuses).toEqual(["accepted", "revoked"]);
  });

  test("a revoked or expired invite answers 410", async () => {
    const revoked = await invite(ownerCookie, "revoked@example.com");
    const deleted = await send(
      "DELETE",
      `/v1/invites/${revoked.invite_id}`,
      undefined,
      as(ownerCookie),
    );
    expect(deleted.status).toBe(204);
    expect((await accept(revoked.invite_token)).status).toBe(410);
    const [receipt] = await receiptsOf("revoke_invite");
    expect(receipt?.actor).toMatchObject({ actor_user_id: ownerId });

    const expired = await invite(ownerCookie, "expired@example.com");
    await db
      .update(invites)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(invites.id, expired.invite_id));
    expect((await accept(expired.invite_token)).status).toBe(410);
    const listed = listInvitesResponseSchema.parse(
      await (
        await send("GET", "/v1/invites", undefined, as(ownerCookie))
      ).json(),
    );
    expect(
      listed.items.find((item) => item.id === expired.invite_id)?.status,
    ).toBe("expired");
    // An accepted invite cannot be revoked afterwards.
    const used = listed.items.find((item) => item.status === "accepted");
    const late = await send(
      "DELETE",
      `/v1/invites/${used?.id}`,
      undefined,
      as(ownerCookie),
    );
    expect(late.status).toBe(409);
  });

  test("an existing account joins with its own password, which is not overwritten", async () => {
    const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
    const [existing] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email: "returning@example.com",
        passwordHash: hash,
        displayName: "Returning",
      })
      .returning({ id: users.id });
    const issued = await invite(ownerCookie, "returning@example.com");
    const wrong = await accept(
      issued.invite_token,
      "a different long password",
    );
    expect(wrong.status).toBe(401);
    const joined = await accept(issued.invite_token, PASSWORD, "Renamed");
    expect(joined.status).toBe(200);
    expect(acceptInviteResponseSchema.parse(await joined.json()).user_id).toBe(
      existing?.id ?? "",
    );
    const [after] = await db
      .select()
      .from(users)
      .where(eq(users.email, "returning@example.com"));
    expect(after?.passwordHash).toBe(hash);
    expect(after?.displayName).toBe("Returning");

    // Offboarded: still listed, with when it ended.
    await db
      .update(memberships)
      .set({ disabledAt: sql`clock_timestamp()` })
      .where(eq(memberships.userId, existing?.id ?? ""));
    const listed = listMembersResponseSchema.parse(
      await (
        await send("GET", "/v1/members", undefined, as(ownerCookie))
      ).json(),
    );
    const gone = listed.items.find((item) => item.user_id === existing?.id);
    expect(Date.parse(gone?.disabled_at ?? "")).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  test("a member is refused every management route", async () => {
    const headers = as(memberCookie);
    const refused = await Promise.all([
      send(
        "POST",
        "/v1/invites",
        { email: "x@example.com", role: "member" },
        headers,
      ),
      send("GET", "/v1/invites", undefined, headers),
      send("GET", "/v1/members", undefined, headers),
      send("PATCH", `/v1/members/${memberId}`, { role: "owner" }, headers),
      send("DELETE", `/v1/invites/${crypto.randomUUID()}`, undefined, headers),
    ]);
    expect(refused.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403,
    ]);
  });

  test("an agent admin still may not list members; owners see what each administers", async () => {
    const agentId = crypto.randomUUID();
    await db.insert(schema.agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `listed-${agentId.slice(0, 8)}`,
      name: "Listed agent",
    });
    await db
      .insert(schema.agentAdmins)
      .values({ workspaceId, agentId, userId: memberId });
    const refused = await send(
      "GET",
      "/v1/members",
      undefined,
      as(memberCookie),
    );
    expect(refused.status).toBe(403);

    const listed = listMembersResponseSchema.parse(
      await (
        await send("GET", "/v1/members", undefined, as(ownerCookie))
      ).json(),
    );
    const member = listed.items.find((item) => item.user_id === memberId);
    expect(member?.administered_agents).toEqual([
      { id: agentId, name: "Listed agent", via: "user" },
    ]);
    // Both signed in above, so both have a web session touch.
    expect(Date.parse(member?.last_active_at ?? "")).toBeGreaterThan(
      Date.now() - 10 * 60_000,
    );
    const owner = listed.items.find((item) => item.user_id === ownerId);
    expect(owner?.last_active_at).not.toBeNull();
  });

  test("members page by cursor and filter by q", async () => {
    const extra = Array.from({ length: 5 }, () => crypto.randomUUID());
    await db.insert(users).values(
      extra.map((id, index) => ({
        id,
        email: `paged-${index}@example.com`,
        passwordHash: null,
        displayName: index === 0 ? "50%_off Pager" : `Pager ${index}`,
      })),
    );
    await db
      .insert(memberships)
      .values(extra.map((userId) => ({ workspaceId, userId, role: "member" })));
    const get = async (search: string) =>
      send("GET", `/v1/members${search}`, undefined, as(ownerCookie));

    const all = listMembersResponseSchema.parse(await (await get("")).json());
    expect(all.next_cursor).toBeNull();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const page = listMembersResponseSchema.parse(
        await (await get(query)).json(),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.user_id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((item) => item.user_id));
    expect(seen.length).toBeGreaterThan(5);

    const pager = listMembersResponseSchema.parse(
      await (await get("?q=%20PAGER%20")).json(),
    );
    expect(pager.items.map((item) => item.user_id).sort()).toEqual(
      [...extra].sort(),
    );
    const literal = listMembersResponseSchema.parse(
      await (await get("?q=%25_")).json(),
    );
    expect(literal.items.map((item) => item.user_id)).toEqual(
      extra.slice(0, 1),
    );

    const refused = await Promise.all([
      get("?q="),
      get(`?q=${"a".repeat(201)}`),
      get("?cursor=not-a-cursor"),
      get("?limit=101"),
    ]);
    expect(refused.map((response) => response.status)).toEqual([
      400, 400, 400, 400,
    ]);
  });

  test("roles change, and nobody changes their own", async () => {
    const listed = listMembersResponseSchema.parse(
      await (
        await send("GET", "/v1/members", undefined, as(ownerCookie))
      ).json(),
    );
    expect(listed.items.map((item) => item.email)).toContain(
      "member@example.com",
    );

    const promoted = await send(
      "PATCH",
      `/v1/members/${memberId}`,
      { role: "owner" },
      as(ownerCookie),
    );
    expect(promoted.status).toBe(200);
    expect((await promoted.json()).role).toBe("owner");
    const [receipt] = await receiptsOf("change_member_role");
    expect(receipt?.actor).toMatchObject({ actor_user_id: ownerId });
    expect(receipt?.result).toEqual({ from: "member", to: "owner" });

    // Ownership handed over: the new owner demotes the old one.
    const demoted = await send(
      "PATCH",
      `/v1/members/${ownerId}`,
      { role: "member" },
      as(memberCookie),
    );
    expect(demoted.status).toBe(200);

    const last = await send(
      "PATCH",
      `/v1/members/${memberId}`,
      { role: "member" },
      as(memberCookie),
    );
    expect(last.status).toBe(403);
    expect((await last.json()).error.code).toBe("SELF_PROTECTED");
    expect(await liveOwners()).toBe(1);

    // The demoted owner lost the right at once, with their session intact.
    const after = await send("GET", "/v1/members", undefined, as(ownerCookie));
    expect(after.status).toBe(403);
    const restored = await send(
      "PATCH",
      `/v1/members/${ownerId}`,
      { role: "owner" },
      as(memberCookie),
    );
    expect(restored.status).toBe(200);
  });

  describe("races: an invite is spent once, a workspace keeps an owner", () => {
    test("two tabs accepting one token: one wins, one conflicts", async () => {
      const issued = await invite(ownerCookie, "twotabs@example.com");
      const results = await Promise.all([
        accept(issued.invite_token),
        accept(issued.invite_token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.email, "twotabs@example.com"));
      expect(rows.length).toBe(1);
    });

    test("revoke racing accept: exactly one of them takes effect", async () => {
      const issued = await invite(ownerCookie, "revokerace@example.com");
      const [revoked, accepted] = await Promise.all([
        send(
          "DELETE",
          `/v1/invites/${issued.invite_id}`,
          undefined,
          as(ownerCookie),
        ),
        accept(issued.invite_token),
      ]);
      expect([revoked.status, accepted.status].sort().join(",")).toBeOneOf([
        "204,410",
        "200,409",
      ]);
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.id, issued.invite_id));
      expect((row?.acceptedAt === null) !== (row?.revokedAt === null)).toBe(
        true,
      );
    });

    test("re-issue racing the old link: the old link never joins after the new one exists", async () => {
      const old = await invite(ownerCookie, "reissue@example.com");
      const [reissued, accepted] = await Promise.all([
        send(
          "POST",
          "/v1/invites",
          { email: "reissue@example.com", role: "member" },
          as(ownerCookie),
        ),
        accept(old.invite_token),
      ]);
      // Either the old link joined first (and the address is now a member),
      // or the re-issue revoked it first.
      expect([reissued.status, accepted.status].sort().join(",")).toBeOneOf([
        "200,400",
        "201,410",
      ]);
      const live = await db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.email, "reissue@example.com"),
            sql`${invites.acceptedAt} IS NULL AND ${invites.revokedAt} IS NULL`,
          ),
        );
      expect(live.length).toBe(accepted.status === 200 ? 0 : 1);
    });

    test("an account created for the address mid-accept is not a server error", async () => {
      const issued = await invite(ownerCookie, "late@example.com");
      const other = await pool.connect();
      try {
        await other.query("BEGIN");
        await other.query(
          "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'late@example.com', 'x', 'Late')",
          [crypto.randomUUID()],
        );
        // The accept peeks no account, then waits on the uncommitted row.
        const pending = accept(issued.invite_token);
        await Bun.sleep(300);
        await other.query("COMMIT");
        const response = await pending;
        expect(response.status).toBe(401);
      } finally {
        other.release();
      }
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.id, issued.invite_id));
      expect(row?.acceptedAt).toBeNull();
    });

    test("two owners demoting each other or themselves: an owner remains", async () => {
      const issued = await invite(ownerCookie, "co-owner@example.com", "owner");
      const joined = await accept(issued.invite_token);
      expect(joined.status).toBe(200);
      const coOwnerCookie = cookieOf(joined);
      const coOwnerId = acceptInviteResponseSchema.parse(
        await joined.json(),
      ).user_id;
      // Down to exactly two owners first.
      await db
        .update(memberships)
        .set({ role: "member" })
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            sql`${memberships.userId} NOT IN (${ownerId}, ${coOwnerId})`,
          ),
        );
      expect(await liveOwners()).toBe(2);
      const results = await Promise.all([
        send(
          "PATCH",
          `/v1/members/${coOwnerId}`,
          { role: "member" },
          as(ownerCookie),
        ),
        send(
          "PATCH",
          `/v1/members/${ownerId}`,
          { role: "member" },
          as(coOwnerCookie),
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
      expect(await liveOwners()).toBe(1);

      // Stepping down yourself is refused outright, so both stay.
      await db
        .update(memberships)
        .set({ role: "owner" })
        .where(sql`${memberships.userId} IN (${ownerId}, ${coOwnerId})`);
      const stepDowns = await Promise.all([
        send(
          "PATCH",
          `/v1/members/${coOwnerId}`,
          { role: "member" },
          as(coOwnerCookie),
        ),
        send(
          "PATCH",
          `/v1/members/${ownerId}`,
          { role: "member" },
          as(ownerCookie),
        ),
      ]);
      for (const response of stepDowns) {
        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe("SELF_PROTECTED");
      }
      expect(await liveOwners()).toBe(2);
    });
  });
});
