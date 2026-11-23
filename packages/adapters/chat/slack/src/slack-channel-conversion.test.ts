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
    teamId: "T1",
    eventType: String(event.type),
    eventTime: null,
    payload: { event },
  }) as unknown as SlackInboundClaim;

function handler(agents = resolved) {
  const calls: [ChannelSessionPlace, ChannelKindNow][] = [];
  const passed: unknown[] = [];
  const handle = createSlackChannelConversionHandler({
    agents,
    bindings: {
      channelKindChanged: async (place, kind): Promise<ChannelKindChanged> => {
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
    logger: { info: () => {} },
    next: async (claim) => {
      passed.push((claim.payload as { event: unknown }).event);
    },
  });
  return { handle, calls, passed };
}

const place = (channelId: string) => ({
  workspaceId: WORKSPACE,
  agentId: AGENT,
  installationId: INSTALLATION,
  teamId: "T1",
  channelId,
});

describe("channel conversion handler", () => {
  test.each([
    ["channel_convert_to_private", "private_channel"],
    ["channel_convert_to_public", "public_channel"],
  ] as const)(
    "%s moves the channel's binding and sessions to %s and stops there",
    async (subtype, kind) => {
      const h = handler();
      await h.handle(
        claim({
          type: "message",
          subtype,
          channel: "C1",
          user: "U0P",
          ts: "1.1",
        }),
      );
      expect(h.calls).toEqual([[place("C1"), kind]]);
      expect(h.passed).toEqual([]);
    },
  );

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
      resolveSlackEvent: async () => ({
        status: "dropped",
        reason: "unknown_app",
      }),
    } as never);
    await h.handle(
      claim({
        type: "message",
        subtype: "channel_convert_to_private",
        channel: "C1",
        ts: "1.1",
      }),
    );
    expect(h.calls).toEqual([]);
    expect(h.passed).toEqual([]);
  });
});
