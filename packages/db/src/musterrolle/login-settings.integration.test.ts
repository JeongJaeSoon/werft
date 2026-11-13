import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { type MembershipRole, SecretKey } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  invites,
  loginMethods,
  loginProviders,
  loginSettings,
  memberships,
  passwordResets,
  receipts,
  users,
  webSessions,
  workspaces,
} from "../schema.ts";
import { seedLoginProvider } from "../testing/login-provider.ts";
import {
  bootstrapOwner,
  consumePasswordReset,
  createWebSession,
  findLiveMembership,
  issueOperatorPasswordReset,
  issuePasswordReset,
} from "./identity.ts";
import { createPostgresInviteStore } from "./invites.ts";
import { createPostgresLoginMethodStore } from "./login-methods.ts";
import { createPostgresLoginProviderAdminStore } from "./login-providers.ts";
import {
  createPostgresLoginSettingsStore,
  EMERGENCY_ADMIN_CANDIDATES,
} from "./login-settings.ts";
import { createPostgresMemberStore } from "./members.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const KEY = SecretKey.fromHex("ab".repeat(32), "test");
const HASH = "argon2id$placeholder";

integration("who may sign in with a password", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: ReturnType<typeof createPostgresLoginSettingsStore>;
  const workspaceId = randomUUID();
  /** The owner bootstrap made; the others are made by each test. */
  let first: string;
  let serial = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "login_settings" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresLoginSettingsStore(db);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const newHash = () => createHash("sha256").update(randomUUID()).digest();
  const fromDbNow = (ms: number) =>
    sql<Date>`clock_timestamp() + ${ms}::double precision * interval '1 millisecond'`;
  const audit = (userId: string) => ({
    userId,
    workspaceId,
    receiptId: randomUUID(),
  });
  const acting = (userId: string) => ({
    principal: {
      ownerId: workspaceId,
      requestId: "req-1",
      actor: {
        principal: { kind: "user" as const, id: userId },
        userId,
        workspaceId,
        apiKeyId: null,
      },
    },
    workspaceId,
    userId,
  });

  /** A person as an accepted password invite leaves one. */
  const person = async (role: MembershipRole, password = true) => {
    serial += 1;
    const id = randomUUID();
    await db.insert(users).values({
      id,
      email: `p${serial}@example.com`,
      passwordHash: password ? HASH : null,
      displayName: `P${serial}`,
    });
    await db.insert(memberships).values({ workspaceId, userId: id, role });
    const passwordMethodId = randomUUID();
    if (password) {
      await db
        .insert(loginMethods)
        .values({ id: passwordMethodId, userId: id, kind: "password" });
    }
    return { id, passwordMethodId, email: `p${serial}@example.com` };
  };
  const provider = () => {
    serial += 1;
    return seedLoginProvider(db, {
      issuer: `https://idp${serial}.example.com`,
      displayName: `IdP ${serial}`,
    });
  };
  type Provider = Awaited<ReturnType<typeof provider>>;
  /** Gives the person an account of the provider; returns the method's id. */
  const account = async (userId: string, of: Provider) => {
    const id = randomUUID();
    await db.insert(loginMethods).values({
      id,
      userId,
      kind: "oidc",
      issuer: of.issuer,
      subject: randomUUID(),
    });
    return id;
  };
  const session = async (userId: string, loginMethodId: string | null) => {
    const id = randomUUID();
    await db.insert(webSessions).values({
      id,
      userId,
      tokenHash: newHash(),
      expiresAt: fromDbNow(3_600_000),
      loginMethodId,
    });
    return id;
  };
  const live = async (sessionId: string) =>
    (await db.$count(
      webSessions,
      and(eq(webSessions.id, sessionId), isNull(webSessions.revokedAt)),
    )) === 1;
  const signIn = (userId: string) =>
    createWebSession(db, {
      id: randomUUID(),
      userId,
      verifiedPasswordHash: HASH,
      tokenHash: newHash(),
      ttlMs: 60_000,
      userAgent: null,
      maxLive: 5,
    });
  const settingsRow = async () => {
    const [row] = await db.select().from(loginSettings);
    if (!row) throw new Error("no settings row");
    return row;
  };
  const receiptsOf = async (operation: string) =>
    (
      await db
        .select({ result: receipts.result, actor: receipts.actor })
        .from(receipts)
        .where(eq(receipts.operation, operation))
        .orderBy(receipts.createdAt)
    ).at(-1);
  /** Passwords closed, with `admin` named and one provider on. */
  const closed = async (admin: string) => {
    const idp = await provider();
    await db.update(loginSettings).set({
      passwordLogin: "emergency_only",
      emergencyAdminUserId: admin,
    });
    return idp;
  };
  /** Resolves once `count` transactions of this database wait on a lock. */
  const lockWaiters = async (count: number) => {
    for (let i = 0; i < 300; i += 1) {
      const { rows } = await pool.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (rows[0].n >= count) return;
      await Bun.sleep(20);
    }
    throw new Error(`no ${count} lock waiters`);
  };
  /**
   * Starts `action` while another transaction holds the settings for
   * update, lets that transaction make `change` once the action waits, and
   * returns what the action answered after the commit.
   */
  const afterSettingsChange = async <T>(
    action: () => Promise<T>,
    change: string,
    values: unknown[] = [],
  ): Promise<T> => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM login_settings FOR UPDATE");
      const pending = action();
      await lockWaiters(1);
      await holder.query(change, values);
      await holder.query("COMMIT");
      return await pending;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  };

  // Each test starts with passwords on, the bootstrap owner named, and
  // every provider an earlier test made turned off.
  beforeEach(async () => {
    if (first === undefined) return;
    await db.update(loginSettings).set({
      passwordLogin: "on",
      emergencyAdminUserId: first,
    });
    await db.update(loginProviders).set({ enabled: false });
  });

  test("a migrated database has the one row: passwords on, nobody named", async () => {
    expect(await store.read()).toEqual({
      passwordLogin: "on",
      emergencyAdmin: null,
      enabledProviders: 0,
    });
    await expect(
      pool.query("INSERT INTO login_settings (id) VALUES (false)"),
    ).rejects.toThrow(/login_settings_single_row_check/);
    await expect(
      pool.query("UPDATE login_settings SET password_login = 'emergency_only'"),
    ).rejects.toThrow(/login_settings_emergency_admin_check/);
  });

  test("bootstrap names the owner it makes the emergency admin", async () => {
    first = randomUUID();
    await bootstrapOwner(db, {
      userId: first,
      email: "first@example.com",
      passwordHash: HASH,
      displayName: "First",
      workspaceId,
      workspaceSlug: "acme",
      workspaceName: "Acme",
      bootstrapTokenHash: newHash(),
      receiptId: randomUUID(),
      loginMethodId: randomUUID(),
    });
    expect(await store.read()).toEqual({
      passwordLogin: "on",
      emergencyAdmin: {
        userId: first,
        email: "first@example.com",
        displayName: "First",
        eligible: true,
      },
      enabledProviders: 0,
    });
  });

  test("only a live owner with a password is named emergency admin", async () => {
    const member = await person("member");
    const admin = await person("admin");
    const noPassword = await person("owner", false);
    const off = await person("owner");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, off.id));
    const suspended = await person("owner");
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, suspended.id));
    for (const who of [member, admin, noPassword, off, suspended]) {
      expect(
        await store.setEmergencyAdmin({ userId: who.id, audit: audit(first) }),
      ).toEqual({ outcome: "not_eligible" });
    }
    expect((await settingsRow()).emergencyAdminUserId).toBe(first);

    const other = await person("owner");
    // The list a screen offers is the people the naming takes, the oldest
    // membership first.
    const offered = await store.emergencyAdminCandidates(workspaceId);
    expect(offered[0]?.userId).toBe(first);
    expect(offered.find((owner) => owner.userId === other.id)).toEqual({
      userId: other.id,
      email: other.email,
      displayName: expect.any(String),
    });
    const offeredIds = offered.map((owner) => owner.userId);
    for (const who of [member, admin, noPassword, off, suspended]) {
      expect(offeredIds).not.toContain(who.id);
    }
    expect(await store.emergencyAdminCandidates(randomUUID())).toEqual([]);
    const named = await store.setEmergencyAdmin({
      userId: other.id,
      audit: audit(first),
    });
    expect(named.outcome).toBe("changed");
    expect((await settingsRow()).emergencyAdminUserId).toBe(other.id);
    expect(await receiptsOf("set_emergency_admin")).toEqual({
      result: {
        user_id: other.id,
        previous_user_id: first,
        sessions_revoked: 0,
      },
      actor: {
        principal: { kind: "user", id: first },
        actor_user_id: first,
        agent_id: null,
      },
    });
    expect(
      (await store.setEmergencyAdmin({ userId: other.id, audit: audit(first) }))
        .outcome,
    ).toBe("unchanged");
  });

  test("owners nobody could name do not use up the list of candidates", async () => {
    // A full list's worth of owners without a password, all older members
    // than the one owner who can be named.
    const crowd: string[] = Array.from(
      { length: EMERGENCY_ADMIN_CANDIDATES },
      () => randomUUID(),
    );
    await db.insert(users).values(
      crowd.map((id, index) => ({
        id,
        email: `crowd${index}@example.com`,
        passwordHash: null,
        displayName: `Crowd ${index}`,
      })),
    );
    await db.insert(memberships).values(
      crowd.map((userId) => ({
        workspaceId,
        userId,
        role: "owner" as const,
        createdAt: sql`now() - interval '1 hour'`,
      })),
    );
    try {
      const late = await person("owner");
      const offered = (await store.emergencyAdminCandidates(workspaceId)).map(
        (owner) => owner.userId,
      );
      expect(offered).toContain(late.id);
      expect(offered.filter((id) => crowd.includes(id))).toEqual([]);
      expect(
        (
          await store.setEmergencyAdmin({
            userId: late.id,
            audit: audit(first),
          })
        ).outcome,
      ).toBe("changed");
    } finally {
      await db.delete(memberships).where(inArray(memberships.userId, crowd));
      await db.delete(users).where(inArray(users.id, crowd));
    }
  });

  test("passwords are not closed without a provider, an emergency admin who can sign in, and a way back for the one asking", async () => {
    const close = (by: string) =>
      store.setPasswordLogin({ value: "emergency_only", audit: audit(by) });
    expect(await close(first)).toEqual({ outcome: "no_provider" });

    const idp = await provider();
    const other = await person("owner");
    // Not the emergency admin, and no account of a provider that is on.
    expect(await close(other.id)).toEqual({ outcome: "locks_out_actor" });
    const stale = await provider();
    await account(other.id, stale);
    await db
      .update(loginProviders)
      .set({ enabled: false })
      .where(eq(loginProviders.id, stale.id));
    expect(await close(other.id)).toEqual({ outcome: "locks_out_actor" });

    // Nobody named: an installation whose owners never had a password.
    await db.update(loginSettings).set({ emergencyAdminUserId: null });
    await account(other.id, idp);
    expect(await close(other.id)).toEqual({ outcome: "no_emergency_admin" });
    // Named, but no longer able to sign in with a password. No path here
    // leaves one so; a row written by hand does.
    const lapsed = await person("owner", false);
    await db.update(loginSettings).set({ emergencyAdminUserId: lapsed.id });
    expect(await close(other.id)).toEqual({ outcome: "no_emergency_admin" });
    expect((await settingsRow()).passwordLogin).toBe("on");
  });

  test("closing passwords ends everyone's password sessions but the emergency admin's, in the same transaction", async () => {
    const idp = await provider();
    const owner = await person("owner");
    const ownerAccount = await account(owner.id, idp);
    const member = await person("member");
    const [firstMethod] = await db
      .select({ id: loginMethods.id })
      .from(loginMethods)
      .where(eq(loginMethods.userId, first));
    const kept = [
      await session(first, firstMethod?.id ?? null),
      // Made before sessions recorded their method: still a password one.
      await session(first, null),
      await session(owner.id, ownerAccount),
    ];
    const ended = [
      await session(owner.id, owner.passwordMethodId),
      await session(member.id, member.passwordMethodId),
      await session(member.id, null),
    ];
    const result = await store.setPasswordLogin({
      value: "emergency_only",
      audit: audit(owner.id),
    });
    expect(result).toMatchObject({ outcome: "changed", sessionsRevoked: 3 });
    for (const id of kept) expect(await live(id)).toBe(true);
    for (const id of ended) expect(await live(id)).toBe(false);
    expect(await receiptsOf("set_password_login")).toMatchObject({
      result: { password_login: "emergency_only", sessions_revoked: 3 },
    });
    expect(
      (
        await store.setPasswordLogin({
          value: "emergency_only",
          audit: audit(owner.id),
        })
      ).outcome,
    ).toBe("unchanged");

    // Open again: nothing is ended, and anyone signs in with a password.
    expect(
      await store.setPasswordLogin({ value: "on", audit: audit(owner.id) }),
    ).toMatchObject({ outcome: "changed", sessionsRevoked: 0 });
    expect(await signIn(member.id)).not.toBeNull();
  });

  test("while passwords are closed only the emergency admin signs in with one, and nobody else is given one", async () => {
    const member = await person("member");
    const owner = await person("owner");
    // An owner's link made while passwords were open.
    const early = newHash();
    expect(
      (
        await issuePasswordReset(db, {
          id: randomUUID(),
          workspaceId,
          userId: member.id,
          issuedBy: owner.id,
          issuerPasswordHash: HASH,
          tokenHash: early,
          ttlMs: 60_000,
          receiptId: randomUUID(),
        })
      ).outcome,
    ).toBe("issued");
    const inviteToken = newHash();
    const inviteId = randomUUID();
    await db.insert(invites).values({
      id: inviteId,
      workspaceId,
      email: "new@example.com",
      role: "member",
      tokenHash: inviteToken,
      invitedBy: owner.id,
      expiresAt: fromDbNow(60_000),
    });
    await closed(first);

    expect(await signIn(member.id)).toBeNull();
    expect(await signIn(owner.id)).toBeNull();
    expect(await signIn(first)).not.toBeNull();
    const methods = createPostgresLoginMethodStore(db);
    expect((await methods.list(member.id)).methods[0]?.usable).toBe(false);
    expect((await methods.list(first)).methods[0]?.usable).toBe(true);

    // The early link sets no password, and stays unused.
    expect(
      await consumePasswordReset(db, {
        tokenHash: early,
        passwordHash: "argon2id$changed",
        receiptId: randomUUID(),
      }),
    ).toBeNull();
    const [link] = await db
      .select({ usedAt: passwordResets.usedAt })
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, early));
    expect(link?.usedAt).toBeNull();
    const issue = (userId: string) =>
      issuePasswordReset(db, {
        id: randomUUID(),
        workspaceId,
        userId,
        issuedBy: first,
        issuerPasswordHash: HASH,
        tokenHash: newHash(),
        ttlMs: 60_000,
        receiptId: randomUUID(),
      });
    expect(await issue(member.id)).toEqual({ outcome: "password_closed" });

    // An invite sets no password either, and is left to be taken through
    // a provider.
    expect(
      await createPostgresInviteStore(db).acceptInvite({
        tokenHash: inviteToken,
        account: {
          kind: "new",
          userId: randomUUID(),
          passwordHash: HASH,
          displayName: "New",
          loginMethodId: randomUUID(),
        },
        session: {
          id: randomUUID(),
          tokenHash: newHash(),
          ttlMs: 60_000,
          userAgent: null,
          maxLive: 5,
        },
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "password_closed" });
    const [invite] = await db
      .select({ acceptedAt: invites.acceptedAt })
      .from(invites)
      .where(eq(invites.id, inviteId));
    expect(invite?.acceptedAt).toBeNull();
    expect(await db.$count(users, eq(users.email, "new@example.com"))).toBe(0);
  });

  test("the emergency admin is not turned off, demoted, or left without a password until another is named", async () => {
    const owner = await person("owner");
    const target = await person("owner");
    const idp = await provider();
    await account(target.id, idp);
    await db.update(loginSettings).set({ emergencyAdminUserId: target.id });
    const members = createPostgresMemberStore(db);
    const off = (scope: "membership" | "account") =>
      members.setAccess({
        actor: acting(owner.id),
        userId: target.id,
        scope,
        disabled: true,
        reason: null,
        receiptId: randomUUID(),
      });
    const demote = () =>
      createPostgresInviteStore(db).changeMemberRole({
        actor: acting(owner.id),
        userId: target.id,
        role: "admin",
        receiptId: randomUUID(),
      });
    const dropPassword = async () =>
      createPostgresLoginMethodStore(db).unlink({
        userId: target.id,
        sessionId: await session(target.id, null),
        maxAgeMs: 600_000,
        loginMethodId: target.passwordMethodId,
        workspaceId,
        receiptId: randomUUID(),
      });
    expect(await off("membership")).toEqual({ outcome: "emergency_admin" });
    expect(await off("account")).toEqual({ outcome: "emergency_admin" });
    expect(await demote()).toEqual({ outcome: "emergency_admin" });
    expect(await dropPassword()).toEqual({ outcome: "emergency_admin" });
    const [row] = await db
      .select({
        role: memberships.role,
        disabledAt: memberships.disabledAt,
        passwordHash: users.passwordHash,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.userId, target.id));
    expect(row).toEqual({
      role: "owner",
      disabledAt: null,
      passwordHash: HASH,
    });

    // With another owner named, each of them goes through.
    expect(
      (
        await store.setEmergencyAdmin({
          userId: owner.id,
          audit: audit(owner.id),
        })
      ).outcome,
    ).toBe("changed");
    expect((await dropPassword()).outcome).toBe("unlinked");
    expect((await demote()).outcome).toBe("changed");
    expect((await off("membership")).outcome).toBe("changed");
  });

  test("a change that waited while another owner was named emergency admin answers by who is named now", async () => {
    const owner = await person("owner");
    const target = await person("owner");
    const answer = await afterSettingsChange(
      () =>
        createPostgresMemberStore(db).setAccess({
          actor: acting(owner.id),
          userId: target.id,
          scope: "membership",
          disabled: true,
          reason: null,
          receiptId: randomUUID(),
        }),
      "UPDATE login_settings SET emergency_admin_user_id = $1",
      [target.id],
    );
    expect(answer).toEqual({ outcome: "emergency_admin" });
  });

  test("a password sign-in that waited while passwords were closed makes no session", async () => {
    const member = await person("member");
    await provider();
    const answer = await afterSettingsChange(
      () => signIn(member.id),
      "UPDATE login_settings SET password_login = 'emergency_only'",
    );
    expect(answer).toBeNull();
    expect(
      await db.$count(webSessions, eq(webSessions.userId, member.id)),
    ).toBe(0);
  });

  test("the last provider is not turned off while passwords are closed", async () => {
    const providers = createPostgresLoginProviderAdminStore(db, KEY);
    const a = await closed(first);
    const b = await provider();
    const off = (id: string) => providers.disable({ id, audit: audit(first) });
    expect((await off(a.id)).outcome).toBe("disabled");
    expect(await off(b.id)).toEqual({ outcome: "last_provider" });
    const [row] = await db
      .select({ enabled: loginProviders.enabled })
      .from(loginProviders)
      .where(eq(loginProviders.id, b.id));
    expect(row?.enabled).toBe(true);
    // Off already: said again, whatever passwords are.
    expect((await off(a.id)).outcome).toBe("disabled");

    await db.update(loginSettings).set({ passwordLogin: "on" });
    expect((await off(b.id)).outcome).toBe("disabled");
  });

  test("a provider turned off after waiting for passwords to close is the last one, and stays on", async () => {
    const idp = await provider();
    const answer = await afterSettingsChange(
      () =>
        createPostgresLoginProviderAdminStore(db, KEY).disable({
          id: idp.id,
          audit: audit(first),
        }),
      "UPDATE login_settings SET password_login = 'emergency_only'",
    );
    expect(answer).toEqual({ outcome: "last_provider" });
  });

  test("while passwords are closed, naming another emergency admin ends the old one's password sessions and needs a way back for the one asking", async () => {
    const idp = await closed(first);
    const next = await person("owner");
    const [firstMethod] = await db
      .select({ id: loginMethods.id })
      .from(loginMethods)
      .where(eq(loginMethods.userId, first));
    const old = await session(first, firstMethod?.id ?? null);
    // The one being replaced has only a password: they would be out.
    expect(
      await store.setEmergencyAdmin({ userId: next.id, audit: audit(first) }),
    ).toEqual({ outcome: "locks_out_actor" });
    expect(await live(old)).toBe(true);

    const throughProvider = await session(first, await account(first, idp));
    expect(
      (await store.setEmergencyAdmin({ userId: next.id, audit: audit(first) }))
        .outcome,
    ).toBe("changed");
    expect(await live(old)).toBe(false);
    expect(await live(throughProvider)).toBe(true);
    expect(await signIn(first)).toBeNull();
    expect(await signIn(next.id)).not.toBeNull();
  });

  describe("the operator's link", () => {
    const issue = (email: string, ttlMs = 60_000) => {
      const tokenHash = newHash();
      return issueOperatorPasswordReset(db, {
        id: randomUUID(),
        email,
        tokenHash,
        ttlMs,
        receiptId: randomUUID(),
      }).then((issued) => ({ issued, tokenHash }));
    };
    const use = (tokenHash: Uint8Array) =>
      consumePasswordReset(db, {
        tokenHash,
        passwordHash: "argon2id$operator",
        receiptId: randomUUID(),
      });
    const hashOf = async (userId: string) =>
      (
        await db
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, userId))
      )[0]?.passwordHash;

    test("is issued only for a live owner, and issuing names nobody", async () => {
      const member = await person("member");
      const off = await person("owner");
      await db
        .update(memberships)
        .set({ disabledAt: new Date() })
        .where(eq(memberships.userId, off.id));
      for (const email of [member.email, off.email, "nobody@example.com"]) {
        expect((await issue(email)).issued).toEqual({ outcome: "not_found" });
      }
      const owner = await person("owner", false);
      const { issued } = await issue(owner.email);
      expect(issued).toMatchObject({
        outcome: "issued",
        userId: owner.id,
        workspaceId,
      });
      expect((await settingsRow()).emergencyAdminUserId).toBe(first);
      expect(await hashOf(owner.id)).toBeNull();
      expect(await receiptsOf("issue_password_reset")).toMatchObject({
        result: { issued_by: "operator_cli", target_role: "owner" },
        actor: null,
      });
    });

    test("used, gives an owner who had no password one, and names them in the same transaction, passwords closed or not", async () => {
      await closed(first);
      const owner = await person("owner", false);
      const before = await session(owner.id, null);
      const [firstMethod] = await db
        .select({ id: loginMethods.id })
        .from(loginMethods)
        .where(eq(loginMethods.userId, first));
      const oldAdmin = await session(first, firstMethod?.id ?? null);
      const { tokenHash } = await issue(owner.email);
      expect(await use(tokenHash)).toEqual({ userId: owner.id, workspaceId });
      expect(await hashOf(owner.id)).toBe("argon2id$operator");
      expect((await settingsRow()).emergencyAdminUserId).toBe(owner.id);
      expect(
        await db.$count(
          loginMethods,
          and(
            eq(loginMethods.userId, owner.id),
            eq(loginMethods.kind, "password"),
          ),
        ),
      ).toBe(1);
      // Their own sessions end as with any reset; so do the password
      // sessions of the one who was named before.
      expect(await live(before)).toBe(false);
      expect(await live(oldAdmin)).toBe(false);
      expect(await receiptsOf("reset_password")).toMatchObject({
        result: { issued_by: "operator_cli", emergency_admin_before: first },
      });
      // Once only.
      expect(await use(tokenHash)).toBeNull();
    });

    test("unused, expired, or for someone who is no longer an owner, changes nothing", async () => {
      const owner = await person("owner", false);
      const expired = await issue(owner.email, 1);
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await pool.query(
          "select expires_at <= clock_timestamp() as dead from password_resets where token_hash = $1",
          [Buffer.from(expired.tokenHash)],
        );
        if (rows[0].dead) break;
        await Bun.sleep(5);
      }
      expect(await use(expired.tokenHash)).toBeNull();

      const demoted = await issue(owner.email);
      await db
        .update(memberships)
        .set({ role: "admin" })
        .where(eq(memberships.userId, owner.id));
      expect(await use(demoted.tokenHash)).toBeNull();

      expect(await hashOf(owner.id)).toBeNull();
      expect((await settingsRow()).emergencyAdminUserId).toBe(first);
      expect(
        await db.$count(loginMethods, eq(loginMethods.userId, owner.id)),
      ).toBe(0);
    });

    test("for the one already named sets their password and leaves the designation", async () => {
      const { tokenHash } = await issue("first@example.com");
      expect(await use(tokenHash)).toEqual({ userId: first, workspaceId });
      expect((await settingsRow()).emergencyAdminUserId).toBe(first);
      const receipt = await receiptsOf("reset_password");
      expect(receipt?.actor).toBeNull();
      expect(receipt?.result).toMatchObject({ issued_by: "operator_cli" });
      expect(receipt?.result).not.toHaveProperty("emergency_admin_before");
      await db
        .update(users)
        .set({ passwordHash: HASH })
        .where(eq(users.id, first));
    });
  });

  test("an owner whose sign-in lands on an older membership elsewhere is not one who can recover the installation", async () => {
    const elsewhere = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: elsewhere, slug: `w-${elsewhere}`, name: "Elsewhere" });
    const boss = await person("owner");
    const split = await person("owner");
    try {
      await db.insert(memberships).values([
        { workspaceId: elsewhere, userId: boss.id, role: "owner" },
        {
          workspaceId: elsewhere,
          userId: split.id,
          role: "member",
          createdAt: new Date("2000-01-01T00:00:00Z"),
        },
      ]);
      const older = (disabled: boolean) =>
        db
          .update(memberships)
          .set({ disabledAt: disabled ? new Date() : null })
          .where(
            and(
              eq(memberships.workspaceId, elsewhere),
              eq(memberships.userId, split.id),
            ),
          );
      const name = () =>
        store.setEmergencyAdmin({ userId: split.id, audit: audit(first) });
      const link = () => {
        const tokenHash = newHash();
        return issueOperatorPasswordReset(db, {
          id: randomUUID(),
          email: split.email,
          tokenHash,
          ttlMs: 60_000,
          receiptId: randomUUID(),
        }).then((issued) => ({ outcome: issued.outcome, tokenHash }));
      };

      // What a session of theirs acts through: not the owner's membership.
      expect(await findLiveMembership(db, split.id)).toEqual({
        workspaceId: elsewhere,
        role: "member",
      });
      expect(await name()).toEqual({ outcome: "not_eligible" });
      expect(
        (await store.emergencyAdminCandidates(workspaceId)).map(
          (owner) => owner.userId,
        ),
      ).not.toContain(split.id);
      expect((await link()).outcome).toBe("not_found");
      // Named by hand, they are shown as unable, and passwords stay open.
      const idp = await provider();
      await account(first, idp);
      await db.update(loginSettings).set({ emergencyAdminUserId: split.id });
      expect((await store.read()).emergencyAdmin?.eligible).toBe(false);
      expect(
        await store.setPasswordLogin({
          value: "emergency_only",
          audit: audit(first),
        }),
      ).toEqual({ outcome: "no_emergency_admin" });
      await db.update(loginSettings).set({ emergencyAdminUserId: first });

      // A link issued while they were an owner by sign-in dies when the
      // older membership comes back.
      await older(true);
      const issued = await link();
      expect(issued.outcome).toBe("issued");
      await older(false);
      expect(
        await consumePasswordReset(db, {
          tokenHash: issued.tokenHash,
          passwordHash: HASH,
          receiptId: randomUUID(),
        }),
      ).toBeNull();
      const [unused] = await db
        .select({ usedAt: passwordResets.usedAt })
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, issued.tokenHash));
      expect(unused?.usedAt).toBeNull();
      expect((await settingsRow()).emergencyAdminUserId).toBe(first);

      // Named while that membership is off, they keep it off.
      await older(true);
      expect((await name()).outcome).toBe("changed");
      expect(
        await createPostgresMemberStore(db).setAccess({
          actor: {
            ...acting(boss.id),
            workspaceId: elsewhere,
            principal: {
              ...acting(boss.id).principal,
              ownerId: elsewhere,
              actor: {
                ...acting(boss.id).principal.actor,
                workspaceId: elsewhere,
              },
            },
          },
          userId: split.id,
          scope: "membership",
          disabled: false,
          reason: null,
          receiptId: randomUUID(),
        }),
      ).toEqual({ outcome: "emergency_admin" });
      // An invite there would turn it on the same way, and is not spent.
      const inviteToken = newHash();
      await db.insert(invites).values({
        id: randomUUID(),
        workspaceId: elsewhere,
        email: split.email,
        role: "member",
        tokenHash: inviteToken,
        invitedBy: boss.id,
        expiresAt: fromDbNow(60_000),
      });
      expect(
        await createPostgresInviteStore(db).acceptInvite({
          tokenHash: inviteToken,
          account: {
            kind: "existing",
            userId: split.id,
            verifiedPasswordHash: HASH,
          },
          session: {
            id: randomUUID(),
            tokenHash: newHash(),
            ttlMs: 60_000,
            userAgent: null,
            maxLive: 5,
          },
          receiptId: randomUUID(),
        }),
      ).toEqual({ outcome: "emergency_admin" });
      const [invite] = await db
        .select({ acceptedAt: invites.acceptedAt })
        .from(invites)
        .where(eq(invites.tokenHash, inviteToken));
      expect(invite?.acceptedAt).toBeNull();
      expect(await findLiveMembership(db, split.id)).toEqual({
        workspaceId,
        role: "owner",
      });
    } finally {
      await db
        .update(loginSettings)
        .set({ passwordLogin: "on", emergencyAdminUserId: first });
      await db.delete(invites).where(eq(invites.workspaceId, elsewhere));
      await db
        .delete(passwordResets)
        .where(eq(passwordResets.workspaceId, elsewhere));
      await db
        .delete(memberships)
        .where(eq(memberships.workspaceId, elsewhere));
    }
  });
});
