import { describe, expect, test } from "bun:test";
import { LayoutGrid, Table2 } from "lucide-react";
import { type JSX, useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { SegmentedControl, SegmentedControlItem } = await import(
  "./segmented-control.tsx"
);

function StatusFilter({
  initial = "all",
  scroll,
}: {
  readonly initial?: string;
  readonly scroll?: boolean;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      aria-label="세션 상태"
      value={value}
      onValueChange={setValue}
      scroll={scroll}
    >
      <SegmentedControlItem value="all" count={12}>
        전체
      </SegmentedControlItem>
      <SegmentedControlItem value="running" count={3} countLabel="3개 실행 중">
        실행 중
      </SegmentedControlItem>
      <SegmentedControlItem value="waiting" count={0}>
        답변 대기
      </SegmentedControlItem>
      <SegmentedControlItem value="done">끝남</SegmentedControlItem>
    </SegmentedControl>
  );
}

function pressed(button: HTMLElement): string | null {
  return button.getAttribute("aria-pressed");
}

describe("SegmentedControl", () => {
  test("이름 있는 group 안의 버튼이고 선택한 하나만 aria-pressed=true다", () => {
    const { getByRole, getAllByRole } = render(<StatusFilter />);
    const group = getByRole("group", { name: "세션 상태" });
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.parentElement === group).toBe(true);
      expect(button.getAttribute("type")).toBe("button");
    }
    expect(buttons.map(pressed)).toEqual(["true", "false", "false", "false"]);
  });

  test("세로 flex 열 안에서도 트랙이 마지막 항목에서 끝난다", () => {
    const { getByRole } = render(<StatusFilter />);
    const group = getByRole("group", { name: "세션 상태" });
    // happy-dom does no layout; w-fit is what stops align-items: stretch.
    expect(group.className.split(" ")).toContain("w-fit");
  });

  test("scroll이 아니면 감싸개 없이 트랙 안에서 줄을 바꾼다", () => {
    const { getByRole } = render(<StatusFilter />);
    const group = getByRole("group", { name: "세션 상태" });
    expect(group.className.split(" ")).toContain("flex-wrap");
    expect(group.closest("[data-slot=segmented-control-scroll]") === null).toBe(
      true,
    );
  });

  test("scroll이면 한 줄로 두고, 바깥 상자가 초점 윤곽이 들어갈 여백을 두고 가로로 스크롤한다", () => {
    const { getByRole } = render(<StatusFilter scroll={true} />);
    const group = getByRole("group", { name: "세션 상태" });
    const classes = group.className.split(" ");
    expect(classes).toContain("flex-nowrap");
    expect(classes).toContain("w-max");
    expect(classes).not.toContain("flex-wrap");
    expect(classes).not.toContain("max-w-full");
    const box = group.parentElement as HTMLElement;
    expect(box.dataset.slot).toBe("segmented-control-scroll");
    // An item's outline is 2px wide at a 2px offset: 4px of padding holds
    // it, and the negative margin leaves the track where it was.
    for (const name of ["overflow-x-auto", "p-1", "-m-1", "min-w-0"]) {
      expect(box.className.split(" ")).toContain(name);
    }
  });

  test("scroll이면 상자만 가로로 밀어 고른 항목을 보이게 하고 페이지는 움직이지 않는다", async () => {
    // happy-dom does no layout: a 200px box, 90px items 100px apart.
    let intoView = 0;
    const originalRect = Element.prototype.getBoundingClientRect;
    const originalIntoView = HTMLElement.prototype.scrollIntoView;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const box = this.closest<HTMLElement>(
        "[data-slot=segmented-control-scroll]",
      );
      if (box === this) return new DOMRect(0, 0, 200, 40);
      const items = [...(box?.querySelectorAll("button") ?? [])];
      const x = items.indexOf(this as HTMLButtonElement) * 100;
      return new DOMRect(x - (box?.scrollLeft ?? 0), 4, 90, 26);
    };
    HTMLElement.prototype.scrollIntoView = () => {
      intoView += 1;
    };
    try {
      const { getByRole } = render(
        <StatusFilter initial="done" scroll={true} />,
      );
      const box = getByRole("group").parentElement as HTMLElement;
      // No stylesheet, so no padding: "끝남" ends at 390, the box at 200.
      expect(box.scrollLeft).toBe(190);
      const user = await setupUser();
      await user.click(getByRole("button", { name: /실행 중/ }));
      // "실행 중" starts at 100, scrolled to -90: back to the box's left edge.
      expect(box.scrollLeft).toBe(100);
      await user.click(getByRole("button", { name: "끝남" }));
      expect(box.scrollLeft).toBe(190);
      expect(intoView).toBe(0);
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
      HTMLElement.prototype.scrollIntoView = originalIntoView;
    }
  });

  test("누르면 선택이 옮겨 가고 이미 눌린 항목을 다시 눌러도 풀리지 않는다", async () => {
    const { getByRole, getAllByRole } = render(<StatusFilter />);
    const user = await setupUser();
    await user.click(getByRole("button", { name: "끝남" }));
    expect(getAllByRole("button").map(pressed)).toEqual([
      "false",
      "false",
      "false",
      "true",
    ]);
    await user.click(getByRole("button", { name: "끝남" }));
    expect(pressed(getByRole("button", { name: "끝남" }))).toBe("true");
  });

  test("항목마다 Tab으로 가고 Enter·Space로 고른다", async () => {
    const { getByRole } = render(<StatusFilter />);
    const user = await setupUser();
    await user.tab();
    expect(
      document.activeElement === getByRole("button", { name: "전체 12" }),
    ).toBe(true);
    await user.tab();
    const running = getByRole("button", { name: "실행 중 3개 실행 중" });
    expect(document.activeElement === running).toBe(true);
    await user.keyboard("{Enter}");
    expect(pressed(running)).toBe("true");
    await user.tab();
    const waiting = getByRole("button", { name: "답변 대기 0" });
    expect(document.activeElement === waiting).toBe(true);
    await user.keyboard(" ");
    expect(pressed(waiting)).toBe("true");
    expect(pressed(running)).toBe("false");
  });

  test("개수는 이름 뒤에 읽히고 0도 그리며 없으면 그리지 않는다", () => {
    const { getByRole } = render(<StatusFilter />);
    const all = getByRole("button", { name: "전체 12" });
    expect(all.textContent).toBe("전체 12");
    const number = all.querySelector('[data-slot="item-count"]');
    expect(number?.className.split(" ")).toEqual(
      expect.arrayContaining([
        "text-caption",
        "text-subtle-foreground",
        "tabular-nums",
      ]),
    );
    expect(
      getByRole("button", { name: "답변 대기 0" }).querySelector(
        '[data-slot="item-count"]',
      )?.textContent,
    ).toBe("0");
    expect(
      getByRole("button", { name: "실행 중 3개 실행 중" })
        .querySelector('[data-slot="item-count"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      getByRole("button", { name: "끝남" }).querySelector(
        '[data-slot="item-count"]',
      ),
    ).toBeNull();
  });

  test("아이콘만 있는 항목은 aria-label로 읽히고 아이콘은 숨는다", async () => {
    function ViewToggle(): JSX.Element {
      const [view, setView] = useState("cards");
      return (
        <SegmentedControl
          aria-label="보기"
          value={view}
          onValueChange={setView}
        >
          <SegmentedControlItem value="cards" aria-label="카드">
            <LayoutGrid aria-hidden="true" strokeWidth={1.5} />
          </SegmentedControlItem>
          <SegmentedControlItem value="table" aria-label="표">
            <Table2 aria-hidden="true" strokeWidth={1.5} />
          </SegmentedControlItem>
        </SegmentedControl>
      );
    }
    const { getByRole } = render(<ViewToggle />);
    const table = getByRole("button", { name: "표" });
    expect(pressed(table)).toBe("false");
    expect(table.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await (await setupUser()).click(table);
    expect(pressed(table)).toBe("true");
    expect(pressed(getByRole("button", { name: "카드" }))).toBe("false");
  });

  test("onClick에서 preventDefault하면 선택을 바꾸지 않는다", async () => {
    let calls = 0;
    const { getByRole } = render(
      <SegmentedControl
        aria-label="범위"
        value="mine"
        onValueChange={() => {
          calls += 1;
        }}
      >
        <SegmentedControlItem value="mine">내 것</SegmentedControlItem>
        <SegmentedControlItem
          value="all"
          onClick={(event) => event.preventDefault()}
        >
          전체
        </SegmentedControlItem>
      </SegmentedControl>,
    );
    await (await setupUser()).click(getByRole("button", { name: "전체" }));
    expect(calls).toBe(0);
  });

  test("트랙은 테두리 없는 회색 알약이고 3px 여백으로 컨트롤 높이(32px)에 맞는다", () => {
    const { getByRole } = render(<StatusFilter />);
    const track = getByRole("group").className.split(" ");
    for (const name of [
      "inline-flex",
      "flex-wrap",
      "gap-0.5",
      "p-[3px]",
      "rounded-card",
      "bg-segment-track",
    ]) {
      expect(track).toContain(name);
    }
    for (const name of ["border", "border-border", "bg-card"]) {
      expect(track).not.toContain(name);
    }
    const item = getByRole("button", { name: "끝남" }).className.split(" ");
    // 26px item + 3px padding on each side = --werft-control-height.
    expect(item).toContain("h-[calc(var(--werft-control-height)-6px)]");
  });

  test("고른 항목은 흰 알약(그림자·진한 글자), 나머지는 흐린 글자다", () => {
    const { getByRole } = render(<StatusFilter />);
    const item = getByRole("button", { name: "끝남" }).className.split(" ");
    for (const name of [
      "px-3",
      "gap-1.5",
      "rounded-control",
      "font-medium",
      "text-control",
      "whitespace-nowrap",
      "text-subtle-foreground",
      "hover:text-foreground",
      "aria-pressed:bg-segment-thumb",
      "aria-pressed:shadow-segment-thumb",
      "aria-pressed:text-foreground",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-focus-ring",
    ]) {
      expect(item).toContain(name);
    }
  });

  test("countTone은 1 이상일 때만 색 배지이고 0이나 tone 없음은 흐린 숫자다", () => {
    const { getByRole } = render(
      <SegmentedControl aria-label="상태" value="all" onValueChange={() => {}}>
        <SegmentedControlItem value="all" count={12}>
          전체
        </SegmentedControlItem>
        <SegmentedControlItem value="wait" count={2} countTone="attention">
          답변 대기
        </SegmentedControlItem>
        <SegmentedControlItem value="failed" count={0} countTone="danger">
          실패
        </SegmentedControlItem>
        <SegmentedControlItem value="broken" count={1} countTone="danger">
          깨짐
        </SegmentedControlItem>
      </SegmentedControl>,
    );
    const countOf = (name: string) =>
      getByRole("button", { name }).querySelector<HTMLElement>(
        '[data-slot="item-count"]',
      );
    const wait = countOf("답변 대기 2");
    expect(wait?.dataset.tone).toBe("attention");
    expect(wait?.className).toContain("bg-(color:--werft-tone-attention-bg)");
    expect(wait?.className).toContain("rounded-full");
    expect(countOf("깨짐 1")?.dataset.tone).toBe("danger");
    const zero = countOf("실패 0");
    expect(zero?.dataset.tone).toBeUndefined();
    expect(zero?.className.split(" ")).toContain("text-subtle-foreground");
    expect(countOf("전체 12")?.dataset.tone).toBeUndefined();
  });

  test("색 배지는 tone마다 다른 아이콘을 앞에 두고, 아이콘은 이름에 읽히지 않는다", () => {
    const { getByRole } = render(
      <SegmentedControl aria-label="상태" value="all" onValueChange={() => {}}>
        <SegmentedControlItem value="wait" count={2} countTone="attention">
          답변 대기
        </SegmentedControlItem>
        <SegmentedControlItem value="broken" count={1} countTone="danger">
          깨짐
        </SegmentedControlItem>
        <SegmentedControlItem value="failed" count={0} countTone="danger">
          실패
        </SegmentedControlItem>
      </SegmentedControl>,
    );
    const iconOf = (name: string) =>
      getByRole("button", { name }).querySelector<SVGElement>(
        '[data-slot="item-count"] svg',
      );
    const attention = iconOf("답변 대기 2");
    const danger = iconOf("깨짐 1");
    expect(attention?.classList.contains("lucide-triangle-alert")).toBe(true);
    expect(danger?.classList.contains("lucide-circle-x")).toBe(true);
    for (const icon of [attention, danger]) {
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.classList.contains("size-3")).toBe(true);
    }
    // A quiet 0 has no badge, so no icon either.
    expect(iconOf("실패 0") === null).toBe(true);
  });

  test("개수가 오기 전에는 tone이 있어도 아무것도 그리지 않는다", () => {
    const { getByRole } = render(
      <SegmentedControl aria-label="상태" value="all" onValueChange={() => {}}>
        <SegmentedControlItem
          value="failed"
          count={undefined}
          countTone="danger"
        >
          실패
        </SegmentedControlItem>
      </SegmentedControl>,
    );
    const item = getByRole("button", { name: "실패" });
    expect(item.querySelector('[data-slot="item-count"]') === null).toBe(true);
    expect(item.querySelector("svg") === null).toBe(true);
  });
});
