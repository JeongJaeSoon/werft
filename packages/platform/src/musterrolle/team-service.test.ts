import { describe, expect, test } from "bun:test";
import {
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  AgentAdminStore,
  AgentAdminSubject,
} from "../ports/agent-admin-store.ts";
import type { DecisionLog } from "../ports/decision-log.ts";
import type { Team, TeamStore } from "../ports/team-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createAgentAdminService } from "./agent-admin-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import { createTeamService } from "./team-service.ts";

// Design 4.7 and D23: only an owner or an admin changes a team. An agent's
// admin — directly or through a team — and a team's own members do not.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const TEAM = "019a0000-0000-7000-8000-00000000b0a1";
const PAGE = { limit: 50 };
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
  agent_admin: "019a0000-0000-7000-8000-0000000000c4",
  team_member: "019a0000-0000-7000-8000-0000000000c5",
} as const;
type Who = keyof typeof USERS;
const ROLE: Record<Who, WorkspaceRole> = {
  owner: "owner",
  admin: "admin",
  member: "member",
  agent_admin: "member",
  team_member: "member",
};

// The team member administers AGENT through TEAM; the agent admin directly.
const agents: AgentAuthority = {
  async agentOf(_workspaceId, resource) {
    return resource.kind === "agent" ? resource.id : null;
  },
  async isAdmin(_workspaceId, agentId, userId) {
    return (
      agentId === AGENT &&
      (userId === USERS.agent_admin || userId === USERS.team_member)
    );
  },
};

function caller(who: Who): Caller {
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role: ROLE[who],
    scopes: [...scopesForRole(ROLE[who])],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
}

function keyCaller(): Caller {
  return callerFor(
    {
      kind: "api_key",
      id: "019a0000-0000-7000-8000-0000000000f1",
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      scopes: ["sessions:read"],
    },
    { kind: "api" },
    crypto.randomUUID(),
  );
}

const TEAM_ROW: Team = {
  id: TEAM,
  workspaceId: WORKSPACE,
  name: "research",
  createdBy: USERS.owner,
  createdAt: new Date("2026-10-11T00:00:00Z"),
  revision: 1,
  memberCount: 1,
};

function recordingStore() {
  const calls: string[] = [];
  const store: TeamStore = {
    async create(input) {
      calls.push(`create:${input.actor.userId}`);
      return { outcome: "created", team: { ...TEAM_ROW, name: input.name } };
    },
    async rename(input) {
      calls.push(`rename:${input.actor.userId}`);
      return { outcome: "renamed", team: { ...TEAM_ROW, name: input.name } };
    },
    async delete(input) {
      calls.push(`delete:${input.actor.userId}`);
      return { outcome: "deleted" };
    },
    async addMember(input) {
      calls.push(`add:${input.userId}`);
      return { outcome: "added", team: TEAM_ROW };
    },
    async removeMember(input) {
      calls.push(`remove:${input.userId}`);
      return { outcome: "removed", team: TEAM_ROW };
    },
    async setMemberRole(input) {
      calls.push(`role:${input.userId}:${input.role}`);
      return { outcome: "changed", team: TEAM_ROW };
    },
    async list(_workspaceId, query) {
      calls.push(`list:${JSON.stringify(query)}`);
      return { items: [TEAM_ROW], nextCursor: "next" };
    },
    async get() {
      return { ...TEAM_ROW, members: [] };
    },
    async listJoined(workspaceId, userId, query) {
      calls.push(`joined:${workspaceId}:${userId}:${JSON.stringify(query)}`);
      return { items: [{ ...TEAM_ROW, role: "lead" }], nextCursor: null };
    },
    async isMember(workspaceId, teamId, userId) {
      return (
        workspaceId === WORKSPACE &&
        teamId === TEAM &&
        userId === USERS.team_member
      );
    },
  };
  return { store, calls };
}

function services() {
  const recorded: { action: string; outcome: string; reason: string }[] = [];
  const decisions: DecisionLog = {
    async record({ request, decision }) {
      recorded.push({
        action: request.action,
        outcome: decision.outcome,
        reason: decision.reason_code,
      });
    },
  };
  const authorization = createAuthorizationPolicy({ agents, decisions });
  const { store, calls } = recordingStore();
  return {
    teams: createTeamService({ authorization, store }),
    authorization,
    calls,
    recorded,
  };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  return "allowed";
}

const CHANGES = {
  create: (s: ReturnType<typeof services>, c: Caller) =>
    s.teams.createTeam(c, { name: "new" }),
  rename: (s: ReturnType<typeof services>, c: Caller) =>
    s.teams.renameTeam(c, TEAM, { name: "renamed" }),
  delete: (s: ReturnType<typeof services>, c: Caller) =>
    s.teams.deleteTeam(c, TEAM),
  add: (s: ReturnType<typeof services>, c: Caller) =>
    s.teams.addTeamMember(c, TEAM, USERS.member),
  remove: (s: ReturnType<typeof services>, c: Caller) =>
    s.teams.removeTeamMember(c, TEAM, USERS.team_member),
};

describe("team.manage by role (design 4.1, D23)", () => {
  for (const [name, run] of Object.entries(CHANGES)) {
    for (const who of ["owner", "admin"] as const) {
      test(`${who} may ${name} a team`, async () => {
        const s = services();
        expect(await refusal(run(s, caller(who)))).toBe("allowed");
        expect(s.calls).toHaveLength(1);
        // A management action is recorded even when it is allowed.
        expect(s.recorded).toEqual([
          { action: "team.manage", outcome: "allow", reason: "ok" },
        ]);
      });
    }
    for (const who of ["member", "agent_admin", "team_member"] as const) {
      test(`${who} may not ${name} a team`, async () => {
        const s = services();
        expect(await refusal(run(s, caller(who)))).toEqual({
          code: "FORBIDDEN",
          details: { reason_code: "role" },
        });
        expect(s.calls).toEqual([]);
        expect(s.recorded).toEqual([
          { action: "team.manage", outcome: "deny", reason: "role" },
        ]);
      });
    }
    test(`an API key may not ${name} a team`, async () => {
      const s = services();
      expect(await refusal(run(s, keyCaller()))).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(s.calls).toEqual([]);
    });
  }

  test("reading teams is the same right", async () => {
    const s = services();
    expect(
      await refusal(s.teams.listTeams(caller("member"), PAGE)),
    ).toMatchObject({
      code: "FORBIDDEN",
    });
    const page = await s.teams.listTeams(caller("admin"), {
      limit: 2,
      cursor: "c",
    });
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBe("next");
    expect(s.calls).toContain(
      `list:${JSON.stringify({ limit: 2, cursor: "c" })}`,
    );
    expect(await s.teams.getTeam(caller("owner"), TEAM)).toMatchObject({
      id: TEAM,
      members: [],
    });
  });

  test("a store refusal maps to the API's codes", async () => {
    const { store } = recordingStore();
    const authorization = createAuthorizationPolicy({ agents });
    const teams = createTeamService({
      authorization,
      store: {
        ...store,
        async create() {
          return { outcome: "name_taken" };
        },
        async addMember() {
          return { outcome: "not_member" };
        },
        async removeMember() {
          return { outcome: "actor_inactive" };
        },
        async setMemberRole() {
          return { outcome: "member_disabled" };
        },
        async rename() {
          return { outcome: "unchanged", team: TEAM_ROW };
        },
      },
    });
    const owner = caller("owner");
    expect(await refusal(teams.createTeam(owner, { name: "x" }))).toMatchObject(
      { code: "ALREADY_EXISTS" },
    );
    expect(
      await refusal(teams.addTeamMember(owner, TEAM, USERS.member)),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await refusal(teams.removeTeamMember(owner, TEAM, USERS.member)),
    ).toEqual({ code: "FORBIDDEN", details: { reason_code: "role" } });
    expect(
      await refusal(
        teams.setTeamMemberRole(owner, TEAM, USERS.member, { role: "lead" }),
      ),
    ).toMatchObject({ code: "MEMBER_DISABLED" });
    expect(
      await teams.renameTeam(owner, TEAM, { name: "research" }),
    ).toMatchObject({ receipt_id: null });
  });
});

test("a disabled member's removal from a team is MEMBER_DISABLED", async () => {
  const { store } = recordingStore();
  const teams = createTeamService({
    authorization: createAuthorizationPolicy({ agents }),
    store: {
      ...store,
      async removeMember() {
        return { outcome: "member_disabled" };
      },
    },
  });
  expect(
    await refusal(teams.removeTeamMember(caller("owner"), TEAM, USERS.member)),
  ).toMatchObject({ code: "MEMBER_DISABLED" });
});

describe("agent.admin.manage by role (design 4.1)", () => {
  function agentAdmins() {
    const changed: AgentAdminSubject[] = [];
    const store: AgentAdminStore = {
      async list() {
        return { users: [], teams: [] };
      },
      async add(input) {
        changed.push(input.subject);
        return { outcome: "added", admins: { users: [], teams: [] } };
      },
      async remove(input) {
        changed.push(input.subject);
        return { outcome: "removed", admins: { users: [], teams: [] } };
      },
      async setManagingTeam() {
        return { outcome: "not_found" };
      },
      async listAdministered() {
        return [];
      },
    };
    const service = createAgentAdminService({
      authorization: createAuthorizationPolicy({ agents }),
      store,
    });
    return { service, changed };
  }

  for (const who of ["owner", "admin"] as const) {
    test(`${who} may name a team the agent's admin`, async () => {
      const { service, changed } = agentAdmins();
      const result = await service.addAgentAdmin(
        caller(who),
        AGENT,
        "teams",
        TEAM,
      );
      expect(result.receipt_id).not.toBeNull();
      expect(changed).toEqual([{ kind: "team", id: TEAM }]);
    });
  }

  // 94S-837: a team lends every member to the agent, so naming one is for
  // the people who manage teams. The agent's admin only takes one off.
  for (const who of ["agent_admin", "team_member"] as const) {
    test(`${who} is refused naming a team, and may still take one off or name a person`, async () => {
      const { service, changed } = agentAdmins();
      expect(
        await refusal(service.addAgentAdmin(caller(who), AGENT, "teams", TEAM)),
      ).toEqual({ code: "FORBIDDEN", details: { reason_code: "role" } });
      expect(changed).toEqual([]);

      await service.removeAgentAdmin(caller(who), AGENT, "teams", TEAM);
      await service.addAgentAdmin(caller(who), AGENT, "users", USERS.member);
      expect(changed).toEqual([
        { kind: "team", id: TEAM },
        { kind: "user", id: USERS.member },
      ]);
    });
  }

  test("the store is asked against the team.manage roles for a team, agent.admin.manage for the rest", async () => {
    const asked: Array<readonly string[]> = [];
    const service = createAgentAdminService({
      authorization: createAuthorizationPolicy({ agents }),
      store: {
        async list() {
          return { users: [], teams: [] };
        },
        async add(input) {
          asked.push(input.managerRoles);
          return { outcome: "added", admins: { users: [], teams: [] } };
        },
        async remove() {
          return { outcome: "removed", admins: { users: [], teams: [] } };
        },
        async setManagingTeam() {
          return { outcome: "not_found" };
        },
        async listAdministered() {
          return [];
        },
      },
    });
    await service.addAgentAdmin(caller("admin"), AGENT, "teams", TEAM);
    await service.addAgentAdmin(caller("admin"), AGENT, "users", USERS.member);
    // Both lists are ["owner", "admin"] today, so identity is what tells the
    // two policies apart.
    expect(asked[0]).toBe(MANAGEMENT_ROLES["team.manage"]);
    expect(asked[1]).toBe(MANAGEMENT_ROLES["agent.admin.manage"]);
  });

  test("a role lost after the check is refused by the store as team_not_allowed", async () => {
    const service = createAgentAdminService({
      authorization: createAuthorizationPolicy({ agents }),
      store: {
        async list() {
          return { users: [], teams: [] };
        },
        async add() {
          return { outcome: "team_not_allowed" };
        },
        async remove() {
          return { outcome: "removed", admins: { users: [], teams: [] } };
        },
        async setManagingTeam() {
          return { outcome: "not_found" };
        },
        async listAdministered() {
          return [];
        },
      },
    });
    expect(
      await refusal(
        service.addAgentAdmin(caller("admin"), AGENT, "teams", TEAM),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "team_not_allowed" },
    });
  });

  test("a plain member may not, and an agent's admin only on that agent", async () => {
    const { service, changed } = agentAdmins();
    expect(
      await refusal(
        service.addAgentAdmin(caller("member"), AGENT, "users", USERS.member),
      ),
    ).toEqual({ code: "FORBIDDEN", details: { reason_code: "role" } });
    const other = "019a0000-0000-7000-8000-00000000a0b1";
    expect(
      await refusal(
        service.removeAgentAdmin(caller("agent_admin"), other, "teams", TEAM),
      ),
    ).toEqual({ code: "FORBIDDEN", details: { reason_code: "role" } });
    expect(changed).toEqual([]);
  });

  test("only a person lists the agents they administer", async () => {
    const { service } = agentAdmins();
    expect(await service.listAdministeredAgents(caller("member"))).toEqual({
      items: [],
    });
    expect(
      await refusal(service.listAdministeredAgents(keyCaller())),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a team's own members read it (94S-719)", () => {
  test("a member of the team reads it, asking no policy", async () => {
    const s = services();
    expect(await s.teams.getTeam(caller("team_member"), TEAM)).toMatchObject({
      id: TEAM,
      members: [],
    });
    expect(s.recorded).toEqual([]);
  });

  test("anyone else is refused as before: another team, a plain member, an API key", async () => {
    const other = "019a0000-0000-7000-8000-00000000b0b1";
    for (const [who, teamId] of [
      [caller("team_member"), other],
      [caller("member"), TEAM],
      [caller("agent_admin"), TEAM],
      [keyCaller(), TEAM],
    ] as const) {
      const s = services();
      expect(await refusal(s.teams.getTeam(who, teamId))).toMatchObject({
        code: "FORBIDDEN",
      });
    }
    const s = services();
    await refusal(s.teams.getTeam(caller("member"), TEAM));
    expect(s.recorded).toEqual([
      { action: "team.manage", outcome: "deny", reason: "role" },
    ]);
  });
});

describe("one's own teams", () => {
  test("any signed-in person reads their own, names only, asking no policy", async () => {
    const s = services();
    expect(await s.teams.listMyTeams(caller("member"), PAGE)).toEqual({
      items: [{ id: TEAM_ROW.id, name: TEAM_ROW.name, role: "lead" }],
      next_cursor: null,
    });
    expect(s.calls).toEqual([
      `joined:${WORKSPACE}:${USERS.member}:${JSON.stringify(PAGE)}`,
    ]);
    expect(s.recorded).toEqual([]);
  });

  test("an API key belongs to no team", async () => {
    const s = services();
    expect(await refusal(s.teams.listMyTeams(keyCaller(), PAGE))).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    });
    expect(s.calls).toEqual([]);
  });
});
