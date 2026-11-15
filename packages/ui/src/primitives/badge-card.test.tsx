import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Badge } from "./badge.tsx";
import { Card, CardFooter } from "./card.tsx";
import { StatusDot } from "./status-dot.tsx";

const { render } = await setupDom();

const classesOf = (element: Element | null | undefined) =>
  (element?.className ?? "").split(" ");

describe("StatusDot", () => {
  test("8px 원을 상태 토큰으로 칠하고 화면 낭독기에서 숨는다", () => {
    const { container } = render(<StatusDot status="wait" />);
    const dot = container.querySelector("[data-slot=status-dot]");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    const classes = classesOf(dot);
    expect(classes).toContain("size-2");
    expect(classes).toContain("bg-(color:--werft-color-status-dot-wait)");
  });

  test("run은 다른 상태와 같은 8px 자리에서 0.9초에 도는 고리이고, 움직임을 줄이면 점이다", () => {
    const { container } = render(<StatusDot status="run" />);
    const dot = container.querySelector<HTMLElement>("[data-slot=status-dot]");
    const classes = classesOf(dot);
    expect(classes).toContain("size-2");
    expect(classes).not.toContain("size-2.5");
    expect(classes).toContain("animate-spin");
    expect(classes).toContain("border-r-transparent");
    expect(classes).toContain("border-[1.5px]");
    expect(classes).toContain(
      "motion-reduce:border-r-(color:--werft-color-status-dot-run)",
    );
    expect(classes).toContain("motion-reduce:animate-none");
    expect(classes).toContain(
      "motion-reduce:bg-(color:--werft-color-status-dot-run)",
    );
    expect(dot?.style.animationDuration).toBe("0.9s");
  });
});

describe("Badge", () => {
  test("기본 variant는 그대로 gray이고 점이 없다", () => {
    const { container } = render(<Badge>초안</Badge>);
    const badge = container.querySelector("[data-slot=badge]");
    expect(classesOf(badge)).toContain("bg-(color:--werft-tone-neutral-bg)");
    expect(badge?.querySelector("[data-slot=status-dot]")).toBeNull();
    expect(badge?.textContent).toBe("초안");
  });

  test("점이 없으면 children을 그대로 넘겨 dangerouslySetInnerHTML도 그대로 쓴다", () => {
    const { container } = render(
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the existing prop this test pins
      <Badge dangerouslySetInnerHTML={{ __html: "<b>초안</b>" }} />,
    );
    const badge = container.querySelector("[data-slot=badge]");
    expect(badge?.innerHTML).toBe("<b>초안</b>");
  });

  test("mono는 mono 글꼴·굵기 400의 회색 배지다", () => {
    const { container } = render(<Badge variant="mono">claude-opus</Badge>);
    const classes = classesOf(container.querySelector("[data-slot=badge]"));
    expect(classes).toContain("font-mono");
    expect(classes).toContain("font-normal");
    expect(classes).not.toContain("font-medium");
    expect(classes).toContain("bg-(color:--werft-tone-neutral-bg)");
  });

  test("dot은 글자 앞에 상태 점을 두고, 이름은 글자가 맡는다", () => {
    const { getByText } = render(
      <Badge variant="blue" dot="done">
        끝남
      </Badge>,
    );
    const badge = getByText("끝남");
    const first = badge.firstElementChild;
    expect(first?.getAttribute("data-slot")).toBe("status-dot");
    expect(first?.getAttribute("data-status")).toBe("done");
    expect(badge.textContent).toBe("끝남");
  });

  test("포커스는 focus-ring 2px outline이다", () => {
    const { container } = render(<Badge>초안</Badge>);
    const classes = classesOf(container.querySelector("[data-slot=badge]"));
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-offset-2");
    expect(classes).toContain("focus-visible:outline-focus-ring");
    expect(classes).not.toContain("focus-visible:ring-ring/50");
  });

  test("asChild에서는 점을 그리지 않고 자식 하나가 배지가 된다", () => {
    const { container } = render(
      <Badge asChild dot="run">
        <a href="#x">링크</a>
      </Badge>,
    );
    const badge = container.querySelector("[data-slot=badge]");
    expect(badge?.tagName).toBe("A");
    expect(badge?.querySelector("[data-slot=status-dot]")).toBeNull();
  });
});

describe("Card", () => {
  test("기본 Card와 CardFooter의 클래스는 그대로다", () => {
    const { container } = render(
      <Card>
        <CardFooter>바닥</CardFooter>
      </Card>,
    );
    const card = classesOf(container.querySelector("[data-slot=card]"));
    expect(card).toContain("py-4");
    expect(card).toContain("gap-3");
    const footer = container.querySelector("[data-slot=card-footer]");
    expect(footer?.className).toBe("flex items-center px-4 [.border-t]:pt-3");
    expect(footer?.hasAttribute("data-variant")).toBe(false);
  });

  test("flush는 padding과 gap을 없앤다", () => {
    const { container } = render(<Card flush />);
    const classes = classesOf(container.querySelector("[data-slot=card]"));
    expect(classes).toContain("py-0");
    expect(classes).toContain("gap-0");
    expect(classes).not.toContain("py-4");
    expect(classes).not.toContain("gap-3");
  });

  test("CardFooter form은 위 테두리·가라앉은 바탕·12/16 padding의 띠다", () => {
    const { container } = render(
      <CardFooter variant="form">저장 전 안내</CardFooter>,
    );
    const classes = classesOf(
      container.querySelector("[data-slot=card-footer]"),
    );
    for (const name of [
      "justify-between",
      "gap-3",
      "border-t",
      "bg-surface-sunken",
      "px-4",
      "py-3",
      "rounded-b-card",
    ])
      expect(classes).toContain(name);
  });
});
