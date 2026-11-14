import { describe, expect, test } from "bun:test";
import { sessionActivitySchema } from "./session.ts";

const SINCE = "2026-10-25T01:18:00.000Z";
const WAITING = {
  last: { kind: "text", text: "git push 전에 승인을 기다리는 중" },
  tool_count: 41,
  error_count: 1,
  subagent_count: 1,
  current_tool: {
    id: "toolu_push",
    name: "Bash",
    target: "git push origin fix/webhook-retry",
    state: "waiting",
    since: SINCE,
    request: { kind: "permission", prompt: null },
  },
  window: { events: 120, complete: true, since: SINCE },
};

describe("session activity", () => {
  test("a request is only for a waiting call, and a prompt is never empty", () => {
    const parse = (current: Record<string, unknown>) =>
      sessionActivitySchema.safeParse({
        ...WAITING,
        current_tool: { ...WAITING.current_tool, ...current },
      }).success;
    expect(parse({})).toBe(true);
    expect(parse({ request: { kind: "question", prompt: "" } })).toBe(false);
    expect(parse({ request: { kind: "other", prompt: null } })).toBe(false);
    expect(parse({ state: "interrupted" })).toBe(false);
  });
});
