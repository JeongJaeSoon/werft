import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type PendingQuestion,
  SLACK_INTERACTION_ACTIONS,
  SLACK_NOTE_VIEW_CALLBACK,
  SLACK_NOTICE_MESSAGES,
  SLACK_QUESTION_VIEW_CALLBACK,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createTaskClose,
  type DecisionEntry,
  type IdentityReader,
  type LinkedSubject,
  SessionServiceError,
  type SurfaceAiLabel,
  type SurfaceProgressLink,
  type SurfacePromptCard,
} from "@werft-ai/platform";
import { slackAiLabelBlock } from "./slack-ai-label.ts";
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
// SESSION's thread link, and a second channel whose ceiling leaves
// session.control out, with a task of its own.
const LINK = "019a0000-0000-7000-8000-0000000000b1";
const LOCKED_CHANNEL = "C0LOCKED";
const LOCKED_THREAD = "1761300000.000300";
const LOCKED_SESSION = "019a0000-0000-7000-8000-0000000000a6";
const LOCKED_LINK = "019a0000-0000-7000-8000-0000000000b2";

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
let continueError: Error | null;
let startFreshError: Error | null;
// What closing a task answers a press of its progress message's buttons.
let taskClose: "closed" | "not_permitted" | "already_closed" | "refused" =
  "closed";
// Set: the press reaches the platform's own close, judged by the policy.
let realTaskClose: boolean;
let progressLinks: Record<string, SurfaceProgressLink>;
let recorded: DecisionEntry[];
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
let channelLeft: boolean;
// null: derived from the request id; undefined: no card row found.
let posted: SurfacePromptCard["display"] | null | undefined;
let postedScope: SurfacePromptCard["conversationScope"];

beforeEach(() => {
  calls = [];
  role = "owner";
  answerError = null;
  continueError = null;
  startFreshError = null;
  viewUpdateError = null;
  channelLeft = false;
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
  postedScope = undefined;
  realTaskClose = false;
  recorded = [];
  progressLinks = {
    [SESSION]: {
      id: LINK,
      agentId: AGENT,
      channelId: CHANNEL,
      threadId: THREAD_TS,
    },
    [LOCKED_SESSION]: {
      id: LOCKED_LINK,
      agentId: AGENT,
      channelId: LOCKED_CHANNEL,
      threadId: LOCKED_THREAD,
    },
  };
});

const OTHER_USER = "019a0000-0000-7000-8000-000000000102";

const toolDisplay = () =>
  displayFor("toolu_1") as Extract<
    SurfacePromptCard["display"],
    { kind: "permission" }
  >;

/**
 * The request as the database holds it once the press landed: what the
 * presser decided, by them; a push as `pushState` says, else approved.
 */
function displayFor(requestId: string): SurfacePromptCard["display"] {
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
// What the store reads for a redrawn notice's AI line; null under `off`.
let aiLabel: SurfaceAiLabel | null = null;
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
  const authorization = createAuthorizationPolicy({
    identity,
    slackGuests: { enabled: async () => false },
    credentials: { unboundRefs: async () => [] },
    sessions: {
      visibleTo: async () => true,
      originOf: async () => ({ creatorUserId: USER, creatorApiKeyId: null }),
    },
    agents: {
      agentOf: async () => AGENT,
      agentOfRelease: async () => null,
      isAdmin: async () => false,
      isInside: async () => true,
    },
    decisions: {
      record: async (entry) => {
        recorded.push(entry);
      },
    },
  });
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
    authorization,
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
              allowedBotUserIds: [],
              werftBotUserIds: [],
            }
          : { status: "dropped", reason: "not_installed" };
      },
    },
    bindings: {
      async findPendingApproval() {
        return null;
      },
      async findLiveSlackChannel() {
        return channelLeft ? ({ status: "left" } as never) : null;
      },
      async resolveSlackChannel(installationId, channelId) {
        const locked = channelId === LOCKED_CHANNEL;
        if (
          installationId !== INSTALLATION ||
          (channelId !== CHANNEL && !locked)
        ) {
          return null;
        }
        return {
          id: locked
            ? "019a0000-0000-7000-8000-0000000000a7"
            : "019a0000-0000-7000-8000-0000000000a4",
          workspaceId: WORKSPACE,
          agentId: AGENT,
          installationId: INSTALLATION,
          channelId: CHANNEL,
          channelKind: "public_channel",
          mode: "on",
          listen: "free",
          m1JudgmentsPerHour: 12,
          reportMode: null,
          ceiling: {
            actions: locked
              ? ["session.read", "session.submit", "session.approve"]
              : [
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
    sessions: {
      continueTurn: (async (...args: unknown[]) => {
        calls.push({ method: "continue", args });
        if (continueError !== null) throw continueError;
        return undefined;
      }) as never,
      startFreshTurn: (async (...args: unknown[]) => {
        calls.push({ method: "start_fresh", args });
        if (startFreshError !== null) throw startFreshError;
        return undefined;
      }) as never,
      queuePushFollowUp: record("append") as never,
    },
    tasks: realTaskClose
      ? createTaskClose({
          authorization,
          closes: {
            close: async (input) => {
              calls.push({ method: "store_close", args: [input] });
              return "closing";
            },
          },
        })
      : {
          close: (async (...args: unknown[]) => {
            calls.push({ method: "task_close", args });
            return taskClose;
          }) as never,
        },
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
      progressLink: async (sessionId) => progressLinks[sessionId] ?? null,
      aiLabelFor: async (input) => {
        calls.push({ method: "aiLabel", args: [input] });
        return aiLabel;
      },
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
          ...(postedScope === undefined
            ? {}
            : { conversationScope: postedScope }),
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

function press(
  actionId: string,
  value: Record<string, string>,
  user = LINKED,
  at = { channel: CHANNEL, thread: THREAD_TS },
) {
  return form({
    type: "block_actions",
    api_app_id: APP,
    team: { id: TEAM },
    user: { id: user },
    channel: { id: at.channel },
    message: { ts: CARD_TS, thread_ts: at.thread, blocks: asked },
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
        continueTurn: record("continue") as never,
        startFreshTurn: record("start_fresh") as never,
        queuePushFollowUp: (async (...args: unknown[]) => {
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

  // 94S-2213: the modal shows the card's questions in the scope the server
  // reads for the card's session, not the channel the press came from.
  describe("the question modal's links", () => {
    const link = (channel: string) =>
      `https://ops.slack.com/archives/${channel}/p1700000000000100`;
    const shown = async () => {
      listed = [
        {
          request_id: "q_1",
          kind: "question",
          questions: [
            {
              ...question,
              prompt: `Which database? @channel ${link(CHANNEL)} ${link("C0HOME0001")}`,
            },
          ],
        },
      ];
      await send(
        press(SLACK_INTERACTION_ACTIONS.questionOpen, { s: SESSION, r: "q_1" }),
      );
      return JSON.stringify(called("viewUpdate")[0]?.args[1]);
    };

    test("keep only the session's own channel", async () => {
      postedScope = { kind: "channel", teamId: TEAM, channelId: "C0HOME0001" };
      const view = await shown();
      expect(view).toContain("Which database?");
      expect(view).toContain(link("C0HOME0001"));
      expect(view).not.toContain(link(CHANNEL));
      expect(view).not.toContain("@channel");
    });

    test("keep none without a conversation", async () => {
      postedScope = null;
      const view = await shown();
      expect(view).toContain("Which database?");
      expect(view).not.toContain(link(CHANNEL));
      expect(view).not.toContain(link("C0HOME0001"));
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

  describe("allow with an instruction", () => {
    const permission = {
      request_id: "toolu_1",
      kind: "permission",
      tool: "Bash",
    };
    const metadata = {
      s: SESSION,
      r: "toolu_1",
      c: CHANNEL,
      m: CARD_TS,
      t: THREAD_TS,
    };
    const submitNote = (value: unknown) =>
      form({
        type: "view_submission",
        api_app_id: APP,
        team: { id: TEAM },
        user: { id: LINKED },
        view: {
          callback_id: SLACK_NOTE_VIEW_CALLBACK,
          private_metadata: JSON.stringify(metadata),
          state: {
            values: { note: { v: { type: "plain_text_input", value } } },
          },
        },
      });

    test("the button opens a loading modal at once, then fills it with one text input; nothing is answered", async () => {
      listed = [permission];
      const result = await send(
        press(SLACK_INTERACTION_ACTIONS.permissionAllowNote, {
          s: SESSION,
          r: "toolu_1",
        }),
      );
      expect(result).toMatchObject({ result: "view_opened" });
      const opened = called("view")[0]?.args[1] as {
        triggerId: string;
        view: { callback_id?: string };
      };
      expect(opened.triggerId).toBe("trigger-1");
      expect(opened.view.callback_id).toBeUndefined();
      const filled = called("viewUpdate")[0]?.args[1] as {
        viewId: string;
        view: {
          callback_id: string;
          private_metadata: string;
          blocks: {
            type: string;
            block_id?: string;
            optional?: boolean;
            element?: { type: string; action_id: string; multiline: boolean };
          }[];
        };
      };
      expect(filled.viewId).toBe("V1");
      expect(filled.view.callback_id).toBe(SLACK_NOTE_VIEW_CALLBACK);
      expect(JSON.parse(filled.view.private_metadata)).toEqual(metadata);
      const inputs = filled.view.blocks.filter((b) => b.type === "input");
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        block_id: "note",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "v",
          multiline: true,
        },
      });
      expect(called("answer")).toEqual([]);
    });

    test("the button on a request no longer open says so in the modal and settles the card", async () => {
      listed = [];
      outcome = {
        state: "answered",
        kind: "permission",
        decision: "allow",
      } as never;
      const result = await send(
        press(SLACK_INTERACTION_ACTIONS.permissionAllowNote, {
          s: SESSION,
          r: "toolu_1",
        }),
      );
      expect(result).toMatchObject({ result: "view_opened" });
      expect(results).toEqual(["already"]);
      const shown = JSON.stringify(called("viewUpdate")[0]?.args[1]);
      expect(shown).toContain("This request was already allowed");
      expect(shown).not.toContain(SLACK_NOTE_VIEW_CALLBACK);
      expect(called("update")).toHaveLength(1);
    });

    test("a submitted instruction answers allow with it as the reason, closes, and settles the card as a plain allow", async () => {
      listed = [permission];
      const result = await send(
        submitNote("  Only touch the fixtures\nthen list them  "),
      );
      expect(result).toEqual({
        kind: "ok",
        body: { response_action: "clear" },
        result: "answered",
      });
      expect(called("answer")[0]?.args[2]).toEqual({
        idempotencyKey: `slack:toolu_1:${LINKED}`,
        body: {
          request_id: "toolu_1",
          kind: "permission",
          decision: "allow",
          reason: "Only touch the fixtures\nthen list them",
        },
      });
      const update = called("update")[0]?.args[1] as {
        ts: string;
        blocks: { elements: { text: string }[] }[];
      };
      expect(update.ts).toBe(CARD_TS);
      expect(update.blocks[0]?.elements[0]?.text).toBe(
        `:white_check_mark: *許可済み* · <@${LINKED}>`,
      );
      // The instruction was the presser's to see, not the thread's.
      expect(JSON.stringify(update)).not.toContain("fixtures");
    });

    test("a blank, missing or oversized instruction keeps the modal open with an error and answers nothing", async () => {
      listed = [permission];
      for (const value of ["   \n ", null, "가".repeat(3000)]) {
        const result = await send(submitNote(value));
        expect(result).toMatchObject({
          body: {
            response_action: "errors",
            errors: { note: expect.any(String) },
          },
        });
      }
      expect(called("answer")).toEqual([]);
    });

    test("the blank and oversized errors say different things, in the presser's language", async () => {
      listed = [permission];
      const errorOf = async (value: string) => {
        const outcome = await send(submitNote(value));
        if (outcome.kind !== "ok" || !("errors" in outcome.body)) {
          throw new Error(`no error: ${JSON.stringify(outcome)}`);
        }
        return outcome.body.errors.note;
      };
      const blank = await errorOf(" ");
      const long = await errorOf("a".repeat(8193));
      expect(blank).toContain("Allow");
      expect(long).toContain("too long");
      expect(blank).not.toBe(long);
    });

    test("a session that cannot carry the instruction is told why in Slack, and the request and card stay open", async () => {
      listed = [permission];
      answerError = new SessionServiceError(
        "BAD_REQUEST",
        "This session's worker cannot hand an approval note to the model; allow without a reason",
        undefined,
        { reason_code: "note_not_accepted" },
      );
      const result = await send(submitNote("Only touch the fixtures"));
      expect(result).toMatchObject({
        body: { response_action: "clear" },
        result: "note_refused",
      });
      expect(called("answer")).toHaveLength(1);
      expect(called("update")).toEqual([]);
      const told = called("ephemeral");
      expect(told).toHaveLength(1);
      const text = (told[0]?.args[1] as { text: string; userId: string }).text;
      expect((told[0]?.args[1] as { userId: string }).userId).toBe(LINKED);
      expect(text).toContain("cannot hand an instruction");
      expect(text).toContain("still open");
    });

    const toldText = () =>
      called("ephemeral").map((c) => (c.args[1] as { text: string }).text);

    test("answers too long for the parked turn's message ask for a shorter instruction, not a plain allow", async () => {
      listed = [permission];
      answerError = new SessionServiceError(
        "BAD_REQUEST",
        "The answers to this parked turn no longer fit in one message; answer with less text",
        undefined,
        { reason_code: "answer_too_long" },
      );
      const result = await send(submitNote("Only touch the fixtures"));
      expect(result).toMatchObject({ result: "note_too_long" });
      expect(called("update")).toEqual([]);
      const [text] = toldText();
      expect(text).toContain("Shorten");
      expect(text).toContain("still open");
      expect(text).not.toContain("cannot hand an instruction");
    });

    test("any other bad request on a noted allow gets the plain failure, not a claim about the session", async () => {
      listed = [permission];
      answerError = new SessionServiceError("BAD_REQUEST", "Something else");
      const result = await send(submitNote("Only touch the fixtures"));
      expect(result).toMatchObject({ result: "failed" });
      expect(called("update")).toEqual([]);
      const [text] = toldText();
      expect(text).toBeDefined();
      expect(text).not.toContain("cannot hand an instruction");
      expect(text).not.toContain("Shorten");
    });

    test("a submit that loses to another answer says the instruction was not handed over", async () => {
      for (const code of [
        "REQUEST_EXPIRED",
        "REQUEST_STALE",
        "IDEMPOTENCY_CONFLICT",
      ] as const) {
        calls = [];
        results = [];
        listed = [permission];
        outcome = {
          state: "answered",
          kind: "permission",
          decision: "allow",
        } as never;
        answerError = new SessionServiceError(code, "taken");
        const result = await send(submitNote("Only touch the fixtures"));
        expect(result).toMatchObject({
          body: { response_action: "clear" },
          result: "already",
        });
        expect(called("update")).toHaveLength(1);
        const told = toldText();
        expect(told).toHaveLength(1);
        expect(told[0]).toContain("Another answer");
        expect(told[0]).toContain("not handed");
      }
    });

    test("the loading modal opens before a slow language lookup, in the default language, and fills in the presser's", async () => {
      listed = [permission];
      let localeRead = false;
      const base = deps();
      const service = createSlackInteractionService({
        ...base,
        outbox: {
          ...base.outbox,
          readerLocale: async () => {
            await new Promise((r) => setTimeout(r, 40));
            localeRead = true;
            return "ja";
          },
        },
      });
      const body = press(SLACK_INTERACTION_ACTIONS.permissionAllowNote, {
        s: SESSION,
        r: "toolu_1",
      });
      const outcome = await service.receive({
        agentId: AGENT,
        rawBody: new TextEncoder().encode(body),
        ...signed(body),
      });
      expect(outcome).toMatchObject({ result: "view_opened" });
      expect(localeRead).toBe(false);
      expect(JSON.stringify(called("view")[0]?.args[1])).toContain(
        "Allow with instruction",
      );
      await drain();
      expect(localeRead).toBe(true);
      expect(JSON.stringify(called("viewUpdate")[0]?.args[1])).toContain(
        "指示を付けて許可",
      );
    });

    test("a submit for a request no longer open answers nothing and tells the presser", async () => {
      listed = [];
      outcome = { state: "expired", kind: "permission" } as never;
      const result = await send(submitNote("Only touch the fixtures"));
      expect(result).toMatchObject({
        body: { response_action: "clear" },
        result: "already",
      });
      expect(called("answer")).toEqual([]);
      expect(called("ephemeral")).toHaveLength(1);
    });
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
      pushRequestId: "push-1",
      decision: "approve",
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
    expect(called("append")[0]?.args[2]).toMatchObject({ decision: "reject" });
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

  test("a press in a channel the bot left tells nobody, even when the press fails", async () => {
    channelLeft = true;
    answerError = new Error("connection reset");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("ephemeral")).toEqual([]);
  });

  test("a follow-up turn that never lands is told to the presser", async () => {
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      sessions: {
        continueTurn: record("continue") as never,
        startFreshTurn: record("start_fresh") as never,
        queuePushFollowUp: (async () => {
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

describe("the continue button on the notice of a turn its worker's lost lease ended", () => {
  const pressContinue = (turn: string, user = LINKED) =>
    press(
      SLACK_INTERACTION_ACTIONS.turnContinue,
      { s: SESSION, r: turn },
      user,
    );

  test("a press goes on from the turn as the presser, judged as a message of theirs, and takes the button away", async () => {
    const outcome = await send(pressContinue("3"));
    expect(outcome).toEqual({
      kind: "ok",
      body: { ok: true },
      result: "continued",
    });
    const [continued] = called("continue");
    expect(continued?.args.slice(1)).toEqual([SESSION, { turnId: 3 }]);
    expect(
      (continued?.args[0] as { actor: { userId: string } }).actor.userId,
    ).toBe(USER);
    // No request is answered: the press is an input, not an approval.
    expect(called("answer")).toEqual([]);
    const [update] = called("update");
    const drawn = update?.args[1] as {
      channelId: string;
      ts: string;
      text: string;
      blocks: unknown[];
    };
    expect({ channelId: drawn.channelId, ts: drawn.ts }).toEqual({
      channelId: CHANNEL,
      ts: CARD_TS,
    });
    const shown = JSON.stringify(drawn.blocks);
    expect(shown).not.toContain(SLACK_INTERACTION_ACTIONS.turnContinue);
    expect(shown).toContain("Continuing from the last save point");
    expect(shown).toContain(`/sessions/${SESSION}`);
  });

  test("the redrawn notice keeps the AI line under rollout `on`, and has none without", async () => {
    await send(pressContinue("3"));
    aiLabel = { requestedBy: "Ada" };
    await send(pressContinue("3"));
    aiLabel = null;
    expect(called("aiLabel")[0]?.args).toEqual([
      { agentId: AGENT, sessionId: SESSION, turnId: 3 },
    ]);
    const [off, on] = called("update").map(
      (call) => call.args[1] as { text: string; blocks: unknown[] },
    );
    expect(JSON.stringify(off)).not.toContain("Werft");
    expect(on?.blocks.at(-1)).toEqual(slackAiLabelBlock("en", "Ada"));
    expect(on?.text).toEndWith("\n\nAI agent · Werft");
  });

  test("pressed again, the same turn is asked for again and the store answers it once", async () => {
    await send(pressContinue("3"));
    await send(pressContinue("3"));
    expect(called("continue").map((call) => call.args.slice(1))).toEqual([
      [SESSION, { turnId: 3 }],
      [SESSION, { turnId: 3 }],
    ]);
  });

  test("a turn a later turn already follows starts nothing, and the button goes", async () => {
    continueError = new SessionServiceError(
      "CONTROL_SUPERSEDED",
      "A later turn of the session already goes on from this one",
    );
    const outcome = await send(pressContinue("3"));
    expect((outcome as { result: string }).result).toBe("superseded");
    const [update] = called("update");
    const shown = JSON.stringify(
      (update?.args[1] as { blocks: unknown[] }).blocks,
    );
    expect(shown).not.toContain(SLACK_INTERACTION_ACTIONS.turnContinue);
    expect(called("ephemeral")).toEqual([]);
  });

  test("a person who may not send to the session goes on from nothing and the notice stays", async () => {
    const outcome = await send(pressContinue("3", "U0STRANGER"));
    expect((outcome as { result: string }).result).toStartWith("refused:");
    expect(called("continue")).toEqual([]);
    expect(called("update")).toEqual([]);
  });

  test("a value that names no turn is ignored", async () => {
    const outcome = await send(pressContinue("toolu_1"));
    expect((outcome as { result: string }).result).toBe("ignored");
    expect(called("continue")).toEqual([]);
  });

  test("a turn the session will not go on from leaves the notice as it is and tells the presser", async () => {
    continueError = new SessionServiceError("NOT_FOUND", "Resource not found");
    const outcome = await send(pressContinue("3"));
    expect((outcome as { result: string }).result).toBe("failed");
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });
});

describe("the start-fresh button on the notice of a turn of unknown outcome with no save point", () => {
  const pressStartFresh = (turn: string, user = LINKED) =>
    press(
      SLACK_INTERACTION_ACTIONS.turnStartFresh,
      { s: SESSION, r: turn },
      user,
    );

  test("a press decides start_fresh on the turn as the presser and takes the button away", async () => {
    const outcome = await send(pressStartFresh("1"));
    expect(outcome).toEqual({
      kind: "ok",
      body: { ok: true },
      result: "started_fresh",
    });
    const [started] = called("start_fresh");
    expect(started?.args.slice(1)).toEqual([SESSION, { turnId: 1 }]);
    expect(
      (started?.args[0] as { actor: { userId: string } }).actor.userId,
    ).toBe(USER);
    expect(called("continue")).toEqual([]);
    const [update] = called("update");
    const drawn = update?.args[1] as {
      channelId: string;
      ts: string;
      blocks: unknown[];
    };
    expect({ channelId: drawn.channelId, ts: drawn.ts }).toEqual({
      channelId: CHANNEL,
      ts: CARD_TS,
    });
    const shown = JSON.stringify(drawn.blocks);
    expect(shown).not.toContain(SLACK_INTERACTION_ACTIONS.turnStartFresh);
    expect(shown).toContain("Running the same request again in a new context");
  });

  test("the redrawn notice keeps the AI line under rollout `on`, and has none without", async () => {
    await send(pressStartFresh("1"));
    aiLabel = { requestedBy: "Ada" };
    await send(pressStartFresh("1"));
    aiLabel = null;
    expect(called("aiLabel")[0]?.args).toEqual([
      { agentId: AGENT, sessionId: SESSION, turnId: 1 },
    ]);
    const [off, on] = called("update").map(
      (call) => call.args[1] as { text: string; blocks: unknown[] },
    );
    expect(JSON.stringify(off)).not.toContain("Werft");
    expect(on?.blocks.at(-1)).toEqual(slackAiLabelBlock("en", "Ada"));
    expect(on?.text).toEndWith("\n\nAI agent · Werft");
  });

  test("pressed again, the same turn is asked for again and the store decides it once", async () => {
    await send(pressStartFresh("1"));
    await send(pressStartFresh("1"));
    expect(called("start_fresh").map((call) => call.args.slice(1))).toEqual([
      [SESSION, { turnId: 1 }],
      [SESSION, { turnId: 1 }],
    ]);
  });

  test("a person who may not send to the session decides nothing and the notice stays", async () => {
    const outcome = await send(pressStartFresh("1", "U0STRANGER"));
    expect((outcome as { result: string }).result).toStartWith("refused:");
    expect(called("start_fresh")).toEqual([]);
    expect(called("update")).toEqual([]);
  });

  test("a value that names no turn is ignored", async () => {
    const outcome = await send(pressStartFresh("toolu_1"));
    expect((outcome as { result: string }).result).toBe("ignored");
    expect(called("start_fresh")).toEqual([]);
  });

  test("a session that moved on another way runs nothing and tells nobody", async () => {
    startFreshError = new SessionServiceError(
      "REQUEST_STALE",
      "Session is active with nothing to recover",
    );
    const outcome = await send(pressStartFresh("1"));
    expect((outcome as { result: string }).result).toBe("stale");
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toEqual([]);
  });

  test("a decision that fails leaves the notice as it is and tells the presser", async () => {
    startFreshError = new SessionServiceError(
      "RECOVERY_REQUIRED",
      "The previous execution has not been confirmed gone",
    );
    const outcome = await send(pressStartFresh("1"));
    expect((outcome as { result: string }).result).toBe("failed");
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });
});

describe("the close buttons on a task's progress message", () => {
  const pressClose = (actionId: string, user = LINKED) =>
    press(actionId, { s: SESSION, r: LINK }, user);

  test.each([
    [SLACK_INTERACTION_ACTIONS.taskComplete, "completed"],
    [SLACK_INTERACTION_ACTIONS.taskCancel, "cancelled"],
  ] as const)(
    "%s closes the task as %s for the presser, who is told nothing",
    async (actionId, reason) => {
      taskClose = "closed";
      const outcome = await send(pressClose(actionId));
      expect((outcome as { result: string }).result).toBe("task_closed");
      const [closed] = called("task_close");
      expect(closed?.args.slice(1)).toEqual([SESSION, reason]);
      expect(
        (closed?.args[0] as { actor: { userId: string } }).actor.userId,
      ).toBe(USER);
      expect(called("ephemeral")).toEqual([]);
    },
  );

  test("someone who may not control the session closes nothing and alone is told so", async () => {
    taskClose = "not_permitted";
    const outcome = await send(
      pressClose(SLACK_INTERACTION_ACTIONS.taskCancel),
    );
    expect((outcome as { result: string }).result).toBe(
      "refused:not_permitted",
    );
    const [told] = called("ephemeral");
    expect(JSON.stringify(told?.args)).toContain(
      SLACK_NOTICE_MESSAGES.en.taskCloseNotPermitted,
    );
    expect(JSON.stringify(told?.args)).toContain(LINKED);
  });

  test("a person who may not send to the agent reaches no close", async () => {
    const outcome = await send(
      pressClose(SLACK_INTERACTION_ACTIONS.taskComplete, STRANGER),
    );
    expect((outcome as { result: string }).result).toStartWith("refused:");
    expect(called("task_close")).toEqual([]);
  });

  test("a task already closed takes the press as nothing new", async () => {
    taskClose = "already_closed";
    const outcome = await send(
      pressClose(SLACK_INTERACTION_ACTIONS.taskComplete),
    );
    expect((outcome as { result: string }).result).toBe("task_already_closed");
    expect(called("ephemeral")).toEqual([]);
  });
});

// 94S-2538: a close button's value names its session and its thread's link;
// a press whose value is not of the message pressed closes nothing, and the
// session is judged at its own channel's ceiling.
describe("a close button's value against the message pressed", () => {
  const onA = { channel: CHANNEL, thread: THREAD_TS };
  const onLocked = { channel: LOCKED_CHANNEL, thread: LOCKED_THREAD };
  const refusedAs = (reason: string) =>
    recorded
      .filter((entry) => entry.decision.reason_code === reason)
      .map((entry) => ({
        action: entry.request.action,
        session: entry.request.resource.id,
        outcome: entry.decision.outcome,
      }));

  beforeEach(() => {
    realTaskClose = true;
  });

  test.each([
    [
      "another channel's session with this message's link",
      LOCKED_SESSION,
      LINK,
    ],
    ["another channel's session and link", LOCKED_SESSION, LOCKED_LINK],
    ["this session with another session's link", SESSION, LOCKED_LINK],
    ["a link that is no id", SESSION, "link-1"],
  ] as const)(
    "%s closes nothing, is kept as a surface_mismatch deny and told to the presser alone",
    async (_, s, r) => {
      const outcome = await send(
        press(SLACK_INTERACTION_ACTIONS.taskComplete, { s, r }, LINKED, onA),
      );
      expect((outcome as { result: string }).result).toBe(
        "refused:surface_mismatch",
      );
      expect(called("store_close")).toEqual([]);
      expect(refusedAs("surface_mismatch")).toEqual([
        { action: "session.submit", session: s, outcome: "deny" },
      ]);
      const told = called("ephemeral");
      expect(told).toHaveLength(1);
      expect(JSON.stringify(told[0]?.args)).toContain(
        SLACK_NOTICE_MESSAGES.en.pressMismatch,
      );
      expect(JSON.stringify(told[0]?.args)).toContain(LINKED);
    },
  );

  test("its own value pressed in another thread of the channel, or for a session with no thread, closes nothing", async () => {
    const elsewhere = { channel: CHANNEL, thread: "1761300000.000900" };
    expect(
      (
        (await send(
          press(
            SLACK_INTERACTION_ACTIONS.taskCancel,
            { s: SESSION, r: LINK },
            LINKED,
            elsewhere,
          ),
        )) as { result: string }
      ).result,
    ).toBe("refused:surface_mismatch");
    delete progressLinks[SESSION];
    expect(
      (
        (await send(
          press(
            SLACK_INTERACTION_ACTIONS.taskCancel,
            { s: SESSION, r: LINK },
            LINKED,
            onA,
          ),
        )) as { result: string }
      ).result,
    ).toBe("refused:surface_mismatch");
    expect(called("store_close")).toEqual([]);
  });

  test("on its own message, a task whose channel may submit but not control is not closed", async () => {
    const outcome = await send(
      press(
        SLACK_INTERACTION_ACTIONS.taskComplete,
        { s: LOCKED_SESSION, r: LOCKED_LINK },
        LINKED,
        onLocked,
      ),
    );
    expect((outcome as { result: string }).result).toBe(
      "refused:not_permitted",
    );
    expect(called("store_close")).toEqual([]);
    // Let in as a message typed there would be, then refused the close.
    expect(
      recorded.map((entry) => [
        entry.request.action,
        entry.decision.reason_code,
      ]),
    ).toEqual([
      ["session.submit", "ok"],
      ["session.control", "surface_ceiling"],
    ]);
    expect(JSON.stringify(called("ephemeral")[0]?.args)).toContain(
      SLACK_NOTICE_MESSAGES.en.taskCloseNotPermitted,
    );
  });

  test("on its own message, a task whose channel may control it closes as before", async () => {
    const outcome = await send(
      press(
        SLACK_INTERACTION_ACTIONS.taskComplete,
        { s: SESSION, r: LINK },
        LINKED,
        onA,
      ),
    );
    expect((outcome as { result: string }).result).toBe("task_closing");
    const [closed] = called("store_close");
    expect(closed?.args[0]).toMatchObject({
      sessionId: SESSION,
      reason: "completed",
    });
    expect(refusedAs("surface_mismatch")).toEqual([]);
    expect(called("ephemeral")).toEqual([]);
  });
});
