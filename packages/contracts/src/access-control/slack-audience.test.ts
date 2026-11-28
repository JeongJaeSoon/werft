import { describe, expect, test } from "bun:test";
import {
  slackChannelSharingOf,
  slackUnheardReasonOf,
} from "./slack-audience.ts";

describe("slackChannelSharingOf", () => {
  test.each([
    [{ is_ext_shared: true }, "external"],
    // Shared among one Enterprise's workspaces: Slack sets is_org_shared only.
    [{ is_ext_shared: false }, "internal"],
    [{}, "external"],
  ] as const)("%o is %s", (channel, sharing) => {
    expect(slackChannelSharingOf(channel)).toBe(sharing);
  });
});

describe("slackUnheardReasonOf", () => {
  test.each([
    ["internal", "member", null],
    ["external", "member", "external_shared_channel"],
    ["external", null, "external_shared_channel"],
    ["internal", "guest", "guest_author"],
    ["internal", "external", "external_author"],
    [null, "member", "audience_unconfirmed"],
    ["internal", null, "audience_unconfirmed"],
  ] as const)("channel %s, author %s: %s", (sharing, author, reason) => {
    expect(slackUnheardReasonOf({ sharing, author })).toBe(reason);
  });
});
