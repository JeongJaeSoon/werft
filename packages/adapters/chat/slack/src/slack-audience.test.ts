import { describe, expect, test } from "bun:test";
import type { SlackChannelSharing, SlackUser } from "@werft-ai/contracts";
import { createSlackAudience } from "./slack-audience.ts";
import { SlackApiError } from "./slack-config-api.ts";

const TEAM = "T0ACME";
const question = {
  installationId: "installation-1",
  teamId: TEAM,
  channelId: "C0OPS",
  slackUserId: "U0PERSON",
  botToken: "bot-token-1",
};

function audienceWith(
  sharing: () => Promise<SlackChannelSharing>,
  user: () => Promise<Partial<SlackUser>> = async () => ({}),
) {
  let clock = 0;
  const calls: string[] = [];
  const recorded: [string, boolean, number][] = [];
  const audience = createSlackAudience({
    slack: {
      channelSharing: async (_token, channelId) => {
        calls.push(`conversations.info ${channelId}`);
        return sharing();
      },
      userInfo: async (_token, userId) => {
        calls.push(`users.info ${userId}`);
        return { id: userId, team_id: TEAM, ...(await user()) };
      },
    },
    bindings: {
      recordExternalShared: async (_installation, channelId, shared, at) => {
        recorded.push([channelId, shared, at.getTime()]);
        return true;
      },
    },
    logger: { warn: () => {} },
    ttlMs: 1000,
    now: () => clock,
  });
  return {
    audience,
    calls,
    recorded,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createSlackAudience", () => {
  test("a channel shared with another organization is not heard; its author is not asked", async () => {
    const { audience, calls, recorded } = audienceWith(async () => "external");
    expect(await audience.unheardReason(question)).toBe(
      "external_shared_channel",
    );
    expect(calls).toEqual(["conversations.info C0OPS"]);
    expect(recorded).toEqual([["C0OPS", true, 0]]);
  });

  test.each([
    [{}, null],
    [{ is_restricted: true }, "guest_author"],
    [{ is_ultra_restricted: true }, "guest_author"],
    [{ team_id: "T0PARTNER" }, "external_author"],
  ] as const)(
    "in an unshared channel, an author %o: %s",
    async (user, reason) => {
      const { audience, recorded } = audienceWith(
        async () => "internal",
        async () => user,
      );
      expect(await audience.unheardReason(question)).toBe(reason);
      expect(recorded).toEqual([["C0OPS", false, 0]]);
    },
  );

  test("answers are kept for the cache time, then asked again; a kept answer is not recorded again", async () => {
    const { audience, calls, recorded, tick } = audienceWith(
      async () => "internal",
    );
    await audience.unheardReason(question);
    tick(999);
    await audience.unheardReason(question);
    expect(calls).toHaveLength(2);
    tick(1);
    await audience.unheardReason(question);
    expect(calls).toEqual([
      "conversations.info C0OPS",
      "users.info U0PERSON",
      "conversations.info C0OPS",
      "users.info U0PERSON",
    ]);
    expect(recorded.map(([, , at]) => at)).toEqual([0, 1000]);
  });

  test("a fresh question asks Slack whatever is kept", async () => {
    let sharing: SlackChannelSharing = "internal";
    const { audience, recorded } = audienceWith(async () => sharing);
    await audience.channelSharing(question);
    sharing = "external";
    expect(await audience.channelSharing(question)).toBe("internal");
    expect(await audience.channelSharing({ ...question, fresh: true })).toBe(
      "external",
    );
    expect(recorded.map(([, shared]) => shared)).toEqual([false, true]);
  });

  test("Slack not answering, or no bot token, is unconfirmed and keeps nothing", async () => {
    let fail = true;
    const { audience, calls, recorded } = audienceWith(async () => {
      if (fail) throw new SlackApiError("conversations.info", "timeout", false);
      return "internal";
    });
    expect(await audience.unheardReason(question)).toBe("audience_unconfirmed");
    expect(await audience.unheardReason({ ...question, botToken: null })).toBe(
      "audience_unconfirmed",
    );
    fail = false;
    expect(await audience.unheardReason(question)).toBeNull();
    expect(
      calls.filter((call) => call.startsWith("conversations")),
    ).toHaveLength(2);
    expect(recorded).toEqual([["C0OPS", false, 0]]);

    const guestUnknown = audienceWith(
      async () => "internal",
      async () => {
        throw new SlackApiError("users.info", "ratelimited", true);
      },
    );
    expect(await guestUnknown.audience.unheardReason(question)).toBe(
      "audience_unconfirmed",
    );
  });
});
