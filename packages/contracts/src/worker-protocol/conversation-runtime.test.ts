import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_DECISION_TOOL_NAMES,
  conversationDecisionTools,
} from "./conversation-runtime.ts";

describe("conversation decision tools by requester (G2)", () => {
  test("a person and the operator's test turn get all four; an agent, and a kind not known, reply and no_reply alone", () => {
    const all = ["reply", "route_to_task", "spawn_task", "no_reply"] as const;
    for (const kind of ["user", "slack_user", "operator"]) {
      expect([...conversationDecisionTools(kind)]).toEqual([...all]);
    }
    for (const kind of ["slack_bot", "agent", "api_key", "", "toString"]) {
      expect([...conversationDecisionTools(kind)]).toEqual([
        "reply",
        "no_reply",
      ]);
    }
    // A DM's turn opens no task, whoever asks.
    expect([...conversationDecisionTools("user", "dm")]).toEqual([
      "reply",
      "route_to_task",
      "no_reply",
    ]);
    expect([...conversationDecisionTools("slack_bot", "dm")]).toEqual([
      "reply",
      "no_reply",
    ]);
    expect(CONVERSATION_DECISION_TOOL_NAMES).toEqual(
      all.map((tool) => `mcp__conversation__${tool}`),
    );
  });
});
