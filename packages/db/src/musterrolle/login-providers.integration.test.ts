import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { type ExternalSignInResult, SecretKey } from "@werft-ai/platform";
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
  loginMethods,
  loginProviders,
  users,
  webSessions,
  workspaces,
} from "../schema.ts";
import { seedLoginProvider } from "../testing/login-provider.ts";
import {
  createWebSession,
  resolveWebSession,
  signInWithExternalIdentity,
} from "./identity.ts";
import {
  createPostgresLoginProviderStore,
  disableLoginProvider,
} from "./login-providers.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const KEY = SecretKey.fromHex("ab".repeat(32), "test");
const OTHER_KEY = SecretKey.fromHex("cd".repeat(32), "test");
const PASSWORD_HASH = "argon2id$placeholder";

integration("login providers", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  let issuerCount = 0;
  const newIssuer = () => `https://idp-${++issuerCount}.example.test`;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "login_providers" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  type Provider = Awaited<ReturnType<typeof seedLoginProvider>>;

  const signIn = (
    provider: Pick<Provider, "id" | "issuer" | "configRevision">,
    subject: string,
    email: string,
  ) => {
    const tokenHash = createHash("sha256").update(randomUUID()).digest();
    return signInWithExternalIdentity(db, {
      kind: "oidc",
      provider: { id: provider.id, configRevision: provider.configRevision },
      issuer: provider.issuer,
      subject,
      email,
      displayName: subject,
      jitRole: "member",
      ownsEmail: true,
      newUserId: randomUUID(),
      newLoginMethodId: randomUUID(),
      receiptId: randomUUID(),
      session: {
        id: randomUUID(),
        tokenHash,
        ttlMs: 60_000,
        userAgent: null,
        maxLive: 5,
      },
    }).then((result) => ({ result, tokenHash }));
  };

  const userIdOf = (result: ExternalSignInResult) => {
    if (result.outcome !== "signed_in") {
      throw new Error(`sign-in ended ${result.outcome}`);
    }
    return result.userId;
  };

  /** Live sessions made by a login method of this issuer. */
  const liveSessionsOf = async (issuer: string) =>
    (
      await db
        .select({ id: webSessions.id })
        .from(webSessions)
        .innerJoin(loginMethods, eq(loginMethods.id, webSessions.loginMethodId))
        .where(
          and(eq(loginMethods.issuer, issuer), isNull(webSessions.revokedAt)),
        )
    ).length;

  const isEnabled = async (id: string) =>
    (
      await db
        .select({ enabled: loginProviders.enabled })
        .from(loginProviders)
        .where(eq(loginProviders.id, id))
    )[0]?.enabled;

  /** Resolves once `count` statements of this database wait on a lock. */
  const lockWaiters = async (count: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await pool.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if ((rows[0]?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`fewer than ${count} statements wait on a lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  describe("the store", () => {
    test("lists only the providers that are turned on, oldest first", async () => {
      const store = createPostgresLoginProviderStore(db, KEY);
      const first = await seedLoginProvider(db, {
        issuer: newIssuer(),
        displayName: "First",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      const off = await seedLoginProvider(db, {
        issuer: newIssuer(),
        displayName: "Off",
        enabled: false,
      });
      const second = await seedLoginProvider(db, {
        issuer: newIssuer(),
        displayName: "Second",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      });
      const listed = await store.listEnabled();
      const ids = listed.map((provider) => provider.id);
      expect(ids).not.toContain(off.id);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      expect(listed.find((provider) => provider.id === first.id)).toEqual({
        id: first.id,
        displayName: "First",
      });
    });

    test("reads a provider with its client secret; without one, or under another key, the secret is null", async () => {
      const withSecret = await seedLoginProvider(
        db,
        { issuer: newIssuer(), allowedDomains: ["example.com"] },
        { key: KEY, value: "s3cret-value" },
      );
      const bare = await seedLoginProvider(db, { issuer: newIssuer() });
      const store = createPostgresLoginProviderStore(db, KEY);

      const found = await store.findForSignIn(withSecret.id);
      expect(found?.clientSecret).toBe("s3cret-value");
      expect(found?.provider).toMatchObject({
        id: withSecret.id,
        issuer: withSecret.issuer,
        clientId: "test-client",
        allowedDomains: ["example.com"],
        enabled: true,
        configRevision: 1,
      });
      expect((await store.findForSignIn(bare.id))?.clientSecret).toBeNull();
      expect(
        (
          await createPostgresLoginProviderStore(db, OTHER_KEY).findForSignIn(
            withSecret.id,
          )
        )?.clientSecret,
      ).toBeNull();
      expect(await store.findForSignIn(randomUUID())).toBeNull();
    });

    test("one issuer has one provider", async () => {
      const issuer = newIssuer();
      await seedLoginProvider(db, { issuer });
      await expect(seedLoginProvider(db, { issuer })).rejects.toThrow();
    });

    test("a provider with no client id cannot be turned on", async () => {
      await expect(
        seedLoginProvider(db, { issuer: newIssuer(), clientId: null }),
      ).rejects.toThrow();
    });
  });

  describe("signing in", () => {
    test("a provider that is off, changed or of another issuer makes no account and no session", async () => {
      const off = await seedLoginProvider(db, {
        issuer: newIssuer(),
        enabled: false,
      });
      const on = await seedLoginProvider(db, { issuer: newIssuer() });
      const attempts = [
        await signIn(off, "sub-off", "off@example.com"),
        // The flow started on settings that have since changed.
        await signIn(
          { ...on, configRevision: on.configRevision + 1 },
          "sub-stale",
          "stale@example.com",
        ),
        // The provider id names a row of a different issuer.
        await signIn(
          { ...on, issuer: off.issuer },
          "sub-cross",
          "cross@example.com",
        ),
        await signIn(
          { ...on, id: randomUUID() },
          "sub-gone",
          "gone@example.com",
        ),
      ];
      expect(attempts.map((attempt) => attempt.result.outcome)).toEqual([
        "provider_off",
        "provider_off",
        "provider_off",
        "provider_off",
      ]);
      for (const email of [
        "off@example.com",
        "stale@example.com",
        "cross@example.com",
        "gone@example.com",
      ]) {
        expect(await db.$count(users, eq(users.email, email))).toBe(0);
      }
      for (const attempt of attempts) {
        expect(await resolveWebSession(db, attempt.tokenHash)).toBeNull();
      }
    });

    test("the same (issuer, subject) is the same user whatever address it brings", async () => {
      const provider = await seedLoginProvider(db, { issuer: newIssuer() });
      const first = await signIn(provider, "sub-same", "before@example.com");
      const later = await signIn(provider, "sub-same", "after@example.com");
      expect(later.result).toMatchObject({
        outcome: "signed_in",
        via: "linked",
        userId: userIdOf(first.result),
      });
      expect(await db.$count(users, eq(users.email, "after@example.com"))).toBe(
        0,
      );
    });

    test("the same address from another issuer is not joined to the account", async () => {
      const home = await seedLoginProvider(db, { issuer: newIssuer() });
      const other = await seedLoginProvider(db, { issuer: newIssuer() });
      const owner = await signIn(home, "sub-home", "shared@example.com");
      const userId = userIdOf(owner.result);

      const intruder = await signIn(other, "sub-home", "shared@example.com");
      expect(intruder.result).toEqual({ outcome: "link_required" });
      expect(await resolveWebSession(db, intruder.tokenHash)).toBeNull();
      expect(
        await db
          .select({ issuer: loginMethods.issuer })
          .from(loginMethods)
          .where(eq(loginMethods.userId, userId)),
      ).toEqual([{ issuer: home.issuer }]);
      expect(await liveSessionsOf(other.issuer)).toBe(0);
    });
  });

  describe("turning a provider off", () => {
    test("ends that provider's sessions in the same transaction and no others", async () => {
      const target = await seedLoginProvider(db, { issuer: newIssuer() });
      const bystander = await seedLoginProvider(db, { issuer: newIssuer() });
      const one = await signIn(target, "sub-1", "one@example.com");
      const two = await signIn(target, "sub-2", "two@example.com");
      const again = await signIn(target, "sub-1", "one@example.com");
      const other = await signIn(bystander, "sub-1", "other@example.com");

      // The first user also has a password and a session made with it.
      const userId = userIdOf(one.result);
      await db
        .update(users)
        .set({ passwordHash: PASSWORD_HASH })
        .where(eq(users.id, userId));
      const passwordToken = createHash("sha256").update(randomUUID()).digest();
      expect(
        await createWebSession(db, {
          id: randomUUID(),
          userId,
          verifiedPasswordHash: PASSWORD_HASH,
          tokenHash: passwordToken,
          ttlMs: 60_000,
          userAgent: null,
          maxLive: 5,
        }),
      ).not.toBeNull();

      expect(await disableLoginProvider(db, target.id)).toEqual({
        sessionsRevoked: 3,
      });
      expect(await isEnabled(target.id)).toBe(false);
      for (const ended of [one, two, again]) {
        expect(await resolveWebSession(db, ended.tokenHash)).toBeNull();
      }
      expect(await resolveWebSession(db, other.tokenHash)).not.toBeNull();
      expect((await resolveWebSession(db, passwordToken))?.userId).toBe(userId);
      expect(await isEnabled(bystander.id)).toBe(true);

      // Off already: nothing left to end, and no later sign-in.
      expect(await disableLoginProvider(db, target.id)).toEqual({
        sessionsRevoked: 0,
      });
      expect((await signIn(target, "sub-1", "one@example.com")).result).toEqual(
        { outcome: "provider_off" },
      );
      expect(await disableLoginProvider(db, randomUUID())).toBeNull();
    });

    test("waits for a sign-in already under way and ends the session it makes", async () => {
      const provider = await seedLoginProvider(db, { issuer: newIssuer() });
      const known = await signIn(provider, "sub-held", "held@example.com");
      const userId = userIdOf(known.result);

      // Hold the user row, so the sign-in stops after it has read the
      // provider row and before it writes its session.
      const holder = await pool.connect();
      let signingIn: ReturnType<typeof signIn>;
      let disabling: ReturnType<typeof disableLoginProvider>;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
          userId,
        ]);
        signingIn = signIn(provider, "sub-held", "held@example.com");
        await lockWaiters(1);
        disabling = disableLoginProvider(db, provider.id);
        await lockWaiters(2);
        // Neither has finished: the provider is still on.
        expect(await isEnabled(provider.id)).toBe(true);
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }
      const [signedIn, disabled] = await Promise.all([signingIn, disabling]);
      expect(signedIn.result.outcome).toBe("signed_in");
      // Both sessions of this user: the earlier one and the one made while
      // the provider was being turned off.
      expect(disabled).toEqual({ sessionsRevoked: 2 });
      expect(await resolveWebSession(db, signedIn.tokenHash)).toBeNull();
      expect(await liveSessionsOf(provider.issuer)).toBe(0);
    });

    test("a sign-in that waits behind it finds the provider off and makes no session", async () => {
      const provider = await seedLoginProvider(db, { issuer: newIssuer() });
      await signIn(provider, "sub-late", "late@example.com");

      // The provider row is being changed by a transaction not yet done.
      const holder = await pool.connect();
      let signingIn: ReturnType<typeof signIn>;
      try {
        await holder.query("BEGIN");
        await holder.query(
          "UPDATE login_providers SET enabled = false WHERE id = $1",
          [provider.id],
        );
        signingIn = signIn(provider, "sub-late", "late@example.com");
        await lockWaiters(1);
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }
      const late = await signingIn;
      expect(late.result).toEqual({ outcome: "provider_off" });
      expect(await resolveWebSession(db, late.tokenHash)).toBeNull();
    });

    test("raced against sign-ins, no order leaves a live session of a provider that is off", async () => {
      for (let round = 0; round < 12; round++) {
        const provider = await seedLoginProvider(db, { issuer: newIssuer() });
        const email = `race-${round}@example.com`;
        await signIn(provider, "sub-race", email);
        const [, , disabled] = await Promise.all([
          signIn(provider, "sub-race", email),
          signIn(provider, "sub-race-new", `new-${round}@example.com`),
          disableLoginProvider(db, provider.id),
        ]);
        expect(disabled).not.toBeNull();
        expect(await isEnabled(provider.id)).toBe(false);
        expect(await liveSessionsOf(provider.issuer)).toBe(0);
      }
    }, 60_000);
  });
});
