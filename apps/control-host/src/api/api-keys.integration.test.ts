import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createAgentReleaseResponseSchema,
  createApiKeyResponseSchema,
  createSessionResponseSchema,
  listAgentsResponseSchema,
  listApiKeysResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentAdmins,
  apiKeys,
  authzDecisions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkspaceKeyStore,
  memberships,
  newSessionGitHubReaders,
  receipts,
  sessions,
  users,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAgentService,
  createApiKeyService,
  createAuthorizationPolicy,
  createSessionService,
  type SessionCatalog,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testCatalog,
} from "../testing/catalog.ts";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import {
  DatabaseApiKeyStore,
  generateApiKey,
  hashApiKey,
  issueApiKey,
} from "./keys.ts";
import { registerAgentRoutes } from "./routes/agents/agents.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerApiKeyRoutes } from "./routes/musterrolle/api-keys.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions/sessions.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";

const catalog: SessionCatalog = testCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true } as const,
    },
  },
});

const card = {
  role: "리뷰어",
  instructions: "변경을 읽고 위험을 요약한다.",
  language: "ko" as const,
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  rules: [],
};

// Design 4.1 scenario d over HTTP: who may issue which key, and what each
// key then reaches.
integration("API keys by authority over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "api_keys_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger,
    };
    const credentials = createPostgresCredentialBindingStore(db);
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: createDatabaseAgentAuthority(db),
      credentials,
      decisions: createPostgresDecisionLog(db),
    });
    const agents = createAgentService({
      authorization,
      store: createPostgresAgentStore(db),
      catalog,
      credentials,
      keys: createPostgresWorkspaceKeyStore(db),
      runtimes: TEST_RUNTIMES,
    });
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization,
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog,
      releases: { ...agents, ...newSessionGitHubReaders(db) },
      credentials,
    });
    const keys = createApiKeyService({
      authorization,
      store: createPostgresWorkspaceKeyStore(db),
      mint: () => {
        const secret = generateApiKey();
        return { secret, hash: hashApiKey(secret) };
      },
    });
    app = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      authorization,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerSessionRoutes(router, service);
        registerReceiptRoutes(router, service);
        registerAgentRoutes(router, agents);
        registerApiKeyRoutes(router, keys);
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const send = (
    method: string,
    path: string,
    headers: HeadersInit,
    body?: unknown,
  ) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  async function errorOf(response: Response) {
    return apiErrorResponseSchema.parse(await response.json()).error;
  }

  let workspaceId = "";
  const cookies: Record<"owner" | "member" | "admin" | "other", string> = {
    owner: "",
    member: "",
    admin: "",
    other: "",
  };
  let memberId = "";
  const releases: Record<"mine" | "owners", string> = { mine: "", owners: "" };
  const agentIds: Record<"mine" | "owners", string> = { mine: "", owners: "" };

  async function login(email: string) {
    const response = await send(
      "POST",
      "/v1/auth/login",
      { "X-Requested-With": "werft-web" },
      { email, password: PASSWORD },
    );
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  async function addUser(email: string, role: "member" | "admin") {
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
    await db.insert(memberships).values({ workspaceId, userId: user.id, role });
    return user.id;
  }

  /** A team holding `members`, as rows: this app has no team routes. */
  async function team(name: string, ...members: string[]) {
    const teamId = crypto.randomUUID();
    await db
      .insert(schema.memberTeams)
      .values({ id: teamId, workspaceId, name });
    for (const userId of members) {
      await db.insert(schema.memberTeamMembers).values({
        id: crypto.randomUUID(),
        workspaceId,
        teamId,
        userId,
      });
    }
    return teamId;
  }

  async function agentWithRelease(
    cookie: string,
    slug: string,
    teamId: string,
  ) {
    const created = await send("POST", "/v1/agents", asCookie(cookie), {
      slug,
      name: slug,
      managing_team_id: teamId,
      card,
    });
    expect(created.status).toBe(201);
    const detail = (await created.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    const versionId = detail.versions[0]?.id;
    const released = await send(
      "POST",
      `/v1/agents/${detail.agent.id}/releases`,
      asCookie(cookie),
      {
        version_id: versionId,
        connection_id: TEST_CONNECTION_ID,
        repository_id: "sample-app",
      },
    );
    expect(released.status).toBe(200);
    const { release } = createAgentReleaseResponseSchema.parse(
      await released.json(),
    );
    // A session starts only on a release an activation approved.
    const activated = await send(
      "POST",
      `/v1/agents/${detail.agent.id}/activate`,
      asCookie(cookie),
      { release_id: release.id, expected_revision: -1 },
    );
    expect(activated.status).toBe(200);
    return { agentId: detail.agent.id, releaseId: release.id };
  }

  async function issue(headers: HeadersInit, body: unknown) {
    return send("POST", "/v1/api-keys", headers, body);
  }

  function createSession(headers: HeadersInit, agentReleaseId?: string) {
    return send(
      "POST",
      "/v1/sessions",
      { ...headers, "Idempotency-Key": crypto.randomUUID() },
      {
        repository_id: "sample-app",
        message: "Review the change.",
        ...(agentReleaseId ? { agent_release_id: agentReleaseId } : {}),
      },
    );
  }

  // The authenticator records a use without awaiting it.
  async function lastUsedOf(keyId: string) {
    for (let tries = 0; tries < 40; tries++) {
      const [row] = await db
        .select({ at: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));
      if (row?.at) return row.at;
      await Bun.sleep(50);
    }
    return null;
  }

  async function decisionsFor(action: string) {
    return db
      .select({
        outcome: authzDecisions.outcome,
        reason: authzDecisions.reasonCode,
      })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.action, action),
          eq(authzDecisions.workspaceId, workspaceId),
        ),
      );
  }

  test("setup: an owner, a member who makes an agent, an admin", async () => {
    const boot = await send(
      "POST",
      "/v1/auth/bootstrap",
      {},
      {
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      },
    );
    expect(boot.status).toBe(201);
    workspaceId = bootstrapResponseSchema.parse(await boot.json()).workspace.id;
    cookies.owner = await login("owner@example.com");
    memberId = await addUser("member@example.com", "member");
    await addUser("admin@example.com", "admin");
    await addUser("other@example.com", "member");
    cookies.member = await login("member@example.com");
    cookies.admin = await login("admin@example.com");
    cookies.other = await login("other@example.com");

    const mine = await agentWithRelease(
      cookies.member,
      "reviewer",
      await team("reviewers", memberId),
    );
    const owners = await agentWithRelease(
      cookies.owner,
      "finance",
      await team("finance"),
    );
    agentIds.mine = mine.agentId;
    agentIds.owners = owners.agentId;
    releases.mine = mine.releaseId;
    releases.owners = owners.releaseId;
    // D3: whoever makes an agent administers it.
    expect(
      await db
        .select({ userId: agentAdmins.userId })
        .from(agentAdmins)
        .where(eq(agentAdmins.agentId, mine.agentId)),
    ).toEqual([{ userId: memberId }]);
  });

  let agentKey = "";
  let personalKey = "";
  let agentKeyId = "";

  test("an agent's admin issues a named key bound to it, and no other key", async () => {
    const bound = await issue(asCookie(cookies.member), {
      kind: "agent",
      name: "  ci-deploy  ",
      agent_id: agentIds.mine,
      scopes: ["sessions:read", "sessions:write"],
    });
    expect(bound.status).toBe(201);
    const created = createApiKeyResponseSchema.parse(await bound.json());
    expect(created.key).toMatchObject({
      kind: "agent",
      name: "ci-deploy",
      agent_id: agentIds.mine,
      created_by: memberId,
      created_by_user: { id: memberId, display_name: "member@example.com" },
      last_used_at: null,
    });
    agentKey = created.secret;
    agentKeyId = created.key.id;

    const refused = await issue(asCookie(cookies.member), {
      kind: "agent",
      agent_id: agentIds.owners,
      scopes: ["sessions:read"],
    });
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    });
    // A member who administers nothing has no agent key either.
    expect(
      (
        await issue(asCookie(cookies.other), {
          kind: "agent",
          agent_id: agentIds.mine,
          scopes: ["sessions:read"],
        })
      ).status,
    ).toBe(403);
  });

  test("the agent's key creates sessions on its agent and reaches nothing else", async () => {
    const own = await createSession(bearer(agentKey), releases.mine);
    expect(own.status).toBe(201);
    const { session_id, receipt_id } = createSessionResponseSchema.parse(
      await own.json(),
    );
    const [row] = await db
      .select({ release: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, session_id));
    expect(row?.release).toBe(releases.mine);
    expect(
      (await send("GET", `/v1/sessions/${session_id}`, bearer(agentKey)))
        .status,
    ).toBe(200);

    const other = await createSession(bearer(agentKey), releases.owners);
    expect(other.status).toBe(403);
    expect(await errorOf(other)).toMatchObject({
      details: { reason_code: "agent_ceiling" },
    });
    // Every session names its release: one without is a bad request.
    expect((await createSession(bearer(agentKey))).status).toBe(400);
    // The owner's session on another agent is out of its reach.
    const owners = await createSession(
      asCookie(cookies.owner),
      releases.owners,
    );
    const { session_id: ownersId, receipt_id: ownersReceiptId } =
      createSessionResponseSchema.parse(await owners.json());
    expect(
      (await send("GET", `/v1/receipts/${receipt_id}`, bearer(agentKey)))
        .status,
    ).toBe(200);
    for (const path of [
      `/v1/sessions/${ownersId}`,
      `/v1/sessions/${ownersId}/turns`,
      // A list spans agents.
      "/v1/sessions",
      // Narrowing to its own agent does not lift the list's refusal.
      `/v1/sessions?agent_id=${agentIds.mine}`,
      `/v1/receipts/${ownersReceiptId}`,
    ]) {
      expect((await send("GET", path, bearer(agentKey))).status).toBe(403);
    }
    // No management action, its own agent's included.
    expect(
      (
        await send("PATCH", `/v1/agents/${agentIds.mine}`, bearer(agentKey), {
          name: "renamed",
        })
      ).status,
    ).toBe(403);
  });

  test("a member issues a personal key, and no key issues a key", async () => {
    const response = await issue(asCookie(cookies.member), {
      kind: "personal",
      scopes: ["sessions:read", "sessions:write"],
    });
    expect(response.status).toBe(201);
    personalKey = createApiKeyResponseSchema.parse(
      await response.json(),
    ).secret;
    for (const key of [personalKey, agentKey]) {
      const refused = await issue(bearer(key), {
        kind: "personal",
        scopes: ["sessions:read"],
      });
      expect(refused.status).toBe(403);
    }
  });

  test("an agent key that creates sessions finds its own agent's active release, and only that", async () => {
    const activated = await send(
      "POST",
      `/v1/agents/${agentIds.mine}/activate`,
      asCookie(cookies.member),
      { release_id: releases.mine, expected_revision: 0 },
    );
    expect(activated.status).toBe(200);

    const listed = await send("GET", "/v1/agents?limit=50", bearer(agentKey));
    expect(listed.status).toBe(200);
    const page = listAgentsResponseSchema.parse(await listed.json());
    expect(page.next_cursor).toBeNull();
    expect(
      page.items.map(({ id, active_release_id }) => ({
        id,
        active_release_id,
      })),
    ).toEqual([{ id: agentIds.mine, active_release_id: releases.mine }]);

    // The release alone names the connection and the repository.
    const created = await send(
      "POST",
      "/v1/sessions",
      { ...bearer(agentKey), "Idempotency-Key": crypto.randomUUID() },
      { agent_release_id: releases.mine, message: "Review the change." },
    );
    expect(created.status).toBe(201);
    const { session_id } = createSessionResponseSchema.parse(
      await created.json(),
    );
    expect(
      (await send("GET", `/v1/sessions/${session_id}`, bearer(agentKey)))
        .status,
    ).toBe(200);

    const readOnly = createApiKeyResponseSchema.parse(
      await (
        await issue(asCookie(cookies.owner), {
          kind: "agent",
          agent_id: agentIds.owners,
          scopes: ["sessions:read"],
        })
      ).json(),
    ).secret;
    for (const [headers, path, reason] of [
      // What a card shows an admin is not the key's to read.
      [bearer(agentKey), "/v1/agents?include=summary", undefined],
      // The scope check refuses it before the service reads anything.
      [bearer(readOnly), "/v1/agents", undefined],
      [bearer(personalKey), "/v1/agents", undefined],
      [bearer(agentKey), "/v1/agents/counts", undefined],
      [bearer(agentKey), `/v1/agents/${agentIds.mine}`, "role"],
    ] as const) {
      const refused = await send("GET", path, headers);
      expect(refused.status, path).toBe(403);
      const error = await errorOf(refused);
      expect(error.code).toBe("FORBIDDEN");
      if (reason) expect(error.details).toMatchObject({ reason_code: reason });
    }
  });

  test("no key reaches a whole workspace: one without an agent is refused, even for the owner", async () => {
    const before = await db.select({ id: apiKeys.id }).from(apiKeys);
    for (const body of [
      { kind: "agent", scopes: ["sessions:read"] },
      { kind: "service", scopes: ["sessions:read"] },
      { kind: "service", agent_id: agentIds.owners, scopes: ["sessions:read"] },
      { kind: "personal", name: " ", scopes: ["sessions:read"] },
      { kind: "personal", name: "x".repeat(65), scopes: ["sessions:read"] },
    ]) {
      const refused = await issue(asCookie(cookies.owner), body);
      expect(refused.status).toBe(400);
      expect((await errorOf(refused)).code).toBe("BAD_REQUEST");
    }
    expect(await db.select({ id: apiKeys.id }).from(apiKeys)).toHaveLength(
      before.length,
    );
  });

  test("the key CLI's store refuses an operator key on a workspace's own partition", async () => {
    const store = new DatabaseApiKeyStore(db);
    const operator = (ownerId: string) =>
      issueApiKey(store, { ownerId, scopes: ["sessions:read"] });
    await expect(operator(workspaceId)).rejects.toThrow("is a workspace");
    // Partitions compare as text: the upper-cased id is a partition of its own.
    await operator(workspaceId.toUpperCase());
    const rows = await db
      .select({ ownerId: apiKeys.ownerId, kind: apiKeys.kind })
      .from(apiKeys)
      .where(eq(apiKeys.kind, "operator"));
    expect(rows).toEqual([
      { ownerId: workspaceId.toUpperCase(), kind: "operator" },
    ]);
  });

  test("never above the issuer's scopes: an admin cannot hand out recover", async () => {
    const refused = await issue(asCookie(cookies.admin), {
      kind: "agent",
      agent_id: agentIds.owners,
      scopes: ["sessions:read", "sessions:recover"],
    });
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).code).toBe("SCOPE_NOT_GRANTABLE");
    const approve = await issue(asCookie(cookies.owner), {
      kind: "agent",
      agent_id: agentIds.owners,
      scopes: ["sessions:approve"],
    });
    expect(approve.status).toBe(201);
    expect(
      (
        await issue(asCookie(cookies.admin), {
          kind: "agent",
          agent_id: agentIds.owners,
          scopes: ["sessions:read"],
        })
      ).status,
    ).toBe(201);
  });

  test("each list shows only what its caller manages", async () => {
    const list = async (cookie: string) =>
      listApiKeysResponseSchema.parse(
        await (await send("GET", "/v1/api-keys", asCookie(cookie))).json(),
      ).items;
    const denialsBefore = (await decisionsFor("api_key.manage")).length;
    const members = await list(cookies.member);
    expect(members.map((key) => key.kind).sort()).toEqual([
      "agent",
      "personal",
    ]);
    expect(await list(cookies.other)).toEqual([]);
    // A listing asks nothing it would record a denial for.
    expect((await decisionsFor("api_key.manage")).length).toBe(denialsBefore);
    // The admin's agent key; nobody's personal key but their own.
    expect(
      (await list(cookies.owner)).every((key) => key.kind === "agent"),
    ).toBe(true);
  });

  test("issue and revoke leave receipts and decision rows", async () => {
    const listed = listApiKeysResponseSchema.parse(
      await (
        await send("GET", "/v1/api-keys", asCookie(cookies.member))
      ).json(),
    ).items;
    const personal = listed.find((key) => key.kind === "personal");
    if (!personal) throw new Error("no personal key");
    const revoked = await send(
      "DELETE",
      `/v1/api-keys/${personal.id}`,
      asCookie(cookies.member),
    );
    expect(revoked.status).toBe(200);
    expect((await send("GET", "/v1/auth/me", bearer(personalKey))).status).toBe(
      401,
    );

    const written = await db
      .select({ operation: receipts.operation })
      .from(receipts)
      .where(sql`${receipts.targetRef}->'resource'->>'kind' = 'api_key'`);
    expect(
      written.filter((r) => r.operation === "create_api_key").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      written.filter((r) => r.operation === "revoke_api_key"),
    ).toHaveLength(1);

    const manage = await decisionsFor("api_key.manage");
    expect(manage.some((d) => d.outcome === "allow")).toBe(true);
    expect(
      manage.some((d) => d.outcome === "deny" && d.reason === "role"),
    ).toBe(true);
    expect(
      (await decisionsFor("api_key.manage_own")).some(
        (d) => d.outcome === "allow",
      ),
    ).toBe(true);
    expect(
      (await decisionsFor("session.submit")).some(
        (d) => d.reason === "agent_ceiling",
      ),
    ).toBe(true);
  });

  test("a personal key dies with its issuer, an agent key outlives them", async () => {
    const response = await issue(asCookie(cookies.member), {
      kind: "personal",
      scopes: ["sessions:read"],
    });
    const personal = createApiKeyResponseSchema.parse(
      await response.json(),
    ).secret;
    expect((await send("GET", "/v1/auth/me", bearer(personal))).status).toBe(
      200,
    );
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, memberId));
    expect((await send("GET", "/v1/auth/me", bearer(personal))).status).toBe(
      401,
    );
    expect((await createSession(bearer(agentKey), releases.mine)).status).toBe(
      201,
    );
  });

  test("a listed key shows its last use and its departed issuer's name, and no other member field", async () => {
    const usedAt = await lastUsedOf(agentKeyId);
    expect(usedAt).not.toBeNull();
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, memberId));
    const response = await send("GET", "/v1/api-keys", asCookie(cookies.owner));
    const raw = (await response.json()) as {
      items: Record<string, unknown>[];
    };
    const row = listApiKeysResponseSchema
      .parse(raw)
      .items.find((key) => key.id === agentKeyId);
    expect(row).toMatchObject({
      created_by_user: { id: memberId, display_name: "member@example.com" },
      last_used_at: usedAt?.toISOString(),
    });
    for (const item of raw.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "agent_id",
          "created_at",
          "created_by",
          "created_by_user",
          "expires_at",
          "id",
          "kind",
          "last_used_at",
          "name",
          "revoked_at",
          "scopes",
          "workspace_id",
        ].sort(),
      );
      if (item.created_by_user !== null) {
        expect(Object.keys(item.created_by_user as object).sort()).toEqual([
          "display_name",
          "id",
        ]);
      }
    }
  });

  test("the list pages by cursor over HTTP, and a bad cursor or limit is a 400", async () => {
    const page = async (query: string) => {
      const response = await send(
        "GET",
        `/v1/api-keys${query}`,
        asCookie(cookies.owner),
      );
      expect(response.status).toBe(200);
      return listApiKeysResponseSchema.parse(await response.json());
    };
    const all = await page("");
    expect(all.next_cursor).toBeNull();
    expect(all.items.length).toBeGreaterThan(1);
    const walked: string[] = [];
    let query = "?limit=1";
    for (;;) {
      const one = await page(query);
      expect(one.items).toHaveLength(1);
      walked.push(...one.items.map((key) => key.id));
      if (one.next_cursor === null) break;
      query = `?limit=1&cursor=${encodeURIComponent(one.next_cursor)}`;
    }
    expect(walked).toEqual(all.items.map((key) => key.id));

    for (const bad of ["?cursor=not-a-cursor", "?limit=0", "?limit=101"]) {
      const response = await send(
        "GET",
        `/v1/api-keys${bad}`,
        asCookie(cookies.owner),
      );
      expect(response.status, bad).toBe(400);
      expect((await errorOf(response)).code, bad).toBe("BAD_REQUEST");
    }
  });
});
