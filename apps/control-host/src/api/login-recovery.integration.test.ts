import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as schema from "@werft-ai/db";
import {
  consumePasswordReset,
  loginMethods,
  loginProviders,
  loginSettings,
  memberships,
  passwordResets,
  receipts,
  users,
  webSessions,
  workspaces,
} from "@werft-ai/db";
import { seedLoginProvider } from "@werft-ai/db/testing/login-provider";
import type { MembershipRole } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashWebSessionToken } from "./auth.ts";
import {
  LOGIN_RECOVERY_EXIT,
  type LoginRecoveryIo,
  runLoginRecovery,
} from "./login-recovery.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("login-recovery on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  /** The emergency admin every test starts with. */
  let admin: { id: string; email: string; passwordMethodId: string };
  let serial = 0;
  let closes = 0;

  const person = async (role: MembershipRole, password = true) => {
    serial += 1;
    const id = randomUUID();
    const email = `p${serial}@example.com`;
    await db.insert(users).values({
      id,
      email,
      passwordHash: password ? "argon2id$placeholder" : null,
      displayName: `P${serial}`,
    });
    await db.insert(memberships).values({ workspaceId, userId: id, role });
    const passwordMethodId = randomUUID();
    if (password) {
      await db
        .insert(loginMethods)
        .values({ id: passwordMethodId, userId: id, kind: "password" });
    }
    return { id, email, passwordMethodId };
  };
  const provider = (displayName: string, enabled = true) => {
    serial += 1;
    return seedLoginProvider(db, {
      issuer: `https://idp${serial}.example.com`,
      displayName,
      enabled,
    });
  };
  /** A live session of `userId`, made through the provider or a password. */
  const session = async (
    userId: string,
    through: { issuer: string } | { passwordMethodId: string },
  ) => {
    let loginMethodId: string;
    if ("issuer" in through) {
      loginMethodId = randomUUID();
      await db.insert(loginMethods).values({
        id: loginMethodId,
        userId,
        kind: "oidc",
        issuer: through.issuer,
        subject: randomUUID(),
      });
    } else {
      loginMethodId = through.passwordMethodId;
    }
    const id = randomUUID();
    await db.insert(webSessions).values({
      id,
      userId,
      tokenHash: createHash("sha256").update(randomUUID()).digest(),
      expiresAt: sql`clock_timestamp() + interval '1 hour'`,
      loginMethodId,
    });
    return id;
  };
  const live = async (sessionId: string) =>
    (await db.$count(
      webSessions,
      and(eq(webSessions.id, sessionId), isNull(webSessions.revokedAt)),
    )) === 1;
  const settingsRow = async () => {
    const [row] = await db.select().from(loginSettings);
    if (!row) throw new Error("no settings row");
    return row;
  };
  const close = () =>
    db.update(loginSettings).set({ passwordLogin: "emergency_only" });
  const receiptsOf = (operation: string) =>
    db
      .select({ result: receipts.result, actor: receipts.actor })
      .from(receipts)
      .where(eq(receipts.operation, operation));

  /** Runs the command; the one stdout line comes back parsed. */
  async function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: LoginRecoveryIo = {
      env: { DATABASE_URL: "postgres://handled-by-openDatabase" },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      openDatabase: async () => ({
        db,
        close: async () => {
          closes += 1;
        },
      }),
    };
    const code = await runLoginRecovery(argv, io);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    return { code, line: JSON.parse(out[0] as string) };
  }

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "login_recovery_cli" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "recovery", name: "Recovery" });
    admin = await person("owner");
  }, 60_000);

  beforeEach(async () => {
    await db.delete(webSessions);
    await db.delete(loginMethods).where(eq(loginMethods.kind, "oidc"));
    await db.delete(loginProviders);
    await db.delete(receipts);
    await db
      .update(loginSettings)
      .set({ passwordLogin: "on", emergencyAdminUserId: admin.id });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  test("status says the providers, the password switch and the emergency admin, and closes the database", async () => {
    const zulu = await provider("Zulu");
    const alpha = await provider("Alpha", false);
    const before = closes;
    expect(await run(["status"])).toEqual({
      code: LOGIN_RECOVERY_EXIT.ok,
      line: {
        outcome: "ok",
        password_login: "on",
        emergency_admin: { email: admin.email, eligible: true },
        providers: [
          {
            id: alpha.id,
            display_name: "Alpha",
            issuer: alpha.issuer,
            enabled: false,
          },
          {
            id: zulu.id,
            display_name: "Zulu",
            issuer: zulu.issuer,
            enabled: true,
          },
        ],
      },
    });
    expect(closes).toBe(before + 1);

    await close();
    await db
      .update(memberships)
      .set({ disabledAt: sql`clock_timestamp()` })
      .where(eq(memberships.userId, admin.id));
    try {
      expect((await run(["status"])).line).toMatchObject({
        password_login: "emergency_only",
        emergency_admin: { email: admin.email, eligible: false },
      });
    } finally {
      await db
        .update(memberships)
        .set({ disabledAt: null })
        .where(eq(memberships.userId, admin.id));
    }

    await db
      .update(loginSettings)
      .set({ passwordLogin: "on", emergencyAdminUserId: null });
    expect((await run(["status"])).line).toMatchObject({
      emergency_admin: null,
    });
    expect(await db.$count(receipts)).toBe(0);
  });

  test("enable-password opens passwords once, and says so when they were open", async () => {
    await provider("Only");
    await close();
    expect(await run(["enable-password"])).toEqual({
      code: LOGIN_RECOVERY_EXIT.ok,
      line: { outcome: "changed", password_login: "on" },
    });
    expect(await settingsRow()).toMatchObject({
      passwordLogin: "on",
      emergencyAdminUserId: admin.id,
    });
    expect(await receiptsOf("set_password_login")).toEqual([
      {
        result: {
          password_login: "on",
          sessions_revoked: 0,
          by: "operator_cli",
        },
        actor: null,
      },
    ]);

    expect(await run(["enable-password"])).toEqual({
      code: LOGIN_RECOVERY_EXIT.ok,
      line: { outcome: "unchanged", password_login: "on" },
    });
    expect(await receiptsOf("set_password_login")).toHaveLength(1);
  });

  test("disable-provider --id ends that provider's sessions, and opens passwords only with the last one", async () => {
    const one = await provider("One");
    const two = await provider("Two");
    const member = await person("member");
    const viaOne = [
      await session(member.id, one),
      await session(admin.id, one),
    ];
    const viaTwo = await session(member.id, two);
    const viaPassword = await session(admin.id, admin);
    await close();

    expect(await run(["disable-provider", "--id", one.id])).toEqual({
      code: LOGIN_RECOVERY_EXIT.ok,
      line: {
        outcome: "disabled",
        providers: [{ id: one.id, display_name: "One", sessions_revoked: 2 }],
        password_login_opened: false,
      },
    });
    expect(await Promise.all(viaOne.map(live))).toEqual([false, false]);
    expect(await live(viaTwo)).toBe(true);
    expect(await live(viaPassword)).toBe(true);
    expect((await settingsRow()).passwordLogin).toBe("emergency_only");
    expect(await receiptsOf("disable_login_provider")).toEqual([
      {
        result: {
          provider_id: one.id,
          sessions_revoked: 2,
          by: "operator_cli",
        },
        actor: null,
      },
    ]);
    expect(await receiptsOf("set_password_login")).toEqual([]);

    expect((await run(["disable-provider", "--id", two.id])).line).toEqual({
      outcome: "disabled",
      providers: [{ id: two.id, display_name: "Two", sessions_revoked: 1 }],
      password_login_opened: true,
    });
    expect(await live(viaTwo)).toBe(false);
    expect(await live(viaPassword)).toBe(true);
    expect((await settingsRow()).passwordLogin).toBe("on");
    expect(await receiptsOf("set_password_login")).toHaveLength(1);

    // Off already: done, with nothing ended and nothing recorded.
    expect(await run(["disable-provider", "--id", two.id])).toEqual({
      code: LOGIN_RECOVERY_EXIT.ok,
      line: {
        outcome: "disabled",
        providers: [{ id: two.id, display_name: "Two", sessions_revoked: 0 }],
        password_login_opened: false,
      },
    });
    expect(await receiptsOf("disable_login_provider")).toHaveLength(2);
    expect(
      await db.$count(loginProviders, eq(loginProviders.enabled, true)),
    ).toBe(0);
  });

  test("disable-provider --all turns every provider off and opens closed passwords", async () => {
    const on = [await provider("A"), await provider("B")];
    const off = await provider("C", false);
    const sessions = await Promise.all(on.map((idp) => session(admin.id, idp)));
    await close();

    const { code, line } = await run(["disable-provider", "--all"]);
    expect(code).toBe(LOGIN_RECOVERY_EXIT.ok);
    expect(line.password_login_opened).toBe(true);
    expect(
      [...line.providers].sort((a, b) =>
        a.display_name.localeCompare(b.display_name),
      ),
    ).toEqual([
      { id: on[0]?.id, display_name: "A", sessions_revoked: 1 },
      { id: on[1]?.id, display_name: "B", sessions_revoked: 1 },
      { id: off.id, display_name: "C", sessions_revoked: 0 },
    ]);
    expect(await Promise.all(sessions.map(live))).toEqual([false, false]);
    expect((await settingsRow()).passwordLogin).toBe("on");
    expect(
      await db.$count(loginProviders, eq(loginProviders.enabled, true)),
    ).toBe(0);
    expect(await receiptsOf("disable_login_provider")).toHaveLength(2);

    // Passwords were open: there is nothing to open, with or without providers.
    await provider("D");
    expect((await run(["disable-provider", "--all"])).line).toMatchObject({
      outcome: "disabled",
      password_login_opened: false,
    });
    expect(await receiptsOf("set_password_login")).toHaveLength(1);
  });

  test("disable-provider for an id that is no provider exits 3 and changes nothing", async () => {
    const idp = await provider("Kept");
    const kept = await session(admin.id, idp);
    await close();
    expect(await run(["disable-provider", "--id", randomUUID()])).toEqual({
      code: LOGIN_RECOVERY_EXIT.not_found,
      line: { outcome: "not_found" },
    });
    expect(await live(kept)).toBe(true);
    expect((await settingsRow()).passwordLogin).toBe("emergency_only");
    expect(await db.$count(receipts)).toBe(0);
  });

  test("reset-password is for a live owner only", async () => {
    const member = await person("member");
    for (const email of [member.email, "nobody@example.com"]) {
      expect(await run(["reset-password", "--email", email])).toEqual({
        code: LOGIN_RECOVERY_EXIT.not_found,
        line: { outcome: "not_found" },
      });
    }
    expect(await db.$count(passwordResets)).toBe(0);
    expect(await db.$count(receipts)).toBe(0);
  });

  test("reset-password prints a token that, once used, makes that owner the emergency admin", async () => {
    await provider("Broken");
    await close();
    // An owner who only ever came in through the provider.
    const owner = await person("owner", false);

    const { code, line } = await run([
      "reset-password",
      "--email",
      owner.email.toUpperCase(),
    ]);
    expect(code).toBe(LOGIN_RECOVERY_EXIT.ok);
    expect(Object.keys(line).sort()).toEqual([
      "expires_at",
      "outcome",
      "token",
      "user_id",
    ]);
    expect(line).toMatchObject({ outcome: "issued", user_id: owner.id });
    expect(line.token).toStartWith("apr_");

    const {
      rows: [stored],
    } = await pool.query(
      `select issued_by, expires_at,
              extract(epoch from expires_at - clock_timestamp())::float as seconds_left
         from password_resets where user_id = $1`,
      [owner.id],
    );
    expect(stored.issued_by).toBeNull();
    expect(stored.expires_at.toISOString()).toBe(line.expires_at);
    expect(stored.seconds_left).toBeGreaterThan(3500);
    expect(stored.seconds_left).toBeLessThanOrEqual(3600);
    expect(await receiptsOf("issue_password_reset")).toMatchObject([
      { result: { issued_by: "operator_cli" }, actor: null },
    ]);
    // Issued, not used: nobody new is named and passwords stay closed.
    expect(await settingsRow()).toMatchObject({
      passwordLogin: "emergency_only",
      emergencyAdminUserId: admin.id,
    });

    expect(
      await consumePasswordReset(db, {
        tokenHash: hashWebSessionToken(line.token),
        passwordHash: "argon2id$operator",
        receiptId: randomUUID(),
      }),
    ).toEqual({ userId: owner.id, workspaceId });
    expect(await settingsRow()).toMatchObject({
      passwordLogin: "emergency_only",
      emergencyAdminUserId: owner.id,
    });
    expect((await run(["status"])).line.emergency_admin).toEqual({
      email: owner.email,
      eligible: true,
    });
  });
});
