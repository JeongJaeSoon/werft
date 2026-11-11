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
  SESSION_OVERVIEW_HOME_TEMPLATE,
  SESSION_OVERVIEW_NARROW_TEMPLATE,
  SESSION_OVERVIEW_TEMPLATE,
  SessionOverviewRow,
  SessionOverviewTable,
} = await import("./session-overview.tsx");
const { StatusLabel } = await import("../status/status-label.tsx");
const { StageIndicator } = await import("./stage-indicator.tsx");
const { Timeline } = await import("./timeline.tsx");

// One track per column, each minmax(0,…) or fixed so no cell widens the table.
const TRACK = /^(minmax\((0|\d+px),[\d.]+fr\)|\d+px)$/;
test.each([
  [SESSION_TEMPLATE, 5],
  [SESSION_NARROW_TEMPLATE, 3],
  [SESSION_OVERVIEW_TEMPLATE, 6],
  [SESSION_OVERVIEW_HOME_TEMPLATE, 5],
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
  statusAxis: "work",
  noRepository: "no repository",
  moreRepositories: (count: number) => `more:${count}`,
  unknown: "—",
  recent: "recent",
};

describe("SessionOverviewRow", () => {
  test("제목이 있으면 행을 여는 링크가 제목으로 읽히고 그 아래 짧은 ID 8자리를 둔다", () => {
    const { getByRole, getByText } = render(
      <SessionOverviewRow
        session={{ ...SESSION, title: "hello.txt 만들고 commit" }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={OVERVIEW_MESSAGES}
        statusDetail="12분"
        renderTime={(at) => <time dateTime={at}>12분 전</time>}
      />,
    );
    const link = getByRole("link", { name: "hello.txt 만들고 commit" });
    expect(link.dataset.slot).toBe("grid-table-row-opener");
    expect(link.getAttribute("title")).toBe("hello.txt 만들고 commit");
    expect(getByText("hello.txt 만들고 commit").className).not.toContain(
      "font-mono",
    );
    expect(getByText(SESSION.id.slice(0, 8)).getAttribute("title")).toBe(
      SESSION.id,
    );
    expect(getByText("model-claude-default")).toBeTruthy();
    expect(getByText("no repository")).toBeTruthy();
    const row = link.closest('[role="row"]') as HTMLElement;
    expect(row.textContent).toContain("work: status:running · 12분");
    expect(
      row.querySelector("[data-slot=status-dot]")?.getAttribute("data-status"),
    ).toBe("run");
    expect(row.querySelector("time")?.textContent).toBe("12분 전");
    // A caller's time keeps the ellipsis the column has always given it.
    expect(row.querySelector("time")?.parentElement?.className).toContain(
      "truncate",
    );
  });

  test("멈춘 세션의 점은 다른 화면처럼 쉬는 점이고 문구는 그대로다", () => {
    const { container } = render(
      <SessionOverviewRow
        session={{ ...SESSION, status: "stopped" }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={OVERVIEW_MESSAGES}
      />,
    );
    const dot = container.querySelector("[data-slot=status-dot]");
    expect(dot?.getAttribute("data-status")).toBe("idle");
    expect(container.textContent).toContain("work: status:stopped");
  });

  test("상태 뒤 설명은 노드를 받아 툴팁과 포커스를 행 링크 위에 둔다", () => {
    const { getByText, getByRole } = render(
      <SessionOverviewRow
        session={{ ...SESSION, status: "needs_input" }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={OVERVIEW_MESSAGES}
        statusDetail={
          // biome-ignore lint/a11y/noNoninteractiveTabindex: home's wait tooltip trigger, focused for its exact time
          <time dateTime="2026-11-02T00:00:00Z" tabIndex={0} title="exact">
            12분
          </time>
        }
      />,
    );
    const time = getByText("12분");
    expect(time.tagName).toBe("TIME");
    // Raised above the row's opener, so hover and focus reach it.
    expect(time.parentElement?.className).toContain("relative");
    time.focus();
    expect(document.activeElement === time).toBe(true);
    const row = getByRole("row");
    expect(row.textContent).toContain("work: status:needs_input · 12분");
  });

  test("저장소는 표시 이름 · branch로, 이름이 없으면 —로, 옛 서버면 catalog key로 보인다", () => {
    const cases = [
      [
        { id: "demo", full_name: "agent/sample-app", branch: "main" },
        "demo",
        "agent/sample-app · main",
      ],
      [{ id: null, full_name: null, branch: "dev" }, null, "— · dev"],
      [null, "demo", "demo"],
    ] as const;
    for (const [repository, repository_id, shown] of cases) {
      const { getByTitle, unmount } = render(
        <SessionOverviewRow
          session={{ ...SESSION, repository, repository_id }}
          renderLink={(link) => <a href="/sessions/abc" {...link} />}
          messages={OVERVIEW_MESSAGES}
        />,
      );
      expect(getByTitle(shown).textContent).toBe(shown);
      unmount();
    }
  });

  describe("저장소 여러 개", () => {
    const own = { id: "web", full_name: "acme/web", branch: "main" } as const;
    const attached = [
      { id: "zed", full_name: "acme/zed" },
      { id: "api", full_name: "acme/api" },
    ];
    const renderRow = (session: SessionSummary) =>
      render(
        <SessionOverviewRow
          session={session}
          renderLink={(link) => <a href="/sessions/abc" {...link} />}
          messages={OVERVIEW_MESSAGES}
        />,
      );

    test("id 순 첫 저장소와 +N 단추를 보이고, 단추의 설명이 전체 목록이다", () => {
      const { getByRole, container } = renderRow({
        ...SESSION,
        repository_id: "web",
        repository: own,
        attached_repositories: attached,
      });
      // id order, not the session's own first: api, web, zed.
      const first = container.querySelector("code");
      expect(first?.textContent).toBe("acme/api");
      const more = getByRole("button", { name: "+2 more:2" });
      expect(more.textContent).toBe("+2");
      expect(more.getAttribute("type")).toBe("button");
      // Above the row's opener, so it takes its own hover and focus.
      expect(more.className).toContain("relative");
      const described = more.getAttribute("aria-describedby");
      const description = document.getElementById(described ?? "");
      expect(description?.textContent).toBe("acme/apiacme/web · mainacme/zed");
      more.focus();
      expect(document.activeElement === more).toBe(true);
    });

    test("자기 저장소 없이 추가만 있어도 저장소 있음으로 읽는다", () => {
      const { queryByText, getByRole, container } = renderRow({
        ...SESSION,
        repository_id: null,
        repository: null,
        attached_repositories: attached,
      });
      expect(queryByText("no repository")).toBeNull();
      expect(container.querySelector("code")?.textContent).toBe("acme/api");
      expect(getByRole("button", { name: "+1 more:1" })).toBeTruthy();
    });

    test("하나면 단추가 없고, 하나도 없으면 단추 없이 문구만 둔다", () => {
      const one = renderRow({
        ...SESSION,
        repository_id: "web",
        repository: own,
      });
      expect(one.queryByRole("button")).toBeNull();
      one.unmount();
      const none = renderRow({ ...SESSION, attached_repositories: [] });
      expect(none.queryByRole("button")).toBeNull();
      expect(none.getByText("no repository")).toBeTruthy();
    });

    test("옛 서버가 id만 보내면 id가 이름을 대신하고, 같은 id는 한 번만 센다", () => {
      const { getByRole, container } = renderRow({
        ...SESSION,
        repository_id: "web",
        repository: own,
        attached_repository_ids: ["web", "api", "api"],
      });
      expect(container.querySelector("code")?.textContent).toBe("api");
      expect(getByRole("button", { name: "+1 more:1" })).toBeTruthy();
    });
  });

  test("제목이 없으면 짧은 ID를 mono로 보이고 링크 이름은 전체 ID다", () => {
    const { getByRole, getByText, queryAllByText } = render(
      <SessionOverviewRow
        session={{ ...SESSION, runtime: null, repository_id: "demo" }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={OVERVIEW_MESSAGES}
      />,
    );
    const link = getByRole("link", { name: SESSION.id });
    expect(getByText(SESSION.id.slice(0, 8)).className).toContain("font-mono");
    // No agent column asked for: the model column it had, a dash without a
    // runtime rather than a guess.
    expect(queryAllByText("—")).toHaveLength(1);
    expect(queryAllByText(SESSION.id.slice(0, 8))).toHaveLength(1);
    // No last event yet: the time is the creation time, absolute.
    expect(link.closest('[role="row"]')?.querySelector("time")?.dateTime).toBe(
      SESSION.created_at,
    );
  });

  test("에이전트 위에 모델, 시작한 사람 열에 표시 이름을 두고 여는 링크 이름은 messages.open이다", () => {
    const head = {
      session: "세션",
      status: "상태",
      model: "모델",
      agent: "에이전트 · 모델",
      repository: "저장소",
      startedBy: "시작한 사람",
      recent: "최근",
    };
    const { getAllByRole, getByRole, rerender } = render(
      <SessionOverviewTable label="sessions" messages={head}>
        <SessionOverviewRow
          session={{
            ...SESSION,
            title: "배포 점검",
            agent: {
              id: "0192f0c4-7d3a-7b4e-9f00-0000000000a1",
              name: "Release helper",
              release_version_no: 3,
              release_label: "2026-10-30_14:30:28",
              release_is_active: true,
            },
            created_by: {
              user_id: "0192f0c4-7d3a-7b4e-9f00-0000000000b1",
              display_name: "김하나",
            },
          }}
          renderLink={(link) => <a href="/sessions/abc" {...link} />}
          messages={{
            ...OVERVIEW_MESSAGES,
            open: (name) => `세션 열기: ${name}`,
          }}
        />
      </SessionOverviewTable>,
    );
    expect(getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "세션",
      "상태",
      "에이전트 · 모델",
      "저장소",
      "시작한 사람",
      "최근",
    ]);
    const link = getByRole("link", { name: "세션 열기: 배포 점검" });
    const cells = [
      ...(link.closest('[role="row"]')?.querySelectorAll('[role="cell"]') ??
        []),
    ];
    expect(cells).toHaveLength(6);
    expect(cells[2]?.textContent).toBe("Release helpermodel-claude-default");
    expect(cells[4]?.textContent).toBe("김하나");
    rerender(
      <SessionOverviewTable label="sessions" messages={head}>
        <SessionOverviewRow
          session={SESSION}
          renderLink={(link) => <a href="/sessions/abc" {...link} />}
          messages={OVERVIEW_MESSAGES}
        />
      </SessionOverviewTable>,
    );
    // A service key's session or one from before people were recorded.
    const row = getByRole("link", { name: SESSION.id }).closest('[role="row"]');
    const plain = row?.querySelectorAll('[role="cell"]');
    expect(plain?.[4]?.textContent).toBe("—");
    // No agent: a dash over the model; no model: no second line.
    rerender(
      <SessionOverviewTable label="sessions" messages={head}>
        <SessionOverviewRow
          session={{ ...SESSION, model: null }}
          renderLink={(link) => <a href="/sessions/abc" {...link} />}
          messages={OVERVIEW_MESSAGES}
        />
      </SessionOverviewTable>,
    );
    expect(
      getByRole("link", { name: SESSION.id })
        .closest('[role="row"]')
        ?.querySelectorAll('[role="cell"]')[2]?.textContent,
    ).toBe("—");
  });

  test("표 머리는 값이 있는 다섯 열이고 좁은 폭에서 저장소를 숨긴다", () => {
    const { getAllByRole } = render(
      <SessionOverviewTable
        label="sessions"
        messages={{
          session: "세션",
          status: "상태",
          model: "모델",
          repository: "저장소",
          recent: "최근",
        }}
      >
        {null}
      </SessionOverviewTable>,
    );
    const heads = getAllByRole("columnheader");
    expect(heads.map((head) => head.textContent)).toEqual([
      "세션",
      "상태",
      "모델",
      "저장소",
      "최근",
    ]);
    expect(
      heads.filter((head) => head.className.includes("hidden")),
    ).toHaveLength(1);
  });

  test("표 폭이 600px 미만이면 행은 제목 한 줄 아래에 나머지를 두고 열 이름은 화면 읽기용으로만 남긴다", () => {
    const { getAllByRole, getByRole } = render(
      <SessionOverviewTable
        label="sessions"
        messages={{
          session: "세션",
          status: "상태",
          model: "모델",
          repository: "저장소",
          recent: "최근",
        }}
      >
        <SessionOverviewRow
          session={SESSION}
          renderLink={(link) => <a href="/sessions/abc" {...link} />}
          messages={OVERVIEW_MESSAGES}
        />
      </SessionOverviewTable>,
    );
    const [header, row] = getAllByRole("row");
    expect(header?.className).toContain("[@container(width<600px)]:sr-only");
    expect(row?.className).toContain(
      "[@container(width<600px)]:grid-cols-[auto_minmax(0,1fr)_auto]!",
    );
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
    const overview = render(
      <SessionOverviewRow
        session={{ ...SESSION, last_event_at: at }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={OVERVIEW_MESSAGES}
      />,
    );
    const row = render(
      <SessionRow
        session={{ ...SESSION, last_event_at: at }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={ROW_MESSAGES}
      />,
    );
    expect(shown(overview.container)).toBe("방금");
    expect(shown(row.container)).toBe("방금");
    act(() => jest.advanceTimersByTime(3 * 60_000));
    expect(shown(overview.container)).toBe("3분 전");
    expect(shown(row.container)).toBe("3분 전");
  });

  test("now를 주면 그 시각부터 세고 정확한 시각은 툴팁 설명으로 둔다", () => {
    const { container } = render(
      <SessionOverviewRow
        session={{ ...SESSION, last_event_at: at }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={OVERVIEW_MESSAGES}
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
