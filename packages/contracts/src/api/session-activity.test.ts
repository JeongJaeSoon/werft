import { describe, expect, test } from "bun:test";
import {
  listSessionsResponseSchema,
  type SessionActivity,
  type SessionSummary,
} from "./session.ts";

// The agent map's list cards, as the list API answers them.
const NOW = Date.parse("2026-10-25T01:30:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const CARDS = [
  {
    id: "s1",
    note: "git push 전에 승인을 기다리는 중",
    toolCount: 41,
    errorCount: 1,
    subagentCount: 1,
    pending: {
      tool: "Bash · git push origin fix/webhook-retry",
      waitedMinutes: 12,
    },
  },
  {
    id: "s2",
    note: "용어집에 없는 단어 3개를 물어봄",
    toolCount: 18,
    errorCount: 0,
    subagentCount: 0,
    pending: {
      tool: "질문 · 'workspace'를 어떻게 옮길까요?",
      waitedMinutes: 4,
    },
  },
  {
    id: "s3",
    note: "Explore 하위 에이전트 3개가 차트 컴포넌트를 나눠 읽는 중",
    toolCount: 63,
    errorCount: 2,
    subagentCount: 3,
  },
  {
    id: "s4",
    note: "사용량 요약 표를 만드는 중",
    toolCount: 9,
    errorCount: 0,
    subagentCount: 0,
  },
  // A queued session has done nothing yet: its line is the screen's own.
  { id: "s5", note: null, toolCount: 0, errorCount: 0, subagentCount: 0 },
];

const window = { events: 120, complete: true, since: ago(30) };
const ACTIVITY: Record<string, unknown> = {
  s1: {
    last: { kind: "text", text: "git push 전에 승인을 기다리는 중" },
    tool_count: 41,
    error_count: 1,
    subagent_count: 1,
    current_tool: {
      id: "toolu_push",
      name: "Bash",
      target: "git push origin fix/webhook-retry",
      state: "waiting",
      since: ago(12),
      request: { kind: "permission", prompt: null },
    },
    window,
  },
  s2: {
    last: { kind: "text", text: "용어집에 없는 단어 3개를 물어봄" },
    tool_count: 18,
    error_count: 0,
    subagent_count: 0,
    current_tool: {
      id: "toolu_ask",
      name: "AskUserQuestion",
      target: "",
      state: "waiting",
      since: ago(4),
      request: { kind: "question", prompt: "'workspace'를 어떻게 옮길까요?" },
    },
    window,
  },
  s3: {
    last: {
      kind: "text",
      text: "Explore 하위 에이전트 3개가 차트 컴포넌트를 나눠 읽는 중",
    },
    tool_count: 63,
    error_count: 2,
    subagent_count: 3,
    current_tool: {
      id: "toolu_task",
      name: "Task",
      target: "",
      state: "running",
      since: ago(3),
      request: null,
    },
    window: { events: 500, complete: false, since: ago(20) },
  },
  s4: {
    last: { kind: "text", text: "사용량 요약 표를 만드는 중" },
    tool_count: 9,
    error_count: 0,
    subagent_count: 0,
    current_tool: null,
    window,
  },
  s5: {
    last: null,
    tool_count: 0,
    error_count: 0,
    subagent_count: 0,
    current_tool: null,
    window: { events: 0, complete: true, since: null },
  },
};

const tool = (name: string, target: string) =>
  target === "" ? name : `${name} · ${target}`;

// What the board needs beyond the summary's own fields; the wording of a
// question is the screen's.
function cardOf(item: SessionSummary, activity: SessionActivity) {
  const current = activity.current_tool;
  return {
    id: item.title,
    note:
      activity.last === null
        ? null
        : activity.last.kind === "text"
          ? activity.last.text
          : tool(activity.last.name, activity.last.target),
    toolCount: activity.tool_count,
    errorCount: activity.error_count,
    subagentCount: activity.subagent_count,
    ...(current?.state === "waiting"
      ? {
          pending: {
            tool:
              current.request?.kind === "question"
                ? `질문 · ${current.request.prompt}`
                : tool(current.name, current.target),
            waitedMinutes: Math.round(
              (NOW - Date.parse(current.since)) / 60_000,
            ),
          },
        }
      : {}),
  };
}

describe("session list activity", () => {
  test("a list page carries each agent map card's counts, line and open request", () => {
    const page = listSessionsResponseSchema.parse({
      items: CARDS.map((card, index) => ({
        id: `0000000${index + 1}-0000-4000-8000-000000000000`,
        title: card.id,
        revision: 0,
        admission_state: "active",
        status: "running",
        runtime: null,
        model: null,
        repository_id: null,
        current_turn_id: null,
        queued_turn_count: 0,
        last_event_at: null,
        activity: ACTIVITY[card.id],
        created_at: ago(60),
        updated_at: ago(1),
      })),
      next_cursor: null,
    });
    expect(
      page.items.map((item) => cardOf(item, item.activity as SessionActivity)),
    ).toEqual(CARDS);
  });

  test("a summary from a server before the field still parses, without it", () => {
    const [item] = listSessionsResponseSchema.parse({
      items: [
        {
          id: "00000001-0000-4000-8000-000000000000",
          revision: 0,
          admission_state: "active",
          status: "queued",
          runtime: null,
          model: null,
          repository_id: null,
          current_turn_id: null,
          queued_turn_count: 0,
          last_event_at: null,
          created_at: NOW_ISO,
          updated_at: NOW_ISO,
        },
      ],
      next_cursor: null,
    }).items;
    expect(item?.activity).toBeUndefined();
  });

  test("a request is only for a waiting call, and a prompt is never empty", () => {
    const base = ACTIVITY.s1 as { current_tool: Record<string, unknown> };
    const parse = (current: Record<string, unknown>) =>
      listSessionsResponseSchema.shape.items.element.shape.activity.safeParse({
        ...base,
        current_tool: { ...base.current_tool, ...current },
      }).success;
    expect(parse({ request: { kind: "question", prompt: "" } })).toBe(false);
    expect(parse({ request: { kind: "other", prompt: null } })).toBe(false);
    expect(parse({ state: "interrupted" })).toBe(false);
  });

  test("a call as the newest activity reads as the card's tool line", () => {
    const activity = {
      ...(ACTIVITY.s4 as SessionActivity),
      last: { kind: "tool", name: "Bash", target: "bun run report" },
    } as SessionActivity;
    expect(cardOf({ title: "s4" } as SessionSummary, activity).note).toBe(
      "Bash · bun run report",
    );
  });
});

const NOW_ISO = new Date(NOW).toISOString();
