import { describe, expect, test } from "bun:test";
import { presentTurnEvent } from "@werft-ai/contracts";

import type { TimelineEntry } from "./timeline.tsx";
import { timelineRows, turnGroups } from "./timeline.tsx";
import { finalStatusKey, focusWork, workCounts } from "./timeline-focus.ts";

let sequence = 0;
function entry(
  event: string,
  data: unknown,
  extra: Partial<TimelineEntry> = {},
): TimelineEntry {
  sequence += 1;
  return {
    id: `e${sequence}`,
    occurredAt: "2026-11-09T01:00:00.000Z",
    turnId: "t1",
    presentation: presentTurnEvent({ event, data }),
    ...extra,
  };
}
const call = (id: string, name: string, input: unknown = {}) =>
  entry(
    "tool_use",
    { tool_call: { id, name, input } },
    { toolCallId: id, toolName: name },
  );
const result = (id: string, isError = false) =>
  entry(
    "tool_result",
    { tool_result: { tool_call_id: id, is_error: isError, text: "out" } },
    { toolCallId: id },
  );
const permission = (id: string) =>
  entry(
    "question",
    { kind: "permission", tool: "Bash", tool_use_id: id, input: {} },
    { toolCallId: id, requestId: `req_${id}` },
  );
const status = (phase: string) => entry("status", { phase });
const reply = (text: string) => entry("assistant", { text });
const internal = () =>
  entry("system", {
    engine_event: { name: "command_lifecycle", category: "internal" },
  });
const tick = () =>
  entry("system", {
    engine_event: { name: "thinking_tokens", category: "thinking" },
  });

/** Each item of the single group: a folded run's counts, or a row's label. */
function focused(entries: readonly TimelineEntry[], held = new Set<string>()) {
  const rows = timelineRows(entries, true);
  const context = { held, finalStatus: finalStatusKey(rows) };
  return turnGroups(rows, "focus", context).flatMap((group) =>
    group.items.map((item) =>
      item.fold
        ? Object.fromEntries(
            Object.entries(workCounts(item.rows, context)).filter(
              ([, count]) => count > 0,
            ),
          )
        : item.row.presentation.label.key.replace("session.event.kind.", ""),
    ),
  );
}

describe("focusWork", () => {
  test("도구를 이름으로 나눈다: 명령, 읽기, 쓰기, 고치기, 검색, 그 밖", () => {
    expect(
      [
        call("a", "Bash"),
        call("b", "Read"),
        call("c", "Write"),
        call("d", "Edit"),
        call("e", "Grep"),
        call("f", "mcp__github__get_me"),
      ].map((row) => focusWork({ ...row, key: row.id })),
    ).toEqual(["command", "read", "write", "edit", "search", "tool"]);
  });

  test("답, 질문·권한, 오류는 접지 않는다", () => {
    for (const row of [
      reply("done"),
      permission("x"),
      entry("error", { message: "engine crashed" }),
    ]) {
      expect(focusWork({ ...row, key: row.id })).toBeNull();
    }
  });

  test("상태는 마지막 것만 펼친다", () => {
    const first = status("running");
    const last = status("idle");
    const context = { finalStatus: last.id };
    expect(focusWork({ ...first, key: first.id }, context)).toBe("event");
    expect(focusWork({ ...last, key: last.id }, context)).toBeNull();
  });
});

describe("focus 묶음", () => {
  test("연속된 도구 호출과 내부 이벤트는 한 줄로 접고 종류별로 센다", () => {
    expect(
      focused([
        status("running"),
        tick(),
        tick(),
        call("c1", "Bash"),
        result("c1"),
        internal(),
        call("c2", "Bash"),
        result("c2"),
        call("c3", "Read"),
        result("c3"),
        call("c4", "Read"),
        result("c4"),
        call("c5", "Write"),
        result("c5"),
        reply("Wrote the release notes."),
        entry("result", {
          turn: {
            outcome: "success",
            is_error: false,
            terminal_reason: null,
            tokens: 10,
          },
        }),
        status("idle"),
      ]),
    ).toEqual([
      // running status, one thinking line, one internal line.
      { command: 2, read: 2, write: 1, event: 3 },
      "assistant",
      { event: 1 },
      "status",
    ]);
  });

  test("한 개만 있어도 접는다", () => {
    expect(focused([call("c1", "Bash"), result("c1"), reply("ok")])).toEqual([
      { command: 1 },
      "assistant",
    ]);
  });

  test("권한을 기다리는 호출, 답한 호출, 실패한 호출은 펼친 채 앞뒤 묶음을 끊는다", () => {
    expect(
      focused(
        [
          call("c1", "Read"),
          result("c1"),
          call("c2", "Bash"),
          permission("c2"),
          call("c3", "Read"),
          result("c3"),
          call("c4", "Bash"),
          result("c4", true),
          call("c5", "Edit"),
          result("c5"),
          call("c6", "Bash"),
          permission("c6"),
          status("needs_input"),
        ],
        new Set(["c6"]),
      ),
    ).toEqual([
      { read: 1 },
      // Answered: the request and what came of it stay in sight.
      "toolUse",
      { read: 1 },
      "toolUse",
      { edit: 1 },
      // Still waiting on a person.
      "toolUse",
      "status",
    ]);
  });

  test("debug 이벤트도 focus 묶음에 들어가 센다", () => {
    expect(focused([internal(), internal(), reply("hi")])).toEqual([
      { event: 2 },
      "assistant",
    ]);
  });
});
