import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type PendingQuestion,
  SLACK_INTERACTION_ACTIONS,
  SLACK_QUESTION_VIEW_CALLBACK,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { LinkedSubject } from "../ports/linked-account-store.ts";
import type { SlackPromptCard } from "../ports/slack-outbox-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createAuthorizationPolicy, type IdentityReader } from "./policy.ts";
import {
  createSlackInteractionService,
  type SlackInteractionDeps,
  slackPushFollowUp,
} from "./slack-interactions.ts";
import { slackPromptMessage } from "./slack-prompts.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000a2";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000a3";
const SESSION = "019a0000-0000-7000-8000-0000000000a5";
const SLACK_APP = "019a0000-0000-7000-8000-0000000000a9";
const APP = "A0RESEARCH";
const TEAM = "T0OPS";
const CHANNEL = "C0OPS";
const CARD_TS = "1761300000.000200";
const THREAD_TS = "1761300000.000100";
const SECRET = "interaction-signing-fixture";
const LINKED = "U0LINKED";
const STRANGER = "U0STRANGER";
const USER = "019a0000-0000-7000-8000-000000000101";
const NOW = new Date("2026-11-03T00:00:00Z");

const question: PendingQuestion = {
  question_id: "q-1",
  prompt: "Which database?",
  options: [
    { option_id: "pg", label: "Postgres" },
    { option_id: "sqlite", label: "SQLite" },
  ],
  multi_select: false,
  allow_free_text: true,
};

type Call = { method: string; args: unknown[] };

let calls: Call[];
let role: WorkspaceRole;
let answerError: Error | null;
let outcome: Awaited<ReturnType<SlackInteractionDeps["pending"]["outcome"]>>;
let listed: unknown[];
let pushState: "requested" | "approved" | "rejected" | null;
// undefined: a stored request that carries no flow, so flowOf is asked.
let pushFlow: "legacy" | "actions" | undefined;
let decideError: SessionServiceError | null;
let getError: Error | null;
let deferred: Promise<void>[];
let results: string[];
let userDelayMs: number;
let hold: "now" | "held" | "pull_request" | Error;
// The flow the stored push request was made under; an Error: it cannot be read.
let flow: "legacy" | "actions" | Error | null;
let viewUpdateError: Error | null;
// null: derived from the request id; undefined: no card row found.
let posted: SlackPromptCard["display"] | null | undefined;

beforeEach(() => {
  calls = [];
  role = "owner";
  answerError = null;
  viewUpdateError = null;
  outcome = { state: "open", kind: "permission" };
  listed = [];
  pushState = "requested";
  pushFlow = "legacy";
  decideError = null;
  getError = null;
  deferred = [];
  results = [];
  userDelayMs = 0;
  hold = "now";
  flow = "legacy";
  posted = null;
});

const OTHER_USER = "019a0000-0000-7000-8000-000000000102";

const toolDisplay = () =>
  displayFor("toolu_1") as Extract<
    SlackPromptCard["display"],
    { kind: "permission" }
  >;

/**
 * The request as the database holds it once the press landed: what the
 * presser decided, by them; a push as `pushState` says, else approved.
 */
function displayFor(requestId: string): SlackPromptCard["display"] {
  const base = {
    decidedByUserId: USER,
    closedReason: null,
    createdAt: NOW.toISOString(),
    expiresAt: NOW.toISOString(),
  };
  if (requestId.startsWith("push")) {
    return {
      kind: "push",
      repositoryId: "repo-1",
      repositoryName: "JeongJaeSoon/werft-sandbox",
      targetBranch: "agent/x",
      gitCommit: "a".repeat(40),
      state: pushState === "rejected" ? "rejected" : "approved",
      decidedByUserId: pushState === "rejected" ? OTHER_USER : USER,
      createdAt: NOW.toISOString(),
    };
  }
  if (requestId.startsWith("q")) {
    return {
      ...base,
      kind: "question",
      questions: [question],
      answers: [{ question_id: "q-1", selected_option_ids: [], typed: true }],
      state: "answered",
      decision: null,
    };
  }
  return {
    ...base,
    kind: "permission",
    tool: "Bash",
    input: { command: "ls" },
    context: {},
    state: "answered",
    decision: "allow",
  };
}

const record =
  (method: string, result: unknown = undefined) =>
  async (...args: unknown[]) => {
    calls.push({ method, args });
    return result;
  };
const called = (method: string) => calls.filter((c) => c.method === method);

const identity: IdentityReader = {
  async reread(subject) {
    if (subject.actor_user_id !== USER) return { status: "unlinked" };
    return {
      status: "ok",
      principal: {
        kind: "user",
        id: USER,
        workspace_id: WORKSPACE,
        role,
        scopes: [...scopesForRole(role)],
      },
    };
  },
};

function deps(): SlackInteractionDeps {
  return {
    signingSecrets: {
      async forAgent(agentId) {
        return agentId === AGENT
          ? {
              workspaceId: WORKSPACE,
              slackAppId: SLACK_APP,
              appId: APP,
              signingSecret: SECRET,
            }
          : null;
      },
    } as SlackInteractionDeps["signingSecrets"],
    authorization: createAuthorizationPolicy({
      identity,
      slackGuests: { enabled: async () => false },
      outsideAgents: { access: async () => "use" },
      credentials: { unboundRefs: async () => [] },
      sessions: {
        visibleTo: async () => true,
        originOf: async () => ({ creatorUserId: USER, creatorApiKeyId: null }),
      },
      agents: {
        agentOf: async () => AGENT,
        agentOfRelease: async () => null,
        isAdmin: async () => false,
      },
      decisions: { record: async () => {} },
    }),
    agents: {
      async resolveSlackEvent(key) {
        return key.appId === APP && key.teamId === TEAM
          ? {
              status: "resolved",
              workspaceId: WORKSPACE,
              agentId: AGENT,
              identity: { id: "identity-1", revision: 1 },
              installationId: INSTALLATION,
              botUserId: "U0BOT",
              credentialRef: "slack_bot_token",
            }
          : { status: "dropped", reason: "not_installed" };
      },
    },
    bindings: {
      async findPendingApproval() {
        return null;
      },
      async resolveSlackChannel(installationId, channelId) {
        if (installationId !== INSTALLATION || channelId !== CHANNEL) {
          return null;
        }
        return {
          id: "019a0000-0000-7000-8000-0000000000a4",
          workspaceId: WORKSPACE,
          agentId: AGENT,
          installationId: INSTALLATION,
          channelId: CHANNEL,
          channelKind: "public_channel",
          mode: "on",
          ceiling: {
            actions: [
              "session.read",
              "session.submit",
              "session.control",
              "session.approve",
            ],
            disclosure: "full",
          },
          home: false,
          memoryWritePolicy: "deny",
          status: "ready",
          approvedAt: null,
          membership: null,
          muted: false,
          revision: 1,
          createdAt: new Date(0),
          revokedAt: null,
        };
      },
    },
    links: {
      async resolveLinkedSubject(ref): Promise<LinkedSubject> {
        if (ref.externalUserId !== LINKED) return { status: "unlinked" };
        return {
          status: "linked",
          linkedAccount: {
            id: "019a0000-0000-7000-8000-000000000201",
            revision: 1,
          },
          userId: USER,
          workspaceId: WORKSPACE,
          role,
        };
      },
    },
    pending: {
      async answer(...args) {
        calls.push({ method: "answer", args });
        if (answerError !== null) throw answerError;
        return undefined as never;
      },
      async listPendingRequests(...args) {
        calls.push({ method: "list", args });
        return { items: listed } as never;
      },
      async outcome() {
        return outcome;
      },
    },
    pushes: {
      async get(...args) {
        calls.push({ method: "pushGet", args });
        if (getError !== null) throw getError;
        if (pushState === null)
          throw new SessionServiceError("NOT_FOUND", "gone");
        return {
          id: "push-1",
          state: pushState,
          git_commit: "a".repeat(40),
          repository_id: "repo-1",
          target_branch: "agent/x",
          flow: pushFlow,
        } as never;
      },
      async decide(...args) {
        calls.push({ method: "decide", args });
        if (decideError !== null) throw decideError;
        return undefined as never;
      },
    },
    sessions: { appendMessage: record("append") as never },
    followUps: {
      async hold(input) {
        calls.push({ method: "hold", args: [input] });
        if (hold instanceof Error) throw hold;
        return hold;
      },
      async flowOf() {
        if (flow instanceof Error) throw flow;
        return flow;
      },
    },
    slack: {
      userInfo: async (_token, id) => {
        if (userDelayMs > 0)
          await new Promise((r) => setTimeout(r, userDelayMs));
        return { id, team_id: TEAM };
      },
      updateMessage: record("update") as never,
      openView: record("view", { viewId: "V1" }) as never,
      updateView: async (...args: unknown[]) => {
        calls.push({ method: "viewUpdate", args });
        if (viewUpdateError !== null) throw viewUpdateError;
      },
      postEphemeral: record("ephemeral") as never,
    },
    botToken: async () => "xoxb-fixture",
    outbox: {
      promptCard: async (input) => {
        calls.push({ method: "card", args: [input] });
        if (posted === undefined) return null;
        const display = posted ?? displayFor(input.requestId);
        return {
          // The card's language, not the presser's ("en"): it was posted so.
          locale: "ja",
          linkUrl: "https://console.example/sessions/x",
          decidedVia: display.decidedByUserId === null ? null : "slack",
          deciderSlackUserId: display.decidedByUserId === USER ? LINKED : null,
          display,
        };
      },
      readerLocale: async () => "en",
    },
    connectUrl: "https://app.example/settings/linked-accounts",
    logger: {
      warn() {},
      info(message: string, fields?: Record<string, unknown>) {
        if (message === "Slack interaction handled") {
          results.push(String(fields?.result));
        }
      },
    },
    now: () => NOW,
    wait: async () => {},
    defer: (work) => {
      deferred.push(work());
    },
  };
}

function signed(body: string, at = Math.floor(NOW.getTime() / 1000)) {
  return {
    timestamp: String(at),
    signature: `v0=${createHmac("sha256", SECRET)
      .update(`v0:${at}:${body}`)
      .digest("hex")}`,
  };
}

function form(payload: unknown) {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

const asked = slackPromptMessage(
  {
    kind: "permission",
    sessionId: SESSION,
    requestId: "toolu_1",
    tool: "Bash",
    input: { command: "ls" },
    context: {},
    expiresAt: NOW.toISOString(),
  },
  { locale: "en", requesterSlackUserId: null },
).blocks;

function press(actionId: string, value: Record<string, string>, user = LINKED) {
  return form({
    type: "block_actions",
    api_app_id: APP,
    team: { id: TEAM },
    user: { id: user },
    channel: { id: CHANNEL },
    message: { ts: CARD_TS, thread_ts: THREAD_TS, blocks: asked },
    trigger_id: "trigger-1",
    actions: [{ action_id: actionId, value: JSON.stringify(value) }],
  });
}

// Work deferred by deferred work lands in the list while it runs.
async function drain() {
  for (let i = 0; i < deferred.length; i += 1) await deferred[i];
}

// What Slack is answered, with the result of the work run after it.
async function send(body: string, headers = signed(body), agentId = AGENT) {
  const outcome = await createSlackInteractionService(deps()).receive({
    agentId,
    rawBody: new TextEncoder().encode(body),
    ...headers,
  });
  await drain();
  return outcome.kind === "ok" && outcome.result === "accepted"
    ? { ...outcome, result: results.at(-1) ?? "accepted" }
    : outcome;
}

const settledText = () =>
  (called("update")[0]?.args[1] as { text: string } | undefined)?.text;

describe("Slack interactions", () => {
  test("an unsigned, stale or unknown-agent request is refused before anything runs", async () => {
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    expect(await send(body, { timestamp: "1", signature: "v0=00" })).toEqual({
      kind: "unauthorized",
    });
    expect(
      await send(body, signed(body, Math.floor(NOW.getTime() / 1000) - 600)),
    ).toEqual({ kind: "unauthorized" });
    expect(
      await send(body, signed(body), "019a0000-0000-7000-8000-0000000000ff"),
    ).toEqual({ kind: "unauthorized" });
    expect(calls).toEqual([]);
  });

  test("a signed body that is not a form payload is a bad request", async () => {
    const body = "payload=not-json";
    expect(await send(body)).toEqual({ kind: "bad_request" });
  });

  test("allow answers the request once and settles the card with who pressed", async () => {
    const outcome = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(outcome).toEqual({
      kind: "ok",
      body: { ok: true },
      result: "answered",
    });
    const [answer] = called("answer");
    expect(answer?.args[1]).toBe(SESSION);
    expect(answer?.args[2]).toEqual({
      idempotencyKey: `slack:toolu_1:${LINKED}`,
      body: { request_id: "toolu_1", kind: "permission", decision: "allow" },
    });
    // Redrawn from the stored request, not from the pressed message.
    expect(called("card")[0]?.args[0]).toEqual({
      sessionId: SESSION,
      requestId: "toolu_1",
      channelId: CHANNEL,
      slackTs: CARD_TS,
    });
    const update = called("update")[0]?.args[1] as {
      ts: string;
      blocks: { type: string; elements: { text: string }[] }[];
    };
    expect(update.ts).toBe(CARD_TS);
    expect(update.blocks).toHaveLength(1);
    expect(update.blocks[0]?.type).toBe("context");
    // The presser reads English; the card was posted in Japanese.
    expect(update.blocks[0]?.elements.map((e) => e.text)).toEqual([
      // Decided in Slack, so the line names no "Web".
      `:white_check_mark: *許可済み* · <@${LINKED}>`,
      "コマンド実行: ls",
      "<https://console.example/sessions/x|Webで開く>",
    ]);
    expect(settledText()).toContain(`<@${LINKED}>`);
    expect(settledText()).toContain("許可済み");
  });

  test("allow for the session answers allow with remember, through the same approval path", async () => {
    const outcome = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllowSession, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(outcome).toMatchObject({ kind: "ok", result: "answered" });
    const [answer] = called("answer");
    expect(answer?.args[1]).toBe(SESSION);
    expect(answer?.args[2]).toEqual({
      idempotencyKey: `slack:toolu_1:${LINKED}`,
      body: {
        request_id: "toolu_1",
        kind: "permission",
        decision: "allow",
        remember: "session",
      },
    });
  });

  test("a plain deny never carries remember", async () => {
    await send(
      press(SLACK_INTERACTION_ACTIONS.permissionDeny, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(called("answer")[0]?.args[2]).toMatchObject({
      body: { decision: "deny" },
    });
    expect(JSON.stringify(called("answer")[0]?.args[2])).not.toContain(
      "remember",
    );
  });

  test("a card no outbox row posted is left as it is", async () => {
    posted = undefined;
    const outcome = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(outcome).toMatchObject({ result: "answered" });
    expect(called("card")).toHaveLength(1);
    expect(called("update")).toEqual([]);
  });

  test("a request still open after the press keeps its buttons", async () => {
    posted = { ...toolDisplay(), state: "open", decision: null };
    await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(called("update")).toEqual([]);
  });

  test("Slack is answered within three seconds when the token, language, decision and card reads take longer", async () => {
    const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      pending: {
        ...base.pending,
        answer: async (...args) => {
          calls.push({ method: "answer", args });
          await slow(4000);
          return undefined as never;
        },
      },
      botToken: async () => {
        calls.push({ method: "token", args: [] });
        await slow(1000);
        return "xoxb-fixture";
      },
      outbox: {
        ...base.outbox,
        readerLocale: async () => {
          await slow(1000);
          return "en";
        },
        promptCard: async (input) => {
          calls.push({ method: "card", args: [input] });
          await slow(1000);
          return null;
        },
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    const started = performance.now();
    const outcome = await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    const elapsed = performance.now() - started;
    expect(outcome).toMatchObject({ kind: "ok", result: "accepted" });
    // Only the signing secret and the token (1s) are awaited before the
    // answer: the language (1s), the decision (4s) and the card (1s) after.
    expect(elapsed).toBeLessThan(1500);
    expect(called("answer")).toEqual([]);
    expect(called("card")).toEqual([]);
    await drain();
    expect(called("answer")).toHaveLength(1);
    expect(called("card")).toHaveLength(1);
  }, 15_000);

  test("a press whose presser's language cannot be read still decides, in the default language", async () => {
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      outbox: {
        ...base.outbox,
        readerLocale: async () => {
          throw new Error("db down");
        },
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    expect(
      await service.receive({
        agentId: AGENT,
        rawBody: new TextEncoder().encode(body),
        ...signed(body),
      }),
    ).toMatchObject({ kind: "ok", result: "accepted" });
    await drain();
    expect(called("answer")).toHaveLength(1);
    expect(called("update")).toHaveLength(1);
  });

  test("a press whose bot token cannot be read fails before Slack is answered", async () => {
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      botToken: async () => {
        throw new Error("secret store down");
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    await expect(
      service.receive({
        agentId: AGENT,
        rawBody: new TextEncoder().encode(body),
        ...signed(body),
      }),
    ).rejects.toThrow("secret store down");
    await drain();
    expect(called("answer")).toEqual([]);
  });

  test("two presses of the same button decide once; the second sees it settled", async () => {
    const decided = new Map<string, unknown>();
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      pending: {
        ...base.pending,
        // As the store does: one decision per idempotency key, replayed.
        answer: async (...args) => {
          calls.push({ method: "answer", args });
          const key = (args[2] as { idempotencyKey: string }).idempotencyKey;
          if (!decided.has(key)) decided.set(key, args[2]);
          return undefined as never;
        },
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    for (const _ of [1, 2]) {
      expect(
        await service.receive({
          agentId: AGENT,
          rawBody: new TextEncoder().encode(body),
          ...signed(body),
        }),
      ).toMatchObject({ kind: "ok", result: "accepted" });
    }
    await drain();
    expect(called("answer")).toHaveLength(2);
    expect(decided.size).toBe(1);
    expect(called("update")).toHaveLength(2);
    expect(settledText()).toContain("許可済み");
  });

  test("Slack is answered before a press's work runs", async () => {
    const service = createSlackInteractionService(deps());
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    const outcome = await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    expect(outcome).toEqual({
      kind: "ok",
      body: { ok: true },
      result: "accepted",
    });
    expect(called("answer")).toEqual([]);
    await drain();
    expect(called("answer")).toHaveLength(1);
  });

  test("a follow-up turn that fails is tried again before the card is settled", async () => {
    let fails = 2;
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      sessions: {
        appendMessage: (async (...args: unknown[]) => {
          calls.push({ method: "append", args });
          if (fails-- > 0) throw new Error("queue unavailable");
        }) as never,
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.pushApprove, {
      s: SESSION,
      r: "push-1",
    });
    await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    await drain();
    const appends = called("append");
    expect(appends).toHaveLength(3);
    expect(
      new Set(
        appends.map(
          (c) => (c.args[2] as { idempotencyKey: string }).idempotencyKey,
        ),
      ),
    ).toEqual(new Set(["slack-push:push-1"]));
    expect(calls.findIndex((c) => c.method === "update")).toBeGreaterThan(
      calls.lastIndexOf(appends[2] as Call),
    );
  });

  test("a press on a request someone already answered shows its result and answers nothing new", async () => {
    answerError = new SessionServiceError("REQUEST_STALE", "answered");
    outcome = { state: "answered", kind: "permission", decision: "deny" };
    posted = {
      ...toolDisplay(),
      decision: "deny",
      decidedByUserId: OTHER_USER,
    };
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(result).toMatchObject({ result: "already" });
    expect(called("answer")).toHaveLength(1);
    expect(settledText()).not.toContain(`<@${LINKED}>`);
    // Decided elsewhere by someone with no Slack account here: the press
    // does not know the path, so the line names neither.
    expect(settledText()).toContain("拒否済み");
    expect(settledText()).not.toContain("Webで拒否");
    expect(called("ephemeral")).toEqual([]);
  });

  test("an unlinked Slack user answers nothing and is pointed at the link page", async () => {
    const result = await send(
      press(
        SLACK_INTERACTION_ACTIONS.permissionAllow,
        { s: SESSION, r: "toolu_1" },
        STRANGER,
      ),
    );
    expect(result).toMatchObject({ kind: "ok" });
    expect((result as { result: string }).result).toStartWith("refused:");
    expect(called("answer")).toEqual([]);
    expect(called("update")).toEqual([]);
    const [notice] = called("ephemeral");
    const sent = notice?.args[1] as { userId: string; text: string };
    expect(sent.userId).toBe(STRANGER);
    expect(sent.text).toContain("https://app.example/settings/linked-accounts");
  });

  test("a press the web would refuse answers nothing", async () => {
    answerError = new SessionServiceError("FORBIDDEN", "not yours");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionDeny, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(result).toMatchObject({ result: "refused" });
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });

  test("an option button answers a single question with that option", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    await send(
      press(`${SLACK_INTERACTION_ACTIONS.questionOption}:1`, {
        s: SESSION,
        r: "q_1",
        o: "1",
      }),
    );
    expect(called("answer")[0]?.args[2]).toEqual({
      idempotencyKey: `slack:q_1:${LINKED}`,
      body: {
        request_id: "q_1",
        kind: "question",
        answers: [{ question_id: "q-1", selected_option_ids: ["sqlite"] }],
      },
    });
  });

  test("an option index the request never offered answers nothing", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    outcome = { state: "open", kind: "question" };
    const result = await send(
      press(`${SLACK_INTERACTION_ACTIONS.questionOption}:1`, {
        s: SESSION,
        r: "q_1",
        o: "7",
      }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("answer")).toEqual([]);
  });

  test("answer opens a loading modal at once, then fills it with the request and the card", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.questionOpen, { s: SESSION, r: "q_1" }),
    );
    expect(result).toMatchObject({ result: "view_opened" });
    const opened = called("view")[0]?.args[1] as {
      triggerId: string;
      view: { callback_id?: string };
    };
    expect(opened.triggerId).toBe("trigger-1");
    expect(opened.view.callback_id).toBeUndefined();
    expect(JSON.stringify(opened.view)).not.toContain("Which database?");
    const filled = called("viewUpdate")[0]?.args[1] as {
      viewId: string;
      view: { callback_id: string; private_metadata: string };
    };
    expect(filled.viewId).toBe("V1");
    expect(filled.view.callback_id).toBe(SLACK_QUESTION_VIEW_CALLBACK);
    expect(JSON.parse(filled.view.private_metadata)).toEqual({
      s: SESSION,
      r: "q_1",
      c: CHANNEL,
      m: CARD_TS,
      t: THREAD_TS,
    });
  });

  test("a modal that cannot be filled or told so leaves the presser an ephemeral", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    viewUpdateError = new Error("view_not_found");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.questionOpen, { s: SESSION, r: "q_1" }),
    );
    expect(result).toMatchObject({ result: "view_opened" });
    expect(called("viewUpdate")).toHaveLength(2);
    expect(called("answer")).toEqual([]);
    const told = called("ephemeral");
    expect(told).toHaveLength(1);
    expect((told[0]?.args[1] as { userId: string }).userId).toBe(LINKED);
  });

  test("the modal opens before a slow Slack user lookup, and an unlinked presser gets no question", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    userDelayMs = 30;
    const service = createSlackInteractionService(deps());
    const body = press(
      SLACK_INTERACTION_ACTIONS.questionOpen,
      { s: SESSION, r: "q_1" },
      STRANGER,
    );
    const outcome = await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    expect(outcome).toMatchObject({ result: "view_opened" });
    expect(called("view")).toHaveLength(1);
    expect(called("viewUpdate")).toEqual([]);
    await drain();
    const shown = JSON.stringify(called("viewUpdate")[0]?.args[1]);
    expect(shown).not.toContain("Which database?");
    expect(shown).not.toContain(SLACK_QUESTION_VIEW_CALLBACK);
    expect(called("ephemeral")).toHaveLength(1);
  });

  const submit = (values: Record<string, Record<string, unknown>>) =>
    form({
      type: "view_submission",
      api_app_id: APP,
      team: { id: TEAM },
      user: { id: LINKED },
      view: {
        callback_id: SLACK_QUESTION_VIEW_CALLBACK,
        private_metadata: JSON.stringify({
          s: SESSION,
          r: "q_1",
          c: CHANNEL,
          m: CARD_TS,
          t: THREAD_TS,
        }),
        state: { values },
      },
    });

  test("a submitted modal answers the question, closes and settles its card", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    const result = await send(
      submit({ "q0.text": { v: { value: "  MySQL, actually  " } } }),
    );
    expect(result).toEqual({
      kind: "ok",
      body: { response_action: "clear" },
      result: "answered",
    });
    expect(called("answer")[0]?.args[2]).toEqual({
      idempotencyKey: `slack:q_1:${LINKED}`,
      body: {
        request_id: "q_1",
        kind: "question",
        answers: [
          {
            question_id: "q-1",
            selected_option_ids: [],
            free_text: "MySQL, actually",
          },
        ],
      },
    });
    const update = called("update")[0]?.args[1] as {
      ts: string;
      text: string;
      blocks: unknown[];
    };
    expect(update.ts).toBe(CARD_TS);
    expect(called("card")[0]?.args[0]).toMatchObject({
      requestId: "q_1",
      slackTs: CARD_TS,
    });
    // The typed answer was the presser's to see; the thread sees that one was given.
    expect(JSON.stringify(update)).not.toContain("MySQL");
    // The question stays whole, the typed answer only as "直接入力".
    expect(JSON.stringify(update.blocks)).toContain('"text":"Which database?"');
    expect(JSON.stringify(update.blocks)).toContain('"text":"直接入力を選択"');
  });

  test("an empty or forged modal answer keeps the modal open with an error", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    const empty = await send(submit({}));
    expect(empty).toMatchObject({
      body: { response_action: "errors", errors: { q0: expect.any(String) } },
    });
    const forged = await send(
      submit({ q0: { v: { selected_option: { value: "9" } } } }),
    );
    expect(forged).toMatchObject({ body: { response_action: "errors" } });
    expect(called("answer")).toEqual([]);
  });

  test("a form whose checks outrun Slack's window stays open and answers nothing", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    userDelayMs = 40;
    const service = createSlackInteractionService({
      ...deps(),
      submitDeadlineMs: 5,
    });
    const body = submit({ "q0.text": { v: { value: "MySQL" } } });
    const outcome = await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    expect(outcome).toMatchObject({
      body: {
        response_action: "errors",
        errors: { "q0.text": expect.any(String) },
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    await drain();
    expect(called("answer")).toEqual([]);
  });

  test("approving a push decides it with the stored commit and queues a turn telling the session", async () => {
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "approved" });
    const [decide] = called("decide");
    expect(decide?.args.slice(1, 3)).toEqual([SESSION, "push-1"]);
    const input = decide?.args[3] as {
      idempotencyKey: string;
      readBody(): Promise<unknown>;
    };
    expect(input.idempotencyKey).toBe(`slack:push-1:${LINKED}`);
    expect(await input.readBody()).toEqual({
      decision: "approve",
      git_commit: "a".repeat(40),
    });
    const [append] = called("append");
    expect(append?.args[1]).toBe(SESSION);
    expect(append?.args[2]).toMatchObject({
      idempotencyKey: "slack-push:push-1",
      body: { mode: "enqueue" },
    });
    expect(settledText()).toContain(`<@${LINKED}>`);
  });

  test("a push of the actions flow is decided and its card settled, with no follow-up turn", async () => {
    pushFlow = "actions";
    for (const [action, result] of [
      [SLACK_INTERACTION_ACTIONS.pushApprove, "approved"],
      [SLACK_INTERACTION_ACTIONS.pushReject, "rejected"],
    ] as const) {
      calls = [];
      expect(
        await send(press(action, { s: SESSION, r: "push-1" })),
      ).toMatchObject({ result });
      expect(called("decide")).toHaveLength(1);
      expect(called("append")).toEqual([]);
      expect(called("hold")).toEqual([]);
      expect(called("update")).toHaveLength(1);
    }
  });

  test("an approval while a turn runs, or with the branch's pull request recorded, queues no turn now", async () => {
    for (const answer of ["held", "pull_request"] as const) {
      calls = [];
      hold = answer;
      const result = await send(
        press(SLACK_INTERACTION_ACTIONS.pushApprove, {
          s: SESSION,
          r: "push-1",
        }),
      );
      expect(result).toMatchObject({ result: "approved" });
      expect(called("hold")[0]?.args[0]).toMatchObject({
        sessionId: SESSION,
        pushRequestId: "push-1",
        message: expect.stringContaining("approved push request push-1"),
      });
      expect(called("append")).toEqual([]);
      expect(settledText()).toContain(`<@${LINKED}>`);
    }
  });

  test("a request that carries its flow never asks flowOf", async () => {
    flow = new Error("flowOf must not be called");
    await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, {
        s: SESSION,
        r: "push-1",
      }),
    );
    expect(called("decide")).toHaveLength(1);
    expect(called("append")).toHaveLength(1);
  });

  test("an actions request queues and holds no turn, on approval or rejection, and still settles the card", async () => {
    pushFlow = undefined;
    flow = "actions";
    for (const action of [
      SLACK_INTERACTION_ACTIONS.pushApprove,
      SLACK_INTERACTION_ACTIONS.pushReject,
    ]) {
      calls = [];
      const result = await send(press(action, { s: SESSION, r: "push-1" }));
      expect(result).toMatchObject({
        result:
          action === SLACK_INTERACTION_ACTIONS.pushApprove
            ? "approved"
            : "rejected",
      });
      expect(called("decide")).toHaveLength(1);
      expect(called("hold")).toEqual([]);
      expect(called("append")).toEqual([]);
      expect(settledText()).toContain(`<@${LINKED}>`);
    }
  });

  test("a request with no stored flow row is treated as legacy", async () => {
    pushFlow = undefined;
    flow = null;
    await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, {
        s: SESSION,
        r: "push-1",
      }),
    );
    expect(called("append")).toHaveLength(1);
  });

  test("a flow read that errors fails the press: no decision, no follow-up turn", async () => {
    pushFlow = undefined;
    flow = new Error("db down");
    await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, {
        s: SESSION,
        r: "push-1",
      }),
    );
    expect(called("decide")).toEqual([]);
    expect(called("append")).toEqual([]);
    expect(called("hold")).toEqual([]);
  });

  test("a hold that fails queues the turn now, and a rejection is never held", async () => {
    hold = new Error("db down");
    await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, { s: SESSION, r: "push-1" }),
    );
    expect(called("append")).toHaveLength(1);
    calls = [];
    hold = "held";
    await send(
      press(SLACK_INTERACTION_ACTIONS.pushReject, { s: SESSION, r: "push-1" }),
    );
    expect(called("hold")).toEqual([]);
    expect(called("append")).toHaveLength(1);
  });

  test("a push already decided is not decided again and queues no turn", async () => {
    pushState = "rejected";
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "already" });
    expect(called("decide")).toEqual([]);
    expect(called("append")).toEqual([]);
    expect(called("update")).toHaveLength(1);
  });

  test("a failed push lookup leaves the card's buttons, decides nothing and tells the presser", async () => {
    getError = new Error("canceling statement due to statement timeout");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("update")).toEqual([]);
    expect(called("decide")).toEqual([]);
    const [told] = called("ephemeral");
    expect((told?.args[1] as { userId: string }).userId).toBe(LINKED);
  });

  test("an answer that throws after Slack was answered tells the presser", async () => {
    answerError = new Error("connection reset");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });

  test("a follow-up turn that never lands is told to the presser", async () => {
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      sessions: {
        appendMessage: (async () => {
          throw new Error("queue unavailable");
        }) as never,
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.pushApprove, {
      s: SESSION,
      r: "push-1",
    });
    await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    await drain();
    const [told] = called("ephemeral");
    expect((told?.args[1] as { text: string }).text).toContain(
      "Reply in this thread",
    );
    expect(called("update")).toHaveLength(1);
  });

  test("a member the policy refuses a push for decides nothing", async () => {
    decideError = new SessionServiceError("FORBIDDEN", "no");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushReject, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("append")).toEqual([]);
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });

  test("another app's payload and an unknown button are acknowledged and ignored", async () => {
    const other = form({
      type: "block_actions",
      api_app_id: "A0OTHER",
      team: { id: TEAM },
      user: { id: LINKED },
      channel: { id: CHANNEL },
      message: { ts: CARD_TS },
      trigger_id: "t",
      actions: [{ action_id: "permission.allow", value: "{}" }],
    });
    expect(await send(other)).toMatchObject({ result: "app_mismatch" });
    expect(
      await send(press("something.else", { s: SESSION, r: "toolu_1" })),
    ).toMatchObject({ result: "ignored" });
    expect(called("answer")).toEqual([]);
  });
});

describe("slackPushFollowUp", () => {
  const push = { id: "push-1", repositoryId: "app", targetBranch: "agent/s" };

  test("the texts state what happened and name no channel, tool or next step", () => {
    expect(slackPushFollowUp("approve", push)).toBe(
      "A person approved push request push-1 (repository app, branch agent/s). The push runs in the background.",
    );
    expect(slackPushFollowUp("reject", push)).toBe(
      "A person rejected push request push-1 (repository app, branch agent/s). Nothing was pushed.",
    );
    for (const decision of ["approve", "reject"] as const) {
      expect(slackPushFollowUp(decision, push)).not.toMatch(
        /slack|open_pull_request|call it again|do not/i,
      );
    }
  });
});
