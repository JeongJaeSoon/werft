import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentCard,
  type AgentCardRequest,
  agentCardRequestSchema,
  type ListAgentsQuery,
  SESSION_SCOPE_VALUES,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  callerFor,
  cardContentSha256,
  createAgentService,
  createAuthorizationPolicy,
  deriveReleaseId,
  InvalidCursorError,
  releaseRunOf,
  resolveReleaseContent,
  type SessionCatalog,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentAdminStore } from "./agent-admins.ts";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresSessionReader } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentActivationEvents,
  agentAdmins,
  agentAdminTeams,
  agentIdentities,
  agentReleases,
  agents,
  agentVersions,
  attempts,
  credentialBindings,
  memberships,
  memberTeamMembers,
  memberTeams,
  pendingRequests,
  receipts,
  sessionShares,
  sessions,
  slackApps,
  slackInstallations,
  surfaceBindings,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testSessionCatalog,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const PAGE = { limit: 50 };

const CATALOG: SessionCatalog = testSessionCatalog({
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

// The run a release on the test connection gets, as the service resolves it.
const TEST_RUN = (() => {
  const found = releaseRunOf(CATALOG, TEST_RUNTIMES, TEST_CONNECTION_ID);
  if (!found.ok) throw new Error(found.message);
  return found.run;
})();

function cardWith(instructions: string, tools: string[] | null = ["Read"]) {
  return agentCardRequestSchema.parse({
    role: "재무 분석가",
    instructions,
    model: "claude-sonnet-5",
    capabilities: { tools, mcp: null, forbidden: [] },
  });
}

// What PostgreSQL said; Drizzle wraps it as the cause of its own error.
async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String((error as { cause?: Error }).cause?.message ?? error);
  }
  return "accepted";
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  return "ok";
}

integration("agents, versions, releases and activation on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agents_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function service(catalog: SessionCatalog = CATALOG): AgentService {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog,
      credentials: createPostgresCredentialBindingStore(db),
      runtimes: TEST_RUNTIMES,
    });
  }

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(workspaceId: string, role: "owner" | "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        // A member's own: a scope over the role makes a request malformed.
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  function serviceKey(workspaceId: string): Caller {
    return callerFor(
      {
        kind: "api_key",
        id: randomUUID(),
        owner_id: workspaceId,
        workspace_id: workspaceId,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      randomUUID(),
      { creatorId: null },
    );
  }

  async function liveTeam(workspaceId: string) {
    const teamId = randomUUID();
    await db.insert(memberTeams).values({
      id: teamId,
      workspaceId,
      name: `team-${teamId.slice(0, 8)}`,
    });
    return teamId;
  }

  async function newAgent(
    agents: AgentService,
    owner: Caller,
    card: AgentCardRequest = cardWith("v1"),
  ) {
    return agents.createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      managing_team_id: await liveTeam(owner.ownerId),
      card,
    });
  }

  // Rows straight into agents, so created_at can tie and differ by 1µs.
  async function seedAgents(workspaceId: string, createdAt: string[]) {
    const ids: string[] = createdAt.map(() => randomUUID());
    const teamId = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      `INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, created_at)
       SELECT id, $1, $4, 'seed-' || id, 'seed', at
       FROM unnest($2::uuid[], $3::timestamptz[]) AS seed(id, at)`,
      [workspaceId, ids, createdAt, teamId],
    );
    return ids;
  }

  async function walk(
    agentsService: AgentService,
    caller: Caller,
    limit: number,
  ) {
    const pages: { ids: string[]; next_cursor: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await agentsService.listAgents(caller, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      pages.push({
        ids: page.items.map((agent) => agent.id),
        next_cursor: page.next_cursor,
      });
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return pages;
  }

  async function idsInOrder(workspaceId: string) {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .orderBy(asc(agents.createdAt), asc(agents.id));
    return rows.map((row) => row.id);
  }

  test("pages walk created_at, id oldest first through ties and microseconds, and only the last page has no next_cursor", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const tie = "2026-01-01 00:00:00.000001+00";
    await seedAgents(workspaceId, [
      tie,
      tie,
      tie,
      "2026-01-01 00:00:00.000002+00",
      "2026-01-01 00:00:00+00",
      tie,
      "2026-01-02 00:00:00+00",
    ]);
    const pages = await walk(agentsService, owner, 3);
    expect(pages.map((page) => page.ids.length)).toEqual([3, 3, 1]);
    expect(pages.map((page) => page.next_cursor === null)).toEqual([
      false,
      false,
      true,
    ]);
    expect(pages.flatMap((page) => page.ids)).toEqual(
      await idsInOrder(workspaceId),
    );

    // Exactly limit agents: one full page, nothing after it.
    const exact = await workspace();
    const exactOwner = await person(exact, "owner");
    await seedAgents(exact, [tie, tie, tie]);
    expect(await walk(agentsService, exactOwner, 3)).toEqual([
      { ids: await idsInOrder(exact), next_cursor: null },
    ]);
  });

  test("more than the old 500 cap are all listed, and no cursor reads the first 50", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    await seedAgents(
      workspaceId,
      Array.from({ length: 501 }, (_, i) =>
        new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      ),
    );
    const all = await idsInOrder(workspaceId);
    const first = await agentsService.listAgents(owner, PAGE);
    expect(first.items.map((agent) => agent.id)).toEqual(all.slice(0, 50));
    expect(first.next_cursor).not.toBeNull();
    const pages = await walk(agentsService, owner, 100);
    expect(pages.map((page) => page.ids.length)).toEqual([
      100, 100, 100, 100, 100, 1,
    ]);
    expect(pages.flatMap((page) => page.ids)).toEqual(all);
  });

  test("agents created during a walk never duplicate or hide the ones that were there", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const before = await seedAgents(
      workspaceId,
      Array.from({ length: 9 }, (_, i) => `2026-01-01 00:00:0${i}+00`),
    );
    const seen: string[] = [];
    const first = await agentsService.listAgents(owner, { limit: 4 });
    seen.push(...first.items.map((agent) => agent.id));
    let cursor = first.next_cursor;
    // Behind the cursor, between pages and after the end, while the walk runs.
    const inserts = Promise.all([
      seedAgents(workspaceId, ["2025-12-31 00:00:00+00"]),
      seedAgents(workspaceId, ["2026-01-01 00:00:03.5+00"]),
      seedAgents(workspaceId, ["2026-01-01 00:00:06.5+00"]),
      newAgent(agentsService, owner),
    ]);
    while (cursor) {
      const page = await agentsService.listAgents(owner, { limit: 4, cursor });
      seen.push(...page.items.map((agent) => agent.id));
      cursor = page.next_cursor;
    }
    await inserts;
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of before) {
      expect(seen.filter((one) => one === id)).toHaveLength(1);
    }
  });

  test("a cursor only positions: another workspace's cursor shows nothing of that workspace, and a forged one is refused", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const me = await person(mine, "owner");
    const them = await person(theirs, "owner");
    const member = await person(theirs, "member");
    const agentsService = service();
    await seedAgents(mine, ["2026-01-01 00:00:00+00"]);
    const theirIds = await seedAgents(theirs, [
      "2026-01-01 00:00:00+00",
      "2026-01-01 00:00:01+00",
      "2026-01-01 00:00:02+00",
    ]);
    const theirCursor = (await agentsService.listAgents(them, { limit: 1 }))
      .next_cursor;
    expect(theirCursor).not.toBeNull();
    const page = await agentsService.listAgents(me, {
      limit: 50,
      cursor: theirCursor ?? "",
    });
    expect(page.items.some((agent) => theirIds.includes(agent.id))).toBe(false);
    expect(page.items.every((agent) => agent.workspace_id === mine)).toBe(true);

    // A member reads their own workspace's agents with it, and no other's.
    const members = await agentsService.listAgents(member, {
      limit: 50,
      cursor: theirCursor ?? "",
    });
    expect(members.items.every((agent) => agent.workspace_id === theirs)).toBe(
      true,
    );

    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const forged of [
      "not-a-cursor",
      encode({ created_at: "2026-01-01", id: randomUUID() }),
      encode({ created_at: "2026-13-01 00:00:00+00", id: randomUUID() }),
      encode({ created_at: "2026-01-01 00:00:00+00", id: "x" }),
    ]) {
      const refused = await agentsService
        .listAgents(them, { limit: 1, cursor: forged })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused, forged).toBeInstanceOf(InvalidCursorError);
    }
  });

  test("q keeps names or slugs containing it, ids keeps those named, and both page by the same cursor", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const ids = await seedAgents(
      workspaceId,
      Array.from({ length: 5 }, (_, i) => `2026-01-0${i + 1} 00:00:00+00`),
    );
    const [first = "", second = "", third = "", fourth = "", fifth = ""] = ids;
    await db
      .update(agents)
      .set({ name: "Release Notes" })
      .where(eq(agents.id, first));
    await db
      .update(agents)
      .set({ name: "100% notes_bot" })
      .where(eq(agents.id, second));
    const [other = ""] = await seedAgents(await workspace(), [
      "2026-01-01 00:00:00+00",
    ]);
    const listed = async (query: ListAgentsQuery): Promise<string[]> =>
      (await agentsService.listAgents(owner, query)).items.map(
        (agent) => agent.id,
      );

    expect(await listed({ limit: 50, q: "NOTES" })).toEqual([first, second]);
    // Slugs are seed-<id>, so part of an id finds that agent alone.
    expect(await listed({ limit: 50, q: third.slice(0, 13) })).toEqual([third]);
    // Wildcards match themselves.
    expect(await listed({ limit: 50, q: "100%" })).toEqual([second]);
    expect(await listed({ limit: 50, q: "_bot" })).toEqual([second]);
    expect(await listed({ limit: 50, q: "%" })).toEqual([second]);

    expect(
      await listed({ limit: 50, ids: [fifth, first.toUpperCase(), other] }),
    ).toEqual([first, fifth]);
    const named = [first, fourth, fifth];
    const page = await agentsService.listAgents(owner, {
      limit: 1,
      ids: named,
    });
    expect(page.items.map((agent) => agent.id)).toEqual([first]);
    expect(
      await listed({ limit: 50, ids: named, cursor: page.next_cursor ?? "" }),
    ).toEqual([fourth, fifth]);
  });

  test("counts are the list read to its end and the agents the caller administers now, as /v1/administered-agents lists them", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const userId = owner.actor?.userId ?? "";
    const agentsService = service();
    const [direct, viaTeam, archivedTeam, removedFromTeam] = await seedAgents(
      workspaceId,
      Array.from({ length: 6 }, () => "2026-01-01 00:00:00+00"),
    );
    await seedAgents(await workspace(), ["2026-01-01 00:00:00+00"]);
    await db.insert(agentAdmins).values({
      workspaceId,
      agentId: direct ?? "",
      userId,
    });
    async function team(
      agentIds: (string | undefined)[],
      state: { archived?: boolean; removed?: boolean } = {},
    ) {
      const teamId = randomUUID();
      await db.insert(memberTeams).values({
        id: teamId,
        workspaceId,
        name: `team-${teamId.slice(0, 8)}`,
        archivedAt: state.archived ? new Date() : null,
      });
      await db.insert(memberTeamMembers).values({
        id: randomUUID(),
        workspaceId,
        teamId,
        userId,
        removedAt: state.removed ? new Date() : null,
      });
      for (const agentId of agentIds) {
        await db
          .insert(agentAdminTeams)
          .values({ workspaceId, agentId: agentId ?? "", teamId });
      }
    }
    await team([viaTeam, direct]);
    await team([archivedTeam], { archived: true });
    await team([removedFromTeam], { removed: true });

    // Seeded agents have no release: drafts, until one is archived.
    expect(await agentsService.countAgents(owner)).toEqual({
      counts: { all: 6, administered: 2, active: 0, draft: 6 },
    });
    await db
      .update(agents)
      .set({ status: "archived" })
      .where(eq(agents.id, removedFromTeam ?? ""));
    expect(await agentsService.countAgents(owner)).toEqual({
      counts: { all: 6, administered: 2, active: 0, draft: 5 },
    });
    const listed = await createPostgresAgentAdminStore(db).listAdministered(
      workspaceId,
      userId,
      200,
    );
    expect(listed.map((agent) => agent.id).sort()).toEqual(
      [direct ?? "", viaTeam ?? ""].sort(),
    );

    // A disabled member administers nothing, as the admin list says.
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, userId));
    // A disabled member reads no agent either.
    expect(
      await createPostgresAgentStore(db).count(workspaceId, {
        userId,
        outsideAccess: "use",
      }),
    ).toEqual({ all: 0, administered: 0, active: 0, draft: 0 });

    // A member outside every agent counts what they find in the list.
    const member = await person(workspaceId, "member");
    expect(await agentsService.countAgents(member)).toEqual({
      counts: { all: 6, administered: 0, active: 0, draft: 5 },
    });
    expect(
      await codeOf(agentsService.countAgents(serviceKey(workspaceId))),
    ).toBe("FORBIDDEN");
  });

  test("a page's summaries say what reading each agent, its admins and bindings one by one says", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const userId = owner.actor?.userId ?? "";
    const agentsService = service();

    // A draft with a newer draft, asking for two names, one bound live.
    const longest = `${"a".repeat(299)}😀b`;
    const draft = await newAgent(agentsService, owner, {
      ...cardWith("v1"),
      capabilities: {
        ...cardWith("v1").capabilities,
        credential_refs: ["github", "slack"],
      },
    });
    await agentsService.updateAgent(owner, draft.agent.id, {
      card: {
        ...cardWith(longest),
        capabilities: {
          ...cardWith(longest).capabilities,
          credential_refs: ["github", "slack"],
        },
      },
    });
    await db.insert(credentialBindings).values([
      {
        id: randomUUID(),
        workspaceId,
        credentialRef: "github",
        target: "agent",
        targetId: draft.agent.id,
        boundBy: userId,
      },
      {
        id: randomUUID(),
        workspaceId,
        credentialRef: "slack",
        target: "agent",
        targetId: draft.agent.id,
        boundBy: userId,
        revokedAt: new Date(),
      },
    ]);
    // Its creator administers it already; a team is added.
    const teamId = randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: "재무팀" });
    await db
      .insert(agentAdminTeams)
      .values({ workspaceId, agentId: draft.agent.id, teamId });

    // Released at v1, then edited: people still talk to v1.
    const released = await newAgent(agentsService, owner);
    const v1 = released.versions[0];
    if (!v1) throw new Error("no version 1");
    const release = await agentsService.createRelease(
      owner,
      released.agent.id,
      { version_id: v1.id, connection_id: TEST_CONNECTION_ID },
    );
    await agentsService.activateAgent(owner, released.agent.id, {
      release_id: release.release.id,
      expected_revision: -1,
    });
    await agentsService.updateAgent(owner, released.agent.id, {
      card: cardWith("v2"),
    });
    await newAgent(agentsService, await person(await workspace(), "owner"));

    const page = await agentsService.listAgents(owner, {
      ...PAGE,
      include: "summary",
    });
    expect(page.items.map((agent) => agent.id)).toEqual([
      draft.agent.id,
      released.agent.id,
    ]);
    expect(page.items.map((agent) => agent.summary)).toEqual([
      {
        version: {
          version_no: 2,
          role: "재무 분석가",
          instructions: "a".repeat(299),
          mcp_servers: [],
          credential_refs: ["github", "slack"],
        },
        connection_id: null,
        release_label: null,
        release_model: null,
        bound_credential_refs: ["github"],
        admins: ["owner", "재무팀"],
        needs_input_count: 0,
        running_count: 0,
        slack_action: null,
      },
      {
        version: {
          version_no: 1,
          role: "재무 분석가",
          instructions: "v1",
          mcp_servers: [],
          credential_refs: [],
        },
        connection_id: TEST_CONNECTION_ID,
        release_label: release.release.label,
        release_model: release.release.runtime_config_snapshot.model as string,
        bound_credential_refs: [],
        admins: ["owner"],
        needs_input_count: 0,
        running_count: 0,
        slack_action: null,
      },
    ]);
    // By the active release's connection: the draft has none, so only v1's
    // agent.
    const onConnection = async (connection_id: string) =>
      (
        await agentsService.listAgents(owner, { ...PAGE, connection_id })
      ).items.map((agent) => agent.id);
    expect(await onConnection(TEST_CONNECTION_ID)).toEqual([released.agent.id]);
    expect(await onConnection("analysis")).toEqual([]);
    // Without asking, the page is the agents as before.
    const plain = await agentsService.listAgents(owner, PAGE);
    expect(plain.items.map((agent) => Object.hasOwn(agent, "summary"))).toEqual(
      [false, false],
    );
    // Another workspace's agent is never summarised, even by id.
    const store = createPostgresAgentStore(db);
    const other = await workspace();
    const anyone = { userId: null, apiKeyId: null };
    expect(
      (await store.summaries(other, [draft.agent.id.toUpperCase()], anyone))
        .size,
    ).toBe(0);
    expect((await store.summaries(workspaceId, [], anyone)).size).toBe(0);
  });

  test("a summary names the Slack step its agent's tab asks for first, and none when nothing is left", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const newId = async () => (await newAgent(agentsService, owner)).agent.id;

    async function app(
      agentId: string,
      values: Partial<typeof slackApps.$inferInsert> = {},
    ) {
      const id = randomUUID();
      await db.insert(slackApps).values({
        id,
        workspaceId,
        kind: "agent",
        agentId,
        state: "created",
        appId: `A${id.slice(0, 8).toUpperCase()}`,
        clientId: `1.${id.slice(0, 8)}`,
        redirectUrl: "https://example.invalid/slack/callback",
        botTokenRef: `slack_app:${id}/slack_bot_token`,
        eventsState: "verified",
        eventsUrl: "https://example.invalid/slack/events",
        ...values,
      });
      return id;
    }
    async function identity(
      agentId: string,
      status: "active" | "revoked" = "active",
    ) {
      const installationId = randomUUID();
      await db.insert(slackInstallations).values({
        id: installationId,
        workspaceId,
        appId: `A${installationId.slice(0, 8).toUpperCase()}`,
        teamId: "T1",
      });
      await db.insert(agentIdentities).values({
        id: randomUUID(),
        workspaceId,
        agentId,
        provider: "slack_bot",
        installationId,
        externalPrincipalId: "U1",
        credentialRef: `slack_app:${installationId}/slack_bot_token`,
        status,
        ...(status === "revoked" ? { revokedAt: new Date() } : {}),
      });
      return installationId;
    }
    async function home(
      agentId: string,
      installationId: string,
      revokedAt: Date | null = null,
    ) {
      await db.insert(surfaceBindings).values({
        id: randomUUID(),
        workspaceId,
        agentId,
        surface: "slack",
        installationId,
        externalSurfaceId: `C${randomUUID().slice(0, 8)}`,
        surfaceKind: "public_channel",
        mode: "on",
        ceilingActions: [],
        ceilingDisclosure: "summary",
        home: true,
        ...(revokedAt ? { status: "revoked" as const, revokedAt } : {}),
      });
    }
    async function installed(agentId: string) {
      await home(agentId, await identity(agentId));
    }

    const none = await newId();
    const fine = await newId();
    await app(fine);
    await installed(fine);
    // Slack refused the Request URL, even with everything else in place.
    const failed = await newId();
    await app(failed, { eventsState: "failed" });
    await installed(failed);
    // Sent but not yet checked; before any was sent there is nothing to check.
    const unverified = await newId();
    await app(unverified, { eventsState: "pending" });
    await installed(unverified);
    const notSent = await newId();
    await app(notSent, { eventsState: "pending", eventsUrl: null });
    await installed(notSent);
    // Created, never installed: no bot token and no identity.
    const uninstalled = await newId();
    await app(uninstalled, { botTokenRef: null, eventsUrl: null });
    // A bot token whose identity was revoked (disconnected or uninstalled);
    // the events state it had while installed no longer shows in the tab.
    const reinstall = await newId();
    await app(reinstall, { eventsState: "failed" });
    await identity(reinstall, "revoked");
    // The tab asks for a home before the failed events row in Advanced.
    const failedHomeless = await newId();
    await app(failedHomeless, { eventsState: "failed" });
    await identity(failedHomeless);
    // An unverified URL locks the channels, home step included.
    const unverifiedHomeless = await newId();
    await app(unverifiedHomeless, { eventsState: "pending" });
    await identity(unverifiedHomeless);
    // Installed, and its only home binding was revoked.
    const homeless = await newId();
    await app(homeless);
    await home(homeless, await identity(homeless), new Date());
    // A deleted app is not the agent's app any more.
    const deleted = await newId();
    await app(deleted, { state: "deleted", eventsState: "failed" });

    const page = await agentsService.listAgents(owner, {
      ...PAGE,
      include: "summary",
    });
    const actions = new Map(
      page.items.map((agent) => [agent.id, agent.summary?.slack_action]),
    );
    expect(
      [
        none,
        fine,
        failed,
        unverified,
        notSent,
        uninstalled,
        reinstall,
        failedHomeless,
        unverifiedHomeless,
        homeless,
        deleted,
      ].map((id) => actions.get(id)),
    ).toEqual([
      null,
      null,
      "events_failed",
      "events_unverified",
      null,
      "install",
      "reinstall",
      "home_unset",
      "events_unverified",
      "home_unset",
      null,
    ]);
  });

  test("a card counts the agent's waiting and working sessions the caller can list, in a fixed number of statements", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const ownerId = owner.actor?.userId ?? "";
    const memberId = member.actor?.userId ?? "";
    const agentsService = service();

    async function activeAgent() {
      const created = await newAgent(agentsService, owner);
      const v1 = created.versions[0];
      if (!v1) throw new Error("no version 1");
      const { release } = await agentsService.createRelease(
        owner,
        created.agent.id,
        { version_id: v1.id, connection_id: TEST_CONNECTION_ID },
      );
      await agentsService.activateAgent(owner, created.agent.id, {
        release_id: release.id,
        expected_revision: -1,
      });
      return { agentId: created.agent.id, releaseId: release.id };
    }

    // A session of the release in a stored status; `asking` adds a request a
    // person can still answer, which GET /v1/sessions shows as needs_input.
    async function session(
      releaseId: string,
      options: {
        status: "running" | "idle" | "queued";
        creator: string;
        asking?: boolean;
        share?: "private";
      },
    ) {
      const sessionId = randomUUID();
      await db.insert(sessions).values({
        id: sessionId,
        ownerId: workspaceId,
        workspaceId,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        agentReleaseId: releaseId,
        status: options.status,
        createdByUserId: options.creator,
      });
      if (options.share)
        await db.insert(sessionShares).values({
          sessionId,
          ownerId: workspaceId,
          workspaceId,
          scope: options.share,
        });
      if (!options.asking) return sessionId;
      const attemptId = `att-${randomUUID()}`;
      await db.insert(attempts).values({
        id: attemptId,
        sessionId,
        executionId: `exec-${randomUUID()}`,
        leaseEpoch: 0,
        executionGeneration: 0,
        authRevision: 0,
        state: "running",
        leaseExpiresAt: new Date(Date.now() + 3_600_000),
      });
      const [turn] = await db
        .insert(turns)
        .values({
          sessionId,
          sequence: 1,
          message: "go",
          status: "running",
          attemptId,
          startedAt: new Date(),
        })
        .returning({ id: turns.id });
      if (!turn) throw new Error("no turn");
      await db.insert(pendingRequests).values({
        requestId: `req_${randomUUID()}`,
        sessionId,
        turnId: turn.id,
        attemptId,
        kind: "permission",
        payload: { kind: "permission", tool: "Bash", input: null },
        inputHash: "a".repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      return sessionId;
    }

    const busy = await activeAgent();
    const idle = await activeAgent();
    await session(busy.releaseId, {
      status: "running",
      creator: ownerId,
      asking: true,
    });
    await session(busy.releaseId, { status: "running", creator: ownerId });
    await session(busy.releaseId, { status: "running", creator: memberId });
    // The owner's private ones: the member cannot list them.
    await session(busy.releaseId, {
      status: "running",
      creator: ownerId,
      share: "private",
    });
    await session(busy.releaseId, {
      status: "running",
      creator: ownerId,
      asking: true,
      share: "private",
    });
    // Neither waiting nor working.
    await session(busy.releaseId, { status: "idle", creator: ownerId });
    await session(busy.releaseId, { status: "queued", creator: ownerId });

    const counts = (page: Awaited<ReturnType<AgentService["listAgents"]>>) =>
      page.items.map((agent) => [
        agent.id,
        agent.summary?.needs_input_count,
        agent.summary?.running_count,
      ]);
    expect(
      counts(
        await agentsService.listAgents(owner, { ...PAGE, include: "summary" }),
      ),
    ).toEqual([
      [busy.agentId, 2, 3],
      [idle.agentId, 0, 0],
    ]);

    // A member outside the agent gets its row without a card; as one of its
    // admins, the card.
    expect(
      counts(
        await agentsService.listAgents(member, { ...PAGE, include: "summary" }),
      ),
    ).toEqual([
      [busy.agentId, undefined, undefined],
      [idle.agentId, undefined, undefined],
    ]);
    await db
      .insert(agentAdmins)
      .values({ workspaceId, agentId: busy.agentId, userId: memberId });

    // What GET /v1/sessions?agent_id=&status= lists to each of them.
    const reader = createPostgresSessionReader(db);
    for (const [caller, viewer] of [
      [owner, { userId: ownerId, apiKeyId: null }],
      [member, { userId: memberId, apiKeyId: null }],
    ] as const) {
      const listed = async (status: "needs_input" | "running") =>
        (
          await reader.listSessions(
            workspaceId,
            { limit: 100, status, agent_id: busy.agentId },
            viewer,
          )
        ).items.length;
      const summary = (
        await createPostgresAgentStore(db).summaries(
          workspaceId,
          [busy.agentId],
          viewer,
        )
      ).get(busy.agentId);
      expect([summary?.needs_input_count, summary?.running_count]).toEqual([
        await listed("needs_input"),
        await listed("running"),
      ]);
      expect(caller.ownerId).toBe(workspaceId);
    }
    expect(
      (
        await createPostgresAgentStore(db).summaries(
          workspaceId,
          [busy.agentId],
          { userId: memberId, apiKeyId: null },
        )
      ).get(busy.agentId),
    ).toMatchObject({ needs_input_count: 1, running_count: 2 });

    // The same statements for one agent and for a page of many.
    const statements: string[] = [];
    const counting = drizzle(pool, {
      schema,
      logger: { logQuery: (query) => statements.push(query) },
    });
    const many = [busy.agentId, idle.agentId];
    for (let n = 0; n < 4; n += 1) many.push((await activeAgent()).agentId);
    const store = createPostgresAgentStore(counting);
    const viewer = { userId: ownerId, apiKeyId: null };
    await store.summaries(workspaceId, [busy.agentId], viewer);
    const one = statements.length;
    statements.length = 0;
    await store.summaries(workspaceId, many, viewer);
    expect(statements.length).toBe(one);
  });

  test("a description is the row's: set, changed and cleared without a version, and a card without a role still summarises", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const operations = async () =>
      (
        await db
          .select({ operation: receipts.operation })
          .from(receipts)
          .where(eq(receipts.ownerId, workspaceId))
          .orderBy(receipts.createdAt)
      ).map((row) => row.operation);

    const created = await agentsService.createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      description: "분기 보고서를 읽는다",
      managing_team_id: await liveTeam(workspaceId),
      card: cardWith("v1"),
    });
    expect(created.agent.description).toBe("분기 보고서를 읽는다");
    const id = created.agent.id;
    const before = await operations();

    const described = await agentsService.updateAgent(owner, id, {
      description: "이상치를 요약한다",
    });
    expect(described.agent.description).toBe("이상치를 요약한다");
    expect(described.versions).toEqual(created.versions);
    const same = await agentsService.updateAgent(owner, id, {
      description: "이상치를 요약한다",
    });
    expect(same.agent.updated_at).toBe(described.agent.updated_at);
    const cleared = await agentsService.updateAgent(owner, id, {
      description: null,
    });
    expect(cleared.agent.description).toBeNull();
    expect(cleared.versions).toEqual(created.versions);
    expect((await operations()).slice(before.length)).toEqual([
      "update_agent",
      "update_agent",
    ]);

    const {
      role: _role,
      instructions: _instructions,
      ...bare
    } = cardWith("v2");
    await db.insert(agentVersions).values({
      id: randomUUID(),
      agentId: id,
      versionNo: 2,
      card: bare,
      contentSha256: "2".repeat(64),
      createdBy: owner.actor?.userId ?? null,
    });
    const page = await agentsService.listAgents(owner, {
      ...PAGE,
      include: "summary",
    });
    const item = page.items.find((agent) => agent.id === id);
    expect(item?.description).toBeNull();
    expect(item?.summary?.version).toMatchObject({
      version_no: 2,
      role: null,
      instructions: null,
    });
    const detail = await agentsService.getAgent(owner, id);
    expect(detail.versions.at(-1)?.card.role).toBeUndefined();
  });

  test("an owner creates an agent, adds versions, releases and activates one", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();

    const created = await newAgent(agentsService, owner);
    expect(created.agent).toMatchObject({
      workspace_id: workspaceId,
      status: "active",
      active_release_id: null,
      activation_revision: -1,
      created_by: owner.actor?.userId,
    });
    expect(created.versions.map((version) => version.version_no)).toEqual([1]);
    const first = created.versions[0];
    if (!first) throw new Error("no version 1");

    const edited = await agentsService.updateAgent(owner, created.agent.id, {
      name: "재무 분석가 2",
      card: cardWith("v2"),
    });
    expect(edited.agent.name).toBe("재무 분석가 2");
    expect(edited.versions.map((version) => version.version_no)).toEqual([
      1, 2,
    ]);
    expect(edited.versions[0]).toEqual(first);
    const again = await agentsService.updateAgent(owner, created.agent.id, {
      card: cardWith("v2"),
    });
    expect(again.versions).toHaveLength(2);

    const second = edited.versions[1];
    if (!second) throw new Error("no version 2");
    const released = await agentsService.createRelease(
      owner,
      created.agent.id,
      {
        version_id: second.id,
        connection_id: TEST_CONNECTION_ID,
      },
    );
    expect(released.created).toBe(true);
    expect(released.release).toMatchObject({
      agent_id: created.agent.id,
      version_id: second.id,
      card_sha256: second.content_sha256,
      effective_tools: { tools: ["Read", "Grep", "Edit", "Bash"], mcp: [] },
      created_by: owner.actor?.userId,
      approved_by: null,
      approved_at: null,
    });
    expect(JSON.stringify(released.release)).not.toContain(
      "catalog-provider-key",
    );
    const rereleased = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: second.id, connection_id: TEST_CONNECTION_ID },
    );
    expect(rereleased).toEqual({ release: released.release, created: false });

    const before = await agentsService.getAgent(owner, created.agent.id);
    expect(before.active_release).toBeNull();

    const activated = await agentsService.activateAgent(
      owner,
      created.agent.id,
      { release_id: released.release.id, expected_revision: -1 },
    );
    expect(activated).toMatchObject({
      active_release_id: released.release.id,
      previous_release_id: null,
      activation_revision: 0,
    });
    expect(activated.receipt_id).not.toBeNull();
    expect(
      await agentsService.activateAgent(owner, created.agent.id, {
        release_id: released.release.id,
        expected_revision: -1,
      }),
    ).toEqual({
      active_release_id: released.release.id,
      previous_release_id: null,
      activation_revision: 0,
      receipt_id: null,
    });

    const detail = await agentsService.getAgent(owner, created.agent.id);
    expect(detail.agent.active_release_id).toBe(released.release.id);
    expect(detail.active_release?.approved_by).toBe(owner.actor?.userId);
    expect(detail.releases).toHaveLength(1);
    const list = await agentsService.listAgents(owner, PAGE);
    expect(list.items.map((agent) => agent.id)).toEqual([created.agent.id]);
  });

  test("a release keeps the note it was first made with, outside its id", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner);
    const first = created.versions[0];
    if (!first) throw new Error("no version 1");

    const noted = await agentsService.createRelease(owner, created.agent.id, {
      version_id: first.id,
      connection_id: TEST_CONNECTION_ID,
      note: "첫 배포 🚀",
    });
    expect(noted.created).toBe(true);
    expect(noted.release.note).toBe("첫 배포 🚀");
    // Another note on the same content is the same release, note unchanged.
    const again = await agentsService.createRelease(owner, created.agent.id, {
      version_id: first.id,
      connection_id: TEST_CONNECTION_ID,
      note: "다른 메모",
    });
    expect(again).toEqual({ release: noted.release, created: false });
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: noted.release.id,
      expected_revision: -1,
    });
    const detail = await agentsService.getAgent(owner, created.agent.id);
    expect(detail.releases.map((release) => release.note)).toEqual([
      "첫 배포 🚀",
    ]);
    expect(detail.active_release?.note).toBe("첫 배포 🚀");

    // A release made without a note is not given one by a later re-release.
    const edited = await agentsService.updateAgent(owner, created.agent.id, {
      card: cardWith("v2"),
    });
    const second = edited.versions[1];
    if (!second) throw new Error("no version 2");
    const bare = await agentsService.createRelease(owner, created.agent.id, {
      version_id: second.id,
      connection_id: TEST_CONNECTION_ID,
    });
    expect(bare.release.note).toBeNull();
    const late = await agentsService.createRelease(owner, created.agent.id, {
      version_id: second.id,
      connection_id: TEST_CONNECTION_ID,
      note: "late",
    });
    expect(late).toEqual({ release: bare.release, created: false });

    // A row is never updated, so its note cannot be changed afterwards.
    const edit = await db
      .update(agentReleases)
      .set({ note: "edited" })
      .where(eq(agentReleases.id, bare.release.id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((edit as { cause?: Error } | null)?.cause?.message).toContain(
      "insert-only",
    );
    // The column counts characters as the API does, and refuses an empty one.
    const insertNote = (note: string) =>
      db.execute(sql`
        INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
          connection_id, spec_source, spec_source_digest, runtime_spec,
          spec_digest, runtime_config_snapshot, effective_tools, policy_pins,
          note)
        SELECT ${`rel-${randomUUID()}`}, agent_id, version_id, card_sha256,
          connection_id, spec_source, spec_source_digest, runtime_spec,
          spec_digest, runtime_config_snapshot, effective_tools, policy_pins,
          ${note}
        FROM agent_releases WHERE id = ${bare.release.id}`);
    await insertNote("🚀".repeat(200));
    for (const note of ["", "a".repeat(201)]) {
      const refused = await insertNote(note).then(
        () => null,
        (error: unknown) => error,
      );
      expect(
        (refused as { cause?: { constraint?: string } } | null)?.cause
          ?.constraint,
      ).toBe("agent_releases_note_check");
    }
  });

  test("release creation and activation are separate audit rows with their own actors", async () => {
    const workspaceId = await workspace();
    const author = await person(workspaceId, "owner");
    const approver = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, author);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const { release } = await agentsService.createRelease(
      author,
      created.agent.id,
      { version_id: version.id, connection_id: TEST_CONNECTION_ID },
    );

    let events = await db
      .select()
      .from(agentActivationEvents)
      .where(eq(agentActivationEvents.agentId, created.agent.id));
    expect(events.map((event) => event.kind)).toEqual(["release_created"]);
    const [stored] = await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.id, release.id));
    expect(stored?.approvedBy).toBeNull();

    await agentsService.activateAgent(approver, created.agent.id, {
      release_id: release.id,
      expected_revision: -1,
    });
    events = await db
      .select()
      .from(agentActivationEvents)
      .where(eq(agentActivationEvents.agentId, created.agent.id))
      .orderBy(asc(agentActivationEvents.createdAt));
    expect(
      events.map((event) => ({
        kind: event.kind,
        actor: event.actorUserId,
        release: event.releaseId,
        revision: event.activationRevision,
      })),
    ).toEqual([
      {
        kind: "release_created",
        actor: author.actor?.userId as string,
        release: release.id,
        revision: null,
      },
      {
        kind: "activated",
        actor: approver.actor?.userId as string,
        release: release.id,
        revision: 0,
      },
    ]);
    const [approved] = await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.id, release.id));
    expect(approved?.approvedBy).toBe(approver.actor?.userId as string);
    expect(approved?.createdBy).toBe(author.actor?.userId as string);

    for (const event of events) {
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, event.receiptId));
      expect(receipt?.operation).toBe(
        event.kind === "activated" ? "activate_agent" : "create_agent_release",
      );
      expect(receipt?.actor).toEqual({
        principal: { kind: "user", id: event.actorUserId },
        actor_user_id: event.actorUserId,
        agent_id: null,
      });
      expect(receipt?.targetRef).toEqual({
        resource: { kind: "agent", id: created.agent.id },
        workspace_id: workspaceId,
      });
    }
  });

  test("a release is labelled by the Seoul second it was made, a tie numbered, and says when it went live and was replaced", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("l1"));
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version");
    const v2 = (
      await agentsService.updateAgent(owner, created.agent.id, {
        card: cardWith("l2"),
      })
    ).versions[1];
    if (!v2) throw new Error("no version 2");
    const first = await agentsService.createRelease(owner, created.agent.id, {
      version_id: v1.id,
      connection_id: TEST_CONNECTION_ID,
    });
    expect(first.release.label).toMatch(
      /^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2}$/,
    );
    expect(first.release).toMatchObject({
      activated_at: null,
      deactivated_at: null,
    });
    const { release: second } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v2.id, connection_id: TEST_CONNECTION_ID },
    );

    // Live, then replaced, then live again: the last activation counts.
    for (const [release, expected] of [
      [first.release, -1],
      [second, 0],
      [first.release, 1],
    ] as const) {
      await agentsService.activateAgent(owner, created.agent.id, {
        release_id: release.id,
        expected_revision: expected,
      });
    }
    const events = await db
      .select({
        at: agentActivationEvents.createdAt,
        revision: agentActivationEvents.activationRevision,
      })
      .from(agentActivationEvents)
      .where(
        and(
          eq(agentActivationEvents.agentId, created.agent.id),
          eq(agentActivationEvents.kind, "activated"),
        ),
      )
      .orderBy(asc(agentActivationEvents.activationRevision));
    const at = events.map((event) => event.at.toISOString());
    expect(at).toHaveLength(3);

    // Rows copied in at fixed instants, two in the same Seoul second.
    const copyAt = async (createdAt: string) => {
      const id = `rel-${randomUUID()}`;
      await db.execute(sql`
        INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
          connection_id, spec_source, spec_source_digest, runtime_spec,
          spec_digest, runtime_config_snapshot, effective_tools, policy_pins,
          created_at)
        SELECT ${id}, agent_id, version_id, card_sha256,
          connection_id, spec_source, spec_source_digest, runtime_spec,
          spec_digest, runtime_config_snapshot, effective_tools, policy_pins,
          ${createdAt}::timestamptz
        FROM agent_releases WHERE id = ${second.id}`);
      return id;
    };
    const tieA = await copyAt("2026-10-30T05:30:28.900Z");
    const tieB = await copyAt("2026-10-30T05:30:28.100Z");
    const nextDay = await copyAt("2026-10-30T15:00:00.000Z");

    const detail = await agentsService.getAgent(owner, created.agent.id);
    const byId = new Map(
      detail.releases.map((release) => [release.id, release]),
    );
    expect(byId.get(tieB)?.label).toBe("2026-10-30_14:30:28");
    expect(byId.get(tieA)?.label).toBe("2026-10-30_14:30:28-2");
    expect(byId.get(nextDay)?.label).toBe("2026-10-31_00:00:00");
    expect(byId.get(first.release.id)).toMatchObject({
      label: first.release.label,
      activated_at: at[2],
      deactivated_at: null,
    });
    expect(byId.get(second.id)).toMatchObject({
      activated_at: at[1],
      deactivated_at: at[2],
    });
    expect(byId.get(tieA)).toMatchObject({
      activated_at: null,
      deactivated_at: null,
    });
    expect(detail.active_release).toEqual(byId.get(first.release.id) ?? null);
    // A re-release answers with the release as it reads now.
    const again = await agentsService.createRelease(owner, created.agent.id, {
      version_id: v1.id,
      connection_id: TEST_CONNECTION_ID,
    });
    const read = byId.get(first.release.id);
    if (!read) throw new Error("first release not read");
    expect(again).toEqual({ release: read, created: false });

    const summary = (
      await createPostgresAgentStore(db).summaries(
        workspaceId,
        [created.agent.id],
        { userId: owner.actor?.userId ?? "", apiKeyId: null },
      )
    ).get(created.agent.id);
    expect(summary?.release_label).toBe(first.release.label);
  });

  test("releases made at the same time answer with the distinct labels they keep", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("t0"));
    const versionIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const detail = await agentsService.updateAgent(owner, created.agent.id, {
        card: cardWith(`t${index + 1}`),
      });
      const version = detail.versions.at(-1);
      if (!version) throw new Error("no version");
      versionIds.push(version.id);
    }
    const made = await Promise.all(
      versionIds.map((versionId) =>
        agentsService.createRelease(owner, created.agent.id, {
          version_id: versionId,
          connection_id: TEST_CONNECTION_ID,
        }),
      ),
    );
    const detail = await agentsService.getAgent(owner, created.agent.id);
    const labels = new Map(
      detail.releases.map((release) => [release.id, release.label]),
    );
    for (const { release } of made) {
      expect(release.label).toBe(labels.get(release.id) ?? "");
    }
    expect(new Set(made.map(({ release }) => release.label)).size).toBe(6);
  });

  test("of ten concurrent activations one wins and nine see REVISION_CONFLICT", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("c0"));
    const releaseIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const detail = await agentsService.updateAgent(owner, created.agent.id, {
        card: cardWith(`c${index + 1}`),
      });
      const version = detail.versions.at(-1);
      if (!version) throw new Error("no version");
      const { release } = await agentsService.createRelease(
        owner,
        created.agent.id,
        { version_id: version.id, connection_id: TEST_CONNECTION_ID },
      );
      releaseIds.push(release.id);
    }
    expect(new Set(releaseIds).size).toBe(10);

    const outcomes = await Promise.all(
      releaseIds.map((releaseId) =>
        codeOf(
          agentsService.activateAgent(owner, created.agent.id, {
            release_id: releaseId,
            expected_revision: -1,
          }),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome === "REVISION_CONFLICT"),
    ).toHaveLength(9);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.agent.id));
    expect(agent?.activationRevision).toBe(0);
    const winner = releaseIds[outcomes.indexOf("ok")];
    expect(agent?.activeReleaseId).toBe(winner as string);
    const activated = await db
      .select()
      .from(agentActivationEvents)
      .where(eq(agentActivationEvents.agentId, created.agent.id));
    expect(activated.filter((row) => row.kind === "activated")).toHaveLength(1);

    const next = releaseIds.find((id) => id !== winner) as string;
    expect(
      await agentsService.activateAgent(owner, created.agent.id, {
        release_id: next,
        expected_revision: 0,
      }),
    ).toMatchObject({
      active_release_id: next,
      previous_release_id: winner,
      activation_revision: 1,
    });
  });

  test("a release refuses to resolve once its connection or its model is gone", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const created = await newAgent(service(), owner);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const { release } = await service().createRelease(owner, created.agent.id, {
      version_id: version.id,
      connection_id: TEST_CONNECTION_ID,
    });

    for (const catalog of [
      { ...CATALOG, connections: {} },
      testSessionCatalog({ models: ["claude-other"], repositories: {} }),
    ]) {
      const edited = service(catalog);
      expect(await codeOf(edited.resolveRelease(workspaceId, release.id))).toBe(
        "RELEASE_SPEC_UNAVAILABLE",
      );
      expect(
        await codeOf(
          edited.activateAgent(owner, created.agent.id, {
            release_id: release.id,
            expected_revision: -1,
          }),
        ),
      ).toBe("RELEASE_SPEC_UNAVAILABLE");
    }
    expect((await service().resolveRelease(workspaceId, release.id)).id).toBe(
      release.id,
    );
  });

  test("an agent id in upper case releases and activates the same release", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const created = await newAgent(service(), owner);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const upper = created.agent.id.toUpperCase();
    const { release } = await service().createRelease(owner, upper, {
      version_id: version.id,
      connection_id: TEST_CONNECTION_ID,
    });
    const lower = await service().createRelease(owner, created.agent.id, {
      version_id: version.id,
      connection_id: TEST_CONNECTION_ID,
    });
    expect(lower).toEqual({ release, created: false });
    const activated = await service().activateAgent(owner, upper, {
      release_id: release.id,
      expected_revision: -1,
    });
    expect(activated.active_release_id).toBe(release.id);
  });

  test("a card asking for more than the runtime installs is released on the runtime's tools; an unknown connection is not", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const created = await newAgent(
      service(),
      owner,
      cardWith("wide", ["Read", "WebFetch"]),
    );
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const made = await service().createRelease(owner, created.agent.id, {
      version_id: version.id,
      connection_id: TEST_CONNECTION_ID,
    });
    expect(made.release.effective_tools.tools).not.toContain("WebFetch");
    expect(
      await codeOf(
        service().createRelease(owner, created.agent.id, {
          version_id: version.id,
          connection_id: "missing",
        }),
      ),
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      await codeOf(
        service().createRelease(owner, created.agent.id, {
          version_id: version.id,
          connection_id: "missing",
        }),
      ),
    ).toBe("UNSUPPORTED_CAPABILITY");
  });

  test("another agent's version or release is not found, and the database refuses the pairing too", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const a = await newAgent(agentsService, owner, cardWith("a"));
    const b = await newAgent(agentsService, owner, cardWith("b"));
    const versionOfB = b.versions[0];
    if (!versionOfB) throw new Error("no version");
    expect(
      await codeOf(
        agentsService.createRelease(owner, a.agent.id, {
          version_id: versionOfB.id,
          connection_id: TEST_CONNECTION_ID,
        }),
      ),
    ).toBe("NOT_FOUND");
    const { release: releaseOfB } = await agentsService.createRelease(
      owner,
      b.agent.id,
      { version_id: versionOfB.id, connection_id: TEST_CONNECTION_ID },
    );
    expect(
      await codeOf(
        agentsService.activateAgent(owner, a.agent.id, {
          release_id: releaseOfB.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("NOT_FOUND");

    expect(
      await refusal(
        db
          .update(agents)
          .set({ activeReleaseId: releaseOfB.id, activationRevision: 0 })
          .where(eq(agents.id, a.agent.id)),
      ),
    ).toMatch(/agents_active_release_fk/);
    expect(
      await refusal(
        db.insert(agentReleases).values({
          id: `sha256:${"0".repeat(64)}`,
          agentId: a.agent.id,
          versionId: versionOfB.id,
          cardSha256: versionOfB.content_sha256,
          connectionId: TEST_CONNECTION_ID,
          ...releaseSpecColumns(),
          runtimeConfigSnapshot: {},
          effectiveTools: { tools: [], mcp: [] },
        }),
      ),
    ).toMatch(/agent_releases_version_fk/);

    const elsewhere = await person(await workspace(), "owner");
    expect(await codeOf(agentsService.getAgent(elsewhere, a.agent.id))).toBe(
      "NOT_FOUND",
    );
    expect((await agentsService.listAgents(elsewhere, PAGE)).items).toEqual([]);
  });

  test("versions and releases cannot be rewritten in place", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const { release } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: version.id, connection_id: TEST_CONNECTION_ID },
    );
    expect(
      await refusal(
        db
          .update(agentVersions)
          .set({ card: cardWith("rewritten") })
          .where(eq(agentVersions.id, version.id)),
      ),
    ).toMatch(/insert-only/);
    expect(
      await refusal(
        db
          .update(agentReleases)
          .set({ effectiveTools: { tools: ["Bash"], mcp: [] } })
          .where(eq(agentReleases.id, release.id)),
      ),
    ).toMatch(/insert-only/);
    expect(
      await refusal(
        db.delete(agentReleases).where(eq(agentReleases.id, release.id)),
      ),
    ).toMatch(/insert-only/);
  });

  test("a session keeps the release it was pinned to when the agent is activated anew", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("p1"));
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version");
    const { release: r1 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v1.id, connection_id: TEST_CONNECTION_ID },
    );
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r1.id,
      expected_revision: -1,
    });
    // Pinning happens at session creation (94S-157); the row is what it pins.
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      agentReleaseId: r1.id,
    });
    expect(
      await refusal(
        db.insert(sessions).values({
          id: randomUUID(),
          ownerId: workspaceId,
          repoUrl: "https://example.invalid/app.git",
          branch: "main",
          agentReleaseId: "sha256:nowhere",
        }),
      ),
    ).toMatch(/sessions_agent_release_id_agent_releases_id_fk/);

    const v2 = (
      await agentsService.updateAgent(owner, created.agent.id, {
        card: cardWith("p2"),
      })
    ).versions[1];
    if (!v2) throw new Error("no version 2");
    const { release: r2 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v2.id, connection_id: TEST_CONNECTION_ID },
    );
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r2.id,
      expected_revision: 0,
    });
    const [session] = await db
      .select({ agentReleaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.agentReleaseId).toBe(r1.id);
  });

  test("a policy change is a new release; a pinned session keeps the policy it started with", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    // Only MCP entries still decide the release; built-in ones are not read.
    const withPolicy = (search: "ask" | "deny") =>
      agentCardRequestSchema.parse({
        ...cardWith("policy", ["Read", "Bash"]),
        capabilities: {
          tools: ["Read", "Bash"],
          mcp: null,
          forbidden: [],
          tool_policy: { per_tool: { mcp__docs__search: search } },
        },
      });
    const created = await newAgent(agentsService, owner, withPolicy("ask"));
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version");
    const { release: r1 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v1.id, connection_id: TEST_CONNECTION_ID },
    );
    expect(r1.policy_pins).toEqual({
      tools: {
        default: { builtin: "allow", mcp: "ask" },
        per_tool: {
          Read: "allow",
          Grep: "allow",
          Edit: "allow",
          Bash: "allow",
          mcp__docs__search: "ask",
        },
      },
    });
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r1.id,
      expected_revision: -1,
    });
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      agentReleaseId: r1.id,
    });

    const updated = await agentsService.updateAgent(owner, created.agent.id, {
      card: withPolicy("deny"),
    });
    const v2 = updated.versions[1];
    if (!v2) throw new Error("a policy change did not make a version");
    const { release: r2 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v2.id, connection_id: TEST_CONNECTION_ID },
    );
    expect(r2.id).not.toBe(r1.id);
    expect(r2.policy_pins.tools?.per_tool.mcp__docs__search).toBe("deny");
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r2.id,
      expected_revision: 0,
    });

    const [session] = await db
      .select({ agentReleaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.agentReleaseId).toBe(r1.id);
    const pinned = await agentsService.resolveRelease(
      workspaceId,
      session?.agentReleaseId ?? "",
    );
    expect(pinned.policy_pins.tools?.per_tool.mcp__docs__search).toBe("ask");
  });

  test("a release stored before tool policies still reads, verifies and activates", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("legacy"));
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version");
    const resolved = resolveReleaseContent(v1.card, TEST_RUN);
    if (!resolved.ok) throw new Error(resolved.error.message);
    // What 94S-154 wrote: the same content with the `{}` placeholder.
    const identity = {
      ...resolved.content,
      agent_id: created.agent.id,
      card_sha256: cardContentSha256(v1.card),
      repository_id: null,
      policy_pins: {},
    };
    const legacyId = deriveReleaseId(identity);
    await db.insert(agentReleases).values({
      id: legacyId,
      agentId: identity.agent_id,
      versionId: v1.id,
      cardSha256: identity.card_sha256,
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: identity.runtime_config_snapshot,
      effectiveTools: identity.effective_tools,
      policyPins: {},
      createdBy: owner.actor?.userId ?? null,
    });

    const detail = await agentsService.getAgent(owner, created.agent.id);
    expect(detail.releases.map((release) => release.policy_pins)).toEqual([{}]);
    expect(
      (await agentsService.resolveRelease(workspaceId, legacyId)).policy_pins,
    ).toEqual({});
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: legacyId,
      expected_revision: -1,
    });
    // Releasing the same version now pins a policy, so it is another release.
    const { release } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v1.id, connection_id: TEST_CONNECTION_ID },
    );
    expect(release.id).not.toBe(legacyId);
    expect(release.policy_pins.tools?.per_tool).toEqual({
      Read: "allow",
      Grep: "allow",
      Edit: "allow",
      Bash: "allow",
    });
  });

  test("a card stored with a tone reads without it and its release still verifies", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("v1"));
    // What a card written before 94S-761 holds, hashed tone included.
    const storedCard = { ...cardWith("with tone"), tone: "공손하게" };
    const storedSha = cardContentSha256(storedCard as AgentCard);
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId: created.agent.id,
      versionNo: 2,
      card: storedCard,
      contentSha256: storedSha,
      createdBy: owner.actor?.userId ?? null,
    });

    // And the release made from it then, stored as a row.
    const resolved = resolveReleaseContent(storedCard as AgentCard, TEST_RUN);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const identity = {
      ...resolved.content,
      agent_id: created.agent.id,
      card_sha256: storedSha,
      repository_id: null,
    };
    const legacyId = deriveReleaseId(identity);
    await db.insert(agentReleases).values({
      id: legacyId,
      agentId: identity.agent_id,
      versionId,
      cardSha256: identity.card_sha256,
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: identity.runtime_config_snapshot,
      effectiveTools: identity.effective_tools,
      policyPins: identity.policy_pins,
      createdBy: owner.actor?.userId ?? null,
    });

    const detail = await agentsService.getAgent(owner, created.agent.id);
    const v2 = detail.versions.find((version) => version.id === versionId);
    expect(v2?.card).toEqual(cardWith("with tone"));
    expect(v2?.content_sha256).toBe(storedSha);
    expect(detail.releases.map((release) => release.id)).toEqual([legacyId]);
    expect((await agentsService.resolveRelease(workspaceId, legacyId)).id).toBe(
      legacyId,
    );
    // Releasing the version again derives the stored id from the stored hash.
    const again = await agentsService.createRelease(owner, created.agent.id, {
      version_id: versionId,
      connection_id: TEST_CONNECTION_ID,
    });
    expect(again).toMatchObject({ created: false, release: { id: legacyId } });
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: legacyId,
      expected_revision: -1,
    });
  });

  test("a card stored with the retired tool fields reads without them and its release still verifies", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("v1"));
    const base = cardWith("with tools");
    const storedCard = {
      ...base,
      capabilities: {
        ...base.capabilities,
        tools: ["Read", "Grep"],
        forbidden: ["Bash"],
        tool_policy: {
          default: { builtin: "ask", mcp: "ask" },
          per_tool: { Read: "allow" },
        },
      },
    };
    const storedSha = cardContentSha256(storedCard as unknown as AgentCard);
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId: created.agent.id,
      versionNo: 2,
      card: storedCard,
      contentSha256: storedSha,
      createdBy: owner.actor?.userId ?? null,
    });

    const resolved = resolveReleaseContent(
      storedCard as unknown as AgentCard,
      TEST_RUN,
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    const identity = {
      ...resolved.content,
      agent_id: created.agent.id,
      card_sha256: storedSha,
      repository_id: null,
    };
    const storedId = deriveReleaseId(identity);
    await db.insert(agentReleases).values({
      id: storedId,
      agentId: identity.agent_id,
      versionId,
      cardSha256: identity.card_sha256,
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: identity.runtime_config_snapshot,
      effectiveTools: identity.effective_tools,
      policyPins: identity.policy_pins,
      createdBy: owner.actor?.userId ?? null,
    });

    const detail = await agentsService.getAgent(owner, created.agent.id);
    const stored = detail.versions.find((version) => version.id === versionId);
    expect(stored?.card.capabilities).toEqual(base.capabilities);
    expect(stored?.content_sha256).toBe(storedSha);
    expect(detail.releases.map((release) => release.id)).toEqual([storedId]);
    await expect(agentsService.listAgents(owner, PAGE)).resolves.toBeDefined();
    const again = await agentsService.createRelease(owner, created.agent.id, {
      version_id: versionId,
      connection_id: TEST_CONNECTION_ID,
    });
    expect(again).toMatchObject({ created: false, release: { id: storedId } });
  });

  test("members and API keys cannot manage agents; a slug is taken once", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const agentsService = service();
    const created = await newAgent(agentsService, owner);

    // A member outside the agent finds it, and reads nothing behind it.
    expect(
      (await agentsService.listAgents(member, PAGE)).items.map((a) => a.id),
    ).toEqual([created.agent.id]);
    expect(
      await codeOf(agentsService.listAgents(serviceKey(workspaceId), PAGE)),
    ).toBe("FORBIDDEN");
    for (const caller of [member, serviceKey(workspaceId)]) {
      expect(
        await codeOf(agentsService.getAgent(caller, created.agent.id)),
      ).toBe("FORBIDDEN");
    }
    // Any member creates an agent (D3); no key does.
    expect(
      await codeOf(
        agentsService.createAgent(serviceKey(workspaceId), {
          slug: "by-someone-else",
          name: "x",
          managing_team_id: created.agent.managing_team_id ?? "",
          card: cardWith("x"),
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        agentsService.createAgent(owner, {
          slug: created.agent.slug,
          name: "duplicate",
          managing_team_id: created.agent.managing_team_id ?? "",
          card: cardWith("dup"),
        }),
      ),
    ).toBe("ALREADY_EXISTS");
  });

  test("an owner offboarded after the decision cannot write", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const store = createPostgresAgentStore(db);
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, owner.actor?.userId as string));
    expect(
      await store.create({
        principal: owner,
        workspaceId,
        slug: "late",
        name: "late",
        managingTeam: {
          id: await liveTeam(workspaceId),
          managerRoles: ["owner", "admin"],
        },
        card: cardWith("late"),
        contentSha256: "a".repeat(64),
        createdBy: owner.actor?.userId as string,
      }),
    ).toEqual({ outcome: "actor_inactive" });
  });
});
