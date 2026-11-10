import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationRequest,
  type AuthorizationResource,
  authorizationDecisionSchema,
  type Principal,
  SESSION_SCOPE_VALUES,
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type IdentityReader,
} from "./policy.ts";

// Design 4.1, the role table: one row per action, one column per subject.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT_A = "019a0000-0000-7000-8000-00000000a0a1";
const AGENT_B = "019a0000-0000-7000-8000-00000000a0b1";
const SESSION_A = "019a0000-0000-7000-8000-00000000e0a1";
const SESSION_B = "019a0000-0000-7000-8000-00000000e0b1";
const SESSION_NONE = "019a0000-0000-7000-8000-00000000e0c1";
const KEY = "019a0000-0000-7000-8000-0000000000f1";
const OTHER_KEY = "019a0000-0000-7000-8000-0000000000f2";

const USERS: Record<WorkspaceRole | "agent_admin", string> = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
  agent_admin: "019a0000-0000-7000-8000-0000000000c4",
};

const AGENT_OF: Record<string, string> = {
  [SESSION_A]: AGENT_A,
  [SESSION_B]: AGENT_B,
};

// The agent admin is a member who administers AGENT_A only.
const agents: AgentAuthority = {
  async agentOf(_workspaceId, resource) {
    if (resource.kind === "agent") return resource.id;
    return AGENT_OF[resource.id] ?? null;
  },
  async isAdmin(workspaceId, agentId, userId) {
    return (
      workspaceId === WORKSPACE &&
      agentId === AGENT_A &&
      userId === USERS.agent_admin
    );
  },
};

function user(role: WorkspaceRole, id: string): Principal {
  return {
    kind: "user",
    id,
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
}

function key(
  scopes: readonly SessionScope[] = SESSION_SCOPE_VALUES,
): Principal {
  return {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopes],
  };
}

type Column =
  | "owner"
  | "admin"
  | "member"
  | "agent_admin"
  | "service_key"
  | "personal_key";
const COLUMNS: Column[] = [
  "owner",
  "admin",
  "member",
  "agent_admin",
  "service_key",
  "personal_key",
];

function subject(column: Column): { caller: Caller; identity: IdentityReader } {
  const plain: IdentityReader = {
    reread: async (s) => ({ status: "ok", principal: s.principal }),
  };
  switch (column) {
    case "owner":
    case "admin":
    case "member":
      return {
        caller: callerFor(user(column, USERS[column]), { kind: "web" }, "r"),
        identity: plain,
      };
    case "agent_admin":
      return {
        caller: callerFor(
          user("member", USERS.agent_admin),
          { kind: "web" },
          "r",
        ),
        identity: plain,
      };
    case "service_key":
      return {
        caller: callerFor(key(), { kind: "api" }, "r", { creatorId: null }),
        identity: plain,
      };
    case "personal_key":
      // An owner's personal key: still a key, so no management action.
      return {
        caller: callerFor(key(), { kind: "api" }, "r", {
          creatorId: USERS.owner,
        }),
        identity: {
          reread: async (s) => ({
            status: "ok",
            principal: s.principal,
            keyCreator: { userId: USERS.owner, role: "owner" },
          }),
        },
      };
  }
}

async function allowed(
  column: Column,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
): Promise<boolean> {
  const { caller, identity } = subject(column);
  const policy = createAuthorizationPolicy({ identity, agents });
  const request: AuthorizationRequest = {
    subject: caller.subject,
    action,
    resource: { ...resource, owner_scope: WORKSPACE },
    request_id: caller.requestId,
  };
  const decision = authorizationDecisionSchema.parse(
    await policy.authorize(request),
  );
  return decision.outcome === "allow";
}

const onWorkspace = { kind: "workspace", id: WORKSPACE } as const;
const onAgentA = { kind: "agent", id: AGENT_A } as const;

// o allowed, x refused. Columns: owner, admin, member, member + admin of
// AGENT_A, service key, personal key.
const TABLE: [
  string,
  AuthorizationAction,
  Omit<AuthorizationResource, "owner_scope">,
  string,
][] = [
  ["설정·비용 상한 변경", "workspace.manage", onWorkspace, "ooxxxx"],
  // That an admin cannot touch the owner role is the store's; see
  // invites.integration.test.ts.
  ["멤버 초대·역할 변경", "member.manage", onWorkspace, "ooxxxx"],
  ["Slack guest 사용 켜기·끄기", "workspace.manage", onWorkspace, "ooxxxx"],
  ["감사 보존 기간 변경", "audit_retention.manage", onWorkspace, "oxxxxx"],
  // 94S-762: figures summed over every owner, the owner's personal key
  // included in the refusal.
  [
    "설치 전체 사용량·한도 읽기",
    "usage.installation_read",
    onWorkspace,
    "oxxxxx",
  ],
  [
    "설치 설정 내보내기·가져오기",
    "installation.settings.manage",
    onWorkspace,
    "oxxxxx",
  ],
  ["팀 만들기·구성원 관리", "team.manage", onWorkspace, "ooxxxx"],
  ["모든 에이전트의 key 발급·폐기", "api_key.manage", onWorkspace, "ooxxxx"],
  ["그 에이전트의 key 발급·폐기", "api_key.manage", onAgentA, "ooxoxx"],
  ["개인 key 발급·폐기(자기 것)", "api_key.manage_own", onWorkspace, "ooooxx"],
  ["에이전트 만들기", "agent.create", onWorkspace, "ooooxx"],
  ["외부 계정 연결(자기 것)", "account.link", onWorkspace, "ooooxx"],
  ["정의 수정·release·활성화", "agent.manage", onAgentA, "ooxoxx"],
  ["도구 권한 정책 변경", "agent.manage", onAgentA, "ooxoxx"],
  ["자격 참조 연결·해제", "credential.bind", onAgentA, "ooxoxx"],
  [
    "워크스페이스 변수 읽기·쓰기·허락",
    "variable.workspace.manage",
    onWorkspace,
    "ooxxxx",
  ],
  ["그 에이전트의 변수 읽기·쓰기", "variable.agent.manage", onAgentA, "ooxoxx"],
  [
    "다른 에이전트의 변수 (에이전트 admin)",
    "variable.agent.manage",
    { kind: "agent", id: AGENT_B },
    "ooxxxx",
  ],
  ["에이전트 관리자 지정", "agent.admin.manage", onAgentA, "ooxoxx"],
  ["Slack 앱 설치·채널 설정", "binding.manage", onAgentA, "ooxoxx"],
  ["그 에이전트의 사용량 읽기", "usage.agent_read", onAgentA, "ooxoxx"],
  ["에이전트 보관", "agent.manage", onAgentA, "ooxoxx"],
  [
    "성과 구분·type·규칙·판정 설정 읽기",
    "workspace.read",
    onWorkspace,
    "ooooxo",
  ],
  [
    "성과 규칙·판정 설정 관리",
    "achievement_rule.manage",
    onWorkspace,
    "ooxxxx",
  ],
  ["그 에이전트의 성과 확인·거절", "achievement.review", onAgentA, "ooxoxx"],
  ["보관한 에이전트 되살리기", "agent.restore", onAgentA, "oxxxxx"],
  // Every agent, across the workspace, is the roles' alone.
  ["모든 에이전트 관리", "agent.manage", onWorkspace, "ooxxxx"],
  // agent-rbac (b): every member finds agents; a personal key as its
  // creator, an agent key only its own row through session.submit.
  ["에이전트 목록·개수", "agent.read", onWorkspace, "ooooxo"],
  ["에이전트 정보 읽기", "agent.read", onAgentA, "ooooxo"],
  ["에이전트 설정 읽기", "agent.settings_read", onAgentA, "ooxoxo"],
  [
    "복구 결정",
    "session.recover",
    { kind: "session", id: SESSION_A },
    "oxxxoo",
  ],
];

describe("design 4.1 role table", () => {
  for (const [row, action, resource, cells] of TABLE) {
    test(`${row} (${action} on ${resource.kind})`, async () => {
      const got = await Promise.all(
        COLUMNS.map(async (column) =>
          (await allowed(column, action, resource)) ? "o" : "x",
        ),
      );
      expect(got.join("")).toBe(cells);
    });
  }

  test("an agent's admin manages that agent and no other", async () => {
    for (const action of [
      "agent.manage",
      "credential.bind",
      "agent.admin.manage",
      "binding.manage",
      "api_key.manage",
      "achievement.review",
    ] as const) {
      expect(await allowed("agent_admin", action, onAgentA)).toBe(true);
      expect(
        await allowed("agent_admin", action, { kind: "agent", id: AGENT_B }),
      ).toBe(false);
    }
  });

  test("an admin holds a member's session scopes: everything but recovery", () => {
    expect(scopesForRole("admin")).toEqual(scopesForRole("member"));
    expect(scopesForRole("admin")).not.toContain("sessions:recover");
  });
});

describe("a service key bound to an agent", () => {
  const bound: IdentityReader = {
    reread: async (s) => ({
      status: "ok",
      principal: s.principal,
      keyAgentId: AGENT_A.toUpperCase(),
    }),
  };
  const caller = callerFor(key(), { kind: "api" }, "r", { creatorId: null });
  const policy = createAuthorizationPolicy({ identity: bound, agents });

  async function decide(
    action: AuthorizationAction,
    resource: Omit<AuthorizationResource, "owner_scope">,
  ) {
    return authorizationDecisionSchema.parse(
      await policy.authorize({
        subject: caller.subject,
        action,
        resource: { ...resource, owner_scope: WORKSPACE },
        request_id: "r",
      }),
    );
  }

  test("reaches its agent's sessions and refuses another's", async () => {
    expect(
      await decide("session.read", { kind: "session", id: SESSION_A }),
    ).toMatchObject({ outcome: "allow" });
    expect(
      await decide("session.read", { kind: "session", id: SESSION_B }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
    expect(
      await decide("session.control", { kind: "session", id: SESSION_NONE }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
  });

  test("creates a session only on its own agent", async () => {
    expect(
      await decide("session.submit", {
        kind: "session",
        id: null,
        agent_id: AGENT_A,
      }),
    ).toMatchObject({ outcome: "allow" });
    expect(
      await decide("session.submit", {
        kind: "session",
        id: null,
        agent_id: AGENT_B,
      }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
    // A list, or a session that names no agent, is refused.
    expect(
      await decide("session.submit", { kind: "session", id: null }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
  });

  test("approves its own agent's sessions, never one it started itself (GA-8)", async () => {
    let startedBy: string | null = OTHER_KEY;
    const approving = createAuthorizationPolicy({
      identity: bound,
      agents,
      sessions: {
        visibleTo: async () => true,
        originOf: async () => ({
          creatorUserId: null,
          creatorApiKeyId: startedBy,
        }),
      },
    });
    const approve = async (id: string) =>
      authorizationDecisionSchema.parse(
        await approving.authorize({
          subject: caller.subject,
          action: "session.approve",
          resource: { kind: "session", id, owner_scope: WORKSPACE },
          request_id: "r",
        }),
      );
    expect(await approve(SESSION_A)).toMatchObject({ outcome: "allow" });
    expect(await approve(SESSION_B)).toMatchObject({
      outcome: "deny",
      reason_code: "agent_ceiling",
    });
    startedBy = KEY.toUpperCase();
    const own = await approve(SESSION_A);
    expect(own).toMatchObject({
      outcome: "deny",
      reason_code: "self_approval",
    });
    expect(own.effective_scopes).toContain("sessions:approve");
  });

  test("with no session store to read who started it, approves nothing", async () => {
    expect(
      await decide("session.approve", { kind: "session", id: SESSION_A }),
    ).toMatchObject({ outcome: "deny", reason_code: "error" });
  });

  test("takes no management action, its own agent's included", async () => {
    for (const action of [
      "agent.manage",
      "api_key.manage",
      "credential.bind",
    ] as const) {
      expect(await decide(action, onAgentA)).toMatchObject({
        outcome: "deny",
        reason_code: "role",
      });
    }
  });
});

describe("the resource's agent", () => {
  test("a store that throws refuses", async () => {
    const policy = createAuthorizationPolicy({
      agents: {
        agentOf: async () => {
          throw new Error("connection terminated");
        },
        isAdmin: async () => {
          throw new Error("connection terminated");
        },
      },
    });
    const caller = callerFor(
      user("member", USERS.agent_admin),
      { kind: "web" },
      "r",
    );
    expect(
      await policy.authorize({
        subject: caller.subject,
        action: "agent.manage",
        resource: { ...onAgentA, owner_scope: WORKSPACE },
        request_id: "r",
      }),
    ).toMatchObject({ outcome: "deny", reason_code: "error" });
  });
});

describe("reading an agent: who is inside it (agent-rbac (b))", () => {
  // W: the owner. L: AGENT_A's admin. T: a member of its managing team.
  // O: a member outside it. AGENT_GONE is no agent at all.
  const TEAM_MEMBER = "019a0000-0000-7000-8000-0000000000c5";
  const AGENT_GONE = "019a0000-0000-7000-8000-00000000a0ff";
  const inside: AgentAuthority = {
    async agentOf(_workspaceId, resource) {
      return resource.kind === "agent" && resource.id !== AGENT_GONE
        ? resource.id
        : null;
    },
    isAdmin: agents.isAdmin,
    async isInside(workspaceId, agentId, userId) {
      return (
        (await agents.isAdmin(workspaceId, agentId, userId)) ||
        (agentId === AGENT_A && userId === TEAM_MEMBER)
      );
    },
  };
  const WHO = {
    W: user("owner", USERS.owner),
    L: user("member", USERS.agent_admin),
    T: user("member", TEAM_MEMBER),
    O: user("member", USERS.member),
  };

  async function reasons(
    action: AuthorizationAction,
    agentId: string,
    access: "use" | "view" | "none" = "use",
  ) {
    const policy = createAuthorizationPolicy({
      identity: {
        reread: async (s) => ({ status: "ok", principal: s.principal }),
      },
      agents: inside,
      outsideAgents: { access: async () => access },
    });
    const got: Record<string, string> = {};
    for (const [who, principal] of Object.entries(WHO)) {
      const caller = callerFor(principal, { kind: "web" }, "r");
      got[who] = (
        await policy.authorize({
          subject: caller.subject,
          action,
          resource: { kind: "agent", id: agentId, owner_scope: WORKSPACE },
          request_id: "r",
        })
      ).reason_code;
    }
    return got;
  }

  test("settings: W, L and T read them; O is refused", async () => {
    expect(await reasons("agent.settings_read", AGENT_A)).toEqual({
      W: "ok",
      L: "ok",
      T: "ok",
      O: "role",
    });
    // T only reads: changing the agent stays with W and L.
    expect(await reasons("agent.manage", AGENT_A)).toEqual({
      W: "ok",
      L: "ok",
      T: "role",
      O: "role",
    });
  });

  test("information: everyone while axis A shows agents to those outside", async () => {
    for (const access of ["use", "view"] as const) {
      expect(await reasons("agent.read", AGENT_A, access)).toEqual({
        W: "ok",
        L: "ok",
        T: "ok",
        O: "ok",
      });
    }
  });

  test("axis A none hides the agent from O, its settings included", async () => {
    const hidden = { W: "ok", L: "ok", T: "ok", O: "not_found" };
    expect(await reasons("agent.read", AGENT_A, "none")).toEqual(hidden);
    expect(await reasons("agent.settings_read", AGENT_A, "none")).toEqual(
      hidden,
    );
  });

  test("no such agent is not_found to everyone, the owner too", async () => {
    const gone = {
      W: "not_found",
      L: "not_found",
      T: "not_found",
      O: "not_found",
    };
    expect(await reasons("agent.read", AGENT_GONE)).toEqual(gone);
    expect(await reasons("agent.settings_read", AGENT_GONE)).toEqual(gone);
  });

  test("a personal key reads as its creator; an agent key reads no settings", async () => {
    const asCreator = (
      creator: string,
      keyAgentId?: string,
    ): IdentityReader => ({
      reread: async (s) => ({
        status: "ok",
        principal: s.principal,
        keyCreator: { userId: creator, role: "member" },
        ...(keyAgentId === undefined ? {} : { keyAgentId }),
      }),
    });
    const decide = async (creator: string, keyAgentId?: string) => {
      const policy = createAuthorizationPolicy({
        identity: asCreator(creator, keyAgentId),
        agents: inside,
      });
      const caller = callerFor(key(), { kind: "api" }, "r", {
        creatorId: creator,
      });
      return (
        await policy.authorize({
          subject: caller.subject,
          action: "agent.settings_read",
          resource: { ...onAgentA, owner_scope: WORKSPACE },
          request_id: "r",
        })
      ).reason_code;
    };
    expect(await decide(TEAM_MEMBER)).toBe("ok");
    expect(await decide(USERS.member)).toBe("role");
    expect(await decide(TEAM_MEMBER, AGENT_A)).toBe("role");
  });

  test("an allowed read is not recorded; a refused one is", async () => {
    const recorded: string[] = [];
    const policy = createAuthorizationPolicy({
      identity: {
        reread: async (s) => ({ status: "ok", principal: s.principal }),
      },
      agents: inside,
      decisions: {
        record: async ({ decision }) => {
          recorded.push(decision.reason_code);
        },
      },
    });
    for (const principal of [WHO.T, WHO.O]) {
      const caller = callerFor(principal, { kind: "web" }, "r");
      await policy.authorize({
        subject: caller.subject,
        action: "agent.settings_read",
        resource: { ...onAgentA, owner_scope: WORKSPACE },
        request_id: "r",
      });
    }
    expect(recorded).toEqual(["role"]);
  });
});

describe("starting a session: axis A (agent-rbac (b))", () => {
  const TEAM_MEMBER = "019a0000-0000-7000-8000-0000000000c5";
  const RELEASE = "019a0000-0000-7000-8000-00000000d0a1";
  const inside: AgentAuthority = {
    ...agents,
    async isInside(workspaceId, agentId, userId) {
      return (
        (await agents.isAdmin(workspaceId, agentId, userId)) ||
        (agentId === AGENT_A && userId === TEAM_MEMBER)
      );
    },
    async agentOfRelease() {
      return AGENT_A;
    },
  };
  const start = { kind: "session", id: null, agent_id: AGENT_A } as const;

  async function reason(
    principal: Principal,
    access: "use" | "view" | "none",
    options: {
      resource?: Omit<AuthorizationResource, "owner_scope">;
      keyCreator?: { userId: string; role: WorkspaceRole };
      keyAgentId?: string;
    } = {},
  ) {
    const policy = createAuthorizationPolicy({
      identity: {
        reread: async (s) => ({
          status: "ok",
          principal: s.principal,
          ...(options.keyCreator ? { keyCreator: options.keyCreator } : {}),
          ...(options.keyAgentId ? { keyAgentId: options.keyAgentId } : {}),
        }),
      },
      agents: inside,
      credentials: { unboundRefs: async () => [] },
      outsideAgents: { access: async () => access },
    });
    const caller = callerFor(
      principal,
      { kind: principal.kind === "user" ? "web" : "api" },
      "r",
      principal.kind === "api_key"
        ? { creatorId: options.keyCreator?.userId ?? null }
        : undefined,
    );
    return (
      await policy.authorize({
        subject: caller.subject,
        action: "session.submit",
        resource: {
          ...(options.resource ?? { ...start, release_id: RELEASE }),
          owner_scope: WORKSPACE,
        },
        request_id: "r",
      })
    ).reason_code;
  }

  const WHO = {
    W: user("admin", USERS.admin),
    L: user("member", USERS.agent_admin),
    T: user("member", TEAM_MEMBER),
    O: user("member", USERS.member),
  };

  test("use: everyone starts it; view and none: only those inside", async () => {
    const expected = {
      use: { W: "ok", L: "ok", T: "ok", O: "ok" },
      view: { W: "ok", L: "ok", T: "ok", O: "role" },
      none: { W: "ok", L: "ok", T: "ok", O: "role" },
    };
    for (const access of ["use", "view", "none"] as const) {
      const got: Record<string, string> = {};
      for (const [who, principal] of Object.entries(WHO)) {
        got[who] = await reason(principal, access);
      }
      expect(got, access).toEqual(expected[access]);
    }
  });

  test("a personal key starts as its creator; an agent key is inside its agent; a key with neither is outside", async () => {
    expect(
      await reason(key(), "view", {
        keyCreator: { userId: TEAM_MEMBER, role: "member" },
      }),
    ).toBe("ok");
    expect(
      await reason(key(), "view", {
        keyCreator: { userId: USERS.member, role: "member" },
      }),
    ).toBe("role");
    expect(await reason(key(), "none", { keyAgentId: AGENT_A })).toBe("ok");
    expect(await reason(key(), "view")).toBe("role");
    expect(await reason(key(), "use")).toBe("ok");
  });

  test("a message to a session already started is not a start", async () => {
    expect(
      await reason(WHO.O, "none", {
        resource: { kind: "session", id: SESSION_A },
      }),
    ).toBe("ok");
  });
});
