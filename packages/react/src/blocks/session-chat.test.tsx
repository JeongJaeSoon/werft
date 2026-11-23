import { describe, expect, test } from "bun:test";
import type { TurnSummary } from "@werft-ai/contracts";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { SessionEventFrame } from "../sessions.ts";

await setupDom();
// After setupDom: session-chat loads @werft-ai/ui, whose Radix decides at
// import time whether a DOM exists, for every later file in the run too.
const { chatItems } = await import("./session-chat.tsx");

const DELETED_AT = "2026-11-23T02:00:00.000Z";

const turn = (
  turn_id: string,
  message: string,
  source_deleted_at: string | null,
): TurnSummary => ({
  turn_id,
  session_id: "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b01",
  status: "completed",
  message,
  channel: "slack",
  created_by: null,
  requester: null,
  slack_permalink: null,
  source_deleted_at,
  terminal_reason: null,
  checkpoint_revision: null,
  created_at: `2026-11-23T01:0${turn_id}:00.000Z`,
  started_at: null,
  ended_at: null,
});

const frame = (
  id: string,
  turnId: string,
  minute: string,
  payload: SessionEventFrame["payload"],
): SessionEventFrame => ({
  id,
  turnId,
  attemptId: null,
  occurredAt: `2026-11-23T01:0${minute}:00.000Z`,
  payload,
});

// As streamed before the delete: the text is in the frames themselves.
const EVENTS: SessionEventFrame[] = [
  frame("1", "1", "1", {
    event: "assistant",
    data: { type: "assistant", text: "Secret answer" },
  }),
  frame("2", "1", "1", {
    event: "tool_use",
    data: {
      type: "assistant",
      tool_call: { id: "tu-1", name: "Read", input: { path: "secret" } },
    },
  }),
  frame("3", "1", "1", {
    event: "tool_result",
    data: {
      tool_result: {
        tool_call_id: "tu-1",
        is_error: false,
        text: "Secret file",
      },
    },
  }),
  frame("4", "2", "2", {
    event: "assistant",
    data: { type: "assistant", text: "Second answer" },
  }),
];

const shape = (items: ReturnType<typeof chatItems>) =>
  items.map((item) =>
    item.kind === "user"
      ? ["user", item.turn.message, item.turn.source_deleted_at]
      : item.kind === "reply"
        ? ["reply", item.text, item.withheld ?? false]
        : ["tool", item.name, item.input, item.result, item.withheld ?? false],
  );

describe("chatItems for a turn whose Slack message was deleted", () => {
  const format = () => "";

  test("with no deleted message every line reads as streamed", () => {
    expect(
      shape(
        chatItems(
          EVENTS,
          [turn("1", "Secret ask", null), turn("2", "Follow-up", null)],
          format,
        ),
      ),
    ).toEqual([
      ["user", "Secret ask", null],
      ["reply", "Secret answer", false],
      [
        "tool",
        "Read",
        { path: "secret" },
        { text: "Secret file", error: false },
        false,
      ],
      ["user", "Follow-up", null],
      ["reply", "Second answer", false],
    ]);
  });

  test("the withheld turn shows placeholders, even for text it streamed before; the next turn reads as streamed", () => {
    expect(
      shape(
        chatItems(
          EVENTS,
          [turn("1", "", DELETED_AT), turn("2", "Follow-up", null)],
          format,
        ),
      ),
    ).toEqual([
      ["user", "", DELETED_AT],
      ["reply", "", true],
      ["tool", "Read", {}, { text: "", error: false }, true],
      ["user", "Follow-up", null],
      ["reply", "Second answer", false],
    ]);
  });
  test("frames marked withheld show placeholders without the turns read, an error too", () => {
    const marked = [
      ...EVENTS.slice(0, 3),
      frame("5", "1", "1", {
        event: "error",
        data: { message: "Withheld: this turn's Slack message was deleted" },
      }),
    ].map((item) => ({ ...item, sourceDeletedAt: DELETED_AT }));
    expect(shape(chatItems(marked, undefined, format))).toEqual([
      ["reply", "", true],
      ["tool", "Read", {}, { text: "", error: false }, true],
      ["reply", "", true],
    ]);
  });

  test("a frame marked withheld hides the instruction of turns read before the delete", () => {
    const later = {
      ...frame("5", "1", "2", {
        event: "tool_result",
        data: {
          tool_result: { tool_call_id: "tu-1", is_error: false, text: "" },
        },
      }),
      sourceDeletedAt: DELETED_AT,
    };
    expect(
      shape(
        chatItems(
          [later],
          [turn("1", "Secret ask", null), turn("2", "Follow-up", null)],
          format,
        ),
      ),
    ).toEqual([
      ["user", "", DELETED_AT],
      ["user", "Follow-up", null],
    ]);
  });

  test("one frame marked withheld hides the frames of its turn streamed before it", () => {
    const later = {
      ...frame("5", "1", "2", {
        event: "tool_result",
        data: {
          tool_result: { tool_call_id: "tu-1", is_error: false, text: "" },
        },
      }),
      sourceDeletedAt: DELETED_AT,
    };
    expect(
      shape(
        chatItems(
          [...EVENTS.slice(0, 2), later, EVENTS[3]!],
          undefined,
          format,
        ),
      ),
    ).toEqual([
      ["reply", "", true],
      ["tool", "Read", {}, { text: "", error: false }, true],
      ["reply", "Second answer", false],
    ]);
  });
});
