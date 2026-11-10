import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationDecision,
  type AuthorizationRequest,
  authorizationDecisionSchema,
  type Principal,
  SESSION_SCOPE_VALUES,
  type SessionScope,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import { createPendingRequestService } from "../decision/pending-service.ts";
import type { DecisionLog } from "../ports/decision-log.ts";
import { createInterruptService } from "../sessions/interrupt-service.ts";
import {
  createSessionService,
  SessionServiceError,
} from "../sessions/session-service.ts";
import { createUsageService } from "../usage/usage-service.ts";
import {
  ACTION_SCOPES,
  type AuthorizationPolicy,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  deciderKeyOf,
  type IdentityReader,
  MANAGEMENT_ROLES,
  mustRecord,
  RECORDED_ALLOW_ACTIONS,
  receiptActorOf,
} from "./policy.ts";

// Any store call means the refusal came too late.
const unreachable = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("the store must not be reached");
    },
  },
) as never;

function services(authorization: AuthorizationPolicy) {
  const sessions = createSessionService({
    authorization,
    inputs: unreachable,
    controls: unreachable,
    reader: new Proxy(
      {},
      {
        get: (_target, name) =>
          name === "getReceipt"
            ? async () => null
            : () => {
                throw new Error("the store must not be reached");
              },
      },
    ) as never,
    catalog: unreachable,
    releases: unreachable,
    limits: unreachable,
  });
  const pending = createPendingRequestService({
    authorization,
    store: unreachable,
  });
  const interrupts = createInterruptService({
    authorization,
    store: unreachable,
  });
  const usage = createUsageService({
    authorization,
    reader: unreachable,
    limits: unreachable,
  });
  return { sessions, pending, interrupts, usage };
}

type Services = ReturnType<typeof services>;
const id = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const input = unreachable;

// Every service entry point with the action it needs. createSession is
// asked about the agent its release names, so it has its own test below.
const entryPoints: [
  string,
  AuthorizationAction,
  (s: Services, actor: Caller) => Promise<unknown>,
][] = [
  [
    "appendMessage",
    "session.submit",
    (s, actor) => s.sessions.appendMessage(actor, id, input),
  ],
  [
    "terminateSession",
    "session.control",
    // `input` answers every property; a justification would ride along.
    (s, actor) =>
      s.sessions.terminateSession(actor, id, {
        idempotencyKey: "key-1",
        body: input,
      }),
  ],
  [
    "pauseSession",
    "session.control",
    (s, actor) => s.sessions.pauseSession(actor, id, input),
  ],
  [
    "resumeSession",
    "session.control",
    (s, actor) => s.sessions.resumeSession(actor, id, input),
  ],
  [
    "decideRecovery",
    "session.recover",
    (s, actor) =>
      s.sessions.decideRecovery(actor, id, {
        idempotencyKey: "key-1",
        body: input,
      }),
  ],
  [
    "listSessions",
    "session.read",
    (s, actor) => s.sessions.listSessions(actor, input),
  ],
  [
    "getSession",
    "session.read",
    (s, actor) => s.sessions.getSession(actor, id),
  ],
  [
    "listTurns",
    "session.read",
    (s, actor) => s.sessions.listTurns(actor, id, input),
  ],
  ["getTurn", "session.read", (s, actor) => s.sessions.getTurn(actor, id, "1")],
  [
    "readEvents",
    "session.read",
    (s, actor) => s.sessions.readEvents(actor, id, input),
  ],
  [
    "getReceipt",
    "session.read",
    (s, actor) => s.sessions.getReceipt(actor, id),
  ],
  [
    "listPendingRequests",
    "session.read",
    (s, actor) => s.pending.listPendingRequests(actor, id),
  ],
  [
    "answer",
    "session.approve",
    (s, actor) => s.pending.answer(actor, id, input),
  ],
  [
    "interrupt",
    "session.control",
    (s, actor) => s.interrupts.interrupt(actor, id, input),
  ],
  [
    "getSessionUsage",
    "session.read",
    (s, actor) => s.usage.getSessionUsage(actor, id),
  ],
];

const policy = createAuthorizationPolicy();

function without(scope: SessionScope): SessionScope[] {
  return SESSION_SCOPE_VALUES.filter((held) => held !== scope);
}

describe("service entry points without HTTP", () => {
  test("createSession refuses a key from before workspaces, which names no agent, before any store", async () => {
    const error = await services(policy)
      .sessions.createSession(testCaller("owner-a"), {
        idempotencyKey: "k",
        body: { agent_release_id: "rel-1", message: "hi" },
      })
      .catch((e) => e);
    expect(error).toMatchObject({ code: "NOT_FOUND" });
  });

  for (const [name, action, call] of entryPoints) {
    const scope = ACTION_SCOPES[action] as SessionScope;
    test(`${name} is FORBIDDEN without ${scope}`, async () => {
      const error = await call(
        services(policy),
        testCaller("owner-a", without(scope)),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(SessionServiceError);
      expect(error).toMatchObject({
        code: "FORBIDDEN",
        message: `This principal does not hold ${scope}`,
      });
    });

    test(`${name} is NOT_FOUND for a caller holding another owner's partition`, async () => {
      const error = await call(services(policy), {
        ...testCaller("owner-a"),
        ownerId: "owner-b",
      }).catch((e) => e);
      expect(error).toMatchObject({ code: "NOT_FOUND" });
    });

    test(`${name} is FORBIDDEN when the decision throws`, async () => {
      const broken = createAuthorizationPolicy({
        identity: {
          reread: async () => {
            throw new Error("connection terminated");
          },
        },
      });
      const error = await call(services(broken), testCaller("owner-a")).catch(
        (e) => e,
      );
      expect(error).toMatchObject({ code: "FORBIDDEN" });
    });
  }

  test("a policy that rejects instead of deciding is a refusal", async () => {
    const rejecting: AuthorizationPolicy = {
      authorize: () => Promise.reject(new Error("boom")),
    };
    for (const [, , call] of entryPoints) {
      const error = await call(
        services(rejecting),
        testCaller("owner-a"),
      ).catch((e) => e);
      expect(error).toMatchObject({ code: "FORBIDDEN" });
    }
  });

  test("asks about the caller's subject, the action and a session in its partition", async () => {
    const asked: AuthorizationRequest[] = [];
    const recording: AuthorizationPolicy = {
      authorize: async (request) => {
        asked.push(request);
        return policy.authorize({ ...request, action: "workspace.manage" });
      },
    };
    const actor = testCaller("owner-a");
    for (const [, , call] of entryPoints) {
      await call(services(recording), actor).catch(() => {});
    }
    expect(asked.map((request) => request.action)).toEqual(
      entryPoints.map(([, action]) => action),
    );
    for (const request of asked) {
      expect(request.subject).toBe(actor.subject);
      expect(request.request_id).toBe(actor.requestId);
      expect(request.resource).toMatchObject({
        kind: "session",
        owner_scope: "owner-a",
      });
    }
    expect(asked.filter((request) => request.resource.id === null).length).toBe(
      2,
    ); // listSessions, getReceipt
  });
});

const WORKSPACE_A = "019a0000-0000-7000-8000-0000000000a1";
const WORKSPACE_B = "019a0000-0000-7000-8000-0000000000b1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000d1";
const SESSION = "019a0000-0000-7000-8000-0000000000e1";

const member: Principal = {
  kind: "user",
  id: USER,
  workspace_id: WORKSPACE_A,
  role: "member",
  scopes: without("sessions:recover"),
};

function request(
  caller: Caller,
  overrides: Partial<AuthorizationRequest> = {},
): AuthorizationRequest {
  return {
    subject: caller.subject,
    action: "session.read",
    resource: { kind: "session", id: SESSION, owner_scope: caller.ownerId },
    request_id: caller.requestId,
    ...overrides,
  };
}

async function decide(
  req: AuthorizationRequest,
  using: AuthorizationPolicy = policy,
) {
  const decision = await using.authorize(req);
  // Every decision, refusals included, is a well-formed contract value.
  return authorizationDecisionSchema.parse(decision);
}

describe("authorize", () => {
  const web = callerFor(member, { kind: "web" }, "req-1");

  test("allows what the role and the membership both hold", async () => {
    const decision = await decide(request(web));
    expect(decision).toMatchObject({
      outcome: "allow",
      reason_code: "ok",
      effective_scopes: without("sessions:recover"),
      policy_version: "m16",
    });
  });

  test("the role is a ceiling the membership's scopes cannot pass", async () => {
    const decision = await decide(
      request(web, {
        subject: {
          ...web.subject,
          // A hand-built subject the contract rejects.
          principal: { ...member, scopes: [...SESSION_SCOPE_VALUES] },
        },
        action: "session.recover",
      }),
    );
    expect(decision).toMatchObject({ outcome: "deny", reason_code: "error" });
  });

  test("a member is refused recovery for their role", async () => {
    const decision = await decide(request(web, { action: "session.recover" }));
    expect(decision).toMatchObject({ outcome: "deny", reason_code: "role" });
  });

  test("an API key holds exactly its scopes", async () => {
    const key = testCaller("owner-a", ["sessions:read"]);
    expect(await decide(request(key))).toMatchObject({ outcome: "allow" });
    expect(
      await decide(request(key, { action: "session.submit" })),
    ).toMatchObject({ outcome: "deny", reason_code: "role" });
  });

  test("a resource in another workspace does not exist", async () => {
    const decision = await decide(
      request(web, {
        resource: { kind: "session", id: SESSION, owner_scope: WORKSPACE_B },
      }),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      reason_code: "not_found",
      effective_scopes: [],
    });
  });

  test("an autonomous run, with no person or key asking, is refused", async () => {
    const decision = await decide(
      request(web, {
        subject: { principal: null, surface: { kind: "api" } },
      }),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      reason_code: "no_requester",
    });
  });

  test("an installation with no person behind it is unlinked", async () => {
    const installation = callerFor(
      {
        kind: "installation",
        id: INSTALLATION,
        owner_id: "service-owner",
        workspace_id: WORKSPACE_A,
        scopes: ["sessions:read"],
      },
      {
        kind: "slack",
        channel_kind: "public_channel",
        slack_user_kind: "member",
        agent_id: "019a0000-0000-7000-8000-00000000b0c1",
      },
      "req-2",
    );
    expect(await decide(request(installation))).toMatchObject({
      outcome: "deny",
      reason_code: "unlinked",
    });
    expect(
      await decide(
        request(installation, {
          subject: { ...installation.subject, actor_user_id: USER },
        }),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "unlinked" });
  });

  test("slack speaks only through an installation that names the user's kind", async () => {
    const slack = callerFor(
      member,
      { kind: "slack", slack_user_kind: "member" },
      "req-3",
    );
    expect(await decide(request(slack))).toMatchObject({
      outcome: "deny",
      reason_code: "error",
    });
  });

  test("an agent acting for the requester has no ceiling to judge against yet", async () => {
    const decision = await decide(
      request(web, {
        subject: {
          ...web.subject,
          agent: {
            agent_id: "019a0000-0000-7000-8000-0000000000f1",
            release_id: "release-1",
          },
        },
      }),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      reason_code: "agent_ceiling",
    });
  });

  test("an action with no rule, or on a resource it cannot apply to, is an error", async () => {
    expect(
      await decide(
        request(web, {
          action: "routine.manage",
          resource: {
            kind: "workspace",
            id: WORKSPACE_A,
            owner_scope: WORKSPACE_A,
          },
        }),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "error" });
    expect(
      await decide(
        request(web, {
          action: "session.recover",
          resource: {
            kind: "session_link",
            id: SESSION,
            owner_scope: WORKSPACE_A,
          },
        }),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "error" });
  });

  test("a malformed request is an error, not a throw", async () => {
    const decision = await decide({
      ...request(web),
      action: "sessions:read",
    } as unknown as AuthorizationRequest);
    expect(decision).toMatchObject({ outcome: "deny", reason_code: "error" });
  });

  test("an identity read that throws or fails is an error", async () => {
    const failing = (reread: IdentityReader["reread"]) =>
      createAuthorizationPolicy({ identity: { reread } });
    expect(
      await decide(
        request(web),
        failing(async () => {
          throw new Error("connection terminated");
        }),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "error" });
    expect(
      await decide(
        request(web),
        failing(() => Promise.reject(new Error("deadlock detected"))),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "error" });
  });

  test("the identity read decides, not the principal the request carried", async () => {
    const reads: unknown[] = [];
    const disabled = createAuthorizationPolicy({
      identity: {
        reread: async (subject) => {
          reads.push(subject.principal);
          return { status: "disabled" };
        },
      },
    });
    expect(await decide(request(web), disabled)).toMatchObject({
      outcome: "deny",
      reason_code: "disabled",
    });
    await decide(request(web), disabled);
    // Read again for each decision, never remembered.
    expect(reads).toEqual([member, member]);
  });

  test("each decision has its own id", async () => {
    const first = await decide(request(web));
    const second = await decide(request(web));
    expect(first.decision_id).not.toBe(second.decision_id);
  });
});

const OWNER_USER = "019a0000-0000-7000-8000-0000000000c2";
const KEY = "019a0000-0000-7000-8000-0000000000f1";

const owner: Principal = {
  kind: "user",
  id: OWNER_USER,
  workspace_id: WORKSPACE_A,
  role: "owner",
  scopes: [...SESSION_SCOPE_VALUES],
};

function workspaceKey(scopes: readonly SessionScope[]): Principal {
  return {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE_A,
    workspace_id: WORKSPACE_A,
    scopes: [...scopes],
  };
}

function personalKeyReader(
  role: "owner" | "member",
  status: "ok" | "disabled" = "ok",
): IdentityReader {
  return {
    reread: async (subject) =>
      status === "ok"
        ? {
            status: "ok",
            principal: subject.principal,
            keyCreator: { userId: USER, role },
          }
        : { status },
  };
}

const MANAGEMENT_ACTIONS: AuthorizationAction[] = [
  "workspace.manage",
  "member.manage",
  "api_key.manage",
  "api_key.manage_own",
  "agent.manage",
  "binding.manage",
];

function onWorkspace(
  caller: Caller,
  action: AuthorizationAction,
): AuthorizationRequest {
  return request(caller, {
    action,
    resource: { kind: "workspace", id: WORKSPACE_A, owner_scope: WORKSPACE_A },
  });
}

describe("management actions", () => {
  const ownerWeb = callerFor(owner, { kind: "web" }, "req-o");
  const memberWeb = callerFor(member, { kind: "web" }, "req-m");

  test("an owner takes every management action", async () => {
    for (const action of MANAGEMENT_ACTIONS) {
      expect(await decide(onWorkspace(ownerWeb, action))).toMatchObject({
        outcome: "allow",
        reason_code: "ok",
      });
    }
  });

  test("a member takes only its own key's, and is refused the rest for the role", async () => {
    for (const action of MANAGEMENT_ACTIONS) {
      expect(await decide(onWorkspace(memberWeb, action))).toMatchObject(
        action === "api_key.manage_own"
          ? { outcome: "allow", reason_code: "ok" }
          : { outcome: "deny", reason_code: "role" },
      );
    }
  });

  test("no key takes a management action or issues a key, whatever its scopes", async () => {
    const service = callerFor(
      workspaceKey(SESSION_SCOPE_VALUES),
      { kind: "api" },
      "req-k",
      { creatorId: null },
    );
    const personal = callerFor(
      workspaceKey(SESSION_SCOPE_VALUES),
      { kind: "api" },
      "req-p",
      { creatorId: USER },
    );
    for (const action of MANAGEMENT_ACTIONS) {
      expect(await decide(onWorkspace(service, action))).toMatchObject({
        outcome: "deny",
        reason_code: "role",
      });
      expect(
        await decide(
          onWorkspace(personal, action),
          createAuthorizationPolicy({ identity: personalKeyReader("owner") }),
        ),
      ).toMatchObject({ outcome: "deny", reason_code: "role" });
    }
  });

  test("another workspace's member or session is not found", async () => {
    expect(
      await decide(
        request(ownerWeb, {
          action: "member.manage",
          resource: { kind: "session", id: SESSION, owner_scope: WORKSPACE_B },
        }),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "not_found" });
  });

  test("a disabled owner is refused before the role is read", async () => {
    expect(
      await decide(
        onWorkspace(ownerWeb, "member.manage"),
        createAuthorizationPolicy({
          identity: { reread: async () => ({ status: "disabled" }) },
        }),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "disabled" });
  });
});

describe("personal and service keys", () => {
  const personal = callerFor(
    workspaceKey(SESSION_SCOPE_VALUES),
    { kind: "api" },
    "req-p",
    { creatorId: USER },
  );

  test("a personal key holds the narrower of its scopes and its creator's current role", async () => {
    const asMember = createAuthorizationPolicy({
      identity: personalKeyReader("member"),
    });
    expect(
      await decide(request(personal, { action: "session.recover" }), asMember),
    ).toMatchObject({
      outcome: "deny",
      reason_code: "role",
      effective_scopes: without("sessions:recover"),
    });
    expect(await decide(request(personal), asMember)).toMatchObject({
      outcome: "allow",
    });
    const asOwner = createAuthorizationPolicy({
      identity: personalKeyReader("owner"),
    });
    expect(
      await decide(request(personal, { action: "session.recover" }), asOwner),
    ).toMatchObject({ outcome: "allow" });
    const narrowKey = callerFor(
      workspaceKey(["sessions:read"]),
      { kind: "api" },
      "req-n",
      { creatorId: USER },
    );
    expect(
      await decide(request(narrowKey, { action: "session.submit" }), asOwner),
    ).toMatchObject({
      outcome: "deny",
      reason_code: "role",
      effective_scopes: ["sessions:read"],
    });
  });

  test("a personal key whose creator is disabled is refused; a service key is not", async () => {
    expect(
      await decide(
        request(personal),
        createAuthorizationPolicy({
          identity: personalKeyReader("owner", "disabled"),
        }),
      ),
    ).toMatchObject({ outcome: "deny", reason_code: "disabled" });
    const service = callerFor(
      workspaceKey(SESSION_SCOPE_VALUES),
      { kind: "api" },
      "req-s",
      { creatorId: null },
    );
    expect(
      await decide(request(service, { action: "session.recover" })),
    ).toMatchObject({
      outcome: "allow",
      effective_scopes: SESSION_SCOPE_VALUES,
    });
  });

  test("a subject naming a person the stored identity does not is an error", async () => {
    const claimed = {
      ...request(
        callerFor(workspaceKey(SESSION_SCOPE_VALUES), { kind: "api" }, "r"),
      ),
    };
    claimed.subject = { ...claimed.subject, actor_user_id: USER };
    expect(await decide(claimed)).toMatchObject({
      outcome: "deny",
      reason_code: "error",
    });
    const otherCreator = createAuthorizationPolicy({
      identity: {
        reread: async (subject) => ({
          status: "ok",
          principal: subject.principal,
          keyCreator: { userId: OWNER_USER, role: "owner" },
        }),
      },
    });
    expect(await decide(request(personal), otherCreator)).toMatchObject({
      outcome: "deny",
      reason_code: "error",
    });
  });
});

describe("credentials a starting session needs", () => {
  const web = callerFor(member, { kind: "web" }, "req-cred");
  const AGENT = "019a0000-0000-7000-8000-00000000b0c1";
  const starting = (release_id = "rel-1") =>
    request(web, {
      action: "session.submit",
      resource: {
        kind: "session",
        id: null,
        owner_scope: web.ownerId,
        agent_id: AGENT,
        release_id,
      },
    });

  function withBindings(unbound: Record<string, string[]>) {
    const entries: Parameters<DecisionLog["record"]>[0][] = [];
    const asked: [string, string][] = [];
    return {
      entries,
      asked,
      policy: createAuthorizationPolicy({
        credentials: {
          async unboundRefs(workspaceId, releaseId) {
            asked.push([workspaceId, releaseId]);
            return unbound[releaseId] ?? [];
          },
        },
        decisions: {
          async record(entry) {
            entries.push(entry);
          },
        },
      }),
    };
  }

  test("a release whose credentials are all bound starts", async () => {
    const { policy: using, asked } = withBindings({});
    expect(await decide(starting(), using)).toMatchObject({
      outcome: "allow",
      reason_code: "ok",
    });
    expect(asked).toEqual([[WORKSPACE_A, "rel-1"]]);
  });

  test("an unbound credential refuses the start, and the refusal is kept", async () => {
    const { policy: using, entries } = withBindings({ "rel-1": ["mcp-x"] });
    const decision = await decide(starting(), using);
    expect(decision).toMatchObject({
      outcome: "deny",
      reason_code: "credential_unbound",
    });
    expect(entries.map((entry) => entry.decision)).toEqual([decision]);
  });

  test("the role is judged before the bindings are read", async () => {
    const { policy: using, asked } = withBindings({ "rel-1": ["mcp-x"] });
    const reader = callerFor(
      { ...member, scopes: ["sessions:read"] },
      { kind: "web" },
      "req-reader",
    );
    expect(
      await decide({ ...starting(), subject: reader.subject }, using),
    ).toMatchObject({ reason_code: "role" });
    expect(asked).toEqual([]);
  });

  test("with no binding store a release cannot be shown bound", async () => {
    expect(await decide(starting())).toMatchObject({
      outcome: "deny",
      reason_code: "error",
    });
  });

  test("a release is named only on a session about to start", async () => {
    const { policy: using } = withBindings({});
    expect(
      await decide(
        request(web, {
          resource: {
            kind: "session",
            id: SESSION,
            owner_scope: web.ownerId,
            release_id: "rel-1",
          },
        }),
        using,
      ),
    ).toMatchObject({ reason_code: "error" });
    expect(
      await decide(
        request(web, {
          resource: {
            kind: "session",
            id: null,
            owner_scope: web.ownerId,
            release_id: "rel-1",
          },
        }),
        using,
      ),
    ).toMatchObject({ reason_code: "error" });
  });
});

describe("callerFor records who acts", () => {
  test("a cookie user is recorded as themselves in their workspace", () => {
    expect(callerFor(member, { kind: "web" }, "r").actor).toEqual({
      principal: { kind: "user", id: USER },
      userId: USER,
      workspaceId: WORKSPACE_A,
      apiKeyId: null,
      agentId: null,
      apiKeyIssuerId: null,
      apiKeyKind: null,
    });
  });

  test("an agent key's receipts name its agent; a cookie user's name none", () => {
    const agent = callerFor(
      workspaceKey(["sessions:write"]),
      { kind: "api" },
      "r",
      { creatorId: null, agentId: "agent-1" },
    );
    expect(receiptActorOf(agent)).toEqual({
      principal: { kind: "api_key", id: KEY },
      actor_user_id: null,
      agent_id: "agent-1",
    });
    const web = callerFor(member, { kind: "web" }, "r", {
      creatorId: null,
      agentId: "agent-1",
    });
    expect(receiptActorOf(web)?.agent_id).toBeNull();
  });

  test("a service key names no person, a personal key its creator", () => {
    const key = workspaceKey(["sessions:read"]);
    expect(
      callerFor(key, { kind: "api" }, "r", { creatorId: null }).actor,
    ).toEqual({
      principal: { kind: "api_key", id: KEY },
      userId: null,
      workspaceId: WORKSPACE_A,
      apiKeyId: KEY,
      agentId: null,
      apiKeyIssuerId: null,
      apiKeyKind: null,
    });
    const personal = callerFor(key, { kind: "api" }, "r", {
      creatorId: USER,
    });
    expect(personal.actor?.userId).toBe(USER);
    expect(personal.subject.actor_user_id).toBe(USER);
  });

  test("the key behind a decision names its issuer, an agent key's too (GA-8)", () => {
    const key = workspaceKey(["sessions:approve"]);
    const agent = callerFor(key, { kind: "api" }, "r", {
      creatorId: null,
      agentId: "agent-1",
      issuerId: USER,
    });
    expect(deciderKeyOf(agent)).toEqual({
      id: KEY,
      kind: "agent",
      issued_by_user_id: USER,
    });
    const personal = callerFor(key, { kind: "api" }, "r", {
      creatorId: USER,
      issuerId: USER,
    });
    expect(deciderKeyOf(personal)).toEqual({
      id: KEY,
      kind: "personal",
      issued_by_user_id: USER,
    });
    const operator = callerFor(key, { kind: "api" }, "r", {
      creatorId: null,
      issuerId: null,
      kind: "operator",
    });
    expect(deciderKeyOf(operator)).toEqual({
      id: KEY,
      kind: "operator",
      issued_by_user_id: null,
    });
    expect(deciderKeyOf(callerFor(member, { kind: "web" }, "r"))).toBeNull();
  });

  test("AUTH_MODE=none's owner-named principal is no key row, even when the owner is a UUID", () => {
    const none: Principal = {
      kind: "api_key",
      id: KEY,
      owner_id: KEY,
      workspace_id: null,
      scopes: [...SESSION_SCOPE_VALUES],
    };
    expect(callerFor(none, { kind: "api" }, "r").actor?.apiKeyId).toBeNull();
  });
});

describe("decision log", () => {
  const web = callerFor(member, { kind: "web" }, "req-log");

  function logged(fail = false) {
    const entries: Parameters<DecisionLog["record"]>[0][] = [];
    const decisions: DecisionLog = {
      async record(entry) {
        if (fail) throw new Error("audit store down");
        entries.push(entry);
      },
    };
    // SESSION is the member's own, so the member may answer it.
    const sessions = {
      visibleTo: async () => true,
      originOf: async () => ({ creatorUserId: USER, creatorApiKeyId: null }),
    };
    return {
      entries,
      policy: createAuthorizationPolicy({ decisions, sessions }),
    };
  }

  test("keeps every refusal with the request that asked", async () => {
    const { entries, policy: using } = logged();
    const decision = await decide(
      request(web, { action: "session.recover" }),
      using,
    );
    expect(entries).toEqual([
      { request: request(web, { action: "session.recover" }), decision },
    ]);
    expect(entries[0]?.request.request_id).toBe("req-log");
  });

  test("keeps an approval but not a plain read", async () => {
    const { entries, policy: using } = logged();
    await decide(request(web), using);
    expect(entries).toEqual([]);
    const approval = await decide(
      request(web, { action: "session.approve" }),
      using,
    );
    expect(approval.outcome).toBe("allow");
    expect(entries.map((entry) => entry.decision)).toEqual([approval]);
  });

  test("keeps every Slack input, and not a Slack read that was allowed", () => {
    const slack = callerFor(member, { kind: "slack" }, "req-slack");
    const allowed: AuthorizationDecision = {
      outcome: "allow",
      reason_code: "ok",
      effective_scopes: [],
      policy_version: "m16",
      decision_id: crypto.randomUUID(),
    };
    expect(
      mustRecord(request(slack, { action: "session.submit" }), allowed),
    ).toBe(true);
    expect(mustRecord(request(slack), allowed)).toBe(false);
    expect(
      mustRecord(request(web, { action: "session.submit" }), allowed),
    ).toBe(false);
  });

  test("every management action is kept when allowed", () => {
    for (const action of Object.keys(MANAGEMENT_ROLES)) {
      expect(RECORDED_ALLOW_ACTIONS.has(action as AuthorizationAction)).toBe(
        true,
      );
    }
  });

  test("records a Slack input the policy refuses", async () => {
    const { entries, policy: using } = logged();
    const slack = callerFor(member, { kind: "slack" }, "req-slack");
    await decide(request(slack, { action: "session.submit" }), using);
    expect(entries.map((entry) => entry.request.subject.surface.kind)).toEqual([
      "slack",
    ]);
  });

  test("an allow that must be kept and cannot be is refused", async () => {
    const { policy: using } = logged(true);
    const approval = await decide(
      request(web, { action: "session.approve" }),
      using,
    );
    expect(approval).toMatchObject({ outcome: "deny", reason_code: "error" });
    expect((await decide(request(web), using)).outcome).toBe("allow");
  });

  test("a refusal stays a refusal when it cannot be kept", async () => {
    const { policy: using } = logged(true);
    const decision = await decide(
      request(web, { action: "session.recover" }),
      using,
    );
    expect(decision).toMatchObject({ outcome: "deny", reason_code: "role" });
  });

  test("a malformed request is refused without a row", async () => {
    const { entries, policy: using } = logged();
    const decision = await decide(
      { ...request(web), request_id: "" } as AuthorizationRequest,
      using,
    );
    expect(decision.outcome).toBe("deny");
    expect(entries).toEqual([]);
  });

  test("records the decision it returns, id included", async () => {
    const { entries, policy: using } = logged();
    const decision = await decide(
      request(web, { action: "session.recover" }),
      using,
    );
    expect(entries[0]?.decision.decision_id).toBe(decision.decision_id);
  });
});
