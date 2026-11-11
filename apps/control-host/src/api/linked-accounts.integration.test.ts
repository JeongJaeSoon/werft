import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  getReceiptResponseSchema,
  listLinkedAccountsResponseSchema,
  slackLinkCallbackResponseSchema,
  startSlackLinkResponseSchema,
  unlinkAccountResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresLinkedAccountStore,
  createPostgresMemberStore,
  linkedAccounts,
  memberships,
  registerSlackInstallation,
  resolveLinkedSubject,
  users,
  verifySlackInstallation,
} from "@werft-ai/db";
import {
  createAuthorizationPolicy,
  createLinkedAccountService,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import {
  type MockSlackOidc,
  startMockSlackOidc,
} from "@werft-ai/testkit/mock-slack-oidc";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore, issueApiKey } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerLinkedAccountRoutes } from "./routes/musterrolle/linked-accounts.ts";
import { SLACK_LINK_COOKIE_NAME } from "./slack-link.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const TEAM = "T0ACME";
const REDIRECT_URI = "https://werft.example/settings/linked-accounts/slack";

integration("Sign in with Slack over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let keys: DatabaseApiKeyStore;
  let idp: MockSlackOidc;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "linked_accounts_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    keys = new DatabaseApiKeyStore(db);
    idp = await startMockSlackOidc();
    const idpClient = {
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      redirectUri: REDIRECT_URI,
      slackAppId: "019a0000-0000-7000-8000-0000000000a1",
    };
    const identity = new DatabaseIdentityStore(db);
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
    };
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    });
    const service = createLinkedAccountService({
      authorization,
      store: createPostgresLinkedAccountStore(db),
    });
    app = createApiApp({
      authMode: "api-key",
      keyStore: keys,
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerLinkedAccountRoutes(router, {
          service,
          github: { oauth: { client: async () => null }, redirectUri: null },
          slack: {
            issuer: idp.url,
            clients: {
              clientFor: async () => idpClient,
              clientForStart: async () => idpClient,
            },
          },
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await idp?.stop();
    await pool?.end();
    await database?.drop();
  });

  const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const cookieOf = (response: Response, name: string) => {
    const match = new RegExp(`${name}=([^;]+)`).exec(
      response.headers.get("Set-Cookie") ?? "",
    );
    return match ? `${name}=${match[1]}` : "";
  };
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  const errorOf = async (response: Response) =>
    apiErrorResponseSchema.parse(await response.json()).error;

  let workspaceId = "";
  let ownerId = "";

  async function addMember(email: string) {
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(PASSWORD, {
          algorithm: "argon2id",
        }),
        displayName: email,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    await db
      .insert(memberships)
      .values({ workspaceId, userId: user.id, role: "member" });
    return user.id;
  }

  async function login(email: string) {
    const response = await post(
      "/v1/auth/login",
      { email, password: PASSWORD },
      { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    );
    expect(response.status).toBe(200);
    return cookieOf(response, "__Host-werft_session");
  }

  /** The whole browser round trip, as the account `mock` names. */
  async function linkAs(session: string, mock: { team: string; user: string }) {
    const started = await post(
      "/v1/linked-accounts/slack/start",
      {},
      asCookie(session),
    );
    expect(started.status).toBe(200);
    const { authorize_url } = startSlackLinkResponseSchema.parse(
      await started.json(),
    );
    const { code, state } = await idp.consent(
      `${authorize_url}&mock_team=${mock.team}&mock_user=${mock.user}`,
    );
    return post(
      "/v1/linked-accounts/slack/callback",
      { code, state },
      asCookie(`${session}; ${cookieOf(started, SLACK_LINK_COOKIE_NAME)}`),
    );
  }

  test("setup: an owner, a workspace with a verified Slack install", async () => {
    const boot = await post("/v1/auth/bootstrap", {
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
    const install = { appId: "A0SHARED", teamId: TEAM };
    await registerSlackInstallation(db, { ...install, workspaceId });
    await verifySlackInstallation(db, { ...install, botUserId: "U0BOT" });
  });

  test("a person with no login is told to sign in, and who can invite them", async () => {
    const response = await post("/v1/linked-accounts/slack/start", {});
    expect(response.status).toBe(401);
    expect((await errorOf(response)).message).toBe(
      "웹에 로그인한 뒤 다시 열어 주세요. 계정이 없으면 owner·admin에게 초대를 요청하세요",
    );
    // A login attempt for an account that does not exist is refused as any
    // wrong password is.
    const refused = await post(
      "/v1/auth/login",
      { email: "nobody@example.com", password: PASSWORD },
      { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    );
    expect(refused.status).toBe(401);
  });

  test("links the member's Slack account, shows it linked, and audits it", async () => {
    const memberId = await addMember("member@example.com");
    const session = await login("member@example.com");
    const response = await linkAs(session, { team: TEAM, user: "U0MEMBER" });
    expect(response.status).toBe(201);
    const linked = slackLinkCallbackResponseSchema.parse(await response.json());
    expect(linked.linked_account).toMatchObject({
      user_id: memberId,
      provider: "slack",
      external_tenant: TEAM,
      external_user_id: "U0MEMBER",
      status: "active",
      revision: 1,
    });

    const list = await app.request("/v1/linked-accounts", {
      headers: asCookie(session),
    });
    expect(
      listLinkedAccountsResponseSchema.parse(await list.json()).items,
    ).toEqual([linked.linked_account]);

    const [receipt] = await db
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.id, linked.receipt_id));
    const view = getReceiptResponseSchema.parse({
      id: receipt?.id,
      operation: receipt?.operation,
      target_ref: receipt?.targetRef,
      actor: receipt?.actor,
      status: receipt?.status,
      result: receipt?.result,
      error: null,
      created_at: receipt?.createdAt.toISOString(),
      updated_at: receipt?.updatedAt.toISOString(),
    });
    expect(view).toMatchObject({
      operation: "link_account",
      status: "succeeded",
      target_ref: { user_id: memberId, workspace_id: workspaceId },
      actor: {
        principal: { kind: "user", id: memberId },
        actor_user_id: memberId,
      },
    });
  });

  test("an account from another Slack team is refused, naming the workspace", async () => {
    const session = await login("member@example.com");
    const response = await linkAs(session, {
      team: "T0ELSEWHERE",
      user: "U0OTHER",
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "LINK_TEAM_MISMATCH",
      message:
        "이 Slack 워크스페이스는 연결된 곳이 아니에요. Acme 워크스페이스 계정으로 다시 시도하세요",
    });
  });

  test("an account linked to someone else is refused and stays theirs", async () => {
    const session = await login("owner@example.com");
    const response = await linkAs(session, { team: TEAM, user: "U0MEMBER" });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "LINK_TAKEN",
      message:
        "이 Slack 계정은 다른 사용자에게 연결돼 있어요. owner·admin에게 문의하세요",
    });
    const subject = await resolveLinkedSubject(db, {
      provider: "slack",
      externalTenant: TEAM,
      externalUserId: "U0MEMBER",
    });
    expect(subject.status).toBe("linked");
    expect(subject.status === "linked" && subject.userId).not.toBe(ownerId);
  });

  test("an API key, even the person's own, cannot link or list", async () => {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "member@example.com"));
    const key = await issueApiKey(keys, {
      workspaceId,
      scopes: ["sessions:read", "sessions:write"],
      personalFor: member?.id ?? "",
    });
    const bearer = { Authorization: `Bearer ${key.plaintext}` };
    expect(
      (await post("/v1/linked-accounts/slack/start", {}, bearer)).status,
    ).toBe(403);
    expect(
      (await app.request("/v1/linked-accounts", { headers: bearer })).status,
    ).toBe(403);
  });

  test("unlinking refuses the account's next input and input that was already waiting", async () => {
    const session = await login("member@example.com");
    const account = {
      provider: "slack" as const,
      externalTenant: TEAM,
      externalUserId: "U0MEMBER",
    };
    const waiting = await resolveLinkedSubject(db, account);
    if (waiting.status !== "linked") throw new Error(waiting.status);

    const unlinked = await app.request(
      `/v1/linked-accounts/${waiting.linkedAccount.id}`,
      { method: "DELETE", headers: asCookie(session) },
    );
    expect(unlinked.status).toBe(200);
    const receipt = unlinkAccountResponseSchema.parse(await unlinked.json());
    expect(receipt.receipt_status).toBe("succeeded");

    expect(await resolveLinkedSubject(db, account)).toEqual({
      status: "unlinked",
    });
    const decision = await createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    }).authorize({
      subject: {
        principal: {
          kind: "installation",
          id: crypto.randomUUID(),
          owner_id: workspaceId,
          workspace_id: workspaceId,
          scopes: ["sessions:write"],
        },
        actor_user_id: waiting.userId,
        linked_account: waiting.linkedAccount,
        surface: {
          kind: "slack",
          slack_user_kind: "member",
          ceiling: { actions: ["session.submit"], disclosure: "full" },
          agent_id: crypto.randomUUID(),
        },
      },
      action: "session.submit",
      resource: { kind: "surface_binding", id: null, owner_scope: workspaceId },
      request_id: crypto.randomUUID(),
    });
    expect(decision).toMatchObject({
      outcome: "deny",
      reason_code: "unlinked",
    });

    const list = await app.request("/v1/linked-accounts", {
      headers: asCookie(session),
    });
    expect(listLinkedAccountsResponseSchema.parse(await list.json())).toEqual({
      items: [],
    });
  });

  test("a deactivated Slack account goes stale; offboarding revokes the link", async () => {
    const leaverId = await addMember("leaver@example.com");
    const session = await login("leaver@example.com");
    const account = {
      provider: "slack" as const,
      externalTenant: TEAM,
      externalUserId: "U0LEAVER",
    };
    expect(
      (await linkAs(session, { team: TEAM, user: "U0LEAVER" })).status,
    ).toBe(201);
    const store = createPostgresLinkedAccountStore(db);
    expect((await store.markStale(account)).outcome).toBe("stale");
    expect((await resolveLinkedSubject(db, account)).status).toBe("stale");

    const offboarded = await createPostgresMemberStore(db).setAccess({
      actor: {
        principal: {
          ownerId: workspaceId,
          requestId: "req-offboard",
          actor: {
            principal: { kind: "user", id: ownerId },
            userId: ownerId,
            workspaceId,
            apiKeyId: null,
          },
        },
        workspaceId,
        userId: ownerId,
      },
      userId: leaverId,
      scope: "membership",
      disabled: true,
      reason: null,
      receiptId: crypto.randomUUID(),
    });
    expect(offboarded).toMatchObject({
      outcome: "changed",
      effects: { revokedLinkedAccounts: 1 },
    });
    expect((await resolveLinkedSubject(db, account)).status).toBe("revoked");
    const rows = await db
      .select({
        status: linkedAccounts.status,
        reason: linkedAccounts.revokedReason,
      })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.externalUserId, "U0LEAVER"));
    expect(rows).toEqual([{ status: "revoked", reason: "offboarded" }]);
  });
});
