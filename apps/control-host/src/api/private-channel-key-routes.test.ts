import { describe, expect, test } from "bun:test";
import {
  type AuthorizationReason,
  SESSION_SCOPE_VALUES,
} from "@werft-ai/contracts";
import { StructuredLogger } from "@werft-ai/observability";
import {
  authenticatedIdentity,
  createAuthorizationPolicy,
  createGitHubWorkService,
  createInterruptService,
  createMemberService,
  createPendingRequestService,
  createPullRequestService,
  createPushRequestService,
  createSessionAchievementService,
  createSessionAttributionService,
  createSessionOutcomeService,
  createSessionOutputService,
  createSessionService,
  createSessionShareService,
  createUsageService,
  type DecisionLog,
  type IdentityReader,
  type SessionAccess,
} from "@werft-ai/platform";
import { createApiApp } from "./app.ts";
import { hashApiKey } from "./keys.ts";
import { API_ROUTE_DECLARATIONS } from "./openapi.ts";
import { registerPullRequestRoutes } from "./routes/action/pull-requests.ts";
import { registerPushRequestRoutes } from "./routes/action/push-requests.ts";
import {
  registerGitHubWorkRoutes,
  registerSessionAttributionRoutes,
  registerSessionOutcomeRoutes,
} from "./routes/github/github-work.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";
import { registerSessionShareRoutes } from "./routes/musterrolle/session-shares.ts";
import { registerSessionAchievementRoutes } from "./routes/sessions/achievements.ts";
import { registerCloseRoutes } from "./routes/sessions/close.ts";
import { registerEventRoutes } from "./routes/sessions/events.ts";
import { registerInterruptRoutes } from "./routes/sessions/interrupt.ts";
import { registerSessionOutputRoutes } from "./routes/sessions/outputs.ts";
import { registerPauseRoutes } from "./routes/sessions/pause.ts";
import { registerPendingRoutes } from "./routes/sessions/pending.ts";
import { registerSessionRoutes } from "./routes/sessions/sessions.ts";
import { registerUsageRoutes } from "./routes/usage/usage.ts";

// Answer 15, first part (94S-2000): a key, a person's or an agent's, reaches
// nothing of a private channel's session: every route under
// /v1/sessions/{id} answers 404, as for a session that is not there, and the
// policy keeps the refusal as private_channel_key. Every service here sits
// on stores that throw when reached, so a route passes only when the policy
// refused it before anything was read or written. A new route under the
// path fails here until it is listed, and passes only through the same
// refusal.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";
// A session of no private channel, which the workspace's keys see.
const OPEN_SESSION = "019a0000-0000-7000-8000-00000000e0a2";
const PUSH = "019a0000-0000-7000-8000-00000000e0d1";
const MEMBER = "019a0000-0000-7000-8000-0000000000c1";
const REQUESTER = "019a0000-0000-7000-8000-0000000000c3";
const COMMIT = "a".repeat(40);

/** A store that throws on any call: reaching it is the failure. */
function unreached(name: string): never {
  const handler: ProxyHandler<() => void> = {
    get: (_target, property) =>
      property === "then"
        ? undefined
        : unreached(`${name}.${String(property)}`),
    apply: () => {
      throw new Error(`${name} reached past the policy`);
    },
  };
  return new Proxy(() => {}, handler) as never;
}

const sessions: SessionAccess = {
  async visibleTo(_ownerId, sessionId, viewer) {
    return (
      sessionId === OPEN_SESSION ||
      (sessionId === SESSION &&
        viewer.apiKeyId === null &&
        (viewer.privateChannels ?? []).length > 0)
    );
  },
  async originOf() {
    return { creatorUserId: REQUESTER, creatorApiKeyId: null };
  },
  async privateChannels(_ownerId, sessionId) {
    return sessionId === SESSION
      ? [
          {
            conversationId: "019a0000-0000-7000-8000-00000000c0a1",
            agentId: AGENT,
            channelId: "C0PRIV",
          },
        ]
      : [];
  },
};

const TOKENS = { personal: "csp_personal", agent: "csp_agent" } as const;
const identity: IdentityReader = {
  async reread(subject) {
    const { principal } = subject;
    if (principal.kind !== "api_key") {
      return authenticatedIdentity.reread(subject);
    }
    return principal.id === `key-${TOKENS.agent}`
      ? { status: "ok", principal, keyAgentId: AGENT }
      : {
          status: "ok",
          principal,
          keyCreator: { userId: MEMBER, role: "owner" },
        };
  },
};

/** Stores named in `reached` answer; every other one throws when reached. */
function app(reached: Record<string, unknown> = {}) {
  const decisions: { sessionId: string | null; reason: AuthorizationReason }[] =
    [];
  const log: DecisionLog = {
    async record({ request, decision }) {
      decisions.push({
        sessionId:
          request.resource.kind === "session" ? request.resource.id : null,
        reason: decision.reason_code,
      });
    },
  };
  const authorization = createAuthorizationPolicy({
    identity,
    agents: {
      agentOf: async () => AGENT,
      isAdmin: async () => false,
      usageOf: async () => ({ allowed: true, basis: "public", teamId: null }),
    },
    sessions,
    channelMembers: {
      isMember: async () => true,
      membership: async () => "member",
      cachedMembership: async () => "member",
    },
    decisions: log,
  });
  const store = (name: string) =>
    name in reached ? (reached[name] as never) : unreached(name);
  const session = createSessionService({
    limits: store("limits"),
    authorization,
    catalog: unreached("catalog"),
    releases: store("releases"),
    inputs: store("inputs"),
    controls: store("controls"),
    reader: store("reader"),
  } as never);
  const pushes = createPushRequestService({
    authorization,
    store: store("pushes"),
    intents: store("intents"),
    source: store("source"),
    catalog: unreached("catalog"),
  } as never);
  const api = createApiApp({
    authMode: "api-key",
    logger: new StructuredLogger({ sinks: [] }),
    keyStore: {
      async find(hash) {
        const kind = (Object.keys(TOKENS) as (keyof typeof TOKENS)[]).find(
          (candidate) =>
            Buffer.from(hash).equals(
              Buffer.from(hashApiKey(TOKENS[candidate])),
            ),
        );
        if (kind === undefined) return null;
        return {
          id: `key-${TOKENS[kind]}`,
          ownerId: WORKSPACE,
          workspaceId: WORKSPACE,
          kind,
          agentId: kind === "agent" ? AGENT : null,
          createdByUserId: kind === "personal" ? MEMBER : null,
          creatorRole: kind === "personal" ? ("owner" as const) : null,
          scopes: [...SESSION_SCOPE_VALUES],
        };
      },
    },
    registerRoutes: (router) => {
      registerSessionRoutes(router, session);
      registerSessionOutputRoutes(
        router,
        createSessionOutputService({
          sessions: session,
          source: store("outputs"),
        }),
      );
      registerSessionShareRoutes(
        router,
        createSessionShareService({
          authorization,
          store: store("shares"),
        } as never),
        session,
      );
      registerPauseRoutes(router, session);
      registerCloseRoutes(router, session);
      registerUsageRoutes(
        router,
        createUsageService({
          authorization,
          reader: store("usage"),
          limits: unreached("limits"),
        } as never),
      );
      registerSessionAchievementRoutes(
        router,
        createSessionAchievementService({
          authorization,
          store: store("achievements"),
          judgeConnections: store("judges"),
        } as never),
      );
      registerPendingRoutes(
        router,
        createPendingRequestService({ authorization, store: store("pending") }),
      );
      registerPushRequestRoutes(router, pushes);
      registerPullRequestRoutes(
        router,
        createPullRequestService({
          authorization,
          pushes,
          store: store("pulls"),
        } as never),
      );
      registerGitHubWorkRoutes(
        router,
        createGitHubWorkService({
          authorization,
          store: store("work"),
        } as never),
      );
      registerSessionAttributionRoutes(
        router,
        createSessionAttributionService({
          authorization,
          store: store("attribution"),
        }),
      );
      registerSessionOutcomeRoutes(
        router,
        createSessionOutcomeService({
          authorization,
          store: store("outcomes"),
        }),
      );
      registerInterruptRoutes(
        router,
        createInterruptService({
          authorization,
          store: store("interrupts"),
        } as never),
      );
      registerMemberRoutes(
        router,
        createMemberService({
          authorization,
          store: store("members"),
          sessions,
        } as never),
        unreached("invites"),
      );
      registerEventRoutes(router, session, {
        wakeup: { wait: () => new Promise<void>(() => {}) },
      });
    },
  });
  return { api, decisions };
}

type Call = { query?: string; body?: unknown };
const REVISION = { expected_revision: 1 };

// Every route under /v1/sessions/{id}, with a request its body and query
// schemas take, so what answers is the service and not the validation.
const ROUTES: Record<string, Call> = {
  getSession: {},
  updateSession: { body: { title: "renamed" } },
  getSessionShare: {},
  setSessionShare: { body: { scope: "private" } },
  auditReadSession: { body: { justification: "incident 42" } },
  getSessionUsage: {},
  listSessionOutputs: {},
  downloadSessionOutput: {},
  appendSessionMessage: { body: { message: "hello" } },
  listSessionTurns: {},
  getSessionTurn: {},
  continueSessionTurn: {},
  streamSessionEvents: {},
  listPendingRequests: {},
  answerPendingRequest: {
    body: { request_id: "req-1", kind: "permission", action: "allow" },
  },
  createPushRequest: { body: {} },
  listPushRequests: {},
  getPushRequest: {},
  approvePushRequest: { body: { git_commit: COMMIT } },
  rejectPushRequest: { body: {} },
  openPullRequest: { body: {} },
  commentPullRequest: { body: { body: "hello" } },
  dispatchWorkflow: { body: { workflow: "ci.yml", ref: "main" } },
  getWorkflowRun: {},
  rerunWorkflow: { body: { failed_only: true } },
  getSessionGitHubAttribution: {},
  listSessionGitHubRefusals: {},
  listSessionOutcomes: {},
  listSessionAchievements: {},
  rejudgeSession: { body: {} },
  submitPullRequestReview: { body: { event: "APPROVE", commit_id: COMMIT } },
  interruptSession: { body: { target_turn_id: "1" } },
  pauseSession: { body: REVISION },
  closeSession: { body: REVISION },
  terminateSession: { body: REVISION },
  resumeSession: { body: REVISION },
  decideSessionRecovery: {
    body: {
      ...REVISION,
      decision: "abandon",
      target_turn_id: "1",
      reason: "no external effect",
    },
  },
  takeOverSession: { body: { justification: "incident 42" } },
};

const PARAMS: Record<string, string> = {
  id: SESSION,
  push_request_id: PUSH,
  turn_id: "1",
  run_id: "1",
  number: "1",
  path: "report.txt",
};

const declared = API_ROUTE_DECLARATIONS.filter(
  (route) =>
    route.path === "/v1/sessions/{id}" ||
    route.path.startsWith("/v1/sessions/{id}/"),
);

describe("a key on a private channel's session, over HTTP", () => {
  test("every route under /v1/sessions/{id} is listed here", () => {
    expect(declared.map((route): string => route.operationId).sort()).toEqual(
      Object.keys(ROUTES).sort(),
    );
  });

  for (const kind of ["personal", "agent"] as const) {
    test(`the ${kind} key gets 404 on every route, refused as private_channel_key`, async () => {
      const outcomes: Record<string, string> = {};
      for (const route of declared) {
        const { api, decisions } = app();
        const call = ROUTES[route.operationId] ?? {};
        const path = route.path.replace(
          /\{([a-z_]+)\}/g,
          (_whole, name: string) => PARAMS[name] ?? name,
        );
        const response = await api.request(
          `${path}${call.query === undefined ? "" : `?${call.query}`}`,
          {
            method: route.method.toUpperCase(),
            headers: {
              Authorization: `Bearer ${TOKENS[kind]}`,
              "Idempotency-Key": crypto.randomUUID(),
              ...(call.body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(call.body === undefined
              ? {}
              : { body: JSON.stringify(call.body) }),
          },
        );
        const refused = decisions.some(
          (row) =>
            row.sessionId === SESSION && row.reason === "private_channel_key",
        );
        outcomes[route.operationId] =
          response.status === 404 && refused
            ? "404 private_channel_key"
            : `${response.status} ${refused ? "refused" : "not refused"} ${(await response.text()).slice(0, 200)}`;
      }
      expect(outcomes).toEqual(
        Object.fromEntries(
          declared.map((route) => [
            route.operationId,
            "404 private_channel_key",
          ]),
        ),
      );
    });
  }
});

// Where this meets a deleted Slack source (94S-2010): the policy's refusal
// comes first, so a key on a private channel's session gets the same 404
// whether or not the session was stopped for a deleted message, and learns
// nothing of it. Only a caller the policy lets through reaches the store,
// whose stop answers 409 SOURCE_DELETED.
describe("a key on a session stopped for a deleted Slack source", () => {
  const stopped = {
    limits: {
      queuedInputLimitPerSession: 10,
      storageLimitBytes: 1e9,
      sessionCostLimitUsd: 100,
      sessionTokenLimit: null,
    },
    inputs: {
      appendInputAtomic: async () => ({
        outcome: "source_deleted",
        sessionStopped: true,
      }),
    },
    controls: { resumeAtomic: async () => ({ outcome: "source_deleted" }) },
    pending: { answerAtomic: async () => ({ outcome: "source_deleted" }) },
  };
  const calls = {
    appendSessionMessage: ["messages", { message: "hello" }],
    resumeSession: ["resume", REVISION],
    answerPendingRequest: [
      "answers",
      { request_id: "req-1", kind: "permission", action: "allow" },
    ],
  } as const;

  async function status(sessionId: string, kind: keyof typeof TOKENS) {
    const out: Record<string, string> = {};
    for (const [operation, [suffix, body]] of Object.entries(calls)) {
      const { api } = app(stopped);
      const response = await api.request(
        `/v1/sessions/${sessionId}/${suffix}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKENS[kind]}`,
            "Idempotency-Key": crypto.randomUUID(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const error = ((await response.json()) as { error?: { code?: string } })
        .error;
      out[operation] = `${response.status} ${error?.code ?? ""}`;
    }
    return out;
  }

  for (const kind of ["personal", "agent"] as const) {
    test(`the ${kind} key: 404 on the private channel's session, 409 SOURCE_DELETED on another`, async () => {
      expect(await status(SESSION, kind)).toEqual({
        appendSessionMessage: "404 NOT_FOUND",
        resumeSession: "404 NOT_FOUND",
        answerPendingRequest: "404 NOT_FOUND",
      });
      expect(await status(OPEN_SESSION, kind)).toEqual({
        appendSessionMessage: "409 SOURCE_DELETED",
        resumeSession: "409 SOURCE_DELETED",
        answerPendingRequest: "409 SOURCE_DELETED",
      });
    });
  }
});
