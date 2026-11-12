import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  type LoginProviderAdminStore,
  type LoginProviderEndpoints,
  type LoginProviderRecord,
  SecretKey,
} from "@werft-ai/platform";
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
  secretValues,
  users,
  webSessions,
  workspaces,
} from "../schema.ts";
import { signInWithExternalIdentity } from "./identity.ts";
import {
  createPostgresLoginProviderAdminStore,
  createPostgresLoginProviderStore,
} from "./login-providers.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const KEY = SecretKey.fromHex("ab".repeat(32), "test");
const FIRST_SECRET = "first-client-secret-1111";
const SECOND_SECRET = "second-client-secret-2222";

integration("login provider admin store", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let admin: LoginProviderAdminStore;
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  let issuerCount = 0;
  const newIssuer = () => `https://idp-${++issuerCount}.example.test`;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "login_provider_admin" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    await db.insert(users).values({
      id: ownerId,
      email: "owner@example.com",
      displayName: "Owner",
    });
    admin = createPostgresLoginProviderAdminStore(db, KEY);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const audit = () => ({
    userId: ownerId,
    workspaceId,
    receiptId: randomUUID(),
  });

  const endpointsOf = (
    issuer: string,
    over: Partial<LoginProviderEndpoints> = {},
  ): LoginProviderEndpoints => ({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`,
    userinfoEndpoint: null,
    signingAlgs: ["RS256"],
    issParameterRequired: false,
    pkceAdvertised: true,
    tokenAuthMethods: ["client_secret_basic", "client_secret_post"],
    ...over,
  });

  const make = async (displayName = "Keycloak") => {
    const made = await admin.create({
      id: randomUUID(),
      displayName,
      endpoints: endpointsOf(newIssuer()),
      audit: audit(),
    });
    if (made.outcome !== "created") throw new Error(made.outcome);
    return made.provider;
  };

  const current = async (id: string) => {
    const found = (await admin.list()).find((provider) => provider.id === id);
    if (!found) throw new Error("no such provider");
    return found;
  };

  /** A provider with a client id and a secret, not yet tested. */
  const configured = async () => {
    const made = await make();
    const withClient = await admin.update({
      id: made.id,
      ifMatch: made.revision,
      changes: { clientId: "client-1" },
      audit: audit(),
    });
    if (withClient.outcome !== "updated") throw new Error(withClient.outcome);
    const stored = await admin.setClientSecret({
      id: made.id,
      value: FIRST_SECRET,
      audit: audit(),
    });
    if (stored.outcome !== "stored") throw new Error(stored.outcome);
    return stored.provider;
  };

  /** Runs the store's side of a test sign-in that the provider accepted. */
  const passTest = async (id: string) => {
    const found = await admin.findForTest(id);
    if (!found?.clientSecret) throw new Error("nothing to test with");
    return admin.recordTest({
      id,
      configRevision: found.provider.configRevision,
      slot: found.slot,
      clientSecret: found.clientSecret,
      audit: audit(),
    });
  };

  /** A provider that is on. */
  const turnedOn = async () => {
    const provider = await configured();
    expect((await passTest(provider.id)).outcome).toBe("recorded");
    const enabled = await admin.enable({ id: provider.id, audit: audit() });
    if (enabled.outcome !== "enabled") throw new Error(enabled.outcome);
    return enabled.provider;
  };

  /** The sign-in itself, by an account whose address the provider vouches for. */
  const signIn = (
    target: Pick<LoginProviderRecord, "id" | "configRevision" | "issuer">,
    subject: string,
    email: string | null = `${subject}@example.com`,
    ownsEmail = true,
  ) =>
    signInWithExternalIdentity(db, {
      kind: "oidc",
      provider: { id: target.id, configRevision: target.configRevision },
      issuer: target.issuer,
      subject,
      email,
      displayName: subject,
      jitRole: ownsEmail ? "member" : null,
      ownsEmail,
      newUserId: randomUUID(),
      newLoginMethodId: randomUUID(),
      receiptId: randomUUID(),
      session: {
        id: randomUUID(),
        tokenHash: createHash("sha256").update(randomUUID()).digest(),
        ttlMs: 60_000,
        userAgent: null,
        maxLive: 5,
      },
    });

  const receiptsOf = async (providerId: string) =>
    (
      await db
        .select({
          operation: receipts.operation,
          result: receipts.result,
          actor: receipts.actor,
          ownerId: receipts.ownerId,
        })
        .from(receipts)
        .orderBy(receipts.createdAt)
    ).filter(
      (row) =>
        (row.result as { provider_id?: string } | null)?.provider_id ===
        providerId,
    );

  const signInSecret = async (id: string) =>
    (await createPostgresLoginProviderStore(db, KEY).findForSignIn(id))
      ?.clientSecret;

  test("a provider is made off, with what discovery named and the provider's default client authentication", async () => {
    const issuer = newIssuer();
    const made = await admin.create({
      id: randomUUID(),
      displayName: "Okta",
      endpoints: endpointsOf(issuer, {
        tokenAuthMethods: ["client_secret_post"],
        userinfoEndpoint: `${issuer}/userinfo`,
      }),
      audit: audit(),
    });
    if (made.outcome !== "created") throw new Error(made.outcome);
    expect(made.provider).toMatchObject({
      displayName: "Okta",
      issuer,
      tokenEndpoint: `${issuer}/token`,
      userinfoEndpoint: `${issuer}/userinfo`,
      tokenAuthMethod: "client_secret_post",
      clientId: null,
      clientSecret: null,
      pendingClientSecret: null,
      enabled: false,
      configRevision: 1,
      testedConfigRevision: null,
      revision: 1,
    });
    expect(
      (await createPostgresLoginProviderStore(db, KEY).listEnabled()).map(
        (provider) => provider.id,
      ),
    ).not.toContain(made.provider.id);

    const again = await admin.create({
      id: randomUUID(),
      displayName: "Okta again",
      endpoints: endpointsOf(issuer),
      audit: audit(),
    });
    expect(again.outcome).toBe("issuer_taken");
  });

  test("a change names the revision it was read at", async () => {
    const made = await make();
    const stale = await admin.update({
      id: made.id,
      ifMatch: made.revision + 1,
      changes: { displayName: "Renamed" },
      audit: audit(),
    });
    expect(stale).toEqual({ outcome: "stale", revision: made.revision });
    expect((await current(made.id)).displayName).toBe("Keycloak");
    expect(
      (
        await admin.update({
          id: randomUUID(),
          ifMatch: 1,
          changes: { displayName: "Renamed" },
          audit: audit(),
        })
      ).outcome,
    ).toBe("not_found");
  });

  test("a new name is not a new revision of the settings; a client id, a domain list or a policy is", async () => {
    const made = await make();
    const renamed = await admin.update({
      id: made.id,
      ifMatch: made.revision,
      changes: { displayName: "Renamed" },
      audit: audit(),
    });
    if (renamed.outcome !== "updated") throw new Error(renamed.outcome);
    expect(renamed.provider).toMatchObject({
      displayName: "Renamed",
      configRevision: 1,
      revision: 2,
    });

    let revision = renamed.provider.revision;
    let configRevision = 1;
    for (const changes of [
      { clientId: "client-1" },
      { tokenAuthMethod: "client_secret_post" as const },
      { allowedDomains: ["example.com"] },
      { jitRole: "member" as const },
      { requireVerifiedEmail: false },
    ]) {
      const updated = await admin.update({
        id: made.id,
        ifMatch: revision,
        changes,
        audit: audit(),
      });
      if (updated.outcome !== "updated") throw new Error(updated.outcome);
      configRevision += 1;
      revision += 1;
      expect(updated.provider).toMatchObject({
        ...changes,
        configRevision,
        revision,
      });
    }

    // Naming the values it already has changes nothing and leaves no receipt.
    const before = (await receiptsOf(made.id)).length;
    const same = await admin.update({
      id: made.id,
      ifMatch: revision,
      changes: { clientId: "client-1", allowedDomains: ["example.com"] },
      audit: audit(),
    });
    if (same.outcome !== "updated") throw new Error(same.outcome);
    expect(same.provider).toMatchObject({ configRevision, revision });
    expect((await receiptsOf(made.id)).length).toBe(before);
  });

  test("a provider cannot be turned on before a test sign-in passed with the settings it has now", async () => {
    const made = await make();
    expect((await admin.enable({ id: made.id, audit: audit() })).outcome).toBe(
      "not_ready",
    );

    const provider = await configured();
    expect(
      (await admin.enable({ id: provider.id, audit: audit() })).outcome,
    ).toBe("not_ready");

    expect((await passTest(provider.id)).outcome).toBe("recorded");
    const tested = await current(provider.id);
    expect(tested.testedConfigRevision).toBe(tested.configRevision);
    expect(tested.testedAt).not.toBeNull();

    // A change after the test: the pass no longer vouches for the settings.
    const changed = await admin.update({
      id: provider.id,
      ifMatch: tested.revision,
      changes: { allowedDomains: ["example.com"] },
      audit: audit(),
    });
    if (changed.outcome !== "updated") throw new Error(changed.outcome);
    expect(
      (await admin.enable({ id: provider.id, audit: audit() })).outcome,
    ).toBe("not_ready");

    expect((await passTest(provider.id)).outcome).toBe("recorded");
    const enabled = await admin.enable({ id: provider.id, audit: audit() });
    if (enabled.outcome !== "enabled") throw new Error(enabled.outcome);
    expect(enabled.provider.enabled).toBe(true);
    expect(
      (await createPostgresLoginProviderStore(db, KEY).listEnabled()).map(
        (listed) => listed.id,
      ),
    ).toContain(provider.id);
    expect(
      (await admin.enable({ id: randomUUID(), audit: audit() })).outcome,
    ).toBe("not_found");
  });

  test("a new secret after the test means another test before turning on", async () => {
    const provider = await configured();
    expect((await passTest(provider.id)).outcome).toBe("recorded");
    const replaced = await admin.setClientSecret({
      id: provider.id,
      value: SECOND_SECRET,
      audit: audit(),
    });
    if (replaced.outcome !== "stored") throw new Error(replaced.outcome);
    expect(replaced.provider.pendingClientSecret).toBeNull();
    expect(replaced.provider.clientSecret?.last4).toBe("2222");
    expect(
      (await admin.enable({ id: provider.id, audit: audit() })).outcome,
    ).toBe("not_ready");
  });

  test("the secret a provider already has, or already waits to try, is no change: the pass stands and no receipt is left", async () => {
    const provider = await configured();
    expect((await passTest(provider.id)).outcome).toBe("recorded");
    const ready = await current(provider.id);
    const set = (value: string) =>
      admin.setClientSecret({ id: provider.id, value, audit: audit() });
    const secretReceipts = async () =>
      (await receiptsOf(provider.id)).filter(
        (receipt) => receipt.operation === "set_login_provider_secret",
      ).length;

    const again = await set(FIRST_SECRET);
    if (again.outcome !== "stored") throw new Error(again.outcome);
    expect(again.provider).toEqual(ready);
    expect(await secretReceipts()).toBe(1);
    const enabled = await admin.enable({ id: provider.id, audit: audit() });
    if (enabled.outcome !== "enabled") throw new Error(enabled.outcome);

    // On: the secret in use is not a replacement of itself.
    const inUse = await set(FIRST_SECRET);
    if (inUse.outcome !== "stored") throw new Error(inUse.outcome);
    expect(inUse.provider).toEqual(enabled.provider);
    const waiting = await set(SECOND_SECRET);
    if (waiting.outcome !== "stored") throw new Error(waiting.outcome);
    expect(waiting.provider.pendingClientSecret?.last4).toBe("2222");
    const repeated = await set(SECOND_SECRET);
    if (repeated.outcome !== "stored") throw new Error(repeated.outcome);
    expect(repeated.provider).toEqual(waiting.provider);
    expect(await secretReceipts()).toBe(2);

    // Naming the secret in use while another waits withdraws the one that
    // waits: the provider stays on with the secret that passed.
    const started = await admin.findForTest(provider.id);
    expect(started?.slot).toBe("next");
    const withdrawn = await set(FIRST_SECRET);
    if (withdrawn.outcome !== "stored") throw new Error(withdrawn.outcome);
    expect(withdrawn.provider).toMatchObject({
      enabled: true,
      pendingClientSecret: null,
      configRevision: waiting.provider.configRevision,
      revision: waiting.provider.revision + 1,
    });
    expect(withdrawn.provider.clientSecret?.last4).toBe("1111");
    expect(await signInSecret(provider.id)).toBe(FIRST_SECRET);
    expect((await receiptsOf(provider.id)).at(-1)).toMatchObject({
      operation: "set_login_provider_secret",
      result: { provider_id: provider.id, slot: "next", withdrawn: true },
    });
    // A test that was under way with the withdrawn secret is not a pass.
    expect(
      (
        await admin.recordTest({
          id: provider.id,
          configRevision: started?.provider.configRevision ?? -1,
          slot: "next",
          clientSecret: SECOND_SECRET,
          audit: audit(),
        })
      ).outcome,
    ).toBe("stale");
    expect(await signInSecret(provider.id)).toBe(FIRST_SECRET);
  });

  test("a test that ran while the settings changed is not written down", async () => {
    const provider = await configured();
    const started = await admin.findForTest(provider.id);
    if (!started?.clientSecret) throw new Error("nothing to test with");

    const changed = await admin.update({
      id: provider.id,
      ifMatch: provider.revision,
      changes: { clientId: "client-2" },
      audit: audit(),
    });
    if (changed.outcome !== "updated") throw new Error(changed.outcome);
    expect(
      await admin.recordTest({
        id: provider.id,
        configRevision: started.provider.configRevision,
        slot: started.slot,
        clientSecret: started.clientSecret,
        audit: audit(),
      }),
    ).toEqual({ outcome: "stale" });

    // The same revision, another secret than the one the provider accepted.
    const again = await admin.findForTest(provider.id);
    if (!again?.clientSecret) throw new Error("nothing to test with");
    expect(
      await admin.recordTest({
        id: provider.id,
        configRevision: again.provider.configRevision,
        slot: again.slot,
        clientSecret: SECOND_SECRET,
        audit: audit(),
      }),
    ).toEqual({ outcome: "stale" });

    const after = await current(provider.id);
    expect(after.testedConfigRevision).toBeNull();
    expect(after.testedAt).toBeNull();
    expect(
      (await receiptsOf(provider.id)).map((receipt) => receipt.operation),
    ).not.toContain("test_login_provider");
    expect(
      (
        await admin.recordTest({
          id: randomUUID(),
          configRevision: 1,
          slot: "current",
          clientSecret: FIRST_SECRET,
          audit: audit(),
        })
      ).outcome,
    ).toBe("not_found");
  });

  test("the secret goes in and only its last four characters come out", async () => {
    const provider = await configured();
    expect(provider.clientSecret).toMatchObject({
      last4: "1111",
      secretVersion: 1,
    });
    expect(JSON.stringify(await admin.list())).not.toContain(FIRST_SECRET);
    expect(await signInSecret(provider.id)).toBe(FIRST_SECRET);
    // Sealed at rest: the row holds no readable value.
    const rows = await db.select().from(secretValues);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(
        FIRST_SECRET,
      );
    }
    const stored = (await receiptsOf(provider.id)).filter(
      (receipt) => receipt.operation === "set_login_provider_secret",
    );
    expect(stored.map((receipt) => receipt.result)).toEqual([
      { provider_id: provider.id, slot: "current", last4: "1111" },
    ]);
    expect(
      (
        await admin.setClientSecret({
          id: randomUUID(),
          value: FIRST_SECRET,
          audit: audit(),
        })
      ).outcome,
    ).toBe("not_found");
  });

  test("on a provider that is on, the client id and the client authentication cannot change; the name and the policy can", async () => {
    const provider = await turnedOn();
    for (const changes of [
      { clientId: "client-2" },
      { tokenAuthMethod: "client_secret_post" as const },
      { displayName: "Renamed", clientId: "client-2" },
    ]) {
      expect(
        (
          await admin.update({
            id: provider.id,
            ifMatch: provider.revision,
            changes,
            audit: audit(),
          })
        ).outcome,
      ).toBe("locked");
    }
    expect(await current(provider.id)).toMatchObject({
      displayName: "Keycloak",
      clientId: "client-1",
      tokenAuthMethod: "client_secret_basic",
      revision: provider.revision,
    });

    const updated = await admin.update({
      id: provider.id,
      ifMatch: provider.revision,
      changes: {
        displayName: "Renamed",
        allowedDomains: ["example.com"],
        // The value it has: not a change, so not refused.
        clientId: "client-1",
      },
      audit: audit(),
    });
    if (updated.outcome !== "updated") throw new Error(updated.outcome);
    expect(updated.provider).toMatchObject({
      displayName: "Renamed",
      allowedDomains: ["example.com"],
      enabled: true,
      configRevision: provider.configRevision + 1,
    });

    expect(
      (
        await admin.refreshDiscovery({
          id: provider.id,
          endpoints: endpointsOf(provider.issuer, {
            tokenEndpoint: `${provider.issuer}/token2`,
          }),
          audit: audit(),
        })
      ).outcome,
    ).toBe("locked");
    expect((await current(provider.id)).tokenEndpoint).toBe(
      `${provider.issuer}/token`,
    );
  });

  test("on a provider that is on, a new secret waits; sign-ins keep the old one until a test passes with the new", async () => {
    const provider = await turnedOn();
    const stored = await admin.setClientSecret({
      id: provider.id,
      value: SECOND_SECRET,
      audit: audit(),
    });
    if (stored.outcome !== "stored") throw new Error(stored.outcome);
    expect(stored.provider).toMatchObject({
      enabled: true,
      configRevision: provider.configRevision,
      clientSecret: { last4: "1111" },
      pendingClientSecret: { last4: "2222" },
    });
    expect(await signInSecret(provider.id)).toBe(FIRST_SECRET);

    const testing = await admin.findForTest(provider.id);
    expect(testing).toMatchObject({
      slot: "next",
      clientSecret: SECOND_SECRET,
    });

    // A test that passed with something else than the waiting secret.
    expect(
      await admin.recordTest({
        id: provider.id,
        configRevision: provider.configRevision,
        slot: "next",
        clientSecret: FIRST_SECRET,
        audit: audit(),
      }),
    ).toEqual({ outcome: "stale" });
    expect(await signInSecret(provider.id)).toBe(FIRST_SECRET);

    expect((await passTest(provider.id)).outcome).toBe("recorded");
    expect(await signInSecret(provider.id)).toBe(SECOND_SECRET);
    expect(await current(provider.id)).toMatchObject({
      enabled: true,
      clientSecret: { last4: "2222" },
      pendingClientSecret: null,
    });
    const tests = (await receiptsOf(provider.id)).filter(
      (receipt) => receipt.operation === "test_login_provider",
    );
    expect(tests.at(-1)?.result).toMatchObject({
      slot: "next",
      secret_replaced: true,
    });
  });

  test("a waiting secret is never tested on a provider that is off", async () => {
    const provider = await configured();
    expect(
      await admin.recordTest({
        id: provider.id,
        configRevision: provider.configRevision,
        slot: "next",
        clientSecret: FIRST_SECRET,
        audit: audit(),
      }),
    ).toEqual({ outcome: "stale" });
  });

  test("turning a provider off ends its sessions, drops a waiting secret and says how many sessions ended", async () => {
    const provider = await turnedOn();
    const other = await turnedOn();
    for (const [target, subject] of [
      [provider, "off-1"],
      [provider, "off-2"],
      [other, "stays-1"],
    ] as const) {
      expect((await signIn(target, subject)).outcome).toBe("signed_in");
    }
    const waiting = await admin.setClientSecret({
      id: provider.id,
      value: SECOND_SECRET,
      audit: audit(),
    });
    expect(waiting.outcome).toBe("stored");

    const disabled = await admin.disable({ id: provider.id, audit: audit() });
    if (disabled.outcome !== "disabled") throw new Error(disabled.outcome);
    expect(disabled.sessionsRevoked).toBe(2);
    expect(disabled.provider).toMatchObject({
      enabled: false,
      clientSecret: { last4: "1111" },
      pendingClientSecret: null,
    });
    const live = async (issuer: string) =>
      (
        await db
          .select({ id: webSessions.id })
          .from(webSessions)
          .innerJoin(
            loginMethods,
            eq(loginMethods.id, webSessions.loginMethodId),
          )
          .where(
            and(eq(loginMethods.issuer, issuer), isNull(webSessions.revokedAt)),
          )
      ).length;
    expect(await live(provider.issuer)).toBe(0);
    expect(await live(other.issuer)).toBe(1);
    expect(
      (await receiptsOf(provider.id)).find(
        (receipt) => receipt.operation === "disable_login_provider",
      )?.result,
    ).toEqual({ provider_id: provider.id, sessions_revoked: 2 });

    // Off already: nothing to end, and no second receipt.
    const again = await admin.disable({ id: provider.id, audit: audit() });
    expect(again).toMatchObject({ outcome: "disabled", sessionsRevoked: 0 });
    expect(
      (await receiptsOf(provider.id)).filter(
        (receipt) => receipt.operation === "disable_login_provider",
      ).length,
    ).toBe(1);
    expect(
      (await admin.disable({ id: randomUUID(), audit: audit() })).outcome,
    ).toBe("not_found");
  });

  test("discovery is read again only while off, for the same issuer, and makes the settings a new revision", async () => {
    const provider = await configured();
    expect((await passTest(provider.id)).outcome).toBe("recorded");
    expect(
      (
        await admin.refreshDiscovery({
          id: provider.id,
          endpoints: endpointsOf("https://elsewhere.example.test"),
          audit: audit(),
        })
      ).outcome,
    ).toBe("issuer_changed");

    const refreshed = await admin.refreshDiscovery({
      id: provider.id,
      endpoints: endpointsOf(provider.issuer, {
        tokenEndpoint: `${provider.issuer}/token2`,
        signingAlgs: ["ES256"],
        tokenAuthMethods: ["client_secret_post"],
      }),
      audit: audit(),
    });
    if (refreshed.outcome !== "updated") throw new Error(refreshed.outcome);
    expect(refreshed.provider).toMatchObject({
      tokenEndpoint: `${provider.issuer}/token2`,
      signingAlgs: ["ES256"],
      // The one it had is no longer offered.
      tokenAuthMethod: "client_secret_post",
      configRevision: provider.configRevision + 1,
    });
    expect(
      (await admin.enable({ id: provider.id, audit: audit() })).outcome,
    ).toBe("not_ready");
    expect(
      (
        await admin.refreshDiscovery({
          id: randomUUID(),
          endpoints: endpointsOf(provider.issuer),
          audit: audit(),
        })
      ).outcome,
    ).toBe("not_found");
  });

  test("only a provider that is off is deleted; its secrets go and the login methods stay", async () => {
    const provider = await turnedOn();
    expect(
      (await admin.delete({ id: provider.id, audit: audit() })).outcome,
    ).toBe("enabled");
    const methodId = randomUUID();
    await db.insert(loginMethods).values({
      id: methodId,
      userId: ownerId,
      kind: "oidc",
      issuer: provider.issuer,
      subject: "owner-subject",
    });
    await admin.disable({ id: provider.id, audit: audit() });

    expect(await admin.delete({ id: provider.id, audit: audit() })).toEqual({
      outcome: "deleted",
    });
    expect(
      await db
        .select({ id: loginProviders.id })
        .from(loginProviders)
        .where(eq(loginProviders.id, provider.id)),
    ).toEqual([]);
    expect(
      (await db.select({ ownerRef: secretValues.ownerRef }).from(secretValues))
        .map((row) => row.ownerRef)
        .filter((ref) => ref.endsWith(provider.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: loginMethods.id })
        .from(loginMethods)
        .where(eq(loginMethods.id, methodId)),
    ).toEqual([{ id: methodId }]);
    expect(
      (await admin.delete({ id: provider.id, audit: audit() })).outcome,
    ).toBe("not_found");
  });

  test("every change leaves a receipt naming the owner, and none holds a secret", async () => {
    const provider = await turnedOn();
    await admin.setClientSecret({
      id: provider.id,
      value: SECOND_SECRET,
      audit: audit(),
    });
    await passTest(provider.id);
    await admin.disable({ id: provider.id, audit: audit() });
    await admin.refreshDiscovery({
      id: provider.id,
      endpoints: endpointsOf(provider.issuer),
      audit: audit(),
    });
    await admin.delete({ id: provider.id, audit: audit() });

    const written = await receiptsOf(provider.id);
    expect(written.map((receipt) => receipt.operation)).toEqual([
      "create_login_provider",
      "update_login_provider",
      "set_login_provider_secret",
      "test_login_provider",
      "enable_login_provider",
      "set_login_provider_secret",
      "test_login_provider",
      "disable_login_provider",
      "refresh_login_provider_discovery",
      "delete_login_provider",
    ]);
    for (const receipt of written) {
      expect(receipt.ownerId).toBe(workspaceId);
      expect(receipt.actor).toEqual({
        principal: { kind: "user", id: ownerId },
        actor_user_id: ownerId,
        agent_id: null,
      });
    }
    const text = JSON.stringify(written);
    expect(text).not.toContain(FIRST_SECRET);
    expect(text).not.toContain(SECOND_SECRET);
  });

  test("an update's receipt names what changed as the API names it, and not the values", async () => {
    const provider = await configured();
    const updated = await admin.update({
      id: provider.id,
      ifMatch: provider.revision,
      changes: {
        displayName: "Renamed",
        // The value it has: not a change.
        clientId: "client-1",
        allowedDomains: ["receipt.example"],
        jitRole: "member",
        requireVerifiedEmail: false,
      },
      audit: audit(),
    });
    if (updated.outcome !== "updated") throw new Error(updated.outcome);
    const last = (await receiptsOf(provider.id)).at(-1);
    expect(last).toMatchObject({
      operation: "update_login_provider",
      result: {
        provider_id: provider.id,
        fields: [
          "allowed_domains",
          "display_name",
          "jit_role",
          "require_verified_email",
        ],
        config_revision: updated.provider.configRevision,
      },
    });
    expect(JSON.stringify(last?.result)).not.toContain("receipt.example");
  });

  test("a preview of who would come in says what the sign-in itself would, and makes nothing", async () => {
    const provider = await turnedOn();
    const person = async (
      name: string,
      has: { off?: boolean; membership?: "live" | "off"; subject?: string },
    ) => {
      const id = randomUUID();
      await db.insert(users).values({
        id,
        email: `${name}@example.com`,
        displayName: name,
        disabledAt: has.off ? new Date() : null,
      });
      if (has.membership) {
        await db.insert(memberships).values({
          workspaceId,
          userId: id,
          role: "member",
          disabledAt: has.membership === "off" ? new Date() : null,
        });
      }
      if (has.subject) {
        await db.insert(loginMethods).values({
          id: randomUUID(),
          userId: id,
          kind: "oidc",
          issuer: provider.issuer,
          subject: has.subject,
        });
      }
    };
    await person("pv-linked", { membership: "live", subject: "pv-linked" });
    await person("pv-off", {
      off: true,
      membership: "live",
      subject: "pv-off",
    });
    await person("pv-homeless", { subject: "pv-homeless" });
    await person("pv-left", { membership: "off", subject: "pv-left" });
    await person("pv-account", { membership: "live" });
    await person("pv-off-account", { off: true, membership: "live" });
    await db.insert(invites).values({
      id: randomUUID(),
      workspaceId,
      email: "pv-invited@example.com",
      role: "member",
      tokenHash: createHash("sha256").update(randomUUID()).digest(),
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const count = async () => ({
      users: (await db.select({ id: users.id }).from(users)).length,
      methods: (await db.select({ id: loginMethods.id }).from(loginMethods))
        .length,
      sessions: (await db.select({ id: webSessions.id }).from(webSessions))
        .length,
    });
    const before = await count();

    const preview = (subject: string, email: string | null) =>
      admin.previewEntry({ issuer: provider.issuer, subject, email });
    // Each with what the sign-in itself answers for the same account. The
    // last column is whether the provider vouches for the address; where it
    // does not, the caller of the preview says `refused` whatever the
    // preview found (entryOf, provider-login.test.ts).
    const cases = [
      ["pv-linked", "someone@example.com", "linked", "signed_in", true],
      ["pv-linked", null, "linked", "signed_in", false],
      ["pv-off", "pv-off@example.com", "refused", "rejected", true],
      ["pv-homeless", "pv-homeless@example.com", "refused", "rejected", true],
      ["pv-left", "pv-left@example.com", "refused", "rejected", true],
      [
        "pv-new",
        "pv-account@example.com",
        "account_exists",
        "link_required",
        true,
      ],
      ["pv-new", "pv-account@example.com", "account_exists", "rejected", false],
      ["pv-new", "pv-off-account@example.com", "refused", "rejected", true],
      // A live invite for the address is not found by an address the
      // provider does not vouch for, and no address finds nothing.
      ["pv-new", "pv-invited@example.com", "none", "rejected", false],
      ["pv-new", null, "none", "rejected", false],
    ] as const;
    for (const [subject, email, expected] of cases) {
      expect(await preview(subject, email), `${subject} ${email}`).toBe(
        expected,
      );
    }
    // The same subject at another issuer is another account.
    expect(
      await admin.previewEntry({
        issuer: "https://elsewhere.example.test",
        subject: "pv-linked",
        email: null,
      }),
    ).toBe("none");
    expect(await preview("pv-new", "pv-nobody@example.com")).toBe("none");
    expect(await count()).toEqual(before);

    for (const [subject, email, , outcome, owned] of cases) {
      expect(
        (await signIn(provider, subject, email, owned)).outcome,
        `${subject} ${email} ${owned}`,
      ).toBe(outcome);
    }
    // The invite was live all along: vouched for, the same address joins.
    expect(
      await signIn(provider, "pv-new", "pv-invited@example.com"),
    ).toMatchObject({ outcome: "signed_in", via: "invite" });
  });
});
