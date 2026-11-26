import { describe, expect, test } from "bun:test";
import type { SurfaceOutboxClaim } from "@werft-ai/platform";
import { createRowDelivery } from "./outbox-delivery.ts";
import { slackAiLabelBlock, slackAiLabelText } from "./slack-ai-label.ts";
import type { SlackBotSender, SlackSendResponse } from "./slack-config-api.ts";

// v1-b/E1: a conversation turn's answer, posted in its thread under the
// agent's name, ending with the AI line (Architect Q2).

type Posted = Parameters<SlackBotSender["postMessage"]>[1];

const row = (
  body: SurfaceOutboxClaim["body"],
  over: Partial<SurfaceOutboxClaim> = {},
): SurfaceOutboxClaim => ({
  id: "row-conversation-reply",
  claimToken: "claim",
  attempts: 1,
  workspaceId: "ws-1",
  agentId: "agent-1",
  slackAppId: "slack-app-1",
  installationId: "installation-1",
  kind: "conversation_reply",
  channelId: "C0ROOM1",
  threadTs: "1700000000.000100",
  slackUserId: null,
  sessionId: null,
  sessionLinkId: null,
  body,
  dedupeKey: "conversation_reply:turn-1",
  conversationTurnId: null,
  conversationScope: {
    kind: "channel",
    teamId: "T0ACME",
    channelId: "C0ROOM1",
  },
  ...over,
});

function deliveryAnswering(answers: SlackSendResponse["body"][]) {
  const posted: Posted[] = [];
  const delivery = createRowDelivery({
    slack: {
      postMessage: async (_token, input) => {
        posted.push(input);
        return {
          httpStatus: 200,
          retryAfterHeader: null,
          body: answers.shift() ?? { ok: true, ts: "1700000000.000200" },
        };
      },
      postEphemeral: async () => {
        throw new Error("a conversation reply is never ephemeral");
      },
      userImage: async () => null,
    },
    botToken: async () => "bot",
    consoleOrigin: null,
  });
  const deliver = (claim: SurfaceOutboxClaim) =>
    delivery.direct({
      row: claim,
      attempts: 1,
      begin: async () => ({ agentName: "Notes Agent", taskTitle: null }),
    });
  return { deliver, posted };
}

const contextOf = (input: Posted | undefined): unknown =>
  (input?.blocks as unknown[] | undefined)?.at(-1);

describe("a conversation reply row", () => {
  test("posts in its thread as the agent, ending with the AI line", async () => {
    const { deliver, posted } = deliveryAnswering([]);
    expect(
      await deliver(
        row({ text: "The plan is set.", locale: "ko", requested_by: "Ada" }),
      ),
    ).toEqual({ kind: "sent", ref: "1700000000.000200" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      channelId: "C0ROOM1",
      threadTs: "1700000000.000100",
      username: "Notes Agent",
      text: "The plan is set.\n\nAI 에이전트 · Werft",
    });
    expect(posted[0]?.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "The plan is set." } },
      slackAiLabelBlock("ko", "Ada"),
    ]);
  });

  test("a name never becomes a mention or a link", async () => {
    const name = "<@U0BOSS> & <!here> <https://evil.example|click>";
    const { deliver, posted } = deliveryAnswering([]);
    await deliver(row({ text: "Done.", locale: "en", requested_by: name }));
    // Plain text in the block: Slack reads no control there.
    expect(contextOf(posted[0])).toEqual({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: `AI agent · Werft · Requested by ${name}`,
          emoji: false,
        },
      ],
    });
    // Slack parses the text: the name stays out of it.
    expect(posted[0]?.text).toBe("Done.\n\nAI agent · Werft");
  });

  test("a bare URL as a name stays out of the text Slack links", async () => {
    const name = "https://evil.example";
    const { deliver, posted } = deliveryAnswering([
      { ok: false, error: "invalid_blocks" },
    ]);
    await deliver(row({ text: "Done.", locale: "en", requested_by: name }));
    expect(JSON.stringify(posted[0]?.blocks)).toContain(name);
    expect(posted[1]?.blocks).toBeUndefined();
    expect(posted[1]?.text).toBe("Done.\n\nAI agent · Werft");
  });

  test("the answer loses group mentions and channels outside its conversation", async () => {
    const { deliver, posted } = deliveryAnswering([]);
    await deliver(
      row({ text: "@here see <#C0OTHER9> and <#C0ROOM1>", locale: "en" }),
    );
    const text = posted[0]?.text ?? "";
    expect(text).not.toContain("@here");
    expect(text).not.toContain("C0OTHER9");
    expect(text).toContain("C0ROOM1");
    expect(JSON.stringify(posted[0]?.blocks)).not.toContain("C0OTHER9");
  });
});

describe("the AI line", () => {
  test("is worded in the row's language, the requester only when known", () => {
    expect(slackAiLabelText("ja", "Ada")).toBe(
      "AIエージェント · Werft · Ada さんの依頼",
    );
    expect(slackAiLabelText(undefined)).toBe("AI agent · Werft");
    expect(slackAiLabelText("ko", "  ")).toBe("AI 에이전트 · Werft");
  });

  test("cuts a long name", () => {
    const line = slackAiLabelText("en", "x".repeat(200));
    expect(line).toBe(`AI agent · Werft · Requested by ${"x".repeat(79)}…`);
  });
});
