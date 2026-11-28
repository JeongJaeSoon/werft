import { describe, expect, test } from "bun:test";
import { slackOutboxDmThreadRefused } from "./slack-outbox-channel.ts";

describe("slackOutboxDmThreadRefused", () => {
  const dm = { channelId: "D0OWNER", threadTs: "" };

  test("refuses an answer, a progress message or a report at the top of a DM", () => {
    for (const kind of [
      "reply",
      "conversation_reply",
      "progress",
      "failure_notice",
      "notice",
      "input_notice",
      "action_notice",
      "model_notice",
      "instruction",
      "reaction",
      "welcome",
      "channel_notice",
    ]) {
      expect(slackOutboxDmThreadRefused({ ...dm, kind })).toBe(true);
    }
  });

  test("lets a web input's mirror and the stop line stand at the top of a DM", () => {
    expect(slackOutboxDmThreadRefused({ ...dm, kind: "input_mirror" })).toBe(
      false,
    );
    expect(
      slackOutboxDmThreadRefused({ ...dm, kind: "emergency_stop_notice" }),
    ).toBe(false);
  });

  test("takes any row in a DM thread, and leaves channels alone", () => {
    expect(
      slackOutboxDmThreadRefused({
        ...dm,
        threadTs: "100.000100",
        kind: "reply",
      }),
    ).toBe(false);
    for (const channelId of ["C0OPS", "G0PRIVATE"]) {
      expect(
        slackOutboxDmThreadRefused({ channelId, threadTs: "", kind: "reply" }),
      ).toBe(false);
    }
  });
});
