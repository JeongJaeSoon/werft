import { describe, expect, mock, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
const { Pagination, paginationItems } = await import("./pagination.tsx");

const messages = {
  label: "페이지 이동",
  previous: "이전 페이지",
  next: "다음 페이지",
  page: (page: number) => `${page}페이지`,
};

describe("paginationItems", () => {
  test("처음·끝·앞뒤 쪽만 두고 사이를 줄인다", () => {
    expect(paginationItems(1, 1, false)).toEqual([1]);
    expect(paginationItems(1, 3, false)).toEqual([1, 2, 3]);
    expect(paginationItems(5, 10, false)).toEqual([
      1,
      "gap-before",
      4,
      5,
      6,
      "gap-after",
      10,
    ]);
    expect(paginationItems(2, 2, true)).toEqual([1, 2, "gap-after"]);
  });
});

describe("Pagination", () => {
  test("이름 있는 nav 안에서 지금 쪽만 aria-current=page이다", () => {
    const { getByRole, getAllByRole } = render(
      <Pagination
        page={2}
        pageCount={3}
        onPageChange={() => {}}
        range="16–30 / 40"
        messages={messages}
      />,
    );
    const nav = getByRole("navigation", { name: "페이지 이동" });
    expect(nav.querySelectorAll("[aria-current]")).toHaveLength(1);
    const current = getByRole("button", { name: "2페이지" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(
      getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual(["이전 페이지", "1페이지", "2페이지", "3페이지", "다음 페이지"]);
    expect(nav.parentElement?.textContent).toContain("16–30 / 40");
  });

  test("이전·다음·번호가 그 쪽을 알리고, 끝에서는 aria-disabled로 남는다", () => {
    const onPageChange = mock((_page: number) => {});
    const { getByRole, rerender } = render(
      <Pagination
        page={1}
        pageCount={2}
        onPageChange={onPageChange}
        messages={messages}
      />,
    );
    const previous = getByRole("button", { name: "이전 페이지" });
    const next = getByRole("button", { name: "다음 페이지" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(next.getAttribute("aria-disabled")).toBe(null);
    previous.click();
    getByRole("button", { name: "1페이지" }).click();
    expect(onPageChange).not.toHaveBeenCalled();
    next.click();
    expect(onPageChange.mock.calls).toEqual([[2]]);

    rerender(
      <Pagination
        page={2}
        pageCount={2}
        onPageChange={onPageChange}
        messages={messages}
      />,
    );
    const end = getByRole("button", { name: "다음 페이지" });
    expect(end === next).toBe(true);
    expect(end.getAttribute("aria-disabled")).toBe("true");
    expect(end.hasAttribute("disabled")).toBe(false);
    end.click();
    getByRole("button", { name: "이전 페이지" }).click();
    getByRole("button", { name: "1페이지" }).click();
    expect(onPageChange.mock.calls).toEqual([[2], [1], [1]]);
  });

  test("뒤에 쪽이 더 있으면 마지막 쪽에서도 다음으로 갈 수 있다", () => {
    const onPageChange = mock((_page: number) => {});
    const { getByRole } = render(
      <Pagination
        page={2}
        pageCount={2}
        hasMore={true}
        onPageChange={onPageChange}
        messages={messages}
      />,
    );
    const next = getByRole("button", { name: "다음 페이지" });
    expect(next.getAttribute("aria-disabled")).toBe(null);
    next.click();
    expect(onPageChange.mock.calls).toEqual([[3]]);
  });
});
