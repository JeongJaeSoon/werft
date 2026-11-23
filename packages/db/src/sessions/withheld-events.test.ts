import { describe, expect, test } from "bun:test";
import type { SessionEventPayload } from "@werft-ai/contracts";
import {
  WITHHELD_ERROR_MESSAGE,
  withheldEventPayload,
} from "./withheld-events.ts";

describe("withheldEventPayload", () => {
  const cases: [SessionEventPayload, SessionEventPayload][] = [
    [
      {
        event: "assistant",
        data: {
          type: "assistant",
          text: "Secret answer",
          thinking: "Secret thought",
          message: { content: "native" },
          parent_tool_use_id: null,
        },
      },
      {
        event: "assistant",
        data: { type: "assistant", parent_tool_use_id: null },
      },
    ],
    [
      {
        event: "tool_use",
        data: {
          type: "assistant",
          tool_call: { id: "tu-1", name: "Read", input: { path: "secret" } },
        },
      },
      {
        event: "tool_use",
        data: {
          type: "assistant",
          tool_call: { id: "tu-1", name: "Read", input: {} },
        },
      },
    ],
    [
      {
        event: "tool_result",
        data: {
          native: "Secret file",
          tool_result: {
            tool_call_id: "tu-1",
            is_error: null,
            text: "Secret file",
          },
        },
      },
      {
        event: "tool_result",
        data: {
          tool_result: { tool_call_id: "tu-1", is_error: null, text: "" },
        },
      },
    ],
    [
      { event: "tool_result", data: "Secret file the codec could not read" },
      { event: "tool_result", data: {} },
    ],
    [
      {
        event: "question",
        data: {
          request_id: "req-1",
          tool_use_id: "tu-2",
          kind: "question",
          input: { question: "Secret?" },
        },
      },
      {
        event: "question",
        data: {
          request_id: "req-1",
          tool_use_id: "tu-2",
          kind: "question",
          input: {},
        },
      },
    ],
    [
      {
        event: "result",
        data: {
          type: "result",
          subtype: "success",
          result: "Secret answer",
          usage: { output_tokens: 3 },
          turn: {
            outcome: "failed",
            is_error: true,
            terminal_reason: "Secret path in a reason",
            tokens: 3,
          },
        },
      },
      {
        event: "result",
        data: {
          type: "result",
          subtype: "success",
          usage: { output_tokens: 3 },
          turn: {
            outcome: "failed",
            is_error: true,
            terminal_reason: null,
            tokens: 3,
          },
        },
      },
    ],
    [
      {
        event: "system",
        data: {
          type: "system",
          engine_event: { name: "warning", category: "other" },
          params: { message: "Secret warning" },
        },
      },
      {
        event: "system",
        data: {
          type: "system",
          engine_event: { name: "warning", category: "other" },
        },
      },
    ],
    [
      { event: "error", data: { message: "Secret failure", code: "X" } },
      { event: "error", data: { message: WITHHELD_ERROR_MESSAGE, code: "X" } },
    ],
    [
      { event: "status", data: { phase: "idle", title: "Secret title" } },
      { event: "status", data: { phase: "idle" } },
    ],
  ];

  test.each(cases)("leaves out the words of %#", (stored, served) => {
    expect(withheldEventPayload(stored)).toEqual(served);
  });

  test("the platform's system events and an untitled status pass as they are", () => {
    const kept: SessionEventPayload[] = [
      { event: "status", data: { phase: "idle" } },
      { event: "system", data: { type: "system", subtype: "source_deleted" } },
    ];
    for (const payload of kept) {
      expect(withheldEventPayload(payload)).toBe(payload);
    }
  });
});
