import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentCallerLimitRule,
  agentCardRequestSchema,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createDatabaseAgentAuthority } from "./agent-authority.ts";
import {
  callerLimitsOf,
  createPostgresAgentCallerLimitsStore,
} from "./agent-caller-limits.ts";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresTeamStore } from "./member-teams.ts";
import * as schema from "./schema.ts";
import { TEST_RUNTIMES, testSessionCatalog } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];

const CATALOG = testSessionCatalog();

const card = agentCardRequestSchema.parse({
  role: "재무 분석가",
  instructions: "v1",
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
});

const rule = (
  target: AgentCallerLimitRule["target"],
  over: Partial<Omit<AgentCallerLimitRule, "target">> = {},
): AgentCallerLimitRule => ({
  target,
  tools_deny: [],
  repositories: null,
  mcp_servers: null,
  credentials_deny: [],
  ...over,
});

integration("agent caller limits on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_caller_limits_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const teams = () => createPostgresTeamStore(db);
  const limits = () => createPostgresAgentCallerLimitsStore(db);
  const agentService = () =>
    createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
      }),
      store: createPostgresAgentStore(db),
      catalog: CATALOG,
      credentials: createPostgresCredentialBindingStore(db),
      runtimes: TEST_RUNTIMES,
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
    rules: AgentCallerLimitRule[],
    ifMatch: number,
  ) =>
    limits().put({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      rules,
      ifMatch,
      managerRoles: MANAGERS,
    });

  const revisionOf = async (agentId: string) =>
    (
      await pool.query(
        "SELECT limits_revision, revision FROM agent_usage WHERE agent_id = $1",
        [agentId],
      )
    ).rows[0] as { limits_revision: number; revision: number };
  const receiptsOf = async (agentId: string) =>
    (
      await pool.query(
        "SELECT result FROM receipts WHERE operation = 'set_agent_caller_limits' AND target_ref->'resource'->>'id' = $1 ORDER BY created_at",
        [agentId],
      )
    ).rows;
  const rowsOf = async (agentId: string) =>
    (
      await pool.query(
        "SELECT target_kind, team_id FROM agent_caller_limits WHERE agent_id = $1 ORDER BY target_kind, team_id",
        [agentId],
      )
    ).rows;

  async function catalogRepository(id: string, removed = false) {
    await db.insert(schema.catalogRepositories).values({
      id,
      owner: "acme",
      name: id,
      url: `https://git.invalid/acme/${id}.git`,
      branch: "main",
      authKind: "none",
      source: "seed",
      removedAt: removed ? new Date() : null,
    });
  }

  test("the table refuses a kind with the wrong columns and a repeated target, workspace included", async () => {
    const { agentId, workspaceId, managing, owner } = await cast();
    const insert = (
      kind: string,
      team: string | null,
      channel: string | null,
    ) =>
      pool.query(
        "INSERT INTO agent_caller_limits (agent_id, workspace_id, target_kind, team_id, channel_id) VALUES ($1, $2, $3, $4, $5)",
        [agentId, workspaceId, kind, team, channel],
      );
    // Each kind sets exactly its own column.
    await expect(insert("workspace", managing, null)).rejects.toThrow(
      /agent_caller_limits_target_check/,
    );
    await expect(insert("team", null, null)).rejects.toThrow(
      /agent_caller_limits_target_check/,
    );
    await expect(insert("team", managing, "C1")).rejects.toThrow(
      /agent_caller_limits_target_check/,
    );
    await expect(insert("channel", null, null)).rejects.toThrow(
      /agent_caller_limits_target_check/,
    );
    await expect(insert("user", null, null)).rejects.toThrow(
      /agent_caller_limits_target_check/,
    );
    await expect(insert("everyone", null, null)).rejects.toThrow(
      /agent_caller_limits_target_check/,
    );
    // NULLS NOT DISTINCT: the workspace rule, whose other columns are NULL, cannot repeat.
    await insert("workspace", null, null);
    await expect(insert("workspace", null, null)).rejects.toThrow(
      /agent_caller_limits_target_uniq/,
    );
    await insert("team", managing, null);
    await expect(insert("team", managing, null)).rejects.toThrow(
      /agent_caller_limits_target_uniq/,
    );
    await insert("channel", null, "C1");
    await expect(insert("channel", null, "C1")).rejects.toThrow(
      /agent_caller_limits_target_uniq/,
    );
    await insert("channel", null, "C2");
    // A team of another workspace is not a target.
    const foreign = await cast();
    await expect(insert("team", foreign.managing, null)).rejects.toThrow(
      /agent_caller_limits_team_fk/,
    );
    // A person is storable, though the API takes none.
    await pool.query(
      "INSERT INTO agent_caller_limits (agent_id, workspace_id, target_kind, user_id) VALUES ($1, $2, 'user', $3)",
      [agentId, workspaceId, idOf(owner)],
    );
    const read = await limits().get(workspaceId, agentId);
    expect(read?.rules.map((r) => r.target.kind)).toEqual([
      "workspace",
      "team",
      "channel",
      "channel",
    ]);
  });

  test("a new agent reads no rules at revision 1; an unknown agent reads null", async () => {
    const { agentId, workspaceId } = await cast();
    expect(await limits().get(workspaceId, agentId)).toEqual({
      rules: [],
      revision: 1,
    });
    expect(await limits().get(workspaceId, randomUUID())).toBeNull();
    expect(await limits().get(randomUUID(), agentId)).toBeNull();
  });

  test("an owner replaces the set: revision moves, a receipt is written, a repeat changes nothing", async () => {
    const { agentId, owner, managing, other, workspaceId } = await cast();
    const rules = [
      rule({ kind: "team", id: managing }, { tools_deny: ["b", "a"] }),
      rule({ kind: "channel", id: "C1" }, { mcp_servers: [] }),
      rule({ kind: "workspace" }, { credentials_deny: ["token"] }),
    ];
    const set = await put(owner, agentId, rules, 1);
    expect(set).toMatchObject({ outcome: "set", limits: { revision: 2 } });
    // Workspace first, then team, then channel; lists sorted.
    expect(set.outcome === "set" && set.limits.rules).toEqual([
      rule({ kind: "workspace" }, { credentials_deny: ["token"] }),
      rule({ kind: "team", id: managing }, { tools_deny: ["a", "b"] }),
      rule({ kind: "channel", id: "C1" }, { mcp_servers: [] }),
    ]);
    expect(await receiptsOf(agentId)).toHaveLength(1);
    expect((await receiptsOf(agentId))[0]?.result).toMatchObject({
      from: { rules: [] },
      revision: 2,
    });
    expect(await revisionOf(agentId)).toEqual({
      limits_revision: 2,
      revision: 1,
    });

    // The same rules in another order and with lists shuffled.
    const same = await put(owner, agentId, [...rules].reverse(), 2);
    expect(same).toMatchObject({
      outcome: "unchanged",
      limits: { revision: 2 },
    });
    expect(await receiptsOf(agentId)).toHaveLength(1);

    const changed = await put(
      owner,
      agentId,
      [rule({ kind: "team", id: other }, { repositories: [] })],
      2,
    );
    expect(changed).toMatchObject({ outcome: "set", limits: { revision: 3 } });
    expect(await rowsOf(agentId)).toEqual([
      { target_kind: "team", team_id: other },
    ]);
    const cleared = await put(owner, agentId, [], 3);
    expect(cleared).toMatchObject({
      outcome: "set",
      limits: { rules: [], revision: 4 },
    });
    expect(await rowsOf(agentId)).toEqual([]);
    expect((await limits().get(workspaceId, agentId))?.revision).toBe(4);
    // The usage setting's own revision never moved.
    expect((await revisionOf(agentId)).revision).toBe(1);
  });

  test("a stale If-Match is refused and writes nothing", async () => {
    const { agentId, owner, managing } = await cast();
    await put(owner, agentId, [rule({ kind: "team", id: managing })], 1);
    const stale = await put(owner, agentId, [], 1);
    expect(stale).toEqual({ outcome: "version_mismatch", current: 2 });
    expect(await rowsOf(agentId)).toHaveLength(1);
    expect(await receiptsOf(agentId)).toHaveLength(1);
  });

  test("a plain member is refused; an agent's admin adds a rule only for a team they are in, and may remove any", async () => {
    const { agentId, owner, lead, member, managing, other } = await cast();
    expect(
      await put(member, agentId, [rule({ kind: "team", id: managing })], 1),
    ).toEqual({ outcome: "actor_inactive" });
    expect(await rowsOf(agentId)).toEqual([]);

    expect(
      await put(lead, agentId, [rule({ kind: "team", id: other })], 1),
    ).toEqual({ outcome: "team_not_allowed" });
    expect(
      await put(lead, agentId, [rule({ kind: "team", id: managing })], 1),
    ).toMatchObject({ outcome: "set", limits: { revision: 2 } });
    // The workspace and a channel need no team.
    expect(
      await put(
        lead,
        agentId,
        [
          rule({ kind: "team", id: managing }),
          rule({ kind: "workspace" }),
          rule({ kind: "channel", id: "C9" }),
        ],
        2,
      ),
    ).toMatchObject({ outcome: "set", limits: { revision: 3 } });

    // A rule for a team the lead is not in was put by the owner; removing it is the lead's right.
    await put(
      owner,
      agentId,
      [rule({ kind: "team", id: other }), rule({ kind: "team", id: managing })],
      3,
    );
    expect(
      await put(lead, agentId, [rule({ kind: "team", id: managing })], 4),
    ).toMatchObject({ outcome: "set", limits: { revision: 5 } });
  });

  test("an unknown agent, a foreign team and an archived team answer not found", async () => {
    const { agentId, owner } = await cast();
    expect(
      await put(owner, randomUUID(), [rule({ kind: "workspace" })], 1),
    ).toEqual({ outcome: "not_found" });
    expect(await put(owner, "not-a-uuid", [], 1)).toEqual({
      outcome: "not_found",
    });
    const foreign = await cast();
    expect(
      await put(
        owner,
        agentId,
        [rule({ kind: "team", id: foreign.managing })],
        1,
      ),
    ).toEqual({ outcome: "team_not_found" });
    expect(
      await put(owner, agentId, [rule({ kind: "team", id: randomUUID() })], 1),
    ).toEqual({ outcome: "team_not_found" });
    const doomed = await newTeam(owner);
    await teams().delete({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: doomed,
    });
    expect(
      await put(owner, agentId, [rule({ kind: "team", id: doomed })], 1),
    ).toEqual({ outcome: "team_not_found" });
    expect(await revisionOf(agentId)).toEqual({
      limits_revision: 1,
      revision: 1,
    });
  });

  test("a repository id this edit adds must be in the catalog; one the target already holds passes after the catalog drops it", async () => {
    const { agentId, owner, managing } = await cast();
    const a = `repo-a-${randomUUID().slice(0, 8)}`;
    const b = `repo-b-${randomUUID().slice(0, 8)}`;
    const gone = `repo-gone-${randomUUID().slice(0, 8)}`;
    await catalogRepository(a);
    await catalogRepository(b);
    await catalogRepository(gone, true);
    const ghost = `repo-ghost-${randomUUID().slice(0, 8)}`;

    // Unknown and removed ids are named, sorted, and nothing is written.
    expect(
      await put(
        owner,
        agentId,
        [rule({ kind: "workspace" }, { repositories: [a, ghost, gone] })],
        1,
      ),
    ).toEqual({
      outcome: "repository_not_in_catalog",
      repositoryIds: [ghost, gone].sort(),
    });
    expect(await revisionOf(agentId)).toEqual({
      limits_revision: 1,
      revision: 1,
    });
    expect(await receiptsOf(agentId)).toHaveLength(0);

    expect(
      await put(
        owner,
        agentId,
        [
          rule({ kind: "workspace" }, { repositories: [a] }),
          rule({ kind: "team", id: managing }, { repositories: [] }),
        ],
        1,
      ),
    ).toMatchObject({ outcome: "set", limits: { revision: 2 } });

    // The catalog drops `a`: the rule keeps it, and its other fields stay editable.
    await pool.query(
      "UPDATE catalog_repositories SET removed_at = now() WHERE id = $1",
      [a],
    );
    const edited = await put(
      owner,
      agentId,
      [
        rule(
          { kind: "workspace" },
          { repositories: [a, b], tools_deny: ["shell"] },
        ),
        rule({ kind: "team", id: managing }, { repositories: [] }),
      ],
      2,
    );
    expect(edited).toMatchObject({ outcome: "set", limits: { revision: 3 } });
    // Another target adding the dropped id is adding it: refused.
    expect(
      await put(
        owner,
        agentId,
        [
          rule(
            { kind: "workspace" },
            { repositories: [a, b], tools_deny: ["shell"] },
          ),
          rule({ kind: "team", id: managing }, { repositories: [a] }),
        ],
        3,
      ),
    ).toEqual({ outcome: "repository_not_in_catalog", repositoryIds: [a] });
    expect((await limits().get(owner.ownerId, agentId))?.revision).toBe(3);
  });

  test("channel ids that differ only by case are two targets: moving an allowance to one adds it there", async () => {
    const { agentId, owner } = await cast();
    const gone = `repo-gone-${randomUUID().slice(0, 8)}`;
    const live = `repo-live-${randomUUID().slice(0, 8)}`;
    await catalogRepository(live);
    await catalogRepository(gone);
    await put(
      owner,
      agentId,
      [rule({ kind: "channel", id: "C1" }, { repositories: [gone] })],
      1,
    );
    await pool.query(
      "UPDATE catalog_repositories SET removed_at = now() WHERE id = $1",
      [gone],
    );
    // Same id, other case: a new target, so the dropped id counts as added.
    expect(
      await put(
        owner,
        agentId,
        [rule({ kind: "channel", id: "c1" }, { repositories: [gone] })],
        2,
      ),
    ).toEqual({ outcome: "repository_not_in_catalog", repositoryIds: [gone] });
    // Both stay as two rules, each keeping what it holds.
    const both = await put(
      owner,
      agentId,
      [
        rule({ kind: "channel", id: "C1" }, { repositories: [gone] }),
        rule({ kind: "channel", id: "c1" }, { repositories: [live] }),
      ],
      2,
    );
    expect(both).toMatchObject({ outcome: "set", limits: { revision: 3 } });
    expect(both.outcome === "set" && both.limits.rules).toHaveLength(2);
  });

  test("an edit leaves a person's rule as it is, and the reader sees it", async () => {
    const { agentId, owner, workspaceId, managing } = await cast();
    await pool.query(
      "INSERT INTO agent_caller_limits (agent_id, workspace_id, target_kind, user_id, tools_deny) VALUES ($1, $2, 'user', $3, '{x}')",
      [agentId, workspaceId, idOf(owner)],
    );
    expect(await limits().get(workspaceId, agentId)).toEqual({
      rules: [],
      revision: 1,
    });
    await put(owner, agentId, [rule({ kind: "team", id: managing })], 1);
    await put(owner, agentId, [], 2);
    const read = await callerLimitsOf(db, {
      workspaceId,
      agentId,
      lock: false,
    });
    expect(read).toEqual({
      rules: [
        rule({ kind: "user", id: idOf(owner) } as never, { tools_deny: ["x"] }),
      ],
      revision: 3,
    });
    expect(
      await db.transaction((tx) =>
        callerLimitsOf(tx, { workspaceId, agentId, lock: true }),
      ),
    ).toEqual(read);
  });

  test("archiving a team deletes its rules, moves only the revisions of agents that had one, and makes an earlier If-Match stale", async () => {
    const { agentId, owner, managing } = await cast();
    const doomed = await newTeam(owner);
    const bystander = (
      await agentService().createAgent(owner, {
        slug: `agent-${randomUUID().slice(0, 8)}`,
        name: "b",
        card,
        managing_team_id: managing,
      })
    ).agent.id;
    const unrelated = (
      await agentService().createAgent(owner, {
        slug: `agent-${randomUUID().slice(0, 8)}`,
        name: "c",
        card,
        managing_team_id: managing,
      })
    ).agent.id;
    await put(
      owner,
      agentId,
      [
        rule({ kind: "team", id: managing }, { tools_deny: ["keep"] }),
        rule({ kind: "team", id: doomed }),
        rule({ kind: "channel", id: "C1" }),
      ],
      1,
    );
    await put(owner, bystander, [rule({ kind: "team", id: doomed })], 1);
    await put(owner, unrelated, [rule({ kind: "workspace" })], 1);
    const readAt = (await limits().get(owner.ownerId, agentId))?.revision;
    expect(readAt).toBe(2);

    const archived = await teams().delete({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: doomed,
    });
    expect(archived).toEqual({ outcome: "deleted" });
    expect(await rowsOf(agentId)).toEqual([
      { target_kind: "channel", team_id: null },
      { target_kind: "team", team_id: managing },
    ]);
    expect(await rowsOf(bystander)).toEqual([]);
    expect(await revisionOf(agentId)).toEqual({
      limits_revision: 3,
      revision: 1,
    });
    expect(await revisionOf(bystander)).toEqual({
      limits_revision: 3,
      revision: 1,
    });
    // No rule for the team: nothing moved.
    expect(await revisionOf(unrelated)).toEqual({
      limits_revision: 2,
      revision: 1,
    });

    // The PUT that read before the archive is stale.
    expect(await put(owner, agentId, [], readAt ?? 0)).toEqual({
      outcome: "version_mismatch",
      current: 3,
    });
    expect(
      (
        await pool.query(
          "SELECT result FROM receipts WHERE operation = 'delete_team' AND target_ref->'resource'->>'id' = $1",
          [doomed],
        )
      ).rows[0]?.result.limits_agent_ids.sort(),
    ).toEqual([agentId, bystander].sort());
  });

  test("archive and PUT together: no deadlock, and the end state agrees with whoever won", async () => {
    const { agentId, owner } = await cast();
    for (let round = 0; round < 12; round++) {
      const team = await newTeam(owner);
      const before =
        (await limits().get(owner.ownerId, agentId))?.revision ?? 0;
      const [archived, edited] = await Promise.all([
        teams().delete({
          actor: acting(owner),
          receiptId: randomUUID(),
          teamId: team,
        }),
        put(owner, agentId, [rule({ kind: "team", id: team })], before),
      ]);
      // The archive always wins in the end: no rule may name a dead team.
      expect(archived.outcome).toBe("deleted");
      expect(["set", "team_not_found"]).toContain(edited.outcome);
      expect(
        (await rowsOf(agentId)).filter((row) => row.team_id === team),
      ).toEqual([]);
      const after = (await limits().get(owner.ownerId, agentId))?.revision ?? 0;
      // Edited first: +1 for the edit, +1 for the archive. Archive first: no change.
      expect(after).toBe(edited.outcome === "set" ? before + 2 : before);
    }
  }, 60_000);

  test("an archive that finds a rule added while it waited for the team row restarts and deletes it", async () => {
    const { agentId, owner } = await cast();
    const team = await newTeam(owner);
    const before = (await limits().get(owner.ownerId, agentId))?.revision ?? 0;
    // Hold the team row so the archive queues behind it after naming no agent.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM member_teams WHERE id = $1 FOR UPDATE",
        [team],
      );
      const archive = teams().delete({
        actor: acting(owner),
        receiptId: randomUUID(),
        teamId: team,
      });
      await Bun.sleep(300);
      // A rule for the team lands while the archive waits: the editor reads
      // the team share-locked behind the holder, so it commits only after.
      await holder.query(
        "INSERT INTO agent_caller_limits (agent_id, workspace_id, target_kind, team_id) VALUES ($1, $2, 'team', $3)",
        [agentId, owner.ownerId, team],
      );
      await holder.query(
        "UPDATE agent_usage SET limits_revision = limits_revision + 1 WHERE agent_id = $1",
        [agentId],
      );
      await holder.query("COMMIT");
      expect(await archive).toEqual({ outcome: "deleted" });
    } finally {
      holder.release();
    }
    expect(
      (await rowsOf(agentId)).filter((row) => row.team_id === team),
    ).toEqual([]);
    expect((await limits().get(owner.ownerId, agentId))?.revision).toBe(
      before + 2,
    );
  }, 30_000);
});
