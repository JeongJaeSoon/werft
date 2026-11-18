import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type EgressIssue,
  hashWorkerToken,
  type SessionWorkspaceMcp,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  agentWorkspaceMcpServers,
  receipts,
  sessions,
  users,
  workspaceMcpConnections,
  workspaceMcpServers,
  workspaces,
} from "./schema.ts";
import {
  createPostgresWorkspaceMcpEgressStore,
  sessionWorkspaceMcpOf,
} from "./sessions/workspace-mcp-egress.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { launchSession } from "./testing/launches.ts";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
  testClaimCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

integration("workspace MCP servers in the claim and the egress", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "ws_mcp_egress_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

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

  /**
   * An agent with `tracker` (connected, generation 2) and `wiki` (never
   * connected) and a session it started with both on, unless `on` is false.
   */
  async function setup(options: { mcpDeny?: string[]; on?: boolean } = {}) {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    const adminId = randomUUID();
    await db.insert(users).values({
      id: adminId,
      email: `${adminId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "admin",
    });
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
        capabilities: { tools: null, mcp: [], forbidden: [] },
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
      runtimeConfigSnapshot:
        options.mcpDeny === undefined ? {} : { mcp_deny: options.mcpDeny },
      effectiveTools: { tools: [], mcp: [] },
      policyPins: {
        tools: { default: { builtin: "allow", mcp: "ask" }, per_tool: {} },
      },
    });
    const tracker = await server(workspaceId, "tracker", ["search", "create"]);
    const wiki = await server(workspaceId, "wiki", ["read"]);
    await db.insert(workspaceMcpConnections).values({
      serverId: tracker,
      subject: "workspace",
      state: "active",
      generation: 2,
      connectedByUserId: adminId,
      connectedAt: new Date(),
    });
    if (options.on !== false) {
      await db.insert(agentWorkspaceMcpServers).values([
        { agentId, workspaceId, serverId: tracker },
        { agentId, workspaceId, serverId: wiki },
      ]);
    }
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      principal: { ownerId: workspaceId },
      idempotencyKey: randomUUID(),
      payloadHash: "h",
      model: TEST_MODEL,
      repository: "none",
      agentReleaseId: releaseId,
      message: "go",
      limits: LIMITS,
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    // A principal without an actor leaves the session's workspace unset; a
    // console or key caller sets it.
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, accepted.response.session_id));
    return {
      workspaceId,
      agentId,
      releaseId,
      tracker,
      wiki,
      sessionId: accepted.response.session_id,
    };
  }

  type Launch = Awaited<ReturnType<typeof launchSession>>;
  // A given launch is a worker retrying the claim it already made.
  async function claim(
    sessionId: string,
    options: {
      again?: Launch;
      workspaceMcp?: boolean;
      // As the gateway's bindingsOf does for names that collide.
      collide?: boolean;
    } = {},
  ) {
    const launch = options.again ?? (await launchSession(db, { sessionId }));
    const asked: Parameters<EgressIssue["bindingsOf"]>[0][] = [];
    const result = await createPostgresWorkerUnitOfWork(db).claimAtomic({
      ...(options.workspaceMcp === false
        ? {}
        : { workspaceMcp: true as const }),
      settingsGeneration: Number.MAX_SAFE_INTEGER,
      unsettledRepositoryIds: new Set(),
      unsettledConnectionIds: new Set(),
      runnable: testClaimCatalog(),
      budget: { costUsd: 1_000, tokens: null },
      nonceHash: hashWorkerToken(launch.nonce),
      executionId: launch.executionId,
      executionGeneration: launch.generation,
      attemptId: `att_${randomUUID()}`,
      credentialHash: hashWorkerToken(`tok-${randomUUID()}`),
      credentialTtlMs: 60_000,
      egress: {
        providerHash: hashWorkerToken(`wep-${randomUUID()}`),
        repositoryHash: hashWorkerToken(`wer-${randomUUID()}`),
        objectStoreHash: hashWorkerToken(`weo-${randomUUID()}`),
        bindingsOf: (input) => {
          asked.push(input);
          if (options.collide) throw new Error("names collide");
          return {
            provider: "provider",
            repository: "repository",
            object_store: "sessions/s/",
          };
        },
      },
      leaseTtlMs: 60_000,
      now: new Date(),
    });
    return { result, asked, launch };
  }

  const entry = (
    releaseId: string,
    serverId: string,
    name: string,
    tools: string[],
  ): SessionWorkspaceMcp => ({
    releaseId,
    serverId,
    name,
    url: `https://${name}.example.com/mcp`,
    tools,
  });

  describe("the claim", () => {
    test("a worker without workspace_mcp is refused before anything is bound; one with it gets the snapshot's servers", async () => {
      const { sessionId, releaseId, tracker, wiki } = await setup();
      // The launch itself writes the session row; the claim must not.
      const launch = await launchSession(db, { sessionId });
      const before = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      const old = await claim(sessionId, {
        again: launch,
        workspaceMcp: false,
      });
      expect(old.result.outcome).toBe("workspace_mcp_unsupported");
      expect(old.asked).toEqual([]);
      const after = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect(after).toEqual(before);
      expect(after[0]?.podId).toBeNull();

      // The same launch, now by a worker that carries them.
      const claimed = await claim(sessionId, { again: old.launch });
      expect(claimed.result.outcome).toBe("claimed");
      const expected = [
        entry(releaseId, tracker, "tracker", [
          "mcp__tracker__create",
          "mcp__tracker__search",
        ]),
        entry(releaseId, wiki, "wiki", ["mcp__wiki__read"]),
      ];
      if (claimed.result.outcome === "claimed") {
        expect(claimed.result.binding.workspaceMcp).toEqual(expected);
      }
      expect(claimed.asked[0]?.workspaceMcp).toEqual(expected);
    }, 60_000);

    test("a retry by a worker without it is refused the same way, before anything rotates", async () => {
      const { sessionId } = await setup();
      const first = await claim(sessionId);
      expect(first.result.outcome).toBe("claimed");
      const rowOf = async () =>
        (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
      const before = await rowOf();
      const old = await claim(sessionId, {
        again: first.launch,
        workspaceMcp: false,
      });
      expect(old.result.outcome).toBe("workspace_mcp_unsupported");
      expect(old.asked).toEqual([]);
      expect(await rowOf()).toEqual(before);
      const replayed = await claim(sessionId, { again: first.launch });
      expect(replayed.result.outcome).toBe("replayed");
    }, 60_000);

    test("a refusal thrown while binding the claim rolls the whole claim back", async () => {
      const { sessionId } = await setup();
      const rowOf = async () =>
        (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
      const launch = await launchSession(db, { sessionId });
      const before = await rowOf();
      const collided = claim(sessionId, { again: launch, collide: true });
      await expect(collided).rejects.toThrow("names collide");
      expect(await rowOf()).toEqual(before);
      // Nothing was spent: the same launch claims once the names are apart.
      expect((await claim(sessionId, { again: launch })).result.outcome).toBe(
        "claimed",
      );
    }, 60_000);

    test("a session with none on is claimed by either worker as before", async () => {
      const { sessionId } = await setup({ on: false });
      const claimed = await claim(sessionId, { workspaceMcp: false });
      expect(claimed.result.outcome).toBe("claimed");
      if (claimed.result.outcome === "claimed") {
        expect(claimed.result.binding.workspaceMcp ?? []).toEqual([]);
      }
    }, 60_000);

    test("the release's deny narrows a server's tools, and a whole-server deny leaves it out", async () => {
      const { sessionId, releaseId, tracker } = await setup({
        mcpDeny: ["mcp__tracker__create", "mcp__wiki__*"],
      });
      const claimed = await claim(sessionId);
      expect(claimed.result.outcome).toBe("claimed");
      if (claimed.result.outcome === "claimed") {
        expect(claimed.result.binding.workspaceMcp).toEqual([
          entry(releaseId, tracker, "tracker", ["mcp__tracker__search"]),
        ]);
      }
    }, 60_000);

    test("a server deleted or moved after the start is claimed as it started, so a checkpoint still matches", async () => {
      const { sessionId, releaseId, tracker, wiki } = await setup();
      const first = await claim(sessionId);
      expect(first.result.outcome).toBe("claimed");
      await db
        .delete(workspaceMcpServers)
        .where(eq(workspaceMcpServers.id, wiki));
      await db
        .update(workspaceMcpServers)
        .set({ url: "https://tracker-moved.example.com/mcp" })
        .where(eq(workspaceMcpServers.id, tracker));
      const expected = [
        entry(releaseId, tracker, "tracker", [
          "mcp__tracker__create",
          "mcp__tracker__search",
        ]),
        entry(releaseId, wiki, "wiki", ["mcp__wiki__read"]),
      ];
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect(await sessionWorkspaceMcpOf(db, session as never)).toEqual(
        expected,
      );
      if (first.result.outcome === "claimed") {
        expect(first.result.binding.workspaceMcp).toEqual(expected);
      }
      // Each one's egress refuses it.
      const store = createPostgresWorkspaceMcpEgressStore(db);
      for (const server of ["tracker", "wiki"]) {
        expect(
          (await store.sessionState({ sessionId, attemptId: "att_x", server }))
            ?.available,
        ).toBe(false);
      }
    }, 60_000);

    test("a snapshot from before URLs were kept takes the row's, and leaves out a server deleted since", async () => {
      const { sessionId, releaseId, tracker, wiki } = await setup();
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      const start = session?.workspaceMcpStart as {
        servers: Array<{ url?: string }>;
      };
      const unkept = {
        servers: start.servers.map(({ url: _url, ...server }) => server),
      };
      await db
        .update(sessions)
        .set({ workspaceMcpStart: unkept })
        .where(eq(sessions.id, sessionId));
      await db
        .delete(workspaceMcpServers)
        .where(eq(workspaceMcpServers.id, wiki));
      expect(
        await sessionWorkspaceMcpOf(db, {
          agentReleaseId: releaseId,
          workspaceId: session?.workspaceId ?? null,
          workspaceMcpStart: unkept,
        }),
      ).toEqual([
        entry(releaseId, tracker, "tracker", [
          "mcp__tracker__create",
          "mcp__tracker__search",
        ]),
      ]);
      // The row's URL is the one checked.
      expect(
        (
          await createPostgresWorkspaceMcpEgressStore(db).sessionState({
            sessionId,
            attemptId: "att_x",
            server: "tracker",
          })
        )?.available,
      ).toBe(true);
    }, 60_000);
  });

  describe("the egress store", () => {
    const store = () => createPostgresWorkspaceMcpEgressStore(db);
    const stateOf = (sessionId: string, server: string) =>
      store().sessionState({ sessionId, attemptId: "att_x", server });

    test("a server the session started with is read as it is now", async () => {
      const { sessionId, workspaceId, agentId, releaseId, tracker, wiki } =
        await setup();
      expect(await stateOf(sessionId, "tracker")).toMatchObject({
        ownerId: workspaceId,
        workspaceId,
        agentId,
        releaseId,
        serverId: tracker,
        available: true,
        url: "https://tracker.example.com/mcp",
        connection: { state: "active", generation: 2 },
        // Sorted, as the claim's are.
        tools: ["mcp__tracker__create", "mcp__tracker__search"],
      });
      expect(await stateOf(sessionId, "wiki")).toMatchObject({
        serverId: wiki,
        available: true,
        connection: { state: "none", generation: 0 },
      });
      // Not in the snapshot: left to the other decisions.
      expect(await stateOf(sessionId, "github")).toBeNull();
      expect(await stateOf(randomUUID(), "tracker")).toBeNull();
    });

    test("a server turned off, a reauth, a narrowed tool list and a delete each show at once", async () => {
      const { sessionId, agentId, tracker } = await setup();
      await db
        .update(workspaceMcpServers)
        .set({ tools: [{ name: "search", description: null }] })
        .where(eq(workspaceMcpServers.id, tracker));
      expect((await stateOf(sessionId, "tracker"))?.tools).toEqual([
        "mcp__tracker__search",
      ]);
      // A tool the server adds later is not the session's.
      await db
        .update(workspaceMcpServers)
        .set({
          tools: [
            { name: "search", description: null },
            { name: "create", description: null },
            { name: "drop", description: null },
          ],
        })
        .where(eq(workspaceMcpServers.id, tracker));
      expect((await stateOf(sessionId, "tracker"))?.tools).toEqual([
        "mcp__tracker__create",
        "mcp__tracker__search",
      ]);

      await db
        .update(workspaceMcpConnections)
        .set({ state: "needs_reauth", reauthReason: "invalid_grant" })
        .where(eq(workspaceMcpConnections.serverId, tracker));
      expect((await stateOf(sessionId, "tracker"))?.connection).toEqual({
        state: "needs_reauth",
        generation: 2,
      });

      await db
        .delete(agentWorkspaceMcpServers)
        .where(
          and(
            eq(agentWorkspaceMcpServers.agentId, agentId),
            eq(agentWorkspaceMcpServers.serverId, tracker),
          ),
        );
      expect((await stateOf(sessionId, "tracker"))?.available).toBe(false);

      await db
        .delete(workspaceMcpServers)
        .where(eq(workspaceMcpServers.id, tracker));
      expect(await stateOf(sessionId, "tracker")).toMatchObject({
        available: false,
        url: null,
        connection: null,
      });
    });

    test("a server renamed since the start is not the one the session named", async () => {
      const { sessionId, tracker } = await setup();
      await db
        .update(workspaceMcpServers)
        .set({ name: "tracker2" })
        .where(eq(workspaceMcpServers.id, tracker));
      expect((await stateOf(sessionId, "tracker"))?.available).toBe(false);
      expect(await stateOf(sessionId, "tracker2")).toBeNull();
    });

    test("a server moved to another URL since the start is not the one the session named", async () => {
      const { sessionId, tracker } = await setup();
      await db
        .update(workspaceMcpServers)
        .set({ url: "https://tracker-moved.example.com/mcp" })
        .where(eq(workspaceMcpServers.id, tracker));
      expect((await stateOf(sessionId, "tracker"))?.available).toBe(false);
    });

    test("the release's deny and a whole-server deny are taken out", async () => {
      const { sessionId } = await setup({
        mcpDeny: ["mcp__tracker__create", "mcp__wiki__*"],
      });
      expect((await stateOf(sessionId, "tracker"))?.tools).toEqual([
        "mcp__tracker__search",
      ]);
      expect((await stateOf(sessionId, "wiki"))?.tools).toEqual([]);
    });

    test("a refusal is written once as a call_mcp receipt", async () => {
      const { sessionId, workspaceId, agentId, releaseId, tracker } =
        await setup();
      const record = {
        id: randomUUID(),
        ownerId: workspaceId,
        sessionId,
        turnId: null,
        status: "failed" as const,
        message: "The workspace MCP server needs to be connected again",
        actor: null,
        result: {
          attempt_id: "att_x",
          agent_id: agentId,
          release_id: releaseId,
          server_id: "tracker",
          workspace_server_id: tracker,
          connection_generation: 2,
          reason: "oauth_needs_reauth" as const,
        },
      };
      await store().recordRefusal(record);
      await store().recordRefusal(record);
      const rows = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, record.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operation: "call_mcp",
        status: "failed",
        result: record.result,
        error: { code: "CREDENTIAL_UNBOUND" },
      });
    });

    test("a call is written as an accepted call_mcp receipt only while its connection is at the generation named", async () => {
      const { sessionId, workspaceId, agentId, releaseId, tracker } =
        await setup();
      const record = (generation: number) => ({
        id: randomUUID(),
        ownerId: workspaceId,
        sessionId,
        turnId: null,
        actor: null,
        result: {
          attempt_id: "att_x",
          agent_id: agentId,
          release_id: releaseId,
          server_id: "tracker",
          workspace_server_id: tracker,
          connection_generation: generation,
          tool: "search",
        },
      });
      const sent = record(2);
      expect(await store().recordCall(sent)).toBe(true);
      const [row] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, sent.id));
      expect(row).toMatchObject({
        operation: "call_mcp",
        status: "accepted",
        result: sent.result,
        error: null,
      });

      // Reconnected: generation 3 now; a call read under 2 names nothing.
      await db
        .update(workspaceMcpConnections)
        .set({ generation: 3 })
        .where(eq(workspaceMcpConnections.serverId, tracker));
      const stale = record(2);
      expect(await store().recordCall(stale)).toBe(false);
      expect(
        await db.select().from(receipts).where(eq(receipts.id, stale.id)),
      ).toEqual([]);
      // Disconnected at the same generation: not active, nothing written.
      await db
        .update(workspaceMcpConnections)
        .set({ state: "none" })
        .where(eq(workspaceMcpConnections.serverId, tracker));
      expect(await store().recordCall(record(3))).toBe(false);
    });
  });
});
