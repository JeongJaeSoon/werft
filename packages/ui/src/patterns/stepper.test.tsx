import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";
import { Stepper, type StepperStep } from "./stepper.tsx";

const { render } = await setupDom();

const STEPS: StepperStep[] = [
  { id: "basics", label: "기본 정보" },
  { id: "model", label: "모델" },
  { id: "tools", label: "도구", disabled: true },
  { id: "review", label: "검토" },
];

describe("Stepper", () => {
  test("현재 단계만 aria-current=step이고 지난 단계는 완료로 읽힌다", () => {
    const { getByRole, getAllByRole } = render(
      <Stepper label="만들기 단계" steps={STEPS} currentStepId="model" />,
    );
    expect(getByRole("navigation", { name: "만들기 단계" })).toBeTruthy();
    const items = getAllByRole("listitem");
    expect(items.map((item) => item.dataset.state)).toEqual([
      "complete",
      "current",
      "upcoming",
      "upcoming",
    ]);
    const current = [...document.querySelectorAll('[aria-current="step"]')];
    expect(current.map((node) => node.textContent)).toEqual(["2모델"]);
    // The word is on screen now, not only for screen readers.
    const done = items[0]?.querySelector('[data-slot="stepper-step-status"]');
    expect(done?.textContent).toBe(", 완료");
    expect(done?.getAttribute("aria-hidden")).toBeNull();
    expect(done?.closest(".sr-only")).toBeNull();
    // Display only: nothing to tab to.
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  test("status 글자를 이름 뒤에 보이고, 끝난 단계는 completedLabel이 앞선다", () => {
    const { getAllByRole } = render(
      <Stepper
        label="만들기 단계"
        completedLabel="done"
        steps={[
          { id: "a", label: "이름", status: "선택" },
          { id: "b", label: "Slack 연결", status: "선택" },
          { id: "c", label: "켜기" },
        ]}
        currentStepId="b"
      />,
    );
    const statuses = getAllByRole("listitem").map((item) => {
      const node = item.querySelector('[data-slot="stepper-step-status"]');
      return [node?.textContent, node?.getAttribute("aria-hidden")];
    });
    expect(statuses).toEqual([
      [", done", null],
      [", 선택", null],
      // A step without a status keeps an empty line that readers skip.
      ["", "true"],
    ]);
    // Name first, then status, in reading order.
    const first = getAllByRole("listitem")[0];
    expect(first?.textContent).toBe("1이름, done");
  });

  test("연결선은 마지막 단계 뒤에 없고 끝난 구간만 success 색이다", () => {
    render(<Stepper label="만들기 단계" steps={STEPS} currentStepId="tools" />);
    const lines = [
      ...document.querySelectorAll('[data-slot="stepper-connector"]'),
    ];
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.getAttribute("aria-hidden"))).toBe(true);
    expect(
      lines.map((line) =>
        line.className.includes("--werft-tone-success-border"),
      ),
    ).toEqual([true, true, false]);
  });

  test("단계는 시작에 모이고 연결선은 짧은 고정 길이다", () => {
    const { getAllByRole } = render(
      <Stepper label="만들기 단계" steps={STEPS} currentStepId="model" />,
    );
    const classes = (node: Element | null | undefined) =>
      (node?.getAttribute("class") ?? "").split(/\s+/);
    // Any grow class would push the last step to the far edge again.
    const grows = (node: Element | null | undefined) =>
      classes(node).some((name) =>
        /(^|:)(flex-1|grow|justify-between)$/.test(name),
      );
    expect(grows(document.querySelector("ol"))).toBe(false);
    for (const item of getAllByRole("listitem")) {
      const step = item.firstElementChild;
      expect(grows(item)).toBe(false);
      expect(grows(step)).toBe(false);
      expect(grows(step?.querySelector(":scope > span:nth-child(2)"))).toBe(
        false,
      );
    }
    const lines = [
      ...document.querySelectorAll('[data-slot="stepper-connector"]'),
    ];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(classes(line)).toContain("w-8");
      expect(classes(line)).toContain("shrink-0");
      expect(grows(line)).toBe(false);
    }
  });

  test("끝난 단계 원에 기호 없이 번호가 남는다", () => {
    render(
      <Stepper label="만들기 단계" steps={STEPS} currentStepId="review" />,
    );
    const circles = [
      ...document.querySelectorAll("li > div > span:first-child"),
    ].map((node) => node.textContent);
    expect(circles).toEqual(["1", "2", "3", "4"]);
    expect(document.querySelector("svg")).toBeNull();
  });

  test("Tab은 현재 단계에 서고 화살표·Home·End가 고를 수 있는 단계 사이를 돈다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <Stepper
        label="만들기 단계"
        steps={STEPS}
        currentStepId="model"
        onStepSelect={() => {}}
      />,
    );
    const step = (name: RegExp) => getByRole("button", { name });
    await user.tab();
    expect(document.activeElement).toBe(step(/모델/));
    await user.keyboard("{ArrowRight}");
    // 도구 is disabled, so focus skips to 검토.
    expect(document.activeElement).toBe(step(/검토/));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(step(/기본 정보/));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(step(/검토/));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(step(/기본 정보/));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(step(/검토/));
    expect(
      [...document.querySelectorAll("button")].map((button) => button.tabIndex),
    ).toEqual([-1, -1, -1, 0]);
  });

  test("화면이 현재 단계를 바꾸면 Tab 진입점도 새 현재 단계로 간다", async () => {
    const user = await setupUser();
    const props = {
      label: "만들기 단계",
      steps: STEPS,
      onStepSelect: () => {},
    };
    const { getByRole, rerender } = render(
      <>
        <button type="button">앞</button>
        <Stepper {...props} currentStepId="basics" />
      </>,
    );
    rerender(
      <>
        <button type="button">앞</button>
        <Stepper {...props} currentStepId="model" />
      </>,
    );
    getByRole("button", { name: "앞" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(getByRole("button", { name: /모델/ }));
  });

  test("Enter로 단계를 고르면 onStepSelect가 그 id를 받는다", async () => {
    const user = await setupUser();
    const onStepSelect = mock((_id: string) => {});
    function Harness() {
      const [current, setCurrent] = useState("model");
      return (
        <Stepper
          label="만들기 단계"
          steps={STEPS}
          currentStepId={current}
          onStepSelect={(id) => {
            onStepSelect(id);
            setCurrent(id);
          }}
        />
      );
    }
    const { getByRole } = render(<Harness />);
    await user.tab();
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(onStepSelect).toHaveBeenCalledWith("basics");
    expect(
      getByRole("button", { name: /기본 정보/ }).getAttribute("aria-current"),
    ).toBe("step");
  });
});
