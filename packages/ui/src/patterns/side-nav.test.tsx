import { describe, expect, mock, test } from "bun:test";
import type { ComponentProps, JSX } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { SideNav, SideNavGroup, SideNavLayout, SideNavLink } = await import(
  "./side-nav.tsx"
);

// Stands in for a router link: `to` becomes href.
function RouterLink({
  to,
  ...props
}: Omit<ComponentProps<"a">, "href"> & { readonly to: string }): JSX.Element {
  return <a href={to} {...props} />;
}

function settings(onPick?: () => void) {
  return (
    <SideNavLayout
      nav={
        <SideNav aria-label="설정" current="Slack 앱" onPick={onPick}>
          <SideNavGroup label="워크스페이스">
            <SideNavLink href="/settings/workspace">일반</SideNavLink>
            <SideNavLink href="/settings/workspace/integrations/slack" current>
              Slack 앱
            </SideNavLink>
          </SideNavGroup>
          <SideNavGroup label="내 설정">
            <SideNavLink asChild>
              <RouterLink to="/settings/linked-accounts">연동 계정</RouterLink>
            </SideNavLink>
          </SideNavGroup>
        </SideNav>
      }
    >
      <h1>Slack 앱</h1>
    </SideNavLayout>
  );
}

describe("SideNav", () => {
  test("이름 있는 nav 안에 제목으로 묶인 링크 그룹이 있다", () => {
    const { getByRole, getAllByRole } = render(settings());
    const nav = getByRole("navigation", { name: "설정" });
    expect(nav.tagName).toBe("NAV");
    const groups = getAllByRole("group");
    expect(
      groups.map(
        (group) =>
          group.getAttribute("aria-labelledby") &&
          document.getElementById(group.getAttribute("aria-labelledby") ?? "")
            ?.textContent,
      ),
    ).toEqual(["워크스페이스", "내 설정"]);
    expect(getAllByRole("link")).toHaveLength(3);
  });

  test("그룹 제목은 링크 글자색과 다른 subtle 색으로 링크와 구분된다", () => {
    const { getByText, getByRole } = render(settings());
    const heading = getByText("워크스페이스").className.split(" ");
    expect(heading).toContain("text-caption");
    expect(heading).toContain("text-subtle-foreground");
    const link = getByRole("link", { name: "일반" }).className.split(" ");
    expect(link).toContain("text-muted-foreground");
    expect(link).not.toContain("text-subtle-foreground");
    // 12px between groups, as in the mockup's sidebar.
    const toggle = getByRole("button", { name: /설정/ });
    const list = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(list?.className.split(" ")).toContain("gap-3");
  });

  test("current는 aria-current를 page로, location은 location으로 둔다", () => {
    const { getByRole } = render(
      <SideNav aria-label="Slack">
        <SideNavGroup>
          <SideNavLink href="#app" current="location">
            앱
          </SideNavLink>
          <SideNavLink href="#channels">채널</SideNavLink>
          <SideNavLink href="/x" current="page">
            페이지
          </SideNavLink>
        </SideNavGroup>
      </SideNav>,
    );
    expect(getByRole("link", { name: "앱" }).getAttribute("aria-current")).toBe(
      "location",
    );
    expect(
      getByRole("link", { name: "채널" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(
      getByRole("link", { name: "페이지" }).getAttribute("aria-current"),
    ).toBe("page");
    // A group with no heading is not labelled by an empty element.
    expect(getByRole("group").getAttribute("aria-labelledby")).toBeNull();
  });

  test("asChild는 넘긴 링크를 그 자리에 그리고 href를 지킨다", () => {
    const { getByRole } = render(settings());
    const link = getByRole("link", { name: "연동 계정" });
    expect(link.getAttribute("href")).toBe("/settings/linked-accounts");
    expect(link.querySelector("a")).toBeNull();
    expect(link.getAttribute("data-slot")).not.toBeNull();
  });

  test("asChild에서 SideNavLink와 자식 링크의 onClick이 둘 다 돌고 class도 둘 다 남는다", async () => {
    const user = await setupUser();
    const calls: string[] = [];
    const { getByRole } = render(
      <SideNav aria-label="설정">
        <SideNavGroup>
          <SideNavLink
            asChild
            className="outer"
            onClick={() => calls.push("outer")}
          >
            <RouterLink
              to="/x"
              className="inner"
              onClick={(event) => {
                event.preventDefault();
                calls.push("inner");
              }}
            >
              일반
            </RouterLink>
          </SideNavLink>
        </SideNavGroup>
      </SideNav>,
    );
    const link = getByRole("link", { name: "일반" });
    await user.click(link);
    expect(calls.sort()).toEqual(["inner", "outer"]);
    expect(link.classList.contains("inner")).toBe(true);
    expect(link.classList.contains("outer")).toBe(true);
  });

  test("목록을 닫은 Esc는 페이지의 바깥 핸들러로 올라가지 않는다", async () => {
    const user = await setupUser();
    const outer = mock(() => {});
    const { getByRole } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for a page-level Escape handler
      <div onKeyDown={outer}>{settings()}</div>,
    );
    await user.click(getByRole("button", { name: /^설정/ }));
    getByRole("link", { name: "일반" }).focus();
    await user.keyboard("{Escape}");
    expect(outer).not.toHaveBeenCalled();
  });

  test("접힌 버튼은 이름과 지금 항목을 읽고 목록을 열고 닫는다", async () => {
    const user = await setupUser();
    const { getByRole } = render(settings());
    const toggle = getByRole("button", { name: /^설정 · Slack 앱/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(list?.className).toContain("hidden");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list?.className).not.toMatch(/(^| )hidden( |$)/);
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  test("펼친 목록에서 Esc를 누르면 닫고 포커스를 버튼에 둔다", async () => {
    const user = await setupUser();
    const { getByRole } = render(settings());
    const toggle = getByRole("button", { name: /^설정/ });
    await user.click(toggle);
    getByRole("link", { name: "일반" }).focus();
    await user.keyboard("{Escape}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement === toggle).toBe(true);
  });

  test("펼친 목록에서 링크를 고르면 닫히고, 링크의 onClick 뒤에 onPick을 부른다", async () => {
    const user = await setupUser();
    const order: string[] = [];
    const onClick = mock((event: { preventDefault(): void }) => {
      event.preventDefault();
      order.push("link");
    });
    const onPick = mock(() => order.push("pick"));
    const { getByRole } = render(
      <SideNav aria-label="Slack" onPick={onPick}>
        <SideNavGroup>
          <SideNavLink href="#app" onClick={onClick}>
            앱
          </SideNavLink>
        </SideNavGroup>
      </SideNav>,
    );
    const toggle = getByRole("button", { name: /^Slack/ });
    await user.click(toggle);
    await user.click(getByRole("link", { name: "앱" }));
    expect(order).toEqual(["link", "pick"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Without a move by onPick, focus would have gone with the hidden link.
    expect(document.activeElement === toggle).toBe(true);
  });

  test("펼친 목록에서 고르면 링크의 onClick 전에 목록이 접히고, 버튼으로 돌아가는 포커스는 스크롤하지 않는다", async () => {
    const user = await setupUser();
    const seen: (string | null)[] = [];
    const { getByRole } = render(
      <SideNav aria-label="Slack">
        <SideNavGroup>
          <SideNavLink
            href="#app"
            onClick={(event) => {
              event.preventDefault();
              seen.push(toggle.getAttribute("aria-expanded"));
            }}
          >
            앱
          </SideNavLink>
        </SideNavGroup>
      </SideNav>,
    );
    const toggle = getByRole("button", { name: /^Slack/ });
    const focus = mock(toggle.focus.bind(toggle));
    toggle.focus = focus;
    await user.click(toggle);
    await user.click(getByRole("link", { name: "앱" }));
    // A section link scrolls in its onClick: the list it measures past must
    // already be gone, or the jump lands short by the list's height.
    expect(seen).toEqual(["false"]);
    expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
  });

  test("링크가 click 전파를 막으면 onPick은 부르지 않고 포커스는 버튼에 둔다", async () => {
    const user = await setupUser();
    const onPick = mock(() => {});
    const { getByRole } = render(
      <SideNav aria-label="Slack" onPick={onPick}>
        <SideNavGroup>
          <SideNavLink
            href="#app"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            앱
          </SideNavLink>
        </SideNavGroup>
      </SideNav>,
    );
    const toggle = getByRole("button", { name: /^Slack/ });
    await user.click(toggle);
    await user.click(getByRole("link", { name: "앱" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(onPick).not.toHaveBeenCalled();
    expect(document.activeElement === toggle).toBe(true);
  });

  test("접히지 않은 목록에서 고르면 onPick을 부르지 않는다", async () => {
    const user = await setupUser();
    const onPick = mock(() => {});
    const { getByRole } = render(settings(onPick));
    const link = getByRole("link", { name: "일반" });
    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);
    expect(onPick).not.toHaveBeenCalled();
  });
});
