import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AGENT_GITHUB_ACTIVITY_LIMIT,
  type AgentGitHub,
  agentGitHubActivityResponseSchema,
  agentGitHubResponseSchema,
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createAgentReleaseResponseSchema,
  createApiKeyResponseSchema,
  githubSettingsResponseSchema,
  newSessionGitHubPolicy,
  putAgentGitHubEnabledResponseSchema,
  putAgentGitHubSettingsResponseSchema,
  repositoryRefOf,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentGitHubStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresGitHubGateStore,
  createPostgresGitHubOAuthStore,
  createPostgresGitHubSettingsStore,
  createPostgresPullRequestSettingsStore,
  createPostgresWorkspaceKeyStore,
  memberships,
  users,
} from "@werft-ai/db";
import { createGitHubAppDirectory } from "@werft-ai/forge-github";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAgentGitHubService,
  createAgentPullRequestService,
  createAgentService,
  createApiKeyService,
  createAuthorizationPolicy,
  createGitHubSettingsService,
  type SessionCatalog,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore, generateApiKey, hashApiKey } from "./keys.ts";
import { registerAgentGitHubRoutes } from "./routes/agent-github.ts";
import { registerAgentPullRequestRoutes } from "./routes/agent-pull-request.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerApiKeyRoutes } from "./routes/api-keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerGitHubSettingsRoutes } from "./routes/github-settings.ts";
import { TEST_CONNECTION_ID, TEST_RUNTIMES, testCatalog } from "../test-support/catalog.ts";
import { sessionPinValues } from "@werft-ai/db/testing/spec-pins";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "bootstrap-token-for-the-agent-github-tab";
const PASSWORD = "correct horse battery staple";

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
      url: "https://github.com/acme/sample-app",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

const card = {
  role: "문의 분류",
  instructions: "들어온 문의를 분류한다.",
  language: "ko" as const,
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  rules: [],
};

const GITHUB: AgentGitHub = {
  repositories: ["sample-app"],
  push_approval: true,
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [{ workflow: "ci.yml", ref: "release/*" }],
};

// Design github-agent.md §6 and decision 10: the agent's GitHub tab reads
// its switch, settings and activity; activity is found by target and keeps
// sessions the caller cannot see out before the latest 20 are cut.
integration("agent GitHub tab over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_github_api" });
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
    const agentStore = createPostgresAgentStore(db);
    const githubSettings = createPostgresGitHubSettingsStore(db);
    const agents = createAgentService({
      authorization,
      store: agentStore,
      catalog,
      credentials,
      githubSettings,
      runtimes: TEST_RUNTIMES,
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
        registerAgentRoutes(router, agents);
        registerApiKeyRoutes(router, keys);
        registerGitHubSettingsRoutes(
          router,
          createGitHubSettingsService({
            authorization,
            store: githubSettings,
            pullRequestSettings: createPostgresPullRequestSettingsStore(db),
            oauth: createPostgresGitHubOAuthStore(db, null),
            callbackUrl: null,
            secretsOn: false,
            apps: null,
            directory: createGitHubAppDirectory(),
          }),
        );
        registerAgentGitHubRoutes(
          router,
          createAgentGitHubService({
            authorization,
            agents: agentStore,
            store: createPostgresAgentGitHubStore(db),
            catalog,
            githubSettings,
          }),
        );
        registerAgentPullRequestRoutes(
          router,
          createAgentPullRequestService({
            authorization,
            agents: agentStore,
            settings: createPostgresPullRequestSettingsStore(db),
          }),
        );
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
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });

  let workspaceId = "";
  let ownerId = "";
  let adminId = "";
  let teamId = "";
  const cookies = { owner: "", admin: "", other: "" };
  const ceilingOfWorkspace = async () =>
    (
      await pool.query<{ repository_ceiling: unknown; revision: number }>(
        "SELECT repository_ceiling, revision FROM github_workspace_settings WHERE workspace_id = $1",
        [workspaceId],
      )
    ).rows[0];
  let agentId = "";
  let versionId = "";
  let firstRelease = "";
  let githubRelease = "";

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

  async function release(body: object) {
    const response = await send(
      "POST",
      `/v1/agents/${agentId}/releases`,
      asCookie(cookies.admin),
      {
        connection_id: TEST_CONNECTION_ID,
        repository_id: "sample-app",
        ...body,
      },
    );
    expect(response.status).toBe(200);
    return createAgentReleaseResponseSchema.parse(await response.json());
  }

  async function activate(releaseId: string) {
    const detail = (await (
      await send("GET", `/v1/agents/${agentId}`, asCookie(cookies.admin))
    ).json()) as { agent: { activation_revision: number } };
    const response = await send(
      "POST",
      `/v1/agents/${agentId}/activate`,
      asCookie(cookies.admin),
      {
        release_id: releaseId,
        expected_revision: detail.agent.activation_revision,
      },
    );
    expect(response.status).toBe(200);
  }

  /** A session of `releaseId`; `privateTo` keeps it to its creator. */
  async function session(releaseId: string, createdBy: string, priv = false) {
    const sessionId = crypto.randomUUID();
    const pin = sessionPinValues();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id, model,
         runtime_spec, spec_source, spec_source_digest, spec_digest)
       VALUES ($1, $2, 'https://github.com/acme/sample-app', 'main',
         'sample-app', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        sessionId,
        workspaceId,
        workspaceId,
        releaseId,
        createdBy,
        pin.model,
        pin.runtime_spec,
        pin.spec_source,
        pin.spec_source_digest,
        pin.spec_digest,
      ],
    );
    if (priv) {
      await pool.query(
        `INSERT INTO session_shares (session_id, owner_id, workspace_id, scope, updated_by)
         VALUES ($1, $2, $3, 'private', $4)`,
        [sessionId, workspaceId, workspaceId, createdBy],
      );
    }
    return sessionId;
  }

  /** What the gate writes for a token, at `at` seconds from now. */
  async function minted(sessionId: string, at: number) {
    const id = await createPostgresGitHubGateStore(db).recordReceipt({
      ownerId: workspaceId,
      sessionId,
      actor: null,
      operation: "mint_github_token",
      status: "succeeded",
      result: { session_id: sessionId, purpose: "clone" },
      error: null,
    });
    await pool.query(
      "UPDATE receipts SET created_at = now() + make_interval(secs => $2) WHERE id = $1",
      [id, at],
    );
    return id;
  }

  const activity = async (cookie: string) => {
    const response = await send(
      "GET",
      `/v1/agents/${agentId}/github/activity`,
      asCookie(cookie),
    );
    expect(response.status).toBe(200);
    return agentGitHubActivityResponseSchema.parse(await response.json()).items;
  };

  test("setup: an owner turns Actions on under the ceiling; a member makes and releases an agent", async () => {
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
    const booted = bootstrapResponseSchema.parse(await boot.json());
    workspaceId = booted.workspace.id;
    ownerId = booted.user_id;
    cookies.owner = await login("owner@example.com");
    adminId = await addMember("agent-admin@example.com");
    await addMember("other@example.com");
    cookies.admin = await login("agent-admin@example.com");
    cookies.other = await login("other@example.com");
    // The admin's own team, so the agents they make can name it. This app
    // has no team routes.
    teamId = crypto.randomUUID();
    await db
      .insert(schema.memberTeams)
      .values({ id: teamId, workspaceId, name: "triage" });
    await db.insert(schema.memberTeamMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      teamId,
      userId: adminId,
    });

    const ceiling = await send(
      "PUT",
      `/v1/workspaces/${workspaceId}/github-settings`,
      asCookie(cookies.owner),
      {
        ceiling: { ...GITHUB.features },
        // Bootstrap already wrote the repository ceiling, which counts.
        revision: (await ceilingOfWorkspace())?.revision ?? 0,
      },
    );
    expect(ceiling.status).toBe(200);
    expect(
      githubSettingsResponseSchema.parse(await ceiling.json()).ceiling.actions,
    ).toBe(true);
    // Bootstrap wrote the default ceiling when it created the workspace.
    expect((await ceilingOfWorkspace())?.repository_ceiling).toEqual({
      repository_ids: [],
      github_app_repositories: "installed",
    });

    const created = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "triage",
      name: "triage",
      managing_team_id: teamId,
      card,
    });
    expect(created.status).toBe(201);
    const detail = (await created.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    agentId = detail.agent.id;
    versionId = detail.versions[0]?.id ?? "";
    firstRelease = (await release({ version_id: versionId })).release.id;
    await activate(firstRelease);
  });

  test("GET github: a release without settings reads legacy defaults and the options", async () => {
    const response = await send(
      "GET",
      `/v1/agents/${agentId}/github`,
      asCookie(cookies.admin),
    );
    expect(response.status).toBe(200);
    const body = agentGitHubResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      enabled: true,
      active_release_id: firstRelease,
      github: null,
      settings_revision: null,
      start_repository_id: null,
      legacy_defaults: {
        repositories: [],
        push_approval: false,
        actions_allow: [],
      },
    });
    expect(body.options.repositories).toEqual([
      {
        id: "sample-app",
        url: "https://github.com/acme/sample-app",
        repository: "acme/sample-app",
        full_name: "acme/sample-app",
        private: null,
        ref: repositoryRefOf("sample-app"),
        available: true,
        reason: null,
        installed: { author: null, reviewer: null },
      },
    ]);
    expect(body.selected_repositories).toEqual([]);
    expect(body.options.features.actions).toEqual({
      available: true,
      reason: null,
    });
    expect(body.options.features.checks).toEqual({
      available: false,
      reason: "over_workspace_ceiling",
    });
  });

  test("a member who does not manage the agent reads none of it", async () => {
    for (const path of ["github", "github/activity"]) {
      const response = await send(
        "GET",
        `/v1/agents/${agentId}/${path}`,
        asCookie(cookies.other),
      );
      expect(response.status).toBe(403);
    }
  });

  test("before any save, a release may still pin settings (the legacy path); it and its activation are listed, a card-only release is not", async () => {
    const saved = await release({ version_id: versionId, github: GITHUB });
    expect(saved.created).toBe(true);
    expect(saved.release.version_id).toBe(versionId);
    expect(saved.release.policy_pins.github).toEqual(GITHUB);
    githubRelease = saved.release.id;
    await activate(githubRelease);

    const read = agentGitHubResponseSchema.parse(
      await (
        await send(
          "GET",
          `/v1/agents/${agentId}/github`,
          asCookie(cookies.admin),
        )
      ).json(),
    );
    expect(read.github).toEqual(GITHUB);
    expect(read.legacy_defaults).toBeNull();

    // A card edit's release keeps the settings: nothing GitHub moved.
    const edited = await send(
      "PATCH",
      `/v1/agents/${agentId}`,
      asCookie(cookies.admin),
      { card: { ...card, role: "문의 분류와 담당 제안" } },
    );
    expect(edited.status).toBe(200);
    const versions = (
      (await edited.json()) as {
        versions: { id: string; version_no: number }[];
      }
    ).versions;
    const newest = versions.reduce((a, b) =>
      a.version_no > b.version_no ? a : b,
    );
    const cardOnly = await release({ version_id: newest.id });
    expect(cardOnly.release.policy_pins.github).toEqual(GITHUB);
    await activate(cardOnly.release.id);

    const items = await activity(cookies.admin);
    expect(
      items.map((item) => [
        item.operation,
        (item.result as { release_id?: string }).release_id,
      ]),
    ).toEqual([
      ["activate_agent", githubRelease],
      ["create_agent_release", githubRelease],
    ]);
    expect(items[0]?.actor?.actor_user_id).toBe(adminId);
    expect(items[0]?.result).toMatchObject({
      github: GITHUB,
      github_changed: true,
      previous_release_id: firstRelease,
    });
  });

  test("PUT settings: a first save by a person, a compare-and-swap after it, and never a release", async () => {
    const releasesOf = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            "SELECT count(*) AS n FROM agent_releases WHERE agent_id = $1",
            [agentId],
          )
        ).rows[0]?.n,
      );
    const revisionBefore = (
      (await (
        await send("GET", `/v1/agents/${agentId}`, asCookie(cookies.admin))
      ).json()) as { agent: { activation_revision: number } }
    ).agent.activation_revision;
    const releasesBefore = await releasesOf();
    const put = (cookie: string, body: object) =>
      send(
        "PUT",
        `/v1/agents/${agentId}/github/settings`,
        asCookie(cookie),
        body,
      );
    const settings = { ...GITHUB, push_approval: false };
    const row = async () =>
      (
        await pool.query<{ revision: number; updated_by: string | null }>(
          "SELECT revision, updated_by FROM agent_github_settings WHERE agent_id = $1",
          [agentId],
        )
      ).rows[0];

    // No row yet: expecting a revision is a conflict.
    const early = await put(cookies.admin, {
      expected_revision: 3,
      settings,
      start_repository_id: null,
    });
    expect(early.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await early.json()).error.code).toBe(
      "REVISION_CONFLICT",
    );
    expect(await row()).toBeUndefined();

    // A workspace made before ceilings were written has none. Reading shows
    // the default without writing it; the first save writes it.
    await pool.query(
      "UPDATE github_workspace_settings SET repository_ceiling = NULL WHERE workspace_id = $1",
      [workspaceId],
    );
    const unsetRead = agentGitHubResponseSchema.parse(
      await (
        await send(
          "GET",
          `/v1/agents/${agentId}/github`,
          asCookie(cookies.admin),
        )
      ).json(),
    );
    expect(unsetRead.options.repository_ceiling_unset).toBe(true);
    expect(unsetRead.options.repositories[0]?.available).toBe(true);
    expect((await ceilingOfWorkspace())?.repository_ceiling).toBeNull();

    const first = await put(cookies.admin, {
      expected_revision: null,
      settings,
      start_repository_id: "sample-app",
    });
    expect(first.status).toBe(200);
    const saved = putAgentGitHubSettingsResponseSchema.parse(
      await first.json(),
    );
    expect(saved).toMatchObject({ settings_revision: 1 });
    expect(saved.receipt_id).not.toBeNull();
    // The person who saved is on the row, which is what narrows old sessions.
    expect(await row()).toEqual({ revision: 1, updated_by: adminId });
    const written = await ceilingOfWorkspace();
    expect(written?.repository_ceiling).toEqual({
      repository_ids: [],
      github_app_repositories: "installed",
    });

    const read = agentGitHubResponseSchema.parse(
      await (
        await send(
          "GET",
          `/v1/agents/${agentId}/github`,
          asCookie(cookies.admin),
        )
      ).json(),
    );
    expect(read).toMatchObject({
      github: settings,
      settings_revision: 1,
      start_repository_id: "sample-app",
    });

    // The same values by the same person change nothing.
    const same = await put(cookies.admin, {
      expected_revision: 1,
      settings,
      start_repository_id: "sample-app",
    });
    expect(
      putAgentGitHubSettingsResponseSchema.parse(await same.json()),
    ).toEqual({ settings_revision: 1, receipt_id: null });
    // A later save leaves the ceiling as the first one wrote it.
    expect(await ceilingOfWorkspace()).toEqual(written);

    // Two saves from the same read: one wins, the other is told to read again.
    const next = { ...settings, push_approval: true };
    const raced = await Promise.all([
      put(cookies.admin, {
        expected_revision: 1,
        settings: next,
        start_repository_id: null,
      }),
      put(cookies.admin, {
        expected_revision: 1,
        settings: { ...settings, actions_allow: [] },
        start_repository_id: null,
      }),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await row())?.revision).toBe(2);

    // A save is not a release: none is made and nothing is activated.
    expect(await releasesOf()).toBe(releasesBefore);
    const detail = (await (
      await send("GET", `/v1/agents/${agentId}`, asCookie(cookies.admin))
    ).json()) as { agent: { activation_revision: number } };
    expect(detail.agent.activation_revision).toBe(revisionBefore);

    // A release request carrying `github` is refused from now on.
    const refused = await send(
      "POST",
      `/v1/agents/${agentId}/releases`,
      asCookie(cookies.admin),
      {
        version_id: versionId,
        connection_id: TEST_CONNECTION_ID,
        repository_id: "sample-app",
        github: GITHUB,
      },
    );
    expect(refused.status).toBe(409);
    expect(
      apiErrorResponseSchema.parse(await refused.json()).error,
    ).toMatchObject({
      code: "ALREADY_EXISTS",
      details: { reason_code: "github_settings_exist" },
    });
    expect(await releasesOf()).toBe(releasesBefore);

    // Who manages the agent saves; another member does not.
    const other = await put(cookies.other, {
      expected_revision: 2,
      settings,
      start_repository_id: null,
    });
    expect(other.status).toBe(403);

    const items = await activity(cookies.admin);
    const receipt = items.find((item) => item.id === saved.receipt_id);
    expect(receipt).toMatchObject({
      operation: "set_agent_github",
      result: {
        change: "settings",
        agent_settings_revision: 1,
        before: null,
        after: { push_approval: false, start_repository_id: "sample-app" },
      },
    });
    expect(receipt?.actor?.actor_user_id).toBe(adminId);
  });

  test("the switch applies at once, is listed, and is a console act", async () => {
    const off = await send(
      "PUT",
      `/v1/agents/${agentId}/github/enabled`,
      asCookie(cookies.admin),
      { enabled: false },
    );
    expect(off.status).toBe(200);
    const saved = putAgentGitHubEnabledResponseSchema.parse(await off.json());
    expect(saved.enabled).toBe(false);
    expect(saved.receipt_id).not.toBeNull();

    // The same value again writes nothing.
    const again = await send(
      "PUT",
      `/v1/agents/${agentId}/github/enabled`,
      asCookie(cookies.admin),
      { enabled: false },
    );
    expect(
      putAgentGitHubEnabledResponseSchema.parse(await again.json()).receipt_id,
    ).toBeNull();

    const read = agentGitHubResponseSchema.parse(
      await (
        await send(
          "GET",
          `/v1/agents/${agentId}/github`,
          asCookie(cookies.admin),
        )
      ).json(),
    );
    expect(read.enabled).toBe(false);

    const [latest] = await activity(cookies.admin);
    expect(latest).toMatchObject({
      id: saved.receipt_id,
      operation: "set_agent_github",
      status: "succeeded",
      result: { agent_id: agentId, enabled: false },
      target_ref: {
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      },
    });
    expect(latest?.actor?.actor_user_id).toBe(adminId);

    const key = await send("POST", "/v1/api-keys", asCookie(cookies.admin), {
      kind: "personal",
      scopes: ["sessions:read"],
    });
    expect(key.status).toBe(201);
    const secret = createApiKeyResponseSchema.parse(await key.json()).secret;
    const byKey = await send(
      "PUT",
      `/v1/agents/${agentId}/github/enabled`,
      { Authorization: `Bearer ${secret}` },
      { enabled: true },
    );
    expect(byKey.status).toBe(403);
    const refused = apiErrorResponseSchema.parse(await byKey.json()).error;
    expect(refused.code).toBe("FORBIDDEN");
  });

  test("a private session nobody shared is kept from the agent's admin, and the 20 fill from what they can see", async () => {
    const visible = await session(githubRelease, adminId);
    const hidden = await session(githubRelease, ownerId, true);
    const seen: string[] = [];
    // The visible ones are older; the private ones crowd the latest.
    for (let i = 0; i < AGENT_GITHUB_ACTIVITY_LIMIT + 5; i += 1) {
      seen.push(await minted(visible, 100 + i));
    }
    const kept: string[] = [];
    for (let i = 0; i < AGENT_GITHUB_ACTIVITY_LIMIT + 5; i += 1) {
      kept.push(await minted(hidden, 1000 + i));
    }

    const admin = await activity(cookies.admin);
    expect(admin).toHaveLength(AGENT_GITHUB_ACTIVITY_LIMIT);
    expect(admin.every((item) => seen.includes(item.id))).toBe(true);
    expect(admin.map((item) => item.id)).toEqual(
      seen.slice(-AGENT_GITHUB_ACTIVITY_LIMIT).reverse(),
    );
    for (const item of admin) {
      expect(item.target_ref).toMatchObject({ session_id: visible });
    }

    // The session's creator sees their own private one.
    const owner = await activity(cookies.owner);
    expect(owner.map((item) => item.id)).toEqual(
      kept.slice(-AGENT_GITHUB_ACTIVITY_LIMIT).reverse(),
    );
  });

  test("another agent's sessions are not listed", async () => {
    const other = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "other",
      name: "other",
      managing_team_id: teamId,
      card,
    });
    const otherDetail = (await other.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    const otherRelease = await send(
      "POST",
      `/v1/agents/${otherDetail.agent.id}/releases`,
      asCookie(cookies.admin),
      {
        version_id: otherDetail.versions[0]?.id,
        connection_id: TEST_CONNECTION_ID,
        repository_id: "sample-app",
      },
    );
    const otherReleaseId = createAgentReleaseResponseSchema.parse(
      await otherRelease.json(),
    ).release.id;
    const foreign = await minted(await session(otherReleaseId, adminId), 5000);
    const items = await activity(cookies.admin);
    expect(items.map((item) => item.id)).not.toContain(foreign);
  });

  // agent-wizard-rework.md item 1: the new-agent flow releases without a
  // repository, and such an agent sets GitHub up from the tab first.
  test("a release without a repository on an optional profile saves its first settings", async () => {
    const created = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "no-repo",
      name: "no-repo",
      managing_team_id: teamId,
      card,
    });
    expect(created.status).toBe(201);
    const made = (await created.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    const id = made.agent.id;
    const releaseOf = async (body: object) => {
      const response = await send(
        "POST",
        `/v1/agents/${id}/releases`,
        asCookie(cookies.admin),
        {
          version_id: made.versions[0]?.id,
          connection_id: TEST_CONNECTION_ID,
          ...body,
        },
      );
      expect(response.status).toBe(200);
      return createAgentReleaseResponseSchema.parse(await response.json())
        .release;
    };
    const activateOf = async (releaseId: string) => {
      const detail = (await (
        await send("GET", `/v1/agents/${id}`, asCookie(cookies.admin))
      ).json()) as { agent: { activation_revision: number } };
      const response = await send(
        "POST",
        `/v1/agents/${id}/activate`,
        asCookie(cookies.admin),
        {
          release_id: releaseId,
          expected_revision: detail.agent.activation_revision,
        },
      );
      expect(response.status).toBe(200);
    };
    const read = async () => {
      const response = await send(
        "GET",
        `/v1/agents/${id}/github`,
        asCookie(cookies.admin),
      );
      expect(response.status).toBe(200);
      return agentGitHubResponseSchema.parse(await response.json());
    };

    const first = await releaseOf({});
    expect(first.repository_id).toBeNull();
    await activateOf(first.id);
    const before = await read();
    expect(before).toMatchObject({
      active_release_id: first.id,
      github: null,
      settings_revision: null,
      legacy_defaults: { repositories: [], push_approval: false },
    });
    expect(
      before.options.repositories.find((r) => r.id === "sample-app"),
    ).toMatchObject({ available: true, reason: null });

    const saved = await releaseOf({ github: GITHUB });
    expect(saved.repository_id).toBeNull();
    expect(saved.policy_pins.github).toEqual(GITHUB);
    await activateOf(saved.id);
    const after = await read();
    expect(after.github).toEqual(GITHUB);
  });

  test("two first saves of an agent's pull request settings race to one winner, and a GitHub settings save beside one neither blocks nor conflicts with it", async () => {
    const created = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "pr-race",
      name: "pr-race",
      managing_team_id: teamId,
      card,
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { agent: { id: string } }).agent.id;
    const layout = (formatting: "on" | "off") => ({
      pull_request: { formatting, template: null, template_name: null },
      revision: 0,
    });
    const put = (body: unknown) =>
      send(
        "PUT",
        `/v1/agents/${id}/github/pull-request`,
        asCookie(cookies.admin),
        body,
      );
    const raced = await Promise.all([put(layout("on")), put(layout("off"))]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);

    // Next to the GitHub settings save: separate rows and revisions, both win.
    const beside = await Promise.all([
      send("PUT", `/v1/agents/${id}/github/settings`, asCookie(cookies.admin), {
        expected_revision: null,
        settings: GITHUB,
        start_repository_id: "sample-app",
      }),
      put({
        pull_request: {
          formatting: "inherit",
          template: "## A\n",
          template_name: null,
        },
        revision: 1,
      }),
    ]);
    expect(beside.map((r) => r.status)).toEqual([200, 200]);
  });

  // Pull request layout of the agent (its own table: saving it must not
  // give the agent a GitHub settings row, which would move its sessions off
  // their release).
  test("an agent's pull request settings are saved with a receipt, found through a session, and leave the GitHub policy alone", async () => {
    // An agent of its own: the shared one already has a GitHub settings row.
    const created = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "pr-layout",
      name: "pr-layout",
      managing_team_id: teamId,
      card,
    });
    expect(created.status).toBe(201);
    const made = (await created.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    const id = made.agent.id;
    const released = await send(
      "POST",
      `/v1/agents/${id}/releases`,
      asCookie(cookies.admin),
      {
        version_id: made.versions[0]?.id,
        connection_id: TEST_CONNECTION_ID,
      },
    );
    expect(released.status).toBe(200);
    const releaseId = createAgentReleaseResponseSchema.parse(
      await released.json(),
    ).release.id;
    const path = `/v1/agents/${id}/github/pull-request`;
    const store = createPostgresPullRequestSettingsStore(db);
    const settings = {
      formatting: "off",
      template: "## Summary\n<!-- ours -->\n",
      template_name: "feature.md",
    } as const;
    const read = async () =>
      (await send("GET", path, asCookie(cookies.admin))).json();
    expect(await read()).toEqual({
      pull_request: {
        formatting: "inherit",
        template: null,
        template_name: null,
      },
      pull_request_revision: 0,
    });
    const sessionId = await session(releaseId, adminId);
    expect(await store.agentOfSession(workspaceId, sessionId)).toBeNull();

    const put = (revision: number, body = settings) =>
      send("PUT", path, asCookie(cookies.admin), {
        pull_request: body,
        revision,
      });
    const saved = await put(0);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      pull_request: settings,
      pull_request_revision: 1,
      receipt_id: expect.any(String),
    });
    expect((await put(0)).status).toBe(409);
    expect(
      ((await (await put(1)).json()) as { receipt_id: unknown }).receipt_id,
    ).toBeNull();
    expect(await store.agentOfSession(workspaceId, sessionId)).toEqual(
      settings,
    );
    // Not the agent's GitHub settings row.
    const github = await send(
      "GET",
      `/v1/agents/${id}/github`,
      asCookie(cookies.admin),
    );
    expect(
      agentGitHubResponseSchema.parse(await github.json()).settings_revision,
    ).toBeNull();
    // What a session started now reads: no GitHub row, so the release's pin
    // is the policy source and the gate sees no agent row at all.
    const row = await createPostgresAgentGitHubStore(db).settings(id);
    expect(row).toBeNull();
    expect(newSessionGitHubPolicy(row, null).source).toBe("release");
    const { rows: held } = await pool.query(
      "SELECT count(*)::int AS n FROM agent_github_settings WHERE agent_id = $1",
      [id],
    );
    expect(held[0].n).toBe(0);
    // A member who does not manage the agent may neither read nor save.
    expect((await send("GET", path, asCookie(cookies.other))).status).toBe(403);
    // The receipt keeps a template's size and hash, never its text.
    const { rows } = await pool.query(
      "SELECT result FROM receipts WHERE operation = 'set_agent_pull_request_settings' AND owner_id = $1 AND target_ref->'resource'->>'id' = $2",
      [workspaceId, id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].result.after.template).toEqual({
      bytes: new TextEncoder().encode(settings.template).length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(rows[0].result)).not.toContain("ours");
  });
});
