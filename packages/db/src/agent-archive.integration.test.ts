import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  agentCardRequestSchema,
  SLACK_APP_SECRET_PURPOSE_VALUES,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  type AgentService,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  SecretKey,
  type SessionCatalog,
  SessionServiceError,
  secretOwnerRef,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { agentDeleted, createPostgresAgentStore } from "./agents.ts";
import { createPostgresAgentAdminStore } from "./musterrolle/agent-admins.ts";
import { createPostgresWorkspaceKeyStore } from "./musterrolle/api-keys.ts";
import { createPostgresCredentialBindingStore } from "./musterrolle/credential-bindings.ts";
import { createDatabaseIdentityReader } from "./musterrolle/identity-reader.ts";
import { createPostgresSessionReader } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentIdentities,
  agents,
  apiKeys,
  memberships,
  memberTeams,
  receipts,
  secretValues,
  sessions,
  slackApps,
  slackInstallations,
  surfaceBindings,
  users,
  workspaces,
} from "./schema.ts";
import { writeSecretInTx } from "./secrets/secret-values.ts";
import { createPostgresSlackAppStore } from "./surface/slack-apps.ts";
import {
  sessionPinColumns,
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testSessionCatalog,
  testToolCatalogs,
} from "./testing/spec-pins.ts";
import { createPostgresUsageReader } from "./usage/usage-reader.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  return "ok";
}

integration("deleting an agent on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_archive_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  function service(): AgentService {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog: {
        ...testSessionCatalog(),
        tool_catalogs: testToolCatalogs(["Read"]),
      } as SessionCatalog,
      credentials: createPostgresCredentialBindingStore(db),
      runtimes: TEST_RUNTIMES,
    });
  }

  async function setup() {
    const workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "ws",
    });
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "owner",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    const owner = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      randomUUID(),
    );
    const teamId = randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: `team-${teamId.slice(0, 8)}` });
    return { workspaceId, userId, owner, teamId };
  }

  test("keeps the row, revokes what it ran under in the same call, frees the slug and leaves its sessions readable", async () => {
    const { workspaceId, userId, owner, teamId } = await setup();
    const agentsService = service();
    const card = agentCardRequestSchema.parse({
      role: "재무 분석가",
      instructions: "v1",
      model: "claude-sonnet-5",
      capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
    });
    const create = () =>
      agentsService.createAgent(owner, {
        slug: "finance",
        name: "재무 분석가",
        managing_team_id: teamId,
        card,
      });
    const created = await create();
    const agentId = created.agent.id;
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version 1");
    const { release } = await agentsService.createRelease(owner, agentId, {
      version_id: v1.id,
      connection_id: TEST_CONNECTION_ID,
    });

    const installationId = randomUUID();
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId,
      appId: `A${installationId.slice(0, 8).toUpperCase()}`,
      teamId: "T1",
    });
    const identityId = randomUUID();
    await db.insert(agentIdentities).values({
      id: identityId,
      workspaceId,
      agentId,
      provider: "slack_bot",
      installationId,
      externalPrincipalId: "U1",
      credentialRef: `slack_app:${installationId}/slack_bot_token`,
    });
    const bindingId = randomUUID();
    await db.insert(surfaceBindings).values({
      id: bindingId,
      workspaceId,
      agentId,
      surface: "slack",
      installationId,
      externalSurfaceId: "C1",
      surfaceKind: "public_channel",
      mode: "on",
      ceilingActions: [],
      ceilingDisclosure: "summary",
      home: true,
    });
    const keyId = randomUUID();
    await db.insert(apiKeys).values({
      id: keyId,
      keyHash: Buffer.from(randomUUID()),
      ownerId: workspaceId,
      workspaceId,
      kind: "agent",
      agentId,
      scopes: ["sessions:read"],
    });
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      ...sessionPinColumns(),
      agentReleaseId: release.id,
      createdByUserId: userId,
    });

    const appId = randomUUID();
    await db.insert(slackApps).values({
      id: appId,
      workspaceId,
      kind: "agent",
      agentId,
      state: "created",
      appId: `A${appId.slice(0, 8).toUpperCase()}`,
      clientId: `1.${appId.slice(0, 8)}`,
      redirectUrl: "https://example.invalid/slack/callback",
      signingSecretRef: `slack_app:${appId}/slack_signing_secret`,
      clientSecretRef: `slack_app:${appId}/slack_client_secret`,
      botTokenRef: `slack_app:${appId}/slack_bot_token`,
    });
    const secretKey = SecretKey.fromHex(
      randomBytes(32).toString("hex"),
      "TEST_KEY",
    );
    await db.transaction(async (tx) => {
      for (const purpose of SLACK_APP_SECRET_PURPOSE_VALUES) {
        await writeSecretInTx(
          tx,
          secretKey,
          { workspaceId, owner: { kind: "slack_app", id: appId }, purpose },
          "placeholder-not-a-secret",
        );
      }
    });
    const appSecrets = () =>
      db
        .select({ purpose: secretValues.purpose })
        .from(secretValues)
        .where(
          eq(
            secretValues.ownerRef,
            secretOwnerRef({ kind: "slack_app", id: appId }),
          ),
        );
    expect(await appSecrets()).toHaveLength(
      SLACK_APP_SECRET_PURPOSE_VALUES.length,
    );
    const admins = createPostgresAgentAdminStore(db);
    const administered = async () =>
      (await admins.listAdministered(workspaceId, userId, 50)).map(
        (agent) => agent.id,
      );
    expect(await administered()).toEqual([agentId]);

    const { receipt_id } = await agentsService.deleteAgent(owner, agentId);

    expect(await appSecrets()).toEqual([]);
    const [app] = await db
      .select({
        state: slackApps.state,
        signing: slackApps.signingSecretRef,
        client: slackApps.clientSecretRef,
        bot: slackApps.botTokenRef,
      })
      .from(slackApps)
      .where(eq(slackApps.id, appId));
    expect(app).toEqual({
      state: "created",
      signing: null,
      client: null,
      bot: null,
    });
    expect(await administered()).toEqual([]);
    expect(
      await createPostgresUsageReader(db).agentExists(workspaceId, agentId),
    ).toBe(false);
    const issued = await createPostgresWorkspaceKeyStore(db).issue({
      principal: owner,
      id: randomUUID(),
      workspaceId,
      keyHash: new Uint8Array(randomBytes(32)),
      kind: "agent",
      name: null,
      agentId,
      createdByUserId: userId,
      scopes: ["sessions:read"],
      expiresAt: null,
      receiptId: randomUUID(),
      issuerRoles: ["owner", "admin"],
    });
    expect(issued.outcome).toBe("agent_not_found");
    const adminChange = await admins.add({
      actor: { principal: owner, workspaceId, userId },
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: userId },
      managerRoles: ["owner", "admin"],
    });
    expect(adminChange.outcome).toBe("not_found");

    const [row] = await db
      .select({
        status: agents.status,
        deletedAt: agents.deletedAt,
        deletedBy: agents.deletedBy,
      })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.status).toBe("archived");
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.deletedBy).toBe(userId);
    expect(await agentDeleted(db, workspaceId, agentId)).toBe(true);

    expect(
      (await agentsService.listAgents(owner, { limit: 50 })).items,
    ).toEqual([]);
    expect((await agentsService.countAgents(owner)).counts.all).toBe(0);
    expect(await createPostgresAgentStore(db).get(workspaceId, agentId)).toBe(
      null,
    );
    expect(await codeOf(agentsService.getAgent(owner, agentId))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(agentsService.deleteAgent(owner, agentId))).toBe(
      "NOT_FOUND",
    );

    const [identity] = await db
      .select({ status: agentIdentities.status })
      .from(agentIdentities)
      .where(eq(agentIdentities.id, identityId));
    expect(identity?.status).toBe("revoked");
    const [binding] = await db
      .select({
        status: surfaceBindings.status,
        revokedAt: surfaceBindings.revokedAt,
      })
      .from(surfaceBindings)
      .where(eq(surfaceBindings.id, bindingId));
    expect(binding?.status).toBe("revoked");
    expect(binding?.revokedAt).toBeInstanceOf(Date);
    const [key] = await db
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId));
    expect(key?.revokedAt).toBeInstanceOf(Date);
    const [receipt] = await db
      .select({ operation: receipts.operation, result: receipts.result })
      .from(receipts)
      .where(eq(receipts.id, receipt_id));
    expect(receipt).toEqual({
      operation: "delete_agent",
      result: {
        agent_identity_ids: [identityId],
        surface_binding_ids: [bindingId],
        api_key_ids: [keyId],
      },
    });

    const session = await createPostgresSessionReader(db).getSession(
      workspaceId,
      sessionId,
    );
    expect(session?.id).toBe(sessionId);

    const again = await create();
    expect(again.agent.id).not.toBe(agentId);
    expect(again.agent.slug).toBe("finance");
    // Two live agents still cannot share it.
    expect(await codeOf(create())).not.toBe("ok");
  });

  test("a deleted mark needs its author and the archived status", async () => {
    const { workspaceId, userId, owner, teamId } = await setup();
    const created = await service().createAgent(owner, {
      slug: "check",
      name: "check",
      managing_team_id: teamId,
      card: agentCardRequestSchema.parse({
        role: "r",
        instructions: "v1",
        model: "claude-sonnet-5",
        capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
      }),
    });
    const mark = (set: string) =>
      pool
        .query(`UPDATE agents SET ${set} WHERE id = $1 AND workspace_id = $2`, [
          created.agent.id,
          workspaceId,
        ])
        .then(
          () => "accepted",
          (error: Error) => error.message,
        );
    expect(await mark("deleted_at = now()")).toContain("agents_deleted_check");
    expect(
      await mark(`deleted_at = now(), deleted_by = '${userId}'`),
    ).toContain("agents_deleted_check");
    expect(
      await mark(
        `status = 'archived', deleted_at = now(), deleted_by = '${userId}'`,
      ),
    ).toBe("accepted");
    expect(
      (
        await db.execute(
          sql`SELECT count(*)::int AS n FROM agents WHERE id = ${created.agent.id}`,
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  async function newAgent(
    owner: Awaited<ReturnType<typeof setup>>["owner"],
    teamId: string,
    slug: string,
  ): Promise<string> {
    const created = await service().createAgent(owner, {
      slug,
      name: slug,
      managing_team_id: teamId,
      card: agentCardRequestSchema.parse({
        role: "r",
        instructions: "v1",
        model: "claude-sonnet-5",
        capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
      }),
    });
    return created.agent.id;
  }

  async function waitUntil(what: string, query: string, params: unknown[]) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await pool.query(query, params)).rowCount) return;
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting until ${what}`);
  }

  test("a Slack answer that lands after the archive stores no secret", async () => {
    const { workspaceId, owner, teamId } = await setup();
    const secretKey = SecretKey.fromHex(
      randomBytes(32).toString("hex"),
      "TEST_KEY",
    );
    const store = createPostgresSlackAppStore(db, secretKey);
    const creatingAgent = await newAgent(owner, teamId, "creating");
    const creatingApp = randomUUID();
    await db.insert(slackApps).values({
      id: creatingApp,
      workspaceId,
      kind: "agent",
      agentId: creatingAgent,
      state: "creating",
      redirectUrl: "https://example.invalid/slack/callback",
    });
    const createdAgent = await newAgent(owner, teamId, "created");
    const createdApp = randomUUID();
    await db.insert(slackApps).values({
      id: createdApp,
      workspaceId,
      kind: "agent",
      agentId: createdAgent,
      state: "created",
      appId: `A${createdApp.slice(0, 8).toUpperCase()}`,
      clientId: `1.${createdApp.slice(0, 8)}`,
      redirectUrl: "https://example.invalid/slack/callback",
    });
    await service().deleteAgent(owner, creatingAgent);
    await service().deleteAgent(owner, createdAgent);

    expect(
      await store
        .finishCreate({
          workspaceId,
          slackAppId: creatingApp,
          created: {
            appId: "A0LATE",
            clientId: "1.late",
            clientSecret: "placeholder-not-a-secret",
            signingSecret: "placeholder-not-a-secret",
          },
          tokenUserId: "U1",
        })
        .then(
          () => "stored",
          () => "refused",
        ),
    ).toBe("refused");
    expect(
      await store.storeBotToken({
        workspaceId,
        slackAppId: createdApp,
        botToken: "placeholder-not-a-secret",
      }),
    ).toBe(null);
    const stored = await db
      .select({ ownerRef: secretValues.ownerRef })
      .from(secretValues)
      .where(
        inArray(secretValues.ownerRef, [
          secretOwnerRef({ kind: "slack_app", id: creatingApp }),
          secretOwnerRef({ kind: "slack_app", id: createdApp }),
        ]),
      );
    expect(stored).toEqual([]);
  });

  test("a key issued while the archive waits on the agent waits for the archive", async () => {
    const { workspaceId, userId, owner, teamId } = await setup();
    const agentId = await newAgent(owner, teamId, "issue");
    // A session start already holding the agent, as requester-locks.ts does.
    const start = await pool.connect();
    let archived: Promise<unknown> | undefined;
    let issued: Promise<{ outcome: string }> | undefined;
    try {
      await start.query("BEGIN");
      await start.query("SELECT 1 FROM agents WHERE id = $1 FOR SHARE", [
        agentId,
      ]);
      const [{ pid }] = (await start.query("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      archived = service().deleteAgent(owner, agentId);
      archived.catch(() => {});
      await waitUntil(
        "the archive waits on the session start",
        "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      issued = createPostgresWorkspaceKeyStore(db).issue({
        principal: owner,
        id: randomUUID(),
        workspaceId,
        keyHash: new Uint8Array(randomBytes(32)),
        kind: "agent",
        name: null,
        agentId,
        createdByUserId: userId,
        scopes: ["sessions:read"],
        expiresAt: null,
        receiptId: randomUUID(),
        issuerRoles: ["owner", "admin"],
      });
      issued.catch(() => {});
      await waitUntil(
        "the issue waits on the archive's issue lock",
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
        [],
      );
      await start.query("COMMIT");
      await archived;
      expect((await issued).outcome).toBe("agent_not_found");
    } finally {
      await start.query("ROLLBACK").catch(() => {});
      start.release();
      await archived?.catch(() => {});
      await issued?.catch(() => {});
    }
    const live = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.agentId, agentId), isNull(apiKeys.revokedAt)));
    expect(live).toEqual([]);
  }, 30_000);

  test("takes the agent's keys before the agent, as a session start does", async () => {
    const { workspaceId, owner, teamId } = await setup();
    const agentsService = service();
    const agentId = await newAgent(owner, teamId, "order");
    const keyId = randomUUID();
    await db.insert(apiKeys).values({
      id: keyId,
      keyHash: Buffer.from(randomUUID()),
      ownerId: workspaceId,
      workspaceId,
      kind: "agent",
      agentId,
      scopes: ["sessions:write"],
    });

    // A session start by that key: key, then agent (requester-locks.ts).
    const start = await pool.connect();
    let archived: Promise<unknown> | undefined;
    try {
      await start.query("BEGIN");
      await start.query("SELECT 1 FROM api_keys WHERE id = $1 FOR SHARE", [
        keyId,
      ]);
      const [{ pid }] = (await start.query("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      archived = agentsService.deleteAgent(owner, agentId);
      archived.catch(() => {});
      await waitUntil(
        "the archive waits on the session start's key",
        "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      await start.query("SET LOCAL lock_timeout = '5s'");
      await start.query("SELECT 1 FROM agents WHERE id = $1 FOR SHARE", [
        agentId,
      ]);
      await start.query("COMMIT");
      await archived;
    } finally {
      await start.query("ROLLBACK").catch(() => {});
      start.release();
      await archived?.catch(() => {});
    }
    expect(await agentDeleted(db, workspaceId, agentId)).toBe(true);
    const [key] = await db
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId));
    expect(key?.revokedAt).toBeInstanceOf(Date);
  }, 30_000);
});
