import { describe, expect, test } from "bun:test";
import {
  ADMISSION_STATE_VALUES,
  EXECUTION_STATE_VALUES,
  RECEIPT_STATUS_VALUES,
  TURN_STATUS_VALUES,
} from "@werft-ai/contracts";

import {
  setupDom,
  stubPrefersReducedMotion,
} from "@werft-ai/ui/test-support/dom";
import { describeStatus, STATUS_VOCABULARY, statusDot } from "./vocabulary.ts";

// Queries come from `render()`, never from `screen`: the DOM is registered
// after this module's imports are evaluated, and `screen` binds document.body
// at import time.
const { render } = await setupDom();
// After setupDom: the label loads @werft-ai/ui, whose Radix decides at import
// time whether a DOM exists.
const { StatusLabel } = await import("./status-label.tsx");

describe("StatusLabel", () => {
  test("축이 다르면 같은 화면에서 서로 다른 라벨로 그려진다", () => {
    const { getByText } = render(
      <>
        <StatusLabel axis="admission" state="paused" />
        <StatusLabel axis="turn" state="needs_input" />
      </>,
    );

    const admission = getByText("일시 정지됨").closest(".werft-status");
    const turn = getByText("답변 대기").closest(".werft-status");

    expect(admission?.getAttribute("data-axis")).toBe("admission");
    expect(turn?.getAttribute("data-axis")).toBe("turn");
    // Different axes must not collapse into one badge.
    expect(admission?.getAttribute("data-tone")).toBe("caution");
    expect(turn?.getAttribute("data-tone")).toBe("attention");
    expect(admission?.querySelector("svg")).not.toBeNull();
    expect(admission?.querySelector("svg")?.innerHTML).not.toBe(
      turn?.querySelector("svg")?.innerHTML,
    );
  });

  test("축 이름을 스크린리더에 먼저 읽어 준다", () => {
    const { getByText } = render(
      <StatusLabel axis="receipt" state="accepted" />,
    );
    expect(getByText("접수:").className).toContain("werft-visually-hidden");
  });

  test("detail과 stale을 덧붙인다", () => {
    const { getByText } = render(
      <StatusLabel
        axis="turn"
        state="running"
        detail="2분 경과"
        stale={true}
      />,
    );

    expect(getByText("2분 경과")).toBeDefined();
    expect(getByText("갱신 지연")).toBeDefined();
    expect(
      getByText("작업 중").closest(".werft-status")?.getAttribute("data-stale"),
    ).toBe("true");
  });

  test("label을 주면 문구만 갈아끼우고 축·상태는 유지한다", () => {
    const { getByText } = render(
      <StatusLabel
        axis="admission"
        state="paused"
        label="관리자가 세웠습니다"
      />,
    );
    const label = getByText("관리자가 세웠습니다").closest(".werft-status");
    expect(label?.getAttribute("data-state")).toBe("paused");
    expect(label?.getAttribute("data-tone")).toBe("caution");
  });

  test("axisLabel을 주면 스크린리더가 듣는 축 이름을 바꾼다", () => {
    const { getByText, queryByText } = render(
      <StatusLabel axis="admission" state="paused" axisLabel="State" />,
    );
    expect(getByText("State:").className).toContain("werft-visually-hidden");
    expect(queryByText("세션:")).toBeNull();
  });

  test("stale 문구와 설명도 바꿀 수 있다", () => {
    const { getByText, queryByText } = render(
      <StatusLabel
        axis="turn"
        state="running"
        stale
        staleLabel="Out of date"
        staleHint="Last value seen"
      />,
    );
    expect(getByText("Out of date").getAttribute("title")).toBe(
      "Last value seen",
    );
    expect(queryByText("갱신 지연")).toBeNull();
  });

  test("prefers-reduced-motion이면 스피너 대신 축 아이콘을 둔다", () => {
    const restore = stubPrefersReducedMotion(true);
    try {
      const { container } = render(<StatusLabel axis="turn" state="running" />);
      expect(container.querySelector(".werft-status__spinner")).toBeNull();
      expect(container.querySelectorAll(".werft-status__icon")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("점 모양은 StatusDot이고 상태의 색 이름을 넘긴다", () => {
    const restore = stubPrefersReducedMotion(false);
    try {
      const { container } = render(
        <>
          <StatusLabel appearance="dot" axis="session" state="needs_input" />
          <StatusLabel appearance="dot" axis="session" state="running" />
          <StatusLabel appearance="dot" axis="session" state="idle" />
          <StatusLabel appearance="dot" axis="session" state="failed" />
          <StatusLabel appearance="dot" axis="turn" state="completed" />
          <StatusLabel appearance="dot" axis="admission" state="pausing" />
        </>,
      );
      const dots = [
        ...container.querySelectorAll("[data-slot=status-dot]"),
      ].map((dot) => dot.getAttribute("data-status"));
      // A moving state turns whatever its tone; pausing is caution yet turns.
      expect(dots).toEqual(["wait", "run", "idle", "failed", "done", "run"]);
    } finally {
      restore();
    }
  });

  test("점 모양도 prefers-reduced-motion이면 도는 링 대신 멈춘 점이다", () => {
    const restore = stubPrefersReducedMotion(true);
    try {
      const { container } = render(
        <>
          <StatusLabel appearance="dot" axis="session" state="running" />
          <StatusLabel appearance="dot" axis="admission" state="pausing" />
        </>,
      );
      const [running, pausing] = container.querySelectorAll<HTMLElement>(
        "[data-slot=status-dot]",
      );
      // StatusDot's own motion-reduce classes stop the ring and fill it.
      expect(running?.getAttribute("data-status")).toBe("run");
      expect(running?.getAttribute("data-animated")).toBeNull();
      expect(running?.className).toContain("motion-reduce:animate-none");
      // Standing still, a moving state shows its tone's colour.
      expect(pausing?.getAttribute("data-status")).toBe("wait");
      expect(pausing?.className).not.toContain("animate-");
    } finally {
      restore();
    }
  });

  test("모션 허용이면 스피너가 축 아이콘 자리를 대신한다", () => {
    const restore = stubPrefersReducedMotion(false);
    try {
      const { container } = render(<StatusLabel axis="turn" state="running" />);
      expect(
        container
          .querySelector(".werft-status__spinner")
          ?.getAttribute("data-animated"),
      ).toBe("true");
      expect(container.querySelector(".werft-status__icon")).toBeNull();
    } finally {
      restore();
    }
  });

  test("멈춘 상태는 축 아이콘만 둔다", () => {
    const restore = stubPrefersReducedMotion(false);
    try {
      const { container } = render(
        <StatusLabel axis="turn" state="completed" />,
      );
      expect(container.querySelector(".werft-status__spinner")).toBeNull();
      expect(container.querySelectorAll(".werft-status__icon")).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe("상태 어휘", () => {
  const axes = [
    ["admission", ADMISSION_STATE_VALUES],
    ["turn", TURN_STATUS_VALUES],
    ["receipt", RECEIPT_STATUS_VALUES],
    ["execution", EXECUTION_STATE_VALUES],
  ] as const;

  test("contracts가 정의한 모든 상태에 문구가 있다", () => {
    for (const [axis, values] of axes) {
      const vocabulary: Record<string, unknown> = STATUS_VOCABULARY[axis];
      expect(Object.keys(vocabulary).sort()).toEqual([...values].sort());
    }
  });

  test("모든 상태가 사람이 읽을 문구를 가진다", () => {
    for (const [axis, values] of axes) {
      for (const state of values) {
        const descriptor = describeStatus(axis, state as never);
        expect(descriptor.label.trim().length).toBeGreaterThan(0);
        // The raw enum value is never what the reader sees.
        expect(descriptor.label).not.toBe(state);
      }
    }
  });

  test("멈춘 세션의 점은 완료가 아니라 쉬는 점이다", () => {
    // Stopped can be resumed; only a confirmed success draws the done dot.
    expect(describeStatus("session", "stopped").tone).toBe("neutral");
    expect(statusDot("session", "stopped")).toBe("idle");
    expect(statusDot("session", "running")).toBe("run");
    expect(statusDot("session", "needs_input")).toBe("wait");
    expect(statusDot("session", "failed")).toBe("failed");
    expect(statusDot("turn", "completed")).toBe("done");
    expect(statusDot("turn", "teleported" as never)).toBe("idle");
  });

  test("모르는 상태는 성공으로 그리지 않는다", () => {
    // A server that learns a new state must not be rendered as a success.
    const descriptor = describeStatus("turn", "teleported" as never);
    expect(descriptor.tone).toBe("unknown");
    expect(descriptor.label).toBe("teleported");
  });

  test("Object.prototype의 이름이 상태로 와도 그 자리를 지킨다", () => {
    // A plain lookup returns Object.prototype here: no label, no tone.
    for (const state of ["__proto__", "constructor", "toString"]) {
      const descriptor = describeStatus("turn", state as never);
      expect(descriptor.tone).toBe("unknown");
      expect(descriptor.label).toBe(state);
      expect(descriptor.inFlight).toBe(false);
    }
  });
});
