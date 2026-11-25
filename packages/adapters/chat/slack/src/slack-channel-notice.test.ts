import { describe, expect, test } from "bun:test";
import { slackNoticeVersionSchema } from "@werft-ai/contracts";
import type { SurfaceOutboxEntry } from "@werft-ai/platform";
import {
  enqueueSlackChannelNotices,
  SLACK_CHANNEL_NOTICE_LINES,
  slackChannelNoticeDedupeKey,
  slackChannelNoticeText,
} from "./slack-channel-notice.ts";
import { slackOutboxText } from "./slack-outbox-render.ts";

const TARGET = {
  workspaceId: "019a0000-0000-7000-8000-0000000000f1",
  agentId: "019A0000-0000-7000-8000-0000000000A1",
  slackAppId: "019a0000-0000-7000-8000-0000000000d1",
  installationId: "019a0000-0000-7000-8000-0000000000c1",
  teamId: "T0ACME",
  channelId: "C0GENERAL",
  noticeVersion: slackNoticeVersionSchema.parse(3),
};

describe("channel notice", () => {
  test("one Korean line, then one Japanese line, that notifies no one", () => {
    const text = slackChannelNoticeText();
    expect(text.split("\n")).toEqual([...SLACK_CHANNEL_NOTICE_LINES]);
    expect(SLACK_CHANNEL_NOTICE_LINES[0]).toMatch(/[가-힣]/);
    expect(SLACK_CHANNEL_NOTICE_LINES[1]).toMatch(/[ぁ-んァ-ン]/);
    const sent = slackOutboxText({ text });
    for (const words of [text, sent]) {
      expect(words).not.toMatch(/@(channel|here|everyone)|<!/);
    }
  });

  test("enqueues one row per channel found, keyed by agent, team, channel and version", async () => {
    const rows: SurfaceOutboxEntry[] = [];
    const limits: number[] = [];
    const found = await enqueueSlackChannelNotices({
      outbox: {
        unnoticedChannels: async (limit) => {
          limits.push(limit);
          return [TARGET];
        },
        enqueue: async (entry) => {
          rows.push(entry);
          return "enqueued";
        },
      },
      limit: 7,
    });
    expect(found).toBe(1);
    expect(limits).toEqual([7]);
    expect(rows).toEqual([
      {
        workspaceId: TARGET.workspaceId,
        agentId: TARGET.agentId.toLowerCase(),
        slackAppId: TARGET.slackAppId,
        installationId: TARGET.installationId,
        kind: "channel_notice",
        channelId: "C0GENERAL",
        threadTs: "",
        slackUserId: null,
        sessionId: null,
        sessionLinkId: null,
        body: { text: slackChannelNoticeText() },
        dedupeKey:
          "channel-notice:019a0000-0000-7000-8000-0000000000a1:T0ACME:C0GENERAL:3",
      },
    ]);
    expect(slackChannelNoticeDedupeKey(TARGET)).toBe(rows[0]?.dedupeKey ?? "");
  });

  test("a store without the sweep enqueues nothing", async () => {
    expect(
      await enqueueSlackChannelNotices({
        outbox: {
          enqueue: async () => {
            throw new Error("not reached");
          },
        },
        limit: 5,
      }),
    ).toBe(0);
  });
});
