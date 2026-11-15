import { describe, expect, test } from "bun:test";
import { ArrowRight, Bot } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
const { MoreLink } = await import("./more-link.tsx");
const { IconTile } = await import("./icon-tile.tsx");
const { Link } = await import("../primitives/link.tsx");

// The router's links take a function of their state as children.
function StateLink({
  children,
  ...props
}: Omit<ComponentProps<"a">, "children"> & {
  readonly children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
}) {
  return (
    <a {...props}>
      {typeof children === "function" ? children({ isActive: true }) : children}
    </a>
  );
}

const classes = (element: Element) => [...element.classList].sort();

describe("MoreLink", () => {
  test("기본은 운영 탭의 12px 모양이고 화살표가 없다", () => {
    const { getByRole } = render(
      <MoreLink href="/operations/tools">도구 활동</MoreLink>,
    );
    const link = getByRole("link", { name: "도구 활동" });
    for (const name of [
      "whitespace-nowrap",
      "font-normal",
      "text-caption",
      "leading-4",
    ])
      expect(link.classList.contains(name)).toBe(true);
    expect(link.querySelector("svg")).toBeNull();
  });

  test("control은 13px이고 화살표 없이 글자만 둔다", () => {
    const { getByRole } = render(
      <MoreLink size="control" asChild>
        <a href="/sessions">모두 보기</a>
      </MoreLink>,
    );
    const link = getByRole("link", { name: "모두 보기" });
    expect(link.classList.contains("text-control")).toBe(true);
    expect(link.classList.contains("inline-flex")).toBe(false);
    expect(link.querySelector("svg")).toBeNull();
  });

  test("arrow는 화살표를 router 링크 안 글자 뒤에 두고 이름은 글자만이다", () => {
    const { getByRole } = render(
      <MoreLink size="control" arrow asChild>
        <a href="/sessions" data-router="tanstack">
          세션 모두 보기
        </a>
      </MoreLink>,
    );
    const link = getByRole("link", { name: "세션 모두 보기" });
    expect(link.getAttribute("data-router")).toBe("tanstack");
    const icon = link.lastElementChild;
    expect(icon?.tagName.toLowerCase()).toBe("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("stroke-width")).toBe("2");
    for (const name of [
      "inline-flex",
      "shrink-0",
      "items-center",
      "gap-1",
      "whitespace-nowrap",
      "text-control",
    ])
      expect(link.classList.contains(name)).toBe(true);
  });

  test("asChild 없이도 arrow는 링크 안 글자 뒤에 둔다", () => {
    const { getByRole } = render(
      <MoreLink size="control" arrow href="/agents">
        에이전트
      </MoreLink>,
    );
    const link = getByRole("link", { name: "에이전트" });
    expect(link.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});

describe("MoreLink는 화면의 이전 손 조립과 같은 DOM을 낸다", () => {
  const html = (node: ReactNode) => render(node).container.innerHTML;

  test("홈의 화살표 링크", () => {
    const before = html(
      <Link
        asChild
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-(color:--werft-color-link) text-control"
      >
        <a href="/sessions">
          모두 보기
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      </Link>,
    );
    const after = html(
      <MoreLink asChild size="control" arrow>
        <a href="/sessions">모두 보기</a>
      </MoreLink>,
    );
    expect(after).toBe(before);
  });

  test("에이전트 개요의 링크", () => {
    const before = html(
      <Link asChild className="text-control">
        <a href="/sessions">모두 보기</a>
      </Link>,
    );
    const after = html(
      <MoreLink asChild size="control">
        <a href="/sessions">모두 보기</a>
      </MoreLink>,
    );
    expect(after).toBe(before);
  });

  test("운영 탭의 링크", () => {
    const before = html(
      <Link
        href="/operations/tools"
        className="whitespace-nowrap font-normal text-caption leading-4"
      >
        도구 활동
      </Link>,
    );
    const after = html(<MoreLink href="/operations/tools">도구 활동</MoreLink>);
    expect(after).toBe(before);
  });

  test("router 링크의 함수 children을 부르고 그 뒤에 화살표를 둔다", () => {
    const { getByRole } = render(
      <MoreLink asChild size="control" arrow>
        <StateLink href="/sessions">
          {({ isActive }) => (isActive ? "지금 보는 중" : "모두 보기")}
        </StateLink>
      </MoreLink>,
    );
    const link = getByRole("link", { name: "지금 보는 중" });
    expect(link.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});

describe("IconTile", () => {
  test("한 가지 타일 색과 크기를 class로 내고 스크린리더에서는 숨는다", () => {
    const { container } = render(
      <>
        <IconTile icon={Bot} />
        <IconTile icon={Bot} size="two-line" />
      </>,
    );
    const [line, twoLine] = container.querySelectorAll("[data-slot=icon-tile]");
    expect(line?.getAttribute("aria-hidden")).toBe("true");
    for (const tile of [line, twoLine]) {
      expect(classes(tile as Element)).toContain("bg-(--werft-color-tile)");
      expect(classes(tile as Element)).toContain(
        "text-(--werft-color-tile-foreground)",
      );
    }
    expect(classes(line as Element)).toContain("size-(--werft-size-icon-tile)");
    expect(classes(twoLine as Element)).toContain(
      "size-(--werft-size-tile-two-line)",
    );
    expect(twoLine?.querySelector("svg")?.getAttribute("class")).toContain(
      "size-5",
    );
  });
});
