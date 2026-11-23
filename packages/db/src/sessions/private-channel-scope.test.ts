import { describe, expect, test } from "bun:test";
import {
  type ChannelSessionRow,
  planChannelScope,
} from "./private-channel-scope.ts";

const CONVERSATION = "019a0000-0000-7000-8000-00000000c0c0";
const row = (
  sessionId: string,
  scope: ChannelSessionRow["scope"],
  more: Partial<ChannelSessionRow> = {},
): ChannelSessionRow => ({
  sessionId,
  ownerId: "019a0000-0000-7000-8000-0000000000f1",
  workspaceId: "019a0000-0000-7000-8000-0000000000f1",
  scope,
  parentConversationId: CONVERSATION,
  keyTurns: 0,
  ...more,
});
const channel = { usable: true, conversationId: CONVERSATION };

describe("planChannelScope", () => {
  test("a private channel's workspace, people and team sessions move to private_channel; private stays", () => {
    const plan = planChannelScope(
      [
        row("s-workspace", "workspace"),
        row("s-people", "people"),
        row("s-team", "team"),
        row("s-private", "private"),
        row("s-moved", "private_channel"),
      ],
      "private_channel",
      channel,
    );
    expect(plan.moves).toEqual([
      { sessionId: "s-workspace", from: "workspace", to: "private_channel" },
      { sessionId: "s-people", from: "people", to: "private_channel" },
      { sessionId: "s-team", from: "team", to: "private_channel" },
    ]);
    expect(plan.keptPrivate).toEqual(["s-private"]);
    expect(plan.unchanged).toEqual(["s-moved"]);
    expect(plan.skipped).toEqual([]);
  });

  test("an empty parent moves (it is filled first); another conversation or no channel is skipped", () => {
    expect(
      planChannelScope(
        [
          row("s-empty", "workspace", { parentConversationId: null }),
          row("s-other", "workspace", {
            parentConversationId: "019a0000-0000-7000-8000-00000000dddd",
          }),
          row("s-legacy", "workspace", { workspaceId: null }),
        ],
        "private_channel",
        channel,
      ),
    ).toEqual({
      moves: [
        { sessionId: "s-empty", from: "workspace", to: "private_channel" },
      ],
      keptPrivate: [],
      unchanged: [],
      skipped: [
        { sessionId: "s-other", reason: "no_channel_conversation" },
        { sessionId: "s-legacy", reason: "no_workspace" },
      ],
    });
    expect(
      planChannelScope(
        [row("s-empty", "workspace", { parentConversationId: null })],
        "private_channel",
        { usable: false, conversationId: null },
      ).skipped,
    ).toEqual([{ sessionId: "s-empty", reason: "no_channel_conversation" }]);
  });

  test("a public channel's private_channel sessions go back to workspace; the rest stay", () => {
    const plan = planChannelScope(
      [
        row("s-moved", "private_channel"),
        row("s-private", "private"),
        row("s-people", "people"),
      ],
      "public_channel",
      channel,
    );
    expect(plan.moves).toEqual([
      { sessionId: "s-moved", from: "private_channel", to: "workspace" },
    ]);
    expect(plan.unchanged).toEqual(["s-private", "s-people"]);
  });

  test("going public widens only the channel's own sessions: another channel's parent or no conversation is skipped", () => {
    // Before, both were moved to workspace whatever their parent was.
    const rows = [
      row("s-other", "private_channel", {
        parentConversationId: "019a0000-0000-7000-8000-00000000dddd",
      }),
      row("s-orphan", "private_channel", { parentConversationId: null }),
    ];
    const plan = planChannelScope(rows, "public_channel", channel);
    expect(plan.moves).toEqual([]);
    expect(plan.skipped).toEqual([
      { sessionId: "s-other", reason: "no_channel_conversation" },
      { sessionId: "s-orphan", reason: "no_channel_conversation" },
    ]);
    expect(
      planChannelScope(rows.slice(0, 1), "public_channel", {
        usable: true,
        conversationId: null,
      }).skipped,
    ).toEqual([{ sessionId: "s-other", reason: "no_channel_conversation" }]);
  });
});
