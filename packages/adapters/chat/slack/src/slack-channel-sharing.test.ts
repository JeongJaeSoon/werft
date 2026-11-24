import { describe, expect, test } from "bun:test";
import type { SlackChannelSharing } from "@werft-ai/contracts";
import type { SurfaceInboundClaim } from "@werft-ai/platform";
import type { SlackChannelQuestion } from "./slack-audience.ts";
import { createSlackChannelSharingHandler } from "./slack-channel-sharing.ts";

const claim = (event: Record<string, unknown>): SurfaceInboundClaim =>
  ({
    id: "row-1",
    eventId: "Ev1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    slackAppId: "slack-app-1",
    appId: "A0NOTES",
    teamId: "T0ACME",
    eventTime: new Date(5000),
    payload: { type: "event_callback", event },
  }) as unknown as SurfaceInboundClaim;

function handlerWith(answer: SlackChannelSharing | null) {
  const asked: SlackChannelQuestion[] = [];
  const recorded: [string, boolean, number][] = [];
  const passed: SurfaceInboundClaim[] = [];
  const handle = createSlackChannelSharingHandler({
    agents: {
      resolveSlackEvent: async () => ({
        workspaceId: "workspace-1",
        agentId: "agent-1",
        installationId: "installation-1",
        botUserId: "U0BOT",
        allowedBotUserIds: [],
        werftBotUserIds: [],
      }),
    } as never,
    audience: {
      channelSharing: async (question) => {
        asked.push(question);
        return answer;
      },
    },
    bindings: {
      recordExternalShared: async (_installation, channelId, shared, at) => {
        recorded.push([channelId, shared, at.getTime()]);
        return true;
      },
    },
    botToken: async () => "bot-token-1",
    next: async (passedOn) => {
      passed.push(passedOn);
    },
  });
  return { handle, asked, recorded, passed };
}

describe("createSlackChannelSharingHandler", () => {
  test.each(["channel_shared", "channel_unshared"])(
    "%s asks Slack again, past what is kept",
    async (type) => {
      const { handle, asked, recorded, passed } = handlerWith("internal");
      await handle(claim({ type, channel: "C0OPS", event_ts: "4.000100" }));
      expect(asked).toEqual([
        {
          agentId: "agent-1",
          channelId: "C0OPS",
          botToken: "bot-token-1",
          fresh: true,
        },
      ]);
      // The answer is recorded where it is read (createSlackAudience).
      expect(recorded).toEqual([]);
      expect(passed).toEqual([]);
    },
  );

  test("unanswered, a share is recorded as one at the event's time; an unshare waits for the next post", async () => {
    const shared = handlerWith(null);
    await shared.handle(
      claim({ type: "channel_shared", channel: "C0OPS", event_ts: "4.000100" }),
    );
    expect(shared.recorded).toEqual([["C0OPS", true, 4000]]);
    const unshared = handlerWith(null);
    await unshared.handle(
      claim({ type: "channel_unshared", channel: "C0OPS", event_ts: "4.0001" }),
    );
    expect(unshared.recorded).toEqual([]);
  });

  test("any other event goes on", async () => {
    const { handle, asked, passed } = handlerWith("external");
    const other = claim({ type: "message", channel: "C0OPS", ts: "1.0" });
    await handle(other);
    expect(passed).toEqual([other]);
    expect(asked).toEqual([]);
  });
});
