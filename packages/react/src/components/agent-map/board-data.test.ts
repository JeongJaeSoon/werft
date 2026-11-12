import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "@werft-ai/contracts";

import { buildRunTree, type RunTreeFrame } from "../../run-tree.ts";
import { arrangeBoard, mapSessionOf, runNodesOf } from "./board-data.ts";
import { laneOf } from "./lane-board.tsx";
import { AGENT_MAP_MESSAGES } from "./messages.ts";
import type { MapSession } from "./types.ts";

const KO = AGENT_MAP_MESSAGES.ko;
const NOW = Date.parse("2026-10-25T01:30:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
    title: "결제 웹훅 재시도 로직 정리",
    agent: { id: "agt_1", name: "백엔드 도우미", release_version_no: 1 },
    created_by: null,
    channel: "web",
    revision: 1,
    admission_state: "admitted",
    status: "running",
    runtime: null,
    model: "claude-opus-5-5",
    repository_id: null,
    repository: null,
    current_turn_id: null,
    queued_turn_count: 0,
    last_event_at: ago(1),
    created_at: ago(30),
    updated_at: ago(1),
    ...over,
  } as SessionSummary;
}

const activity = (
  over: Partial<NonNullable<SessionSummary["activity"]>>,
): NonNullable<SessionSummary["activity"]> => ({
  last: null,
  tool_count: 0,
  error_count: 0,
  subagent_count: 0,
  current_tool: null,
  window: { events: 0, complete: true, since: null },
  ...over,
});

describe("mapSessionOf", () => {
  test("a queued session with nothing done yet says it waits for a worker", () => {
    const card = mapSessionOf(
      summary({ status: "queued", activity: activity({}) }),
      NOW,
      KO,
    );
    expect(card.note).toBe("작업자 배정을 기다리는 중");
    expect(card.toolCount).toBe(0);
    expect(card.pending).toBeUndefined();
  });

  test("the card reads its counts and its newest line from the activity", () => {
    const card = mapSessionOf(
      summary({
        repository: { id: "r", full_name: "o/n", branch: "fix/webhook-retry" },
        activity: activity({
          last: { kind: "tool", name: "Bash", target: "bun test" },
          tool_count: 41,
          error_count: 1,
          subagent_count: 1,
        }),
      }),
      NOW,
      KO,
    );
    expect(card).toMatchObject({
      agent: "백엔드 도우미",
      branch: "fix/webhook-retry",
      note: "Bash · bun test",
      toolCount: 41,
      errorCount: 1,
      subagentCount: 1,
    });
  });

  test("a permission waits as its call; a question as its prompt", () => {
    const waiting = (request: {
      kind: "permission" | "question";
      prompt: string | null;
    }) =>
      mapSessionOf(
        summary({
          status: "needs_input",
          activity: activity({
            current_tool: {
              id: "toolu_1",
              name: request.kind === "permission" ? "Bash" : "AskUserQuestion",
              target:
                request.kind === "permission"
                  ? "git push origin fix/webhook-retry"
                  : "",
              state: "waiting",
              since: ago(12.5),
              request,
            },
          }),
        }),
        NOW,
        KO,
      ).pending;
    expect(waiting({ kind: "permission", prompt: null })).toEqual({
      kind: "approval",
      tool: "Bash · git push origin fix/webhook-retry",
      waitedMinutes: 12,
    });
    expect(
      waiting({ kind: "question", prompt: "'workspace'를 어떻게 옮길까요?" }),
    ).toEqual({
      kind: "question",
      tool: "질문 · 'workspace'를 어떻게 옮길까요?",
      waitedMinutes: 12,
    });
    expect(waiting({ kind: "question", prompt: null })?.tool).toBe("질문");
  });

  test("a waiting session whose request the activity does not show still waits", () => {
    const card = mapSessionOf(
      summary({
        status: "needs_input",
        last_event_at: ago(7.5),
        activity: activity({}),
      }),
      NOW,
      KO,
    );
    expect(card.pending).toEqual({
      kind: "request",
      tool: "답할 요청",
      waitedMinutes: 7,
    });
  });

  test("a waiting card says what it waits on, not its last line", () => {
    const note = (current: {
      name: string;
      target: string;
      request: { kind: "permission" | "question"; prompt: string | null };
    }) =>
      mapSessionOf(
        summary({
          status: "needs_input",
          activity: activity({
            last: { kind: "tool", name: "Read", target: "old.ts" },
            current_tool: {
              id: "toolu_1",
              state: "waiting",
              since: ago(2),
              ...current,
            },
          }),
        }),
        NOW,
        KO,
      ).note;
    expect(
      note({
        name: "AskUserQuestion",
        target: "",
        request: { kind: "question", prompt: "어느 언어로 번역할까요?" },
      }),
    ).toBe("질문 · 어느 언어로 번역할까요?");
    expect(
      note({
        name: "Bash",
        target: "npm test",
        request: { kind: "permission", prompt: null },
      }),
    ).toBe("Bash · npm test");
  });

  test("a session that waits on a recovery decision says so and stays in the attention lane", () => {
    const working = activity({
      last: { kind: "tool", name: "Bash", target: "bun test" },
    });
    // A terminate that cut a running turn leaves it stopped, not failed.
    for (const status of ["stopped", "failed"] as const) {
      const waiting = mapSessionOf(
        summary({
          status,
          admission_state: "recovery_required",
          activity: working,
        }),
        NOW,
        KO,
      );
      expect(waiting.note).toBe("복구 결정을 기다리는 중");
      expect(laneOf(waiting)).toBe("attention");
    }
    const ended = mapSessionOf(
      summary({
        status: "stopped",
        admission_state: "stopped",
        activity: working,
      }),
      NOW,
      KO,
    );
    expect(ended.note).toBe("Bash · bun test");
    expect(laneOf(ended)).toBe("done");
  });

  test("a call that is only running is not a request", () => {
    const card = mapSessionOf(
      summary({
        activity: activity({
          current_tool: {
            id: "toolu_1",
            name: "Bash",
            target: "make",
            state: "running",
            since: ago(1),
            request: null,
          },
        }),
      }),
      NOW,
      KO,
    );
    expect(card.pending).toBeUndefined();
  });
});

const T0 = Date.parse("2026-10-25T01:00:00.000Z");
let row = 0;
function use(
  seconds: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null = null,
): RunTreeFrame {
  row += 1;
  return {
    id: `ev_${row.toString(36)}`,
    occurredAt: new Date(T0 + seconds * 1000).toISOString(),
    turnId: null,
    payload: {
      event: "tool_use",
      data: {
        type: "assistant",
        tool_call: { id, name, input },
        parent_tool_use_id: parent,
      },
    },
  };
}
function result(seconds: number, id: string, isError = false): RunTreeFrame {
  row += 1;
  return {
    id: `ev_${row.toString(36)}`,
    occurredAt: new Date(T0 + seconds * 1000).toISOString(),
    turnId: null,
    payload: {
      event: "tool_result",
      data: { tool_result: { tool_call_id: id, is_error: isError, text: "" } },
    },
  };
}

describe("runNodesOf", () => {
  const frames = [
    use(1, "read-1", "Read", { file_path: "chart.tsx" }),
    result(2, "read-1"),
    use(3, "bash-1", "Bash", { command: "bun run build" }),
    result(4, "bash-1", true),
    ...["막대 차트", "선 차트", "범례"].map((description, i) =>
      use(5 + i, `task-${i}`, "Task", {
        subagent_type: "Explore",
        description,
      }),
    ),
    use(9, "grep-1", "Grep", { pattern: "aria-label" }, "task-0"),
    use(10, "read-2", "Read", { file_path: "bar-chart.tsx" }, "task-0"),
    result(11, "read-2"),
  ];

  test("rows read the run tree; each shows its newest calls first", () => {
    const nodes = runNodesOf(buildRunTree(frames));
    expect(nodes.map((node) => node.label)).toEqual([
      null,
      "Explore · 막대 차트",
      "Explore · 선 차트",
      "Explore · 범례",
    ]);
    expect(nodes[1]?.tools.map((tool) => [tool.name, tool.state])).toEqual([
      ["Read", "ok"],
      ["Grep", "running"],
    ]);
  });

  test("a run's spawns of one type share a chip, as the design draws it", () => {
    const [own] = runNodesOf(buildRunTree(frames));
    expect(
      own?.tools.map((tool) => [tool.name, tool.target, tool.state]),
    ).toEqual([
      ["Task", "Explore × 3", "running"],
      ["Bash", "bun run build", "error"],
      ["Read", "chart.tsx", "ok"],
    ]);
    expect(own?.hiddenTools).toBeUndefined();
  });

  test("calls past the row's chips are counted, not dropped", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      use(20 + i, `r-${i}`, "Read", { file_path: `f${i}` }),
    );
    const [own] = runNodesOf(buildRunTree(many));
    expect(own?.tools.map((tool) => tool.target)).toEqual([
      "f19",
      "f18",
      "f17",
    ]);
    expect(own?.hiddenTools).toBe(17);
  });
});

function card(id: string, status: MapSession["status"]): MapSession {
  return {
    id,
    title: id,
    agent: "문서 봇",
    status,
    model: "",
    branch: null,
    lastEventAt: ago(1),
    note: "",
    toolCount: 0,
    errorCount: 0,
    subagentCount: 0,
  };
}

describe("arrangeBoard", () => {
  test("the first read places every card and marks none", () => {
    const first = arrangeBoard([card("a", "running")], null, false);
    expect(first.sessions).toEqual([card("a", "running")]);
    expect(first.changes).toEqual([]);
    expect(first.added).toBe(0);
  });

  test("a card whose status moved keeps its lane, marked, until tidied", () => {
    const first = arrangeBoard(
      [card("a", "running"), card("b", "running")],
      null,
      false,
    );
    const second = arrangeBoard(
      [card("a", "needs_input"), card("b", "running"), card("c", "queued")],
      first.memory,
      false,
    );
    expect(second.sessions[0]).toMatchObject({
      id: "a",
      pinnedLane: "running",
      fresh: true,
    });
    expect(second.sessions[1]?.fresh).toBeUndefined();
    expect(second.sessions[2]).toMatchObject({ id: "c", fresh: true });
    expect(second.changes).toEqual([
      { title: "a", from: "running", to: "needs_input" },
    ]);
    expect(second.added).toBe(1);

    // A later read with nothing new keeps the pin and says nothing.
    const third = arrangeBoard(
      [card("a", "needs_input"), card("b", "running"), card("c", "queued")],
      second.memory,
      false,
    );
    expect(third.sessions[0]?.pinnedLane).toBe("running");
    expect(third.changes).toEqual([]);

    const tidied = arrangeBoard(
      [card("a", "needs_input"), card("b", "running"), card("c", "queued")],
      third.memory,
      true,
    );
    expect(tidied.sessions[0]?.pinnedLane).toBeUndefined();
  });

  test("an ended session stays in its lane until tidied", () => {
    const first = arrangeBoard([card("a", "running")], null, false);
    const ended = arrangeBoard([card("a", "stopped")], first.memory, false);
    expect(ended.sessions[0]?.pinnedLane).toBe("running");
  });

  test("an ended session that resumes comes back to its lane", () => {
    const first = arrangeBoard([card("a", "stopped")], null, false);
    const resumed = arrangeBoard([card("a", "running")], first.memory, false);
    expect(resumed.sessions[0]?.pinnedLane).toBeUndefined();
    expect(resumed.sessions[0]?.fresh).toBe(true);
  });
});
