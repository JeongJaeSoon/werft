import { describe, expect, test } from "bun:test";
import type { ConversationRollout } from "@werft-ai/contracts";
import type { SurfaceInboundClaim, TaskReplyRoute } from "@werft-ai/platform";
import { SlackInboundDeferred } from "./slack-inbox.ts";
import { createSlackSessionHandler } from "./slack-session-handler.ts";

const BOT = "U0BOT";
const WENT_ON = "went on to a session turn";
/** The last receive()'s task replies, for one whose handler threw. */
let lastTaskReplies: Record<string, unknown>[] = [];

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
  /** The bound session's work, read once the rollout is on. */
  work?: "open" | "closed";
  /** Where the store sends a reply of work going on. */
  taskRoute?: TaskReplyRoute;
  /** False: no turn took the post yet, so this is its first reading. */
  taken?: boolean;
  /** The post was held for its work's judgment before. */
  held?: boolean;
  /** null: an event that does not say its channel's kind. */
  channelType?: string | null;
  /** The kind Slack says the channel is, asked. */
  slackKind?: string;
}) {
  const engagedAsked: unknown[] = [];
  const workAsked: string[] = [];
  const taskReplies: Record<string, unknown>[] = [];
  lastTaskReplies = taskReplies;
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
      closedSessions: async () => [],
      slackTurn: async () =>
        (options.taken ?? true) ? { sequence: 3, requesterId: "user-1" } : null,
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
        channelKind: "public_channel",
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
    stops: { stoppedBefore: async () => false },
    slack: {
      channelKind: async () => options.slackKind,
      userInfo: async () => {
        throw new Error(WENT_ON);
      },
    },
    boundReplies: {
      heldForWork: async () => options.held ?? false,
      work: async (sessionId: string) => {
        workAsked.push(sessionId);
        return options.work ?? "closed";
      },
      taskReply: async (reply: Record<string, unknown>) => {
        taskReplies.push(reply);
        return options.taskRoute ?? "session";
      },
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
        ...(options.channelType === null
          ? {}
          : { channel_type: options.channelType ?? "channel" }),
      },
    },
  } as unknown as SurfaceInboundClaim;
  return {
    receipt: (await handler(claim)) as Record<string, unknown> | undefined,
    engagedAsked,
    workAsked,
    taskReplies,
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
      rollout: "shadow",
      linked: true,
      text: "<@U2> take a look",
    });
    expect(receipt?.judgment).toEqual({
      rule: { decision: "skip", reason: "addressed_to_other_user" },
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

describe("once the rollout is on, a bound thread's unmentioned reply is routed by its work", () => {
  test("work done: held for M1 (m1), no session turn", async () => {
    const { receipt, workAsked } = await receive({
      rollout: "on",
      linked: true,
      taken: false,
    });
    expect(workAsked).toEqual(["sess"]);
    expect(receipt).toEqual({
      topicId: "topic-1",
      channelId: "C1",
      ts: "2.0",
      buffered: { body: "sounds good", slackUserId: "U1" },
      judgment: {
        grade: "m1",
        rule: { decision: "reply", reason: "default_reply" },
      },
    });
  });

  test("work done, a channel that listens to nothing: dropped, nothing held", async () => {
    const { receipt, taskReplies } = await receive({
      rollout: "on",
      linked: true,
      taken: false,
      listen: "off",
    });
    expect(receipt).toBeUndefined();
    expect(taskReplies).toEqual([]);
  });

  test("work going on, not judged yet: the event waits, its thread aside", async () => {
    const waiting = receive({
      rollout: "on",
      linked: true,
      taken: false,
      work: "open",
      taskRoute: "waiting",
    });
    await expect(waiting).rejects.toBeInstanceOf(SlackInboundDeferred);
  });

  test("work going on, kept quiet: no session turn", async () => {
    const { receipt, taskReplies } = await receive({
      rollout: "on",
      linked: true,
      taken: false,
      work: "open",
      taskRoute: "quiet",
    });
    expect(receipt).toBeUndefined();
    expect(taskReplies).toEqual([
      expect.objectContaining({
        topicId: "topic-1",
        channelId: "C1",
        ts: "2.0",
        body: "sounds good",
        slackUserId: "U1",
        waitMs: 30_000,
      }),
    ]);
  });

  test("work going on, spoken or not judged: the work takes it", async () => {
    await expect(
      receive({
        rollout: "on",
        linked: true,
        taken: false,
        work: "open",
        taskRoute: "session",
      }),
    ).rejects.toThrow(WENT_ON);
    expect(lastTaskReplies).toHaveLength(1);
  });

  test("a turn retried after its work took the post carries no judgment", async () => {
    const { receipt, workAsked } = await receive({
      rollout: "on",
      linked: true,
    });
    expect(receipt).toMatchObject({ engagement: "bound" });
    expect(receipt).not.toHaveProperty("judgment");
    expect(workAsked).toEqual([]);
  });

  test("work going on, a stop word: no judgment is waited for", async () => {
    await expect(
      receive({
        rollout: "on",
        linked: true,
        taken: false,
        work: "open",
        taskRoute: "waiting",
        text: "stop",
      }),
    ).rejects.toThrow(WENT_ON);
    expect(lastTaskReplies).toEqual([]);
  });

  test("a reply held before answers by its hold, though Slack cannot say its audience now", async () => {
    const { receipt, taskReplies } = await receive({
      rollout: "on",
      linked: true,
      taken: false,
      held: true,
      unheard: "audience_unconfirmed",
      taskRoute: "quiet",
    });
    expect(receipt).toBeUndefined();
    expect(taskReplies).toHaveLength(1);
  });

  test("an event that does not say its channel turned private is not judged before the channel's kind is", async () => {
    await expect(
      receive({
        rollout: "on",
        linked: true,
        taken: false,
        channelType: null,
        slackKind: "private_channel",
      }),
    ).rejects.toThrow(WENT_ON);
    expect(lastTaskReplies).toEqual([]);
  });

  test("a mention of the agent is not routed: its session takes it", async () => {
    await expect(
      receive({
        rollout: "on",
        linked: true,
        taken: false,
        text: `<@${BOT}> sounds good`,
      }),
    ).rejects.toThrow(WENT_ON);
    expect(lastTaskReplies).toEqual([]);
  });
});
