import { describe, expect, test } from "bun:test";
import type {
  ChannelKindChanged,
  ChannelKindNow,
  ChannelSessionPlace,
  SlackInboundClaim,
} from "@werft-ai/platform";
import { createSlackChannelConversionHandler } from "./slack-channel-conversion.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000c1";

const resolved = {
  resolveSlackEvent: async () => ({
    status: "resolved",
    workspaceId: WORKSPACE,
    agentId: AGENT,
    installationId: INSTALLATION,
    identityId: "identity-1",
    botUserId: "U0BOT",
  }),
} as never;

const claim = (event: Record<string, unknown>) =>
  ({
    id: "e1",
    workspaceId: WORKSPACE,
    agentId: AGENT,
    appId: "A1",
    slackAppId: "app-1",
    teamId: "T1",
    eventType: String(event.type),
    eventTime: null,
    payload: { event },
  }) as unknown as SlackInboundClaim;

function handler(
  options: {
    agents?: never;
    slackSays?: ChannelKindNow | "dm";
    token?: string | null;
  } = {},
) {
  const calls: [ChannelSessionPlace, ChannelKindNow][] = [];
  const asked: string[] = [];
  const passed: unknown[] = [];
  const handle = createSlackChannelConversionHandler({
    agents: options.agents ?? resolved,
    bindings: {
      channelKindChanged: async (
        place,
        kindNow,
      ): Promise<ChannelKindChanged | null> => {
        const kind = await kindNow();
        if (kind === null) return null;
        calls.push([place, kind]);
        return {
          binding: "unchanged",
          moves: [],
          keptPrivate: [],
          unchanged: [],
          skipped: [],
        };
      },
    },
    slack: {
      channelKind: async (_token, channel) => {
        asked.push(channel);
        return options.slackSays ?? "public_channel";
      },
    },
    botToken: async () =>
      options.token === undefined ? "bot-credential" : options.token,
    logger: { info: () => {} },
    next: async (claim) => {
      passed.push((claim.payload as { event: unknown }).event);
    },
  });
  return { handle, calls, asked, passed };
}

const place = (channelId: string) => ({
  workspaceId: WORKSPACE,
  agentId: AGENT,
  installationId: INSTALLATION,
  teamId: "T1",
  channelId,
});

const conversion = (subtype: string) =>
  claim({ type: "message", subtype, channel: "C1", user: "U0P", ts: "1.1" });

describe("channel conversion handler", () => {
  test.each([
    ["channel_convert_to_private", "private_channel"],
    ["channel_convert_to_public", "public_channel"],
  ] as const)(
    "%s moves the channel's binding and sessions to %s, as Slack says now, and stops there",
    async (subtype, kind) => {
      const h = handler({ slackSays: kind });
      await h.handle(conversion(subtype));
      expect(h.asked).toEqual(["C1"]);
      expect(h.calls).toEqual([[place("C1"), kind]]);
      expect(h.passed).toEqual([]);
    },
  );

  test("a late conversion to public, after the channel went private again, keeps it private", async () => {
    const h = handler({ slackSays: "private_channel" });
    await h.handle(conversion("channel_convert_to_public"));
    expect(h.calls).toEqual([[place("C1"), "private_channel"]]);
  });

  test("without a bot token only a conversion to private is applied", async () => {
    const toPrivate = handler({ token: null });
    await toPrivate.handle(conversion("channel_convert_to_private"));
    expect(toPrivate.calls).toEqual([[place("C1"), "private_channel"]]);
    const toPublic = handler({ token: null });
    await toPublic.handle(conversion("channel_convert_to_public"));
    expect(toPublic.calls).toEqual([]);
    expect(toPublic.asked).toEqual([]);
  });

  test("a channel Slack calls a DM changes nothing", async () => {
    const h = handler({ slackSays: "dm" });
    await h.handle(conversion("channel_convert_to_private"));
    expect(h.calls).toEqual([]);
  });

  test("a failed Slack read throws, so the inbox tries again", async () => {
    const h = createSlackChannelConversionHandler({
      agents: resolved,
      bindings: {
        channelKindChanged: async (_place, kindNow) => {
          await kindNow();
          throw new Error("not reached");
        },
      },
      slack: {
        channelKind: async () => {
          throw new Error("slack unreachable");
        },
      },
      botToken: async () => "bot-credential",
      logger: { info: () => {} },
      next: async () => {},
    });
    await expect(h(conversion("channel_convert_to_public"))).rejects.toThrow(
      "slack unreachable",
    );
  });

  test("a session linked while it ran makes the inbox try the event again", async () => {
    const h = createSlackChannelConversionHandler({
      agents: resolved,
      bindings: {
        channelKindChanged: async (_place, kindNow) => {
          await kindNow();
          return {
            binding: "now_private",
            moves: [],
            keptPrivate: [],
            unchanged: [],
            skipped: [{ sessionId: "s-late", reason: "share_changed" }],
          };
        },
      },
      slack: { channelKind: async () => "private_channel" },
      botToken: async () => "bot-credential",
      logger: { info: () => {} },
      next: async () => {},
    });
    await expect(h(conversion("channel_convert_to_private"))).rejects.toThrow(
      "tried again",
    );
  });

  test("any other message goes on to the next handler", async () => {
    const h = handler();
    for (const event of [
      { type: "message", channel: "C1", user: "U0P", ts: "1.1" },
      {
        type: "message",
        subtype: "thread_broadcast",
        channel: "C1",
        ts: "1.2",
      },
      { type: "channel_rename", channel: { id: "C1", name: "x" } },
    ]) {
      await h.handle(claim(event));
    }
    expect(h.calls).toEqual([]);
    expect(h.passed).toHaveLength(3);
  });

  test("an event of another app changes nothing", async () => {
    const h = handler({
      agents: {
        resolveSlackEvent: async () => ({
          status: "dropped",
          reason: "unknown_app",
        }),
      } as never,
    });
    await h.handle(conversion("channel_convert_to_private"));
    expect(h.calls).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.passed).toEqual([]);
  });
});
