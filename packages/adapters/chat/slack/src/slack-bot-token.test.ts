import { describe, expect, test } from "bun:test";
import { SessionServiceError, type SlackAppRecord } from "@werft-ai/platform";
import { createSlackChannelKinds } from "./slack-bot-token.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";

const WORKSPACE = "019a0000-0000-7000-8000-000000000001";
const AGENT = "019a0000-0000-7000-8000-000000000002";

async function codeOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  return "ok";
}

describe("channel kinds through the agent's own app", () => {
  const slackApp = { id: "slack-app-1" };
  const api = (channelKind: SlackBotApi["channelKind"]): SlackBotApi => ({
    channelKind,
    channelMembership: async () => {
      throw new Error("not asked");
    },
    joinChannel: async () => {
      throw new Error("not asked");
    },
    userInfo: async () => {
      throw new Error("not asked");
    },
    setStatus: async () => {},
    permalink: async () => {
      throw new Error("not asked");
    },
    listChannels: async () => {
      throw new Error("not asked");
    },
  });
  const kinds = (
    slack: SlackBotApi,
    token: string | null = "bot-credential",
    apps = true,
  ) =>
    createSlackChannelKinds({
      apps: apps
        ? { findForAgent: async () => slackApp as SlackAppRecord }
        : null,
      secrets: { get: async () => token },
      slack,
    });

  test("asks conversations.info with the app's bot token", async () => {
    const seen: string[] = [];
    const answer = await kinds(
      api(async (token, channelId) => {
        seen.push(`${token}:${channelId}`);
        return "public_channel";
      }),
    ).kindOf(WORKSPACE, AGENT, "C0OPS");
    expect(answer).toBe("public_channel");
    expect(seen).toEqual(["bot-credential:C0OPS"]);
  });

  test("no master key, app or token is not installed; Slack's refusal or absence has its own code", async () => {
    const fine = api(async () => "public_channel");
    for (const [slack, token, apps, code] of [
      [fine, "bot-credential", false, "SLACK_NOT_INSTALLED"],
      [fine, null, true, "SLACK_NOT_INSTALLED"],
      [
        api(async () => {
          throw new SlackApiError("conversations.info", "missing_scope", true);
        }),
        "bot-credential",
        true,
        "BAD_REQUEST",
      ],
      [
        api(async () => {
          throw new SlackApiError("conversations.info", "fetch_failed", false);
        }),
        "bot-credential",
        true,
        "BACKEND_UNAVAILABLE",
      ],
    ] as const) {
      expect(
        await codeOf(kinds(slack, token, apps).kindOf(WORKSPACE, AGENT, "C0")),
      ).toBe(code);
    }
  });

  test("a channel hidden from the bot is a private one waiting for the invite; a hidden DM is refused", async () => {
    const hidden = api(async () => {
      throw new SlackApiError("conversations.info", "channel_not_found", true);
    });
    const channelKinds = kinds(hidden, "bot-credential", true);
    expect(await channelKinds.kindOf(WORKSPACE, AGENT, "G0SECRET")).toBe(
      "private_channel",
    );
    expect(
      await codeOf(channelKinds.kindOf(WORKSPACE, AGENT, "D0SOMEONE")),
    ).toBe("BAD_REQUEST");
  });
});
