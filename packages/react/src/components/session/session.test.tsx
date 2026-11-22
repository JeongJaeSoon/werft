import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  presentTurnEvent,
  type SessionSummary,
  type TurnEventMessage,
} from "@werft-ai/contracts";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import { act } from "react";
import type { SessionRowMessages } from "./session-row.tsx";
import type { TimelineEntry, TimelineMessages } from "./timeline.tsx";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists.
const { SESSION_NARROW_TEMPLATE, SESSION_TEMPLATE, SessionRow } = await import(
  "./session-row.tsx"
);
const {
  SESSION_OVERVIEW_NARROW_TEMPLATE,
  SESSION_OVERVIEW_TEMPLATE,
  SessionOverviewRow,
  SessionOverviewTable,
} = await import("./session-overview.tsx");
const { StatusLabel } = await import("../status/status-label.tsx");
const { StageIndicator } = await import("./stage-indicator.tsx");
const { Timeline } = await import("./timeline.tsx");
const { formatRelativeTime } = await import("@werft-ai/ui");

// One track per column: minmax(0,…), fixed, or as wide as the column's content.
const TRACK = /^(minmax\((0|\d+px),[\d.]+fr\)|\d+px|max-content)$/;
test.each([
  [SESSION_TEMPLATE, 5],
  [SESSION_NARROW_TEMPLATE, 3],
  [SESSION_OVERVIEW_TEMPLATE, 6],
  [SESSION_OVERVIEW_NARROW_TEMPLATE, 4],
])("세션 표 열 정의 %s는 열마다 트랙 하나다", (columns, count) => {
  const tracks = columns.split(" ");
  expect(tracks).toHaveLength(count);
  for (const track of tracks) expect(track).toMatch(TRACK);
});

// Echoes the key and params, so a test reads what the component asked for.
function formatMessage({ key, params }: TurnEventMessage): string {
  return params ? `${key}${JSON.stringify(params)}` : key;
}

const MESSAGES: TimelineMessages = {
  label: "events",
  empty: "no events",
  connecting: "connecting",
  closed: "closed",
  turn: (turnId) => `turn ${turnId}`,
};

let sequence = 0;
function entry(
  event: string,
  data: unknown,
  turnId: string | null = "t1",
): TimelineEntry {
  sequence += 1;
  return {
    id: `e${sequence}`,
    occurredAt: "2026-10-21T01:00:00.000Z",
    turnId,
    presentation: presentTurnEvent({ event, data }),
  };
}

const tick = (turnId = "t1") =>
  entry(
    "system",
    { engine_event: { name: "thinking_tokens", category: "thinking" } },
    turnId,
  );

function summaries() {
  return [...document.querySelectorAll("li")].map(
    (item) => item.textContent ?? "",
  );
}

describe("Timeline", () => {
  test("한 turn 안에 이어진 thinking tick은 한 줄로 접히고 개수를 센다", () => {
    render(
      <Timeline
        entries={[tick(), tick(), tick(), tick("t2")]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    const lines = summaries();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('session.event.thinkingTokens{"count":3}');
    expect(lines[1]).toContain('session.event.thinkingTokens{"count":1}');
  });

  test("응답·도구·요청·오류·시스템 이벤트는 아이콘이 다르고 아이콘마다 이름이 있다", () => {
    const { container } = render(
      <Timeline
        entries={[
          entry("assistant", { text: "hi" }),
          entry("tool_use", {
            tool_call: { id: "c1", name: "Bash", input: {} },
          }),
          entry("question", { kind: "permission", tool: "Bash", input: {} }),
          entry("error", { message: "boom" }),
          entry("status", { phase: "running" }),
        ]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, kind: (kind) => `kind:${kind}` }}
      />,
    );
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.dataset.kind)).toEqual([
      "agent",
      "tool",
      "request",
      "error",
      "system",
    ]);
    const icons = rows.map((row) => row.querySelector('[role="img"]'));
    expect(icons.map((icon) => icon?.getAttribute("aria-label"))).toEqual([
      "kind:agent",
      "kind:tool",
      "kind:request",
      "kind:error",
      "kind:system",
    ]);
    const drawn = icons.map((icon) => icon?.querySelector("svg")?.innerHTML);
    expect(new Set(drawn).size).toBe(5);
  });

  test("아이콘 이름을 주지 않으면 아이콘은 스크린리더에서 숨는다", () => {
    const { container } = render(
      <Timeline
        entries={[entry("error", { message: "boom" })]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelector('li [aria-hidden="true"]')).not.toBeNull();
  });

  test("debug 이벤트는 showDebug일 때만 보이고 tick 접기를 끊지 않는다", () => {
    const entries = [
      tick(),
      entry("system", {
        engine_event: { name: "rate_limit", category: "internal" },
      }),
      tick(),
    ];
    const { rerender } = render(
      <Timeline
        entries={entries}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toContain('{"count":2}');
    rerender(
      <Timeline
        entries={entries}
        formatMessage={formatMessage}
        messages={MESSAGES}
        showDebug
      />,
    );
    expect(summaries().some((line) => line.includes("rate_limit"))).toBe(true);
  });

  test("말할 것이 없는 이벤트는 빈 줄을 만들지 않는다", () => {
    render(
      <Timeline
        entries={[
          entry("assistant", {}),
          entry("system", { subtype: "" }),
          entry("unknown_event", {}),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    expect(summaries()).toEqual([]);
    expect(document.body.textContent).toContain("no events");
  });

  test("짝지은 도구 결과와 오류를 그리고 생각은 접어 둔다", () => {
    const result: TimelineEntry = {
      ...entry("tool_result", {
        tool_result: { tool_call_id: "c1", is_error: true, text: "boom\nmore" },
      }),
      presentation: presentTurnEvent(
        {
          event: "tool_result",
          data: {
            tool_result: { tool_call_id: "c1", is_error: true, text: "boom" },
          },
        },
        { toolName: "Bash" },
      ),
    };
    render(
      <Timeline
        entries={[result, entry("assistant", { thinking: "plan" })]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    const [failed, thought] = [...document.querySelectorAll("li")];
    expect(failed?.dataset.error).toBe("true");
    expect(failed?.textContent).toContain(
      'session.event.toolResult{"tool":"Bash"} · session.event.toolResult.error · boom',
    );
    expect(thought?.querySelector("details summary")?.textContent).toBe(
      "session.event.thought",
    );
    expect(thought?.querySelector("details p")?.textContent).toBe("plan");
    // The turn is named once, in the head of its group.
    expect(
      document.querySelector('[data-slot="timeline-turn"]')?.textContent,
    ).toContain("turn t1");
  });

  test("연결 중과 끊김은 상태로 알리고 그때는 빈 문구를 보이지 않는다", () => {
    const { getByRole, rerender } = render(
      <Timeline
        entries={[]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        state="connecting"
      />,
    );
    expect(getByRole("status").textContent).toBe("connecting");
    expect(document.body.textContent).not.toContain("no events");
    rerender(
      <Timeline
        entries={[entry("error", { message: "lost" })]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        state="closed"
      />,
    );
    expect(getByRole("status").textContent).toBe("closed");
    expect(getByRole("list", { name: "events" })).toBeTruthy();
  });
});

describe("StageIndicator", () => {
  test("presentTurnEvent의 라벨과 요약을 상태 영역으로 그린다", () => {
    const { getByRole, rerender } = render(
      <StageIndicator
        presentation={presentTurnEvent({
          event: "status",
          data: { phase: "running" },
        })}
        formatMessage={formatMessage}
        emptyLabel="waiting"
        busy
      />,
    );
    const status = getByRole("status");
    expect(status.textContent).toBe(
      "session.event.kind.statussessions.status.running",
    );
    expect(status.dataset.busy).toBe("true");
    rerender(
      <StageIndicator
        presentation={presentTurnEvent({
          event: "error",
          data: { message: "boom" },
        })}
        formatMessage={formatMessage}
        emptyLabel="waiting"
      />,
    );
    expect(getByRole("status").dataset.error).toBe("true");
    rerender(
      <StageIndicator
        presentation={null}
        formatMessage={formatMessage}
        emptyLabel="waiting"
      />,
    );
    expect(getByRole("status").textContent).toBe("waiting");
  });
});

const ROW_MESSAGES: SessionRowMessages = {
  status: (status) => `status:${status}`,
  admission: (state) => `admission:${state}`,
  statusAxis: "work",
  admissionAxis: "session",
  runtime: "runtime",
  lastEvent: "last",
  created: "created",
  queuedTurns: (count) => `queued:${count}`,
  none: "none",
};

const SESSION: SessionSummary = {
  id: "0192f0c4-7d3a-7b4e-9f00-000000000001",
  title: null,
  agent: null,
  preview: false,
  agent_hidden: false,
  created_by: null,
  channel: null,
  slack_permalink: null,
  revision: 3,
  admission_state: "active",
  status: "running",
  runtime: {
    connection_id: "anthropic-main",
    kind: "claude_agent_sdk",
    version: "1.2.3",
    model: "model-claude-default",
    permission_mode: "default",
  },
  model: "model-claude-default",
  repository_id: null,
  repository: null,
  current_turn_id: null,
  queued_turn_count: 2,
  turn_time_ms: 0,
  last_event_at: null,
  created_at: "2026-10-21T01:00:00.000Z",
  updated_at: "2026-10-21T01:00:00.000Z",
};

describe("SessionRow", () => {
  test("행 전체를 여는 링크가 전체 id로 읽히고 런타임과 대기 작업을 그린다", () => {
    const { getByRole, container } = render(
      <SessionRow
        session={SESSION}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={ROW_MESSAGES}
      />,
    );
    const link = getByRole("link", { name: SESSION.id });
    expect(link.getAttribute("href")).toBe("/sessions/abc");
    expect(link.dataset.slot).toBe("grid-table-row-opener");
    expect(link.closest('[role="cell"]')).toBeTruthy();
    const row = link.closest('[role="row"]');
    expect(row?.querySelectorAll("a")).toHaveLength(1);
    expect(
      Array.from(row?.children ?? []).every(
        (cell) => cell.getAttribute("role") === "cell",
      ),
    ).toBe(true);
    expect(link.closest('[role="cell"]')?.textContent).toBe(SESSION.id);
    const text = container.textContent ?? "";
    for (const part of [
      "work: status:running",
      "session: admission:active",
      "queued:2",
      "runtime: anthropic-main · claude_agent_sdk 1.2.3",
    ]) {
      expect(text).toContain(part);
    }
  });

  test("renderLink가 fragment를 돌려줘도 링크가 행을 덮고 포커스를 보인다", () => {
    const { getByRole } = render(
      <SessionRow
        session={SESSION}
        renderLink={(link) => (
          <>
            <a href="/sessions/abc" {...link} />
          </>
        )}
        messages={ROW_MESSAGES}
      />,
    );
    const link = getByRole("link", { name: SESSION.id });
    expect(link.className).toContain("absolute inset-0");
    expect(link.className).toContain("focus-visible:outline-2");
    // Still the row's opener, for the row's hover fill and cell rules.
    expect(link.dataset.slot).toBe("grid-table-row-opener");
  });

  test("상태와 admission은 서로 다른 축의 StatusLabel로 그린다", () => {
    const { container } = render(
      <SessionRow
        session={{ ...SESSION, status: "idle", admission_state: "paused" }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={ROW_MESSAGES}
      />,
    );
    const labels = [...container.querySelectorAll(".werft-status")].map(
      (label) => [
        label.getAttribute("data-axis"),
        label.getAttribute("data-tone"),
      ],
    );
    expect(labels).toEqual([
      ["session", "neutral"],
      ["admission", "caution"],
    ]);
  });
});

const OVERVIEW_MESSAGES = {
  status: (status: string) => `status:${status}`,
  admission: (state: string) => `admission:${state}`,
  statusAxis: "work",
  channel: (channel: string) => `channel:${channel}`,
  inProgress: "in progress",
  unknown: "—",
  agentNone: "에이전트 없음",
  agentHidden: "볼 수 없는 에이전트",
};

const HEAD = {
  title: "제목",
  agent: "에이전트",
  channel: "채널",
  status: "상태",
  started: "시작 시각",
  duration: "소요 시간",
};

const AGENT = {
  id: "0192f0c4-7d3a-7b4e-9f00-0000000000a1",
  name: "Release helper",
  release_version_no: 3,
  release_label: "2026-10-30_14:30:28",
  release_is_active: true,
};

function overviewRow(session: SessionSummary, extra: object = {}) {
  return render(
    <SessionOverviewTable label="sessions" messages={HEAD}>
      <SessionOverviewRow
        session={session}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={OVERVIEW_MESSAGES}
        {...extra}
      />
    </SessionOverviewTable>,
  );
}

const cellsOf = (row: Element | null | undefined) => [
  ...(row?.querySelectorAll('[role="cell"]') ?? []),
];

describe("SessionOverviewRow", () => {
  test("미리보기 세션은 제목 셀에 미리보기 표시를 두고, 다른 세션은 두지 않는다", () => {
    const messages = { ...OVERVIEW_MESSAGES, preview: "미리보기" };
    const shown = overviewRow({ ...SESSION, preview: true }, { messages });
    const title = cellsOf(shown.getAllByRole("row")[1])[0];
    expect(title?.querySelector('[data-slot="badge"]')?.textContent).toBe(
      "미리보기",
    );
    shown.unmount();
    const plain = overviewRow(SESSION, { messages });
    expect(plain.queryByText("미리보기")).toBeNull();
  });

  test("머리는 제목·에이전트·채널·상태·시작 시각·소요 시간이고 행마다 셀이 여섯이다", () => {
    const { getAllByRole } = overviewRow(SESSION);
    const heads = getAllByRole("columnheader");
    expect(heads.map((head) => head.textContent)).toEqual([
      "제목",
      "에이전트",
      "채널",
      "상태",
      "시작 시각",
      "소요 시간",
    ]);
    expect(cellsOf(getAllByRole("row")[1])).toHaveLength(6);
    // Only the duration, a time, ends; its header and cells alike.
    const ends = (cell: Element) => cell.className.includes("justify-end");
    const want = [false, false, false, false, false, true];
    expect(heads.map(ends)).toEqual(want);
    expect(cellsOf(getAllByRole("row")[1]).map(ends)).toEqual(want);
  });

  test("제목이 있으면 행을 여는 링크가 제목으로 읽히고 그 아래 짧은 ID 8자리를 둔다", () => {
    const { getByRole, getByText } = overviewRow(
      { ...SESSION, title: "hello.txt 만들고 commit", agent: AGENT },
      {
        messages: {
          ...OVERVIEW_MESSAGES,
          open: (name: string) => `열기: ${name}`,
        },
      },
    );
    const link = getByRole("link", { name: "열기: hello.txt 만들고 commit" });
    expect(link.dataset.slot).toBe("grid-table-row-opener");
    expect(link.getAttribute("title")).toBe("hello.txt 만들고 commit");
    expect(getByText("hello.txt 만들고 commit").className).not.toContain(
      "font-mono",
    );
    expect(getByText(SESSION.id.slice(0, 8)).getAttribute("title")).toBe(
      SESSION.id,
    );
    expect(cellsOf(link.closest('[role="row"]'))[1]?.textContent).toBe(
      "Release helper",
    );
  });

  test("제목이 없으면 짧은 ID를 mono로 보이고 링크 이름은 전체 ID이며, 에이전트가 없으면 '에이전트 없음'이다", () => {
    const { getByRole, getByText } = overviewRow(SESSION);
    const link = getByRole("link", { name: SESSION.id });
    expect(getByText(SESSION.id.slice(0, 8)).className).toContain("font-mono");
    const cells = cellsOf(link.closest('[role="row"]'));
    expect(cells[1]?.textContent).toBe("에이전트 없음");
    // An older session without a channel: a dash, not a guessed icon.
    expect(cells[2]?.textContent).toBe("—");
  });

  test("서버가 에이전트를 가린 세션은 '에이전트 없음'이 아니라 '볼 수 없는 에이전트'를 흐린 글자로 쓴다", () => {
    const { getAllByRole, getByText } = overviewRow({
      ...SESSION,
      agent: null,
      agent_hidden: true,
    });
    expect(cellsOf(getAllByRole("row")[1])[1]?.textContent).toBe(
      "볼 수 없는 에이전트",
    );
    expect(getByText("볼 수 없는 에이전트").className).toContain(
      "text-subtle-foreground",
    );
  });

  test("에이전트 이름은 흐리지 않는다", () => {
    const { getByText } = overviewRow({ ...SESSION, agent: AGENT });
    expect(getByText("Release helper").className).not.toContain(
      "text-subtle-foreground",
    );
  });

  test("채널은 Slack 로고·웹·API 아이콘이고 이름은 스크린 리더와 툴팁으로 읽는다", () => {
    for (const channel of ["slack", "web", "api"] as const) {
      const { getByRole, unmount } = overviewRow({ ...SESSION, channel });
      const icon = getByRole("img", { name: `channel:${channel}` });
      expect(icon.getAttribute("data-channel")).toBe(channel);
      expect(icon.getAttribute("title")).toBe(`channel:${channel}`);
      // Above the row's opener, so hovering shows the name.
      expect(icon.className).toContain("relative");
      expect(icon.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
      unmount();
    }
  });

  test("상태는 색 알약 배지이고 답변 대기 노랑, 작업 중 파랑, 실패 빨강, 나머지는 회색이다", () => {
    const variants = {
      needs_input: "amber",
      running: "blue",
      failed: "red",
      queued: "gray",
      idle: "gray",
      stopped: "gray",
    } as const;
    for (const [status, tone] of Object.entries(variants)) {
      const { container, unmount } = overviewRow({
        ...SESSION,
        status: status as SessionSummary["status"],
      });
      const badge = container.querySelector("[data-slot=badge]");
      expect(badge?.textContent).toBe(`status:${status}`);
      expect(badge?.className).toContain(
        {
          amber: "tone-caution",
          blue: "tone-progress",
          red: "tone-danger",
          gray: "tone-neutral",
        }[tone],
      );
      unmount();
    }
  });

  test("열림·닫힘이 아닌 진입 상태는 두 번째 배지로, 복구 필요는 빨강으로 적는다", () => {
    const badges = (admission_state: SessionSummary["admission_state"]) => {
      const { container, unmount } = overviewRow({
        ...SESSION,
        status: "stopped",
        admission_state,
      });
      const found = [...container.querySelectorAll("[data-slot=badge]")].map(
        (badge) => [badge.textContent, badge.className.includes("tone-danger")],
      );
      unmount();
      return found;
    };
    // A terminate that cut a running turn: stopped, yet a decision is owed.
    expect(badges("recovery_required")).toEqual([
      ["status:stopped", false],
      ["admission:recovery_required", true],
    ]);
    expect(badges("paused")).toEqual([
      ["status:stopped", false],
      ["admission:paused", false],
    ]);
    expect(badges("active")).toEqual([["status:stopped", false]]);
    expect(badges("closed")).toEqual([["status:stopped", false]]);
  });

  test("상태 뒤 설명은 노드를 받아 툴팁과 포커스를 행 링크 위에 둔다", () => {
    const { getByText, getAllByRole } = overviewRow(
      { ...SESSION, status: "needs_input" },
      {
        statusDetail: (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: home's wait tooltip trigger, focused for its exact time
          <time dateTime="2026-11-02T00:00:00Z" tabIndex={0} title="exact">
            12분
          </time>
        ),
      },
    );
    const time = getByText("12분");
    expect(time.tagName).toBe("TIME");
    // Raised above the row's opener, so hover and focus reach it.
    expect(time.parentElement?.className).toContain("relative");
    // A phone's row leaves the wait out; the duration cell stays.
    expect(time.parentElement?.className).toContain(
      "[@container(width<600px)]:hidden",
    );
    expect(
      getAllByRole("row")[1]?.querySelectorAll(
        "[class*='[@container(width<600px)]:hidden']",
      ).length,
    ).toBe(1);
    time.focus();
    expect(document.activeElement === time).toBe(true);
    expect(getAllByRole("row")[1]?.textContent).toContain(
      "work: status:needs_input12분",
    );
  });

  test("시작 시각은 연도 없는 절대 시각이고 툴팁에 상대 시각을 둔다", () => {
    const { getAllByRole } = overviewRow({
      ...SESSION,
      created_at: "2026-11-11T00:42:00.000Z",
    });
    const time = cellsOf(getAllByRole("row")[1])[4]?.querySelector("time");
    expect(time?.textContent).toBe("11월 11일 오전 09:42");
    expect(time?.getAttribute("dateTime")).toBe("2026-11-11T00:42:00.000Z");
    expect(time?.getAttribute("data-slot")).toBe("table-time");
    expect(time?.tabIndex).toBe(0);
    expect(
      document.getElementById(time?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(formatRelativeTime("2026-11-11T00:42:00.000Z", "ko"));
  });

  test("소요 시간은 일하는 세션이면 진행 중, 아니면 끝난 턴들이 돈 시간의 합이다", () => {
    const duration = (session: SessionSummary) => {
      const { getAllByRole, unmount } = overviewRow(session);
      const text = cellsOf(getAllByRole("row")[1])[5]?.textContent;
      unmount();
      return text;
    };
    const minutes = (n: number) => n * 60_000;
    for (const status of ["running", "needs_input", "queued"] as const)
      expect(duration({ ...SESSION, status, turn_time_ms: minutes(5) })).toBe(
        "in progress",
      );
    // Not the wall clock from start to last event: an idle hour between
    // turns does not count.
    expect(
      duration({
        ...SESSION,
        status: "idle",
        created_at: "2026-11-11T00:00:00.000Z",
        last_event_at: "2026-11-11T05:00:00.000Z",
        turn_time_ms: minutes(18),
      }),
    ).toBe("18분");
    expect(
      duration({ ...SESSION, status: "failed", turn_time_ms: minutes(65) }),
    ).toBe("1시간 5분");
    expect(duration({ ...SESSION, status: "stopped", turn_time_ms: 0 })).toBe(
      "—",
    );
  });

  test("표 폭 820px 이하에서는 채널과 시작 시각을 머리와 셀에서 함께 숨긴다", () => {
    const { getAllByRole, getByRole } = overviewRow(SESSION);
    expect(
      getByRole("table", { name: "sessions" }).getAttribute("data-narrow-at"),
    ).toBe("820");
    const hidden = (cells: Element[]) =>
      cells.map((cell) =>
        cell.className.includes("[@container(max-width:820px)]:hidden"),
      );
    const shape = [false, false, true, false, true, false];
    expect(hidden(getAllByRole("columnheader"))).toEqual(shape);
    expect(hidden(cellsOf(getAllByRole("row")[1]))).toEqual(shape);
  });

  test("표 폭이 600px 미만이면 행은 제목 한 줄 아래에 나머지를 두고 열 이름은 화면 읽기용으로만 남긴다", () => {
    const { getAllByRole, getByRole } = overviewRow(SESSION);
    const [header, row] = getAllByRole("row");
    expect(header?.className).toContain("[@container(width<600px)]:sr-only");
    expect(getByRole("table").className).toContain(
      "[@container(width<600px)]:grid-cols-[minmax(0,1fr)_auto_auto]!",
    );
    expect(row?.className).toContain("grid-cols-subgrid");
    const title = getByRole("link", { name: SESSION.id }).closest(
      '[role="cell"]',
    );
    expect(title?.className).toContain(
      "[@container(width<600px)]:col-span-full",
    );
  });
});

describe("rows' relative time", () => {
  afterEach(() => jest.useRealTimers());

  const at = "2026-10-21T01:00:00.000Z";
  const shown = (container: HTMLElement) =>
    container.querySelector("time")?.textContent;

  test("now가 없으면 행이 분마다 다시 읽어 'N분 전'이 늘어난다", () => {
    jest.useFakeTimers({ now: new Date(at) });
    const row = render(
      <SessionRow
        session={{ ...SESSION, last_event_at: at }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={ROW_MESSAGES}
      />,
    );
    expect(shown(row.container)).toBe("방금");
    act(() => jest.advanceTimersByTime(3 * 60_000));
    expect(shown(row.container)).toBe("3분 전");
  });

  test("now를 주면 그 시각부터 세고 정확한 시각은 툴팁 설명으로 둔다", () => {
    const { container } = render(
      <SessionRow
        session={{ ...SESSION, last_event_at: at }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={ROW_MESSAGES}
        now={Date.parse(at) + 12 * 60_000}
      />,
    );
    const time = container.querySelector("time") as HTMLElement;
    expect(time.textContent).toBe("12분 전");
    expect(time.tabIndex).toBe(0);
    expect(
      document.getElementById(time.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("2026년 10월 21일 10:00:00 GMT+9");
  });
});

describe("StatusLabel dot", () => {
  test("점은 배지 없이 색 점과 글자이고 작업 중은 회전 테다", () => {
    const { container } = render(
      <>
        <StatusLabel
          appearance="dot"
          axis="session"
          state="needs_input"
          detail="12분"
        />
        <StatusLabel appearance="dot" axis="session" state="running" />
      </>,
    );
    const [waiting, running] = [...container.children] as HTMLElement[];
    expect(waiting?.className).not.toContain("werft-status");
    expect(waiting?.getAttribute("data-tone")).toBe("attention");
    expect(waiting?.textContent).toBe("작업: 답변 대기 · 12분");
    const ring = running?.querySelector('[aria-hidden="true"]');
    expect(ring?.getAttribute("data-animated")).toBe("true");
    expect(ring?.className).toContain("border-r-transparent");
  });

  test("기본은 지금처럼 배지다", () => {
    const { container } = render(<StatusLabel axis="session" state="idle" />);
    expect(container.querySelector(".werft-status")).toBeTruthy();
  });
});
