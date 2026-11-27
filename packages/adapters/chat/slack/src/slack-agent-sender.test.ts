import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  SurfaceOutboxClaim,
  SurfaceOutboxPostedAs,
  SurfaceOutboxStore,
} from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import { createRowDelivery } from "./outbox-delivery.ts";
import {
  createSlackBotApi,
  type SlackBotSender,
  type SlackSendResponse,
} from "./slack-config-api.ts";
import { drainSlackOutbox } from "./slack-outbox.ts";
import { slackAgentSender } from "./slack-outbox-render.ts";

// v1-b/N1: a task's rows go out as "agent [task]", the agent's other rows
// as the agent, and an app without chat:write.customize as itself.

const TOKEN = "test-bot-credential";
const SLACK_APP = "slack-app-sender";
const TASK = { agentName: "Payments Agent", taskTitle: "Fix the login" };
const AGENT_ONLY = { agentName: "Payments Agent", taskTitle: null };

describe("slackAgentSender", () => {
  test("names a task's agent and its title", () => {
    expect(slackAgentSender(TASK)).toBe("Payments Agent [Fix the login]");
  });

  test("names the agent alone without a title or outside a task", () => {
    for (const taskTitle of [null, "", " \n\t "]) {
      expect(slackAgentSender({ agentName: "Payments Agent", taskTitle })).toBe(
        "Payments Agent",
      );
    }
  });

  test("names no one without an agent name", () => {
    expect(slackAgentSender(null)).toBeNull();
    expect(slackAgentSender(undefined)).toBeNull();
    expect(slackAgentSender({ agentName: "  ", taskTitle: "x" })).toBeNull();
  });

  test("keeps the name to one line", () => {
    expect(
      slackAgentSender({ agentName: " Payments\n Agent ", taskTitle: "a\nb" }),
    ).toBe("Payments Agent [a b]");
  });

  test("fits 80 characters exactly, and cuts at 80 past it", () => {
    const name = "Payments Agent";
    // 14 + " [" + title + "]" = 80 with a 63-character title.
    const fits = "t".repeat(63);
    expect(slackAgentSender({ agentName: name, taskTitle: fits })).toBe(
      `${name} [${fits}]`,
    );
    const over = slackAgentSender({ agentName: name, taskTitle: `${fits}u` });
    expect([...(over ?? "")]).toHaveLength(80);
    expect(over).toBe(`${name} [${"t".repeat(62)}…]`);
    // Counted in characters, so no surrogate pair is split.
    const emoji = slackAgentSender({
      agentName: name,
      taskTitle: "🚀".repeat(70),
    });
    expect([...(emoji ?? "")]).toHaveLength(80);
    expect(emoji?.endsWith("🚀…]")).toBe(true);
  });

  test("keeps a title that fits exactly, and drops one with no room to cut", () => {
    const name = "n".repeat(76);
    expect(slackAgentSender({ agentName: name, taskTitle: "x" })).toBe(
      `${name} [x]`,
    );
    expect(slackAgentSender({ agentName: name, taskTitle: "xy" })).toBe(name);
  });

  test("cuts a name too long for a title at 80 and drops the title", () => {
    const long = "n".repeat(90);
    expect(slackAgentSender({ agentName: long, taskTitle: "x" })).toBe(
      "n".repeat(80),
    );
  });
});

const claim = (over: Partial<SurfaceOutboxClaim>): SurfaceOutboxClaim => ({
  id: "outbox-1",
  claimToken: "claim-1",
  attempts: 1,
  workspaceId: "workspace-1",
  agentId: "agent-1",
  slackAppId: SLACK_APP,
  installationId: "installation-1",
  kind: "reply",
  channelId: "C0OPS",
  threadTs: "100.000100",
  slackUserId: null,
  sessionId: "session-1",
  sessionLinkId: "link-1",
  body: { text: "Done." },
  dedupeKey: "reply:link-1:1",
  ...over,
});

const card = {
  text: "Approve the push?",
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: "Approve the push?" } },
  ],
};

describe("posting over the fake Slack", () => {
  const fakeSlack = startFakeSlackApi();
  beforeAll(() => {
    fakeSlack.apps.set(SLACK_APP, {
      appId: SLACK_APP,
      clientId: "client",
      clientSecret: "client-secret",
      signingSecret: "signing-secret",
      manifest: null,
      botTokens: [TOKEN],
    });
  });
  afterAll(() => fakeSlack.stop());

  async function usernames(
    rows: [SurfaceOutboxClaim, SurfaceOutboxPostedAs | null][],
  ) {
    fakeSlack.messages.length = 0;
    const delivery = createRowDelivery({
      slack: createSlackBotApi({ apiUrl: fakeSlack.url }),
      botToken: async () => TOKEN,
      consoleOrigin: "https://console.example",
    });
    for (const [row, postedAs] of rows) {
      expect(
        await delivery.direct({
          row,
          attempts: 1,
          begin: async () => postedAs ?? true,
        }),
      ).toMatchObject({ kind: "sent" });
    }
    return fakeSlack.messages.map((message) => [
      message.method,
      message.options.username ?? null,
    ]);
  }

  test("a task's answer, notice and card go out as agent [task]", async () => {
    expect(
      await usernames([
        [claim({}), TASK],
        [claim({ kind: "failure_notice" }), TASK],
        [claim({ kind: "action_notice" }), TASK],
        [claim({ kind: "input_notice", body: card }), TASK],
      ]),
    ).toEqual([
      ["chat.postMessage", "Payments Agent [Fix the login]"],
      ["chat.postMessage", "Payments Agent [Fix the login]"],
      ["chat.postMessage", "Payments Agent [Fix the login]"],
      ["chat.postMessage", "Payments Agent [Fix the login]"],
    ]);
  });

  test("an untitled task and a row outside any task go out as the agent", async () => {
    expect(
      await usernames([
        [claim({}), AGENT_ONLY],
        [
          claim({
            kind: "welcome",
            sessionId: null,
            sessionLinkId: null,
            threadTs: "",
          }),
          AGENT_ONLY,
        ],
      ]),
    ).toEqual([
      ["chat.postMessage", "Payments Agent"],
      ["chat.postMessage", "Payments Agent"],
    ]);
  });

  test("an instruction keeps its sender's name; a refusal names no one", async () => {
    expect(
      await usernames([
        [
          claim({
            kind: "instruction",
            body: {
              text: "Add a test",
              sender: { username: "Ada (Web console)" },
            },
          }),
          TASK,
        ],
        [
          claim({
            kind: "notice",
            slackUserId: "U0READER",
            sessionId: null,
            sessionLinkId: null,
          }),
          AGENT_ONLY,
        ],
        // A store that reads no name: the app's own.
        [claim({}), null],
      ]),
    ).toEqual([
      ["chat.postMessage", "Ada (Web console)"],
      ["chat.postEphemeral", null],
      ["chat.postMessage", null],
    ]);
  });
});

describe("an app without chat:write.customize", () => {
  const ok: SlackSendResponse = {
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: true, ts: "200.000200" },
  };
  const refusal = (error: string): SlackSendResponse => ({
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: false, error },
  });

  async function posts(row: SurfaceOutboxClaim, answers: SlackSendResponse[]) {
    const sent: Parameters<SlackBotSender["postMessage"]>[1][] = [];
    const delivery = createRowDelivery({
      slack: {
        postMessage: async (_token, input) => {
          sent.push(input);
          return answers.shift() ?? ok;
        },
        postEphemeral: async () => ok,
        userImage: async () => null,
      },
      botToken: async () => TOKEN,
      consoleOrigin: null,
    });
    const outcome = await delivery.direct({
      row,
      attempts: 1,
      begin: async () => TASK,
    });
    return { outcome, sent };
  }

  test("posts once more as the app, the text unchanged", async () => {
    const { outcome, sent } = await posts(claim({}), [
      refusal("missing_scope"),
    ]);
    expect(outcome).toEqual({ kind: "sent", ref: "200.000200" });
    expect(sent.map((input) => input.username ?? null)).toEqual([
      "Payments Agent [Fix the login]",
      null,
    ]);
    expect(sent[1]).toEqual({ ...sent[0], username: undefined } as never);
    expect(sent[1]).not.toHaveProperty("username");
  });

  test("a card goes once more as the app with its blocks", async () => {
    const { outcome, sent } = await posts(
      claim({ kind: "input_notice", body: card }),
      [refusal("missing_scope")],
    );
    expect(outcome).toMatchObject({ kind: "sent" });
    expect(sent.map((input) => [input.username ?? null, input.blocks])).toEqual(
      [
        ["Payments Agent [Fix the login]", card.blocks],
        [null, card.blocks],
      ],
    );
  });

  test("a table refused as blocks goes as text, as the app", async () => {
    const table = { text: "| a | b |\n| --- | --- |\n| 1 | 2 |" };
    const { sent } = await posts(claim({ body: table }), [
      refusal("missing_scope"),
      refusal("invalid_blocks"),
    ]);
    expect(
      sent.map((input) => [input.username ?? null, input.blocks !== undefined]),
    ).toEqual([
      ["Payments Agent [Fix the login]", true],
      [null, true],
      [null, false],
    ]);
  });

  test("any other refusal is the row's own, not retried", async () => {
    const { outcome, sent } = await posts(claim({}), [
      refusal("channel_not_found"),
    ]);
    expect(outcome).toEqual({ kind: "failed", code: "channel_not_found" });
    expect(sent).toHaveLength(1);
  });
});

describe("the name read when the send begins", () => {
  const ok: SlackSendResponse = {
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: true, ts: "200.000200" },
  };

  test("the drain hands beginSend's name to the delivery", async () => {
    const sent: (string | null)[] = [];
    const batches = [[claim({}), claim({ id: "outbox-2" })], []];
    const outbox = {
      advanceAnswered: async () => 0,
      closeFinishedLinks: async () => 0,
      unpostedInstructions: async () => [],
      unmirroredInputs: async () => [],
      closeOverdueHeld: async () => 0,
      unansweredTurns: async () => [],
      afterTurnReplies: async () => [],
      unpromptedRequests: async () => [],
      expireSending: async () => [],
      closeUnaddressed: async () => [],
      untoldUncertain: async () => [],
      claim: async () => batches.shift() ?? [],
      // A title withheld at the send, then a store that reads no name.
      beginSend: async (fence: { id: string }) =>
        fence.id === "outbox-1" ? AGENT_ONLY : true,
      settle: async () => true,
      enqueue: async () => "enqueued" as const,
    } as unknown as SurfaceOutboxStore;
    const slack = {
      postMessage: async (
        _token: string,
        input: Parameters<SlackBotSender["postMessage"]>[1],
      ) => {
        sent.push(input.username ?? null);
        return ok;
      },
      postEphemeral: async () => ok,
      userImage: async () => null,
      setStatus: async () => {},
    };
    const botToken = async () => TOKEN;
    await drainSlackOutbox({
      outbox,
      slack: slack as never,
      botToken,
      delivery: createRowDelivery({ slack, botToken, consoleOrigin: null }),
      logger: { info: () => {}, warn: () => {} },
      consoleOrigin: null,
      batchSize: 10,
      leaseMs: 30_000,
      deadline: 1_000,
      now: () => 0,
    });
    expect(sent).toEqual(["Payments Agent", null]);
  });
});
