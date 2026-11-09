import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentCardRequestSchema,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  type CatalogProfile,
  callerFor,
  createAgentAdminService,
  createAgentIdentityService,
  createAgentService,
  createAuthorizationPolicy,
  createCredentialBindingService,
  createSurfaceBindingService,
  type SessionCatalog,
  SessionServiceError,
  type TeamActor,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { insideAgent } from "./administers.ts";
import { createPostgresAgentAdminStore } from "./agent-admins.ts";
import { createDatabaseAgentAuthority } from "./agent-authority.ts";
import { createPostgresAgentGitHubStore } from "./agent-github.ts";
import { createPostgresAgentIdentityStore } from "./agent-identities.ts";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresCatalogRepositoryStore } from "./catalog-repositories.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresTeamStore } from "./member-teams.ts";
import { migrate } from "./migrate.ts";
import { lockSessionReach } from "./requester-locks.ts";
import * as schema from "./schema.ts";
import { agents, receipts } from "./schema.ts";
import { createPostgresSurfaceBindingStore } from "./surface-bindings.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  repository: "optional",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const CATALOG: SessionCatalog = withSeededInstallation({
  profiles: { coding: PROFILE },
  repositories: {},
});

const card = (instructions: string) =>
  agentCardRequestSchema.parse({
    role: "재무 분석가",
    instructions,
    model: "claude-sonnet-5",
    capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  });

// The code, and the reason when the error carries one.
const reasonOf = (error: SessionServiceError) => {
  const reason = (error.details as { reason_code?: string } | null)
    ?.reason_code;
  return reason ? `${error.code}:${reason}` : error.code;
};

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return reasonOf(error);
    throw error;
  }
  return "ok";
}

const MIGRATIONS = join(import.meta.dir, "../migrations");

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "managing-team-migrations-"));
  await mkdir(join(folder, "meta"));
  const journal: { entries: Array<{ tag: string }> } = JSON.parse(
    await readFile(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
  );
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`no migration ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag } of entries) {
    await copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  return folder;
}

integration("team roles and the managing team, expand", () => {
  test("rows from before keep their meaning, and the image from before still writes", async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "managing_team_expand_it",
    });
    const pool = new Pool({ connectionString: database.url, max: 2 });
    const db = drizzle(pool, { schema });
    const before = await migrationsThrough("0222_push_continuations");
    try {
      await migrate(db, { migrationsFolder: before });
      const ws = randomUUID();
      const user = randomUUID();
      const team = randomUUID();
      const agent = randomUUID();
      await pool.query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
        [ws, `ws-${ws.slice(0, 8)}`],
      );
      await pool.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'u')",
        [user, `${user}@example.invalid`],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
        [ws, user],
      );
      await pool.query(
        "INSERT INTO member_teams (id, workspace_id, name) VALUES ($1, $2, 't')",
        [team, ws],
      );
      await pool.query(
        "INSERT INTO member_team_members (id, workspace_id, team_id, user_id) VALUES ($1, $2, $3, $4)",
        [randomUUID(), ws, team, user],
      );
      await pool.query(
        "INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'a', 'a')",
        [agent, ws],
      );

      await migrate(db, { migrationsFolder: MIGRATIONS });
      expect(
        (await pool.query("SELECT role FROM member_team_members")).rows,
      ).toEqual([{ role: "member" }]);
      // 0243 gave the agent a managing team, so none is null any more.
      expect(
        (
          await pool.query(
            "SELECT t.name FROM agents a JOIN member_teams t ON t.id = a.managing_team_id",
          )
        ).rows,
      ).toEqual([{ name: "Unassigned agents" }]);

      // The previous image names neither column.
      await pool.query(
        "INSERT INTO member_team_members (id, workspace_id, team_id, user_id, removed_at) VALUES ($1, $2, $3, $4, now())",
        [randomUUID(), ws, team, user],
      );
      expect(
        (await pool.query("SELECT DISTINCT role FROM member_team_members"))
          .rows,
      ).toEqual([{ role: "member" }]);

      let refused = "accepted";
      await pool
        .query("UPDATE member_team_members SET role = 'owner'")
        .catch((error: Error) => {
          refused = error.message;
        });
      expect(refused).toContain("member_team_members_role_check");
      refused = "accepted";
      await pool
        .query("UPDATE agents SET managing_team_id = $1", [randomUUID()])
        .catch((error: Error) => {
          refused = error.message;
        });
      expect(refused).toContain("agents_managing_team_fk");
    } finally {
      await pool.end();
      await database.drop();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});

integration("0243 gives every agent a managing team", () => {
  test("agents without one go to a memberless holding team per workspace, and nothing is lost", async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "managing_team_backfill_it",
    });
    const pool = new Pool({ connectionString: database.url, max: 2 });
    const db = drizzle(pool, { schema });
    const before = await migrationsThrough("0242_agent_mcp_settings");
    const query = async (text: string, values: unknown[] = []) =>
      (await pool.query(text, values)).rows;
    const workspace = async (slug: string) => {
      const id = randomUUID();
      await query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $2)",
        [id, slug],
      );
      return id;
    };
    const team = async (ws: string, name: string, archived = false) => {
      const id = randomUUID();
      await query(
        `INSERT INTO member_teams (id, workspace_id, name, archived_at)
         VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)`,
        [id, ws, name, archived],
      );
      return id;
    };
    const agent = async (ws: string, slug: string, managing: string | null) => {
      const id = randomUUID();
      await query(
        "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, $3, $4)",
        [id, ws, slug, managing],
      );
      return id;
    };
    const adminTeam = (
      ws: string,
      agentId: string,
      teamId: string,
      at: string,
    ) =>
      query(
        "INSERT INTO agent_admin_teams (workspace_id, agent_id, team_id, created_at) VALUES ($1, $2, $3, $4)",
        [ws, agentId, teamId, at],
      );
    try {
      await migrate(db, { migrationsFolder: before });
      const ws = await workspace("backfill-a");
      const clean = await workspace("backfill-b");
      const older = await team(ws, "older");
      const newer = await team(ws, "newer");
      const gone = await team(ws, "gone", true);
      // A name that a holding team would take.
      await team(ws, "Unassigned agents");
      const kept = await agent(ws, "kept", newer);
      const viaAdminTeams = await agent(ws, "via", null);
      const onlyArchived = await agent(ws, "archived", null);
      const bare = await agent(ws, "bare", null);
      await adminTeam(ws, viaAdminTeams, newer, "2026-01-02T00:00:00Z");
      await adminTeam(ws, viaAdminTeams, older, "2026-01-01T00:00:00Z");
      await adminTeam(ws, onlyArchived, gone, "2026-01-01T00:00:00Z");
      const tidy = await agent(clean, "tidy", await team(clean, "t"));

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const teamOf = async (id: string) =>
        (
          await query(
            "SELECT a.managing_team_id AS id, t.name, t.created_by, t.archived_at FROM agents a JOIN member_teams t ON t.id = a.managing_team_id WHERE a.id = $1",
            [id],
          )
        )[0];
      expect((await teamOf(kept))?.id).toBe(newer);
      // An admin team is no evidence of which team owns the agent.
      const holding = await teamOf(bare);
      expect((await teamOf(viaAdminTeams))?.id).toBe(holding?.id);
      expect(older).not.toBe(holding?.id);
      expect(holding?.name).toStartWith("Unassigned agents (");
      expect(holding?.created_by).toBeNull();
      expect(holding?.archived_at).toBeNull();
      expect((await teamOf(onlyArchived))?.id).toBe(holding?.id);
      expect((await teamOf(tidy))?.name).toBe("t");
      // One holding team per workspace that needed it, with no members, and
      // none where every agent already had a team.
      expect(
        await query(
          "SELECT workspace_id FROM member_teams WHERE name LIKE 'Unassigned agents (%'",
        ),
      ).toEqual([{ workspace_id: ws }]);
      expect(
        await query(
          "SELECT count(*)::int AS n FROM member_team_members WHERE team_id = $1",
          [holding?.id],
        ),
      ).toEqual([{ n: 0 }]);
      // Only the holding team is flagged, so only its agents keep their
      // workspace sessions visible past axis B.
      expect(
        await query(
          "SELECT id FROM member_teams WHERE holds_unassigned = true",
        ),
      ).toEqual([{ id: holding?.id }]);
      // Admin links stay: nothing about who administers an agent changed.
      expect(
        await query(
          "SELECT agent_id, team_id FROM agent_admin_teams ORDER BY agent_id, team_id",
        ),
      ).toEqual(
        [
          { agent_id: viaAdminTeams, team_id: newer },
          { agent_id: viaAdminTeams, team_id: older },
          { agent_id: onlyArchived, team_id: gone },
        ].sort((a, b) =>
          a.agent_id === b.agent_id
            ? a.team_id.localeCompare(b.team_id)
            : a.agent_id.localeCompare(b.agent_id),
        ),
      );
      // No agent was deleted, and the column refuses null from here on.
      expect(await query("SELECT count(*)::int AS n FROM agents")).toEqual([
        { n: 5 },
      ]);
      await expect(
        query("UPDATE agents SET managing_team_id = NULL"),
      ).rejects.toThrow("managing_team_id");
    } finally {
      await pool.end();
      await database.drop();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});

integration("the managing team on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "managing_team_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const teams = () => createPostgresTeamStore(db);
  const admins = () => createPostgresAgentAdminStore(db);
  const authority = () => createDatabaseAgentAuthority(db);
  const service = (): AgentService =>
    createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: authority(),
      }),
      store: createPostgresAgentStore(db),
      catalog: CATALOG,
      credentials: createPostgresCredentialBindingStore(db),
    });

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(schema.memberships).values({ workspaceId, userId, role });
    return callerFor(
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
  }

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";
  const acting = (caller: Caller): TeamActor => ({
    principal: caller,
    workspaceId: caller.ownerId,
    userId: idOf(caller),
  });

  async function newTeam(by: Caller) {
    const result = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name: `team-${randomUUID()}`,
    });
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.team.id;
  }

  async function join(by: Caller, teamId: string, who: Caller, role?: "lead") {
    const write = { actor: acting(by), teamId, userId: idOf(who) };
    await teams().addMember({ ...write, receiptId: randomUUID() });
    if (role) {
      const set = await teams().setMemberRole({
        ...write,
        receiptId: randomUUID(),
        role,
      });
      if (set.outcome !== "changed") throw new Error(set.outcome);
    }
  }

  const setRole = (
    by: Caller,
    teamId: string,
    who: Caller,
    role: "lead" | "member",
  ) =>
    teams().setMemberRole({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(who),
      role,
    });

  const name = (by: Caller, agentId: string, teamId: string) =>
    admins().setManagingTeam({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      teamId,
      managerRoles: MANAGERS,
    });

  // An owner, the managing team's lead, a plain member of it, and a member
  // outside it, over one agent the team manages.
  async function cast() {
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "ws",
    });
    const owner = await person(workspaceId, "owner");
    const lead = await person(workspaceId, "member");
    const member = await person(workspaceId, "member");
    const outsider = await person(workspaceId, "member");
    const teamId = await newTeam(owner);
    await join(owner, teamId, lead, "lead");
    await join(owner, teamId, member);
    const created = await service().createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      card: card("v1"),
      managing_team_id: teamId,
    });
    return {
      workspaceId,
      owner,
      lead,
      member,
      outsider,
      teamId,
      agentId: created.agent.id,
      created,
    };
  }

  const isAdmin = (workspaceId: string, agentId: string, who: Caller) =>
    authority().isAdmin(workspaceId, agentId, idOf(who));

  async function inside(workspaceId: string, agentId: string, who: Caller) {
    const [row] = await db
      .select({ inside: insideAgent(db, workspaceId, idOf(who), agentId) })
      .from(sql`(SELECT 1) AS one`);
    return row?.inside;
  }

  test("the managing team's lead manages the agent; its members are inside it, the rest outside", async () => {
    const {
      workspaceId,
      owner,
      lead,
      member,
      outsider,
      teamId,
      agentId,
      created,
    } = await cast();
    expect(created.agent.managing_team_id).toBe(teamId);

    expect(await isAdmin(workspaceId, agentId, lead)).toBe(true);
    expect(await isAdmin(workspaceId, agentId, member)).toBe(false);
    expect(await isAdmin(workspaceId, agentId, outsider)).toBe(false);
    expect(await inside(workspaceId, agentId, owner)).toBe(true);
    expect(await inside(workspaceId, agentId, lead)).toBe(true);
    expect(await inside(workspaceId, agentId, member)).toBe(true);
    expect(await inside(workspaceId, agentId, outsider)).toBe(false);

    const agentsService = service();
    expect(
      await codeOf(agentsService.updateAgent(lead, agentId, { name: "lead" })),
    ).toBe("ok");
    expect(
      await codeOf(agentsService.updateAgent(member, agentId, { name: "x" })),
    ).toStartWith("FORBIDDEN");
    expect(
      (await admins().listAdministered(workspaceId, idOf(lead), 50)).map(
        (a) => a.id,
      ),
    ).toEqual([agentId]);

    // A lead stepped down, or out of the team, holds nothing through it.
    expect(await setRole(owner, teamId, lead, "member")).toMatchObject({
      outcome: "changed",
    });
    expect(await setRole(owner, teamId, lead, "member")).toMatchObject({
      outcome: "unchanged",
    });
    expect(await isAdmin(workspaceId, agentId, lead)).toBe(false);
    expect(await inside(workspaceId, agentId, lead)).toBe(true);
    expect(await setRole(owner, teamId, lead, "lead")).toMatchObject({
      outcome: "changed",
    });
    await teams().removeMember({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(lead),
    });
    expect(await isAdmin(workspaceId, agentId, lead)).toBe(false);
    expect(await inside(workspaceId, agentId, lead)).toBe(false);
    // Only a team manager sets roles, and only of a member.
    expect(await setRole(member, teamId, member, "lead")).toEqual({
      outcome: "actor_inactive",
    });
    expect(await setRole(owner, teamId, lead, "lead")).toEqual({
      outcome: "not_found",
    });

    expect(
      (
        await db
          .select({ operation: receipts.operation })
          .from(receipts)
          .where(eq(receipts.ownerId, workspaceId))
      )
        .map((r) => r.operation)
        .filter((op) => op === "set_team_member_role").length,
    ).toBe(3);
  });

  test("W, L and T read the agent's settings and O only its row; T changes nothing (agent-rbac R2)", async () => {
    const { owner, lead, member, outsider, agentId, teamId } = await cast();
    const policy = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: authority(),
    });
    const agentsService = service();
    const credentials = createCredentialBindingService({
      authorization: policy,
      store: createPostgresCredentialBindingStore(db),
    });
    const adminService = createAgentAdminService({
      authorization: policy,
      store: admins(),
    });
    const slack = createSurfaceBindingService({
      authorization: policy,
      store: createPostgresSurfaceBindingStore(db),
      channels: {
        kindOf: async () => {
          throw new Error("no Slack here");
        },
      },
    });
    const identities = createAgentIdentityService({
      authorization: policy,
      store: createPostgresAgentIdentityStore(db),
    });
    await credentials.bind(owner, agentId, { credential_ref: "github" });

    const reads = {
      list: async (who: Caller) =>
        (
          await agentsService.listAgents(who, {
            limit: 50,
            include: "summary",
          })
        ).items.map((agent) => ("summary" in agent ? "summary" : "row")),
      count: async (who: Caller) =>
        (await agentsService.countAgents(who)).counts,
      detail: (who: Caller) => agentsService.getAgent(who, agentId),
      credentials: (who: Caller) => credentials.list(who, agentId),
      admins: (who: Caller) => adminService.listAgentAdmins(who, agentId),
      slack: (who: Caller) => slack.listSlackBindings(who, agentId),
      identities: (who: Caller) => identities.listAgentIdentities(who, agentId),
    };
    const settings = [
      reads.detail,
      reads.credentials,
      reads.admins,
      reads.slack,
      reads.identities,
    ];
    for (const who of [owner, lead, member]) {
      expect(await reads.list(who)).toEqual(["summary"]);
      expect((await reads.count(who)).all).toBe(1);
      for (const read of settings) expect(await codeOf(read(who))).toBe("ok");
    }
    // O finds the agent's row, without its summary, and nothing behind it.
    expect(await reads.list(outsider)).toEqual(["row"]);
    expect(await reads.count(outsider)).toEqual({
      all: 1,
      administered: 0,
      active: 0,
      draft: 1,
    });
    const [team] = await db
      .select({ name: schema.memberTeams.name })
      .from(schema.memberTeams)
      .where(eq(schema.memberTeams.id, teamId));
    const [row] = (await agentsService.listAgents(outsider, { limit: 50 }))
      .items;
    expect(row?.managing_team_name).toBe(team?.name ?? "missing");
    for (const read of settings) {
      expect(await codeOf(read(outsider))).toBe("FORBIDDEN:role");
    }

    // Reading the settings opens none of the writes beside them to T.
    expect(
      await codeOf(agentsService.updateAgent(member, agentId, { name: "t" })),
    ).toStartWith("FORBIDDEN");
    expect(
      await codeOf(
        credentials.bind(member, agentId, { credential_ref: "slack" }),
      ),
    ).toStartWith("FORBIDDEN");
    expect(
      await codeOf(
        adminService.addAgentAdmin(member, agentId, "users", idOf(member)),
      ),
    ).toStartWith("FORBIDDEN");
    expect(
      await codeOf(
        slack.putSlackBinding(member, agentId, {
          channel_id: null,
          mode: "on",
          home: false,
        }),
      ),
    ).toStartWith("FORBIDDEN");
  });

  test("the list's rows and cards follow who is inside each agent now, under either axis A", async () => {
    const { workspaceId, owner, member, outsider, teamId, agentId } =
      await cast();
    // A second agent whose managing team has no one in it: only W and its
    // creator inside.
    const other = (
      await service().createAgent(owner, {
        slug: `other-${randomUUID().slice(0, 8)}`,
        name: "other",
        card: card("v1"),
        managing_team_id: teamId,
      })
    ).agent.id;
    await db
      .update(schema.agents)
      .set({ managingTeamId: await fixtureTeam(db, workspaceId) })
      .where(eq(schema.agents.id, other));
    const store = createPostgresAgentStore(db);
    const reader = (who: Caller, outsideAccess: "use" | "none") => ({
      userId: idOf(who),
      outsideAccess,
    });
    // Read a page of one at a time, so the cursor crosses filtered rows.
    const rows = async (who: Caller, outsideAccess: "use" | "none") => {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.list(
          workspaceId,
          { limit: 1, ...(cursor === undefined ? {} : { cursor }) },
          reader(who, outsideAccess),
        );
        ids.push(...page.items.map((a) => a.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return ids;
    };
    const cards = async (who: Caller) =>
      [
        ...(
          await store.summaries(workspaceId, [agentId, other], {
            userId: idOf(who),
            apiKeyId: null,
          })
        ).keys(),
      ].sort();
    const both = [agentId, other];

    expect(await rows(outsider, "use")).toEqual(both);
    expect(await rows(member, "use")).toEqual(both);
    // Axis A none: each row only where the reader is inside, the count too.
    expect(await rows(owner, "none")).toEqual(both);
    expect(await rows(member, "none")).toEqual([agentId]);
    expect(await rows(outsider, "none")).toEqual([]);
    expect((await store.count(workspaceId, reader(member, "none"))).all).toBe(
      1,
    );
    expect((await store.count(workspaceId, reader(outsider, "none"))).all).toBe(
      0,
    );
    expect(await cards(owner)).toEqual([...both].sort());
    expect(await cards(member)).toEqual([agentId]);
    expect(await cards(outsider)).toEqual([]);

    // A filter on a setting narrows to the agents whose settings are read.
    const byProfile = async (who: Caller) =>
      (
        await store.list(
          workspaceId,
          { limit: 50, runtime_profile_id: "coding" },
          reader(who, "use"),
        )
      ).items.length;
    const released = await service().createRelease(owner, agentId, {
      version_id: (await service().getAgent(owner, agentId)).versions[0]
        ?.id as string,
      runtime_profile_id: "coding",
    });
    await service().activateAgent(owner, agentId, {
      release_id: released.release.id,
      expected_revision: -1,
    });
    expect(await byProfile(member)).toBe(1);
    expect(await byProfile(outsider)).toBe(0);

    // Out of the team, the card goes with the next read.
    await teams().removeMember({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(member),
    });
    expect(await cards(member)).toEqual([]);
    expect(await byProfile(member)).toBe(0);
    await join(owner, teamId, member);
    expect(await cards(member)).toEqual([agentId]);
    // So it does with an archived team, or a disabled member.
    await pool.query(
      "UPDATE member_teams SET archived_at = now() WHERE id = $1",
      [teamId],
    );
    expect(await cards(member)).toEqual([]);
    await pool.query(
      "UPDATE member_teams SET archived_at = NULL WHERE id = $1",
      [teamId],
    );
    expect(await cards(member)).toEqual([agentId]);
    await db
      .update(schema.memberships)
      .set({ disabledAt: new Date() })
      .where(eq(schema.memberships.userId, idOf(member)));
    expect(await cards(member)).toEqual([]);
    expect(await rows(member, "use")).toEqual([]);
  });

  test("my-teams says the role held in each team", async () => {
    const { workspaceId, lead, member, teamId } = await cast();
    const roleIn = async (who: Caller) =>
      (await teams().listJoined(workspaceId, idOf(who), { limit: 10 })).items
        .filter((team) => team.id === teamId)
        .map((team) => team.role);
    expect(await roleIn(lead)).toEqual(["lead"]);
    expect(await roleIn(member)).toEqual(["member"]);
  });

  test("the database refuses an agent with no managing team", async () => {
    const { workspaceId, agentId } = await cast();
    const refusal = async (work: Promise<unknown>) => {
      try {
        await work;
        return "accepted";
      } catch (error) {
        // drizzle wraps the driver error; the constraint text is on its cause.
        const cause = (error as { cause?: unknown }).cause ?? error;
        return String((cause as Error).message);
      }
    };
    expect(
      await refusal(
        pool.query("UPDATE agents SET managing_team_id = NULL WHERE id = $1", [
          agentId,
        ]),
      ),
    ).toContain("managing_team_id");
    expect(
      await refusal(
        pool.query(
          "INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'bare', 'bare')",
          [randomUUID(), workspaceId],
        ),
      ),
    ).toContain("managing_team_id");
  });

  test("who may name the managing team, at creation and after", async () => {
    const { workspaceId, owner, lead, member, outsider, teamId, agentId } =
      await cast();
    const otherTeam = await newTeam(owner);
    const outsiderTeam = await newTeam(owner);
    await join(owner, outsiderTeam, outsider);
    const create = (by: Caller, team: string) =>
      codeOf(
        service().createAgent(by, {
          slug: `agent-${randomUUID().slice(0, 8)}`,
          name: "새 에이전트",
          card: card("v1"),
          managing_team_id: team,
        }),
      );

    // A member names only a team they are in; an owner any live team.
    expect(await create(member, teamId)).toBe("ok");
    expect(await create(member, otherTeam)).toBe("FORBIDDEN:team_not_allowed");
    expect(await create(member, randomUUID())).toBe(
      "FORBIDDEN:team_not_allowed",
    );
    expect(await create(owner, randomUUID())).toBe("NOT_FOUND");

    // A team the member is in, but in another workspace, is not this one's.
    const elsewhere = randomUUID();
    await db.insert(schema.workspaces).values({
      id: elsewhere,
      slug: `ws-${elsewhere.slice(0, 8)}`,
      name: "elsewhere",
    });
    await db
      .insert(schema.memberships)
      .values({ workspaceId: elsewhere, userId: idOf(member), role: "owner" });
    const foreignOwner = callerFor(
      {
        kind: "user",
        id: idOf(member),
        workspace_id: elsewhere,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      randomUUID(),
    );
    const foreignTeam = await newTeam(foreignOwner);
    await join(foreignOwner, foreignTeam, foreignOwner, "lead");
    expect(await create(member, foreignTeam)).toBe(
      "FORBIDDEN:team_not_allowed",
    );
    await admins().add({
      actor: acting(owner),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: idOf(member) },
      managerRoles: MANAGERS,
    });
    expect(await name(member, agentId, foreignTeam)).toEqual({
      outcome: "team_not_allowed",
    });
    await admins().remove({
      actor: acting(owner),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: idOf(member) },
      managerRoles: MANAGERS,
    });
    expect(await create(owner, otherTeam)).toBe("ok");

    // After: the agent's admin moves it only to a team they are in.
    expect(await name(lead, agentId, otherTeam)).toEqual({
      outcome: "team_not_allowed",
    });
    expect(await name(lead, agentId, teamId)).toMatchObject({
      outcome: "unchanged",
    });
    expect(await name(member, agentId, otherTeam)).toEqual({
      outcome: "actor_inactive",
    });
    expect(await name(owner, agentId, randomUUID())).toEqual({
      outcome: "team_not_found",
    });
    const moved = await name(owner, agentId, outsiderTeam);
    expect(moved).toMatchObject({
      outcome: "set",
      agent: { managing_team_id: outsiderTeam },
    });
    // The old lead lost the agent with the move.
    expect(await isAdmin(workspaceId, agentId, lead)).toBe(false);
    expect(await inside(workspaceId, agentId, outsider)).toBe(true);
    expect(
      (
        await db
          .select({
            operation: receipts.operation,
            result: receipts.result,
          })
          .from(receipts)
          .where(eq(receipts.ownerId, workspaceId))
      ).filter((r) => r.operation === "set_agent_managing_team"),
    ).toEqual([
      {
        operation: "set_agent_managing_team",
        result: { from: teamId, to: outsiderTeam },
      },
    ]);
  });

  test("the holding team of 0243 is no destination for a new agent or a move, but an agent already in it may stay", async () => {
    const { workspaceId, owner, agentId } = await cast();
    const holding = randomUUID();
    await db.insert(schema.memberTeams).values({
      id: holding,
      workspaceId,
      name: "Unassigned agents",
      holdsUnassigned: true,
    });
    const create = (team: string) =>
      codeOf(
        service().createAgent(owner, {
          slug: `agent-${randomUUID().slice(0, 8)}`,
          name: "새 에이전트",
          card: card("v1"),
          managing_team_id: team,
        }),
      );
    expect(await create(holding)).toBe("FORBIDDEN:team_holding");
    expect(await name(owner, agentId, holding)).toMatchObject({
      outcome: "team_holding",
    });
    // The agent did not move.
    const [row] = await db
      .select({ team: schema.agents.managingTeamId })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    expect(row?.team).not.toBe(holding);

    // One that is already there is not forced out by a repeat of its team.
    await db
      .update(schema.agents)
      .set({ managingTeamId: holding })
      .where(eq(schema.agents.id, agentId));
    expect(await name(owner, agentId, holding)).toMatchObject({
      outcome: "unchanged",
    });

    // Leaving it is one way: coming back is a move into it, and refused.
    const real = await newTeam(owner);
    expect(await name(owner, agentId, real)).toMatchObject({ outcome: "set" });
    expect(await name(owner, agentId, holding)).toMatchObject({
      outcome: "team_holding",
    });
  });

  test("the answer for the holding team tells no one what an ordinary team would not", async () => {
    const { workspaceId, owner, member, agentId } = await cast();
    const holding = randomUUID();
    await db.insert(schema.memberTeams).values({
      id: holding,
      workspaceId,
      name: "Unassigned agents",
      holdsUnassigned: true,
    });
    const ordinary = await newTeam(owner);
    const create = (by: Caller, team: string) =>
      codeOf(
        service().createAgent(by, {
          slug: `agent-${randomUUID().slice(0, 8)}`,
          name: "새 에이전트",
          card: card("v1"),
          managing_team_id: team,
        }),
      );
    // A member outside both teams hears the same about each.
    expect(await create(member, holding)).toBe("FORBIDDEN:team_not_allowed");
    expect(await create(member, ordinary)).toBe("FORBIDDEN:team_not_allowed");
    // The same on a move: an admin of the agent who is in neither team.
    await admins().add({
      actor: acting(owner),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: idOf(member) },
      managerRoles: MANAGERS,
    });
    expect(await name(member, agentId, holding)).toEqual({
      outcome: "team_not_allowed",
    });
    expect(await name(member, agentId, ordinary)).toEqual({
      outcome: "team_not_allowed",
    });
    // An archived holding team is as gone as any archived team, on a create
    // and on a move alike.
    const gone = await newTeam(owner);
    for (const id of [holding, gone]) {
      await db
        .update(schema.memberTeams)
        .set({ archivedAt: new Date() })
        .where(eq(schema.memberTeams.id, id));
    }
    expect(await create(owner, holding)).toBe("NOT_FOUND");
    expect(await create(owner, gone)).toBe("NOT_FOUND");
    expect(await name(owner, agentId, holding)).toEqual({
      outcome: "team_not_found",
    });
    expect(await name(owner, agentId, gone)).toEqual({
      outcome: "team_not_found",
    });
  });

  test("a team joins an agent's admins only by a manager or its lead", async () => {
    const { workspaceId, owner, member, agentId } = await cast();
    const direct = await person(workspaceId, "member");
    await admins().add({
      actor: acting(owner),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: idOf(direct) },
      managerRoles: MANAGERS,
    });
    const extra = await newTeam(owner);
    await join(owner, extra, direct);
    const add = (by: Caller, teamId: string) =>
      admins().add({
        actor: acting(by),
        receiptId: randomUUID(),
        agentId,
        subject: { kind: "team", id: teamId },
        managerRoles: MANAGERS,
      });

    expect(await add(direct, extra)).toEqual({ outcome: "team_not_allowed" });
    await setRole(owner, extra, direct, "lead");
    expect(await add(direct, extra)).toMatchObject({ outcome: "added" });
    // A team already there stays; an owner adds a team nobody leads.
    const plain = await newTeam(owner);
    await join(owner, plain, member);
    expect(await add(owner, plain)).toMatchObject({ outcome: "added" });
    await setRole(owner, extra, direct, "member");
    const listed = await admins().list(workspaceId, agentId);
    expect(listed?.teams.map((t) => t.teamId).sort()).toEqual(
      [extra, plain].sort(),
    );
  });

  test("a team managing a live agent is not deleted", async () => {
    const { owner, teamId, agentId } = await cast();
    const remove = () =>
      teams().delete({
        actor: acting(owner),
        receiptId: randomUUID(),
        teamId,
      });
    expect(await remove()).toEqual({
      outcome: "manages_agents",
      agentIds: [agentId],
    });
    await db
      .update(agents)
      .set({ status: "archived" })
      .where(eq(agents.id, agentId));
    expect(await remove()).toEqual({ outcome: "deleted" });
  });

  test("a team delete and naming that team never both land, whichever locks the team first", async () => {
    // Delete first: replays its lock and archive; the naming waits, then
    // finds no live team.
    {
      const { owner, agentId } = await cast();
      const target = await newTeam(owner);
      const deleter = await pool.connect();
      try {
        await deleter.query("BEGIN");
        await deleter.query(
          "SELECT id FROM member_teams WHERE id = $1 FOR UPDATE",
          [target],
        );
        const named = name(owner, agentId, target);
        await blockedBy(deleter);
        await deleter.query(
          "UPDATE member_teams SET archived_at = now() WHERE id = $1",
          [target],
        );
        await deleter.query("COMMIT");
        expect(await named).toEqual({ outcome: "team_not_found" });
      } finally {
        // A no-op after COMMIT; frees the locks when a step above failed.
        await deleter.query("ROLLBACK");
        deleter.release();
      }
    }
    // Naming first: replays setManagingTeam's locks and update; the delete
    // waits on the team row, then sees the agent it manages.
    {
      const { owner, agentId } = await cast();
      const target = await newTeam(owner);
      const namer = await pool.connect();
      try {
        await namer.query("BEGIN");
        await namer.query(
          "SELECT id FROM agents WHERE id = $1 FOR NO KEY UPDATE",
          [agentId],
        );
        await namer.query(
          "SELECT id FROM member_teams WHERE id = $1 FOR SHARE",
          [target],
        );
        await namer.query(
          "UPDATE agents SET managing_team_id = $2 WHERE id = $1",
          [agentId, target],
        );
        const deleted = teams().delete({
          actor: acting(owner),
          receiptId: randomUUID(),
          teamId: target,
        });
        await blockedBy(namer);
        await namer.query("COMMIT");
        expect(await deleted).toEqual({
          outcome: "manages_agents",
          agentIds: [agentId],
        });
      } finally {
        await namer.query("ROLLBACK");
        namer.release();
      }
    }
  });

  test("the lead answers for the agent's sessions in the approval write; a member does not", async () => {
    const { workspaceId, owner, lead, member, teamId, agentId } = await cast();
    const agentsService = service();
    const [version] = (await agentsService.getAgent(owner, agentId)).versions;
    if (!version) throw new Error("no version");
    const { release } = await agentsService.createRelease(owner, agentId, {
      version_id: version.id,
      runtime_profile_id: "coding",
    });
    const reach = (who: Caller) =>
      db.transaction((tx) =>
        lockSessionReach(
          tx,
          {
            userId: idOf(who),
            apiKeyId: null,
            role: "member",
            keyAgentId: null,
          },
          {
            id: randomUUID(),
            workspaceId,
            createdByUserId: idOf(owner),
            createdByApiKeyId: null,
            agentReleaseId: release.id,
          },
          { answer: true },
        ),
      );
    expect(await reach(lead)).toBe("ok");
    expect(await reach(member)).toBe("role");
    await setRole(owner, teamId, lead, "member");
    expect(await reach(lead)).toBe("role");
  });

  // Holds the lock the managing-team change or the lead's demotion takes,
  // starts `write` as the lead, and lets the change commit while it waits.
  async function raced(
    change: (client: PoolClient) => Promise<void>,
    write: () => Promise<unknown>,
  ) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      await change(client);
      const pending = write().then(
        (value) => value,
        (error: unknown) => error,
      );
      await blockedBy(client);
      await client.query("COMMIT");
      open = false;
      const result = await pending;
      if (result instanceof SessionServiceError) return reasonOf(result);
      if (result instanceof Error) throw result;
      return (result as { outcome?: string }).outcome ?? "ok";
    } finally {
      if (open) await client.query("ROLLBACK");
      client.release();
    }
  }

  // Until some backend waits on a lock this connection holds.
  async function blockedBy(holder: PoolClient) {
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    const waiting = async () =>
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        )
      ).rowCount;
    for (let i = 0; i < 100 && !(await waiting()); i++) await Bun.sleep(20);
    expect(await waiting()).toBeGreaterThan(0);
  }

  const moveAway =
    (agentId: string, teamId: string) => async (c: PoolClient) => {
      await c.query("SELECT id FROM agents WHERE id = $1 FOR NO KEY UPDATE", [
        agentId,
      ]);
      await c.query("UPDATE agents SET managing_team_id = $2 WHERE id = $1", [
        agentId,
        teamId,
      ]);
    };
  // setMemberRole's order: the team row, then the member row.
  const demote = (teamId: string, who: Caller) => async (c: PoolClient) => {
    await c.query("SELECT id FROM member_teams WHERE id = $1 FOR UPDATE", [
      teamId,
    ]);
    await c.query(
      "UPDATE member_team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [teamId, idOf(who)],
    );
  };

  test("an agent-settings write by the lead loses to a managing-team move or a demotion that committed while it waited", async () => {
    const changes = [
      [
        "move",
        (s: Awaited<ReturnType<typeof cast>>, other: string) =>
          moveAway(s.agentId, other),
      ],
      [
        "demote",
        (s: Awaited<ReturnType<typeof cast>>) => demote(s.teamId, s.lead),
      ],
    ] as const;
    for (const [label, change] of changes) {
      // Each write on a fresh agent, so a refusal is this write's.
      const writes: Array<
        [string, (s: Awaited<ReturnType<typeof cast>>) => Promise<unknown>]
      > = [
        [
          "update",
          (s) => service().updateAgent(s.lead, s.agentId, { name: "late" }),
        ],
        [
          "release",
          async (s) =>
            service().createRelease(s.lead, s.agentId, {
              version_id: s.created.versions[0]?.id ?? "",
              runtime_profile_id: "coding",
            }),
        ],
        [
          "github",
          (s) =>
            createPostgresAgentGitHubStore(db).setEnabled({
              workspaceId: s.workspaceId,
              agentId: s.agentId,
              enabled: false,
              principal: s.lead,
              managerRoles: MANAGERS,
            }),
        ],
        [
          "repository",
          (s) =>
            createPostgresCatalogRepositoryStore(db).resolve({
              workspaceId: s.workspaceId,
              userId: idOf(s.lead),
              actor: {
                principal: { kind: "user", id: idOf(s.lead) },
                actor_user_id: idOf(s.lead),
                agent_id: null,
              },
              requestId: null,
              agentId: s.agentId,
              managerRoles: MANAGERS,
              receiptId: randomUUID(),
              base: `app-${randomUUID().slice(0, 8)}`,
              githubRepositoryId: Math.floor(Math.random() * 1e9),
              owner: "Acme",
              name: "App",
              url: "https://github.com/Acme/App.git",
              branch: "main",
            }),
        ],
      ];
      for (const [what, write] of writes) {
        const s = await cast();
        const other = await newTeam(s.owner);
        expect(
          `${label}:${what}:${await raced(change(s, other), () => write(s))}`,
        ).toBe(
          `${label}:${what}:${what === "update" || what === "release" ? "FORBIDDEN:role" : "outranked"}`,
        );
      }
    }
  }, 120_000);

  test("activation by the lead loses to a managing-team move or a demotion that committed while it waited", async () => {
    for (const label of ["move", "demote"] as const) {
      const s = await cast();
      const other = await newTeam(s.owner);
      const version = s.created.versions[0];
      if (!version) throw new Error("no version");
      const { release } = await service().createRelease(s.owner, s.agentId, {
        version_id: version.id,
        runtime_profile_id: "coding",
      });
      const change =
        label === "move"
          ? moveAway(s.agentId, other)
          : demote(s.teamId, s.lead);
      expect(
        `${label}:${await raced(change, () =>
          service().activateAgent(s.lead, s.agentId, {
            release_id: release.id,
            expected_revision: -1,
          }),
        )}`,
      ).toBe(`${label}:FORBIDDEN:role`);
      expect(
        await codeOf(
          service().activateAgent(s.owner, s.agentId, {
            release_id: release.id,
            expected_revision: -1,
          }),
        ),
      ).toBe("ok");
    }
  });
});
