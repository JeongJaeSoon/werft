import { describe, expect, test } from "bun:test";

import * as contracts from "../index.ts";
import {
  SESSION_EVENT_NAMES,
  type SessionEventName,
  STATUS_EVENT_PHASE_VALUES,
  sseEventSchema,
} from "./event.ts";
import {
  presentTurnEvent,
  type TurnEventPresentation,
} from "./present-turn-event.ts";

const AT = "2026-10-21T02:54:00.000Z";

// One readable payload per event name; status gets one per phase below.
const PAYLOADS: Record<SessionEventName, unknown[]> = {
  system: [
    { type: "system", engine_event: { name: "init", category: "started" } },
    {
      type: "system",
      engine_event: { name: "vcs_state_changed", category: "workspace" },
    },
    {
      type: "system",
      engine_event: { name: "compact_boundary", category: "other" },
    },
    {
      type: "system",
      engine_event: { name: "thinking_tokens", category: "thinking" },
    },
    {
      type: "system",
      engine_event: { name: "command_lifecycle", category: "internal" },
    },
    { type: "system" },
    // The platform's own: named by their subtype, never folded.
    { type: "system", subtype: "context_gap_detected" },
    { type: "system", subtype: "thinking_tokens" },
  ],
  assistant: [
    { type: "assistant", text: "Listing files" },
    { type: "assistant", text: "x".repeat(300) },
    { type: "assistant", thinking: "Read it first." },
    { type: "assistant", thinking: "" },
    { type: "assistant" },
    // The engine's own message is never read.
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "not shown" }] },
    },
  ],
  tool_use: [
    {
      type: "assistant",
      tool_call: {
        id: "tu_1",
        name: "Bash",
        input: { command: "rm -rf build", description: "Clean" },
      },
    },
    {
      type: "assistant",
      tool_call: {
        id: "tu_2",
        name: "Bash",
        input: { command: `echo ${"x".repeat(200)}\nsecond` },
      },
    },
    {
      type: "assistant",
      tool_call: { id: "tu_3", name: "TodoWrite", input: {} },
    },
  ],
  tool_result: [
    { tool_result: { tool_call_id: "tu_1", is_error: false, text: "a.txt" } },
    {
      tool_result: {
        tool_call_id: "tu_1",
        is_error: true,
        text: "make: *** No rule\nline 2\nline 3",
      },
    },
    { tool_result: { tool_call_id: "tu_1", is_error: null, text: "" } },
    "plain text result",
  ],
  question: [
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "permission",
      tool: "Edit",
      input: { file_path: "/repo/a.ts" },
    },
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "question",
      tool: "AskUserQuestion",
      input: { questions: [{ question: "Which branch?" }, { question: "?" }] },
    },
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "question",
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question_id: "q_1",
            prompt: "Deploy where first?",
            options: [{ option_id: "o_1", label: "Staging" }],
            multi_select: false,
            allow_free_text: false,
          },
        ],
      },
    },
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "question",
      input: { path: "/repo" },
    },
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "question",
      input: {},
    },
  ],
  result: [
    {
      type: "result",
      subtype: "success",
      turn: {
        outcome: "success",
        is_error: false,
        terminal_reason: "completed",
        tokens: 150,
      },
    },
    {
      type: "result",
      subtype: "error_max_turns",
      turn: {
        outcome: "error_max_turns",
        is_error: true,
        terminal_reason: null,
        tokens: null,
      },
    },
  ],
  status: STATUS_EVENT_PHASE_VALUES.map((phase) => ({ phase })),
  error: [{ message: "engine crashed", code: "ENGINE" }],
};

// Every fixture is a frame the public SSE contract accepts, unwrapped the way
// a reader holds it.
const FIXTURES = SESSION_EVENT_NAMES.flatMap((name) =>
  PAYLOADS[name].map((data, index) => {
    const frame = sseEventSchema.parse({
      id: `${name}_${index}`,
      event: name,
      data: {
        schema_version: 1,
        session_id: "6f1c2b5e-8a4d-4c3f-9e2a-1b7d5c9e0a42",
        turn_id: "turn_1",
        attempt_id: null,
        occurred_at: AT,
        data,
      },
    });
    return { id: frame.id, event: frame.event, data: frame.data.data };
  }),
);

describe("presentTurnEvent", () => {
  test("is exported from the package", () => {
    expect(contracts.presentTurnEvent).toBe(presentTurnEvent);
  });

  test("every event name × status phase gets a label", () => {
    for (const name of SESSION_EVENT_NAMES) {
      expect(FIXTURES.some((fixture) => fixture.event === name)).toBe(true);
      for (const phase of STATUS_EVENT_PHASE_VALUES) {
        const presented = presentTurnEvent({ event: name, data: { phase } });
        expect(presented.label.key).toBeString();
        expect(presented.label.key).not.toBe("");
      }
    }
    for (const phase of STATUS_EVENT_PHASE_VALUES) {
      const presented = presentTurnEvent({ event: "status", data: { phase } });
      expect(presented.label).toEqual({ key: "session.event.kind.status" });
      expect(presented.summary).toEqual([
        {
          key:
            phase === "interrupting" || phase === "engine_stopped"
              ? `session.event.phase.${phase}`
              : `sessions.status.${phase}`,
        },
      ]);
    }
  });

  test("a question says what it asks, in the worker's shape and the SDK's", () => {
    const asked = FIXTURES.filter(
      (fixture) =>
        fixture.event === "question" &&
        (fixture.data as { tool?: string }).tool === "AskUserQuestion",
    ).map((fixture) => presentTurnEvent(fixture).summary);
    expect(asked).toEqual([
      [{ text: "Which branch? / ?" }],
      [{ text: "Deploy where first?" }],
    ]);
  });

  test("an event it cannot read gets the generic label and does not throw", () => {
    const generic: TurnEventPresentation = {
      label: { key: "sessions.status.running" },
      summary: [],
    };
    const unreadable: { event: string; data?: unknown }[] = [
      { event: "heartbeat", data: {} },
      { event: "", data: null },
      { event: "status" },
      { event: "status", data: { phase: "warming_up" } },
      { event: "status", data: { phase: 3 } },
      { event: "status", data: [] },
      { event: "error", data: { message: { nested: true } } },
      { event: "result", data: { type: "result" } },
      { event: "assistant", data: "text" },
      { event: "question", data: 42 },
      { event: "system", data: null },
    ];
    for (const event of unreadable) {
      expect(presentTurnEvent(event)).toEqual(generic);
    }
    const throwing = [
      null,
      {
        event: "status",
        get data(): unknown {
          throw new Error("getter");
        },
      },
      JSON.parse('{"event":"system","data":{"subtype":{"toString":null}}}'),
    ];
    for (const event of throwing) {
      expect(presentTurnEvent(event)).toEqual(generic);
    }
    const hostile = {
      event: "assistant",
      data: { text: { toString: null }, tool_call: [], thinking: 1 },
    };
    expect(() => presentTurnEvent(hostile)).not.toThrow();
  });

  test("a reply keeps its whole Markdown in reply while summary stays clipped", () => {
    const long = `**bold** ${"x".repeat(300)}\n\n- item`;
    const presented = presentTurnEvent({
      event: "assistant",
      data: { type: "assistant", text: `  ${long}  ` },
    });
    expect(presented.reply).toBe(long);
    expect(presented.summary).toEqual([{ text: `${long.slice(0, 200)}…` }]);
    for (const quiet of [
      { type: "assistant", thinking: "Read it first." },
      { type: "assistant", tool_call: { id: "c1", name: "Bash", input: {} } },
    ]) {
      expect(
        presentTurnEvent({ event: "assistant", data: quiet }).reply,
      ).toBeUndefined();
    }
  });

  test("returns keys and event text, never wording of its own", () => {
    expect(
      presentTurnEvent(
        { event: "tool_result", data: PAYLOADS.tool_result[1] },
        { toolName: "Bash" },
      ),
    ).toEqual({
      label: { key: "session.event.kind.toolResult" },
      summary: [
        { key: "session.event.toolResult", params: { tool: "Bash" } },
        { key: "session.event.toolResult.error" },
        { text: "make: *** No rule" },
        { key: "session.event.toolResult.lines", params: { count: 3 } },
      ],
      error: true,
    });
    expect(
      presentTurnEvent({ event: "system", data: PAYLOADS.system[3] }),
    ).toMatchObject({ fold: "thinking_tick" });
    expect(
      presentTurnEvent({ event: "system", data: PAYLOADS.system[4] }),
    ).toMatchObject({ fold: "debug" });
  });

  test("an attempt cut for a removed model says so by key, other errors keep their text", () => {
    const cut = {
      code: contracts.MODEL_NOT_ALLOWED_EVENT_CODE,
      message: "cut",
      model: "claude-old",
    };
    expect(presentTurnEvent({ event: "error", data: cut })).toEqual({
      label: { key: "session.event.kind.error" },
      summary: [
        {
          key: "session.event.error.modelNotAllowed",
          params: { model: "claude-old" },
        },
      ],
      error: true,
    });
    // A profile (its connection) that is gone has its own sentence, with the
    // model; an event from before the field reads as a removed model.
    expect(
      presentTurnEvent({
        event: "error",
        data: { ...cut, cause: "profile_removed" },
      }),
    ).toMatchObject({
      summary: [
        {
          key: "session.event.error.modelProfileRemoved",
          params: { model: "claude-old" },
        },
      ],
    });
    // Without the model there is no sentence to build: the stored text shows.
    expect(
      presentTurnEvent({
        event: "error",
        data: { code: cut.code, message: "cut" },
      }),
    ).toMatchObject({ summary: [{ text: "cut" }], error: true });
  });

  test("a session moved to the next model of its series names both models", () => {
    expect(
      presentTurnEvent({
        event: "system",
        data: {
          type: "system",
          subtype: "model_migrated",
          from: "claude-old",
          to: "claude-new",
        },
      }),
    ).toMatchObject({
      summary: [
        {
          key: "session.event.modelMigrated",
          params: { from: "claude-old", to: "claude-new" },
        },
      ],
    });
    // Without both names it stays the plain subtype line.
    expect(
      presentTurnEvent({
        event: "system",
        data: { type: "system", subtype: "model_migrated", from: "claude-old" },
      }),
    ).toMatchObject({ summary: [{ text: "model_migrated" }] });
  });
});
