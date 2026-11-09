import { describe, expect, test } from "bun:test";
import { presentTurnEvent, type TurnEventMessage } from "@werft-ai/contracts";

import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type { TimelineEntry, TimelineMessages } from "./timeline.tsx";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists.
const { Timeline } = await import("./timeline.tsx");
const { formatExactTime } = await import("@werft-ai/ui");

function formatMessage({ key, params }: TurnEventMessage): string {
  return params ? `${key}${JSON.stringify(params)}` : key;
}

const MESSAGES: TimelineMessages = {
  label: "events",
  empty: "no events",
  connecting: "connecting",
  closed: "closed",
  turn: (turnId) => `turn ${turnId}`,
  kind: (kind) => `kind:${kind}`,
  folded: (count) => `${count} events`,
  running: "running",
};

const START = Date.parse("2026-10-21T01:00:00.000Z");
let sequence = 0;
function entry(
  event: string,
  data: unknown,
  {
    turnId = "t1",
    at = 0,
    toolCallId,
  }: { turnId?: string | null; at?: number; toolCallId?: string } = {},
): TimelineEntry {
  sequence += 1;
  return {
    id: `e${sequence}`,
    occurredAt: new Date(START + at * 1000).toISOString(),
    turnId,
    presentation: presentTurnEvent({ event, data }),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

const reply = (text: string, options?: Parameters<typeof entry>[2]) =>
  entry("assistant", { text }, options);
const call = (id: string, options?: Parameters<typeof entry>[2]) =>
  entry(
    "tool_use",
    { tool_call: { id, name: "Bash", input: { command: "ls" } } },
    { toolCallId: id, ...options },
  );
const result = (
  id: string,
  isError = false,
  options?: Parameters<typeof entry>[2],
) =>
  entry(
    "tool_result",
    { tool_result: { tool_call_id: id, is_error: isError, text: "out" } },
    { toolCallId: id, ...options },
  );
const permission = (id: string, options?: Parameters<typeof entry>[2]) =>
  entry(
    "question",
    {
      kind: "permission",
      tool: "Bash",
      tool_use_id: id,
      input: { command: "ls" },
    },
    { toolCallId: id, ...options },
  );
const status = (phase: string, options?: Parameters<typeof entry>[2]) =>
  entry("status", { phase }, options);

const rows = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>("li[data-kind]"),
];

describe("Timeline turn 묶음", () => {
  test("turn마다 머리 아래에 묶고, 토큰은 그 turn의 result 이벤트에서 읽는다", () => {
    const { getByRole } = render(
      <Timeline
        entries={[
          reply("one", { turnId: "a" }),
          entry(
            "result",
            {
              turn: {
                outcome: "success",
                is_error: false,
                terminal_reason: null,
                tokens: 1540,
              },
            },
            { turnId: "a" },
          ),
          reply("two", { turnId: "b" }),
          reply("loose", { turnId: null }),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    const list = getByRole("list", { name: "events" });
    const top = [...list.children] as HTMLElement[];
    expect(top.map((item) => item.dataset.slot ?? item.dataset.kind)).toEqual([
      "timeline-turn",
      "timeline-turn",
      "agent",
    ]);
    const [first, second] = top;
    const firstGroup = getByRole("list", { name: /^turn a/ });
    expect(rows(firstGroup).map((row) => row.textContent)).toEqual([
      expect.stringContaining("one"),
      expect.stringContaining("session.event.result.success"),
    ]);
    expect(first?.firstElementChild?.textContent).toContain(
      'session.event.result.tokens{"count":1540}',
    );
    expect(second?.firstElementChild?.textContent).toContain("turn b");
    expect(second?.firstElementChild?.textContent).not.toContain("tokens");
    expect(top[2]?.textContent).toContain("loose");
  });

  test("prompt 슬롯은 turn 머리와 그 줄 목록 사이에 그리고, null이면 아무것도 두지 않는다", () => {
    render(
      <Timeline
        entries={[reply("one", { turnId: "a" }), reply("two", { turnId: "b" })]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
        prompt={(turnId) =>
          turnId === "a" ? <p data-testid="asked">asked a</p> : null
        }
      />,
    );
    const [first, second] = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="timeline-turn"]'),
    ];
    expect(
      [...(first?.children ?? [])].map((child) => child.tagName.toLowerCase()),
    ).toEqual(["div", "div", "ol"]);
    expect(first?.children[1]?.textContent).toBe("asked a");
    expect(
      [...(second?.children ?? [])].map((child) => child.tagName.toLowerCase()),
    ).toEqual(["div", "ol"]);
  });

  test("turn 없는 줄이 한 turn 사이에 끼어도 turn은 한 묶음이다", () => {
    const { getByRole } = render(
      <Timeline
        entries={[
          status("running", { turnId: "a" }),
          entry(
            "system",
            { engine_event: { name: "init", category: "started" } },
            { turnId: null },
          ),
          entry(
            "result",
            {
              turn: {
                outcome: "success",
                is_error: false,
                terminal_reason: null,
                tokens: 2,
              },
            },
            { turnId: "a" },
          ),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    expect(
      document.querySelectorAll('[data-slot="timeline-turn"]'),
    ).toHaveLength(1);
    expect(rows(getByRole("list", { name: /^turn a/ }))).toHaveLength(1);
    expect(
      document.querySelector('[data-slot="timeline-turn"]')?.textContent,
    ).toContain('session.event.result.tokens{"count":2}');
  });
});

describe("Timeline 도구 호출과 결과", () => {
  test("같은 id의 결과는 호출 행 안에 들어가고, 짝 없는 호출은 실행 중이다", () => {
    render(
      <Timeline
        entries={[call("c1"), reply("between"), result("c1"), call("c2")]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    const [paired, between, open] = rows();
    expect(rows()).toHaveLength(3);
    expect(paired?.dataset.kind).toBe("tool");
    expect(paired?.textContent).toContain("session.event.kind.toolUse");
    expect(paired?.textContent).toContain("session.event.toolResult.unknown");
    expect(paired?.textContent).not.toContain("running");
    expect(between?.textContent).toContain("between");
    expect(open?.textContent).toContain("running");
  });

  test("답을 기다리는 요청이 막은 호출은 실행 중이 아니라 답변 대기다", () => {
    render(
      <Timeline
        entries={[call("c1"), call("c2")]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, waiting: "waiting" }}
        held={new Set(["c1"])}
        now={START}
      />,
    );
    const [held, open] = rows();
    expect(held?.textContent).toContain("waiting");
    expect(held?.textContent).not.toContain("running");
    expect(
      [...(held?.querySelectorAll("span") ?? [])].find(
        (span) => span.textContent === "waiting",
      )?.className,
    ).toContain("--werft-tone-attention-fg");
    expect(open?.textContent).toContain("running");
    expect(open?.textContent).not.toContain("waiting");
  });

  test("실행 중인 호출만 진행 원이 돌고, 끝났거나 답을 기다리는 호출은 멈춘 도구 아이콘이다", () => {
    render(
      <Timeline
        entries={[call("c1"), result("c1"), call("c2"), call("c3")]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, waiting: "waiting" }}
        held={new Set(["c3"])}
        now={START}
      />,
    );
    const icon = (row: HTMLElement | undefined) =>
      row?.querySelector('[role="img"] svg')?.getAttribute("class") ?? "";
    const [done, running, held] = rows();
    expect(icon(running)).toContain("lucide-loader-circle");
    expect(icon(running)).toContain("animate-spin");
    // Reduced motion stops the ring; the "running" label still says it.
    expect(icon(running)).toContain("motion-reduce:animate-none");
    expect(running?.textContent).toContain("running");
    for (const still of [done, held]) {
      expect(icon(still)).not.toContain("lucide-loader-circle");
      expect(icon(still)).not.toContain("animate-spin");
      expect(icon(still)).toContain("lucide-wrench");
    }
  });

  test("막힌 호출도 결과가 오면 대기도 실행 중도 아니다", () => {
    render(
      <Timeline
        entries={[call("c1"), result("c1", true)]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, waiting: "waiting" }}
        held={new Set(["c1"])}
        now={START}
      />,
    );
    const [row] = rows();
    expect(row?.textContent).not.toContain("waiting");
    expect(row?.textContent).not.toContain("running");
  });

  test("호출 행에 들어간 결과도 제 시각을 키보드로 닿게 둔다", () => {
    render(
      <Timeline
        entries={[call("c1", { at: 0 }), result("c1", false, { at: 120 })]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        locale="en"
        now={START + 5 * 60_000}
      />,
    );
    const [row] = rows();
    const times = [...(row?.querySelectorAll("time") ?? [])];
    expect(times.map((time) => time.getAttribute("dateTime"))).toEqual([
      new Date(START).toISOString(),
      new Date(START + 120_000).toISOString(),
    ]);
    expect(times[1]?.textContent).toBe("3 min ago");
    expect(times[1]?.tabIndex).toBe(0);
  });

  test("실패한 결과는 호출 행을 빨간 실패 원과 이름·빨간 글자로 바꾼다", () => {
    render(
      <Timeline
        entries={[call("c1"), result("c1", true)]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    const [row] = rows();
    expect(row?.dataset.kind).toBe("error");
    expect(row?.dataset.error).toBe("true");
    const icon = row?.querySelector('[role="img"]');
    expect(icon?.getAttribute("aria-label")).toBe("kind:error");
    expect(icon?.querySelector("svg")?.getAttribute("class")).not.toContain(
      "animate-spin",
    );
    expect(icon?.className).toContain("--werft-tone-danger-bg");
    expect(icon?.className).toContain("--werft-tone-danger-fg");
    expect(row?.querySelector(".text-destructive")?.textContent).toContain(
      "session.event.toolResult.error",
    );
  });

  test("호출 → 권한 요청 → 결과로 저장된 순서를 호출 행 안에서 그 순서대로 그린다", () => {
    // R2's repro: the result arrives after the request that let the call run.
    render(
      <Timeline
        entries={[
          call("c1", { at: 0 }),
          permission("c1", { at: 1 }),
          result("c1", false, { at: 30 }),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    expect(rows()).toHaveLength(1);
    const text = rows()[0]?.textContent ?? "";
    const at = (part: string) => text.indexOf(part);
    expect(at("session.event.kind.toolUse")).toBeGreaterThanOrEqual(0);
    expect(at("session.event.kind.permission")).toBeGreaterThan(
      at("session.event.kind.toolUse"),
    );
    expect(at("session.event.toolResult.unknown")).toBeGreaterThan(
      at("session.event.kind.permission"),
    );
    const request = rows()[0]?.querySelector("[data-slot='timeline-request']");
    expect(
      request?.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("kind:request");
    // It only repeats the call's own line, so it is not said twice.
    expect(text.split("Bash").length - 1).toBe(1);
  });

  test("결과 뒤에 온 요청도 그 호출 행에서 결과 아래에 두고, 짝 없는 요청은 제 행에 둔다", () => {
    render(
      <Timeline
        entries={[
          call("c1"),
          result("c1"),
          permission("c1"),
          result("c1"),
          permission("gone"),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    const [row, duplicate, alone] = rows();
    expect(rows()).toHaveLength(3);
    const text = row?.textContent ?? "";
    expect(
      text.indexOf("session.event.toolResult.unknown"),
    ).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("session.event.kind.permission")).toBeGreaterThan(
      text.indexOf("session.event.toolResult.unknown"),
    );
    // A second result does not end the call again; it keeps its own line.
    expect(duplicate?.textContent).toContain("session.event.kind.toolResult");
    expect(alone?.dataset.kind).toBe("request");
  });

  test("질문 요청도 그 호출 행 안에 선택지·답변 슬롯과 함께 그린다", () => {
    const asked: TimelineEntry = {
      ...entry(
        "question",
        {
          kind: "question",
          input: { questions: [{ prompt: "Deploy where first?" }] },
        },
        { toolCallId: "c1", at: 1 },
      ),
      requestId: "req_1",
      options: ["Staging", "Production"],
    };
    const { rerender } = render(
      <Timeline
        entries={[call("c1"), asked]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, options: "options" }}
        now={START}
      />,
    );
    expect(rows()).toHaveLength(1);
    const [row] = rows();
    expect(row?.textContent).toContain("session.event.kind.question");
    expect(row?.textContent).toContain("Deploy where first?");
    expect(row?.querySelector("ul[aria-label='options']")?.textContent).toBe(
      "StagingProduction",
    );
    rerender(
      <Timeline
        entries={[call("c1"), asked]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, options: "options" }}
        request={(id) => <form aria-label={`answer ${id}`} />}
        now={START}
      />,
    );
    expect(
      rows()[0]?.querySelector("form[aria-label='answer req_1']"),
    ).toBeTruthy();
  });

  test("요청이 결과 사이에 끼어도 결과가 온 호출은 실행 중도 대기도 아니다", () => {
    const { rerender } = render(
      <Timeline
        entries={[call("c1"), permission("c1")]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, waiting: "waiting" }}
        held={new Set(["c1"])}
        now={START}
      />,
    );
    expect(rows()[0]?.textContent).toContain("waiting");
    rerender(
      <Timeline
        entries={[call("c1"), permission("c1"), result("c1")]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, waiting: "waiting" }}
        now={START}
      />,
    );
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row?.textContent).not.toContain("running");
    expect(row?.textContent).not.toContain("waiting");
    expect(
      row?.querySelector('[role="img"] svg')?.getAttribute("class"),
    ).not.toContain("animate-spin");
  });

  test("대기 요청은 amber 원에 이름이 있고 라벨 글자로도 보인다", () => {
    render(
      <Timeline
        entries={[
          entry("question", { kind: "permission", tool: "Bash", input: {} }),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    const [row] = rows();
    const icon = row?.querySelector('[role="img"]');
    expect(icon?.getAttribute("aria-label")).toBe("kind:request");
    expect(icon?.className).toContain("--werft-tone-attention-bg");
    expect(row?.textContent).toContain("session.event.kind.permission");
  });
});

describe("Timeline 시각", () => {
  test("now에서 센 상대 시간을 보이고, 같은 글자가 이어지면 숨겨도 정확한 시각은 키보드로 닿는다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <Timeline
        entries={[
          reply("a", { at: 0 }),
          reply("b", { at: 20 }),
          reply("c", { at: 70 }),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        locale="en"
        now={START + 5 * 60_000 + 30_000}
      />,
    );
    expect(
      document.querySelector('[data-slot="timeline-turn"] time')?.textContent,
    ).toBe("5 min ago");
    const head = getByRole("list", { name: /^turn t1/ });
    // a and b read "5 min ago" as the head does; c reads differently.
    const [a, b, c] = rows(head);
    const shown = c?.querySelector("time");
    expect(shown?.className).not.toContain("sr-only");
    expect(shown?.textContent).toBe("4 min ago");
    const hidden = [a, b].map((row) => row?.querySelector("time"));
    for (const time of hidden) {
      expect(time?.className).toContain("sr-only");
      expect(time?.className).toContain("focus-visible:not-sr-only");
      const note = document.getElementById(
        time?.getAttribute("aria-describedby") ?? "",
      );
      expect(note?.textContent).toBe(
        formatExactTime(time?.getAttribute("dateTime") ?? "", "en"),
      );
    }
    // Every time is one Tab stop, the hidden ones included.
    await user.tab();
    expect(document.activeElement?.textContent).toBe("5 min ago");
    await user.tab();
    expect(document.activeElement === hidden[0]).toBe(true);
    await user.tab();
    expect(document.activeElement === hidden[1]).toBe(true);
    await user.tab();
    expect(document.activeElement === shown).toBe(true);
    await user.tab();
  });
});

test("turn 머리는 앞 줄과 같은 글자여도 시각을 보인다", () => {
  render(
    <Timeline
      entries={[
        reply("a", { turnId: "a", at: 0 }),
        reply("b", { turnId: "b", at: 10 }),
      ]}
      formatMessage={formatMessage}
      messages={MESSAGES}
      locale="en"
      now={START + 5 * 60_000 + 30_000}
    />,
  );
  const heads = [
    ...document.querySelectorAll('[data-slot="timeline-turn"] > div'),
  ];
  expect(heads.map((head) => head.querySelector("time")?.className)).toEqual([
    expect.not.stringContaining("sr-only"),
    expect.not.stringContaining("sr-only"),
  ]);
});

describe("Timeline 잡음 접기", () => {
  test("이어진 상태·시스템 줄은 N개 한 줄로 접히고 키보드로 펼친다", async () => {
    const user = await setupUser();
    render(
      <Timeline
        entries={[
          status("running"),
          entry("system", {
            engine_event: { name: "init", category: "started" },
          }),
          reply("hi"),
          status("idle"),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    const toggle = document.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("2 events");
    // The folded pair is out of the list; the lone idle line stays, small.
    expect(rows().map((row) => row.dataset.noise ?? "event")).toEqual([
      "event",
      "true",
    ]);
    toggle?.focus();
    await user.keyboard("{Enter}");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(rows().map((row) => row.dataset.noise ?? "event")).toEqual([
      "true",
      "true",
      "event",
      "true",
    ]);
    await user.keyboard(" ");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });

  test("turn 밖에서 이어진 잡음도 접힌다", () => {
    render(
      <Timeline
        entries={[
          status("running", { turnId: null }),
          entry(
            "system",
            { engine_event: { name: "init", category: "started" } },
            { turnId: null },
          ),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    expect(document.querySelector("button")?.textContent).toContain("2 events");
    expect(rows()).toHaveLength(0);
  });

  test("잡음 줄도 detail을 펼쳐 볼 수 있다", () => {
    const noisy = status("running");
    render(
      <Timeline
        entries={[
          {
            ...noisy,
            presentation: { ...noisy.presentation, detail: "raw payload" },
          },
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        now={START}
      />,
    );
    const [row] = rows();
    expect(row?.dataset.noise).toBe("true");
    expect(row?.querySelector("details p")?.textContent).toBe("raw payload");
  });

  test("펼친 잡음 뒤 줄은 마지막 잡음 줄과 같은 글자면 시각을 숨긴다", async () => {
    const user = await setupUser();
    render(
      <Timeline
        entries={[
          reply("a", { turnId: null, at: 0 }),
          status("running", { turnId: null, at: 200 }),
          status("idle", { turnId: null, at: 200 }),
          reply("b", { turnId: null, at: 210 }),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        locale="en"
        now={START + 5 * 60_000}
      />,
    );
    const last = () => rows().at(-1)?.querySelector("time");
    // Closed, b compares with a: "5 min ago" against "1 min ago".
    expect(last()?.className).not.toContain("sr-only");
    const toggle = document.querySelector("button");
    if (toggle) await user.click(toggle);
    expect(last()?.className).toContain("sr-only");
  });

  test("접힘 문구를 받지 않으면 접지 않고 한 줄씩 작게 둔다", () => {
    render(
      <Timeline
        entries={[
          status("running"),
          entry("system", {
            engine_event: { name: "init", category: "started" },
          }),
        ]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, folded: undefined }}
        now={START}
      />,
    );
    expect(document.querySelector("button")).toBeNull();
    expect(rows().map((row) => row.dataset.noise)).toEqual(["true", "true"]);
  });

  test("질문 행은 선택지를 보이고, request 슬롯을 주면 그 자리에 슬롯을 그린다", () => {
    const asked: TimelineEntry = {
      ...entry("question", {
        kind: "question",
        input: { questions: [{ prompt: "Deploy where first?" }] },
      }),
      requestId: "req_1",
      options: ["Staging", "Production"],
    };
    const { rerender } = render(
      <Timeline
        entries={[asked]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, options: "options" }}
      />,
    );
    const list = document.querySelector("ul[aria-label='options']");
    expect(list?.textContent).toBe("StagingProduction");
    expect(rows()[0]?.textContent).toContain("Deploy where first?");
    rerender(
      <Timeline
        entries={[asked]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, options: "options" }}
        request={(id) => <form aria-label={`answer ${id}`} />}
      />,
    );
    expect(
      document.querySelector("form[aria-label='answer req_1']"),
    ).toBeTruthy();
    expect(document.querySelector("ul[aria-label='options']")).toBeNull();
  });

  test("a session cut for a removed model shows the reason as an error row", () => {
    const { getByRole } = render(
      <Timeline
        entries={[
          entry(
            "error",
            {
              code: "MODEL_NOT_ALLOWED",
              message: "cut",
              model: "claude-old",
            },
            { turnId: null },
          ),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    const row = getByRole("list", { name: "events" }).firstElementChild;
    expect(row?.textContent).toContain(
      'session.event.error.modelNotAllowed{"model":"claude-old"}',
    );
    expect((row as HTMLElement).dataset.kind).toBe("error");
  });
});
