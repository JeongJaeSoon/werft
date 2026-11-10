import { describe, expect, test } from "bun:test";
import type { SessionLinkRecord, SlackInboundClaim } from "@werft-ai/platform";
import { createSlackSessionHandler } from "./slack-session-handler.ts";
import {
  judgeThreadReply,
  type SlackThreadShadow,
} from "./slack-thread-shadow.ts";

const BOT = "U0BOT";
const SHADOW = "Slack thread reply judged without a mention";

describe("judging an unmentioned thread reply", () => {
  const cases: [
    string,
    string,
    SlackThreadShadow["decision"],
    SlackThreadShadow["reason"],
  ][] = [
    ["plain talk", "sounds good", "reply", "default_reply"],
    [
      "another person's mention",
      "<@U2> take a look",
      "skip",
      "addressed_to_other_user",
    ],
    [
      "mention with a display name",
      "<@U2|kim> fyi",
      "skip",
      "addressed_to_other_user",
    ],
    [
      "mention with a question",
      "<@U2> why does it fail?",
      "reply",
      "default_reply",
    ],
    ["full-width question mark", "<@U2> 왜 실패해？", "reply", "default_reply"],
    ["the bot's own mention", `<@${BOT}> and thanks`, "reply", "default_reply"],
  ];
  for (const [name, text, decision, reason] of cases) {
    test(name, () => {
      expect(judgeThreadReply(text, BOT)).toEqual({ decision, reason });
    });
  }
});

const link = (revokedAt: Date | null = null): SessionLinkRecord => ({
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
  revokedAt,
});

/**
 * The handler stops at the missing bot token, the first step after the
 * mention gate, so each case sees the gate and the shadow record only.
 */
async function run(
  event: Record<string, unknown>,
  found: SessionLinkRecord | null,
) {
  const records: Record<string, unknown>[] = [];
  let reachedBotToken = 0;
  const handler = createSlackSessionHandler({
    agents: {
      resolveSlackEvent: async () => ({
        status: "resolved",
        workspaceId: "ws",
        agentId: "agent",
        identity: { id: "id", revision: 1 },
        installationId: "inst",
        botUserId: BOT,
        credentialRef: "ref",
      }),
    },
    sessionLinks: { find: async () => found },
    bindings: {
      resolveSlackChannel: async () => null,
      ensureDmBinding: async () => null,
    },
    settings: { getSettings: async () => null },
    botToken: async () => {
      reachedBotToken += 1;
      return null;
    },
    logger: {
      info: (message: string, fields?: Record<string, unknown>) => {
        if (message === SHADOW) records.push(fields ?? {});
      },
      warn: () => {},
    },
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
        text: "hello",
        channel_type: "channel",
        ...event,
      },
    },
  } as unknown as SlackInboundClaim;
  await handler(claim).catch(() => {});
  return { records, reachedBotToken };
}

describe("the shadow record in the session handler", () => {
  test("an unmentioned reply in a linked thread is recorded once and still goes on", async () => {
    const { records, reachedBotToken } = await run({}, link());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event_id: "Ev1",
      channel: "C1",
      thread_ts: "1.0",
      decision: "reply",
      reason: "default_reply",
    });
    expect(JSON.stringify(records[0])).not.toContain("hello");
    expect(reachedBotToken).toBe(1);
  });

  test("a thread_broadcast reply is recorded like any reply", async () => {
    const { records } = await run({ subtype: "thread_broadcast" }, link());
    expect(records).toHaveLength(1);
  });

  test("a skip judgment changes nothing: the reply still goes on", async () => {
    const { records, reachedBotToken } = await run(
      { text: "<@U2> please look" },
      link(),
    );
    expect(records[0]).toMatchObject({
      decision: "skip",
      reason: "addressed_to_other_user",
    });
    expect(reachedBotToken).toBe(1);
  });

  const unrecorded: [
    string,
    Record<string, unknown>,
    SessionLinkRecord | null,
  ][] = [
    ["an app mention", { type: "app_mention" }, link()],
    ["a text mention of the bot", { text: `<@${BOT}> hi` }, link()],
    ["a DM", { channel_type: "im", thread_ts: undefined }, link()],
    // The root of a linked thread, seen again after a retry, is not a reply.
    ["a retried thread root", { thread_ts: undefined }, link()],
    ["a root carrying its own ts as thread_ts", { thread_ts: "2.0" }, link()],
    ["a reply in a thread with no link", {}, null],
    ["a reply in a thread whose link was revoked", {}, link(new Date())],
  ];
  for (const [name, event, found] of unrecorded) {
    test(`${name} leaves no record`, async () => {
      expect((await run(event, found)).records).toHaveLength(0);
    });
  }
});
