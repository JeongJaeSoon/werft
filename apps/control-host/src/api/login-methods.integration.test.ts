import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listMyLoginMethodsResponseSchema,
  providerLoginCallbackResponseSchema,
  startProviderLoginResponseSchema,
  unlinkMyLoginMethodResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresLoginMethodStore,
  createPostgresLoginProviderStore,
  invites,
  loginMethods,
  loginProviders,
  receipts,
  users,
  webSessions,
} from "@werft-ai/db";
import { seedLoginProvider } from "@werft-ai/db/testing/login-provider";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { derivedSecretKey, SecretKey } from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  hashWebSessionToken,
  LoginLockout,
} from "./auth.ts";
import { createProviderLogin } from "./provider-login.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

// Made per run: nothing here is a value anyone could use elsewhere.
const made = () => randomBytes(18).toString("base64url");
const BOOTSTRAP = made();
const OWNER_WORD = made();
const CLIENT_ID = "client-id.apps.example";
const CLIENT_KEY = made();
const KEY = SecretKey.fromHex("ab".repeat(32), "test");
const BROWSER = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const REJECTED = { code: "UNAUTHORIZED", message: "Sign-in was not accepted" };

integration(
  "invite sign-up and a person's own login methods on PostgreSQL",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let app: ReturnType<typeof createApiApp>;
    type Provider = { id: string; idp: MockOidcServer };
    let a: Provider;
    let b: Provider;
    let workspaceId = "";
    let ownerId = "";

    const request = (
      method: string,
      path: string,
      options: { body?: unknown; cookies?: string[]; csrf?: boolean } = {},
    ) =>
      app.request(path, {
        method,
        headers: {
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.csrf === false ? {} : BROWSER),
          ...(options.cookies?.length
            ? { Cookie: options.cookies.filter(Boolean).join("; ") }
            : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    const cookieOf = (response: Response, name: string) =>
      response.headers
        .getSetCookie()
        .find(
          (cookie) =>
            cookie.startsWith(`${name}=`) && !/=;|Max-Age=0/.test(cookie),
        )
        ?.split(";")[0] ?? "";
    const sessionOf = (response: Response) =>
      cookieOf(response, WEB_SESSION_COOKIE_NAME);
    const errorOf = async (response: Response) => {
      const { error } = await response.json();
      return {
        code: error.code,
        ...(error.details?.reason_code
          ? { reason: error.details.reason_code }
          : {}),
      };
    };
    const meStatus = async (cookie: string) =>
      (await request("GET", "/v1/auth/me", { cookies: [cookie] })).status;

    /** A started flow: its cookie, and the provider's answer once asked. */
    const started = async (
      response: Response,
      provider: Provider,
      claims: MockOidcClaims,
    ) => {
      expect(response.status).toBe(200);
      const flowCookie = (response.headers.get("Set-Cookie") ?? "").split(
        ";",
      )[0];
      const { authorization_url } = startProviderLoginResponseSchema.parse(
        await response.json(),
      );
      const back = await provider.idp.authorize(authorization_url, claims);
      return (cookies: string[] = []) =>
        request("POST", "/v1/auth/oidc/callback", {
          body: { provider_id: provider.id, ...back },
          cookies: [flowCookie ?? "", ...cookies],
        });
    };
    const signIn = async (provider: Provider, claims: MockOidcClaims) =>
      (
        await started(
          await request("POST", `/v1/auth/providers/${provider.id}/start`),
          provider,
          claims,
        )
      )();
    const inviteStart = (provider: Provider, token: string) =>
      request("POST", `/v1/auth/providers/${provider.id}/invite/start`, {
        body: { invite_token: token },
      });
    const linkStart = (provider: Provider, session: string) =>
      request("POST", `/v1/auth/me/login-methods/${provider.id}/link/start`, {
        cookies: [session],
      });
    const myMethods = async (session: string) => {
      const response = await request("GET", "/v1/auth/me/login-methods", {
        cookies: [session],
      });
      expect(response.status).toBe(200);
      return listMyLoginMethodsResponseSchema.parse(await response.json());
    };
    const unlink = (session: string, id: string) =>
      request("DELETE", `/v1/auth/me/login-methods/${id}`, {
        cookies: [session],
      });
    const passwordLogin = async (email: string, password: string) => {
      const response = await request("POST", "/v1/auth/login", {
        body: { email, password },
      });
      return { status: response.status, session: sessionOf(response) };
    };

    /** An invite and the token its link carries. */
    const invite = async (email: string, ttlMs = 60_000) => {
      const id = randomUUID();
      const token = made();
      await db.insert(invites).values({
        id,
        workspaceId,
        email,
        role: "member",
        tokenHash: hashWebSessionToken(token),
        invitedBy: ownerId,
        expiresAt: new Date(Date.now() + ttlMs),
      });
      return { id, token };
    };
    const inviteRow = async (id: string) =>
      (await db.select().from(invites).where(eq(invites.id, id)))[0];
    const userByEmail = async (email: string) =>
      (await db.select().from(users).where(eq(users.email, email)))[0];
    const methodsOf = (userId: string) =>
      db.select().from(loginMethods).where(eq(loginMethods.userId, userId));
    const liveSessions = (userId: string) =>
      db.$count(
        webSessions,
        and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt)),
      );
    const setProvider = (
      provider: Provider,
      values: Partial<typeof loginProviders.$inferInsert>,
    ) =>
      db
        .update(loginProviders)
        .set(values)
        .where(eq(loginProviders.id, provider.id));
    /** Makes every session of the user as old as a session left open. */
    const age = (userId: string) =>
      pool.query(
        "UPDATE web_sessions SET created_at = now() - interval '11 minutes' WHERE user_id = $1",
        [userId],
      );

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "my_login_methods" });
      pool = new Pool({ connectionString: database.url, max: 8 });
      db = drizzle(pool, { schema });
      const identity = new DatabaseIdentityStore(db);
      const auth = {
        identity,
        bootstrap: createBootstrapGate(BOOTSTRAP),
        lockout: new LoginLockout(),
        logger: new StructuredLogger({ sinks: [new MemoryLogSink()] }),
        loginMethods: createPostgresLoginMethodStore(db),
        providers: createProviderLogin({
          providers: createPostgresLoginProviderStore(db, KEY),
          // On loopback, so the stand-in providers' plain http is allowed.
          consoleOrigin: "http://localhost:5173",
          flowKey: derivedSecretKey(KEY, "login-flow-cookie"),
        }),
      };
      app = createApiApp({
        authMode: "api-key",
        keyStore: { find: async () => null },
        identity,
        registerPublicRoutes: (router) =>
          registerPublicAuthRoutes(router, auth),
        registerRoutes: (router) => registerAuthRoutes(router, auth),
      });

      // A client secret is stored under a workspace, so the owner comes first.
      const created = await request("POST", "/v1/auth/bootstrap", {
        body: {
          bootstrap_token: BOOTSTRAP,
          email: "owner@example.com",
          password: OWNER_WORD,
          display_name: "Owner",
          workspace_name: "Acme",
          workspace_slug: "acme",
        },
      });
      expect(created.status).toBe(201);
      const body = bootstrapResponseSchema.parse(await created.json());
      workspaceId = body.workspace.id;
      ownerId = body.user_id;

      const provider = async (displayName: string): Promise<Provider> => {
        const idp = await startMockOidcServer({
          clientId: CLIENT_ID,
          clientSecret: CLIENT_KEY,
        });
        const row = await seedLoginProvider(
          db,
          {
            displayName,
            issuer: idp.issuer,
            clientId: CLIENT_ID,
            tokenAuthMethod: "client_secret_post",
            createdBy: ownerId,
          },
          { key: KEY, value: CLIENT_KEY },
        );
        return { id: row.id, idp };
      };
      a = await provider("A");
      b = await provider("B");
    }, 60_000);

    afterAll(async () => {
      a?.idp.stop();
      b?.idp.stop();
      await pool?.end();
      await database?.drop();
    });

    describe("sign-up by invite", () => {
      test("the invite's address and role make the account, whatever address the provider reports", async () => {
        const { id, token } = await invite("bob@example.com");
        const finish = await started(await inviteStart(a, token), a, {
          sub: "bob-at-a",
          email: "robert@elsewhere.example",
          name: "Robert",
        });
        const response = await finish();
        expect(response.status).toBe(200);
        const body = providerLoginCallbackResponseSchema.parse(
          await response.json(),
        );
        expect(body).toMatchObject({ outcome: "signed_in", role: "member" });
        expect(await meStatus(sessionOf(response))).toBe(200);
        const bob = await userByEmail("bob@example.com");
        expect(bob).toMatchObject({
          passwordHash: null,
          displayName: "Robert",
        });
        expect(await userByEmail("robert@elsewhere.example")).toBeUndefined();
        expect(await methodsOf(bob?.id ?? "")).toMatchObject([
          {
            kind: "oidc",
            issuer: a.idp.issuer,
            subject: "bob-at-a",
            // What the provider vouched for, kept as a record only.
            emailAtLink: "robert@elsewhere.example",
          },
        ]);
        expect((await inviteRow(id))?.acceptedAt).not.toBeNull();
        // From now on the provider's account is Bob's way in.
        const again = await signIn(a, {
          sub: "bob-at-a",
          email: "robert@elsewhere.example",
        });
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ user_id: bob?.id });
      });

      test("an address the provider does not vouch for is written nowhere", async () => {
        await setProvider(b, { requireVerifiedEmail: false });
        try {
          const { token } = await invite("cara@example.com");
          const finish = await started(await inviteStart(b, token), b, {
            sub: "cara-at-b",
            email: "owner@example.com",
            email_verified: null,
          });
          const response = await finish();
          expect(response.status).toBe(200);
          const cara = await userByEmail("cara@example.com");
          expect(cara?.displayName).toBe("cara");
          expect(await methodsOf(cara?.id ?? "")).toMatchObject([
            { subject: "cara-at-b", emailAtLink: null },
          ]);
          // Nor does it reach the account that has that address.
          expect((await methodsOf(ownerId)).map((row) => row.kind)).toEqual([
            "password",
          ]);
        } finally {
          await setProvider(b, { requireVerifiedEmail: true });
        }
      });

      test("the start answers like the password accept for an invite that is not live", async () => {
        const used = await invite("used@example.com");
        await db
          .update(invites)
          .set({ acceptedAt: new Date() })
          .where(eq(invites.id, used.id));
        const expired = await invite("expired@example.com", -1_000);
        const live = await invite("live@example.com");
        expect(await errorOf(await inviteStart(a, used.token))).toEqual({
          code: "INVITE_USED",
        });
        expect(await errorOf(await inviteStart(a, expired.token))).toEqual({
          code: "INVITE_EXPIRED",
        });
        expect(await errorOf(await inviteStart(a, made()))).toEqual({
          code: "INVITE_EXPIRED",
        });
        const noBody = await request(
          "POST",
          `/v1/auth/providers/${a.id}/invite/start`,
        );
        expect(noBody.status).toBe(400);
        const noCsrf = await request(
          "POST",
          `/v1/auth/providers/${a.id}/invite/start`,
          { body: { invite_token: live.token }, csrf: false },
        );
        expect(noCsrf.status).toBe(403);
        await setProvider(a, { enabled: false });
        try {
          expect((await inviteStart(a, live.token)).status).toBe(404);
        } finally {
          await setProvider(a, { enabled: true });
        }
      });

      test("an invite that died while the person was at the provider signs nobody in, a linked account included", async () => {
        const { id, token } = await invite("dana@example.com");
        // Bob's account at the provider: linked, and still not let in this way.
        const finish = await started(await inviteStart(a, token), a, {
          sub: "bob-at-a",
          email: "robert@elsewhere.example",
        });
        await db
          .update(invites)
          .set({ revokedAt: new Date() })
          .where(eq(invites.id, id));
        const response = await finish();
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: REJECTED });
        expect(sessionOf(response)).toBe("");
        expect(await userByEmail("dana@example.com")).toBeUndefined();
      });

      test("an account somebody has answers 409 and spends nothing", async () => {
        const { id, token } = await invite("erin@example.com");
        const bob = await userByEmail("bob@example.com");
        const sessionsBefore = await liveSessions(bob?.id ?? "");
        const finish = await started(await inviteStart(a, token), a, {
          sub: "bob-at-a",
          email: "robert@elsewhere.example",
        });
        const response = await finish();
        expect(response.status).toBe(409);
        expect(await errorOf(response)).toEqual({
          code: "ALREADY_EXISTS",
          reason: "login_method_linked",
        });
        expect(sessionOf(response)).toBe("");
        expect((await inviteRow(id))?.acceptedAt).toBeNull();
        expect(await userByEmail("erin@example.com")).toBeUndefined();
        expect(await liveSessions(bob?.id ?? "")).toBe(sessionsBefore);
      });

      test("an invite to an address that has an account answers LOGIN_LINK_REQUIRED and joins nothing", async () => {
        const { id, token } = await invite("owner@example.com");
        const finish = await started(await inviteStart(a, token), a, {
          sub: "owner-by-invite",
          email: "owner@example.com",
        });
        const response = await finish();
        expect(response.status).toBe(409);
        expect(await errorOf(response)).toEqual({
          code: "LOGIN_LINK_REQUIRED",
        });
        expect(sessionOf(response)).toBe("");
        expect((await inviteRow(id))?.acceptedAt).toBeNull();
        expect((await methodsOf(ownerId)).map((row) => row.kind)).toEqual([
          "password",
        ]);
      });

      test("the provider's allowed domains hold for a sign-up by invite", async () => {
        await setProvider(a, { allowedDomains: ["example.com"] });
        try {
          const { id, token } = await invite("finn@example.com");
          const finish = await started(await inviteStart(a, token), a, {
            sub: "finn-at-a",
            email: "finn@elsewhere.example",
          });
          const response = await finish();
          expect(response.status).toBe(403);
          expect((await inviteRow(id))?.acceptedAt).toBeNull();
          expect(await userByEmail("finn@example.com")).toBeUndefined();
        } finally {
          await setProvider(a, { allowedDomains: [] });
        }
      });

      test("a sign-in flow never spends an invite it was not started with", async () => {
        const { id } = await invite("gus@example.com");
        // No address the provider vouches for matches an invite: rule 5.
        const response = await signIn(a, {
          sub: "gus-at-a",
          email: "gus@example.com",
          email_verified: false,
        });
        expect(response.status).toBe(401);
        expect((await inviteRow(id))?.acceptedAt).toBeNull();
      });
    });

    describe("linking and removing from a session", () => {
      let owner = "";

      test("the owner sees a password, and the providers that can be linked", async () => {
        const signedIn = await passwordLogin("owner@example.com", OWNER_WORD);
        expect(signedIn.status).toBe(200);
        owner = signedIn.session;
        const mine = await myMethods(owner);
        expect(mine.methods).toMatchObject([
          { kind: "password", provider: null, usable: true },
        ]);
        expect(mine.linkable.map((row) => row.display_name)).toEqual([
          "A",
          "B",
        ]);
        expect(mine.can_change).toBe(true);
      });

      test("a link ends in the session it started from, adds the account and makes no session", async () => {
        const sessionsBefore = await liveSessions(ownerId);
        const finish = await started(await linkStart(a, owner), a, {
          sub: "owner-at-a",
          email: "someone@elsewhere.example",
        });
        // Without the session, and from Bob's session, it is a refusal.
        const bob = await signIn(a, {
          sub: "bob-at-a",
          email: "robert@elsewhere.example",
        });
        for (const cookies of [[], [sessionOf(bob)]]) {
          const refused = await finish(cookies);
          expect(refused.status).toBe(401);
          expect(await refused.json()).toMatchObject({ error: REJECTED });
        }
        expect(await methodsOf(ownerId)).toHaveLength(1);
        const response = await finish([owner]);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          outcome: "linked",
          provider_id: a.id,
        });
        expect(sessionOf(response)).toBe("");
        expect(await liveSessions(ownerId)).toBe(sessionsBefore);
        const mine = await myMethods(owner);
        expect(mine.methods).toMatchObject([
          { kind: "password" },
          {
            kind: "oidc",
            provider: { id: a.id, display_name: "A", enabled: true },
            email_at_link: "someone@elsewhere.example",
            usable: true,
          },
        ]);
        expect(mine.linkable.map((row) => row.display_name)).toEqual(["B"]);
        const written = await db
          .select()
          .from(receipts)
          .where(eq(receipts.operation, "link_login_method"));
        expect(written).toHaveLength(1);
        expect(written[0]?.actor).toMatchObject({ actor_user_id: ownerId });
        expect(JSON.stringify(written[0])).not.toContain("owner-at-a");
        // The linked account now signs the owner in.
        const viaA = await signIn(a, {
          sub: "owner-at-a",
          email: "someone@elsewhere.example",
        });
        expect(await viaA.json()).toMatchObject({
          outcome: "signed_in",
          user_id: ownerId,
        });
      });

      test("a sign-in flow brought back with a session links nothing", async () => {
        const finish = await started(
          await request("POST", `/v1/auth/providers/${b.id}/start`),
          b,
          { sub: "owner-at-b", email: "nobody@elsewhere.example" },
        );
        const response = await finish([owner]);
        expect(response.status).toBe(401);
        expect(await methodsOf(ownerId)).toHaveLength(2);
      });

      test("an account somebody has, and a second account of the same provider, answer 409", async () => {
        const taken = await (
          await started(await linkStart(b, owner), b, {
            sub: "cara-at-b",
            email: "cara@elsewhere.example",
          })
        )([owner]);
        expect(taken.status).toBe(409);
        expect(await errorOf(taken)).toEqual({
          code: "ALREADY_EXISTS",
          reason: "login_method_linked",
        });
        const second = await (
          await started(await linkStart(a, owner), a, {
            sub: "owner-at-a-too",
            email: "someone@elsewhere.example",
          })
        )([owner]);
        expect(second.status).toBe(409);
        expect(await errorOf(second)).toEqual({
          code: "ALREADY_EXISTS",
          reason: "issuer_linked",
        });
        expect(await methodsOf(ownerId)).toHaveLength(2);
      });

      test("a session left open neither links nor removes; signing in again does", async () => {
        await age(ownerId);
        expect((await myMethods(owner)).can_change).toBe(false);
        const start = await linkStart(b, owner);
        expect(start.status).toBe(403);
        expect(await errorOf(start)).toEqual({
          code: "FORBIDDEN",
          reason: "session_too_old",
        });
        const viaA = (await methodsOf(ownerId)).find(
          (row) => row.kind === "oidc",
        );
        const removal = await unlink(owner, viaA?.id ?? "");
        expect(removal.status).toBe(403);
        expect(await errorOf(removal)).toEqual({
          code: "FORBIDDEN",
          reason: "session_too_old",
        });
        expect(await methodsOf(ownerId)).toHaveLength(2);
        owner = (await passwordLogin("owner@example.com", OWNER_WORD)).session;
        expect((await myMethods(owner)).can_change).toBe(true);
      });

      test("removing a way ends the sessions made with it, and only those", async () => {
        const viaA = await signIn(a, {
          sub: "owner-at-a",
          email: "someone@elsewhere.example",
        });
        const other = sessionOf(viaA);
        expect(await meStatus(other)).toBe(200);
        const method = (await methodsOf(ownerId)).find(
          (row) => row.kind === "oidc",
        );
        // Nobody else's way, and no way that is not there.
        const bob = await userByEmail("bob@example.com");
        const [bobs] = await methodsOf(bob?.id ?? "");
        expect((await unlink(owner, bobs?.id ?? "")).status).toBe(404);
        expect((await unlink(owner, randomUUID())).status).toBe(404);
        const response = await unlink(owner, method?.id ?? "");
        expect(response.status).toBe(200);
        const body = unlinkMyLoginMethodResponseSchema.parse(
          await response.json(),
        );
        // The sign-ins through A above, all still live until now.
        expect(body.sessions_revoked).toBeGreaterThanOrEqual(1);
        expect(await meStatus(other)).toBe(401);
        expect(await meStatus(owner)).toBe(200);
        const [receipt] = await db
          .select()
          .from(receipts)
          .where(eq(receipts.id, body.receipt_id));
        expect(receipt).toMatchObject({ operation: "unlink_login_method" });
        expect(receipt?.result).toMatchObject({
          kind: "oidc",
          sessions_revoked: body.sessions_revoked,
        });
        // The provider's account is nobody's again.
        const gone = await signIn(a, {
          sub: "owner-at-a",
          email: "someone@elsewhere.example",
        });
        expect(gone.status).toBe(401);
      });

      test("the only way that works cannot be removed; a provider that is off does not count", async () => {
        const [password] = await methodsOf(ownerId);
        const only = await unlink(owner, password?.id ?? "");
        expect(only.status).toBe(409);
        expect(await errorOf(only)).toEqual({
          code: "REVISION_CONFLICT",
          reason: "last_login_method",
        });
        const linked = await (
          await started(await linkStart(b, owner), b, {
            sub: "owner-at-b",
            email: "owner@elsewhere.example",
          })
        )([owner]);
        expect(linked.status).toBe(200);
        await setProvider(b, { enabled: false });
        try {
          const mine = await myMethods(owner);
          expect(mine.methods.map((method) => method.usable)).toEqual([
            true,
            false,
          ]);
          expect((await unlink(owner, password?.id ?? "")).status).toBe(409);
        } finally {
          await setProvider(b, { enabled: true });
        }
        expect(await meStatus(owner)).toBe(200);
      });

      test("removing the password ends its sessions, this one included, and the password no longer signs in", async () => {
        const [password] = await methodsOf(ownerId);
        const response = await unlink(owner, password?.id ?? "");
        expect(response.status).toBe(200);
        expect(await meStatus(owner)).toBe(401);
        expect(
          (await userByEmail("owner@example.com"))?.passwordHash,
        ).toBeNull();
        expect(
          (await passwordLogin("owner@example.com", OWNER_WORD)).status,
        ).toBe(401);
        // B is the owner's way in now, and the last one.
        const viaB = await signIn(b, {
          sub: "owner-at-b",
          email: "owner@elsewhere.example",
        });
        expect(viaB.status).toBe(200);
        const session = sessionOf(viaB);
        const mine = await myMethods(session);
        expect(mine.methods).toMatchObject([{ kind: "oidc", usable: true }]);
        const last = await unlink(session, mine.methods[0]?.id ?? "");
        expect(last.status).toBe(409);
        expect(await meStatus(session)).toBe(200);
      });
    });
  },
);
