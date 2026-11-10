import { describe, expect, mock, test } from "bun:test";
import type { ComponentProps, JSX, ReactNode } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { LinkTab, LinkTabs } = await import("./link-tabs.tsx");

// The shape of TanStack Router's <Link>: `to` becomes href, it adds its own
// class, and its children may be a function of the link's state.
function RouterLink({
  to,
  className,
  children,
  ...props
}: Omit<ComponentProps<"a">, "href" | "children"> & {
  readonly to: string;
  readonly children?:
    | ReactNode
    | ((state: { readonly isActive: boolean }) => ReactNode);
}): JSX.Element {
  return (
    <a
      href={to}
      className={["router-link", className].filter(Boolean).join(" ")}
      {...props}
    >
      {typeof children === "function" ? children({ isActive: true }) : children}
    </a>
  );
}

function statusTabs(current: string) {
  const tabs = [
    { status: "", label: "전체", count: 12 },
    { status: "running", label: "실행 중", count: 3 },
    { status: "needs_input", label: "답변 대기", count: 0 },
    { status: "done", label: "끝남" },
  ];
  return (
    <LinkTabs aria-label="세션 상태">
      {tabs.map((tab) => (
        <LinkTab
          key={tab.status}
          href={tab.status ? `?status=${tab.status}` : "?"}
          current={tab.status === current}
          count={tab.count}
        >
          {tab.label}
        </LinkTab>
      ))}
    </LinkTabs>
  );
}

describe("LinkTabs", () => {
  test("이름 있는 nav 안의 링크 목록이고 tab 역할은 없다", () => {
    const { getByRole, getAllByRole, queryAllByRole } = render(
      statusTabs("running"),
    );
    const nav = getByRole("navigation", { name: "세션 상태" });
    expect(nav.tagName).toBe("NAV");
    expect(getByRole("list").parentElement === nav).toBe(true);
    expect(getAllByRole("listitem")).toHaveLength(4);
    expect(getAllByRole("link")).toHaveLength(4);
    expect(queryAllByRole("tab")).toHaveLength(0);
    expect(queryAllByRole("tablist")).toHaveLength(0);
  });

  test("지금 탭만 aria-current=page이다", () => {
    const { getAllByRole } = render(statusTabs("running"));
    const current = getAllByRole("link").filter(
      (link) => link.getAttribute("aria-current") !== null,
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("aria-current")).toBe("page");
    expect(current[0]?.getAttribute("href")).toBe("?status=running");
  });

  test("개수는 이름 뒤에 읽히고 0도 그리며 없으면 개수가 없다", () => {
    const { getByRole } = render(statusTabs(""));
    expect(getByRole("link", { name: "전체 12" })).toBeTruthy();
    // Browsers join an inline count to the label without a space; Testing
    // Library's name computation adds one, so the text is checked too.
    expect(getByRole("link", { name: "실행 중 3" }).textContent).toBe(
      "실행 중 3",
    );
    const zero = getByRole("link", { name: "답변 대기 0" });
    expect(zero.querySelector('[data-slot="item-count"]')?.textContent).toBe(
      "0",
    );
    const none = getByRole("link", { name: "끝남" });
    expect(none.querySelector('[data-slot="item-count"]')).toBeNull();
  });

  test("큰 수도 그대로 그린다", () => {
    const { getByRole } = render(
      <LinkTabs aria-label="세션 상태">
        <LinkTab href="?" count={123456}>
          전체
        </LinkTab>
      </LinkTabs>,
    );
    const link = getByRole("link", { name: "전체 123456" });
    expect(link.querySelector('[data-slot="item-count"]')?.textContent).toBe(
      "123456",
    );
  });

  test("countLabel이 있으면 숫자 대신 그 문장을 읽는다", () => {
    const { getByRole } = render(
      <LinkTabs aria-label="세션 상태">
        <LinkTab href="?status=running" count={3} countLabel="3개 실행 중">
          실행 중
        </LinkTab>
      </LinkTabs>,
    );
    const link = getByRole("link", { name: "실행 중 3개 실행 중" });
    const number = link.querySelector('[data-slot="item-count"]');
    expect(number?.getAttribute("aria-hidden")).toBe("true");
    expect(number?.textContent).toBe("3");
  });

  test("asChild는 넘긴 라우터 링크를 그 자리에 그리고 href·onClick·모양을 지킨다", async () => {
    const onClick = mock((event: { preventDefault(): void }) =>
      event.preventDefault(),
    );
    const { getByRole } = render(
      <LinkTabs aria-label="API 키 종류">
        <LinkTab asChild current count={2}>
          <RouterLink to="/api-keys" onClick={onClick}>
            {({ isActive }) => (isActive ? "개인 키" : "?")}
          </RouterLink>
        </LinkTab>
        <LinkTab asChild>
          <RouterLink to="/api-keys/agents">에이전트 키</RouterLink>
        </LinkTab>
      </LinkTabs>,
    );
    const link = getByRole("link", { name: "개인 키 2" });
    const listItem = getByRole("list").firstElementChild;
    expect(link.tagName).toBe("A");
    expect(link.parentElement === listItem).toBe(true);
    expect(link.getAttribute("href")).toBe("/api-keys");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.getAttribute("data-slot")).toBe("link-tab");
    const classes = link.className.split(" ");
    expect(classes).toContain("router-link");
    expect(classes).toContain(
      "group-data-[orientation=horizontal]/tabs:after:inset-x-2",
    );
    await (await setupUser()).click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
    const other = getByRole("link", { name: "에이전트 키" });
    expect(other.hasAttribute("aria-current")).toBe(false);
  });

  test("라우터 링크가 스스로 매긴 aria-current가 이기므로 상위 경로 링크는 exact로 맞춘다", () => {
    // TanStack's <Link> writes aria-current="page" over its props when it
    // counts as active, and by default a parent path is active too.
    function ActiveRouterLink({
      to,
      at,
      exact = false,
      ...props
    }: Omit<ComponentProps<"a">, "href"> & {
      readonly to: string;
      readonly at: string;
      readonly exact?: boolean;
    }): JSX.Element {
      const active = exact ? at === to : at.startsWith(to);
      return (
        <a
          href={to}
          {...props}
          {...(active ? { "aria-current": "page" } : {})}
        />
      );
    }
    const tabs = (exact: boolean) => (
      <LinkTabs aria-label="key 목록">
        <LinkTab asChild current={false}>
          <ActiveRouterLink to="/keys" at="/keys/agents" exact={exact}>
            개인 key
          </ActiveRouterLink>
        </LinkTab>
        <LinkTab asChild current>
          <ActiveRouterLink to="/keys/agents" at="/keys/agents" exact={exact}>
            에이전트 key
          </ActiveRouterLink>
        </LinkTab>
      </LinkTabs>
    );
    const marked = (container: HTMLElement) =>
      [...container.querySelectorAll('a[aria-current="page"]')].map(
        (link) => link.textContent,
      );
    expect(marked(render(tabs(false)).container)).toEqual([
      "개인 key",
      "에이전트 key",
    ]);
    expect(marked(render(tabs(true)).container)).toEqual(["에이전트 key"]);
  });

  test("Tabs line과 같은 v4 치수 클래스와 focus-visible 윤곽을 쓴다", () => {
    const { getByRole } = render(statusTabs("running"));
    // The shared Tabs classes resolve against these ancestor attributes.
    expect(getByRole("navigation").getAttribute("data-orientation")).toBe(
      "horizontal",
    );
    expect(getByRole("list").getAttribute("data-variant")).toBe("line");
    expect(getByRole("navigation").className.split(" ")).toContain(
      "group/tabs",
    );
    const list = getByRole("list").className.split(" ");
    expect(list).toContain("group/tabs-list");
    expect(list).toContain("gap-1");
    expect(list).toContain("border-b");
    const classes = getByRole("link", { name: "실행 중 3" }).className.split(
      " ",
    );
    for (const name of [
      "group-data-[variant=line]/tabs-list:h-9",
      "group-data-[variant=line]/tabs-list:px-2",
      "gap-2",
      "font-medium",
      "text-control",
      "text-muted-foreground",
      "no-underline!",
      "hover:text-foreground",
      "aria-[current=page]:text-foreground",
      "group-data-[orientation=horizontal]/tabs:after:inset-x-2",
      "group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]",
      "group-data-[orientation=horizontal]/tabs:after:h-0.5",
      "group-data-[orientation=horizontal]/tabs:after:rounded-[1px]",
      "aria-[current=page]:after:opacity-100",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-focus-ring",
    ]) {
      expect(classes).toContain(name);
    }
    // Link's own colour would change the tab's look, and v4 keeps one weight
    // for the current tab and the rest.
    expect(classes).not.toContain("text-link");
    // Only the underline's size and bar are shared with Tabs; its
    // transitions, radius and svg rules would change how a route tab looks.
    for (const name of [
      "transition-all",
      "after:transition-opacity",
      "rounded-control",
      "border",
      "flex-1",
    ]) {
      expect(classes).not.toContain(name);
    }
    expect(classes.some((name) => name.includes("font-semibold"))).toBe(false);
    // Room for the outline inside the scroll clip, but no negative right
    // margin: that would widen the page past a parent with no padding.
    const nav = getByRole("navigation").className.split(" ");
    expect(nav).toContain("overflow-x-auto");
    expect(nav.filter((name) => /^-m[rx]?-/.test(name))).toEqual([]);
    expect(list).toContain("pr-1");
  });

  test("탭 순서는 링크 순서다", async () => {
    const { getAllByRole } = render(statusTabs("running"));
    const user = await setupUser();
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      order.push(document.activeElement?.getAttribute("href") ?? "");
    }
    expect(order).toEqual(
      getAllByRole("link").map((link) => link.getAttribute("href") ?? ""),
    );
  });

  test("두 진입점에서 같은 부품을 내보낸다", async () => {
    const root = await import("../index.ts");
    const patterns = await import("./index.ts");
    expect(root.LinkTabs === LinkTabs).toBe(true);
    expect(root.LinkTab === LinkTab).toBe(true);
    expect(patterns.LinkTabs === LinkTabs).toBe(true);
    expect(patterns.LinkTab === LinkTab).toBe(true);
  });
});
