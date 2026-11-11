import { describe, expect, test } from "bun:test";
import { createLoggingSlackNoticeSink } from "./slack-notice-log.ts";
import type { SlackNoticeRecord } from "./slack-notice-sink.ts";

const notice = (slackUserId: string): SlackNoticeRecord => ({
  workspaceId: "ws-1",
  agentId: "agent-1",
  installationId: "installation-1",
  slackAppId: "slack-app-1",
  teamId: "T0ACME",
  channelId: "C0OPS",
  threadTs: "100.000100",
  slackUserId,
  reason: "unlinked",
  notice: {
    message: "connect",
    link_url: "https://console.example/settings/linked-accounts",
  },
  onceKey: `installation-1:C0OPS:100.000100:${slackUserId}`,
});

describe("Slack notices before 94S-792 sends them", () => {
  test("the log sink writes one line per notice, without its text or link", async () => {
    const lines: { message: string; fields: object | undefined }[] = [];
    const sink = createLoggingSlackNoticeSink({
      info: (message, fields) => lines.push({ message, fields }),
      warn: () => {},
    });
    await sink.record(notice("U0A"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      channel_id: "C0OPS",
      thread_ts: "100.000100",
      slack_user_id: "U0A",
      reason: "unlinked",
    });
    const written = JSON.stringify(lines);
    expect(written).not.toContain("connect");
    expect(written).not.toContain("console.example");
  });
});
