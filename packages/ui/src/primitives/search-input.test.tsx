import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { SearchInput } = await import("./search-input.tsx");

describe("SearchInput", () => {
  test("aria-label로 읽히고 아이콘은 숨는다", async () => {
    const { getByRole } = render(
      <SearchInput aria-label="세션 검색" placeholder="세션 검색" />,
    );
    const input = getByRole("textbox", { name: "세션 검색" });
    expect(input.tagName).toBe("INPUT");
    const wrapper = input.parentElement;
    expect(wrapper?.getAttribute("data-slot")).toBe("search-input");
    const icon = wrapper?.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("stroke-width")).toBe("1.5");
    await (await setupUser()).type(input, "배포");
    expect((input as HTMLInputElement).value).toBe("배포");
  });

  test("v4 .grow 치수: 래퍼 160px에서 140–320px, 아이콘 left 10·top 8, 입력 왼쪽 여백 32px", () => {
    const { getByRole } = render(
      <SearchInput
        aria-label="세션 검색"
        className="extra-input"
        wrapperClassName="extra-wrapper"
      />,
    );
    const input = getByRole("textbox", { name: "세션 검색" });
    const wrapper = input.parentElement?.className.split(" ") ?? [];
    for (const name of [
      "relative",
      "min-w-[140px]",
      "max-w-[320px]",
      "flex-[1_1_160px]",
      "extra-wrapper",
    ]) {
      expect(wrapper).toContain(name);
    }
    const icon =
      input.parentElement?.querySelector("svg")?.getAttribute("class") ?? "";
    for (const name of [
      "absolute",
      "left-2.5",
      "top-2",
      "size-4",
      "text-subtle-foreground",
      "pointer-events-none",
    ]) {
      expect(icon.split(" ")).toContain(name);
    }
    const classes = input.className.split(" ");
    expect(classes).toContain("pl-8");
    expect(classes).toContain("extra-input");
    // Still Input: its height, hover and focus stay; at rest its edge is the
    // card line, like the toolbar controls beside it.
    expect(input.getAttribute("data-slot")).toBe("input");
    expect(classes).toContain("border-border");
    expect(classes).not.toContain("border-input");
    expect(classes).toContain(
      "enabled:not-aria-invalid:hover:border-subtle-foreground",
    );
  });
});
