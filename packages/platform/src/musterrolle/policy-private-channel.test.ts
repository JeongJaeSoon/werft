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
import type {
  ChannelMemberCheckable,
  ChannelMembership,
} from "../surface/ports/channel-member-checkable.ts";
import { createMemberService } from "./member-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type IdentityReader,
  readerOutsideChannels,
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
    async membership(input) {
      return answer(input.userId) ? "member" : "not_member";
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
    logger?: { warn(message: string, fields?: Record<string, unknown>): void };
  } = {},
) {
  return createAuthorizationPolicy({
    identity,
    agents,
    sessions: sessionsSeen(options.viewers),
    channelMembers: options.check ?? members().check,
    ...(options.decisions ? { decisions: options.decisions } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
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

  test("log why a channel is hidden when the agent may not be used", async () => {
    const warned: { message: string; fields?: unknown }[] = [];
    const check = members();
    const caller = person("outsider");
    const seen = await policyFor(plain, {
      check: check.check,
      logger: { warn: (message, fields) => warned.push({ message, fields }) },
    }).privateChannelsOf?.(caller.subject, WORKSPACE);
    expect(seen).toEqual([]);
    expect(check.asked).toEqual([]);
    expect(warned).toEqual([
      {
        message: "Private channel hidden; agent usage denied",
        fields: {
          event: "session.private_channel.usage_denied",
          reason: "usage_denied",
          workspace_id: WORKSPACE,
          agent_id: AGENT.toLowerCase(),
          channel_id: CHANNEL,
        },
      },
    ]);
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
      membership: async () => "member",
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

describe("Codex round 1 (94S-1999)", () => {
  const fromChannel = (who: Person): [Caller, IdentityReader] => [
    {
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
        actor_user_id: USERS[who],
        surface: {
          kind: "slack",
          slack_user_kind: "member",
          ceiling: DEFAULT_SURFACE_CEILING,
          agent_id: AGENT,
          channel_id: CHANNEL,
        },
      },
    },
    {
      reread: async () => ({
        status: "ok",
        principal: {
          kind: "user",
          id: USERS[who],
          workspace_id: WORKSPACE,
          role: ROLES[who],
          scopes: [...scopesForRole(ROLES[who])],
        },
      }),
    },
  ];

  test("a Slack decision from the channel still needs the agent access", async () => {
    const viewers: SessionViewer[] = [];
    const [caller, identity] = fromChannel("outsider");
    await reason(caller, identity, "session.read", PRIVATE_SESSION, {
      viewers,
    });
    expect(viewers.map((viewer) => viewer.privateChannels)).toEqual([[]]);
  });

  test("an owner outside the channel takes no control of it, reason or not", async () => {
    for (const action of ["session.control", "session.recover"] as const) {
      expect(
        await reason(person("owner"), plain, action, PRIVATE_SESSION, {
          justification: "incident 42",
        }),
      ).toBe("not_found");
    }
  });
});
// Answer 15 (PR2): an offboarded requester's session in a private channel
// goes to whoever in the channel may write to it, never to an owner outside.
describe("taking over a private channel's session", () => {
  function takeovers(inChannel: readonly string[]) {
    const taken: unknown[] = [];
    const sessions = sessionsSeen();
    const service = createMemberService({
      authorization: policyFor(plain, {
        check: members((userId) => inChannel.includes(userId)).check,
      }),
      store: {
        setAccess: async () => {
          throw new Error("not a takeover");
        },
        listAwaitingTakeover: async () => ({ items: [], total: 0 }),
        takeOver: async (input) => {
          taken.push({
            sessionId: input.sessionId,
            newRequesterId: input.newRequesterId,
            justification: input.justification,
          });
          return { outcome: "taken_over", receiptId: "r" };
        },
      },
      sessions: {
        privateChannels: (ownerId, sessionId) =>
          sessions.privateChannels?.(ownerId, sessionId) ?? Promise.resolve([]),
      },
    });
    return { service, taken };
  }

  const WITH_OWNER = [...IN_CHANNEL, USERS.owner];
  test.each([
    [
      "a member of the channel",
      "member",
      PRIVATE_SESSION,
      IN_CHANNEL,
      null,
      "taken",
    ],
    [
      "an owner in the channel",
      "owner",
      PRIVATE_SESSION,
      WITH_OWNER,
      null,
      "taken",
    ],
    [
      "an owner in the channel, the reason dropped",
      "owner",
      PRIVATE_SESSION,
      WITH_OWNER,
      "audit",
      "taken",
    ],
    [
      "an owner outside the channel",
      "owner",
      PRIVATE_SESSION,
      IN_CHANNEL,
      null,
      "NOT_FOUND",
    ],
    [
      "an owner outside the channel, with a reason",
      "owner",
      PRIVATE_SESSION,
      IN_CHANNEL,
      "audit",
      "NOT_FOUND",
    ],
    [
      "a member outside the channel",
      "nonmember",
      PRIVATE_SESSION,
      IN_CHANNEL,
      null,
      "NOT_FOUND",
    ],
    [
      "the requester who left",
      "requester",
      PRIVATE_SESSION,
      IN_CHANNEL,
      null,
      "NOT_FOUND",
    ],
    [
      "in the channel without the agent",
      "outsider",
      PRIVATE_SESSION,
      IN_CHANNEL,
      null,
      "NOT_FOUND",
    ],
    [
      "an owner, a session outside any channel (as before)",
      "owner",
      OPEN_SESSION,
      IN_CHANNEL,
      null,
      "taken",
    ],
    [
      "a member, a session outside any channel (as before)",
      "member",
      OPEN_SESSION,
      IN_CHANNEL,
      null,
      "FORBIDDEN",
    ],
  ] as const)(
    "%s",
    async (_name, who, sessionId, inChannel, justification, expected) => {
      const { service, taken } = takeovers(inChannel);
      const outcome = await service
        .takeOverSession(person(who), sessionId, justification)
        .then(
          () => "taken",
          (error: unknown) =>
            error instanceof SessionServiceError ? error.code : String(error),
        );
      expect(outcome).toBe(expected);
      expect(taken).toEqual(
        expected === "taken"
          ? [
              {
                sessionId,
                newRequesterId: USERS[who],
                justification:
                  sessionId === PRIVATE_SESSION ? null : justification,
              },
            ]
          : [],
      );
    },
  );
});
// Answer 15 (PR2): a session's direct message reaches only someone who can
// see it; the unknown counts as outside, as a notice leaks on a guess.
describe("a direct message about a private channel's session", () => {
  const sessions = sessionsSeen();
  const privateChannels = (ownerId: string, sessionId: string | null) =>
    sessions.privateChannels?.(ownerId, sessionId) ?? Promise.resolve([]);
  test.each([
    ["a session outside any channel", OPEN_SESSION, "not_member", false, 0],
    ["an account in the channel", PRIVATE_SESSION, "member", false, 1],
    [
      "an account that left the channel",
      PRIVATE_SESSION,
      "not_member",
      true,
      1,
    ],
    ["a membership not confirmed", PRIVATE_SESSION, "unconfirmed", true, 1],
  ] as const)("%s", async (_name, sessionId, answer, outside, asks) => {
    const asked: PrivateChannelPlace[] = [];
    expect(
      await readerOutsideChannels(
        { sessions: { privateChannels } },
        {
          workspaceId: WORKSPACE,
          sessionId,
          membership: async (place: PrivateChannelPlace) => {
            asked.push(place);
            return answer as ChannelMembership;
          },
        },
      ),
    ).toBe(outside);
    expect(asked).toEqual(Array(asks).fill(PLACE));
  });

  test("counts as outside when the channels cannot be read", async () => {
    expect(
      await readerOutsideChannels(
        {
          sessions: {
            privateChannels: () => Promise.reject(new Error("db down")),
          },
        },
        {
          workspaceId: WORKSPACE,
          sessionId: PRIVATE_SESSION,
          membership: async () => "member",
        },
      ),
    ).toBe(true);
  });
});

// 94S-2052, Architect: a channel no binding names is held private, and each
// such decision leaves a warning to count them by.
describe("a session from a channel of unknown kind", () => {
  test("is behind the door and logged", async () => {
    const warned: { message: string; fields?: unknown }[] = [];
    const base = sessionsSeen();
    const policy = createAuthorizationPolicy({
      identity: plain,
      agents,
      sessions: {
        ...base,
        async privateChannels(ownerId, sessionId) {
          return ((await base.privateChannels?.(ownerId, sessionId)) ?? []).map(
            (place) => ({ ...place, kindUnknown: true as const }),
          );
        },
      },
      channelMembers: members().check,
      logger: {
        warn(message, fields) {
          warned.push({ message, fields });
        },
      },
    });
    const ask = async (who: Person) => {
      const caller = person(who);
      return (
        await policy.authorize({
          subject: caller.subject,
          action: "session.read",
          resource: {
            kind: "session",
            id: PRIVATE_SESSION,
            owner_scope: WORKSPACE,
          },
          request_id: caller.requestId,
        })
      ).reason_code;
    };
    expect(await ask("member")).toBe("ok");
    expect(await ask("nonmember")).toBe("not_found");
    expect(warned).toContainEqual({
      message: "Channel kind unknown; held private",
      fields: {
        event: "session.private_channel.kind_unknown",
        conversation_count: 1,
      },
    });
  });
});

// Codex (94S-2052): behind the door the share is changed only by someone
// who passes it.
describe("a share change on a private channel's session", () => {
  test("is not_found for its creator gone from the channel, role for a member who did not make it", async () => {
    expect(
      await reason(
        person("requester"),
        plain,
        "session.share",
        PRIVATE_SESSION,
      ),
    ).toBe("not_found");
    expect(
      await reason(person("member"), plain, "session.share", PRIVATE_SESSION),
    ).toBe("role");
    expect(
      await reason(person("member"), plain, "session.share", OPEN_SESSION),
    ).toBe("ok");
  });
});
