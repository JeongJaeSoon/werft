import { describe, expect, test } from "bun:test";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import { LayoutGrid, List } from "lucide-react";

const { render } = await setupDom();
// After setupDom: the toolbar loads @werft-ai/ui, whose Radix decides at
// import time whether a DOM exists.
const { FilterMenu, SegmentedControl, SegmentedControlItem } = await import(
  "@werft-ai/ui"
);
const { ListToolbar, ListViewSwitch } = await import("./list-toolbar.tsx");

function Filter() {
  return (
    <SegmentedControl aria-label="분류" value="all" onValueChange={() => {}}>
      <SegmentedControlItem value="all" count={3}>
        전체
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

describe("ListToolbar", () => {
  test("분류 → 칩 → 표시방식 → 검색 순으로 놓고 검색은 260px로 고정한다", () => {
    const { container, getByRole } = render(
      <ListToolbar
        filter={<Filter />}
        filters={
          <FilterMenu
            label="관계"
            options={[{ value: "all", label: "모든 관계" }]}
            value="all"
            onValueChange={() => {}}
          />
        }
        view={<button type="button">표</button>}
        search={{ "aria-label": "찾기", type: "search" }}
      />,
    );
    const order = [...container.querySelectorAll("input, button")].map(
      (node) => node.getAttribute("aria-label") ?? node.textContent,
    );
    expect(order).toEqual(["전체 3", "관계모든 관계", "표", "찾기"]);
    const wrapper = getByRole("searchbox").parentElement;
    expect(wrapper?.dataset.slot).toBe("search-input");
    for (const name of ["sm:w-[260px]", "max-w-none", "flex-1", "min-w-0"]) {
      expect(wrapper?.className.split(" ")).toContain(name);
    }
  });

  test("넓은 폭(lg)에서는 분류·필터·검색을 한 줄에 두고, 좁은 폭에서는 오른쪽 묶음을 아래 줄로 내린다", () => {
    const { container } = render(
      <ListToolbar
        filter={<Filter />}
        filters={<span>칩</span>}
        search={{ "aria-label": "찾기", type: "search" }}
      />,
    );
    // happy-dom lays nothing out: the breakpoint classes are what is checked.
    const bar = container.querySelector<HTMLElement>(
      '[data-slot="list-toolbar"]',
    );
    const end = container.querySelector<HTMLElement>(
      '[data-slot="list-toolbar-end"]',
    );
    const classes = (node: HTMLElement | null) =>
      node?.className.split(" ") ?? [];
    expect(classes(bar)).toEqual(
      expect.arrayContaining(["flex", "flex-wrap", "lg:flex-nowrap"]),
    );
    expect(classes(end)).toEqual(
      expect.arrayContaining(["w-full", "sm:w-auto", "lg:shrink-0"]),
    );
  });

  test("칩만 있어도 오른쪽 묶음을 그린다", () => {
    const { container } = render(
      <ListToolbar filter={<Filter />} filters={<span>칩</span>} />,
    );
    expect(
      container.querySelector('[data-slot="list-toolbar-end"]')?.textContent,
    ).toBe("칩");
  });

  test("검색도 표시방식도 없으면 오른쪽 묶음을 그리지 않는다", () => {
    const { container } = render(<ListToolbar filter={<Filter />} />);
    expect(
      container.querySelector('[data-slot="list-toolbar-end"]'),
    ).toBeNull();
  });
});

describe("ListViewSwitch", () => {
  const OPTIONS = [
    { value: "cards", label: "카드", icon: LayoutGrid },
    { value: "table", label: "표", icon: List },
  ] as const;

  test("툴바 크기 세그먼트이고 좁은 화면에서 글자는 읽히기만 한다", async () => {
    const picked: string[] = [];
    const { getByRole } = render(
      <ListViewSwitch
        aria-label="보기"
        value="table"
        onValueChange={(view) => picked.push(view)}
        options={OPTIONS}
      />,
    );
    const group = getByRole("group", { name: "보기" });
    expect(group.getAttribute("data-slot")).toBe("segmented-control");
    const cards = getByRole("button", { name: "카드" });
    expect(cards.getAttribute("aria-pressed")).toBe("false");
    expect(cards.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(cards.querySelector("span")?.className).toBe("max-sm:sr-only");
    await (await setupUser()).click(cards);
    expect(picked).toEqual(["cards"]);
  });
});
