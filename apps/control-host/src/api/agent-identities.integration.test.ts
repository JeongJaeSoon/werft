import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authorizeSlackInput } from "@werft-ai/chat-slack";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  linkAgentIdentityResponseSchema,
  listAgentIdentitiesResponseSchema,
  listSlackBindingsResponseSchema,
  putSlackBindingResponseSchema,
  revokeAgentIdentityResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentAdmins,
  agents,
  authzDecisions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresDecisionLog,
  createPostgresLinkedAccountStore,
  createPostgresSurfaceBindingStore,
  linkedAccounts,
  memberships,
  receipts,
  registerSlackInstallation,
  surfaceBindings,
  users,
  verifySlackInstallation,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  type AuthorizationPolicy,
  agentForSlackEvent,
  createAgentIdentityService,
  createAuthorizationPolicy,
  createSlackBotApi,
  createSlackChannelSearchService,
  createSurfaceBindingService,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerAgentIdentityRoutes } from "./routes/agent-identities.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerSlackBindingRoutes } from "./routes/slack-bindings.ts";
import { registerSlackChannelRoutes } from "./routes/slack-channels.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const APP = { appId: "A0RESEARCH", teamId: "T0ACME" };

integration("agent identities over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let authorization: AuthorizationPolicy;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_identities_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
    };
    authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: createDatabaseAgentAuthority(db),
      decisions: createPostgresDecisionLog(db),
    });
    const service = createAgentIdentityService({
      authorization,
      store: createPostgresAgentIdentityStore(db),
    });
    const slackBindings = createSurfaceBindingService({
      authorization,
      store: createPostgresSurfaceBindingStore(db),
      channels: { kindOf: async () => "public_channel" },
    });
    app = createApiApp({
      authMode: "api-key",
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerAgentIdentityRoutes(router, { service });
        registerSlackBindingRoutes(router, { service: slackBindings });
        // No agent here has a platform-made app: the search stops at 409.
        registerSlackChannelRoutes(router, {
          service: createSlackChannelSearchService({
            authorization,
            agents: createDatabaseAgentAuthority(db),
            apps: { findForAgent: async () => null },
            secrets: { get: async () => null },
            api: createSlackBotApi({ apiUrl: "http://127.0.0.1:9/api" }),
          }),
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const send = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const errorOf = async (response: Response) =>
    apiErrorResponseSchema.parse(await response.json()).error;
  const store = () => createPostgresAgentIdentityStore(db);

  let workspaceId = "";
  let ownerCookie = "";

  async function login(email: string) {
    const response = await app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const match = /__Host-werft_session=([^;]+)/.exec(
      response.headers.get("Set-Cookie") ?? "",
    );
    return `__Host-werft_session=${match?.[1] ?? ""}`;
  }

  async function addMember(email: string) {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email,
      passwordHash: await Bun.password.hash(PASSWORD, {
        algorithm: "argon2id",
      }),
      displayName: email,
    });
    await db
      .insert(memberships)
      .values({ workspaceId, userId: id, role: "member" });
    return id;
  }

  async function newAgent(slug: string, adminId?: string) {
    const id = crypto.randomUUID();
    await db.insert(agents).values({
      id,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug,
      name: slug,
    });
    if (adminId) {
      await db
        .insert(agentAdmins)
        .values({ workspaceId, agentId: id, userId: adminId });
    }
    return id;
  }

  const LINK = {
    provider: "slack_bot",
    app_id: APP.appId,
    team_id: APP.teamId,
    credential_ref: "slack/research-bot-token",
  };

  test("setup: an owner and a verified install of the agent's app", async () => {
    const boot = await app.request("/v1/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      }),
    });
    expect(boot.status).toBe(201);
    workspaceId = bootstrapResponseSchema.parse(await boot.json()).workspace.id;
    ownerCookie = await login("owner@example.com");
    await registerSlackInstallation(db, { ...APP, workspaceId });
    await verifySlackInstallation(db, { ...APP, botUserId: "B0RESEARCH" });
  });

  test("the agent's admin links its app; events resolve to it; revoking drops them", async () => {
    const managerId = await addMember("manager@example.com");
    const manager = await login("manager@example.com");
    const agentId = await newAgent("research", managerId);
    const other = await newAgent("finance");

    // Before any link, the app's events move no agent.
    expect(await agentForSlackEvent(store(), APP)).toEqual({
      status: "dropped",
      reason: "unidentified",
    });

    const linked = await send(
      "POST",
      `/v1/agents/${agentId}/identities`,
      manager,
      LINK,
    );
    expect(linked.status).toBe(201);
    const body = linkAgentIdentityResponseSchema.parse(await linked.json());
    expect(body.agent_identity).toMatchObject({
      agent_id: agentId,
      app_id: APP.appId,
      team_id: APP.teamId,
      bot_user_id: "B0RESEARCH",
      credential_ref: "slack/research-bot-token",
      status: "active",
      created_by: managerId,
    });

    expect(await agentForSlackEvent(store(), APP)).toMatchObject({
      status: "resolved",
      workspaceId,
      agentId,
      identity: { id: body.agent_identity.id, revision: 1 },
      botUserId: "B0RESEARCH",
    });
    // An event from another app, or one routed to another agent, is dropped.
    expect(
      await agentForSlackEvent(store(), { ...APP, appId: "A0OTHER" }),
    ).toEqual({ status: "dropped", reason: "not_installed" });
    expect(
      await agentForSlackEvent(store(), { ...APP, agentId: other }),
    ).toEqual({ status: "dropped", reason: "agent_mismatch" });

    // The same app cannot be pinned to another agent while this one holds it.
    const taken = await send(
      "POST",
      `/v1/agents/${other}/identities`,
      ownerCookie,
      LINK,
    );
    expect(taken.status).toBe(409);
    expect((await errorOf(taken)).code).toBe("AGENT_IDENTITY_TAKEN");

    const listed = await send(
      "GET",
      `/v1/agents/${agentId}/identities`,
      manager,
    );
    expect(
      listAgentIdentitiesResponseSchema.parse(await listed.json()).items,
    ).toHaveLength(1);

    const revoked = await send(
      "DELETE",
      `/v1/agents/${agentId}/identities/${body.agent_identity.id}`,
      manager,
    );
    expect(revoked.status).toBe(200);
    const revokedBody = revokeAgentIdentityResponseSchema.parse(
      await revoked.json(),
    );
    expect(revokedBody.agent_identity).toMatchObject({
      status: "revoked",
      revision: 2,
    });
    expect(await agentForSlackEvent(store(), APP)).toEqual({
      status: "dropped",
      reason: "identity_revoked",
    });

    const again = await send(
      "DELETE",
      `/v1/agents/${agentId}/identities/${body.agent_identity.id}`,
      manager,
    );
    expect(
      revokeAgentIdentityResponseSchema.parse(await again.json()).receipt_id,
    ).toBeNull();

    const written = await db
      .select({ operation: receipts.operation })
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(written.map((row) => row.operation).sort()).toEqual([
      "link_agent_identity",
      "revoke_agent_identity",
    ]);
  });

  test("another member, and a missing or unverified install, are refused", async () => {
    await addMember("other@example.com");
    const stranger = await login("other@example.com");
    const agentId = await newAgent("support");

    const refused = await send(
      "POST",
      `/v1/agents/${agentId}/identities`,
      stranger,
      LINK,
    );
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    });
    const [decision] = await db
      .select({ outcome: authzDecisions.outcome })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.action, "binding.manage"),
          eq(authzDecisions.reasonCode, "role"),
        ),
      );
    expect(decision?.outcome).toBe("deny");

    const missing = await send(
      "POST",
      `/v1/agents/${agentId}/identities`,
      ownerCookie,
      { ...LINK, app_id: "A0NOWHERE" },
    );
    expect(missing.status).toBe(409);
    expect((await errorOf(missing)).code).toBe("SLACK_NOT_INSTALLED");

    const noAgent = await send(
      "POST",
      `/v1/agents/${crypto.randomUUID()}/identities`,
      ownerCookie,
      LINK,
    );
    expect(noAgent.status).toBe(404);
  });

  test("slack bindings: an agent's admin sets a channel, and a mention there is allowed", async () => {
    const OPS = { appId: "A0OPS", teamId: APP.teamId };
    await registerSlackInstallation(db, { ...OPS, workspaceId });
    await verifySlackInstallation(db, { ...OPS, botUserId: "B0OPS" });
    const adminId = await addMember("ops-admin@example.com");
    const admin = await login("ops-admin@example.com");
    const agentId = await newAgent("ops", adminId);
    const unlinked = await newAgent("ops-unlinked", adminId);
    const linked = await send(
      "POST",
      `/v1/agents/${agentId}/identities`,
      admin,
      {
        ...LINK,
        app_id: OPS.appId,
        credential_ref: "slack/ops-bot-token",
      },
    );
    expect(linked.status).toBe(201);
    const bindingsOf = `/v1/agents/${agentId}/slack-bindings`;

    const put = await send("PUT", bindingsOf, admin, {
      channel_id: "C0OPS",
      channel_kind: "public_channel",
      mode: "on",
      home: true,
    });
    expect(put.status).toBe(200);
    const set = putSlackBindingResponseSchema.parse(await put.json());
    expect(set.slack_binding).toMatchObject({
      agent_id: agentId,
      external_surface_id: "C0OPS",
      surface_kind: "public_channel",
      mode: "on",
      home: true,
      status: "ready",
      revision: 1,
      ceiling: {
        actions: [
          "session.read",
          "session.submit",
          "session.control",
          "session.approve",
        ],
        disclosure: "full",
      },
    });
    const dm = await send("PUT", bindingsOf, ownerCookie, {
      channel_id: null,
      channel_kind: "dm",
      mode: "on",
    });
    expect(dm.status).toBe(200);
    const listed = listSlackBindingsResponseSchema.parse(
      await (await send("GET", bindingsOf, admin)).json(),
    );
    expect(
      listed.items.map((b) => [b.external_surface_id, b.surface_kind, b.home]),
    ).toEqual([
      ["C0OPS", "public_channel", true],
      [null, "dm", false],
    ]);

    // A member, an unknown mode, a home DM, an agent with no app, someone else's agent.
    await addMember("ops-member@example.com");
    const member = await login("ops-member@example.com");
    const body = { channel_id: "C0X", channel_kind: "public_channel" };
    for (const [cookie, path, request, status, code] of [
      [member, bindingsOf, { ...body, mode: "on" }, 403, "FORBIDDEN"],
      [member, bindingsOf, undefined, 403, "FORBIDDEN"],
      [admin, bindingsOf, { ...body, mode: "all" }, 400, "BAD_REQUEST"],
      [
        admin,
        bindingsOf,
        { channel_id: null, channel_kind: "dm", mode: "on", home: true },
        400,
        "BAD_REQUEST",
      ],
      [
        admin,
        `/v1/agents/${unlinked}/slack-bindings`,
        { ...body, mode: "on" },
        409,
        "SLACK_NOT_INSTALLED",
      ],
      [
        admin,
        `/v1/agents/${crypto.randomUUID()}/slack-bindings`,
        { ...body, mode: "on" },
        403,
        "FORBIDDEN",
      ],
    ] as const) {
      const response = await send(
        request === undefined ? "GET" : "PUT",
        path,
        cookie,
        request,
      );
      expect([response.status, (await errorOf(response)).code]).toEqual([
        status,
        code,
      ]);
    }

    // The channel search refuses a member outside the agent the way the
    // binding list does. An id of no agent is 404 to the list, a settings
    // read, and 403 to the search, which is judged as binding like the PUT.
    // To an owner, neither finds another workspace's agent.
    const elsewhere = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: elsewhere, slug: "elsewhere", name: "Elsewhere" });
    const foreign = crypto.randomUUID();
    await db.insert(agents).values({
      id: foreign,
      workspaceId: elsewhere,
      managingTeamId: await fixtureTeam(db, elsewhere),
      slug: "x",
      name: "x",
    });
    for (const [cookie, agent, listStatus] of [
      [member, agentId, 403],
      [admin, crypto.randomUUID(), 404],
    ] as const) {
      const listed = await send(
        "GET",
        `/v1/agents/${agent}/slack-bindings`,
        cookie,
      );
      const searched = await send(
        "GET",
        `/v1/agents/${agent}/slack/channels?q=de`,
        cookie,
      );
      expect(listed.status).toBe(listStatus);
      expect([searched.status, (await errorOf(searched)).code]).toEqual([
        403,
        "FORBIDDEN",
      ]);
    }
    for (const agent of [foreign, crypto.randomUUID()]) {
      const listed = await send(
        "GET",
        `/v1/agents/${agent}/slack-bindings`,
        ownerCookie,
      );
      expect([listed.status, (await errorOf(listed)).code]).toEqual([
        404,
        "NOT_FOUND",
      ]);
      const searched = await send(
        "GET",
        `/v1/agents/${agent}/slack/channels`,
        ownerCookie,
      );
      expect([searched.status, (await errorOf(searched)).code]).toEqual([
        404,
        "NOT_FOUND",
      ]);
    }
    const uninstalled = await send(
      "GET",
      `/v1/agents/${agentId}/slack/channels`,
      admin,
    );
    expect([uninstalled.status, (await errorOf(uninstalled)).code]).toEqual([
      409,
      "SLACK_NOT_INSTALLED",
    ]);

    // The owner's Slack account, linked, mentions the bot in each place.
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "owner@example.com"));
    await db.insert(linkedAccounts).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId: owner?.id ?? "",
      provider: "slack",
      externalTenant: OPS.teamId,
      externalUserId: "U0OWNER",
      verifiedVia: "slack_oidc",
      verifiedAt: new Date(),
    });
    const mention = (channel: { id: string; dm: boolean }) =>
      authorizeSlackInput(
        {
          authorization,
          agents: createPostgresAgentIdentityStore(db),
          links: createPostgresLinkedAccountStore(db),
          bindings: createPostgresSurfaceBindingStore(db),
        },
        {
          event: { ...OPS, agentId },
          user: { id: "U0OWNER", team_id: OPS.teamId },
          action: "session.submit",
          channel,
          resource: { kind: "surface_binding" },
          requestId: crypto.randomUUID(),
          connectUrl: "https://app.example/settings/accounts",
        },
      );
    const outcome = async (channel: { id: string; dm: boolean }) => {
      const decided = await mention(channel);
      if (decided.status !== "decided") throw new Error(decided.reason);
      return [decided.decision.outcome, decided.decision.reason_code];
    };
    expect(await outcome({ id: "C0OPS", dm: false })).toEqual(["allow", "ok"]);
    expect(await outcome({ id: "D0ANY", dm: true })).toEqual(["allow", "ok"]);
    expect(await outcome({ id: "C0UNBOUND", dm: false })).toEqual([
      "deny",
      "surface_ceiling",
    ]);

    // Switched off, the channel takes nothing; the console reads it off.
    const off = await send("PUT", bindingsOf, admin, {
      channel_id: "C0OPS",
      channel_kind: "public_channel",
      mode: "off",
      home: true,
    });
    expect(
      putSlackBindingResponseSchema.parse(await off.json()).slack_binding,
    ).toMatchObject({ id: set.slack_binding.id, mode: "off", revision: 2 });
    expect(await outcome({ id: "C0OPS", dm: false })).toEqual([
      "deny",
      "surface_ceiling",
    ]);
    // Revoked, it is refused as unbound.
    await db
      .update(surfaceBindings)
      .set({ mode: "on", status: "revoked", revokedAt: new Date() })
      .where(eq(surfaceBindings.id, set.slack_binding.id));
    expect(await outcome({ id: "C0OPS", dm: false })).toEqual([
      "deny",
      "surface_ceiling",
    ]);
  });
});
