import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { MenuItem } = await import("./menu-item.tsx");
const { RemoveButton } = await import("./remove-button.tsx");
const { StatValue } = await import("./stat-value.tsx");

const classesOf = (element: Element | null) =>
  (element?.className ?? "").split(" ");

describe("MenuItem", () => {
  test("32px 줄에 포인터와 키보드가 같은 바탕을 쓰고, 키보드에는 안쪽 외곽선이 더해진다", () => {
    const { getByRole } = render(<MenuItem>이름 바꾸기</MenuItem>);
    const item = getByRole("button", { name: "이름 바꾸기" });
    expect(item.getAttribute("type")).toBe("button");
    expect(item.getAttribute("data-slot")).toBe("menu-item");
    const classes = classesOf(item);
    for (const name of [
      "h-[var(--werft-control-height)]",
      "rounded-control",
      "text-control",
      "not-disabled:not-aria-disabled:hover:bg-hover",
      "focus-visible:bg-hover",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-[-2px]",
      "focus-visible:outline-focus-ring",
      "disabled:opacity-50",
      "aria-disabled:opacity-50",
    ])
      expect(classes).toContain(name);
    expect(classes).not.toContain("hover:bg-hover");
  });

  test("danger는 위험 글자색이고, 링크를 asChild로 받아 type을 붙이지 않는다", () => {
    const { getByRole } = render(
      <>
        <MenuItem tone="danger">삭제</MenuItem>
        <MenuItem asChild={true}>
          <a href="/agents">열기</a>
        </MenuItem>
      </>,
    );
    const danger = getByRole("button", { name: "삭제" });
    expect(classesOf(danger)).toContain("text-destructive");
    expect(danger.getAttribute("data-tone")).toBe("danger");
    const link = getByRole("link", { name: "열기" });
    expect(link.getAttribute("data-slot")).toBe("menu-item");
    expect(link.hasAttribute("type")).toBe(false);
    expect(link.getAttribute("href")).toBe("/agents");
  });

  test("비활성 항목은 눌리지 않는다", async () => {
    let clicks = 0;
    const { getByRole } = render(
      <MenuItem
        disabled={true}
        onClick={() => {
          clicks += 1;
        }}
      >
        보관
      </MenuItem>,
    );
    await (await setupUser()).click(getByRole("button", { name: "보관" }));
    expect(clicks).toBe(0);
  });
});

describe("RemoveButton", () => {
  test("20px 둥근 ×이고 이름은 aria-label이 준다", async () => {
    let clicks = 0;
    const { getByRole } = render(
      <RemoveButton
        aria-label="김민지 빼기"
        onClick={() => {
          clicks += 1;
        }}
      />,
    );
    const button = getByRole("button", { name: "김민지 빼기" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    const classes = classesOf(button);
    for (const name of [
      "size-5",
      "rounded-full",
      "enabled:hover:bg-hover",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-focus-ring",
      "disabled:opacity-50",
    ])
      expect(classes).toContain(name);
    expect(classes).not.toContain("hover:bg-hover");
    await (await setupUser()).click(button);
    expect(clicks).toBe(1);
  });
});

describe("StatValue", () => {
  test("숫자 크기의 Geist Mono 500, 고정폭 숫자이고 asChild로 문단이 된다", () => {
    const { getByText } = render(
      <StatValue asChild={true}>
        <p>128</p>
      </StatValue>,
    );
    const figure = getByText("128");
    expect(figure.tagName).toBe("P");
    expect(figure.getAttribute("data-slot")).toBe("stat-value");
    for (const name of [
      "font-mono",
      "font-medium",
      "text-number",
      "tracking-normal",
      "tabular-nums",
    ])
      expect(classesOf(figure)).toContain(name);
  });
});
