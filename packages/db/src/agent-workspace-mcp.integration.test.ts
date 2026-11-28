import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole } from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAgentWorkspaceMcpService,
  createAuthorizationPolicy,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  sessionReach,
  startReach,
} from "./access-control/agent-caller-limits.ts";
import { createDatabaseIdentityReader } from "./access-control/identity-reader.ts";
import {
  captureWorkspaceMcpStart,
  createPostgresAgentWorkspaceMcpStore,
} from "./extensions/mcp/agent-workspace-mcp.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  agentWorkspaceMcpServers,
  memberships,
  receipts,
  sessions,
  users,
  workspaceMcpConnections,
  workspaceMcpServers,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code?: string;
      details?: { reason_code?: string; field?: string } | null;
    };
    return `${failure.code}:${failure.details?.reason_code ?? ""}:${failure.details?.field ?? ""}`;
  }
  return "saved";
}

integration("agent workspace MCP servers on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_ws_mcp_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const service = () =>
    createAgentWorkspaceMcpService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentWorkspaceMcpStore(db),
    });

  async function person(workspaceId: string, role: "owner" | "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return userId;
  }

  const callerOf = (
    workspaceId: string,
    userId: string,
    role: "owner" | "member",
  ): Caller =>
    callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );

  async function server(workspaceId: string, name: string, tools: string[]) {
    const id = randomUUID();
    await db.insert(workspaceMcpServers).values({
      id,
      workspaceId,
      name,
      url: `https://${name}.example.com/mcp`,
      authKind: "bearer",
      tools: tools.map((tool) => ({ name: tool, description: null })),
    });
    return id;
  }

  async function setup() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    const ownerId = await person(workspaceId, "owner");
    const memberId = await person(workspaceId, "member");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {
        role: "r",
        instructions: "i",
        model: "m",
        capabilities: { tools: null, mcp: null, forbidden: [] },
      },
      contentSha256: "0".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: { tools: [], mcp: [] },
      policyPins: {},
    });
    await db
      .update(agents)
      .set({ activeReleaseId: releaseId, activationRevision: 0 })
      .where(eq(agents.id, agentId));
    const tracker = await server(workspaceId, "tracker", ["search", "create"]);
    const wiki = await server(workspaceId, "wiki", ["read"]);
    await db.insert(workspaceMcpConnections).values({
      serverId: tracker,
      subject: "workspace",
      state: "active",
      connectedByUserId: ownerId,
      connectedAt: new Date(),
    });
    return {
      workspaceId,
      agentId,
      releaseId,
      ownerId,
      tracker,
      wiki,
      owner: callerOf(workspaceId, ownerId, "owner"),
      member: callerOf(workspaceId, memberId, "member"),
    };
  }

  const receiptsOf = (agentId: string) =>
    db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "set_agent_workspace_mcp"))
      .then((rows) =>
        rows.filter(
          (row) =>
            (row.result as { agent_id?: string } | null)?.agent_id === agentId,
        ),
      );

  const selectedOf = async (agentId: string) =>
    (
      await db
        .select({ serverId: agentWorkspaceMcpServers.serverId })
        .from(agentWorkspaceMcpServers)
        .where(eq(agentWorkspaceMcpServers.agentId, agentId))
    )
      .map((row) => row.serverId)
      .sort();

  test("the list shows every workspace server, its connection and who connected it", async () => {
    const { agentId, owner, ownerId, tracker, wiki } = await setup();
    const listed = await service().list(owner, agentId);
    expect(listed.items).toEqual([
      {
        server_id: tracker,
        name: "tracker",
        on: false,
        state: "active",
        connected_by: { user_id: ownerId, display_name: "owner" },
        tool_count: 2,
      },
      {
        server_id: wiki,
        name: "wiki",
        on: false,
        state: "none",
        connected_by: null,
        tool_count: 1,
      },
    ]);
  });

  test("an owner saves the whole set with a receipt; the same set again writes none", async () => {
    const { agentId, owner, ownerId, tracker, wiki } = await setup();
    const saved = await service().put(owner, agentId, {
      server_ids: [wiki, tracker.toUpperCase()],
    });
    expect(saved.receipt_id).not.toBeNull();
    expect(saved.servers.items.map((row) => [row.name, row.on])).toEqual([
      ["tracker", true],
      ["wiki", true],
    ]);
    expect(await selectedOf(agentId)).toEqual([tracker, wiki].sort());
    const [receipt] = await receiptsOf(agentId);
    expect(receipt?.result).toEqual({
      agent_id: agentId,
      before: [],
      after: [
        { id: tracker, name: "tracker" },
        { id: wiki, name: "wiki" },
      ],
    });
    expect(receipt?.actor).toMatchObject({ actor_user_id: ownerId });

    const again = await service().put(owner, agentId, {
      server_ids: [tracker, wiki],
    });
    expect(again.receipt_id).toBeNull();
    expect(await receiptsOf(agentId)).toHaveLength(1);

    const narrowed = await service().put(owner, agentId, {
      server_ids: [wiki],
    });
    expect(narrowed.receipt_id).not.toBeNull();
    expect(await selectedOf(agentId)).toEqual([wiki]);
    expect((await receiptsOf(agentId)).at(-1)?.result).toMatchObject({
      before: [
        { id: tracker, name: "tracker" },
        { id: wiki, name: "wiki" },
      ],
      after: [{ id: wiki, name: "wiki" }],
    });

    await service().put(owner, agentId, { server_ids: [] });
    expect(await selectedOf(agentId)).toEqual([]);
  });

  test("another workspace's server is unknown; a member cannot save", async () => {
    const { agentId, owner, member, tracker } = await setup();
    const other = await setup();
    expect(
      await refusal(
        service().put(owner, agentId, {
          server_ids: [tracker, other.tracker],
        }),
      ),
    ).toBe("BAD_REQUEST:server_unknown:server_ids.1");
    expect(
      await refusal(service().put(member, agentId, { server_ids: [tracker] })),
    ).toStartWith("FORBIDDEN:");
    expect(await selectedOf(agentId)).toEqual([]);
    expect(await receiptsOf(agentId)).toHaveLength(0);
  });

  test("a server deleted from the workspace leaves the agent's set", async () => {
    const { agentId, owner, tracker, wiki } = await setup();
    await service().put(owner, agentId, { server_ids: [tracker, wiki] });
    await db
      .delete(workspaceMcpServers)
      .where(eq(workspaceMcpServers.id, tracker));
    expect(await selectedOf(agentId)).toEqual([wiki]);
  });

  test("a session start keeps the servers on with their tools, and its reach counts them", async () => {
    const { agentId, releaseId, workspaceId, owner, tracker, wiki } =
      await setup();
    expect(
      await db.transaction((tx) => captureWorkspaceMcpStart(tx, releaseId)),
    ).toBeNull();
    // Off when the session starts, so out of its reach.
    const none = await db.transaction((tx) =>
      startReach(tx, {
        releaseId,
        workspaceMcpStart: null,
        githubPolicySource: "release",
        repositoryIds: [],
      }),
    );
    expect(none?.mcp_servers).toEqual([]);

    await service().put(owner, agentId, { server_ids: [wiki, tracker] });
    const start = await db.transaction((tx) =>
      captureWorkspaceMcpStart(tx, releaseId),
    );
    expect(start).toEqual({
      servers: [
        {
          id: tracker,
          name: "tracker",
          url: "https://tracker.example.com/mcp",
          tools: ["mcp__tracker__search", "mcp__tracker__create"],
        },
        // Not connected yet: the server and its tools still count.
        {
          id: wiki,
          name: "wiki",
          url: "https://wiki.example.com/mcp",
          tools: ["mcp__wiki__read"],
        },
      ],
    });

    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      ...sessionPinColumns(),
      agentReleaseId: releaseId,
      workspaceMcpStart: start,
    });
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.workspaceMcpStart).toEqual(start);

    // A server turned off after the start stays in the running session's
    // snapshot; the claim, not the reach, narrows it.
    await service().put(owner, agentId, { server_ids: [] });
    const reach = await db.transaction((tx) =>
      sessionReach(tx, {
        agentReleaseId: releaseId,
        repositoryId: null,
        attachedRepositoryIds: [],
        mcpStart: null,
        workspaceMcpStart: row?.workspaceMcpStart ?? null,
        githubPolicySource: "release",
        githubPolicyStart: null,
      }),
    );
    expect([...(reach?.mcp_servers ?? [])].sort()).toEqual(["tracker", "wiki"]);
    expect([...(reach?.tools ?? [])].sort()).toEqual([
      "mcp__tracker__create",
      "mcp__tracker__search",
      "mcp__wiki__read",
    ]);
  });
});
