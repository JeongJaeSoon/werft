import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationReason,
  type AuthorizationRequest,
  type AuthorizationSubject,
  authorizationDecisionSchema,
  type Principal,
  SLACK_SURFACE_ACTION_VALUES,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type AgentAuthority,
  createAuthorizationPolicy,
  type IdentityReader,
} from "./policy.ts";
import type {
  ConversationAccess,
  ConversationListening,
  ConversationPlaceFacts,
} from "./ports/conversation-access.ts";
import type { DecisionEntry } from "./ports/decision-log.ts";

// Design 9-3, one row per permission: conversation.view, conversation.post,
// session.submit (unchanged, see policy-shares.test.ts), task.spawn,
// session.approve as task.approve (unchanged, ditto) and session.audit_read
// widened to conversations as conversation.audit.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
// Usable by its workspace's managers alone.
const PRIVATE_AGENT = "019a0000-0000-7000-8000-00000000a0a2";

const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  // A linked member of every channel, inside AGENT.
  member: "019a0000-0000-7000-8000-0000000000c3",
  // Linked and inside AGENT, but not in the private channel.
  outsider: "019a0000-0000-7000-8000-0000000000c4",
  // In the private channel by Slack's list, with no live Slack link.
  unlinked: "019a0000-0000-7000-8000-0000000000c5",
  // Linked, a channel member, may use AGENT but is not inside it.
  user_only: "019a0000-0000-7000-8000-0000000000c6",
} as const;
type Who = keyof typeof USERS;
const ROLES: Record<Who, WorkspaceRole> = {
  owner: "owner",
  admin: "admin",
  member: "member",
  outsider: "member",
  unlinked: "member",
  user_only: "member",
};

const PUBLIC = "019a0000-0000-7000-8000-00000000b0a1";
const PRIVATE = "019a0000-0000-7000-8000-00000000b0a2";
const MEMBERS_DM = "019a0000-0000-7000-8000-00000000b0a3";
const ARCHIVED = "019a0000-0000-7000-8000-00000000b0a4";
const NOT_LISTENING = "019a0000-0000-7000-8000-00000000b0a5";
const PRIVATE_AGENTS = "019a0000-0000-7000-8000-00000000b0a6";
const PRIVATE_AGENTS_PRIVATE = "019a0000-0000-7000-8000-00000000b0a7";
const PRIVATE_AGENTS_DM = "019a0000-0000-7000-8000-00000000b0a8";
const MISSING = "019a0000-0000-7000-8000-00000000b0ff";

const channel = (
  channelId: string,
  isPrivate = false,
  agentId = AGENT,
): ConversationPlaceFacts => ({
  agentId,
  kind: "channel",
  channelId,
  private: isPrivate,
});
const PLACES: Record<string, ConversationPlaceFacts> = {
  [PUBLIC]: channel("C0PUBLIC"),
  [PRIVATE]: channel("C0PRIVATE", true),
  [MEMBERS_DM]: { agentId: AGENT, kind: "dm", personUserId: USERS.member },
  [ARCHIVED]: channel("C0ARCHIVED"),
  [NOT_LISTENING]: channel("C0QUIET"),
  [PRIVATE_AGENTS]: channel("C0OTHER", false, PRIVATE_AGENT),
  // The member is in it by Slack's list, but may not use its agent.
  [PRIVATE_AGENTS_PRIVATE]: channel("C0PRIVATE", true, PRIVATE_AGENT),
  [PRIVATE_AGENTS_DM]: {
    agentId: PRIVATE_AGENT,
    kind: "dm",
    personUserId: USERS.member,
  },
};
const LINKED = new Set<string>([
  USERS.owner,
  USERS.admin,
  USERS.member,
  USERS.outsider,
  USERS.user_only,
]);
const IN_PRIVATE = new Set<string>([
  USERS.member,
  USERS.unlinked,
  USERS.user_only,
]);

function access(overrides: Partial<ConversationAccess> = {}) {
  const reads: string[] = [];
  const port: ConversationAccess = {
    async placeOf(_workspaceId, id) {
      reads.push("place");
      return PLACES[id] ?? null;
    },
    async slackLinked(_workspaceId, _agentId, userId) {
      reads.push("link");
      return LINKED.has(userId);
    },
    async isMember({ channelId, userId }) {
      reads.push("member");
      return channelId === "C0PRIVATE" ? IN_PRIVATE.has(userId) : true;
    },
    async archived(_workspaceId, id) {
      reads.push("archived");
      return id === ARCHIVED;
    },
    async listening(_workspaceId, id): Promise<ConversationListening> {
      reads.push("listening");
      return id === NOT_LISTENING ? "off" : "free";
    },
    ...overrides,
  };
  return { port, reads };
}

const agents: AgentAuthority = {
  async agentOf() {
    return null;
  },
  async isAdmin() {
    return false;
  },
  async isInside(_workspaceId, agentId, userId) {
    return agentId === AGENT && userId !== USERS.user_only;
  },
  async usageOf(_workspaceId, agentId, who) {
    const allowed =
      agentId !== PRIVATE_AGENT || who.role === "owner" || who.role === "admin";
    return allowed
      ? { allowed, basis: "public", teamId: null }
      : { allowed: false };
  },
};

const plain: IdentityReader = {
  reread: async (s) => ({ status: "ok", principal: s.principal }),
};

function userSubject(who: Who): AuthorizationSubject {
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role: ROLES[who],
    scopes: [...scopesForRole(ROLES[who])],
  };
  return { principal, actor_user_id: USERS[who], surface: { kind: "web" } };
}

async function decide(
  subject: AuthorizationSubject,
  action: AuthorizationAction,
  conversationId: string,
  options: {
    conversations?: ConversationAccess | null;
    identity?: IdentityReader;
    recorded?: DecisionEntry[];
  } = {},
) {
  const policy = createAuthorizationPolicy({
    identity: options.identity ?? plain,
    agents,
    ...(options.conversations === null
      ? {}
      : { conversations: options.conversations ?? access().port }),
    ...(options.recorded
      ? {
          decisions: {
            record: async (entry: DecisionEntry) => {
              options.recorded?.push(entry);
            },
          },
        }
      : {}),
  });
  const request: AuthorizationRequest = {
    subject,
    action,
    resource: {
      kind: "conversation",
      id: conversationId,
      owner_scope: WORKSPACE,
    },
    request_id: "r",
  };
  return authorizationDecisionSchema.parse(await policy.authorize(request));
}

const reason = async (
  who: Who,
  action: AuthorizationAction,
  conversationId: string,
  justification?: string,
) =>
  (
    await decide(
      {
        ...userSubject(who),
        ...(justification === undefined ? {} : { justification }),
      },
      action,
      conversationId,
    )
  ).reason_code;

type Row = [Who, string, AuthorizationReason];

async function table(action: AuthorizationAction, rows: readonly Row[]) {
  const got = await Promise.all(
    rows.map(async ([who, id]) => reason(who, action, id)),
  );
  expect(got).toEqual(rows.map(([, , want]) => want));
}

describe("conversation.view", () => {
  test("a public channel is the agent's usage rule, with no membership check", async () => {
    await table("conversation.view", [
      ["member", PUBLIC, "ok"],
      ["outsider", PUBLIC, "ok"],
      ["unlinked", PUBLIC, "ok"],
      ["user_only", PUBLIC, "ok"],
      ["owner", PUBLIC, "ok"],
      ["member", PRIVATE_AGENTS, "agent_private"],
      ["admin", PRIVATE_AGENTS, "ok"],
    ]);
    const { port, reads } = access();
    await decide(userSubject("member"), "conversation.view", PUBLIC, {
      conversations: port,
    });
    expect(reads).not.toContain("member");
  });

  test("a private channel adds a live Slack link and current membership, and hides the rest", async () => {
    await table("conversation.view", [
      ["member", PRIVATE, "ok"],
      ["user_only", PRIVATE, "ok"],
      ["outsider", PRIVATE, "not_found"],
      ["unlinked", PRIVATE, "not_found"],
      // A manager outside the channel does not see it either.
      ["owner", PRIVATE, "not_found"],
      // Nor does someone who may not use its agent learn that it is there.
      ["member", PRIVATE_AGENTS_PRIVATE, "not_found"],
    ]);
    for (const action of NEW_ACTIONS) {
      expect(await reason("member", action, PRIVATE_AGENTS_PRIVATE)).toBe(
        "not_found",
      );
    }
  });

  test("a public channel never reads the Slack link to be seen", async () => {
    const { port, reads } = access({
      slackLinked: async () => {
        throw new Error("link store down");
      },
    });
    const decision = await decide(
      userSubject("member"),
      "conversation.view",
      PUBLIC,
      { conversations: port },
    );
    expect(decision.reason_code).toBe("ok");
    expect(reads).toEqual(["place"]);
  });

  test("a membership that cannot be confirmed hides the channel", async () => {
    const { port } = access({ isMember: async () => false });
    const decision = await decide(
      userSubject("member"),
      "conversation.view",
      PRIVATE,
      { conversations: port },
    );
    expect(decision.reason_code).toBe("not_found");
  });

  test("a DM is its person's alone", async () => {
    await table("conversation.view", [
      ["member", MEMBERS_DM, "ok"],
      ["outsider", MEMBERS_DM, "not_found"],
      ["owner", MEMBERS_DM, "not_found"],
      ["admin", MEMBERS_DM, "not_found"],
    ]);
  });

  test("an archived or quiet channel can still be seen", async () => {
    await table("conversation.view", [
      ["member", ARCHIVED, "ok"],
      ["member", NOT_LISTENING, "ok"],
    ]);
  });

  test("a conversation that is not there is not found", async () => {
    await table("conversation.view", [["member", MISSING, "not_found"]]);
  });
});

describe("conversation.post", () => {
  test("is view, a live Slack link, not archived and listening not off", async () => {
    await table("conversation.post", [
      ["member", PUBLIC, "ok"],
      ["unlinked", PUBLIC, "unlinked"],
      ["member", ARCHIVED, "conversation_archived"],
      ["member", NOT_LISTENING, "listening_off"],
      ["member", PRIVATE, "ok"],
      ["outsider", PRIVATE, "not_found"],
      ["unlinked", PRIVATE, "not_found"],
      ["member", PRIVATE_AGENTS, "agent_private"],
    ]);
  });

  test("seeing a channel does not let anyone post to it", async () => {
    expect(await reason("unlinked", "conversation.view", PUBLIC)).toBe("ok");
    expect(await reason("unlinked", "conversation.post", PUBLIC)).toBe(
      "unlinked",
    );
  });

  test("a DM whose person may no longer use its agent is seen, never written to", async () => {
    expect(await reason("member", "conversation.view", PRIVATE_AGENTS_DM)).toBe(
      "ok",
    );
    for (const action of ["conversation.post", "task.spawn"] as const) {
      expect(await reason("member", action, PRIVATE_AGENTS_DM)).toBe(
        "agent_private",
      );
    }
  });

  test("a web DM is its person's and needs no Slack link", async () => {
    await table("conversation.post", [
      ["member", MEMBERS_DM, "ok"],
      ["outsider", MEMBERS_DM, "not_found"],
    ]);
    const { port, reads } = access();
    await decide(userSubject("member"), "conversation.post", MEMBERS_DM, {
      conversations: port,
    });
    expect(reads).toEqual(["place"]);
  });
});

describe("task.spawn", () => {
  test("is post and today's start on that agent", async () => {
    await table("task.spawn", [
      ["member", PUBLIC, "ok"],
      ["user_only", PUBLIC, "role"],
      ["owner", PUBLIC, "ok"],
      ["unlinked", PUBLIC, "unlinked"],
      ["member", ARCHIVED, "conversation_archived"],
      ["member", NOT_LISTENING, "listening_off"],
      ["member", PRIVATE, "ok"],
      ["user_only", PRIVATE, "role"],
      ["outsider", PRIVATE, "not_found"],
      ["member", MEMBERS_DM, "ok"],
      ["outsider", MEMBERS_DM, "not_found"],
    ]);
  });

  test("posting does not let anyone start a task", async () => {
    expect(await reason("user_only", "conversation.post", PUBLIC)).toBe("ok");
    expect(await reason("user_only", "task.spawn", PUBLIC)).toBe("role");
  });
});

describe("session.audit_read on a conversation", () => {
  test("is the workspace's managers', with a reason, on DMs and private channels", async () => {
    for (const id of [MEMBERS_DM, PRIVATE, PUBLIC]) {
      expect(await reason("owner", "session.audit_read", id, "dispute")).toBe(
        "ok",
      );
      expect(await reason("admin", "session.audit_read", id, "dispute")).toBe(
        "ok",
      );
      expect(await reason("member", "session.audit_read", id, "dispute")).toBe(
        "role",
      );
    }
    expect(await reason("owner", "session.audit_read", PRIVATE)).toBe(
      "justification_required",
    );
    expect(await reason("owner", "session.audit_read", PRIVATE, "  ")).toBe(
      "justification_required",
    );
    expect(await reason("owner", "session.audit_read", MISSING, "x")).toBe(
      "not_found",
    );
  });

  test("leaves one decision row per read, with its reason", async () => {
    const recorded: DecisionEntry[] = [];
    await decide(
      { ...userSubject("admin"), justification: "dispute" },
      "session.audit_read",
      MEMBERS_DM,
      { recorded },
    );
    await decide(userSubject("admin"), "session.audit_read", MEMBERS_DM, {
      recorded,
    });
    expect(
      recorded.map(({ request, decision }) => [
        request.resource.kind,
        decision.outcome,
        decision.reason_code,
        request.subject.justification ?? null,
      ]),
    ).toEqual([
      ["conversation", "allow", "ok", "dispute"],
      ["conversation", "deny", "justification_required", null],
    ]);
  });
});

const NEW_ACTIONS = [
  "conversation.view",
  "conversation.post",
  "task.spawn",
] as const satisfies readonly AuthorizationAction[];

describe("every conversation decision", () => {
  test("is recorded, allows included", async () => {
    const recorded: DecisionEntry[] = [];
    for (const action of NEW_ACTIONS) {
      await decide(userSubject("member"), action, PUBLIC, { recorded });
      await decide(userSubject("outsider"), action, PRIVATE, { recorded });
    }
    expect(
      recorded.map(({ request, decision }) => [
        request.action,
        decision.outcome,
        decision.reason_code,
      ]),
    ).toEqual(
      NEW_ACTIONS.flatMap((action) => [
        [action, "allow", "ok"],
        [action, "deny", "not_found"],
      ]),
    );
  });

  test("refuses every API key, personal or the agent's (decision 44)", async () => {
    const key = (
      creator: Who | null,
    ): { subject: AuthorizationSubject; identity: IdentityReader } => {
      const principal: Principal = {
        kind: "api_key",
        id: "019a0000-0000-7000-8000-0000000000f1",
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: ["sessions:read", "sessions:write", "sessions:approve"],
      };
      return {
        subject: {
          principal,
          ...(creator === null ? {} : { actor_user_id: USERS[creator] }),
          surface: { kind: "api" },
        },
        identity: {
          reread: async () => ({
            status: "ok",
            principal,
            ...(creator === null
              ? { keyAgentId: AGENT }
              : {
                  keyCreator: { userId: USERS[creator], role: ROLES[creator] },
                }),
          }),
        },
      };
    };
    for (const creator of ["member", "owner", null] as const) {
      const { subject, identity } = key(creator);
      for (const action of [...NEW_ACTIONS, "session.audit_read"] as const) {
        const decision = await decide(
          { ...subject, justification: "dispute" },
          action,
          MEMBERS_DM,
          { identity },
        );
        expect(decision.reason_code).toBe("role");
      }
    }
  });

  test("is refused without the conversation store, or for an id that is no conversation id", async () => {
    for (const action of [...NEW_ACTIONS, "session.audit_read"] as const) {
      const unwired = await decide(
        { ...userSubject("owner"), justification: "dispute" },
        action,
        PUBLIC,
        { conversations: null },
      );
      expect(unwired.reason_code).toBe("error");
      expect(await reason("owner", action, "C0PUBLIC", "dispute")).toBe(
        "error",
      );
    }
  });

  test("is not found from another workspace's partition", async () => {
    const policy = createAuthorizationPolicy({
      identity: plain,
      agents,
      conversations: access().port,
    });
    const decision = await policy.authorize({
      subject: userSubject("member"),
      action: "conversation.view",
      resource: {
        kind: "conversation",
        id: PUBLIC,
        owner_scope: "019a0000-0000-7000-8000-0000000000a2",
      },
      request_id: "r",
    });
    expect(decision.reason_code).toBe("not_found");
  });

  test("fits no other resource, and session actions fit no conversation", async () => {
    const policy = createAuthorizationPolicy({
      identity: plain,
      agents,
      conversations: access().port,
    });
    const on = async (
      action: AuthorizationAction,
      kind: "session" | "conversation",
    ) =>
      (
        await policy.authorize({
          subject: userSubject("member"),
          action,
          resource: { kind, id: PUBLIC, owner_scope: WORKSPACE },
          request_id: "r",
        })
      ).reason_code;
    for (const action of NEW_ACTIONS) {
      expect(await on(action, "session")).toBe("error");
    }
    for (const action of [
      "session.read",
      "session.submit",
      "session.approve",
    ] as const) {
      expect(await on(action, "conversation")).toBe("error");
    }
  });
});

// v1-b/S1: Slack opens task.spawn as the linked person; view and post stay
// on the web and the API.
const INSTALLATION: Principal = {
  kind: "installation",
  id: "019a0000-0000-7000-8000-0000000000e1",
  owner_id: WORKSPACE,
  workspace_id: WORKSPACE,
  scopes: ["sessions:read", "sessions:write", "sessions:approve"],
};
const CHANNEL_OF: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(PLACES).map(([id, place]) => [
    id,
    place.kind === "channel" ? place.channelId : undefined,
  ]),
);

// As the database reader: a linked account resolves to its person, with
// their role now; no link names nobody.
const slackIdentity: IdentityReader = {
  reread: async (s) => {
    const who = (Object.keys(USERS) as Who[]).find(
      (w) => USERS[w] === s.actor_user_id,
    );
    return who === undefined || !LINKED.has(USERS[who])
      ? { status: "unlinked" }
      : { status: "ok", principal: userSubject(who).principal as Principal };
  },
};

function slackSubject(
  who: Who,
  conversationId: string,
  surface: Partial<Extract<AuthorizationSubject["surface"], object>> = {},
): AuthorizationSubject {
  const channelId = CHANNEL_OF[conversationId];
  return {
    principal: INSTALLATION,
    actor_user_id: USERS[who],
    linked_account: {
      id: "019a0000-0000-7000-8000-0000000000d1",
      revision: 1,
    },
    surface: {
      kind: "slack",
      slack_user_kind: "member",
      agent_id: AGENT,
      ceiling: {
        actions: [...SLACK_SURFACE_ACTION_VALUES],
        disclosure: "full",
      },
      ...(channelId === undefined ? {} : { channel_id: channelId }),
      ...surface,
    },
  };
}

const slackDecide = (
  subject: AuthorizationSubject,
  action: AuthorizationAction,
  conversationId: string,
  options: Parameters<typeof decide>[3] = {},
) =>
  decide(subject, action, conversationId, {
    identity: slackIdentity,
    ...options,
  });

const onSlack = async (
  who: Who,
  conversationId: string,
  action: AuthorizationAction = "task.spawn",
) =>
  (await slackDecide(slackSubject(who, conversationId), action, conversationId))
    .reason_code;

describe("task.spawn on Slack", () => {
  test("is post on a channel or the person's own DM, and today's start, as the linked person", async () => {
    const rows: Row[] = [
      // A public channel: no membership check.
      ["member", PUBLIC, "ok"],
      ["outsider", PUBLIC, "ok"],
      ["owner", PUBLIC, "ok"],
      ["user_only", PUBLIC, "role"],
      ["unlinked", PUBLIC, "unlinked"],
      ["member", ARCHIVED, "conversation_archived"],
      ["member", NOT_LISTENING, "listening_off"],
      // A private channel: a member now, and the rest hidden.
      ["member", PRIVATE, "ok"],
      ["user_only", PRIVATE, "role"],
      ["outsider", PRIVATE, "not_found"],
      ["owner", PRIVATE, "not_found"],
      ["unlinked", PRIVATE, "unlinked"],
      // A DM: its person alone.
      ["member", MEMBERS_DM, "ok"],
      ["outsider", MEMBERS_DM, "not_found"],
      ["owner", MEMBERS_DM, "not_found"],
      ["unlinked", MEMBERS_DM, "unlinked"],
    ];
    const got = await Promise.all(rows.map(([who, id]) => onSlack(who, id)));
    expect(got).toEqual(rows.map(([, , want]) => want));
  });

  test("asks Slack for the private channel's membership now, and refuses what it cannot confirm", async () => {
    const { port, reads } = access();
    await slackDecide(slackSubject("member", PRIVATE), "task.spawn", PRIVATE, {
      conversations: port,
    });
    expect(reads).toContain("member");
    const unconfirmed = access({ isMember: async () => false });
    const decision = await slackDecide(
      slackSubject("member", PRIVATE),
      "task.spawn",
      PRIVATE,
      { conversations: unconfirmed.port },
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.reason_code).toBe("not_found");
  });

  test("is the private agent's usage rule", async () => {
    const as = (who: Who, id: string) =>
      slackDecide(
        slackSubject(who, id, { agent_id: PRIVATE_AGENT }),
        "task.spawn",
        id,
      ).then((d) => d.reason_code);
    expect(await as("member", PRIVATE_AGENTS)).toBe("agent_private");
    expect(await as("member", PRIVATE_AGENTS_DM)).toBe("agent_private");
    expect(await as("member", PRIVATE_AGENTS_PRIVATE)).toBe("not_found");
  });

  test("reaches only the conversations of the agent whose app heard it, from that very place", async () => {
    const other = await slackDecide(
      slackSubject("admin", PRIVATE_AGENTS),
      "task.spawn",
      PRIVATE_AGENTS,
    );
    expect(other.reason_code).toBe("agent_ceiling");
    for (const [id, channel_id] of [
      [PUBLIC, "C0QUIET"],
      [MEMBERS_DM, "C0PUBLIC"],
    ] as const) {
      const elsewhere = await slackDecide(
        slackSubject("member", id, { channel_id }),
        "task.spawn",
        id,
      );
      expect(elsewhere.reason_code).toBe("error");
    }
    const { channel_id: _dropped, ...noChannel } = slackSubject(
      "member",
      PUBLIC,
    ).surface;
    const fromDm = await slackDecide(
      { ...slackSubject("member", PUBLIC), surface: noChannel },
      "task.spawn",
      PUBLIC,
    );
    expect(fromDm.reason_code).toBe("error");
  });

  test("passes the channel's ceiling a session start does", async () => {
    const decision = await slackDecide(
      slackSubject("member", PUBLIC, {
        ceiling: { actions: ["session.read"], disclosure: "full" },
      }),
      "task.spawn",
      PUBLIC,
    );
    expect(decision.reason_code).toBe("surface_ceiling");
    const readOnlyInstall = await slackDecide(
      {
        ...slackSubject("member", PUBLIC),
        principal: { ...INSTALLATION, scopes: ["sessions:read"] },
      },
      "task.spawn",
      PUBLIC,
    );
    expect(readOnlyInstall.reason_code).toBe("surface_ceiling");
  });

  test("leaves view and post refused on Slack", async () => {
    for (const action of ["conversation.view", "conversation.post"] as const) {
      expect(await onSlack("member", PUBLIC, action)).toBe("surface_ceiling");
      expect(await onSlack("member", MEMBERS_DM, action)).toBe(
        "surface_ceiling",
      );
    }
  });

  test("refuses a key, and a bot that stands in for its agent (decision 44)", async () => {
    const key: Principal = {
      kind: "api_key",
      id: "019a0000-0000-7000-8000-0000000000f1",
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      scopes: ["sessions:read", "sessions:write", "sessions:approve"],
    };
    const keyed = await slackDecide(
      { ...slackSubject("member", PUBLIC), principal: key },
      "task.spawn",
      PUBLIC,
      { identity: { reread: async () => ({ status: "ok", principal: key }) } },
    );
    expect(keyed.outcome).toBe("deny");
    const {
      actor_user_id: _a,
      linked_account: _l,
      ...unnamed
    } = slackSubject("member", PUBLIC);
    const bot = await slackDecide(
      {
        ...unnamed,
        surface: { ...unnamed.surface, slack_bot_user_id: "U0BOT" },
      },
      "task.spawn",
      PUBLIC,
      {
        identity: {
          reread: async () => ({
            status: "ok",
            principal: INSTALLATION,
            keyAgentId: AGENT,
          }),
        },
      },
    );
    expect(bot.outcome).toBe("deny");
    expect(bot.reason_code).toBe("role");
  });

  test("is recorded, allows included", async () => {
    const recorded: DecisionEntry[] = [];
    await slackDecide(slackSubject("member", PUBLIC), "task.spawn", PUBLIC, {
      recorded,
    });
    await slackDecide(
      slackSubject("outsider", PRIVATE),
      "task.spawn",
      PRIVATE,
      {
        recorded,
      },
    );
    expect(
      recorded.map(({ request, decision }) => [
        request.subject.surface.kind,
        decision.outcome,
        decision.reason_code,
      ]),
    ).toEqual([
      ["slack", "allow", "ok"],
      ["slack", "deny", "not_found"],
    ]);
  });
});
