import { describe, expect, test } from "bun:test";
import type {
  SlackChannelSharing,
  SlackUnheardReason,
} from "@werft-ai/contracts";
import { createFakeSlackWebApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createSlackBotApi,
  SlackApiError,
  SlackRateLimitedError,
  type SlackThreadMessage,
} from "./slack-config-api.ts";
import { createSlackThreadReader } from "./slack-thread-reader.ts";
import { fakeSlackValue } from "./testing/slack-fakes.ts";

const BOT = ["xoxb", "test", "thread", "reader"].join("-");
const thread = { teamId: "T0ACME", channelId: "C0OPS", ts: "100.0" };
const asked = {
  workspaceId: "w-1",
  agentId: "agent-1",
  thread,
  limit: 50,
};

function readerWith(options: {
  sharing?: SlackChannelSharing | null;
  posts?: SlackThreadMessage[] | Error;
  unheard?: Record<string, SlackUnheardReason>;
  token?: string | null;
}) {
  const calls: string[] = [];
  const warned: unknown[] = [];
  const reader = createSlackThreadReader({
    slack: {
      async threadReplies(token, input) {
        calls.push(
          `conversations.replies ${input.channelId} ${input.threadTs} ${input.limit} ${token === BOT}`,
        );
        if (options.posts instanceof Error) throw options.posts;
        return options.posts ?? [];
      },
    },
    audience: {
      async channelSharing(question) {
        calls.push(`sharing ${question.channelId}`);
        return options.sharing === undefined ? "internal" : options.sharing;
      },
      async authorUnheardReason(question) {
        calls.push(`author ${question.slackUserId} ${question.teamId}`);
        return options.unheard?.[question.slackUserId] ?? null;
      },
    },
    botToken: async () => (options.token === undefined ? BOT : options.token),
    logger: { warn: (_message, fields) => warned.push(fields) },
  });
  return { reader, calls, warned };
}

describe("threadReplies", () => {
  test("reads one thread with conversations.replies, the bot's own replies in it as a bot's", async () => {
    const slack = createFakeSlackWebApi();
    const token = fakeSlackValue("xoxb");
    slack.apps.set("A0READER", {
      appId: "A0READER",
      clientId: "1.1",
      clientSecret: fakeSlackValue("client"),
      signingSecret: fakeSlackValue("signing"),
      manifest: {},
      botTokens: [token],
    });
    slack.threads.set("C0OPS/100.000001", [
      { ts: "100.000001", user: "U0ASKER", text: "first" },
      {
        ts: "100.000002",
        subtype: "channel_join",
        user: "U0NEW",
        text: "joined",
      },
    ]);
    const api = createSlackBotApi({
      apiUrl: "http://slack.test/api",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        (await slack.handle(new Request(input, init))) ??
        new Response("not found", { status: 404 })) as typeof fetch,
    });
    await api.postMessage(token, {
      channelId: "C0OPS",
      threadTs: "100.000001",
      text: "the answer",
    });
    const read = await api.threadReplies(token, {
      channelId: "C0OPS",
      threadTs: "100.000001",
      limit: 2,
    });
    expect(read).toEqual([
      { ts: "100.000001", user: "U0ASKER", text: "first" },
      {
        ts: "100.000002",
        user: "U0NEW",
        subtype: "channel_join",
        text: "joined",
      },
    ]);
    const all = await api.threadReplies(token, {
      channelId: "C0OPS",
      threadTs: "100.000001",
      limit: 50,
    });
    expect(all.at(-1)).toMatchObject({ text: "the answer", botId: "B0READER" });
    slack.rateLimit("conversations.replies", 30);
    await expect(
      api.threadReplies(token, {
        channelId: "C0OPS",
        threadTs: "100.000001",
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(SlackRateLimitedError);
  });
});

describe("createSlackThreadReader", () => {
  test("reads the thread with the agent's bot token; a guest's or a stranger's post, or one with no author, is withheld", async () => {
    const { reader, calls } = readerWith({
      posts: [
        { ts: "100.0", user: "U0ASKER", text: "first" },
        { ts: "101.0", user: "U0GUEST", text: "guest" },
        { ts: "102.0", user: "U0PARTNER", text: "partner" },
        { ts: "103.0", botId: "B0BOT", user: "U0BOTUSER", text: "bot said" },
        { ts: "104.0", subtype: "channel_join", user: "U0NEW", text: "joined" },
        { ts: "105.0", text: "no author" },
      ],
      unheard: { U0GUEST: "guest_author", U0PARTNER: "external_author" },
    });
    expect(await reader.read(asked)).toEqual({
      outcome: "read",
      messages: [
        {
          ts: "100.0",
          author: { kind: "person", slackUserId: "U0ASKER" },
          text: "first",
        },
        { ts: "103.0", author: { kind: "bot" }, text: "bot said" },
      ],
      withheld: 3,
    });
    expect(calls).toEqual([
      "sharing C0OPS",
      "conversations.replies C0OPS 100.0 50 true",
      "author U0ASKER T0ACME",
      "author U0GUEST T0ACME",
      "author U0PARTNER T0ACME",
    ]);
  });

  test("a channel another organization shares, or whose sharing Slack would not tell, is not read", async () => {
    for (const [sharing, outcome] of [
      ["external", "external_shared"],
      [null, "unavailable"],
    ] as const) {
      const { reader, calls } = readerWith({ sharing });
      expect(await reader.read(asked)).toEqual({ outcome });
      expect(calls).toEqual(["sharing C0OPS"]);
    }
  });

  test("a 429 says so; another failure, or no bot token, is unavailable", async () => {
    expect(
      await readerWith({
        posts: new SlackRateLimitedError("conversations.replies", 30),
      }).reader.read(asked),
    ).toEqual({ outcome: "rate_limited" });
    const failed = readerWith({
      posts: new SlackApiError(
        "conversations.replies",
        "channel_not_found",
        true,
      ),
    });
    expect(await failed.reader.read(asked)).toEqual({ outcome: "unavailable" });
    expect(failed.warned).toEqual([
      {
        event: "slack.thread_read.failed",
        agent_id: "agent-1",
        channel_id: "C0OPS",
        slack_error: "channel_not_found",
      },
    ]);
    const none = readerWith({ token: null });
    expect(await none.reader.read(asked)).toEqual({ outcome: "unavailable" });
    expect(none.calls).toEqual([]);
  });
});
