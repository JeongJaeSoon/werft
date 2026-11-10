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
  type Caller,
  type CatalogProfile,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  type SessionCatalog,
  type TeamActor,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { createPostgresAgentAdminStore } from "./agent-admins.ts";
import { createDatabaseAgentAuthority } from "./agent-authority.ts";
import { createPostgresAgentUsageStore } from "./agent-usage.ts";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresTeamStore } from "./member-teams.ts";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";

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

const card = agentCardRequestSchema.parse({
  role: "재무 분석가",
  instructions: "v1",
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
});

const MIGRATIONS = join(import.meta.dir, "../migrations");

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "agent-usage-migrations-"));
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

integration("0265 gives every agent a usage row", () => {
  test("agents from before get scope = workspace, revision 1, and no targets", async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "agent_usage_backfill_it",
    });
    const pool = new Pool({ connectionString: database.url, max: 2 });
    const db = drizzle(pool, { schema });
    const before = await migrationsThrough("0264_runtime_tools_source");
    const query = async (text: string, values: unknown[] = []) =>
      (await pool.query(text, values)).rows;
    try {
      await migrate(db, { migrationsFolder: before });
      const agentIds: string[] = [];
      for (const slug of ["one", "two"]) {
        const ws = randomUUID();
        const team = randomUUID();
        const agent = randomUUID();
        agentIds.push(agent);
        await query(
          "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $2)",
          [ws, `ws-${slug}-${ws.slice(0, 6)}`],
        );
        await query(
          "INSERT INTO member_teams (id, workspace_id, name) VALUES ($1, $2, 't')",
          [team, ws],
        );
        await query(
          "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, $3, $4)",
          [agent, ws, slug, team],
        );
      }
      await migrate(db, { migrationsFolder: MIGRATIONS });
      const rows = await query(
        "SELECT agent_id, scope, revision, limits_revision FROM agent_usage ORDER BY agent_id",
      );
      expect(rows).toEqual(
        [...agentIds].sort().map((agent_id) => ({
          agent_id,
          scope: "workspace",
          revision: 1,
          limits_revision: 1,
        })),
      );
      expect(
        await query("SELECT count(*)::int AS n FROM agent_usage_targets"),
      ).toEqual([{ n: 0 }]);
    } finally {
      await pool.end();
      await database.drop();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});

integration("agent usage on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_usage_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const teams = () => createPostgresTeamStore(db);
  const usage = () => createPostgresAgentUsageStore(db);
  const admins = () => createPostgresAgentAdminStore(db);
  const agentService = () =>
    createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
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

  // An owner, the managing team's lead (so an admin of the agent), a plain
  // member of that team, and a second team the lead is not in.
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
    const managing = await newTeam(owner);
    const other = await newTeam(owner);
    await join(owner, managing, lead, "lead");
    await join(owner, managing, member);
    const created = await agentService().createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      card,
      managing_team_id: managing,
    });
    return {
      workspaceId,
      owner,
      lead,
      member,
      managing,
      other,
      agentId: created.agent.id,
    };
  }

  const put = (
    by: Caller,
    agentId: string,
    scope: "workspace" | "private",
    teamIds: string[],
    ifMatch: number,
  ) =>
    usage().put({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      scope,
      teamIds,
      ifMatch,
      managerRoles: MANAGERS,
    });

  const rowsOf = async (agentId: string) =>
    (
      await pool.query(
        "SELECT scope, revision FROM agent_usage WHERE agent_id = $1",
        [agentId],
      )
    ).rows;
  const receiptsOf = async (agentId: string) =>
    (
      await pool.query(
        "SELECT result FROM receipts WHERE operation = 'set_agent_usage' AND target_ref->'resource'->>'id' = $1 ORDER BY created_at",
        [agentId],
      )
    ).rows;
  const targetsOf = async (agentId: string) =>
    (
      await pool.query(
        "SELECT team_id FROM agent_usage_targets WHERE agent_id = $1 ORDER BY team_id",
        [agentId],
      )
    ).rows.map((row) => row.team_id as string);

  test("a created agent has exactly one usage row: workspace, revision 1", async () => {
    const { agentId, workspaceId } = await cast();
    expect(await rowsOf(agentId)).toEqual([
      { scope: "workspace", revision: 1 },
    ]);
    expect(await usage().get(workspaceId, agentId)).toEqual({
      scope: "workspace",
      teams: [],
      revision: 1,
    });
  });

  test("the tables refuse a bad scope, a target with both or neither, a repeat and a foreign team", async () => {
    const { agentId, workspaceId, managing } = await cast();
    const refused = (text: string, values: unknown[]) =>
      pool.query(text, values).then(
        () => "accepted",
        (error: Error) => error.message,
      );
    expect(
      await refused(
        "UPDATE agent_usage SET scope = 'everyone' WHERE agent_id = $1",
        [agentId],
      ),
    ).toContain("agent_usage_scope_check");
    expect(
      await refused("UPDATE agent_usage SET revision = 0 WHERE agent_id = $1", [
        agentId,
      ]),
    ).toContain("agent_usage_revision_check");
    expect(
      await refused(
        "INSERT INTO agent_usage_targets (agent_id, workspace_id) VALUES ($1, $2)",
        [agentId, workspaceId],
      ),
    ).toContain("agent_usage_targets_one_target_check");
    const member = (
      await pool.query(
        "SELECT user_id FROM memberships WHERE workspace_id = $1 LIMIT 1",
        [workspaceId],
      )
    ).rows[0].user_id;
    expect(
      await refused(
        "INSERT INTO agent_usage_targets (agent_id, workspace_id, team_id, user_id) VALUES ($1, $2, $3, $4)",
        [agentId, workspaceId, managing, member],
      ),
    ).toContain("agent_usage_targets_one_target_check");
    const insertTeam =
      "INSERT INTO agent_usage_targets (agent_id, workspace_id, team_id) VALUES ($1, $2, $3)";
    expect(await refused(insertTeam, [agentId, workspaceId, managing])).toBe(
      "accepted",
    );
    expect(
      await refused(insertTeam, [agentId, workspaceId, managing]),
    ).toContain("agent_usage_targets_team_uniq");
    expect(
      await refused(insertTeam, [agentId, workspaceId, randomUUID()]),
    ).toContain("agent_usage_targets_team_fk");
    // A real team of another workspace, with either workspace id: a target
    // cannot cross from its agent's workspace.
    const foreign = await cast();
    expect(
      await refused(insertTeam, [agentId, workspaceId, foreign.managing]),
    ).toContain("agent_usage_targets_team_fk");
    expect(
      await refused(insertTeam, [
        agentId,
        foreign.workspaceId,
        foreign.managing,
      ]),
    ).toContain("agent_usage_targets_usage_fk");
    // A person target is one or the other, and the storage keeps it unique.
    const insertUser =
      "INSERT INTO agent_usage_targets (agent_id, workspace_id, user_id) VALUES ($1, $2, $3)";
    expect(await refused(insertUser, [agentId, workspaceId, member])).toBe(
      "accepted",
    );
    expect(await refused(insertUser, [agentId, workspaceId, member])).toContain(
      "agent_usage_targets_user_uniq",
    );
  });

  test("an owner replaces the setting: revision moves, a receipt is written, a repeat changes nothing", async () => {
    const { agentId, owner, managing, other, workspaceId } = await cast();
    const set = await put(owner, agentId, "private", [managing], 1);
    expect(set).toMatchObject({
      outcome: "set",
      usage: { scope: "private", revision: 2, teams: [{ id: managing }] },
    });
    expect(await receiptsOf(agentId)).toHaveLength(1);

    const same = await put(owner, agentId, "private", [managing], 2);
    expect(same).toMatchObject({
      outcome: "unchanged",
      usage: { revision: 2 },
    });
    expect(await receiptsOf(agentId)).toHaveLength(1);

    const swapped = await put(owner, agentId, "private", [other], 2);
    expect(swapped).toMatchObject({ outcome: "set", usage: { revision: 3 } });
    expect(await targetsOf(agentId)).toEqual([other]);

    const open = await put(owner, agentId, "workspace", [], 3);
    expect(open).toMatchObject({
      outcome: "set",
      usage: { scope: "workspace", teams: [], revision: 4 },
    });
    expect(await targetsOf(agentId)).toEqual([]);
    expect(await receiptsOf(agentId)).toHaveLength(3);
    expect((await receiptsOf(agentId))[0]?.result).toMatchObject({
      from: { scope: "workspace", team_ids: [] },
      to: { scope: "private", team_ids: [managing] },
    });
    expect((await usage().get(workspaceId, agentId))?.revision).toBe(4);
  });

  test("a stale If-Match is refused and writes nothing", async () => {
    const { agentId, owner, managing } = await cast();
    await put(owner, agentId, "private", [managing], 1);
    const stale = await put(owner, agentId, "workspace", [], 1);
    expect(stale).toEqual({ outcome: "version_mismatch", current: 2 });
    expect(await rowsOf(agentId)).toEqual([{ scope: "private", revision: 2 }]);
    expect(await receiptsOf(agentId)).toHaveLength(1);
  });

  test("a plain member is refused; an agent's admin lists only teams they are in, and may remove any", async () => {
    const { agentId, owner, lead, member, managing, other } = await cast();
    expect(await put(member, agentId, "private", [managing], 1)).toEqual({
      outcome: "actor_inactive",
    });
    expect(await rowsOf(agentId)).toEqual([
      { scope: "workspace", revision: 1 },
    ]);

    // The lead administers the agent through the managing team but is not in `other`.
    expect(await put(lead, agentId, "private", [managing, other], 1)).toEqual({
      outcome: "team_not_allowed",
    });
    expect(await put(lead, agentId, "private", [managing], 1)).toMatchObject({
      outcome: "set",
      usage: { revision: 2 },
    });
    // The owner adds `other`; the lead, who cannot add it, can still drop it.
    expect(
      await put(owner, agentId, "private", [managing, other], 2),
    ).toMatchObject({ outcome: "set" });
    expect(await put(lead, agentId, "private", [managing], 3)).toMatchObject({
      outcome: "set",
      usage: { revision: 4, teams: [{ id: managing }] },
    });
    // A lead keeping a team they are not in is not adding it.
    expect(
      await put(owner, agentId, "private", [managing, other], 4),
    ).toMatchObject({ outcome: "set" });
    const dropMine = await put(lead, agentId, "private", [other], 5);
    expect(dropMine).toMatchObject({
      outcome: "set",
      usage: { revision: 6, teams: [{ id: other }] },
    });
  });

  test("an archived team, a foreign team and an unknown agent answer not found", async () => {
    const first = await cast();
    const second = await cast();
    const gone = await newTeam(first.owner);
    await teams().delete({
      actor: acting(first.owner),
      receiptId: randomUUID(),
      teamId: gone,
    });
    expect(await put(first.owner, first.agentId, "private", [gone], 1)).toEqual(
      { outcome: "team_not_found" },
    );
    expect(
      await put(first.owner, first.agentId, "private", [second.managing], 1),
    ).toEqual({ outcome: "team_not_found" });
    expect(
      await put(first.owner, randomUUID(), "private", [first.managing], 1),
    ).toEqual({ outcome: "not_found" });
    expect(await rowsOf(first.agentId)).toEqual([
      { scope: "workspace", revision: 1 },
    ]);
  });

  test("94S-837: a non-manager who administers the agent names a managing team only if they are in it", async () => {
    const { agentId, lead, other, managing } = await cast();
    const name = (teamId: string) =>
      admins().setManagingTeam({
        actor: acting(lead),
        receiptId: randomUUID(),
        agentId,
        teamId,
        managerRoles: MANAGERS,
      });
    // Not in `other`: refused. In `managing` (already the team): unchanged.
    expect(await name(other)).toEqual({ outcome: "team_not_allowed" });
    expect(await name(managing)).toMatchObject({ outcome: "unchanged" });
  });

  // Holds a lock, starts `write`, and lets the lock's transaction commit once
  // the write is waiting on it.
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
      const pending = write();
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
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
      await client.query("COMMIT");
      open = false;
      return await pending;
    } finally {
      if (open) await client.query("ROLLBACK");
      client.release();
    }
  }

  test("a PUT by someone who stopped administering the agent while it waited is refused and changes nothing", async () => {
    const { agentId, lead, owner, managing } = await cast();
    // The team's demotion: the team row, then the member row.
    const result = await raced(
      async (client) => {
        await client.query(
          "SELECT id FROM member_teams WHERE id = $1 FOR UPDATE",
          [managing],
        );
        await client.query(
          "UPDATE member_team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2 AND removed_at IS NULL",
          [managing, idOf(lead)],
        );
      },
      () => put(lead, agentId, "private", [managing], 1),
    );
    expect(result).toEqual({ outcome: "actor_inactive" });
    expect(await rowsOf(agentId)).toEqual([
      { scope: "workspace", revision: 1 },
    ]);
    expect(await targetsOf(agentId)).toEqual([]);
    expect(await receiptsOf(agentId)).toHaveLength(0);
    expect(owner).toBeDefined();
  });

  test("archiving a team removes it from every list, moves those revisions, and makes an earlier If-Match stale", async () => {
    const { agentId, owner, managing } = await cast();
    const doomed = await newTeam(owner);
    const second = await cast();
    // A second agent in the same workspace as the first lists the doomed team too.
    const created = await agentService().createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "b",
      card,
      managing_team_id: managing,
    });
    const otherAgent = created.agent.id;
    await put(owner, agentId, "private", [managing, doomed], 1);
    await put(owner, otherAgent, "private", [doomed], 1);
    const readAt = (await usage().get(owner.ownerId, agentId))?.revision;
    expect(readAt).toBe(2);

    const archived = await teams().delete({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: doomed,
    });
    expect(archived).toEqual({ outcome: "deleted" });
    expect(await targetsOf(agentId)).toEqual([managing]);
    expect(await targetsOf(otherAgent)).toEqual([]);
    expect(await rowsOf(agentId)).toEqual([{ scope: "private", revision: 3 }]);
    // Left private with no team: the setting stays, and its revision moved.
    expect(await rowsOf(otherAgent)).toEqual([
      { scope: "private", revision: 3 },
    ]);

    expect(await put(owner, agentId, "workspace", [], 2)).toEqual({
      outcome: "version_mismatch",
      current: 3,
    });
    expect(
      (
        await pool.query(
          "SELECT result FROM receipts WHERE operation = 'delete_team' AND target_ref->'resource'->>'id' = $1",
          [doomed],
        )
      ).rows[0]?.result.usage_agent_ids.sort(),
    ).toEqual([agentId, otherAgent].sort());
    expect(second.agentId).toBeDefined();
  });

  test("archive and PUT together: no deadlock, and the end state agrees with whoever won", async () => {
    const { agentId, owner } = await cast();
    for (let round = 0; round < 12; round++) {
      const team = await newTeam(owner);
      const before = (await usage().get(owner.ownerId, agentId))?.revision ?? 0;
      const [archived, edited] = await Promise.all([
        teams().delete({
          actor: acting(owner),
          receiptId: randomUUID(),
          teamId: team,
        }),
        put(owner, agentId, "private", [team], before),
      ]);
      // The archive always wins in the end: nothing may list a dead team.
      expect(archived.outcome).toBe("deleted");
      expect(["set", "team_not_found"]).toContain(edited.outcome);
      expect(await targetsOf(agentId)).not.toContain(team);
      const after = (await usage().get(owner.ownerId, agentId))?.revision ?? 0;
      // Edited first: +1 for the edit, +1 for the archive. Archive first: no change.
      expect(after).toBe(edited.outcome === "set" ? before + 2 : before);
      // Back to a state the next round can edit from.
      const row = await usage().get(owner.ownerId, agentId);
      if (row?.scope === "private") {
        const reset = await put(owner, agentId, "workspace", [], row.revision);
        expect(reset.outcome).toBe("set");
      }
    }
  }, 60_000);

  test("an agent that starts listing the team while the archive waits for it is found by the next attempt", async () => {
    const { agentId, owner, workspaceId } = await cast();
    const team = await newTeam(owner);
    // The archive names no agent at first, then waits for the team row this
    // transaction holds; the agent's list gains the team before it commits.
    const result = await raced(
      async (client) => {
        await client.query(
          "SELECT id FROM member_teams WHERE id = $1 FOR SHARE",
          [team],
        );
        await client.query(
          "INSERT INTO agent_usage_targets (agent_id, workspace_id, team_id) VALUES ($1, $2, $3)",
          [agentId, workspaceId, team],
        );
      },
      () =>
        teams().delete({
          actor: acting(owner),
          receiptId: randomUUID(),
          teamId: team,
        }),
    );
    expect(result).toEqual({ outcome: "deleted" });
    expect(await targetsOf(agentId)).toEqual([]);
    expect(await rowsOf(agentId)).toEqual([
      { scope: "workspace", revision: 2 },
    ]);
  });
});
