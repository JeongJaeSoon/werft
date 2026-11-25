import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationReason,
  type AuthorizationResource,
  authorizationDecisionSchema,
  type PendingRequest,
  type PostSessionAnswerRequest,
  type Principal,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { createPendingRequestService } from "../decision/pending-service.ts";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type {
  AnswerRequestInput,
  WorkerPendingStore,
} from "../sessions/ports/pending-requests.ts";
import type { PrivateChannelPlace } from "../sessions/ports/session-share-store.ts";
import { createSessionService } from "../sessions/session-service.ts";
import type { ChannelMemberCheckable } from "../surface/ports/channel-member-checkable.ts";
import { testCatalog } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import { createWorkerGateway } from "../workers/worker-gateway.ts";
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
  // Q5 (94S-2175): a tool permission or question card the session waits on.
  const PENDING = "toolu_pending_1";
  const B = "019a0000-0000-7000-8000-0000000000c7";

  function policyWith(options: {
    pushRequester?: string | null;
    pendingRequester?: string | null;
    inChannel?: (userId: string) => "member" | "not_member" | "unconfirmed";
    warned?: string[];
    identity?: IdentityReader;
  }) {
    const answer =
      options.inChannel ??
      ((userId: string) => (inChannel(userId) ? "member" : "not_member"));
    return createAuthorizationPolicy({
      identity: options.identity ?? plain,
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
        async pendingRequesterOf(_ownerId, sessionId, requestId) {
          return sessionId === PRIVATE_SESSION && requestId === PENDING
            ? options.pendingRequester === undefined
              ? USERS.requester
              : options.pendingRequester
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
      pending?: string;
    } = {},
  ): Promise<AuthorizationReason> {
    return (await decision(who, options)).reason_code;
  }

  async function decision(
    who: Caller,
    options: Parameters<typeof decide>[1] = {},
  ) {
    const push =
      options.pending !== undefined
        ? null
        : options.push === undefined
          ? PUSH
          : options.push;
    const decided = await policyWith(options).authorize({
      subject: who.subject,
      action: "session.approve",
      resource: {
        kind: "session",
        id: options.sessionId ?? PRIVATE_SESSION,
        owner_scope: WORKSPACE,
        ...(push === null ? {} : { push_request_id: push }),
        ...(options.pending === undefined
          ? {}
          : { pending_request_id: options.pending }),
      },
      request_id: who.requestId,
    });
    return authorizationDecisionSchema.parse(decided);
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

  test("a press that names no request keeps its rule", async () => {
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

  // Q5 (94S-2175): tool permission and question cards follow the same rule.
  test("before 94S-2175 a member got role on a tool permission or question; now a member answers one whose requester left", async () => {
    // Before: the press named no request, as it still may.
    expect(await decide(person("member"), { push: null })).toBe("role");
    const answered = await decision(person("member"), { pending: PENDING });
    expect(answered.reason_code).toBe("ok");
    // The store under its locks takes the member only on this mark.
    expect(answered.requester_left).toBe(true);
  });

  test("a tool permission or question: the requester who left and a non-member do not see it, a member without sessions:approve is refused", async () => {
    expect(await decide(person("requester"), { pending: PENDING })).toBe(
      "not_found",
    );
    expect(await decide(person("nonmember"), { pending: PENDING })).toBe(
      "not_found",
    );
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
    expect(await decide(noApprove, { pending: PENDING })).toBe("role");
  });

  test("a tool permission or question keeps its rule while the requester is in the channel, when no one can tell, or on a public channel", async () => {
    const stays = (userId: string) =>
      userId === USERS.member || userId === USERS.requester
        ? ("member" as const)
        : ("not_member" as const);
    expect(
      await decide(person("member"), { pending: PENDING, inChannel: stays }),
    ).toBe("role");
    // The requester still in the channel answers as before, with no mark.
    const own = await decision(person("requester"), {
      pending: PENDING,
      inChannel: stays,
    });
    expect(own.reason_code).toBe("ok");
    expect(own.requester_left).toBeUndefined();
    const warned: string[] = [];
    expect(
      await decide(person("member"), {
        pending: PENDING,
        inChannel: (userId) =>
          userId === USERS.member ? "member" : "unconfirmed",
        warned,
      }),
    ).toBe("role");
    expect(warned).toEqual([
      "Pending request's requester channel membership unconfirmed",
    ]);
    expect(
      await decide(person("member"), {
        pending: PENDING,
        sessionId: PUBLIC_SESSION,
      }),
    ).toBe("role");
    // No person behind the request, or a request not the session's.
    expect(
      await decide(person("member"), {
        pending: PENDING,
        pendingRequester: null,
      }),
    ).toBe("role");
    expect(await decide(person("member"), { pending: "toolu_other" })).toBe(
      "role",
    );
  });

  describe("answering through the pending request service", () => {
    const open = (requestId: string): PendingRequest => ({
      request_id: requestId,
      turn_id: "1",
      attempt_id: "att_1",
      created_at: "2026-11-25T00:00:00.000Z",
      expires_at: "2026-11-25T01:00:00.000Z",
      kind: "permission",
      tool: "Bash",
      input: { command: "ls" },
    });
    function answering(
      identity?: IdentityReader,
      inChannel?: (userId: string) => "member" | "not_member" | "unconfirmed",
    ) {
      const stored: AnswerRequestInput[] = [];
      const service = createPendingRequestService({
        authorization: policyWith({
          ...(identity === undefined ? {} : { identity }),
          ...(inChannel === undefined ? {} : { inChannel }),
        }),
        store: {
          async listOpen() {
            return [open(PENDING), open("toolu_other")];
          },
          async answerAtomic(input) {
            stored.push(input);
            return {
              outcome: "accepted",
              response: { receipt_id: RECEIPT, receipt_status: "accepted" },
            };
          },
          async recordSelfApproval() {
            throw new Error("never reached");
          },
          async requestOutcome() {
            throw new Error("never reached");
          },
        },
      });
      return { service, stored };
    }
    const RECEIPT = "019a0000-0000-7000-8000-00000000b0a1";

    test("a member's answer reaches the store marked, with its decision", async () => {
      const { service, stored } = answering();
      const member = person("member");
      const bodies: PostSessionAnswerRequest[] = [
        { request_id: PENDING, kind: "permission", decision: "allow" },
        {
          request_id: PENDING,
          kind: "question",
          answers: [{ question_id: "q1", selected_option_ids: ["o1"] }],
        },
      ];
      for (const body of bodies) {
        await service.answer(member, PRIVATE_SESSION, {
          idempotencyKey: `k-${body.kind}`,
          body,
        });
      }
      expect(stored.map((input) => input.requesterLeft)).toEqual([true, true]);
    });

    // 94S-2219: the console's list judges each request as its answer does.
    test("the console offers a member the request whose requester left, and nothing else of the session", async () => {
      const { service } = answering();
      const listed = await service.listPendingRequests(
        person("member"),
        PRIVATE_SESSION,
      );
      expect(listed.answerable).toBe(false);
      expect(
        listed.items.map((item) => [item.request_id, item.answerable]),
      ).toEqual([
        [PENDING, true],
        ["toolu_other", false],
      ]);
      // While the requester is in the channel, the member answers none.
      const stays = answering(undefined, (userId) =>
        userId === USERS.member || userId === USERS.requester
          ? "member"
          : "not_member",
      );
      const before = await stays.service.listPendingRequests(
        person("member"),
        PRIVATE_SESSION,
      );
      expect(before.items.map((item) => item.answerable)).toEqual([
        false,
        false,
      ]);
    });

    test("a person outside the channel, and the requester who left, get 404 from the list and the answer alike", async () => {
      const { service, stored } = answering();
      for (const who of ["nonmember", "requester"] as const) {
        const caller = person(who);
        expect(
          await service
            .listPendingRequests(caller, PRIVATE_SESSION)
            .catch((caught: unknown) => caught),
        ).toMatchObject({ code: "NOT_FOUND" });
        expect(
          await service
            .answer(caller, PRIVATE_SESSION, {
              idempotencyKey: `k-${who}`,
              body: {
                request_id: PENDING,
                kind: "permission",
                decision: "allow",
              },
            })
            .catch((caught: unknown) => caught),
        ).toMatchObject({ code: "NOT_FOUND" });
      }
      expect(stored).toEqual([]);
    });

    test("an answer the console sends for a request the list offered is taken, a session allow included", async () => {
      const { service, stored } = answering();
      const member = person("member");
      const listed = await service.listPendingRequests(member, PRIVATE_SESSION);
      const offered = listed.items.find((item) => item.answerable === true);
      expect(offered?.request_id).toBe(PENDING);
      await service.answer(member, PRIVATE_SESSION, {
        idempotencyKey: "k-console",
        body: {
          request_id: PENDING,
          kind: "permission",
          decision: "allow",
          remember: "session",
        },
      });
      expect(stored[0]).toMatchObject({
        requesterLeft: true,
        answer: { remember: "session" },
        sessionAllowSubject: member.subject,
      });
      // One the list did not offer is refused as its role.
      expect(
        await service
          .answer(member, PRIVATE_SESSION, {
            idempotencyKey: "k-other",
            body: {
              request_id: "toolu_other",
              kind: "permission",
              decision: "allow",
            },
          })
          .catch((caught: unknown) => caught),
      ).toMatchObject({ code: "FORBIDDEN" });
    });

    test("a member who took the card over may allow for the session, and the store keeps them as its giver", async () => {
      const { service, stored } = answering();
      const member = person("member");
      await service.answer(member, PRIVATE_SESSION, {
        idempotencyKey: "k",
        body: {
          request_id: PENDING,
          kind: "permission",
          decision: "allow",
          remember: "session",
        },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        requesterLeft: true,
        answer: { remember: "session" },
        sessionAllowSubject: member.subject,
      });
    });

    test("that member's session allow covers a later call only while they may still answer it", async () => {
      const member = person("member");
      let present = new Set<string>([USERS.member]);
      const gateway = createWorkerGateway({
        work: {} as WorkerUnitOfWork,
        catalog: testCatalog(),
        checkpoints: acceptAllCheckpoints,
        pending: {
          sessionAllowAtomic: async () => ({
            outcome: "ok",
            grant: { ownerScope: WORKSPACE, subject: member.subject },
          }),
        } as unknown as WorkerPendingStore,
        authorization: policyWith({
          inChannel: (userId) =>
            present.has(userId) ? "member" : "not_member",
        }),
        options: {
          sessionBudget: { costUsd: 1_000, tokens: null },
          leaseTtlMs: 30_000,
        },
      });
      const scope = {
        session_id: PRIVATE_SESSION,
        attempt_id: "att_1",
        lease_epoch: 1,
        execution_generation: 1,
        auth_revision: 0,
      };
      const check = () =>
        gateway.sessionAllow(
          {
            kind: "session",
            sessionId: PRIVATE_SESSION,
            attemptId: "att_1",
            leaseEpoch: 1,
            executionGeneration: 1,
            authRevision: 0,
          },
          {
            ...scope,
            turn_id: "1",
            grant_request_id: PENDING,
            tool_call_id: "toolu_later",
            input_hash: "a".repeat(64),
          },
        );
      expect(await check()).toEqual({ allowed: true });
      // The member left the channel: the next call is put to a person.
      present = new Set();
      expect(await check()).toEqual({ allowed: false });
      // Back in, and the requester too: the usual rule decides again, and a
      // member's role alone does not approve.
      present = new Set([USERS.member, USERS.requester]);
      expect(await check()).toEqual({ allowed: false });
      present = new Set([USERS.member]);
      expect(await check()).toEqual({ allowed: true });
    });
  });
});

// 94S-2259: [Continue] on a lost turn, from the web or Slack, is judged as a
// message of the presser's own: the requester and those who may write to
// the session, and on a private channel's session its current members only.
describe("going on from a lost turn through the session service", () => {
  function continuing() {
    const reached: string[] = [];
    const service = createSessionService({
      authorization: policyFor(plain),
      catalog: testCatalog({ repositories: {} }),
      controls: {} as never,
      reader: { getSession: async () => null } as never,
      limits: {
        queuedInputLimitPerSession: 10,
        storageLimitBytes: 1e9,
        sessionCostLimitUsd: 100,
        sessionTokenLimit: null,
      },
      releases: {} as never,
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not used");
        },
        async appendInputAtomic(input) {
          reached.push(input.callerSubject?.principal?.id ?? "");
          return {
            outcome: "accepted",
            response: {
              turn_id: "4",
              receipt_id: "019a0000-0000-7000-8000-00000000b0b1",
              receipt_status: "accepted",
            },
          };
        },
      },
    });
    const press = (who: Person, sessionId: string) =>
      service.continueTurn(person(who), sessionId, { turnId: 3 }).then(
        () => "continued",
        (error: { code?: string }) => error.code ?? "error",
      );
    return { press, reached };
  }

  test("on a private channel's session, a current member goes on; the requester who left and a non-member do not", async () => {
    const { press, reached } = continuing();
    expect(await press("member", PRIVATE_SESSION)).toBe("continued");
    expect(await press("requester", PRIVATE_SESSION)).toBe("NOT_FOUND");
    expect(await press("nonmember", PRIVATE_SESSION)).toBe("NOT_FOUND");
    expect(reached).toEqual([USERS.member]);
  });

  test("on a public channel's session, the requester and a member who may write go on", async () => {
    const { press, reached } = continuing();
    expect(await press("requester", PUBLIC_SESSION)).toBe("continued");
    expect(await press("nonmember", PUBLIC_SESSION)).toBe("continued");
    expect(reached).toEqual([USERS.requester, USERS.nonmember]);
  });
});
