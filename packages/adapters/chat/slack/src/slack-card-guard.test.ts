import { describe, expect, test } from "bun:test";
import type {
  PendingRequestDisplay,
  SurfaceCardClaim,
  SurfaceCardSettleStore,
  SurfaceConversationScope,
  SurfaceOutboxEntry,
  SurfacePromptCard,
} from "@werft-ai/platform";
import { settleSlackCards } from "./slack-card-settle.ts";
import { enqueueSlackPrompts } from "./slack-outbox-enqueue.ts";
import { slackOutboxGuard } from "./slack-outbox-render.ts";
import {
  type SlackPrompt,
  slackPromptMessage,
  slackQuestionView,
  slackRejectOnlyCard,
  slackSettledCard,
} from "./slack-prompts.ts";

// 94S-2213: a card's model text loses group mentions (G7) and Slack
// references outside its conversation (A3), first drawn and redrawn.
const TEAM = "T0TEAM0001";
const HERE = "C0HERE0001";
const ELSE = "C0ELSE0001";
const SCOPE = {
  kind: "channel",
  teamId: TEAM,
  channelId: HERE,
} as SurfaceConversationScope;
const OUT = `https://acme.slack.com/archives/${ELSE}/p1700000000000100`;
const IN = `https://acme.slack.com/archives/${HERE}/p1700000000000200`;
const HOSTILE = `ping @channel <!here> see ${OUT} and ${IN}`;

// An open card's text as stored before this change: escaped, with the
// requester's mention and the console link the platform made.
const LEGACY_TEXT = `<@U0ASKER> Tool permission\nping @channel &lt;!here&gt; see ${OUT} and ${IN}\n<https://console.example/sessions/s-1|Open on the web>`;

const guard = slackOutboxGuard({
  kind: "input_notice",
  channelId: HERE,
  conversationScope: SCOPE,
}).guard;

/** Everything the card says, blocks and fallback text. */
const said = (card: { text: string; blocks: unknown[] } | null) =>
  `${JSON.stringify(card?.blocks)}\n${card?.text}`;

const expectGuarded = (text: string) => {
  expect(text).not.toContain("@channel");
  expect(text).not.toContain("<!here>");
  expect(text).not.toContain("&lt;!here&gt;");
  expect(text).not.toContain(ELSE);
  expect(text).toContain(IN);
};

const question = (prompt: string, labels: string[]) => ({
  question_id: "q-1",
  prompt,
  options: labels.map((label, i) => ({ option_id: `o${i}`, label })),
  multi_select: false,
  allow_free_text: false,
});

const permission: SlackPrompt = {
  kind: "permission",
  sessionId: "s-1",
  requestId: "toolu_1",
  tool: "Bash",
  input: { command: `echo "${HOSTILE}"` },
  context: {},
  expiresAt: "2026-11-03T00:00:00Z",
};

const options = { locale: "en", requesterSlackUserId: "U0ASKER" } as const;

describe("a card first drawn", () => {
  test("a tool permission card keeps neither mention nor outside link", () => {
    const unguarded = said(slackPromptMessage(permission, options));
    expect(unguarded).toContain("@channel");
    expect(unguarded).toContain(ELSE);
    const card = slackPromptMessage(permission, { ...options, guard });
    expectGuarded(said(card));
    // The requester's own mention is the platform's and stays.
    expect(card.text).toContain("<@U0ASKER>");
  });

  test("a question card's prompt and option buttons", () => {
    const card = slackPromptMessage(
      {
        kind: "question",
        sessionId: "s-1",
        requestId: "q",
        questions: [question(HOSTILE, [`yes ${OUT}`, `no ${IN}`])],
        expiresAt: "2026-11-03T00:00:00Z",
      },
      { ...options, guard },
    );
    expectGuarded(said(card));
  });

  test("a listed question card, its options in the section text", () => {
    const card = slackPromptMessage(
      {
        kind: "question",
        sessionId: "s-1",
        requestId: "q",
        questions: [
          { ...question(HOSTILE, [`a ${OUT}`, `b ${IN}`]), multi_select: true },
        ],
        expiresAt: "2026-11-03T00:00:00Z",
      },
      { ...options, guard },
    );
    expectGuarded(said(card));
  });

  test("a text the guard empties keeps a mark, which Slack accepts", () => {
    const card = slackPromptMessage(
      {
        kind: "question",
        sessionId: "s-1",
        requestId: "q",
        questions: [question(`Which? ${IN}`, ["@here", "plain"])],
        expiresAt: "2026-11-03T00:00:00Z",
      },
      { ...options, guard },
    );
    const actions = card.blocks.find(
      (block) => (block as { type: string }).type === "actions",
    ) as { elements: { text: { text: string } }[] };
    expect(actions.elements.map((button) => button.text.text)).toEqual([
      "…",
      "plain",
    ]);
  });

  test("a push card's branch", () => {
    const card = slackPromptMessage(
      {
        kind: "push",
        sessionId: "s-1",
        requestId: "push-1",
        repositoryId: "repo-1",
        repositoryName: "acme/web",
        targetBranch: `fix/@channel-${ELSE}`,
        gitCommit: "a".repeat(40),
      },
      { ...options, guard },
    );
    const text = said(card);
    expect(text).not.toContain("@channel");
    expect(text).not.toContain(ELSE);
  });

  test("the question modal", () => {
    const view = slackQuestionView(
      [question(HOSTILE, [`yes ${OUT}`, `no ${IN}`])],
      { s: "s-1", r: "q", c: HERE, m: "1.1", t: "1.0" },
      "en",
      guard,
    );
    expectGuarded(JSON.stringify(view));
  });

  test("with no conversation, every Slack channel reference goes", () => {
    const closed = slackOutboxGuard({
      kind: "input_notice",
      channelId: HERE,
      conversationScope: null,
    }).guard;
    const text = said(
      slackPromptMessage(permission, { ...options, guard: closed }),
    );
    expect(text).not.toContain(ELSE);
    expect(text).not.toContain(HERE);
  });
});

const display = (prompt: string, label: string): PendingRequestDisplay =>
  ({
    kind: "question",
    questions: [question(prompt, [label, "other"])],
    answers: [
      { question_id: "q-1", selected_option_ids: ["o0"], typed: false },
    ],
    state: "answered",
    decision: null,
    decidedByUserId: "019a0000-0000-7000-8000-00000000d0e1",
    closedReason: null,
    createdAt: "2026-11-03T00:00:00Z",
    expiresAt: "2026-11-03T01:00:00Z",
  }) as PendingRequestDisplay;

const promptCard = (
  shown: SurfacePromptCard["display"],
): SurfacePromptCard => ({
  locale: "en",
  linkUrl: "https://console.example/sessions/s-1",
  decidedVia: "slack",
  deciderSlackUserId: "U0DECIDER",
  display: shown,
});

describe("a card redrawn", () => {
  test("a settled question card", () => {
    const card = slackSettledCard(
      promptCard(display(HOSTILE, `yes ${OUT} @here`)),
      guard,
    );
    expectGuarded(said(card));
  });

  test("a reject-only push card", () => {
    const card = slackRejectOnlyCard(
      {
        ...promptCard({
          kind: "push",
          repositoryId: "repo-1",
          repositoryName: `acme/web @channel ${ELSE}`,
          targetBranch: "agent/x",
          gitCommit: "a".repeat(40),
          state: "requested",
          decidedByUserId: null,
          createdAt: "2026-11-03T00:00:00Z",
        }),
        display: {
          kind: "push",
          repositoryId: "repo-1",
          repositoryName: `acme/web @channel ${ELSE}`,
          targetBranch: "agent/x",
          gitCommit: "a".repeat(40),
          state: "requested",
          decidedByUserId: null,
          createdAt: "2026-11-03T00:00:00Z",
        },
      } as Parameters<typeof slackRejectOnlyCard>[0],
      { sessionId: "s-1", requestId: "push-1" },
      guard,
    );
    const text = said(card);
    expect(text).not.toContain("@channel");
    expect(text).not.toContain(ELSE);
  });

  test("the settle pass guards in the claim's conversation scope", async () => {
    const claim = (id: string): SurfaceCardClaim => ({
      id,
      claimToken: `token-${id}`,
      workspaceId: "w",
      slackAppId: "A",
      sessionId: "s-1",
      channelId: HERE,
      slackTs: `1.${id}`,
      dedupeKey: `prompt:link:${id}`,
      // An open card as stored before cards were guarded.
      body: {
        text: LEGACY_TEXT,
        blocks: [
          { type: "section", text: { type: "plain_text", text: HOSTILE } },
        ],
      },
      rendered: null,
      uncertainRev: 0,
      uncertain: false,
      inherited: false,
      attempts: 0,
      conversationScope: SCOPE,
    });
    let claims = 0;
    const store = {
      expireInflight: async () => 0,
      markDue: async () => 0,
      claim: async () =>
        claims++ === 0 ? [claim("open"), claim("settled")] : [],
      card: async (c: SurfaceCardClaim) =>
        c.id === "open"
          ? promptCard({
              ...display(HOSTILE, "x"),
              state: "open",
              answers: [],
            } as PendingRequestDisplay)
          : promptCard(display(HOSTILE, `yes ${OUT}`)),
      beginSend: async () => new Date(),
      finish: async () => true,
    } as Partial<SurfaceCardSettleStore> as SurfaceCardSettleStore;
    const sent: { text: string; blocks: unknown[] }[] = [];
    const pass = await settleSlackCards({
      store,
      slack: {
        updateMessage: async (_token, input) => void sent.push(input),
      },
      botToken: async () => "bot",
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      batchSize: 20,
      deadline: Date.now() + 60_000,
    });
    expect(pass.sent).toBe(2);
    expect(sent).toHaveLength(2);
    for (const card of sent) expectGuarded(JSON.stringify(card.blocks));
    // The open card's stored text, escaped as cards were before: Slack shows
    // the escaped control as text, so only the live mention and link go.
    const open = sent[0]?.text ?? "";
    expect(open).not.toContain("@channel");
    expect(open).not.toContain(ELSE);
    expect(open).toContain(IN);
    expect(open).toContain("<@U0ASKER>");
    expectGuarded(sent[1]?.text ?? "");
  });
});

describe("enqueueSlackPrompts", () => {
  test("guards each card in its row's conversation scope", async () => {
    const enqueued: SurfaceOutboxEntry[] = [];
    const row = {
      sessionLinkId: "link-1",
      sessionId: "s-1",
      workspaceId: "w",
      agentId: "a",
      slackAppId: "A",
      installationId: "i",
      channelId: HERE,
      threadTs: "1.0",
      locale: "en",
      sources: null,
      sourcesTurn: null,
      requesterSlackUserId: null,
    };
    await enqueueSlackPrompts({
      outbox: {
        unpromptedRequests: async () =>
          [
            {
              ...row,
              conversationScope: SCOPE,
              prompt: permission,
            },
            {
              ...row,
              sessionLinkId: "link-2",
              conversationScope: null,
              prompt: { ...permission, requestId: "toolu_2" },
            },
          ] as never,
        enqueue: async (entry) => {
          enqueued.push(entry);
          return true as never;
        },
      },
      consoleOrigin: "https://console.example",
      limit: 10,
    });
    const [scoped, unscoped] = enqueued.map((entry) =>
      said(entry.body as never),
    );
    expectGuarded(scoped ?? "");
    expect(unscoped).not.toContain(ELSE);
    expect(unscoped).not.toContain(HERE);
    expect(unscoped).not.toContain("@channel");
  });
});
