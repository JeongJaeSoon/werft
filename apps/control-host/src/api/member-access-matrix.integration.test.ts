import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  createPostgresInviteStore,
  createPostgresMemberStore,
  memberships,
  users,
  workspaces,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
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
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const LOGIN_SECRET = "matrix-login-secret-94s800";

type Role = "owner" | "admin" | "member";
type Target = Role | "self" | "last live owner";
type Expected = { status: 200 } | { status: 403 | 409; code: string };

const OK: Expected = { status: 200 };
const OWNER_PROTECTED: Expected = { status: 403, code: "OWNER_PROTECTED" };
const FORBIDDEN: Expected = { status: 403, code: "FORBIDDEN" };
const SELF_PROTECTED: Expected = { status: 403, code: "SELF_PROTECTED" };

// A live owner as the caller leaves at least one live owner besides any
// other target, so for an owner the last live owner is always themselves.
const MATRIX: Record<Role, Record<Target, Expected>> = {
  owner: {
    owner: OK,
    admin: OK,
    member: OK,
    self: SELF_PROTECTED,
    "last live owner": SELF_PROTECTED,
  },
  admin: {
    owner: OWNER_PROTECTED,
    admin: OK,
    member: OK,
    self: SELF_PROTECTED,
    "last live owner": OWNER_PROTECTED,
  },
  member: {
    owner: FORBIDDEN,
    admin: FORBIDDEN,
    member: FORBIDDEN,
    self: FORBIDDEN,
    "last live owner": FORBIDDEN,
  },
};

const ROUTES = {
  disable_member: "members",
  disable_user: "users",
} as const;

integration("who may disable a member or suspend an account", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let passwordHash = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "member_access_matrix" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(crypto.randomUUID()),
      lockout: new LoginLockout(),
      logger,
    };
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      decisions: createPostgresDecisionLog(db),
    });
    app = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerMemberRoutes(
          router,
          createMemberService({
            authorization,
            store: createPostgresMemberStore(db),
          }),
          createInviteService({
            authorization,
            store: createPostgresInviteStore(db),
          }),
        );
      },
    });
    passwordHash = await Bun.password.hash(LOGIN_SECRET, {
      algorithm: "argon2id",
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function login(email: string) {
    return app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "werft-web",
      },
      body: JSON.stringify({ email, password: LOGIN_SECRET }),
    });
  }

  async function cookieOf(email: string) {
    const response = await login(email);
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  /** A workspace of its own, so each cell starts from the same state. */
  async function workspaceWith(people: { role: Role; disabled?: boolean }[]) {
    const workspaceId = crypto.randomUUID();
    const tag = workspaceId.slice(0, 8);
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `w-${tag}`, name: tag });
    const created: { id: string; email: string; role: Role }[] = [];
    for (const [index, person] of people.entries()) {
      const id = crypto.randomUUID();
      const email = `${person.role}-${index}-${tag}@example.com`;
      await db
        .insert(users)
        .values({ id, email, passwordHash, displayName: email });
      await db.insert(memberships).values({
        workspaceId,
        userId: id,
        role: person.role,
        disabledAt: person.disabled ? sql`clock_timestamp()` : null,
      });
      created.push({ id, email, role: person.role });
    }
    return { workspaceId, people: created };
  }

  async function accessOf(workspaceId: string, userId: string) {
    const [row] = await db
      .select({
        membership: memberships.disabledAt,
        account: users.disabledAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userId),
        ),
      );
    if (!row) throw new Error("membership vanished");
    return row;
  }

  async function setAccess(
    operation: keyof typeof ROUTES,
    action: "disable" | "enable",
    userId: string,
    cookie: string,
  ) {
    const response = await app.request(
      `/v1/${ROUTES[operation]}/${userId}/${action}`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    const body = (await response.json()) as { error?: { code: string } };
    return { status: response.status, code: body.error?.code };
  }

  for (const operation of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
    for (const caller of Object.keys(MATRIX) as Role[]) {
      for (const target of Object.keys(MATRIX[caller]) as Target[]) {
        const expected = MATRIX[caller][target];
        const verdict =
          expected.status === 200
            ? "200"
            : `${expected.status} ${expected.code}`;
        test(`${operation}: ${caller} → ${target} answers ${verdict}`, async () => {
          // The last live owner's workspace keeps a second, disabled owner:
          // only live owners count.
          const lastOwner = target === "last live owner";
          const { workspaceId, people } = await workspaceWith(
            lastOwner
              ? [
                  { role: "owner" },
                  { role: "owner", disabled: true },
                  ...(caller === "owner" ? [] : [{ role: caller }]),
                ]
              : [
                  { role: caller },
                  { role: "owner" },
                  { role: "admin" },
                  {
                    role: "member",
                  },
                ],
          );
          const actor = lastOwner
            ? (people.find((person) => person.role === caller) ?? people[0])
            : people[0];
          const subject =
            target === "self"
              ? actor
              : lastOwner
                ? people[0]
                : people.find(
                    (person, index) => index > 0 && person.role === target,
                  );
          if (!actor || !subject) throw new Error("no such person");
          const cookie = await cookieOf(actor.email);

          const answer = await setAccess(
            operation,
            "disable",
            subject.id,
            cookie,
          );
          expect(answer).toEqual(
            expected.status === 200
              ? { status: 200, code: undefined }
              : { status: expected.status, code: expected.code },
          );

          const after = await accessOf(workspaceId, subject.id);
          const changed =
            operation === "disable_member" ? after.membership : after.account;
          if (expected.status === 200) {
            expect(changed).not.toBeNull();
            expect((await login(subject.email)).status).toBe(401);
          } else {
            expect(after).toEqual({ membership: null, account: null });
            expect((await login(subject.email)).status).toBe(200);
          }
        });
      }
    }
  }

  test("an admin cannot enable a disabled owner either", async () => {
    const { workspaceId, people } = await workspaceWith([
      { role: "admin" },
      { role: "owner" },
      { role: "owner", disabled: true },
    ]);
    const [admin, , disabled] = people;
    if (!admin || !disabled) throw new Error("no such person");
    const cookie = await cookieOf(admin.email);
    expect(
      await setAccess("disable_member", "enable", disabled.id, cookie),
    ).toEqual(OWNER_PROTECTED);
    expect(
      (await accessOf(workspaceId, disabled.id)).membership,
    ).not.toBeNull();
  });

  test("an admin cannot suspend or lift the account of an owner whose membership is disabled", async () => {
    const { workspaceId, people } = await workspaceWith([
      { role: "admin" },
      { role: "owner" },
      { role: "owner", disabled: true },
    ]);
    const [admin, , disabled] = people;
    if (!admin || !disabled) throw new Error("no such person");
    const cookie = await cookieOf(admin.email);
    expect(
      await setAccess("disable_user", "disable", disabled.id, cookie),
    ).toEqual(OWNER_PROTECTED);
    expect((await accessOf(workspaceId, disabled.id)).account).toBeNull();

    await db
      .update(users)
      .set({ disabledAt: sql`clock_timestamp()` })
      .where(eq(users.id, disabled.id));
    expect(
      await setAccess("disable_user", "enable", disabled.id, cookie),
    ).toEqual(OWNER_PROTECTED);
    expect((await accessOf(workspaceId, disabled.id)).account).not.toBeNull();
  });

  test("an account that is a disabled owner in a workspace the caller is not in cannot be suspended or lifted, by an owner or an admin", async () => {
    for (const role of ["owner", "admin"] as const) {
      const first = await workspaceWith([
        { role: "owner" },
        { role: "admin" },
        { role: "member" },
      ]);
      const second = await workspaceWith([{ role: "owner" }]);
      const caller = first.people.find((person) => person.role === role);
      const target = first.people.find((person) => person.role === "member");
      if (!caller || !target) throw new Error("no such person");
      await db.insert(memberships).values({
        workspaceId: second.workspaceId,
        userId: target.id,
        role: "owner",
        disabledAt: sql`clock_timestamp()`,
      });
      const cookie = await cookieOf(caller.email);
      expect(
        await setAccess("disable_user", "disable", target.id, cookie),
      ).toEqual(OWNER_PROTECTED);
      expect((await accessOf(first.workspaceId, target.id)).account).toBeNull();

      await db
        .update(users)
        .set({ disabledAt: sql`clock_timestamp()` })
        .where(eq(users.id, target.id));
      expect(
        await setAccess("disable_user", "enable", target.id, cookie),
      ).toEqual(OWNER_PROTECTED);
      expect(
        (await accessOf(first.workspaceId, target.id)).account,
      ).not.toBeNull();
    }
  });

  test("an account owned in a workspace where the caller is only an admin answers OWNER_PROTECTED, before the elsewhere check", async () => {
    const first = await workspaceWith([{ role: "owner" }, { role: "member" }]);
    const second = await workspaceWith([{ role: "owner" }]);
    // The caller is in neither of these, so the account is also elsewhere.
    const third = await workspaceWith([{ role: "owner" }]);
    const [owner, target] = first.people;
    if (!owner || !target) throw new Error("no such person");
    await db.insert(memberships).values([
      { workspaceId: second.workspaceId, userId: owner.id, role: "admin" },
      { workspaceId: second.workspaceId, userId: target.id, role: "owner" },
      { workspaceId: third.workspaceId, userId: target.id, role: "member" },
    ]);
    const cookie = await cookieOf(owner.email);
    expect(
      await setAccess("disable_user", "disable", target.id, cookie),
    ).toEqual(OWNER_PROTECTED);
    expect((await accessOf(first.workspaceId, target.id)).account).toBeNull();
  });
});
