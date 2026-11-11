import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listMembersResponseSchema,
  type MemberRow,
  type MemberVerdict,
  type WorkspaceRole,
} from "@werft-ai/contracts";
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
import { registerInviteRoutes } from "./routes/musterrolle/invites.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const PASSWORD = "verdicts-password-1";
const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];
const STATES = {
  live: { membership: false, account: false },
  "membership off": { membership: true, account: false },
  "account off": { membership: false, account: true },
  "both off": { membership: true, account: true },
} as const;
type State = keyof typeof STATES;

type Action =
  | { kind: "change_role"; role: WorkspaceRole }
  | { kind: "disable" }
  | { kind: "enable" };
const ACTIONS: Action[] = [
  ...ROLES.map((role) => ({ kind: "change_role", role }) as const),
  { kind: "disable" },
  { kind: "enable" },
];

function verdictOf(row: MemberRow, action: Action): MemberVerdict {
  return action.kind === "change_role"
    ? row.actions.change_role[action.role]
    : row.actions[action.kind];
}

// Policy combinations live in policy-members.test.ts. These representatives
// pin the real list/write wiring, pagination, error mapping and stored state.
integration("the member list offers what the writes accept", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let passwordHash = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "member_verdicts" });
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
        const invites = createInviteService({
          authorization,
          store: createPostgresInviteStore(db),
        });
        registerMemberRoutes(
          router,
          createMemberService({
            authorization,
            store: createPostgresMemberStore(db),
          }),
          invites,
        );
        registerInviteRoutes(router, invites);
      },
    });
    passwordHash = await Bun.password.hash(PASSWORD, {
      algorithm: "argon2id",
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  /**
   * The actor, a second live owner (so an owner target is never the last
   * one by count), filler rows that push the target off the first page, and
   * the target, oldest first.
   */
  async function workspaceWith(
    actorRole: WorkspaceRole,
    target: { role: WorkspaceRole; state: State } | "self",
  ) {
    const workspaceId = crypto.randomUUID();
    const tag = workspaceId.slice(0, 8);
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `v-${tag}`, name: tag });
    const add = async (
      role: WorkspaceRole,
      index: number,
      off = { membership: false, account: false },
    ) => {
      const id = crypto.randomUUID();
      const email = `${role}-${index}-${tag}@example.com`;
      await db.insert(users).values({
        id,
        email,
        passwordHash,
        displayName: email,
        disabledAt: off.account ? sql`clock_timestamp()` : null,
      });
      await db.insert(memberships).values({
        workspaceId,
        userId: id,
        role,
        disabledAt: off.membership ? sql`clock_timestamp()` : null,
        createdAt: sql`clock_timestamp() + ${`${index} seconds`}::interval`,
      });
      return { id, email };
    };
    const actor = await add(actorRole, 0);
    await add("owner", 1);
    await add("member", 2);
    const subject =
      target === "self"
        ? actor
        : await add(target.role, 3, STATES[target.state]);
    return { workspaceId, actor, subject };
  }

  async function cookieOf(email: string) {
    const response = await app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "werft-web",
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  async function listed(cookie: string, query: string) {
    const response = await app.request(`/v1/members?${query}`, {
      headers: { Cookie: cookie },
    });
    return { status: response.status, body: await response.json() };
  }

  /** The row as the actor's list has it: on a later page, and by search. */
  async function rowOf(cookie: string, userId: string, email: string) {
    const rows: MemberRow[] = [];
    let cursor: string | null = null;
    do {
      const page = listMembersResponseSchema.parse(
        (
          await listed(
            cookie,
            `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )
        ).body,
      );
      rows.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor !== null);
    const paged = rows.find((row) => row.user_id === userId);
    const searched = listMembersResponseSchema
      .parse((await listed(cookie, `q=${encodeURIComponent(email)}`)).body)
      .items.find((row) => row.user_id === userId);
    if (!paged) throw new Error("the target is not listed");
    // What a row offers does not hang on the page or the search.
    expect(searched?.actions).toEqual(paged.actions);
    return paged;
  }

  async function write(cookie: string, userId: string, action: Action) {
    const headers = {
      Cookie: cookie,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Content-Type": "application/json",
    };
    const response =
      action.kind === "change_role"
        ? await app.request(`/v1/members/${userId}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ role: action.role }),
          })
        : await app.request(`/v1/members/${userId}/${action.kind}`, {
            method: "POST",
            headers,
            body: "{}",
          });
    const body = (await response.json()) as { error?: { code: string } };
    return { status: response.status, code: body.error?.code };
  }

  async function stateOf(workspaceId: string, userId: string) {
    const [row] = await db
      .select({
        role: memberships.role,
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

  const cases: readonly {
    actorRole: "owner" | "admin";
    target: { role: WorkspaceRole; state: State } | "self";
  }[] = [
    { actorRole: "owner", target: "self" },
    { actorRole: "owner", target: { role: "owner", state: "live" } },
    { actorRole: "owner", target: { role: "member", state: "live" } },
    { actorRole: "admin", target: { role: "owner", state: "live" } },
    { actorRole: "admin", target: { role: "member", state: "membership off" } },
    { actorRole: "admin", target: { role: "member", state: "account off" } },
  ];

  for (const { actorRole, target } of cases) {
    const name =
      target === "self" ? "self" : `${target.role} (${target.state})`;
    test(`${actorRole} → ${name}`, async () => {
      for (const action of ACTIONS) {
        // A workspace per action: each write starts from the listed state.
        const { workspaceId, actor, subject } = await workspaceWith(
          actorRole,
          target,
        );
        const cookie = await cookieOf(actor.email);
        const verdict = verdictOf(
          await rowOf(cookie, subject.id, subject.email),
          action,
        );
        const before = await stateOf(workspaceId, subject.id);
        const answer = await write(cookie, subject.id, action);
        const after = await stateOf(workspaceId, subject.id);
        const label = `${JSON.stringify(action)} offered ${JSON.stringify(verdict)}`;
        if (verdict.allowed) {
          expect(answer, label).toEqual({ status: 200, code: undefined });
          expect(after, label).not.toEqual(before);
        } else if (verdict.reason === "unchanged") {
          expect(answer, label).toEqual({ status: 200, code: undefined });
          expect(after, label).toEqual(before);
        } else {
          const statuses = {
            self_protected: 403,
            owner_protected: 403,
            member_disabled: 409,
            account_disabled: 409,
            last_owner: 409,
          } as const;
          expect(answer, label).toEqual({
            status: statuses[verdict.reason],
            code: verdict.reason.toUpperCase(),
          });
          expect(after, label).toEqual(before);
        }
      }
    }, 60_000);
  }

  // The roles the list says an invite may carry are the ones POST /v1/invites
  // takes; any other is refused as owner_protected and stores nothing.
  for (const actorRole of ["owner", "admin"] as const) {
    test(`${actorRole}: assignable_roles is what an invite accepts`, async () => {
      const { workspaceId, actor, subject } = await workspaceWith(actorRole, {
        role: "member",
        state: "live",
      });
      const cookie = await cookieOf(actor.email);
      const pages = [
        (await listed(cookie, "limit=2")).body,
        (await listed(cookie, `q=${encodeURIComponent(subject.email)}`)).body,
      ].map((body) => listMembersResponseSchema.parse(body));
      const assignable = pages[0]?.assignable_roles ?? [];
      expect(pages[1]?.assignable_roles).toEqual(assignable);
      expect(assignable).toEqual(
        actorRole === "owner"
          ? ["owner", "admin", "member"]
          : ["admin", "member"],
      );
      for (const role of ROLES) {
        const response = await app.request("/v1/invites", {
          method: "POST",
          headers: {
            Cookie: cookie,
            [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: `${role}-${workspaceId}@example.com`,
            role,
          }),
        });
        const body = (await response.json()) as { error?: { code: string } };
        expect(
          { status: response.status, code: body.error?.code },
          role,
        ).toEqual(
          assignable.includes(role)
            ? { status: 201, code: undefined }
            : { status: 403, code: "OWNER_PROTECTED" },
        );
      }
      const stored = await db
        .select({ role: schema.invites.role })
        .from(schema.invites)
        .where(eq(schema.invites.workspaceId, workspaceId));
      expect(stored.map((row) => row.role).sort()).toEqual(
        [...assignable].sort(),
      );
    });
  }

  test("a member is offered nothing: the list and every write answer 403", async () => {
    const { actor, subject } = await workspaceWith("member", {
      role: "member",
      state: "live",
    });
    const cookie = await cookieOf(actor.email);
    expect((await listed(cookie, "")).status).toBe(403);
    for (const action of ACTIONS) {
      expect(await write(cookie, subject.id, action)).toEqual({
        status: 403,
        code: "FORBIDDEN",
      });
    }
  });
});
