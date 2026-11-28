import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type Principal,
  SecretKey,
  type WorkspaceMcpOAuthPin,
  type WorkspaceMcpStore,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, like, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresMemberStore } from "../../access-control/members.ts";
import * as schema from "../../schema.ts";
import {
  memberships,
  receipts,
  retiredCatalogMcp,
  secretValues,
  users,
  workspaceMcpConnections,
  workspaceMcpServers,
  workspaces,
} from "../../schema.ts";
import { memberManageAllow } from "../../testing/member-manage-allow.ts";
import { createPostgresWorkspaceMcpStore } from "./workspace-mcp.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const FAKE_BEARER = "example-bearer-not-real";
const FAKE_ACCESS = "example-access-not-real";
const FAKE_REFRESH = "example-refresh-not-real";
const FAKE_CLIENT_VALUE = "example-client-value-not-real";
const FAKES = [FAKE_BEARER, FAKE_ACCESS, FAKE_REFRESH, FAKE_CLIENT_VALUE];

const PIN: WorkspaceMcpOAuthPin = {
  issuer: "https://auth.example.com",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  revocationEndpoint: "https://auth.example.com/revoke",
  registrationEndpoint: "https://auth.example.com/register",
  resource: "https://mcp.example.com/v1/mcp",
  scope: "read:issues",
  issParameterSupported: true,
  tokenEndpointAuthMethods: ["client_secret_basic"],
  client: null,
};

const HOUR = 60 * 60 * 1000;

integration("workspace MCP servers on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: WorkspaceMcpStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "workspace_mcp_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresWorkspaceMcpStore(
      db,
      SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY"),
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const id = randomUUID();
    await db.insert(workspaces).values({ id, slug: `ws-${id}`, name: "Acme" });
    return id;
  }

  async function member(
    workspaceId: string,
    role: "owner" | "admin" | "member",
    displayName: string = role,
  ) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return userId;
  }

  const asUser = (workspaceId: string, userId: string) => ({
    actorUserId: userId,
    principal: {
      ownerId: workspaceId,
      requestId: `req-${randomUUID()}`,
      actor: {
        principal: { kind: "user", id: userId },
        userId,
        workspaceId,
        apiKeyId: null,
      },
    } satisfies Principal,
  });

  async function team() {
    const ws = await workspace();
    return {
      ws,
      owner: await member(ws, "owner"),
      admin: await member(ws, "admin", "Admin Kim"),
      plain: await member(ws, "member"),
    };
  }

  function create(
    ws: string,
    actor: string,
    overrides: Partial<Parameters<WorkspaceMcpStore["create"]>[0]> = {},
  ) {
    return store.create({
      ...asUser(ws, actor),
      workspaceId: ws,
      id: randomUUID(),
      name: `tracker-${randomUUID().slice(0, 8)}`,
      url: "https://mcp.example.com/v1/mcp",
      authKind: "bearer",
      oauth: null,
      bearerToken: FAKE_BEARER,
      max: 20,
      ...overrides,
    });
  }

  async function created(...args: Parameters<typeof create>) {
    const result = await create(...args);
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.record;
  }

  const secretsOf = (ws: string) =>
    db
      .select()
      .from(secretValues)
      .where(
        and(
          eq(secretValues.workspaceId, ws),
          like(secretValues.purpose, "mcp_%"),
        ),
      );

  const purposesOf = async (ws: string) =>
    (await secretsOf(ws)).map((row) => row.purpose).sort();

  const receiptsOf = (ws: string) =>
    db.select().from(receipts).where(eq(receipts.ownerId, ws));

  /** Every row this workspace wrote, with no credential in plain text. */
  async function expectNoPlainCredential(ws: string) {
    const written = JSON.stringify({
      secrets: await secretsOf(ws),
      receipts: await receiptsOf(ws),
      connections: await db.select().from(workspaceMcpConnections),
    });
    for (const fake of FAKES) expect(written).not.toContain(fake);
  }

  async function startedFlow(
    ws: string,
    actor: string,
    serverId: string,
    expiresAt: Date,
  ) {
    const flowId = randomUUID();
    const current = (await store.get(ws, serverId))?.oauth?.client ?? null;
    const started = await store.beginFlow({
      ...asUser(ws, actor),
      workspaceId: ws,
      serverId,
      flowId,
      stateSha256: createHash("sha256").update(flowId).digest(),
      expiresAt,
      verifier: "example-verifier-not-real",
      expectedClientId: current?.clientId ?? null,
      registered:
        current !== null
          ? null
          : {
              client: {
                registration: "dcr",
                clientId: "client-1",
                authMethod: "client_secret_basic",
              },
              clientSecret: FAKE_CLIENT_VALUE,
            },
    });
    expect(started.outcome).toBe("started");
    return flowId;
  }

  async function connectedOAuth(ws: string, actor: string) {
    const server = await created(ws, actor, {
      authKind: "oauth",
      oauth: PIN,
      bearerToken: null,
    });
    const flowId = await startedFlow(
      ws,
      actor,
      server.id,
      new Date(Date.now() + HOUR),
    );
    const done = await store.completeFlow({
      ...asUser(ws, actor),
      workspaceId: ws,
      serverId: server.id,
      flowId,
      now: new Date(),
      tokens: {
        accessToken: FAKE_ACCESS,
        refreshToken: FAKE_REFRESH,
        expiresAt: new Date(Date.now() + HOUR),
        scope: "read:issues",
      },
    });
    if (done.outcome !== "connected") throw new Error(done.outcome);
    return done.record;
  }

  test("a static token connects as the admin who gave it, and only the cipher is stored", async () => {
    const { ws, admin } = await team();
    const record = await created(ws, admin);
    expect(record.connection).toMatchObject({
      state: "active",
      generation: 1,
      connectedBy: { userId: admin, displayName: "Admin Kim" },
    });
    expect(record.createdBy).toEqual({
      userId: admin,
      displayName: "Admin Kim",
    });
    expect(record.bearerLast4).toBe("real");
    expect(await store.credentialOf(ws, record.id)).toEqual({
      kind: "bearer",
      token: FAKE_BEARER,
    });
    expect((await receiptsOf(ws)).map((row) => row.operation)).toEqual([
      "create_workspace_mcp_server",
    ]);
    await expectNoPlainCredential(ws);
  });

  test("a server that takes no credential connects as no one and stores nothing", async () => {
    const { ws, admin } = await team();
    const record = await created(ws, admin, {
      authKind: "none",
      bearerToken: null,
    });
    expect(record.authKind).toBe("none");
    expect(record.connection).toMatchObject({
      state: "active",
      generation: 1,
      connectedBy: null,
    });
    expect(record.connection.connectedAt).not.toBeNull();
    expect(record.bearerLast4).toBeNull();
    expect(await purposesOf(ws)).toEqual([]);
    expect(await store.credentialOf(ws, record.id)).toEqual({ kind: "none" });
    const asked = {
      ...asUser(ws, admin),
      workspaceId: ws,
      serverId: record.id,
    };
    expect(
      (await store.setBearerToken({ ...asked, token: "x".repeat(16) })).outcome,
    ).toBe("no_credential");
    expect((await store.disconnect(asked)).outcome).toBe("no_credential");
    expect(
      (
        await store.setOAuthClient({
          ...asked,
          client: {
            registration: "manual",
            clientId: "c1",
            authMethod: "none",
          },
          clientSecret: null,
        })
      ).outcome,
    ).toBe("not_oauth");
    expect(await purposesOf(ws)).toEqual([]);
    expect((await store.get(ws, record.id))?.connection.state).toBe("active");
    expect((await store.delete(asked)).outcome).toBe("deleted");
    expect(await store.get(ws, record.id)).toBeNull();
  });

  test("a server of a kind this release does not know is not disconnected", async () => {
    const { ws, admin } = await team();
    const record = await created(ws, admin);
    // What a later release's migration could allow and write.
    await db.execute(
      sql`ALTER TABLE workspace_mcp_servers DROP CONSTRAINT workspace_mcp_servers_auth_kind_check, ADD CONSTRAINT workspace_mcp_servers_auth_kind_check CHECK (auth_kind IN ('oauth', 'bearer', 'none', 'mtls')) NOT VALID`,
    );
    await db
      .update(workspaceMcpServers)
      .set({ authKind: "mtls" as never })
      .where(eq(workspaceMcpServers.id, record.id));
    await db.delete(secretValues).where(eq(secretValues.workspaceId, ws));
    const before = (await store.get(ws, record.id))?.connection;
    expect(before?.state).toBe("active");
    const result = await store.disconnect({
      ...asUser(ws, admin),
      workspaceId: ws,
      serverId: record.id,
    });
    expect(result.outcome).toBe("unsupported_kind");
    expect((await store.get(ws, record.id))?.connection).toEqual(before);
    expect(await store.credentialOf(ws, record.id)).toBeNull();
    expect((await receiptsOf(ws)).map((row) => row.operation)).toEqual([
      "create_workspace_mcp_server",
    ]);
  });

  test("a credential left on a server that takes none, or of a kind this release does not know, is never read out", async () => {
    const { ws, admin } = await team();
    // One row holds a static token, the other an OAuth access and refresh token.
    const bearer = await created(ws, admin);
    const oauth = await connectedOAuth(ws, admin);
    await db.execute(
      sql`ALTER TABLE workspace_mcp_servers DROP CONSTRAINT workspace_mcp_servers_auth_kind_check, ADD CONSTRAINT workspace_mcp_servers_auth_kind_check CHECK (auth_kind IN ('oauth', 'bearer', 'none', 'mtls')) NOT VALID`,
    );
    const left = await purposesOf(ws);
    expect(left).toContain("mcp_bearer_token");
    expect(left).toContain("mcp_access_token");
    for (const record of [bearer, oauth]) {
      for (const kind of ["none", "mtls"] as const) {
        await db
          .update(workspaceMcpServers)
          .set({ authKind: kind as never, oauth: null })
          .where(eq(workspaceMcpServers.id, record.id));
        expect(await purposesOf(ws)).toEqual(left);
        expect(await store.credentialOf(ws, record.id)).toEqual(
          kind === "none" ? { kind: "none" } : null,
        );
      }
    }
  });

  test("a member, or an admin no longer one, writes nothing", async () => {
    const { ws, admin, plain } = await team();
    expect((await create(ws, plain)).outcome).toBe("actor_inactive");
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(
        and(eq(memberships.workspaceId, ws), eq(memberships.userId, admin)),
      );
    expect((await create(ws, admin)).outcome).toBe("actor_inactive");
    expect(await store.list(ws)).toEqual([]);
    expect(await receiptsOf(ws)).toEqual([]);
  });

  test("a name is one tool prefix in a workspace; a retired catalog server's name is free", async () => {
    const { ws, admin } = await team();
    const other = await team();
    const catalogName = `catalog-${randomUUID().slice(0, 8)}`;
    await db.insert(retiredCatalogMcp).values({
      name: catalogName,
      url: "https://catalog.example.com/mcp",
      credentialRef: "docs",
    });
    expect((await create(ws, admin, { name: catalogName })).outcome).toBe(
      "created",
    );
    await created(ws, admin, { name: "tracker" });
    expect((await create(ws, admin, { name: "tracker" })).outcome).toBe(
      "name_taken",
    );
    // Another workspace's tools are another agent's; the prefix may repeat.
    expect(
      (await create(other.ws, other.admin, { name: "tracker" })).outcome,
    ).toBe("created");
  });

  // The service refuses `memory` for a new server; the table does not, so a
  // server registered under it before keeps its name.
  test("a server named memory stays", async () => {
    const { ws, admin } = await team();
    await created(ws, admin, { name: "memory" });
    expect((await store.list(ws)).map((server) => server.name)).toEqual([
      "memory",
    ]);
  });

  test("a workspace holds no more servers than its limit", async () => {
    const { ws, admin } = await team();
    await created(ws, admin, { max: 1 });
    expect((await create(ws, admin, { max: 1 })).outcome).toBe(
      "quota_exceeded",
    );
  });

  test("a sign-in completes only for its starter, its flow and before it expires", async () => {
    const { ws, admin, owner } = await team();
    const server = await created(ws, admin, {
      authKind: "oauth",
      oauth: PIN,
      bearerToken: null,
    });
    expect(server.connection.state).toBe("none");
    const flowId = await startedFlow(
      ws,
      admin,
      server.id,
      new Date(Date.now() + HOUR),
    );
    const flow = await store.readFlow(ws, server.id);
    expect(flow).toMatchObject({
      flowId,
      startedByUserId: admin,
      verifier: "example-verifier-not-real",
      clientSecret: FAKE_CLIENT_VALUE,
      oauth: { client: { clientId: "client-1" } },
    });
    const tokens = {
      accessToken: FAKE_ACCESS,
      refreshToken: FAKE_REFRESH,
      expiresAt: new Date(Date.now() + HOUR),
      scope: "read:issues",
    };
    const complete = (
      actor: string,
      overrides: { flowId?: string; now?: Date } = {},
    ) =>
      store.completeFlow({
        ...asUser(ws, actor),
        workspaceId: ws,
        serverId: server.id,
        flowId,
        now: new Date(),
        tokens,
        ...overrides,
      });
    expect((await complete(owner)).outcome).toBe("actor_inactive");
    expect((await complete(admin, { flowId: randomUUID() })).outcome).toBe(
      "flow_gone",
    );
    expect(
      (await complete(admin, { now: new Date(Date.now() + 2 * HOUR) })).outcome,
    ).toBe("flow_gone");
    const done = await complete(admin);
    if (done.outcome !== "connected") throw new Error(done.outcome);
    expect(done.record.connection).toMatchObject({
      state: "active",
      generation: 1,
      grantedScope: "read:issues",
      connectedBy: { userId: admin },
    });
    expect(await store.readFlow(ws, server.id)).toBeNull();
    expect((await complete(admin)).outcome).toBe("flow_gone");
    expect(await store.credentialOf(ws, server.id)).toMatchObject({
      kind: "oauth",
      accessToken: FAKE_ACCESS,
      hasRefreshToken: true,
    });
    expect(await purposesOf(ws)).toEqual([
      "mcp_access_token",
      "mcp_client_secret",
      "mcp_refresh_token",
    ]);
    await expectNoPlainCredential(ws);
  });

  test("a sign-in past its expiry is gone even when the caller's clock is behind", async () => {
    const { ws, admin } = await team();
    const server = await created(ws, admin, {
      authKind: "oauth",
      oauth: PIN,
      bearerToken: null,
    });
    const flowId = await startedFlow(
      ws,
      admin,
      server.id,
      new Date(Date.now() - 1000),
    );
    const done = await store.completeFlow({
      ...asUser(ws, admin),
      workspaceId: ws,
      serverId: server.id,
      flowId,
      now: new Date(Date.now() - HOUR),
      tokens: {
        accessToken: FAKE_ACCESS,
        refreshToken: FAKE_REFRESH,
        expiresAt: null,
        scope: null,
      },
    });
    expect(done.outcome).toBe("flow_gone");
    expect((await store.get(ws, server.id))?.connection.state).toBe("none");
  });

  test("a sign-in built for one client does not start once another landed", async () => {
    const { ws, admin, owner } = await team();
    const server = await created(ws, admin, {
      authKind: "oauth",
      oauth: PIN,
      bearerToken: null,
    });
    await startedFlow(ws, owner, server.id, new Date(Date.now() + HOUR));
    const late = await store.beginFlow({
      ...asUser(ws, admin),
      workspaceId: ws,
      serverId: server.id,
      flowId: randomUUID(),
      stateSha256: createHash("sha256").update("late").digest(),
      expiresAt: new Date(Date.now() + HOUR),
      verifier: "example-verifier-not-real",
      expectedClientId: null,
      registered: {
        client: {
          registration: "dcr",
          clientId: "client-late",
          authMethod: "none",
        },
        clientSecret: null,
      },
    });
    expect(late.outcome).toBe("client_changed");
    const kept = await store.get(ws, server.id);
    expect(kept?.oauth?.client?.clientId).toBe("client-1");
    expect((await store.readFlow(ws, server.id))?.startedByUserId).toBe(owner);
  });

  test("a tool list is stored only for the connection it was read with, by a manager", async () => {
    const { ws, admin, owner } = await team();
    const server = await connectedOAuth(ws, admin);
    const save = (actor: string, generation: number) =>
      store.saveTools({
        ...asUser(ws, actor),
        workspaceId: ws,
        serverId: server.id,
        generation,
        tools: [{ name: "search", description: null }],
        skipped: 0,
        readAt: new Date(),
      });
    const saved = await save(admin, server.connection.generation);
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    expect(saved.record.tools).toEqual([{ name: "search", description: null }]);
    expect((await save(admin, server.connection.generation + 1)).outcome).toBe(
      "stale",
    );
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(
        and(eq(memberships.workspaceId, ws), eq(memberships.userId, admin)),
      );
    expect((await save(admin, server.connection.generation)).outcome).toBe(
      "actor_inactive",
    );
    const off = await store.disconnect({
      ...asUser(ws, owner),
      workspaceId: ws,
      serverId: server.id,
    });
    if (off.outcome !== "disconnected") throw new Error(off.outcome);
    expect((await save(owner, server.connection.generation)).outcome).toBe(
      "stale",
    );
    expect((await save(owner, off.record.connection.generation)).outcome).toBe(
      "stale",
    );
    expect(
      (
        await store.saveTools({
          ...asUser(ws, owner),
          workspaceId: ws,
          serverId: randomUUID(),
          generation: 1,
          tools: [],
          skipped: 0,
          readAt: new Date(),
        })
      ).outcome,
    ).toBe("not_found");
  });

  test("a refresh stores what it decided under the lock", async () => {
    const { ws, admin } = await team();
    const server = await connectedOAuth(ws, admin);
    const seen: (string | null)[] = [];
    const refreshed = await store.refresh(ws, server.id, async (input) => {
      seen.push(input.refreshToken, input.clientSecret);
      return {
        kind: "store",
        tokens: {
          accessToken: "example-access-2",
          refreshToken: null,
          expiresAt: new Date(Date.now() + HOUR),
          scope: "read:issues",
        },
        grantedScope: "read:issues",
      };
    });
    expect(seen).toEqual([FAKE_REFRESH, FAKE_CLIENT_VALUE]);
    expect(refreshed?.connection.state).toBe("active");
    expect(await store.credentialOf(ws, server.id)).toMatchObject({
      accessToken: "example-access-2",
      hasRefreshToken: true,
    });
    const backedOff = await store.refresh(ws, server.id, async () => ({
      kind: "backoff",
    }));
    expect(backedOff?.connection.refreshFailedAt).toBeInstanceOf(Date);
    const reauth = await store.refresh(ws, server.id, async () => ({
      kind: "reauth",
      reason: "invalid_client",
      dropClient: true,
    }));
    expect(reauth?.connection).toMatchObject({
      state: "needs_reauth",
      reauthReason: "invalid_client",
      refreshFailedAt: null,
    });
    expect(reauth?.oauth?.client).toBeNull();
    expect(await store.credentialOf(ws, server.id)).toBeNull();
    expect(await purposesOf(ws)).toEqual([]);
    expect(
      await store.refresh(ws, server.id, async () => ({ kind: "keep" })),
    ).toBeNull();
  });

  test("disconnect hands back what to revoke and drops the person's tokens", async () => {
    const { ws, admin, owner } = await team();
    const server = await connectedOAuth(ws, admin);
    const result = await store.disconnect({
      ...asUser(ws, owner),
      workspaceId: ws,
      serverId: server.id,
    });
    if (result.outcome !== "disconnected") throw new Error(result.outcome);
    expect(result.revocation).toEqual({
      oauth: {
        ...PIN,
        client: {
          registration: "dcr",
          clientId: "client-1",
          authMethod: "client_secret_basic",
        },
      },
      token: FAKE_REFRESH,
      hint: "refresh_token",
      clientSecret: FAKE_CLIENT_VALUE,
    });
    expect(result.record.connection).toMatchObject({
      state: "none",
      generation: 2,
      connectedBy: null,
    });
    expect(await purposesOf(ws)).toEqual(["mcp_client_secret"]);

    const bearer = await created(ws, admin);
    await store.disconnect({
      ...asUser(ws, admin),
      workspaceId: ws,
      serverId: bearer.id,
    });
    expect(await store.credentialOf(ws, bearer.id)).toBeNull();
    expect((await store.get(ws, bearer.id))?.bearerLast4).toBeNull();
    expect(
      (await receiptsOf(ws)).filter(
        (row) => row.operation === "disconnect_workspace_mcp_server",
      ),
    ).toHaveLength(2);
  });

  test("a new client drops the tokens issued to the old one", async () => {
    const { ws, admin } = await team();
    const server = await connectedOAuth(ws, admin);
    const saved = await store.setOAuthClient({
      ...asUser(ws, admin),
      workspaceId: ws,
      serverId: server.id,
      client: {
        registration: "manual",
        clientId: "client-2",
        authMethod: "none",
      },
      clientSecret: null,
    });
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    expect(saved.record.connection.state).toBe("none");
    expect(saved.record.oauth?.client?.clientId).toBe("client-2");
    expect(saved.record.hasClientSecret).toBe(false);
    expect(await purposesOf(ws)).toEqual([]);
  });

  test("delete marks the row and takes its connection and every secret", async () => {
    const { ws, admin } = await team();
    const server = await connectedOAuth(ws, admin);
    const result = await store.delete({
      ...asUser(ws, admin),
      workspaceId: ws,
      serverId: server.id,
    });
    expect(result).toMatchObject({
      outcome: "deleted",
      revocation: { token: FAKE_REFRESH },
    });
    expect(await store.get(ws, server.id)).toBeNull();
    expect(
      await db
        .select()
        .from(workspaceMcpConnections)
        .where(eq(workspaceMcpConnections.serverId, server.id)),
    ).toEqual([]);
    expect(await purposesOf(ws)).toEqual([]);
    expect(
      (
        await store.delete({
          ...asUser(ws, admin),
          workspaceId: ws,
          serverId: server.id,
        })
      ).outcome,
    ).toBe("not_found");
    const [kept] = await db
      .select()
      .from(workspaceMcpServers)
      .where(eq(workspaceMcpServers.id, server.id));
    expect(kept).toMatchObject({ deletedBy: admin, oauth: null });
    expect(kept?.deletedAt).toBeInstanceOf(Date);
    expect(await store.list(ws)).toEqual([]);
    // The name is free again, and the deleted row is not counted.
    const again = await created(ws, admin, { name: server.name, max: 1 });
    expect(again.id).not.toBe(server.id);
    expect((await store.list(ws)).map((row) => row.id)).toEqual([again.id]);
  });

  test("disabling the person who connected disconnects what they connected", async () => {
    const { ws, admin, owner } = await team();
    const oauth = await connectedOAuth(ws, admin);
    const bearer = await created(ws, admin);
    const open = await created(ws, admin, {
      authKind: "none",
      bearerToken: null,
    });
    const ownerServer = await connectedOAuth(ws, owner);
    // A sign-in the admin only started, on a server the owner connected.
    await startedFlow(ws, admin, ownerServer.id, new Date(Date.now() + HOUR));
    const offboarded = await createPostgresMemberStore(db).setAccess({
      decision: memberManageAllow({ workspaceId: ws, actorUserId: owner }),
      actor: {
        principal: asUser(ws, owner).principal,
        workspaceId: ws,
        userId: owner,
      },
      userId: admin,
      scope: "membership",
      disabled: true,
      reason: null,
      receiptId: randomUUID(),
    });
    expect(offboarded.outcome).toBe("changed");
    for (const id of [oauth.id, bearer.id]) {
      expect((await store.get(ws, id))?.connection).toMatchObject({
        state: "none",
        connectedBy: null,
      });
      expect(await store.credentialOf(ws, id)).toBeNull();
    }
    expect((await store.get(ws, ownerServer.id))?.connection).toMatchObject({
      state: "active",
      connectedBy: { userId: owner },
    });
    // No one connected it: it stays as it was.
    expect((await store.get(ws, open.id))?.connection.state).toBe("active");
    expect(await store.credentialOf(ws, open.id)).toEqual({ kind: "none" });
    expect(await store.readFlow(ws, ownerServer.id)).toBeNull();
    expect(await store.credentialOf(ws, ownerServer.id)).toMatchObject({
      kind: "oauth",
      hasRefreshToken: true,
    });
  });
});
