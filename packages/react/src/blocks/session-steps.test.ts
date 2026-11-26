import { describe, expect, test } from "bun:test";
import type {
  PendingRequest,
  SessionEventPayload,
  TurnSummary,
} from "@werft-ai/contracts";
import { TURN_WORKER_OWNERSHIP_LOST_REASON } from "@werft-ai/contracts";
import type { SessionEventFrame } from "../sessions.ts";
import { readSessionSteps, sessionTime } from "./session-steps.ts";

const AT = "2026-11-26T01:00:00.000Z";

function turn(
  turn_id: string,
  status: TurnSummary["status"],
  extra: Partial<TurnSummary> = {},
): TurnSummary {
  return {
    turn_id,
    session_id: "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
    status,
    message: `instruction ${turn_id}`,
    channel: "web",
    created_by: null,
    requester: null,
    slack_permalink: null,
    source_deleted_at: null,
    terminal_reason: null,
    prepended_turn_id: null,
    checkpoint_revision: null,
    created_at: AT,
    started_at: AT,
    ended_at: null,
    ...extra,
  };
}

function permission(turn_id: string, request_id: string): PendingRequest {
  return {
    kind: "permission",
    request_id,
    turn_id,
    attempt_id: "att_1",
    created_at: AT,
    expires_at: AT,
    tool: "Bash",
    input: {},
  };
}

function question(turn_id: string): PendingRequest {
  return {
    kind: "question",
    request_id: `q_${turn_id}`,
    turn_id,
    attempt_id: "att_1",
    created_at: AT,
    expires_at: AT,
    questions: [
      {
        question_id: "q1",
        prompt: "Which?",
        options: [],
        multi_select: false,
        allow_free_text: true,
      },
    ],
  };
}

function call(id: string, turnId: string, callId: string): SessionEventFrame {
  return {
    id,
    occurredAt: AT,
    turnId,
    attemptId: null,
    payload: {
      event: "tool_use",
      data: {
        type: "assistant",
        tool_call: { id: callId, name: "Bash", input: {} },
      },
    } as SessionEventPayload,
  };
}

const read = (
  overrides: Partial<Parameters<typeof readSessionSteps>[0]> = {},
) =>
  readSessionSteps({
    session: { current_turn_id: null, status: "idle" },
    turns: [],
    requests: [],
    events: [],
    windowFull: false,
    ...overrides,
  });

describe("readSessionSteps", () => {
  test("numbers every turn and focuses the one the session runs", () => {
    const steps = read({
      session: { current_turn_id: "2", status: "running" },
      turns: [
        turn("1", "completed", { ended_at: AT }),
        turn("2", "running"),
        turn("3", "queued", { started_at: null }),
      ],
    });
    expect(steps.steps.map((step) => [step.number, step.state])).toEqual([
      [1, "done"],
      [2, "running"],
      [3, "queued"],
    ]);
    expect(steps.focus).toBe(1);
    expect(steps.current).toBe(true);
  });

  test("a turn holding a permission request waits on approval, a question on an answer", () => {
    const steps = read({
      session: { current_turn_id: "2", status: "needs_input" },
      turns: [turn("1", "needs_input"), turn("2", "needs_input")],
      requests: [question("1"), question("2"), permission("2", "req_2")],
    });
    expect(steps.steps.map((step) => step.state)).toEqual([
      "answer",
      "approval",
    ]);
    expect(steps.steps[1]?.requests.map((r) => r.request_id)).toEqual([
      "q_2",
      "req_2",
    ]);
  });

  test("with no running turn, the one holding requests is focused but not current", () => {
    const steps = read({
      session: { current_turn_id: null, status: "needs_input" },
      turns: [turn("1", "completed", { ended_at: AT }), turn("2", "running")],
      requests: [permission("2", "req_2")],
    });
    expect(steps.focus).toBe(1);
    expect(steps.current).toBe(false);
  });

  test("an idle session's last turn a lost worker cut off is focused", () => {
    const steps = read({
      turns: [
        turn("1", "completed", { ended_at: AT }),
        turn("2", "failed", {
          ended_at: AT,
          terminal_reason: TURN_WORKER_OWNERSHIP_LOST_REASON,
        }),
      ],
    });
    expect(steps.steps[1]?.state).toBe("cut_off");
    expect(steps.focus).toBe(1);
    expect(steps.current).toBe(false);
  });

  test("a session resting on finished work focuses nothing", () => {
    const steps = read({
      turns: [
        turn("1", "completed", { ended_at: AT }),
        turn("2", "failed", { ended_at: AT, terminal_reason: "error" }),
        turn("3", "interrupted", { ended_at: AT }),
        turn("4", "outcome_unknown", { ended_at: AT }),
      ],
    });
    expect(steps.steps.map((step) => step.state)).toEqual([
      "done",
      "failed",
      "stopped",
      "unknown",
    ]);
    expect(steps.focus).toBeNull();
  });

  test("counts each turn's distinct tool calls, and says when the window may have cut them", () => {
    const events = [
      call("e1", "1", "c1"),
      call("e2", "1", "c1"),
      call("e3", "1", "c2"),
      call("e4", "2", "c3"),
    ];
    const steps = read({
      session: { current_turn_id: "2", status: "running" },
      turns: [turn("1", "completed", { ended_at: AT }), turn("2", "running")],
      events,
      windowFull: true,
    });
    expect(
      steps.steps.map((step) => [step.toolCalls, step.toolCallsPartial]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
  });
});

describe("sessionTime", () => {
  test("adds the running turn's time so far to the finished turns'", () => {
    const steps = read({
      session: { current_turn_id: "1", status: "running" },
      turns: [turn("1", "running")],
    });
    const now = Date.parse(AT) + 5 * 60_000;
    expect(sessionTime({ turn_time_ms: 60_000 }, steps, now)).toBe(6 * 60_000);
  });

  test("counts only the finished turns when none runs", () => {
    expect(sessionTime({ turn_time_ms: 60_000 }, read(), Date.now())).toBe(
      60_000,
    );
  });
});
