import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { MembershipRole } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  invites,
  loginMethods,
  loginProviders,
  memberships,
  receipts,
  users,
  webSessions,
  workspaces,
} from "../schema.ts";
import { seedLoginProvider } from "../testing/login-provider.ts";
import { signInWithExternalIdentity } from "./identity.ts";
import { createPostgresLoginMethodStore } from "./login-methods.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const ISSUER_A = "https://a.idp.example.com";
const ISSUER_B = "https://b.idp.example.com";

integration("a person's ways to sign in", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: ReturnType<typeof createPostgresLoginMethodStore>;
  const workspaceId = randomUUID();
  type Provider = Awaited<ReturnType<typeof seedLoginProvider>>;
  let providerA: Provider;
  let providerB: Provider;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "login_methods" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresLoginMethodStore(db);
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    providerA = await seedLoginProvider(db, {
      issuer: ISSUER_A,
      displayName: "A",
    });
    providerB = await seedLoginProvider(db, {
      issuer: ISSUER_B,
      displayName: "B",
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const newHash = () => createHash("sha256").update(randomUUID()).digest();
  const flowOf = (provider: Provider) => ({
    id: provider.id,
    configRevision: provider.configRevision,
  });

  /** A person with a password, as an accepted password invite leaves one. */
  const person = async (email: string, role: MembershipRole = "member") => {
    const id = randomUUID();
    const passwordMethodId = randomUUID();
    await db.insert(users).values({
      id,
      email,
      passwordHash: "argon2id$placeholder",
      displayName: email,
    });
    await db.insert(memberships).values({ workspaceId, userId: id, role });
    await db
      .insert(loginMethods)
      .values({ id: passwordMethodId, userId: id, kind: "password" });
    return { id, passwordMethodId };
  };
  const invite = async (email: string, ttlMs = 60_000) => {
    const inviter =
      (await userByEmail("inviter@example.com"))?.id ??
      (await person("inviter@example.com", "owner")).id;
    const id = randomUUID();
    await db.insert(invites).values({
      id,
      workspaceId,
      email,
      role: "member",
      tokenHash: createHash("sha256").update(id).digest(),
      invitedBy: inviter,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return id;
  };
  const signUp = (inviteId: string, subject: string, provider = providerA) =>
    store.signUpWithInvite({
      provider: flowOf(provider),
      inviteId,
      issuer: provider.issuer,
      subject,
      vouchedEmail: null,
      name: null,
      newUserId: randomUUID(),
      newLoginMethodId: randomUUID(),
      receiptId: randomUUID(),
      session: {
        id: randomUUID(),
        tokenHash: newHash(),
        ttlMs: 60_000,
        userAgent: null,
        maxLive: 5,
      },
    });
  /** A live session, made `ageMs` ago with the given method. */
  const session = async (
    userId: string,
    loginMethodId: string | null,
    ageMs = 0,
  ) => {
    const id = randomUUID();
    await db.insert(webSessions).values({
      id,
      userId,
      tokenHash: newHash(),
      createdAt: new Date(Date.now() - ageMs),
      expiresAt: new Date(Date.now() + 3_600_000),
      loginMethodId,
    });
    return id;
  };
  const link = (
    userId: string,
    sessionId: string,
    subject: string,
    provider = providerA,
  ) =>
    store.link({
      provider: flowOf(provider),
      issuer: provider.issuer,
      subject,
      vouchedEmail: `${subject}@example.com`,
      userId,
      sessionId,
      workspaceId,
      newLoginMethodId: randomUUID(),
      receiptId: randomUUID(),
    });
  /** Asked from `asking`, or from a session the person has just made. */
  const unlink = async (
    userId: string,
    loginMethodId: string,
    asking?: string,
  ) =>
    store.unlink({
      userId,
      sessionId: asking ?? (await session(userId, null)),
      maxAgeMs: 10 * 60_000,
      loginMethodId,
      workspaceId,
      receiptId: randomUUID(),
    });
  /** Resolves once `count` transactions of this database wait on a lock. */
  const lockWaiters = async (count: number) => {
    for (let i = 0; i < 300; i += 1) {
      const { rows } = await pool.query<{ waiting: string }>(
        "SELECT count(*)::text AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (Number(rows[0]?.waiting) >= count) return;
      await Bun.sleep(10);
    }
    throw new Error(`fewer than ${count} transactions waited on a lock`);
  };
  const userByEmail = async (email: string) =>
    (await db.select().from(users).where(eq(users.email, email)))[0];
  const inviteRow = async (id: string) =>
    (await db.select().from(invites).where(eq(invites.id, id)))[0];
  const methodsOf = (userId: string) =>
    db.select().from(loginMethods).where(eq(loginMethods.userId, userId));
  const liveSessionsOf = (loginMethodId: string) =>
    db.$count(
      webSessions,
      and(
        eq(webSessions.loginMethodId, loginMethodId),
        isNull(webSessions.revokedAt),
      ),
    );
  const setEnabled = (provider: Provider, enabled: boolean) =>
    db
      .update(loginProviders)
      .set({ enabled })
      .where(eq(loginProviders.id, provider.id));

  describe("sign-up by invite", () => {
    test("the invite makes the account, with its own address and role and no password", async () => {
      const inviteId = await invite("bob@example.com");
      const result = await signUp(inviteId, "sub-bob");
      expect(result).toMatchObject({
        outcome: "signed_in",
        workspaceId,
        role: "member",
      });
      const bob = await userByEmail("bob@example.com");
      expect(bob).toMatchObject({ passwordHash: null, displayName: "bob" });
      const [method] = await methodsOf(bob?.id ?? "");
      expect(method).toMatchObject({
        kind: "oidc",
        issuer: ISSUER_A,
        subject: "sub-bob",
        // The provider vouched for no address: none is recorded.
        emailAtLink: null,
      });
      expect((await inviteRow(inviteId))?.acceptedAt).not.toBeNull();
      expect(await liveSessionsOf(method?.id ?? "")).toBe(1);
      const written = await db
        .select()
        .from(receipts)
        .where(eq(receipts.operation, "accept_invite"));
      expect(written).toHaveLength(1);
      expect(written[0]?.result).toMatchObject({
        user_id: bob?.id,
        new_account: true,
        login_method: "oidc",
        issuer: ISSUER_A,
      });
    });

    test("a dead invite signs nobody in, an account that is linked already included", async () => {
      const used = (
        await db
          .select({ id: invites.id })
          .from(invites)
          .where(eq(invites.email, "bob@example.com"))
      )[0]?.id;
      const expired = await invite("late@example.com", -1_000);
      const revoked = await invite("gone@example.com");
      await db
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(eq(invites.id, revoked));
      const sessionsBefore = await db.$count(webSessions);
      // sub-bob is bob's: a spent invite still does not sign bob in.
      expect(await signUp(used ?? "", "sub-bob")).toEqual({
        outcome: "invite_gone",
      });
      expect(await signUp(expired, "sub-late")).toEqual({
        outcome: "invite_gone",
      });
      expect(await signUp(revoked, "sub-gone")).toEqual({
        outcome: "invite_gone",
      });
      expect(await signUp(randomUUID(), "sub-nobody")).toEqual({
        outcome: "invite_gone",
      });
      expect(await db.$count(webSessions)).toBe(sessionsBefore);
      expect(await userByEmail("late@example.com")).toBeUndefined();
      expect(await userByEmail("gone@example.com")).toBeUndefined();
    });

    test("an account somebody has is refused, and the invite is not spent", async () => {
      const inviteId = await invite("carol@example.com");
      const sessionsBefore = await db.$count(webSessions);
      expect(await signUp(inviteId, "sub-bob")).toEqual({
        outcome: "already_linked",
      });
      expect((await inviteRow(inviteId))?.acceptedAt).toBeNull();
      expect(await userByEmail("carol@example.com")).toBeUndefined();
      expect(await db.$count(webSessions)).toBe(sessionsBefore);
    });

    test("an address that has an account is never joined to the provider's account", async () => {
      const dave = await person("dave@example.com");
      const inviteId = await invite("dave@example.com");
      const sessionsBefore = await db.$count(webSessions);
      expect(await signUp(inviteId, "sub-dave")).toEqual({
        outcome: "link_required",
      });
      expect((await inviteRow(inviteId))?.acceptedAt).toBeNull();
      expect((await methodsOf(dave.id)).map((row) => row.kind)).toEqual([
        "password",
      ]);
      expect(await db.$count(webSessions)).toBe(sessionsBefore);
    });

    test("a provider turned off, or changed since the flow started, ends the sign-up", async () => {
      const inviteId = await invite("erin@example.com");
      const stale = store.signUpWithInvite({
        provider: {
          id: providerA.id,
          configRevision: providerA.configRevision + 1,
        },
        inviteId,
        issuer: ISSUER_A,
        subject: "sub-erin",
        vouchedEmail: null,
        name: null,
        newUserId: randomUUID(),
        newLoginMethodId: randomUUID(),
        receiptId: randomUUID(),
        session: {
          id: randomUUID(),
          tokenHash: newHash(),
          ttlMs: 60_000,
          userAgent: null,
          maxLive: 5,
        },
      });
      expect(await stale).toEqual({ outcome: "provider_off" });
      await setEnabled(providerA, false);
      try {
        expect(await signUp(inviteId, "sub-erin")).toEqual({
          outcome: "provider_off",
        });
      } finally {
        await setEnabled(providerA, true);
      }
      expect((await inviteRow(inviteId))?.acceptedAt).toBeNull();
      expect(await userByEmail("erin@example.com")).toBeUndefined();
    });

    test("an invite that expires while the sign-up waits leaves no account behind", async () => {
      const inviteId = await invite("jo@example.com", 1_000);
      const holder = await pool.connect();
      try {
        // Another transaction is writing the same address: the sign-up's own
        // insert waits for it, past the invite's expiry.
        await holder.query("BEGIN");
        await holder.query(
          "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)",
          [randomUUID(), "jo@example.com", "Jo"],
        );
        const pending = signUp(inviteId, "sub-jo");
        await Bun.sleep(1_600);
        await holder.query("ROLLBACK");
        expect(await pending).toEqual({ outcome: "invite_gone" });
      } finally {
        holder.release();
      }
      expect(await userByEmail("jo@example.com")).toBeUndefined();
      expect(
        await db.$count(loginMethods, eq(loginMethods.subject, "sub-jo")),
      ).toBe(0);
    });

    test("an invite that expires behind a row lock nobody changed signs nobody in, a linked account included", async () => {
      const inviteId = await invite("kay@example.com", 700);
      const holder = await pool.connect();
      try {
        // Held and left as it was: the sign-up's own read of the row is not
        // judged again when the lock is given.
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM invites WHERE id = $1 FOR UPDATE", [
          inviteId,
        ]);
        // sub-bob is bob's.
        const pending = signUp(inviteId, "sub-bob");
        await lockWaiters(1);
        await Bun.sleep(900);
        await holder.query("COMMIT");
        expect(await pending).toEqual({ outcome: "invite_gone" });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect(await userByEmail("kay@example.com")).toBeUndefined();
    });

    test("one invite makes one account, and one external account joins once", async () => {
      const shared = await invite("frank@example.com");
      const sameInvite = await Promise.all([
        signUp(shared, "sub-frank-1"),
        signUp(shared, "sub-frank-2"),
      ]);
      expect(sameInvite.map((result) => result.outcome).sort()).toEqual([
        "invite_gone",
        "signed_in",
      ]);
      const [first, second] = await Promise.all([
        invite("gail@example.com"),
        invite("hana@example.com"),
      ]);
      const sameAccount = await Promise.all([
        signUp(first ?? "", "sub-twice"),
        signUp(second ?? "", "sub-twice"),
      ]);
      expect(sameAccount.map((result) => result.outcome).sort()).toEqual([
        "already_linked",
        "signed_in",
      ]);
      expect(
        await db.$count(loginMethods, eq(loginMethods.subject, "sub-twice")),
      ).toBe(1);
    });
  });

  describe("linking from a session", () => {
    test("a link adds the account to the session's user and makes no session", async () => {
      const ivy = await person("ivy@example.com");
      const sessionId = await session(ivy.id, ivy.passwordMethodId);
      const result = await link(ivy.id, sessionId, "sub-ivy");
      expect(result).toMatchObject({ outcome: "linked" });
      const linked = (await methodsOf(ivy.id)).find(
        (row) => row.kind === "oidc",
      );
      expect(linked).toMatchObject({
        issuer: ISSUER_A,
        subject: "sub-ivy",
        emailAtLink: "sub-ivy@example.com",
      });
      expect(await db.$count(webSessions, eq(webSessions.userId, ivy.id))).toBe(
        1,
      );
      const written = await db
        .select()
        .from(receipts)
        .where(eq(receipts.operation, "link_login_method"));
      expect(written).toHaveLength(1);
      expect(written[0]?.actor).toMatchObject({ actor_user_id: ivy.id });
      expect(written[0]?.result).toMatchObject({
        login_method_id: linked?.id,
        provider_id: providerA.id,
        issuer: ISSUER_A,
      });
    });

    test("refused: an account somebody has, a second account of the issuer, a session that ended, a provider that is off", async () => {
      const ivy = await userByEmail("ivy@example.com");
      const ken = await person("ken@example.com");
      const kenSession = await session(ken.id, ken.passwordMethodId);
      const ivySession = await session(ivy?.id ?? "", null);
      // Ivy's account, asked for by Ken, and by Ivy again.
      expect(await link(ken.id, kenSession, "sub-ivy")).toEqual({
        outcome: "already_linked",
      });
      expect(await link(ivy?.id ?? "", ivySession, "sub-ivy")).toEqual({
        outcome: "already_linked",
      });
      expect(await link(ivy?.id ?? "", ivySession, "sub-ivy-other")).toEqual({
        outcome: "issuer_linked",
      });
      // Somebody else's session does not carry a link for Ken.
      expect(await link(ken.id, ivySession, "sub-ken")).toEqual({
        outcome: "session_gone",
      });
      await db
        .update(webSessions)
        .set({ revokedAt: new Date() })
        .where(eq(webSessions.id, kenSession));
      expect(await link(ken.id, kenSession, "sub-ken")).toEqual({
        outcome: "session_gone",
      });
      const kenAgain = await session(ken.id, ken.passwordMethodId);
      await setEnabled(providerA, false);
      try {
        expect(await link(ken.id, kenAgain, "sub-ken")).toEqual({
          outcome: "provider_off",
        });
      } finally {
        await setEnabled(providerA, true);
      }
      expect((await methodsOf(ken.id)).map((row) => row.kind)).toEqual([
        "password",
      ]);
      // Another issuer is another link.
      expect(
        await link(ivy?.id ?? "", ivySession, "sub-ivy-b", providerB),
      ).toMatchObject({ outcome: "linked" });
    });

    test("a session is fresh for as long as asked, and only its own user's", async () => {
      const lee = await person("lee@example.com");
      const other = await person("lee.other@example.com");
      const fresh = await session(lee.id, lee.passwordMethodId, 60_000);
      const old = await session(lee.id, lee.passwordMethodId, 11 * 60_000);
      const ask = (sessionId: string, userId = lee.id) =>
        store.sessionIsFresh({ sessionId, userId, maxAgeMs: 10 * 60_000 });
      expect(await ask(fresh)).toBe(true);
      expect(await ask(old)).toBe(false);
      expect(await ask(fresh, other.id)).toBe(false);
      await db
        .update(webSessions)
        .set({ revokedAt: new Date() })
        .where(eq(webSessions.id, fresh));
      expect(await ask(fresh)).toBe(false);
    });
  });

  describe("listing", () => {
    test("says which ways work now and which providers can still be linked", async () => {
      const ivy = await userByEmail("ivy@example.com");
      const mia = await person("mia@example.com");
      await setEnabled(providerB, false);
      try {
        const mine = await store.list(ivy?.id ?? "");
        expect(
          mine.methods.map((method) => [
            method.kind,
            method.provider?.displayName ?? null,
            method.usable,
          ]),
        ).toEqual([
          ["password", null, true],
          ["oidc", "A", true],
          // Linked, but its provider is off.
          ["oidc", "B", false],
        ]);
        expect(mine.linkable).toEqual([]);
        expect((await store.list(mia.id)).linkable).toEqual([
          { id: providerA.id, displayName: "A" },
        ]);
      } finally {
        await setEnabled(providerB, true);
      }
      expect(
        (await store.list(mia.id)).linkable.map((row) => row.displayName),
      ).toEqual(["A", "B"]);
    });
  });

  describe("removing", () => {
    test("ends the sessions made with it and leaves the others", async () => {
      const ivy = await userByEmail("ivy@example.com");
      const methods = await methodsOf(ivy?.id ?? "");
      const viaA = methods.find((row) => row.issuer === ISSUER_A);
      const password = methods.find((row) => row.kind === "password");
      await session(ivy?.id ?? "", viaA?.id ?? "");
      await session(ivy?.id ?? "", viaA?.id ?? "");
      const passwordSessions = await liveSessionsOf(password?.id ?? "");
      expect(await unlink(ivy?.id ?? "", viaA?.id ?? "")).toEqual({
        outcome: "unlinked",
        sessionsRevoked: 2,
      });
      expect(await liveSessionsOf(viaA?.id ?? "")).toBe(0);
      expect(await liveSessionsOf(password?.id ?? "")).toBe(passwordSessions);
      expect(
        (await methodsOf(ivy?.id ?? "")).some((row) => row.id === viaA?.id),
      ).toBe(false);
      const written = await db
        .select()
        .from(receipts)
        .where(eq(receipts.operation, "unlink_login_method"));
      expect(written).toHaveLength(1);
      expect(written[0]?.actor).toMatchObject({ actor_user_id: ivy?.id });
      expect(written[0]?.result).toMatchObject({
        login_method_id: viaA?.id,
        kind: "oidc",
        issuer: ISSUER_A,
        sessions_revoked: 2,
      });
    });

    test("the last way that works stays; a provider that is off does not count as one", async () => {
      // Ivy now has a password and an account of B.
      const ivy = await userByEmail("ivy@example.com");
      const methods = await methodsOf(ivy?.id ?? "");
      const viaB = methods.find((row) => row.issuer === ISSUER_B);
      const password = methods.find((row) => row.kind === "password");
      await setEnabled(providerB, false);
      try {
        expect(await unlink(ivy?.id ?? "", password?.id ?? "")).toEqual({
          outcome: "last_method",
        });
      } finally {
        await setEnabled(providerB, true);
      }
      expect(
        (await userByEmail("ivy@example.com"))?.passwordHash,
      ).not.toBeNull();
      // With B on, the password can go, and the hash goes with it.
      const passwordSession = await session(ivy?.id ?? "", password?.id ?? "");
      expect(await unlink(ivy?.id ?? "", password?.id ?? "")).toMatchObject({
        outcome: "unlinked",
      });
      expect((await userByEmail("ivy@example.com"))?.passwordHash).toBeNull();
      expect(
        (
          await db
            .select({ revokedAt: webSessions.revokedAt })
            .from(webSessions)
            .where(eq(webSessions.id, passwordSession))
        )[0]?.revokedAt,
      ).not.toBeNull();
      // B is all that is left.
      expect(await unlink(ivy?.id ?? "", viaB?.id ?? "")).toEqual({
        outcome: "last_method",
      });
      expect(await methodsOf(ivy?.id ?? "")).toHaveLength(1);
    });

    test("only the person's own way, by its id", async () => {
      const ivy = await userByEmail("ivy@example.com");
      const ken = await userByEmail("ken@example.com");
      const [kens] = await methodsOf(ken?.id ?? "");
      expect(await unlink(ivy?.id ?? "", kens?.id ?? "")).toEqual({
        outcome: "not_found",
      });
      expect(await unlink(ivy?.id ?? "", randomUUID())).toEqual({
        outcome: "not_found",
      });
      expect(await methodsOf(ken?.id ?? "")).toHaveLength(1);
    });

    test("a provider being turned off as the password is removed leaves the password", async () => {
      const noa = await person("noa@example.com");
      const noaSession = await session(noa.id, noa.passwordMethodId);
      expect(
        await link(noa.id, noaSession, "sub-noa", providerB),
      ).toMatchObject({ outcome: "linked" });
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "UPDATE login_providers SET enabled = false WHERE id = $1",
          [providerB.id],
        );
        const pending = unlink(noa.id, noa.passwordMethodId);
        await Bun.sleep(400);
        await holder.query("COMMIT");
        expect(await pending).toEqual({ outcome: "last_method" });
      } finally {
        holder.release();
        await setEnabled(providerB, true);
      }
      expect(
        (await userByEmail("noa@example.com"))?.passwordHash,
      ).not.toBeNull();
    });

    test("a removal that waited behind a password reset finds its session ended and undoes nothing", async () => {
      const pat = await person("pat@example.com");
      const asking = await session(pat.id, pat.passwordMethodId);
      // Another way in, so the password is not the last one.
      expect(await link(pat.id, asking, "sub-pat", providerB)).toMatchObject({
        outcome: "linked",
      });
      const holder = await pool.connect();
      let pending: ReturnType<typeof unlink>;
      try {
        // What a reset does, in its order: the user row, the new hash, every
        // session of the user ended.
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
          pat.id,
        ]);
        pending = unlink(pat.id, pat.passwordMethodId, asking);
        await lockWaiters(1);
        await holder.query(
          "UPDATE users SET password_hash = 'argon2id$reset' WHERE id = $1",
          [pat.id],
        );
        await holder.query(
          "UPDATE web_sessions SET revoked_at = now() WHERE user_id = $1",
          [pat.id],
        );
        await holder.query("COMMIT");
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect(await pending).toEqual({ outcome: "session_gone" });
      expect((await userByEmail("pat@example.com"))?.passwordHash).toBe(
        "argon2id$reset",
      );
      expect(await methodsOf(pat.id)).toHaveLength(2);
    });

    test("a session left open, and a disabled person's, remove nothing", async () => {
      const quin = await person("quin@example.com");
      const fresh = await session(quin.id, quin.passwordMethodId);
      expect(await link(quin.id, fresh, "sub-quin", providerB)).toMatchObject({
        outcome: "linked",
      });
      const old = await session(quin.id, quin.passwordMethodId, 11 * 60_000);
      expect(await unlink(quin.id, quin.passwordMethodId, old)).toEqual({
        outcome: "session_gone",
      });
      // Somebody else's session does not ask for Quin.
      const other = await person("quin.other@example.com");
      const theirs = await session(other.id, other.passwordMethodId);
      expect(await unlink(quin.id, quin.passwordMethodId, theirs)).toEqual({
        outcome: "session_gone",
      });
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, quin.id));
      expect(await unlink(quin.id, quin.passwordMethodId, fresh)).toEqual({
        outcome: "session_gone",
      });
      expect(await methodsOf(quin.id)).toHaveLength(2);
    });

    // Both stand in line at the user row. Held, the row lets the test say
    // which of the two is first in that line.
    for (const first of ["sign-in", "removal"] as const) {
      test(`a sign-in with the way being removed leaves no session of it: the ${first} first`, async () => {
        const subject = `sub-race-${first}`;
        const racer = await person(`race-${first}@example.com`);
        const racerSession = await session(racer.id, racer.passwordMethodId);
        const linked = await link(racer.id, racerSession, subject);
        if (linked.outcome !== "linked") throw new Error(linked.outcome);
        const signIn = () =>
          signInWithExternalIdentity(db, {
            kind: "oidc",
            provider: flowOf(providerA),
            issuer: ISSUER_A,
            subject,
            email: null,
            displayName: subject,
            jitRole: null,
            ownsEmail: false,
            newUserId: randomUUID(),
            newLoginMethodId: randomUUID(),
            receiptId: randomUUID(),
            session: {
              id: randomUUID(),
              tokenHash: newHash(),
              ttlMs: 60_000,
              userAgent: null,
              maxLive: 5,
            },
          });
        // Asked from a session made before the row is held: making one
        // would itself wait on the user row.
        const remove = () =>
          unlink(racer.id, linked.loginMethodId, racerSession);
        const holder = await pool.connect();
        let signedIn: ReturnType<typeof signIn>;
        let removed: ReturnType<typeof remove>;
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
            racer.id,
          ]);
          if (first === "sign-in") {
            signedIn = signIn();
            await lockWaiters(1);
            removed = remove();
          } else {
            removed = remove();
            await lockWaiters(1);
            signedIn = signIn();
          }
          await lockWaiters(2);
          await holder.query("COMMIT");
        } finally {
          // A no-op after the commit; after a failure it frees the row.
          await holder.query("ROLLBACK");
          holder.release();
        }
        expect((await removed).outcome).toBe("unlinked");
        // First, and the removal ended its session; or second, and the way
        // it had read before waiting is gone when it reads again.
        expect((await signedIn).outcome).toBe(
          first === "sign-in" ? "signed_in" : "rejected",
        );
        expect(await liveSessionsOf(linked.loginMethodId)).toBe(0);
        expect(
          await db.$count(
            webSessions,
            eq(webSessions.loginMethodId, linked.loginMethodId),
          ),
        ).toBe(first === "sign-in" ? 1 : 0);
        expect(
          await db.$count(loginMethods, eq(loginMethods.subject, subject)),
        ).toBe(0);
      });
    }
  });
});
