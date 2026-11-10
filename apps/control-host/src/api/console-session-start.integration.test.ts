import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createAgentReleaseResponseSchema,
  createSessionResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentAccessSetting,
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
  workspaces,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAgentService,
  createAuthorizationPolicy,
  createSessionService,
  type SessionCatalog,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { TEST_CONNECTION_ID, TEST_RUNTIMES, testCatalog } from "../test-support/catalog.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const SETUP_TOKEN = "console-session-start-integration-setup";
const LOGIN = "console-session-start-login";

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

integration("starting an agent's session from the console", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let workspaceId = "";
  let releaseId = "";
  let outsiderId = "";
  const cookies = { owner: "", teammate: "", outsider: "" };

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
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  const start = (headers: HeadersInit) =>
    send(
      "POST",
      "/v1/sessions",
      { ...headers, "Idempotency-Key": crypto.randomUUID() },
      { agent_release_id: releaseId, message: "요약해 줘" },
    );
  const setAccess = (value: "use" | "view" | "none") =>
    db
      .update(workspaces)
      .set({
        settings: sql`${workspaces.settings} || jsonb_build_object('agent_outsider_access', ${value}::text)`,
      })
      .where(eq(workspaces.id, workspaceId));

  async function login(email: string) {
    const response = await send(
      "POST",
      "/v1/auth/login",
      { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      { email, password: LOGIN },
    );
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  async function addMember(email: string) {
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(LOGIN, {
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

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "console_session_start" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(SETUP_TOKEN),
      lockout: new LoginLockout(),
      logger,
    };
    const credentials = createPostgresCredentialBindingStore(db);
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: createDatabaseAgentAuthority(db),
      credentials,
      outsideAgents: createPostgresAgentAccessSetting(db),
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
        registerAgentRoutes(router, agents);
      },
    });

    const boot = await send(
      "POST",
      "/v1/auth/bootstrap",
      {},
      {
        bootstrap_token: SETUP_TOKEN,
        email: "owner@example.com",
        password: LOGIN,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      },
    );
    expect(boot.status).toBe(201);
    workspaceId = bootstrapResponseSchema.parse(await boot.json()).workspace.id;
    const teammateId = await addMember("teammate@example.com");
    outsiderId = await addMember("outsider@example.com");
    cookies.owner = await login("owner@example.com");
    cookies.teammate = await login("teammate@example.com");
    cookies.outsider = await login("outsider@example.com");

    const teamId = crypto.randomUUID();
    await db
      .insert(schema.memberTeams)
      .values({ id: teamId, workspaceId, name: "reviewers" });
    await db.insert(schema.memberTeamMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      teamId,
      userId: teammateId,
    });
    const created = await send("POST", "/v1/agents", asCookie(cookies.owner), {
      slug: "reviewer",
      name: "reviewer",
      managing_team_id: teamId,
      card,
    });
    expect(created.status).toBe(201);
    const detail = (await created.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    const released = await send(
      "POST",
      `/v1/agents/${detail.agent.id}/releases`,
      asCookie(cookies.owner),
      {
        version_id: detail.versions[0]?.id,
        connection_id: TEST_CONNECTION_ID,
        repository_id: "sample-app",
      },
    );
    expect(released.status).toBe(200);
    releaseId = createAgentReleaseResponseSchema.parse(await released.json())
      .release.id;
    // A session starts only on a release an activation approved.
    const activated = await send(
      "POST",
      `/v1/agents/${detail.agent.id}/activate`,
      asCookie(cookies.owner),
      { release_id: releaseId, expected_revision: -1 },
    );
    expect(activated.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  test("a cookie without the CSRF header starts nothing", async () => {
    const refused = await start({ Cookie: cookies.owner });
    expect(refused.status).toBe(403);
  });

  test("a member outside the agent starts while axis A is `use`, as themselves, and reads the session", async () => {
    await setAccess("use");
    const response = await start(asCookie(cookies.outsider));
    expect(response.status).toBe(201);
    const created = createSessionResponseSchema.parse(await response.json());
    const [row] = await db
      .select({
        creator: sessions.createdByUserId,
        channel: sessions.channel,
        release: sessions.agentReleaseId,
      })
      .from(sessions)
      .where(eq(sessions.id, created.session_id));
    // A session started on a release runs that release's spec.
    expect(row).toEqual({
      creator: outsiderId,
      channel: "web",
      release: releaseId,
    });
    const [receipt] = await db
      .select({ operation: receipts.operation })
      .from(receipts)
      .where(eq(receipts.id, created.receipt_id));
    expect(receipt?.operation).toBe("create_session");
    const read = await send(
      "GET",
      `/v1/sessions/${created.session_id}`,
      asCookie(cookies.outsider),
    );
    expect(read.status).toBe(200);
  });

  for (const access of ["view", "none"] as const) {
    test(`axis A \`${access}\` refuses the member outside and no one inside`, async () => {
      await setAccess(access);
      const before = await db.$count(sessions);
      const refused = await start(asCookie(cookies.outsider));
      expect(refused.status).toBe(403);
      const { error } = apiErrorResponseSchema.parse(await refused.json());
      expect(error.code).toBe("FORBIDDEN");
      expect(error.details).toMatchObject({ reason_code: "role" });
      expect(await db.$count(sessions)).toBe(before);

      expect((await start(asCookie(cookies.teammate))).status).toBe(201);
      expect((await start(asCookie(cookies.owner))).status).toBe(201);
    });
  }
});
