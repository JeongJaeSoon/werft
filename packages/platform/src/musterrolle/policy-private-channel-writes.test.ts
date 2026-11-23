import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationReason,
  type AuthorizationResource,
  authorizationDecisionSchema,
  type Principal,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { PrivateChannelPlace } from "../sessions/ports/session-share-store.ts";
import type { ChannelMemberCheckable } from "../surface/ports/channel-member-checkable.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type IdentityReader,
  type SessionAccess,
} from "./policy.ts";
import type { DecisionLog } from "./ports/decision-log.ts";

// Answer 15, first part (94S-2000): a key, a person's or an agent's, writes
// and approves on a private channel's session no more than it reads it. A
// key's own session and a public channel's session stay as they were.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const CHANNEL = "C0PRIV";
const CONVERSATION = "019a0000-0000-7000-8000-00000000c0a1";
// Opened by R from a mention in the private channel.
const PRIVATE_SESSION = "019a0000-0000-7000-8000-00000000e0a1";
// Opened by R in a public channel: no private channel's.
const PUBLIC_SESSION = "019a0000-0000-7000-8000-00000000e0b1";
// Started over the API by the key itself.
const KEYS_SESSION = "019a0000-0000-7000-8000-00000000e0c1";
const KEY = "019a0000-0000-7000-8000-0000000000f1";

const USERS = {
  // M: in the channel.
  member: "019a0000-0000-7000-8000-0000000000c1",
  // N: may use the agent, not in the channel.
  nonmember: "019a0000-0000-7000-8000-0000000000c2",
  // R: started the sessions, then left the channel.
  requester: "019a0000-0000-7000-8000-0000000000c3",
} as const;
type Person = keyof typeof USERS;
const ROLES: Record<Person, WorkspaceRole> = {
  member: "member",
  nonmember: "member",
  requester: "member",
};

const PLACE: PrivateChannelPlace = {
  conversationId: CONVERSATION,
  agentId: AGENT,
  channelId: CHANNEL,
};

function sessionsSeen(): SessionAccess {
  return {
    async visibleTo(_ownerId, sessionId, viewer) {
      if (sessionId === PRIVATE_SESSION) {
        return (
          viewer.apiKeyId === null &&
          (viewer.privateChannels ?? []).includes(CONVERSATION)
        );
      }
      return true;
    },
    async originOf(_ownerId, sessionId) {
      return sessionId === KEYS_SESSION
        ? { creatorUserId: null, creatorApiKeyId: KEY }
        : { creatorUserId: USERS.requester, creatorApiKeyId: null };
    },
    async privateChannels(_ownerId, sessionId) {
      return sessionId === PRIVATE_SESSION ? [PLACE] : [];
    },
  };
}

const agents: AgentAuthority = {
  async agentOf() {
    return AGENT;
  },
  async isAdmin() {
    return false;
  },
  async usageOf() {
    return { allowed: true, basis: "public", teamId: null };
  },
};

const inChannel = (userId: string) => userId === USERS.member;
const channelMembers: ChannelMemberCheckable = {
  async isMember(input) {
    return inChannel(input.userId);
  },
  async membership(input) {
    return inChannel(input.userId) ? "member" : "not_member";
  },
};

const plain: IdentityReader = {
  reread: async (s) => ({ status: "ok", principal: s.principal }),
};

function person(who: Person): Caller {
  const role = ROLES[who];
  return callerFor(
    {
      kind: "user",
      id: USERS[who],
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    "r",
  );
}

const keyPrincipal = (): Principal => ({
  kind: "api_key",
  id: KEY,
  owner_id: WORKSPACE,
  workspace_id: WORKSPACE,
  scopes: [...SESSION_SCOPE_VALUES],
});

// M's personal key, and the agent's key.
const KEYS = {
  personal: {
    caller: callerFor(keyPrincipal(), { kind: "api" }, "r", {
      creatorId: USERS.member,
    }),
    identity: {
      reread: async (s) => ({
        status: "ok",
        principal: s.principal,
        keyCreator: { userId: USERS.member, role: "member" },
      }),
    } satisfies IdentityReader,
  },
  agent: {
    caller: callerFor(keyPrincipal(), { kind: "api" }, "r", {
      creatorId: null,
      agentId: AGENT,
    }),
    identity: {
      reread: async (s) => ({
        status: "ok",
        principal: s.principal,
        keyAgentId: AGENT,
      }),
    } satisfies IdentityReader,
  },
} as const;

function policyFor(identity: IdentityReader, decisions?: DecisionLog) {
  return createAuthorizationPolicy({
    identity,
    agents,
    sessions: sessionsSeen(),
    channelMembers,
    ...(decisions ? { decisions } : {}),
  });
}

async function reason(
  caller: Caller,
  identity: IdentityReader,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  decisions?: DecisionLog,
): Promise<AuthorizationReason> {
  const decision = await policyFor(identity, decisions).authorize({
    subject: caller.subject,
    action,
    resource: { ...resource, owner_scope: WORKSPACE },
    request_id: caller.requestId,
  });
  return authorizationDecisionSchema.parse(decision).reason_code;
}

const session = (id: string) => ({ kind: "session", id }) as const;

// Every action a session route asks for: read (detail, turns, events,
// outputs, pending requests), submit (messages, push requests), approve
// (answers, push approve and reject), control, recover, rename, share.
const SESSION_ACTIONS = [
  "session.read",
  "session.submit",
  "session.approve",
  "session.control",
  "session.recover",
  "session.rename",
  "session.share",
] as const satisfies readonly AuthorizationAction[];

describe("a key on a private channel's session", () => {
  test("is refused every session action as private_channel_key, kept each time, a personal key and the agent's key alike", async () => {
    for (const { caller, identity } of [KEYS.personal, KEYS.agent]) {
      const rows: string[] = [];
      const decisions: DecisionLog = {
        async record({ request, decision }) {
          rows.push(`${request.action}:${decision.reason_code}`);
        },
      };
      for (const action of SESSION_ACTIONS) {
        expect(
          await reason(
            caller,
            identity,
            action,
            session(PRIVATE_SESSION),
            decisions,
          ),
        ).toBe("private_channel_key");
      }
      expect(rows).toEqual(
        SESSION_ACTIONS.map((action) => `${action}:private_channel_key`),
      );
    }
  });

  test("its own session and a public channel's session answer as before", async () => {
    // A personal key looks as M; the agent's key as its agent.
    const expected: Record<
      "personal" | "agent",
      Record<
        string,
        Record<(typeof SESSION_ACTIONS)[number], AuthorizationReason>
      >
    > = {
      personal: {
        [KEYS_SESSION]: {
          "session.read": "ok",
          "session.submit": "ok",
          "session.approve": "self_approval",
          "session.control": "ok",
          "session.recover": "role",
          "session.rename": "ok",
          "session.share": "role",
        },
        [PUBLIC_SESSION]: {
          "session.read": "ok",
          "session.submit": "ok",
          "session.approve": "role",
          "session.control": "ok",
          "session.recover": "role",
          "session.rename": "role",
          "session.share": "role",
        },
      },
      agent: {
        [KEYS_SESSION]: {
          "session.read": "ok",
          "session.submit": "ok",
          "session.approve": "self_approval",
          "session.control": "ok",
          "session.recover": "ok",
          "session.rename": "ok",
          "session.share": "role",
        },
        [PUBLIC_SESSION]: {
          "session.read": "ok",
          "session.submit": "ok",
          "session.approve": "ok",
          "session.control": "ok",
          "session.recover": "ok",
          "session.rename": "role",
          "session.share": "role",
        },
      },
    };
    const got: typeof expected = { personal: {}, agent: {} };
    for (const kind of ["personal", "agent"] as const) {
      const { caller, identity } = KEYS[kind];
      for (const sessionId of [KEYS_SESSION, PUBLIC_SESSION]) {
        const row = {} as Record<
          (typeof SESSION_ACTIONS)[number],
          AuthorizationReason
        >;
        for (const action of SESSION_ACTIONS) {
          row[action] = await reason(
            caller,
            identity,
            action,
            session(sessionId),
          );
        }
        got[kind][sessionId] = row;
      }
    }
    expect(got).toEqual(expected);
  });
});

describe("a push the agent asks for inside a turn", () => {
  test("is judged by its session-bound check, never as a key", async () => {
    const { sessionBoundAuthorization } = await import(
      "../action/tools/session-bound.ts"
    );
    const decision = await sessionBoundAuthorization(PRIVATE_SESSION).authorize(
      {
        subject: KEYS.agent.caller.subject,
        action: "session.submit",
        resource: {
          kind: "session",
          id: PRIVATE_SESSION,
          owner_scope: WORKSPACE,
        },
        request_id: "r",
      },
    );
    expect(decision.outcome).toBe("allow");
    // The same request over the API, as the agent's key, is refused.
    expect(
      await reason(
        KEYS.agent.caller,
        KEYS.agent.identity,
        "session.submit",
        session(PRIVATE_SESSION),
      ),
    ).toBe("private_channel_key");
  });
});

describe("approving after the requester left the private channel", () => {
  // Answer 15, second part: who decides a push whose requester (the person
  // of the turn that asked for it) is no longer in the private channel.
  const PUSH = "019a0000-0000-7000-8000-00000000d0a1";
  const B = "019a0000-0000-7000-8000-0000000000c7";

  function policyWith(options: {
    pushRequester?: string | null;
    inChannel?: (userId: string) => "member" | "not_member" | "unconfirmed";
    warned?: string[];
  }) {
    const answer =
      options.inChannel ??
      ((userId: string) => (inChannel(userId) ? "member" : "not_member"));
    return createAuthorizationPolicy({
      identity: plain,
      agents,
      sessions: {
        ...sessionsSeen(),
        async pushRequesterOf(_ownerId, sessionId, pushRequestId) {
          return sessionId === PRIVATE_SESSION && pushRequestId === PUSH
            ? options.pushRequester === undefined
              ? USERS.requester
              : options.pushRequester
            : null;
        },
      },
      channelMembers: {
        async isMember(input) {
          return answer(input.userId) === "member";
        },
        async membership(input) {
          return answer(input.userId);
        },
      },
      logger: {
        warn(message) {
          options.warned?.push(message);
        },
      },
    });
  }

  async function decide(
    who: Caller,
    options: Parameters<typeof policyWith>[0] & {
      sessionId?: string;
      push?: string | null;
    } = {},
  ): Promise<AuthorizationReason> {
    const push = options.push === undefined ? PUSH : options.push;
    const decision = await policyWith(options).authorize({
      subject: who.subject,
      action: "session.approve",
      resource: {
        kind: "session",
        id: options.sessionId ?? PRIVATE_SESSION,
        owner_scope: WORKSPACE,
        ...(push === null ? {} : { push_request_id: push }),
      },
      request_id: who.requestId,
    });
    return authorizationDecisionSchema.parse(decision).reason_code;
  }

  test("before 94S-2000 a member who did not start the session got role; now a member decides the push of a requester who left", async () => {
    // Before: the rule had no push in it, so the member was refused.
    expect(
      await reason(
        person("member"),
        plain,
        "session.approve",
        session(PRIVATE_SESSION),
      ),
    ).toBe("role");
    // After: a push request whose requester left the channel.
    expect(await decide(person("member"))).toBe("ok");
  });

  test("the requester who left, and a person outside the channel, still do not see the session", async () => {
    expect(await decide(person("requester"))).toBe("not_found");
    expect(await decide(person("nonmember"))).toBe("not_found");
  });

  test("a member without sessions:approve is refused", async () => {
    const noApprove = callerFor(
      {
        kind: "user",
        id: USERS.member,
        workspace_id: WORKSPACE,
        role: "member",
        scopes: ["sessions:read", "sessions:write"],
      },
      { kind: "web" },
      "r",
    );
    expect(await decide(noApprove)).toBe("role");
  });

  test("the rule stays as it was while the requester is in the channel, or when no one can tell", async () => {
    // R still a member.
    expect(
      await decide(person("member"), {
        inChannel: (userId) =>
          userId === USERS.member || userId === USERS.requester
            ? "member"
            : "not_member",
      }),
    ).toBe("role");
    // Slack could not answer for R: nothing widens on a guess, and it is logged.
    const warned: string[] = [];
    expect(
      await decide(person("member"), {
        inChannel: (userId) =>
          userId === USERS.member ? "member" : "unconfirmed",
        warned,
      }),
    ).toBe("role");
    expect(warned).toEqual(["Push requester's channel membership unconfirmed"]);
  });

  test("only a push decision: a permission or question answer keeps its rule", async () => {
    expect(await decide(person("member"), { push: null })).toBe("role");
  });

  test("only the role refusal is lifted: rename keeps its rule, and an agent acting for the member still meets its ceiling", async () => {
    const authorize = (
      subject: Caller["subject"],
      action: "session.approve" | "session.rename",
    ) =>
      policyWith({})
        .authorize({
          subject,
          action,
          resource: {
            kind: "session",
            id: PRIVATE_SESSION,
            owner_scope: WORKSPACE,
            push_request_id: PUSH,
          },
          request_id: "r",
        })
        .then(
          (decision) => authorizationDecisionSchema.parse(decision).reason_code,
        );
    const member = person("member");
    expect(await authorize(member.subject, "session.rename")).toBe("role");
    expect(
      await authorize(
        {
          ...member.subject,
          agent: {
            agent_id: "019a0000-0000-7000-8000-0000000000f1",
            release_id: "release-1",
          },
        },
        "session.approve",
      ),
    ).toBe("agent_ceiling");
  });

  test("a public channel's session keeps its rule though the requester left", async () => {
    expect(await decide(person("member"), { sessionId: PUBLIC_SESSION })).toBe(
      "role",
    );
  });

  test("the requester is the push's, not the session's starter (answer 15, Architect)", async () => {
    // A (R here) started the session and stays; B asked for the push and left.
    const stays = (userId: string) =>
      userId === USERS.member || userId === USERS.requester
        ? ("member" as const)
        : ("not_member" as const);
    expect(
      await decide(person("member"), { pushRequester: B, inChannel: stays }),
    ).toBe("ok");
    // B stays and A left: B's push keeps the usual rule.
    const bStays = (userId: string) =>
      userId === USERS.member || userId === B
        ? ("member" as const)
        : ("not_member" as const);
    expect(
      await decide(person("member"), { pushRequester: B, inChannel: bStays }),
    ).toBe("role");
    // No person behind the push: nothing to have left.
    expect(await decide(person("member"), { pushRequester: null })).toBe(
      "role",
    );
  });
});
