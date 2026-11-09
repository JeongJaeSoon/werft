import { describe, expect, test } from "bun:test";
import { sessionsEn, sessionsJa, sessionsKo } from "../messages/index.ts";
import type { SessionEventFrame } from "../sessions.ts";
import {
  heldToolCalls,
  readableReason,
  workText,
} from "./session-timeline.tsx";

type Translate = Parameters<typeof readableReason>[1];
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as unknown as Translate;

describe("readableReason", () => {
  test("worker가 멈춘 이유 네 가지는 사람 말로, 나머지는 그대로 둔다", () => {
    expect(
      [
        "No input for 1802s",
        "No answer arrived within 1800s",
        "Turn turn_1 ran past its 600s budget, and the engine did not answer the interrupt",
        "checkpoint capture ran past its 45s budget",
        "The turn ran out of time",
        "engine crashed",
      ].map((text) => readableReason(text, t, "en")),
    ).toEqual([
      'session.reason.idle {"duration":"30 minutes"}',
      'session.reason.noAnswer {"duration":"30 minutes"}',
      'session.reason.turnBudget {"duration":"10 minutes"}',
      'session.reason.stageBudget {"duration":"45 seconds"}',
      "session.reason.turnOver",
      null,
    ]);
  });
});

let sequence = 0;
const frame = (event: string, data: unknown) => {
  sequence += 1;
  return {
    id: `e${sequence}`,
    occurredAt: "2026-10-27T01:00:00.000Z",
    turnId: "t1",
    payload: { event, data },
  } as unknown as SessionEventFrame;
};
const call = (id: string, name = "Bash") =>
  frame("tool_use", {
    tool_call: { id, name, input: {} },
  });
const ask = (id: string, kind: "permission" | "question") =>
  frame("question", {
    request_id: `req_${id}`,
    tool_use_id: id,
    kind,
    tool: kind === "permission" ? "Bash" : "AskUserQuestion",
    input: {},
  });
const status = (phase: string) => frame("status", { phase });
const result = (id: string, isError = false) =>
  frame("tool_result", {
    tool_result: { tool_call_id: id, is_error: isError, text: "" },
  });

describe("heldToolCalls", () => {
  test("권한 요청과 질문 모두 답이 오기 전까지 그 호출을 막는다", () => {
    expect([
      ...heldToolCalls([
        call("c1"),
        ask("c1", "permission"),
        call("c2", "AskUserQuestion"),
        ask("c2", "question"),
        status("needs_input"),
        call("c3"),
      ]),
    ]).toEqual(["c1", "c2"]);
  });

  test("허용해 세션이 다시 돌면 결과 전이라도 막지 않는다", () => {
    expect(
      heldToolCalls([
        call("c1"),
        ask("c1", "permission"),
        status("needs_input"),
        status("running"),
      ]).size,
    ).toBe(0);
  });

  test("둘 중 하나만 답하면 세션이 needs_input이어도 그 호출은 막지 않는다", () => {
    expect([
      ...heldToolCalls(
        [
          call("c1"),
          ask("c1", "permission"),
          call("c2"),
          ask("c2", "permission"),
          status("needs_input"),
        ],
        new Set(["req_c1"]),
      ),
    ]).toEqual(["c2"]);
  });

  test("거부해 실패 결과가 오면 막지 않는다", () => {
    expect(
      heldToolCalls([
        call("c1"),
        ask("c1", "permission"),
        status("needs_input"),
        result("c1", true),
      ]).size,
    ).toBe(0);
  });
});

describe("workText", () => {
  const counts = {
    command: 2,
    read: 2,
    write: 1,
    edit: 0,
    search: 1,
    tool: 0,
    event: 3,
  };
  const translate = (messages: Record<string, string>): Translate =>
    ((key: string, vars: Record<string, string | number> = {}) =>
      (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(vars[name]),
      )) as unknown as Translate;

  test("세 언어 모두 0인 종류는 빼고 1은 단수로 말한다", () => {
    expect(workText(counts, translate(sessionsKo))).toBe(
      "실행한 명령 2개 · 읽은 파일 2개 · 쓴 파일 1개 · 검색 1번 · 이벤트 3개",
    );
    expect(workText(counts, translate(sessionsEn))).toBe(
      "Ran 2 commands · Read 2 files · Wrote 1 file · Ran 1 search · 3 events",
    );
    expect(workText(counts, translate(sessionsJa))).toBe(
      "コマンド 2 件を実行 · ファイル 2 件を読み取り · ファイル 1 件を書き込み · 検索 1 回 · イベント 3 件",
    );
  });
});
