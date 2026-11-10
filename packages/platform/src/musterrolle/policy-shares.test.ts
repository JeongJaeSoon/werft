import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizationResource,
  authorizationDecisionSchema,
  type Principal,
  SESSION_SCOPE_VALUES,
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { createPendingRequestService } from "../decision/pending-service.ts";
import type { DecisionLog } from "../ports/decision-log.ts";
import type { PendingRequestStore } from "../ports/pending-requests.ts";
import type { SessionViewer } from "../ports/session-share-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type IdentityReader,
  type SessionAccess,
} from "./policy.ts";

// Design 4.6 and A.3 step 2: a session outside its share does not exist,
// save for what a manager does with a reason.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT_A = "019a0000-0000-7000-8000-00000000a0a1";
const KEY = "019a0000-0000-7000-8000-0000000000f1";
const OTHER_KEY = "019a0000-0000-7000-8000-0000000000f2";

const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  creator: "019a0000-0000-7000-8000-0000000000c3",
  member: "019a0000-0000-7000-8000-0000000000c4",
  agent_admin: "019a0000-0000-7000-8000-0000000000c5",
} as const;

// A person's private session and a service key's private session, both on
// AGENT_A; the agent admin administers AGENT_A.
const PERSONS = "019a0000-0000-7000-8000-00000000e0a1";
const KEYS = "019a0000-0000-7000-8000-00000000e0b1";
const OPEN = "019a0000-0000-7000-8000-00000000e0c1";
// The creator's sessions shared with the workspace and with a team of the
// member, the agent admin and the admin; a service key's shared with the
// workspace.
const CREATORS_OPEN = "019a0000-0000-7000-8000-00000000e0d1";
const CREATORS_TEAM = "019a0000-0000-7000-8000-00000000e0e1";
const KEYS_OPEN = "019a0000-0000-7000-8000-00000000e0f1";
const TEAM: readonly string[] = [USERS.member, USERS.agent_admin, USERS.admin];

const ORIGIN: Record<string, { creatorUserId: string | null; key: string }> = {
  [PERSONS]: { creatorUserId: USERS.creator, key: KEY },
  [KEYS]: { creatorUserId: null, key: KEY },
  [OPEN]: { creatorUserId: USERS.member, key: KEY },
  [CREATORS_OPEN]: { creatorUserId: USERS.creator, key: KEY },
  [CREATORS_TEAM]: { creatorUserId: USERS.creator, key: KEY },
  [KEYS_OPEN]: { creatorUserId: null, key: KEY },
};

const sessions: SessionAccess = {
  async visibleTo(_ownerId, sessionId, viewer: SessionViewer) {
    const origin = ORIGIN[sessionId];
    if (!origin) return false;
    if ([OPEN, CREATORS_OPEN, KEYS_OPEN].includes(sessionId)) return true;
    if (
      sessionId === CREATORS_TEAM &&
      viewer.userId !== null &&
      TEAM.includes(viewer.userId)
    ) {
      return true;
    }
    if (origin.creatorUserId !== null) {
      return viewer.userId === origin.creatorUserId;
    }
    return viewer.apiKeyId === origin.key;
  },
  async originOf(_ownerId, sessionId) {
    const origin = ORIGIN[sessionId];
    return origin
      ? { creatorUserId: origin.creatorUserId, creatorApiKeyId: origin.key }
      : null;
  },
};

const agents: AgentAuthority = {
  async agentOf(_workspaceId, resource) {
    return resource.kind === "agent" || ORIGIN[resource.id] ? AGENT_A : null;
  },
  async isAdmin(_workspaceId, agentId, userId) {
    return agentId === AGENT_A && userId === USERS.agent_admin;
  },
};

type Who =
  | "owner"
  | "admin"
  | "creator"
  | "member"
  | "agent_admin"
  | "service_key"
  | "other_key"
  | "creators_key";

const ROLES: Record<keyof typeof USERS, WorkspaceRole> = {
  owner: "owner",
  admin: "admin",
  creator: "member",
  member: "member",
  agent_admin: "member",
};

function key(id: string, scopes: readonly SessionScope[]): Principal {
  return {
    kind: "api_key",
    id,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopes],
  };
}

function subject(
  who: Who,
  scopes: readonly SessionScope[] = SESSION_SCOPE_VALUES,
): { caller: Caller; identity: IdentityReader } {
  const plain: IdentityReader = {
    reread: async (s) => ({ status: "ok", principal: s.principal }),
  };
  switch (who) {
    case "service_key":
    case "other_key":
      return {
        caller: callerFor(
          key(who === "service_key" ? KEY : OTHER_KEY, scopes),
          { kind: "api" },
          "r",
          { creatorId: null },
        ),
        identity: plain,
      };
    case "creators_key":
      return {
        caller: callerFor(key(OTHER_KEY, scopes), { kind: "api" }, "r", {
          creatorId: USERS.creator,
        }),
        identity: {
          reread: async (s) => ({
            status: "ok",
            principal: s.principal,
            keyCreator: { userId: USERS.creator, role: "member" },
          }),
        },
      };
    default: {
      const role = ROLES[who];
      return {
        caller: callerFor(
          {
            kind: "user",
            id: USERS[who],
            workspace_id: WORKSPACE,
            role,
            scopes: [...scopesForRole(role)],
          },
          { kind: "web" },
          "r",
        ),
        identity: plain,
      };
    }
  }
}

async function decide(
  who: Who,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  options: {
    justification?: string;
    scopes?: readonly SessionScope[];
    decisions?: DecisionLog;
  } = {},
): Promise<AuthorizationDecision> {
  const { caller, identity } = subject(who, options.scopes);
  const policy = createAuthorizationPolicy({
    identity,
    agents,
    sessions,
    ...(options.decisions ? { decisions: options.decisions } : {}),
  });
  const request: AuthorizationRequest = {
    subject: {
      ...caller.subject,
      ...(options.justification === undefined
        ? {}
        : { justification: options.justification }),
    },
    action,
    resource: { ...resource, owner_scope: WORKSPACE },
    request_id: caller.requestId,
  };
  return authorizationDecisionSchema.parse(await policy.authorize(request));
}

const reason = async (...args: Parameters<typeof decide>) =>
  (await decide(...args)).reason_code;
const on = (id: string) => ({ kind: "session", id }) as const;

const SESSION_ACTIONS: AuthorizationAction[] = [
  "session.read",
  "session.submit",
  "session.approve",
  "session.control",
];

describe("a private session", () => {
  test("is its creator's, through the web or their own key", async () => {
    for (const action of SESSION_ACTIONS) {
      expect(await reason("creator", action, on(PERSONS))).toBe("ok");
      expect(await reason("creators_key", action, on(PERSONS))).toBe("ok");
    }
  });

  test("does not exist for anyone else, owner and admin included", async () => {
    for (const who of [
      "member",
      "agent_admin",
      "owner",
      "admin",
      "service_key",
    ] as const) {
      for (const action of ["session.read", "session.submit"] as const) {
        expect(await reason(who, action, on(PERSONS))).toBe("not_found");
      }
    }
    for (const who of ["member", "agent_admin", "service_key"] as const) {
      for (const action of SESSION_ACTIONS) {
        expect(await reason(who, action, on(PERSONS))).toBe("not_found");
      }
    }
  });

  test("a service key's private session is that key's", async () => {
    expect(await reason("service_key", "session.read", on(KEYS))).toBe("ok");
    expect(await reason("other_key", "session.read", on(KEYS))).toBe(
      "not_found",
    );
    expect(await reason("owner", "session.read", on(KEYS))).toBe("not_found");
  });

  test("the share is judged before the key's scopes", async () => {
    expect(
      await reason("other_key", "session.read", on(KEYS), { scopes: [] }),
    ).toBe("not_found");
    expect(
      await reason("service_key", "session.read", on(KEYS), { scopes: [] }),
    ).toBe("role");
  });

  test("a list is not judged per session; the store filters it", async () => {
    expect(
      await reason("member", "session.read", { kind: "session", id: null }),
    ).toBe("ok");
  });
});

describe("a manager outside the share", () => {
  test("ends, recovers or takes it over only with a reason", async () => {
    for (const [action, who, without] of [
      ["session.control", "admin", "not_found"],
      ["session.recover", "owner", "not_found"],
      ["member.manage", "admin", "justification_required"],
    ] as const) {
      expect(await reason(who, action, on(PERSONS))).toBe(without);
      expect(
        await reason(who, action, on(PERSONS), { justification: "  " }),
      ).toBe(without);
      expect(
        await reason(who, action, on(PERSONS), {
          justification: "incident 42",
        }),
      ).toBe("ok");
    }
  });

  test("still cannot read or write it with a reason", async () => {
    for (const action of ["session.read", "session.submit"] as const) {
      expect(
        await reason("owner", action, on(PERSONS), { justification: "x" }),
      ).toBe("not_found");
    }
  });

  test("recovery stays the owner's", async () => {
    expect(
      await reason("admin", "session.recover", on(PERSONS), {
        justification: "x",
      }),
    ).toBe("role");
  });

  test("needs no reason for a session in the share", async () => {
    expect(await reason("admin", "member.manage", on(OPEN))).toBe("ok");
    expect(await reason("owner", "session.control", on(OPEN))).toBe("ok");
  });
});

describe("audit read (D22)", () => {
  test("is the owner's and the admin's, with a reason every time", async () => {
    for (const who of ["owner", "admin"] as const) {
      for (const id of [PERSONS, OPEN]) {
        expect(await reason(who, "session.audit_read", on(id))).toBe(
          "justification_required",
        );
        expect(
          await reason(who, "session.audit_read", on(id), {
            justification: "security review",
          }),
        ).toBe("ok");
      }
    }
  });

  test("is no one else's, an agent's admin and the creator included", async () => {
    const with_ = { justification: "x" };
    expect(
      await reason("agent_admin", "session.audit_read", on(PERSONS), with_),
    ).toBe("not_found");
    expect(await reason("member", "session.audit_read", on(OPEN), with_)).toBe(
      "role",
    );
    expect(
      await reason("creator", "session.audit_read", on(PERSONS), with_),
    ).toBe("role");
    expect(
      await reason("service_key", "session.audit_read", on(KEYS), with_),
    ).toBe("role");
  });
});

describe("session.share (D21)", () => {
  // o allowed, x refused. Columns: owner, admin, creator, member, agent
  // admin, service key, the creator's personal key.
  const WHO: Who[] = [
    "owner",
    "admin",
    "creator",
    "member",
    "agent_admin",
    "service_key",
    "creators_key",
  ];
  const TABLE: [string, string, string][] = [
    ["a person's session", PERSONS, "xxoxxxx"],
    ["a service key's session", KEYS, "ooxxoxx"],
  ];
  for (const [row, id, cells] of TABLE) {
    test(row, async () => {
      const got = await Promise.all(
        WHO.map(async (who) =>
          (await decide(who, "session.share", on(id))).outcome === "allow"
            ? "o"
            : "x",
        ),
      );
      expect(got.join("")).toBe(cells);
    });
  }

  test("someone who cannot see it and may not share it is told it does not exist", async () => {
    expect(await reason("member", "session.share", on(PERSONS))).toBe(
      "not_found",
    );
    expect(await reason("member", "session.share", on(OPEN))).toBe("ok");
    expect(await reason("owner", "session.share", on(OPEN))).toBe("role");
  });

  test("without a store whose session it is cannot be read", async () => {
    const { caller, identity } = subject("creator");
    const decision = await createAuthorizationPolicy({
      identity,
      agents,
    }).authorize({
      subject: caller.subject,
      action: "session.share",
      resource: { kind: "session", id: PERSONS, owner_scope: WORKSPACE },
      request_id: "r",
    });
    expect(decision.reason_code).toBe("error");
  });
});

describe("session.approve (94S-798)", () => {
  // Seeing a session through its share is not answering for its creator.
  // o allowed, r refused (403), n not found (404), s the key that started
  // the session (every fixture session was started through the service
  // key). Columns: owner, admin, creator, member, agent admin,
  // service key, the creator's personal key.
  const WHO: Who[] = [
    "owner",
    "admin",
    "creator",
    "member",
    "agent_admin",
    "service_key",
    "creators_key",
  ];
  const TABLE: [string, string, string][] = [
    ["a person's session shared with the workspace", CREATORS_OPEN, "oooroso"],
    ["a person's session shared with a team", CREATORS_TEAM, "noorono"],
    ["a person's private session", PERSONS, "nnonnno"],
    ["a service key's session shared with the workspace", KEYS_OPEN, "oorrosr"],
    ["a service key's private session", KEYS, "nnnnnsn"],
  ];
  const cell = (decision: AuthorizationDecision) =>
    decision.outcome === "allow"
      ? "o"
      : decision.reason_code === "not_found"
        ? "n"
        : decision.reason_code === "role"
          ? "r"
          : decision.reason_code === "self_approval"
            ? "s"
            : decision.reason_code;
  for (const [row, id, cells] of TABLE) {
    test(row, async () => {
      const got = await Promise.all(
        WHO.map(async (who) =>
          cell(await decide(who, "session.approve", on(id))),
        ),
      );
      expect(got.join("")).toBe(cells);
    });
  }

  test("a key from before workspaces still answers what it sees", async () => {
    const legacy = callerFor(
      {
        kind: "api_key",
        id: "legacy",
        owner_id: WORKSPACE,
        workspace_id: null,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      "r",
    );
    const decision = await createAuthorizationPolicy({
      identity: {
        reread: async (s) => ({ status: "ok", principal: s.principal }),
      },
      agents,
      sessions,
    }).authorize({
      subject: legacy.subject,
      action: "session.approve",
      resource: { kind: "session", id: CREATORS_OPEN, owner_scope: WORKSPACE },
      request_id: "r",
    });
    expect(decision.reason_code).toBe("ok");
  });

  test("a key from before workspaces still approves a session it started itself, as the quickstart's one key does", async () => {
    const legacy = callerFor(
      {
        kind: "api_key",
        id: "legacy",
        owner_id: WORKSPACE,
        workspace_id: null,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      "r",
    );
    const decision = await createAuthorizationPolicy({
      identity: {
        reread: async (s) => ({ status: "ok", principal: s.principal }),
      },
      agents,
      sessions: {
        ...sessions,
        originOf: async () => ({
          creatorUserId: null,
          creatorApiKeyId: "legacy",
        }),
      },
    }).authorize({
      subject: legacy.subject,
      action: "session.approve",
      resource: { kind: "session", id: CREATORS_OPEN, owner_scope: WORKSPACE },
      request_id: "r",
    });
    expect(decision.reason_code).toBe("ok");
  });

  test("a session link is not resolved to its session yet, so only a manager answers through one", async () => {
    const link = {
      kind: "session_link",
      id: "019a0000-0000-7000-8000-00000000f0a1",
    } as const;
    expect(await reason("creator", "session.approve", link)).toBe("role");
    expect(await reason("member", "session.approve", link)).toBe("role");
    expect(await reason("admin", "session.approve", link)).toBe("ok");
  });

  test("a refused answer still holds the scope: only this session is not theirs", async () => {
    const decision = await decide(
      "member",
      "session.approve",
      on(CREATORS_OPEN),
    );
    expect(decision.effective_scopes).toContain("sessions:approve");
  });

  test("seeing and sending stay the share's", async () => {
    for (const action of ["session.read", "session.submit"] as const) {
      expect(await reason("member", action, on(CREATORS_OPEN))).toBe("ok");
      expect(await reason("member", action, on(CREATORS_TEAM))).toBe("ok");
    }
  });
});

describe("session.rename (94S-804)", () => {
  // The same people as session.approve: seeing a session through its share
  // is not naming it. o allowed, r refused (403), n not found (404).
  // Columns: owner, admin, creator, member, agent admin, service key, the
  // creator's personal key.
  const WHO: Who[] = [
    "owner",
    "admin",
    "creator",
    "member",
    "agent_admin",
    "service_key",
    "creators_key",
  ];
  const TABLE: [string, string, string][] = [
    ["a person's session shared with the workspace", CREATORS_OPEN, "ooororo"],
    ["a person's session shared with a team", CREATORS_TEAM, "noorono"],
    ["a person's private session", PERSONS, "nnonnno"],
    ["a service key's session shared with the workspace", KEYS_OPEN, "oorroor"],
    ["a service key's private session", KEYS, "nnnnnon"],
  ];
  const cell = (decision: AuthorizationDecision) =>
    decision.outcome === "allow"
      ? "o"
      : decision.reason_code === "not_found"
        ? "n"
        : decision.reason_code === "role"
          ? "r"
          : decision.reason_code;
  for (const [row, id, cells] of TABLE) {
    test(row, async () => {
      const got = await Promise.all(
        WHO.map(async (who) =>
          cell(await decide(who, "session.rename", on(id))),
        ),
      );
      expect(got.join("")).toBe(cells);
    });
  }

  test("needs sessions:write: a creator's key without it is refused", async () => {
    expect(
      await reason("creators_key", "session.rename", on(CREATORS_OPEN), {
        scopes: ["sessions:read"],
      }),
    ).toBe("role");
  });

  test("names one session: never the collection", async () => {
    expect(
      await reason("owner", "session.rename", { kind: "session", id: null }),
    ).toBe("role");
  });
});

describe("the pending requests a viewer is offered (94S-798)", () => {
  function service(who: Who) {
    const rows: string[] = [];
    let answered = 0;
    const { caller, identity } = subject(who);
    const store: PendingRequestStore = {
      async listOpen() {
        return [];
      },
      async answerAtomic() {
        answered += 1;
        throw new Error("never reached");
      },
      async recordSelfApproval() {
        throw new Error("never reached");
      },
      async requestOutcome() {
        throw new Error("never reached");
      },
    };
    const pending = createPendingRequestService({
      authorization: createAuthorizationPolicy({
        identity,
        agents,
        sessions,
        decisions: {
          async record({ request }) {
            rows.push(request.action);
          },
        },
      }),
      store,
    });
    return { pending, caller, rows, answered: () => answered };
  }

  test("say whether they may answer, and keep no decision for saying so", async () => {
    for (const [who, answerable] of [
      ["member", false],
      ["creator", true],
      ["agent_admin", true],
      ["owner", true],
      ["admin", true],
    ] as const) {
      const { pending, caller, rows } = service(who);
      expect(await pending.listPendingRequests(caller, CREATORS_OPEN)).toEqual({
        items: [],
        answerable,
      });
      expect(rows).toEqual([]);
    }
  });

  test("a viewer's answer is refused as 403 before the store is touched, and kept", async () => {
    const { pending, caller, rows, answered } = service("member");
    const error = await pending
      .answer(caller, CREATORS_OPEN, {
        idempotencyKey: "k",
        body: { request_id: "req_1", kind: "permission", decision: "allow" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      message:
        "This principal holds sessions:approve but may not use it on this session",
      details: { reason_code: "role" },
    });
    expect(answered()).toBe(0);
    expect(rows).toEqual(["session.approve"]);
  });

  test("the key that started the session is offered no answer, and its answer leaves a failed receipt (GA-8)", async () => {
    const { caller, identity } = subject("service_key");
    const refused: unknown[] = [];
    let answered = 0;
    const pending = createPendingRequestService({
      authorization: createAuthorizationPolicy({ identity, agents, sessions }),
      store: {
        async listOpen() {
          return [];
        },
        async answerAtomic() {
          answered += 1;
          throw new Error("never reached");
        },
        async recordSelfApproval(input) {
          refused.push(input);
          return "receipt-self";
        },
        async requestOutcome() {
          throw new Error("never reached");
        },
      },
    });
    expect(await pending.listPendingRequests(caller, KEYS_OPEN)).toEqual({
      items: [],
      answerable: false,
    });
    const error = await pending
      .answer(caller, KEYS_OPEN, {
        idempotencyKey: "k",
        body: { request_id: "req_1", kind: "permission", decision: "allow" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "self_approval", receipt_id: "receipt-self" },
    });
    expect(refused).toMatchObject([
      {
        sessionId: KEYS_OPEN,
        requestId: "req_1",
        principal: { actor: { principal: { kind: "api_key", id: KEY } } },
        deciderKey: { id: KEY },
      },
    ]);
    expect(answered).toBe(0);
  });

  test("the key that started the session cannot allow for the session either", async () => {
    const { caller, identity } = subject("service_key");
    let answered = 0;
    const pending = createPendingRequestService({
      authorization: createAuthorizationPolicy({ identity, agents, sessions }),
      store: {
        async listOpen() {
          return [];
        },
        async answerAtomic() {
          answered += 1;
          throw new Error("never reached");
        },
        async recordSelfApproval() {
          return "receipt-self";
        },
        async requestOutcome() {
          throw new Error("never reached");
        },
      },
    });
    const error = await pending
      .answer(caller, KEYS_OPEN, {
        idempotencyKey: "k",
        body: {
          request_id: "req_1",
          kind: "permission",
          decision: "allow",
          remember: "session",
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "self_approval", receipt_id: "receipt-self" },
    });
    expect(answered).toBe(0);
  });

  test("out of the share it is still not found", async () => {
    const { pending, caller } = service("member");
    const error = await pending
      .answer(caller, PERSONS, {
        idempotencyKey: "k",
        body: { request_id: "req_1", kind: "permission", decision: "allow" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("session.admin_list", () => {
  test("is the owner's and the admin's alone", async () => {
    const onWorkspace = { kind: "workspace", id: WORKSPACE } as const;
    const got = await Promise.all(
      (
        [
          "owner",
          "admin",
          "member",
          "agent_admin",
          "service_key",
          "creators_key",
        ] as const
      ).map(async (who) =>
        (await decide(who, "session.admin_list", onWorkspace)).outcome ===
        "allow"
          ? "o"
          : "x",
      ),
    );
    expect(got.join("")).toBe("ooxxxx");
  });
});

describe("what is kept", () => {
  function log() {
    const rows: { action: string; justification?: string }[] = [];
    const decisions: DecisionLog = {
      async record({ request }) {
        rows.push({
          action: request.action,
          ...(request.subject.justification === undefined
            ? {}
            : { justification: request.subject.justification }),
        });
      },
    };
    return { rows, decisions };
  }

  test("every allowed audit read, share and reasoned action, with its reason", async () => {
    const { rows, decisions } = log();
    await decide("owner", "session.audit_read", on(PERSONS), {
      justification: "incident 42",
      decisions,
    });
    await decide("creator", "session.share", on(PERSONS), { decisions });
    await decide("admin", "session.control", on(OPEN), {
      justification: "stuck",
      decisions,
    });
    await decide("creator", "session.read", on(PERSONS), { decisions });
    expect(rows).toEqual([
      { action: "session.audit_read", justification: "incident 42" },
      { action: "session.share" },
      { action: "session.control", justification: "stuck" },
    ]);
  });
});
