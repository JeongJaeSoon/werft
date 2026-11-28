import { describe, expect, test } from "bun:test";
import {
  type ConversationRollout,
  MESSAGE_MAX_BYTES,
} from "@werft-ai/contracts";
import type { SurfaceInboundClaim } from "@werft-ai/platform";
import { createSlackSessionHandler } from "./slack-session-handler.ts";

const BOT = "U0BOT";

/**
 * What the handler hands the inbox for a reply it does not turn into a new
 * turn here: a retried turn's input, or a post held in the buffer.
 */
async function receive(options: {
  rollout: ConversationRollout;
  linked: boolean;
  engaged?: boolean;
  unheard?: string | null;
  listen?: "free" | "mention" | "off";
  text?: string;
}) {
  const engagedAsked: unknown[] = [];
  const handler = createSlackSessionHandler({
    agents: {
      resolveSlackEvent: async () => ({
        status: "resolved",
        workspaceId: "ws",
        agentId: "agent",
        identity: { id: "id", revision: 1 },
        installationId: "inst",
        botUserId: BOT,
        allowedBotUserIds: [],
        werftBotUserIds: [],
      }),
    },
    botTurns: { reset: async () => {} },
    sessionLinks: {
      find: async () =>
        options.linked
          ? {
              id: "link-1",
              workspaceId: "ws",
              installationId: "inst",
              surfaceBindingId: "bind",
              surfaceRef: "C1:1.0",
              channelId: "C1",
              threadId: "1.0",
              openedByTs: "1.0",
              agentId: "agent",
              releaseId: "rel",
              sessionId: "sess",
              createdBy: null,
              revokedAt: null,
            }
          : null,
      // A turn already taken: the retry path hands its input back.
      slackTurn: async () => ({ sequence: 3, requesterId: "user-1" }),
    },
    buffer: {
      place: async () => ({
        rollout: options.rollout,
        agentActive: true,
        channelState: "active",
      }),
      engagedThread: async (key: unknown) => {
        engagedAsked.push(key);
        return options.engaged ?? false;
      },
    },
    bindings: {
      findLiveSlackChannel: async () => ({
        status: "ready",
        mode: "on",
        listen: options.listen ?? "mention",
        approvedAt: null,
      }),
      resolveSlackChannel: async () => null,
    },
    settings: { getSettings: async () => null },
    audience: { unheardReason: async () => options.unheard ?? null },
    botToken: async () => "bot-token",
    conversations: {
      findOrCreateConversation: async () => ({ id: "conv-1" }),
      findOrCreateThreadTopic: async () => ({ id: "topic-1" }),
    },
    logger: { info: () => {}, warn: () => {} },
  } as never);
  const claim = {
    id: "row-1",
    eventId: "Ev1",
    appId: "A1",
    teamId: "T1",
    agentId: "agent",
    workspaceId: "ws",
    slackAppId: "sa",
    payload: {
      event: {
        type: "message",
        channel: "C1",
        ts: "2.0",
        thread_ts: "1.0",
        user: "U1",
        text: options.text ?? "sounds good",
        channel_type: "channel",
      },
    },
  } as unknown as SurfaceInboundClaim;
  return {
    receipt: (await handler(claim)) as Record<string, unknown> | undefined,
    engagedAsked,
  };
}

describe("a bound thread's unmentioned reply asks for M1's judgment", () => {
  test("in shadow, with the rule's call beside it", async () => {
    const { receipt } = await receive({ rollout: "shadow", linked: true });
    expect(receipt).toMatchObject({
      engagement: "bound",
      judgment: { rule: { decision: "reply", reason: "default_reply" } },
    });
  });

  test("a skip rule is carried as it is", async () => {
    const { receipt } = await receive({
      rollout: "on",
      linked: true,
      text: "<@U2> take a look",
    });
    expect(receipt?.judgment).toEqual({
      rule: { decision: "skip", reason: "addressed_to_other_user" },
    });
  });

  test("an escaped mention of another user is not addressed to them", async () => {
    const { receipt } = await receive({
      rollout: "on",
      linked: true,
      text: "&lt;@U2&gt; take a look",
    });
    expect(receipt?.judgment).toEqual({
      rule: { decision: "reply", reason: "default_reply" },
    });
  });

  test("not with the switch off", async () => {
    const { receipt } = await receive({ rollout: "off", linked: true });
    expect(receipt).toMatchObject({ engagement: "bound" });
    expect(receipt).not.toHaveProperty("judgment");
  });

  test("not for a poster who may not be heard (a guest)", async () => {
    const { receipt } = await receive({
      rollout: "shadow",
      linked: true,
      unheard: "guest",
    });
    expect(receipt).not.toHaveProperty("judgment");
  });
});

describe("an unbound thread the agent took part in lately", () => {
  test("holds the reply for an m1_engaged judgment", async () => {
    const { receipt, engagedAsked } = await receive({
      rollout: "shadow",
      linked: false,
      engaged: true,
    });
    expect(engagedAsked).toEqual([
      {
        kind: "channel",
        workspaceId: "ws",
        agentId: "agent",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1.0",
      },
    ]);
    expect(receipt).toMatchObject({
      topicId: "topic-1",
      ts: "2.0",
      buffered: { body: "sounds good", slackUserId: "U1" },
      judgment: "m1_engaged",
    });
  });

  test("the held body is read from Slack's escapes, the mention check is not", async () => {
    const { receipt } = await receive({
      rollout: "shadow",
      linked: false,
      engaged: true,
      text: `&lt;@${BOT}&gt; A &amp;&amp; B &amp;lt;`,
    });
    expect(receipt).toMatchObject({
      buffered: { body: `<@${BOT}> A && B &lt;` },
    });
  });

  test("a body only its read form fits in is held, as the size is checked on what is held", async () => {
    // "&lt;" is four bytes of text and one once read.
    const count = MESSAGE_MAX_BYTES / 4 + 1;
    const { receipt } = await receive({
      rollout: "shadow",
      linked: false,
      engaged: true,
      text: "&lt;".repeat(count),
    });
    expect(receipt).toMatchObject({ buffered: { body: "<".repeat(count) } });
  });

  test("a thread not engaged under mention-only is not held", async () => {
    const { receipt } = await receive({
      rollout: "shadow",
      linked: false,
      engaged: false,
    });
    expect(receipt).toBeUndefined();
  });

  test("a thread not engaged under free listening is a plain buffer hold", async () => {
    const { receipt } = await receive({
      rollout: "shadow",
      linked: false,
      engaged: false,
      listen: "free",
    });
    expect(receipt).toMatchObject({ buffered: { body: "sounds good" } });
    expect(receipt).not.toHaveProperty("judgment");
  });

  test("a channel that listens to nothing holds nothing, engaged or not", async () => {
    const { receipt } = await receive({
      rollout: "shadow",
      linked: false,
      engaged: true,
      listen: "off",
    });
    expect(receipt).toBeUndefined();
  });

  test("with the switch off nothing is asked", async () => {
    const { receipt, engagedAsked } = await receive({
      rollout: "off",
      linked: false,
      engaged: true,
    });
    expect(receipt).toBeUndefined();
    expect(engagedAsked).toEqual([]);
  });

  test("an unheard poster is not held", async () => {
    const { receipt } = await receive({
      rollout: "shadow",
      linked: false,
      engaged: true,
      unheard: "guest",
    });
    expect(receipt).toBeUndefined();
  });
});
