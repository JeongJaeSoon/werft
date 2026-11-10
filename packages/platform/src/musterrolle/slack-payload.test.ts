// L1: pins what leaves for Slack, byte for byte, so a file move or a port
// seam under musterrolle/slack-*.ts must pass without touching __fixtures__.
// To regenerate after an intended copy change:
//   UPDATE_SLACK_PAYLOADS=1 bun test packages/platform/src/musterrolle/slack-payload.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type PendingQuestion,
  SLACK_NOTICE_MESSAGES,
  type SlackNoticeMessage,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  SlackOutboxClaim,
  SlackOutboxEntry,
  SlackOutboxStore,
  SlackPromptCard,
} from "../ports/slack-outbox-store.ts";
import type { SlackBotSender, SlackSendResponse } from "./slack-config-api.ts";
import {
  createOutboxSlackNoticeSink,
  drainSlackOutbox,
  enqueueSlackInstructions,
  enqueueSlackPrompts,
  enqueueSlackTurnAnswers,
  slackOutboxPresentation,
  slackOutboxText,
  slackReplyBlocks,
} from "./slack-outbox.ts";
import {
  type SlackPrompt,
  slackDoneCard,
  slackNoticeView,
  slackPromptMessage,
  slackQuestionView,
  slackRejectOnlyCard,
  slackSettledCard,
} from "./slack-prompts.ts";
import {
  type SlackSessionStatusMaterial,
  slackSessionStatus,
} from "./slack-session-status.ts";
import { deploymentWelcome } from "./slack-welcome.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__", "slack-payload");

/** Keys sorted at every depth, so a reordered object literal is no change. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Compares as text, never as a DOM or object identity. */
function expectFixture(name: string, value: unknown): void {
  const text = `${JSON.stringify(canonical(value), null, 2)}\n`;
  // Not `.json`: biome would reflow the text this test compares byte for byte.
  const path = join(FIXTURES, `${name}.payload`);
  if (process.env.UPDATE_SLACK_PAYLOADS === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  if (!existsSync(path)) throw new Error(`missing fixture ${name}.json`);
  expect(text).toBe(readFileSync(path, "utf8"));
}

const SESSION = "019a0000-0000-7000-8000-0000000000a5";
const LINK = "https://console.example/sessions/019a0000";
const EXPIRES = "2026-11-03T00:00:00Z";
const LOCALES: UserLocale[] = ["ko", "ja", "en"];
const COMMIT = "abcdef1234567890".padEnd(40, "0");

const choose: PendingQuestion = {
  question_id: "q-1",
  prompt: "Which branch should I rebase onto?",
  options: [
    { option_id: "o0", label: "main" },
    { option_id: "o1", label: "release/2026-11" },
  ],
  multi_select: false,
  allow_free_text: true,
};
const free: PendingQuestion = {
  question_id: "q-2",
  prompt: "Anything else I should know?",
  options: [],
  multi_select: false,
  allow_free_text: true,
};

const permission = (
  input: unknown,
  extra: Partial<Extract<SlackPrompt, { kind: "permission" }>> = {},
): SlackPrompt => ({
  kind: "permission",
  sessionId: SESSION,
  requestId: "toolu_1",
  tool: "Bash",
  input,
  context: {},
  expiresAt: EXPIRES,
  ...extra,
});

const push: SlackPrompt = {
  kind: "push",
  sessionId: SESSION,
  requestId: "push-1",
  repositoryId: "repo-1",
  repositoryName: "acme/web",
  targetBranch: "agent/fix-login",
  gitCommit: COMMIT,
};

describe("Slack payload fixtures: cards", () => {
  test("open request cards in every language", () => {
    const options = (locale: UserLocale) => ({
      locale,
      requesterSlackUserId: "U0ASKER",
      linkUrl: LINK,
    });
    expectFixture("prompt-card", {
      "permission-bash-remember": Object.fromEntries(
        LOCALES.map((locale) => [
          locale,
          slackPromptMessage(
            permission(
              { command: "git status", description: "Check the tree" },
              { rememberOffer: [{ toolName: "Bash", ruleContent: "git:*" }] },
            ),
            options(locale),
          ),
        ]),
      ),
      "permission-write-excerpt": slackPromptMessage(
        permission(
          { file_path: "src/a.ts", content: "line 1\nline 2\nline 3\n" },
          { tool: "Write" },
        ),
        options("en"),
      ),
      "permission-bare": slackPromptMessage(permission({ command: "ls" }), {
        locale: "ko",
        requesterSlackUserId: null,
      }),
      "question-two-choices-and-free": Object.fromEntries(
        LOCALES.map((locale) => [
          locale,
          slackPromptMessage(
            {
              kind: "question",
              sessionId: SESSION,
              requestId: "q_1",
              questions: [choose, free],
              expiresAt: EXPIRES,
            },
            options(locale),
          ),
        ]),
      ),
      push: Object.fromEntries(
        LOCALES.map((locale) => [
          locale,
          slackPromptMessage(push, options(locale)),
        ]),
      ),
      "push-unnamed-repository": slackPromptMessage(
        { ...push, repositoryName: null },
        { locale: "en", requesterSlackUserId: null },
      ),
    });
  });

  const base = {
    linkUrl: LINK,
    deciderSlackUserId: "U0DECIDER",
    decidedVia: "slack" as const,
  };
  const permissionCard = (
    over: Record<string, unknown>,
    locale: UserLocale = "en",
  ): SlackPromptCard =>
    ({
      ...base,
      locale,
      display: {
        kind: "permission",
        tool: "Bash",
        input: { command: "git status" },
        context: {},
        state: "answered",
        decision: "allow",
        remember: null,
        decidedByUserId: "user-1",
        closedReason: null,
        createdAt: "2026-11-02T00:00:00Z",
        expiresAt: EXPIRES,
        ...over,
      },
    }) as SlackPromptCard;
  const questionCard = (
    over: Record<string, unknown>,
    questions: PendingQuestion[],
    answers: { question_id: string; selected_option_ids: string[] }[],
    via: "slack" | "web" = "slack",
  ): SlackPromptCard =>
    ({
      ...base,
      decidedVia: via,
      locale: "en",
      display: {
        kind: "question",
        questions,
        answers: answers.map((a) => ({ ...a, typed: false })),
        state: "answered",
        decision: null,
        decidedByUserId: "user-1",
        closedReason: null,
        createdAt: "2026-11-02T00:00:00Z",
        expiresAt: EXPIRES,
        ...over,
      },
    }) as SlackPromptCard;
  const pushCard = (
    state: string,
    locale: UserLocale = "en",
    extra: Record<string, unknown> = {},
  ): SlackPromptCard =>
    ({
      ...base,
      locale,
      ...extra,
      display: {
        kind: "push",
        repositoryId: "repo-1",
        repositoryName: "acme/web",
        targetBranch: "agent/fix-login",
        gitCommit: COMMIT,
        state,
        decidedByUserId: "user-1",
        createdAt: "2026-11-02T00:00:00Z",
      },
    }) as SlackPromptCard;

  test("settled cards: each way a request ends", () => {
    expectFixture("settled-card", {
      "permission-allowed": slackSettledCard(permissionCard({})),
      "permission-allowed-session-on-web": slackSettledCard({
        ...permissionCard({ remember: "session" }, "ko"),
        decidedVia: "web",
      }),
      "permission-denied": slackSettledCard(
        permissionCard({ decision: "deny" }, "ja"),
      ),
      "permission-expired": slackSettledCard({
        ...permissionCard({ state: "closed", closedReason: "expired" }),
        deciderSlackUserId: null,
      }),
      "question-answered": slackSettledCard(
        questionCard(
          {},
          [choose],
          [{ question_id: "q-1", selected_option_ids: ["o1"] }],
        ),
      ),
      "question-answered-on-web-two": slackSettledCard(
        questionCard(
          {},
          [choose, free],
          [
            { question_id: "q-1", selected_option_ids: ["o0"] },
            { question_id: "q-2", selected_option_ids: [] },
          ],
          "web",
        ),
      ),
      "push-approved": slackSettledCard(pushCard("approved", "ko")),
      "push-rejected": slackSettledCard(pushCard("rejected")),
      "open-is-null": slackSettledCard(pushCard("requested")),
    });
  });

  test("reject-only push card and the done notice", () => {
    const ids = { sessionId: SESSION, requestId: "push-1" };
    expectFixture("reject-only-and-done", {
      "reject-only-stale": slackRejectOnlyCard(
        pushCard("requested") as never,
        ids,
      ),
      "reject-only-pinned-source-invalid": slackRejectOnlyCard(
        pushCard("requested", "ko", {
          pushRevisions: { session: 3, request: 2, origin: "intent" },
        }) as never,
        ids,
      ),
      done: Object.fromEntries(
        LOCALES.map((locale) => [locale, slackDoneCard(locale, LINK)]),
      ),
      "done-no-link": slackDoneCard("en", null),
    });
  });

  test("question modal and notice modal", () => {
    const metadata = {
      session_id: SESSION,
      request_id: "q_1",
      channel_id: "C0OPS",
      message_ts: "100.000100",
    } as never;
    expectFixture("question-view", {
      "choices-and-free": slackQuestionView([choose, free], metadata, "en"),
      "multi-select": slackQuestionView(
        [{ ...choose, multi_select: true, allow_free_text: false }],
        metadata,
        "ko",
      ),
      notice: Object.fromEntries(
        LOCALES.map((locale) => [
          locale,
          slackNoticeView(SLACK_NOTICE_MESSAGES[locale].failed, locale),
        ]),
      ),
    });
  });
});

describe("Slack payload fixtures: replies, instructions, notices", () => {
  const TABLE_REPLY = [
    "저장소는 2개입니다. <!here> *굵게*",
    "",
    "| 저장소 | 상태 |",
    "| --- | --- |",
    "| acme/web | 기본 저장소 |",
    "| acme/api | 붙일 수 있음 |",
    "",
    "끝: [문서](https://docs.example/a)",
  ].join("\n");

  test("reply text and blocks", () => {
    const body = {
      text: TABLE_REPLY,
      link_url: LINK,
      locale: "ko" as const,
      mention_user_ids: ["U0ASKER"],
    };
    const plain = {
      text: "# Done\n\n- one\n- two\n\n`code` and **bold** <@U0ELSE>",
      link_url: LINK,
      locale: "en" as const,
    };
    expectFixture("reply", {
      "table-blocks": slackReplyBlocks(body),
      "table-text": slackOutboxText(body),
      "plain-text": slackOutboxText(plain),
      "plain-has-no-blocks": slackReplyBlocks(plain),
      "plain-no-link": slackOutboxText({ text: "hello", locale: "ja" }),
    });
  });

  const target = {
    sessionLinkId: "link-1",
    sessionId: SESSION,
    workspaceId: "workspace-1",
    agentId: "agent-1",
    slackAppId: "app-1",
    installationId: "installation-1",
    channelId: "C0OPS",
    threadTs: "100.000100",
  };

  test("rows the enqueue paths write", async () => {
    const rows: SlackOutboxEntry[] = [];
    const enqueue = async (entry: SlackOutboxEntry) => {
      rows.push(entry);
      return "enqueued" as const;
    };
    await enqueueSlackTurnAnswers({
      outbox: {
        unansweredTurns: async () => [
          {
            ...target,
            locale: "ko",
            turnId: 1,
            state: "completed",
            requesterSlackUserId: "U0ASKER",
            events: [
              { type: "assistant", payload: { text: "먼저 확인할게요" } },
              {
                type: "tool_use",
                payload: { tool_call: { id: "t1", name: "Bash", input: {} } },
              },
              { type: "assistant", payload: { text: TABLE_REPLY } },
            ],
          },
          {
            ...target,
            locale: "en",
            turnId: 2,
            state: "completed",
            requesterSlackUserId: null,
            events: [],
          },
          {
            ...target,
            locale: "ja",
            turnId: 3,
            state: "failed",
            requesterSlackUserId: "U0ASKER",
            events: [],
          },
        ],
        enqueue,
      },
      consoleOrigin: "https://console.example",
      limit: 10,
    });
    await enqueueSlackInstructions({
      outbox: {
        unpostedInstructions: async () => [
          {
            ...target,
            locale: "en",
            turnId: 4,
            channel: "web",
            message: "Add a test <!here>",
            senderName: "Owner",
            senderSlackUserId: "U0OWNER",
          },
          {
            ...target,
            locale: "ko",
            turnId: 5,
            channel: "api",
            message: "테스트를 더해 줘",
            senderName: null,
            senderSlackUserId: null,
          },
        ],
        enqueue,
      },
      limit: 10,
    });
    await enqueueSlackPrompts({
      outbox: {
        unpromptedRequests: async () => [
          {
            ...target,
            locale: "en",
            requesterSlackUserId: "U0ASKER",
            prompt: {
              kind: "permission",
              requestId: "toolu_1",
              tool: "Bash",
              input: { command: "git status" },
              context: {},
              expiresAt: EXPIRES,
            },
          },
          {
            ...target,
            locale: "ko",
            requesterSlackUserId: null,
            prompt: {
              kind: "push",
              requestId: "push-1",
              repositoryId: "repo-1",
              repositoryName: "acme/web",
              targetBranch: "agent/fix-login",
              gitCommit: COMMIT,
            },
          },
        ],
        enqueue,
      },
      consoleOrigin: "https://console.example",
      limit: 10,
    });
    expectFixture("outbox-rows", rows);
  });

  test("refusal notices in every language, and the welcome row", async () => {
    const rows: SlackOutboxEntry[] = [];
    const locales = new Map<string, UserLocale | null>([
      ["U0KO", "ko"],
      ["U0JA", "ja"],
      ["U0EN", "en"],
      ["U0NONE", null],
    ]);
    const sink = createOutboxSlackNoticeSink({
      enqueue: async (entry) => {
        rows.push(entry);
        return "enqueued";
      },
      readerLocale: async ({ slackUserId }) => locales.get(slackUserId) ?? null,
    });
    for (const [slackUserId, message] of [
      ["U0KO", "connect"],
      ["U0JA", "noApproveRight"],
      ["U0EN", "membersOnly"],
      ["U0NONE", "failed"],
    ] as [string, SlackNoticeMessage][]) {
      await sink.record({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        installationId: "installation-1",
        slackAppId: "app-1",
        teamId: "T0TEAM",
        channelId: "C0OPS",
        threadTs: "100.000100",
        slackUserId,
        reason: "test",
        notice: {
          message,
          ...(message === "connect"
            ? { link_url: "https://console.example/settings/slack" }
            : {}),
        },
        onceKey: `install:C0OPS:${slackUserId}`,
      });
    }
    expectFixture("notice-and-welcome-rows", {
      notices: rows,
      "every-notice-copy": SLACK_NOTICE_MESSAGES,
      welcome: deploymentWelcome({
        workspaceId: "workspace-1",
        agentId: "AGENT-1",
        agentName: "Werft <!channel>",
        slackAppId: "app-1",
        installationId: "installation-1",
        homeBindingId: "BINDING-1",
        channelId: "C0OPS",
      }),
    });
  });
});

describe("Slack payload fixtures: what the drain sends", () => {
  const response = (over: Partial<SlackSendResponse> = {}) =>
    ({
      httpStatus: 200,
      retryAfterHeader: null,
      body: { ok: true, ts: "200.000200" },
      ...over,
    }) as SlackSendResponse;
  const claim = (over: Partial<SlackOutboxClaim>): SlackOutboxClaim => ({
    id: "outbox-1",
    claimToken: "claim-token-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    slackAppId: "app-1",
    installationId: "installation-1",
    kind: "reply",
    channelId: "C0OPS",
    threadTs: "100.000100",
    slackUserId: null,
    sessionId: SESSION,
    body: { text: "hi" },
    dedupeKey: "reply:link-1:1",
    attempts: 1,
    ...over,
  });

  /** Runs one row through the real drain and returns every Slack call. */
  async function sent(row: SlackOutboxClaim, answers: SlackSendResponse[]) {
    const calls: unknown[] = [];
    const batches = [[row], []];
    const outbox = {
      enqueue: async (entry: unknown) => {
        calls.push(["enqueue", entry]);
        return "enqueued";
      },
      readerLocale: async () => null,
      advanceAnswered: async () => 0,
      unpostedInstructions: async () => [],
      unansweredTurns: async () => [],
      promptCard: async () => null,
      unpromptedRequests: async () => [],
      expireSending: async () => [],
      closeUnaddressed: async () => [],
      untoldUncertain: async () => [],
      claim: async () => batches.shift() ?? [],
      beginSend: async () => true,
      settle: async (_fence: unknown, outcome: unknown) => {
        calls.push(["settle", outcome]);
        return true;
      },
    } as unknown as SlackOutboxStore;
    const slack = {
      setStatus: async () => {},
      userImage: async () => "https://images.example/owner.png",
      postMessage: async (
        _token: string,
        input: Parameters<SlackBotSender["postMessage"]>[1],
      ) => {
        calls.push(["postMessage", input]);
        return answers.shift() ?? response();
      },
      postEphemeral: async (
        _token: string,
        input: Parameters<SlackBotSender["postEphemeral"]>[1],
      ) => {
        calls.push(["postEphemeral", input]);
        return answers.shift() ?? response();
      },
    };
    await drainSlackOutbox({
      outbox,
      slack: slack as never,
      botToken: async () => "test-credential",
      logger: { info: () => {}, warn: () => {} },
      consoleOrigin: "https://console.example",
      batchSize: 10,
      leaseMs: 30_000,
      deadline: 1_000,
      now: () => 0,
    });
    return calls;
  }

  test("postMessage and postEphemeral arguments per row kind", async () => {
    const tableBody = {
      text: ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
      link_url: LINK,
      locale: "en" as const,
    };
    expectFixture("drain-calls", {
      "reply-text": await sent(
        claim({ body: { text: "**done** <@U0ELSE>", link_url: LINK } }),
        [],
      ),
      "reply-table": await sent(claim({ body: tableBody }), []),
      "reply-table-blocks-refused": await sent(claim({ body: tableBody }), [
        response({ body: { ok: false, error: "invalid_blocks" } }),
      ]),
      "instruction-sender": await sent(
        claim({
          kind: "instruction",
          body: {
            text: "Add a test",
            sender: { username: "Owner (Web console)", slack_user_id: "U0O" },
          },
        }),
        [],
      ),
      "instruction-sender-refused": await sent(
        claim({
          kind: "instruction",
          body: {
            text: "Add a test",
            sender: { username: "Owner (Web console)", slack_user_id: "U0O" },
          },
        }),
        [response({ body: { ok: false, error: "missing_scope" } }), response()],
      ),
      "input-notice-blocks": await sent(
        claim({
          kind: "input_notice",
          body: {
            ...slackPromptMessage(permission({ command: "ls" }), {
              locale: "en",
              requesterSlackUserId: "U0ASKER",
              linkUrl: LINK,
            }),
          },
        }),
        [],
      ),
      "notice-ephemeral": await sent(
        claim({
          kind: "notice",
          slackUserId: "U0READER",
          sessionId: null,
          body: { text: SLACK_NOTICE_MESSAGES.en.connect, locale: "en" },
        }),
        [],
      ),
      "welcome-text": await sent(
        claim({
          kind: "welcome",
          sessionId: null,
          threadTs: "",
          body: deploymentWelcome({
            workspaceId: "workspace-1",
            agentId: "agent-1",
            agentName: "Werft",
            slackAppId: "app-1",
            installationId: "installation-1",
            homeBindingId: "binding-1",
            channelId: "C0OPS",
          }).body,
        }),
        [],
      ),
      "uncertain-reply-then-notice": await sent(claim({}), [
        response({ httpStatus: 502, body: null }),
      ]),
      presentation: [
        slackOutboxPresentation(claim({ body: tableBody })),
        slackOutboxPresentation(claim({ body: { text: "plain" } })),
      ],
    });
  });
});

describe("Slack payload fixtures: thread status", () => {
  test("the status each session state shows under its thread", () => {
    const material = (
      over: Partial<SlackSessionStatusMaterial>,
    ): SlackSessionStatusMaterial => ({
      lifecycle: "open",
      approvablePush: false,
      answerableRequest: false,
      runningTurn: false,
      queuedTurn: false,
      actionStages: [],
      ...over,
    });
    expectFixture("thread-status", {
      idle: slackSessionStatus(material({})),
      running: slackSessionStatus(material({ runningTurn: true })),
      queued: slackSessionStatus(material({ queuedTurn: true })),
      "waiting-on-request": slackSessionStatus(
        material({ answerableRequest: true }),
      ),
      "waiting-on-push": slackSessionStatus(
        material({ approvablePush: true, lifecycle: "recovery" }),
      ),
      recovery: slackSessionStatus(
        material({ lifecycle: "recovery", answerableRequest: true }),
      ),
      paused: slackSessionStatus(
        material({ lifecycle: "paused", runningTurn: true }),
      ),
      closed: slackSessionStatus(
        material({ lifecycle: "closed", approvablePush: true }),
      ),
    });
  });
});
