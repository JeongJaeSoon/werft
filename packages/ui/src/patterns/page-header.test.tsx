import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import {
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
} from "./page-breadcrumb.tsx";
import { PageHeader } from "./page-header.tsx";

const { render } = await setupDom();

describe("PageHeader", () => {
  test("제목은 페이지의 h1이고 설명이 그 h1의 설명으로 이어진다", () => {
    const { getByRole } = render(
      <PageHeader
        title="세션"
        description="에이전트가 맡은 일을 봅니다."
        actions={<button type="button">새로 만들기</button>}
      />,
    );
    const heading = getByRole("heading", { level: 1, name: "세션" });
    const describedBy = heading.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "에이전트가 맡은 일을 봅니다.",
    );
    expect(getByRole("button", { name: "새로 만들기" })).toBeTruthy();
  });

  test("설명이 없으면 비어 있는 설명을 가리키지 않는다", () => {
    const { getByRole, container } = render(
      <PageHeader title="설정" description="" />,
    );
    expect(
      getByRole("heading", { level: 1 }).hasAttribute("aria-describedby"),
    ).toBe(false);
    expect(container.querySelector("p")).toBeNull();
    // No empty actions box either: it would add a gap on the right.
    expect(
      container.querySelector('[data-slot="page-header"]')?.children,
    ).toHaveLength(1);
  });

  test("v35 크기 클래스를 쓴다: 제목 20/28, 설명 13/20, 아래 24", () => {
    const { container, getByRole } = render(
      <PageHeader title="홈" description="요약" />,
    );
    const header = container.querySelector('[data-slot="page-header"]');
    expect(header?.className).toContain("mb-[var(--werft-space-page-head)]");
    expect(getByRole("heading", { level: 1 }).className).toContain(
      "text-title",
    );
    expect(container.querySelector("p")?.className).toContain(
      "text-description",
    );
  });

  test("좁은 폭에서는 동작이 제목·설명 아래로 가고, 넓으면 오른쪽에 선다", () => {
    const head = (stackBelow?: "md" | "lg") => {
      const { container } = render(
        <PageHeader
          title="세션"
          description="요약"
          actions={<button type="button">새로 만들기</button>}
          stackBelow={stackBelow}
        />,
      );
      const header = container.querySelector('[data-slot="page-header"]');
      return {
        head: header?.className.split(" ") ?? [],
        actions: header?.lastElementChild?.className.split(" ") ?? [],
      };
    };
    const md = head();
    expect(md.head).toContain("flex-col");
    expect(md.head).toContain("md:flex-row");
    expect(md.head).not.toContain("justify-between");
    expect(md.actions).toContain("flex-wrap");
    expect(md.actions).toContain("md:flex-none");
    const lg = head("lg");
    expect(lg.head).toContain("lg:flex-row");
    expect(lg.head).not.toContain("md:flex-row");
  });

  test("wrap이면 제목 칸이 최소 폭을 지키고 동작은 자리가 모자라면 아래 줄로 감싼다", () => {
    const { container } = render(
      <PageHeader
        title="의존성 업데이트 영향 확인"
        actions={<button type="button">세션 종료</button>}
        stackBelow="wrap"
      />,
    );
    const header = container.querySelector('[data-slot="page-header"]');
    const head = header?.className.split(" ") ?? [];
    const title = header?.firstElementChild?.className.split(" ") ?? [];
    const actions = header?.lastElementChild?.className.split(" ") ?? [];
    // No breakpoint: one wrapping row at every width.
    expect(head).toContain("flex-row");
    expect(head).toContain("flex-wrap");
    expect(head.some((name) => name.startsWith("md:"))).toBe(false);
    expect(title).toContain("grow-[999]");
    expect(title).toContain("basis-80");
    expect(title).toContain("min-w-[min(100%,20rem)]");
    // Never fixed at its content width: wider than the row, it wraps inside.
    expect(actions).toContain("max-w-full");
    // Alone on their line they fill it, so a trailing ms-auto item ends at
    // the right edge.
    expect(actions).toContain("grow");
    expect(actions).not.toContain("md:flex-none");
    expect(actions).not.toContain("md:flex-nowrap");
  });

  test("breadcrumb은 제목 위 줄에 위치 nav로 놓이고, 마지막이 지금 페이지다", () => {
    const { getByRole, container } = render(
      <PageHeader
        title="새 개인 key"
        breadcrumb={
          <PageBreadcrumb label="위치">
            <PageBreadcrumbLink href="/settings/api-keys">
              내 key
            </PageBreadcrumbLink>
            <PageBreadcrumbCurrent>새 개인 key</PageBreadcrumbCurrent>
          </PageBreadcrumb>
        }
        actions={<button type="button">주 버튼</button>}
      />,
    );
    const nav = getByRole("navigation", { name: "위치" });
    const heading = getByRole("heading", { level: 1, name: "새 개인 key" });
    // Above the title in the same column; the actions stay the page's own.
    expect(nav.nextElementSibling).toBe(heading);
    expect([...nav.querySelectorAll("li")].map((li) => li.textContent)).toEqual(
      ["내 key", "/", "새 개인 key"],
    );
    const back = getByRole("link", { name: "내 key" });
    expect(back.getAttribute("href")).toBe("/settings/api-keys");
    // The top bar's trail colour, not a link's blue.
    expect(back.className.split(" ")).toContain("text-subtle-foreground");
    expect(back.className.split(" ")).not.toContain("text-link");
    expect(container.querySelector("[aria-current=page]")?.textContent).toBe(
      "새 개인 key",
    );
    expect(nav.contains(getByRole("button", { name: "주 버튼" }))).toBe(false);
  });

  test("titleAside는 제목 줄에 놓이지만 h1의 이름에는 들지 않는다", () => {
    const { getByRole, getByText } = render(
      <PageHeader title="결제 담당" titleAside={<span>활성</span>} />,
    );
    const heading = getByRole("heading", { level: 1, name: "결제 담당" });
    const tag = getByText("활성");
    expect(heading.contains(tag)).toBe(false);
    expect(heading.nextElementSibling === tag).toBe(true);
  });
});
