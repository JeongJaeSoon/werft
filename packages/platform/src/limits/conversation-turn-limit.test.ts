import { describe, expect, test } from "bun:test";
import type { ConversationTurnResult } from "@werft-ai/contracts";
import { conversationTurnLimitReached } from "./conversation-calls.ts";

const done: ConversationTurnResult = { outcome: "completed", text: "answer" };

describe("the limit a conversation turn ended on", () => {
  test("is the server's when it refused a call past the count or the lease ran out, the runner's by its report otherwise", () => {
    expect(
      conversationTurnLimitReached(
        { outcome: "failed", reason: "engine_failed" },
        "turn_limit",
      ),
    ).toEqual({ limit: "model_call_limit", by: "server" });
    // The server's refusal wins over the runner's own word for it.
    expect(
      conversationTurnLimitReached(
        { outcome: "failed", reason: "model_call_limit" },
        "turn_limit",
      ),
    ).toEqual({ limit: "model_call_limit", by: "server" });
    expect(
      conversationTurnLimitReached(
        { outcome: "failed", reason: "lease_expired" },
        null,
      ),
    ).toEqual({ limit: "time_limit", by: "server" });
    for (const limit of [
      "model_call_limit",
      "tool_call_limit",
      "time_limit",
    ] as const) {
      expect(
        conversationTurnLimitReached(
          { outcome: "failed", reason: limit },
          null,
        ),
      ).toEqual({ limit, by: "runner" });
    }
    for (const reason of [
      "engine_failed",
      "runtime_failed",
      "interrupted",
      "not_taken",
    ] as const) {
      expect(
        conversationTurnLimitReached({ outcome: "failed", reason }, "budget"),
      ).toBeNull();
    }
    expect(conversationTurnLimitReached(done, null)).toBeNull();
    expect(conversationTurnLimitReached(null, null)).toBeNull();
  });
});
