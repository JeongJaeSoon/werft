import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationReason,
  type AuthorizationRequest,
  authorizationDecisionSchema,
  DEFAULT_SURFACE_CEILING,
  INSTALLATION_SESSION_SCOPE_VALUES,
  type Principal,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { createPendingRequestService } from "../decision/pending-service.ts";
import type {
  PrivateChannelPlace,
  SessionViewer,
} from "../sessions/ports/session-share-store.ts";
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
import { SessionServiceError } from "./service-errors.ts";

// Design 9-3 on a private channel's sessions (94S-1999): a person who may
// use the agent and is a member of the channel now sees one; the channel
// goes before who made it; a key never sees one.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const CHANNEL = "C0PRIV";
const CONVERSATION = "019a0000-0000-7000-8000-00000000c0a1";
const PRIVATE_SESSION = "019a0000-0000-7000-8000-00000000e0a1";
const OPEN_SESSION = "019a0000-0000-7000-8000-00000000e0b1";
const KEY = "019a0000-0000-7000-8000-0000000000f1";

const USERS = {
  // M: a member of the channel.
  member: "019a0000-0000-7000-8000-0000000000c1",
  // N: may use the agent, not in the channel.
  nonmember: "019a0000-0000-7000-8000-0000000000c2",
  // R: started the session, then left the channel.
  requester: "019a0000-0000-7000-8000-0000000000c3",
  // The workspace's owner, not in the channel.
  owner: "019a0000-0000-7000-8000-0000000000c4",
  // In the channel, but may not use the agent.
  outsider: "019a0000-0000-7000-8000-0000000000c5",
} as const;
type Person = keyof typeof USERS;
const ROLES: Record<Person, WorkspaceRole> = {
  member: "member",
  nonmember: "member",
  requester: "member",
  owner: "owner",
  outsider: "member",
};
const IN_CHANNEL: readonly string[] = [USERS.member, USERS.outsider];

const PLACE: PrivateChannelPlace = {
  conversationId: CONVERSATION,
  agentId: AGENT,
  channelId: CHANNEL,
};

function sessionsSeen(viewers: SessionViewer[] = []): SessionAccess {
  return {
    async visibleTo(_ownerId, sessionId, viewer) {
      viewers.push(viewer);
      if (sessionId === OPEN_SESSION) return true;
      if (sessionId !== PRIVATE_SESSION) return false;
      // As sessionVisibleTo has it: the channel alone, never for a key.
      return (
        viewer.apiKeyId === null &&
        (viewer.privateChannels ?? []).includes(CONVERSATION)
      );
    },
    async originOf(_ownerId, sessionId) {
      return sessionId === PRIVATE_SESSION
        ? { creatorUserId: USERS.requester, creatorApiKeyId: null }
        : { creatorUserId: USERS.member, creatorApiKeyId: null };
    },
    async privateChannels(_ownerId, sessionId) {
      return sessionId === null || sessionId === PRIVATE_SESSION ? [PLACE] : [];
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
  async usageOf(_workspaceId, _agentId, person) {
    return person.userId === USERS.outsider
      ? { allowed: false, basis: "managing_team", teamId: null }
      : { allowed: true, basis: "public", teamId: null };
  },
};

function members(answer = (userId: string) => IN_CHANNEL.includes(userId)) {
  const asked: string[] = [];
  const check: ChannelMemberCheckable = {
    async isMember(input) {
      asked.push(input.userId);
      return answer(input.userId);
    },
  };
  return { check, asked };
}

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

// M's own personal key, and the agent's key.
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

function policyFor(
  identity: IdentityReader,
  options: {
    check?: ChannelMemberCheckable;
    viewers?: SessionViewer[];
    decisions?: DecisionLog;
  } = {},
) {
  return createAuthorizationPolicy({
    identity,
    agents,
    sessions: sessionsSeen(options.viewers),
    channelMembers: options.check ?? members().check,
    ...(options.decisions ? { decisions: options.decisions } : {}),
  });
}

async function reason(
  caller: Caller,
  identity: IdentityReader,
  action: AuthorizationAction,
  sessionId: string,
  options: Parameters<typeof policyFor>[1] & { justification?: string } = {},
): Promise<AuthorizationReason> {
  const request: AuthorizationRequest = {
    subject: {
      ...caller.subject,
      ...(options.justification === undefined
        ? {}
        : { justification: options.justification }),
    },
    action,
    resource: { kind: "session", id: sessionId, owner_scope: WORKSPACE },
    request_id: caller.requestId,
  };
  const decision = await policyFor(identity, options).authorize(request);
  return authorizationDecisionSchema.parse(decision).reason_code;
}

const asPerson = (who: Person, sessionId = PRIVATE_SESSION) =>
  reason(person(who), plain, "session.read", sessionId);

describe("a private_channel session", () => {
  test("is seen by a member of the channel who may use the agent, and no one else", async () => {
    expect(await asPerson("member")).toBe("ok");
    for (const who of [
      "nonmember",
      "requester",
      "owner",
      "outsider",
    ] as const) {
      expect(await asPerson(who)).toBe("not_found");
    }
  });

  test("hides from a member too when the member check cannot be confirmed", async () => {
    // The check answers false whenever Slack cannot tell (94S-1992).
    const down = members(() => false).check;
    expect(
      await reason(person("member"), plain, "session.read", PRIVATE_SESSION, {
        check: down,
      }),
    ).toBe("not_found");
    // Without a member check at all, no one sees it.
    const policy = createAuthorizationPolicy({
      identity: plain,
      agents,
      sessions: sessionsSeen(),
    });
    const caller = person("member");
    const decision = await policy.authorize({
      subject: caller.subject,
      action: "session.read",
      resource: {
        kind: "session",
        id: PRIVATE_SESSION,
        owner_scope: WORKSPACE,
      },
      request_id: caller.requestId,
    });
    expect(decision.reason_code).toBe("not_found");
  });

  test("an owner outside the channel reads it with a reason, as an audit read", async () => {
    const rows: { action: string; reason: string }[] = [];
    const decisions: DecisionLog = {
      async record({ request, decision }) {
        rows.push({ action: request.action, reason: decision.reason_code });
      },
    };
    expect(
      await reason(
        person("owner"),
        plain,
        "session.audit_read",
        PRIVATE_SESSION,
        { justification: "incident 42", decisions },
      ),
    ).toBe("ok");
    expect(rows).toEqual([{ action: "session.audit_read", reason: "ok" }]);
    expect(
      await reason(
        person("owner"),
        plain,
        "session.audit_read",
        PRIVATE_SESSION,
      ),
    ).toBe("justification_required");
  });

  test("a key is refused for a reason of its own, a personal key of a member and the agent's key alike", async () => {
    for (const { caller, identity } of [KEYS.personal, KEYS.agent]) {
      const rows: string[] = [];
      const decisions: DecisionLog = {
        async record({ decision }) {
          rows.push(decision.reason_code);
        },
      };
      for (const action of ["session.read", "session.approve"] as const) {
        expect(
          await reason(caller, identity, action, PRIVATE_SESSION, {
            decisions,
          }),
        ).toBe("private_channel_key");
      }
      expect(rows).toEqual(["private_channel_key", "private_channel_key"]);
      // A session that is no private channel's reads as it did.
      expect(await reason(caller, identity, "session.read", OPEN_SESSION)).toBe(
        "ok",
      );
    }
  });

  test("a key's refusal answers 404, as a session that is not there", async () => {
    const { caller, identity } = KEYS.personal;
    const { requirePermitted } = await import("./require-permitted.ts");
    const error = await requirePermitted(
      policyFor(identity),
      caller,
      "session.read",
      { kind: "session", id: PRIVATE_SESSION },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
  });

  test("other sessions ask Slack nothing", async () => {
    const { check, asked } = members();
    expect(
      await reason(person("nonmember"), plain, "session.read", OPEN_SESSION, {
        check,
      }),
    ).toBe("ok");
    expect(asked).toEqual([]);
  });
});

describe("a decision from Slack", () => {
  const slackCaller = (channelId: string): Caller => ({
    ownerId: WORKSPACE,
    requestId: "r",
    subject: {
      principal: {
        kind: "installation",
        id: "019a0000-0000-7000-8000-0000000000d1",
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: [...INSTALLATION_SESSION_SCOPE_VALUES],
      },
      actor_user_id: USERS.nonmember,
      surface: {
        kind: "slack",
        slack_user_kind: "member",
        ceiling: DEFAULT_SURFACE_CEILING,
        agent_id: AGENT,
        channel_id: channelId,
      },
    },
  });
  // The person the signed Slack payload names, as the identity reader finds
  // them from the installation.
  const linked: IdentityReader = {
    reread: async () => ({
      status: "ok",
      principal: {
        kind: "user",
        id: USERS.nonmember,
        workspace_id: WORKSPACE,
        role: "member",
        scopes: [...scopesForRole("member")],
      },
    }),
  };

  test("in the session's own channel is a member's, with Slack not asked", async () => {
    const { check, asked } = members();
    const viewers: SessionViewer[] = [];
    await reason(
      slackCaller(CHANNEL),
      linked,
      "session.read",
      PRIVATE_SESSION,
      {
        check,
        viewers,
      },
    );
    expect(viewers.map((viewer) => viewer.privateChannels)).toEqual([
      [CONVERSATION],
    ]);
    expect(asked).toEqual([]);
  });

  test("from another channel asks Slack whether the person is a member", async () => {
    const { check, asked } = members();
    const viewers: SessionViewer[] = [];
    expect(
      await reason(
        slackCaller("D0CARD"),
        linked,
        "session.read",
        PRIVATE_SESSION,
        {
          check,
          viewers,
        },
      ),
    ).toBe("not_found");
    expect(viewers.map((viewer) => viewer.privateChannels)).toEqual([[]]);
    expect(asked).toEqual([USERS.nonmember]);
  });
});

describe("the private channels a read across sessions takes", () => {
  test("are those whose member may use the agent; a key has none", async () => {
    const of = (caller: Caller, identity: IdentityReader) =>
      policyFor(identity).privateChannelsOf?.(caller.subject, WORKSPACE);
    expect(await of(person("member"), plain)).toEqual([CONVERSATION]);
    for (const who of [
      "nonmember",
      "requester",
      "owner",
      "outsider",
    ] as const) {
      expect(await of(person(who), plain)).toEqual([]);
    }
    expect(await of(KEYS.personal.caller, KEYS.personal.identity)).toEqual([]);
    expect(await of(KEYS.agent.caller, KEYS.agent.identity)).toEqual([]);
  });

  test("ask Slack at most 8 channels at once", async () => {
    let running = 0;
    let most = 0;
    const check: ChannelMemberCheckable = {
      async isMember() {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return true;
      },
    };
    const places = Array.from({ length: 20 }, (_, i) => ({
      conversationId: `019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      agentId: AGENT,
      channelId: `C${i}`,
    }));
    const policy = createAuthorizationPolicy({
      identity: plain,
      agents,
      sessions: { ...sessionsSeen(), privateChannels: async () => places },
      channelMembers: check,
    });
    const caller = person("member");
    expect(
      await policy.privateChannelsOf?.(caller.subject, WORKSPACE),
    ).toHaveLength(20);
    expect(most).toBe(8);
  });
});

describe("pending requests after the requester left", () => {
  function pendingFor(caller: Caller) {
    return {
      caller,
      pending: createPendingRequestService({
        authorization: policyFor(plain),
        store: {
          async listOpen() {
            return [];
          },
          async answerAtomic() {
            throw new Error("never reached");
          },
          async recordSelfApproval() {
            throw new Error("never reached");
          },
          async requestOutcome() {
            throw new Error("never reached");
          },
        },
      }),
    };
  }

  test("a member of the channel reads them; the requester who left does not", async () => {
    const member = pendingFor(person("member"));
    expect(
      await member.pending.listPendingRequests(member.caller, PRIVATE_SESSION),
    ).toMatchObject({ items: [] });
    const gone = pendingFor(person("requester"));
    const error = await gone.pending
      .listPendingRequests(gone.caller, PRIVATE_SESSION)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "NOT_FOUND" });
  });
});
