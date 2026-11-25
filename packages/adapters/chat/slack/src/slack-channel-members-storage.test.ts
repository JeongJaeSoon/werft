import { describe, expect, test } from "bun:test";
import type { ChannelMemberStore } from "@werft-ai/platform";
import { createSlackChannelMembers } from "./slack-channel-members.ts";

const question = {
  workspaceId: "019a0000-0000-7000-8000-0000000000f1",
  agentId: "019a0000-0000-7000-8000-0000000000c1",
  channelId: "C0SECRET",
  userId: "019a0000-0000-7000-8000-0000000000a1",
};

function members(
  store: Partial<ChannelMemberStore>,
  storageUnavailable?: (error: unknown) => boolean,
) {
  return createSlackChannelMembers({
    store: store as ChannelMemberStore,
    slack: {
      channelMembers: async () => {
        throw new Error("Slack is not asked here");
      },
    } as never,
    botToken: async () => null,
    logger: { warn: () => {} },
    ...(storageUnavailable === undefined ? {} : { storageUnavailable }),
  });
}

describe("a member check whose own store cannot be read", () => {
  const down = new Error("connection terminated");
  const isDown = (error: unknown) => error === down;
  const failing: [string, Partial<ChannelMemberStore>][] = [
    [
      "the Slack link",
      {
        subject: async () => {
          throw down;
        },
      },
    ],
    [
      "the kept list",
      {
        subject: async () => ({
          installationId: "019a0000-0000-7000-8000-0000000000e1",
          slackUserId: "U0MEMBER",
        }),
        cached: async () => {
          throw down;
        },
      },
    ],
  ];

  for (const [name, store] of failing) {
    test(`${name}: rethrown when told it is the store's, so the policy answers undecided`, async () => {
      await expect(members(store, isDown).membership(question)).rejects.toBe(
        down,
      );
      await expect(members(store, isDown).isMember(question)).rejects.toBe(
        down,
      );
    });

    test(`${name}: unconfirmed, as before, without a classifier`, async () => {
      expect(await members(store).membership(question)).toBe("unconfirmed");
    });
  }
});
