import { afterEach, describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { THEME_STORAGE_KEY } from "../components/theme.ts";
import {
  apiError,
  json,
  keys,
  me,
  memberMe,
  SCOPE,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness, WAITING_SESSIONS } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const AT = "2026-10-11T08:14:02.000Z";
const waiting = (id: string) => ({
  id,
  revision: 1,
  admission_state: "active",
  status: "needs_input",
  runtime: {
    kind: "claude_agent_sdk",
    version: "1.0.0",
    profile_id: "default",
    model: "model-default",
    permission_mode: "default",
  },
  repository_id: "demo",
  current_turn_id: "1",
  queued_turn_count: 0,
  model: "model-default",
  last_event_at: AT,
  created_at: AT,
  updated_at: AT,
});
const FIRST = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const SECOND = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const signedIn = { "GET /v1/auth/me": () => json(200, me()) };

// The column inside <main> that centres up to the screen's width.
const contentColumn = () =>
  document.getElementById("main")?.firstElementChild as HTMLElement | null;

afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe("app shell", () => {
  // Console v4 navWs: members and settings join the workspace group for its
  // managers only; a member reaches their own settings from the account menu.
  const MANAGER_NAV = [
    [
      ["홈", "/"],
      ["세션", "/sessions"],
      ["에이전트", "/agents"],
    ],
    [
      ["프로필", "/profiles"],
      ["사용량·한도", "/operations"],
      ["성과", "/achievements"],
      ["구성원", "/members"],
      ["설정", "/settings/workspace"],
    ],
  ];
  for (const [role, signedInAs, expected] of [
    ["owner", me(), MANAGER_NAV],
    ["admin", me(undefined, "admin"), MANAGER_NAV],
    [
      "member",
      memberMe(),
      [
        MANAGER_NAV[0],
        [
          ["프로필", "/profiles"],
          ["사용량·한도", "/operations"],
          ["성과", "/achievements"],
        ],
      ],
    ],
  ] as const) {
    test(`the sidebar an ${role} sees`, async () => {
      renderAt("/", { "GET /v1/auth/me": () => json(200, signedInAs) });
      const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
      await waitFor(() =>
        expect(
          within(nav)
            .getAllByRole("group")
            .map((group) =>
              within(group)
                .getAllByRole("link")
                .map((link) => [link.textContent, link.getAttribute("href")]),
            ),
        ).toEqual(expected as unknown as string[][][]),
      );
      expect(within(nav).getByRole("group", { name: "업무" })).toBeDefined();
      expect(
        within(nav).getByRole("group", { name: "워크스페이스" }),
      ).toBeDefined();
      expect(within(nav).queryByText("운영")).toBeNull();
    });
  }

  test("a labelled sidebar group folds under its heading and opens again", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, me()) });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    const heading = await within(nav).findByRole("button", {
      name: "워크스페이스",
    });
    const group = within(nav).getByRole("group", { name: "워크스페이스" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(within(group).getAllByRole("link")).toHaveLength(5);
    // Plain line icons: no coloured tile behind them.
    expect(nav.querySelectorAll("[data-slot=icon-tile]")).toHaveLength(0);
    expect(nav.querySelectorAll("a > svg")).toHaveLength(8);
    const user = await setupUser();
    await user.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(within(group).queryAllByRole("link")).toHaveLength(0);
    await user.click(heading);
    expect(within(group).getAllByRole("link")).toHaveLength(5);
  });

  test("a member keeps their own settings in the account menu", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    await user.click(
      within(region).getByRole("button", {
        name: "Owner owner@example.com · 구성원",
      }),
    );
    const menu = screen.getByRole("menu", {
      name: "Owner owner@example.com · 구성원",
    });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => [item.textContent, item.getAttribute("href")]),
    ).toEqual([
      ["연동 계정", "/settings/linked-accounts"],
      ["언어한국어", null],
      ["테마시스템 설정", null],
      ["API 키", "/settings/api-keys"],
      [
        "Werft 문서(새 탭에서 열림)",
        "https://jeongjaesoon.github.io/werft/ko/",
      ],
      ["로그아웃", null],
    ]);
  });

  test("the top bar names the page with the sidebar's words", async () => {
    renderAt("/settings/api-keys", signedIn);
    // The page head is a <header> too; the top bar comes first.
    const [header] = await screen.findAllByRole("banner");
    await waitFor(() => expect(header?.textContent).toBe("메뉴 열기API 키"));
  });

  test("a member on their teams still reads 구성원 in the top bar", async () => {
    renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    await within(nav).findByRole("link", { name: "프로필" });
    expect(within(nav).queryByRole("link", { name: "구성원" })).toBeNull();
    const [header] = screen.getAllByRole("banner");
    await waitFor(() => expect(header?.textContent).toBe("메뉴 열기구성원"));
  });

  // An address with no screen under the settings root must not read as the
  // "일반" page it only shares a prefix with.
  for (const path of [
    "/settings/workspace/connections",
    "/settings/workspace/nothing/here",
  ]) {
    test(`${path} has no screen and the top bar reads 설정, not 일반`, async () => {
      renderAt(path, signedIn);
      const [header] = await screen.findAllByRole("banner");
      await waitFor(() => expect(header?.textContent).toBe("메뉴 열기설정"));
    });
  }

  for (const [path, title] of [
    ["/settings/workspace", "일반"],
    ["/settings/workspace/", "일반"],
    ["/settings/workspace/achievement-rules", "성과 규칙"],
    ["/settings/workspace/integrations/slack", "연동"],
    ["/settings/workspace/integrations/github/new-app", "연동"],
    ["/settings/workspace/api-keys", "조직 관리 키"],
  ] as const) {
    test(`${path} still reads ${title} in the top bar`, async () => {
      renderAt(path, signedIn);
      const [header] = await screen.findAllByRole("banner");
      await waitFor(() =>
        expect(header?.textContent).toBe(`메뉴 열기${title}`),
      );
    });
  }

  for (const [path, title] of [
    ["/operations", "사용량·한도"],
    ["/operations/limits", "사용량·한도"],
    ["/achievements", "성과"],
    ["/profiles", "프로필"],
  ] as const) {
    test(`${path} is named ${title} in the top bar and the page head`, async () => {
      renderAt(path, signedIn);
      await screen.findByRole("heading", { level: 1, name: title });
      const [header] = screen.getAllByRole("banner");
      await waitFor(() =>
        expect(header?.textContent).toBe(`메뉴 열기${title}`),
      );
    });
  }

  // V4-PAGE-FRAME: settings and forms used to stop at 1100px.
  for (const [path, title] of [
    ["/settings/api-keys", "API 키"],
    ["/settings/workspace", "일반"],
    ["/settings/workspace/", "일반"],
    ["/settings/workspace/integrations/slack", "연동"],
    ["/settings/preferences", "언어·테마"],
    ["/settings/linked-accounts", "연동 계정"],
    ["/settings/api-keys/new", "새 개인 키"],
  ] as const) {
    test(`${path} sits in the one page frame`, async () => {
      renderAt(path, signedIn);
      await screen.findByRole("heading", { level: 1, name: title });
      const frame = contentColumn();
      expect(frame?.dataset.slot).toBe("page-frame");
      expect(frame?.className).toContain("md:px-6");
      expect(
        frame?.querySelector('[data-slot="page-frame-body"]')?.className,
      ).toContain("max-w-[var(--werft-w-page)]");
    });
  }

  // Home and the sessions list open a waiting session in a rail at the
  // screen's edge, so they frame their own body, in the same frame.
  for (const [path, title] of [
    ["/", "홈"],
    ["/sessions", "세션"],
  ] as const) {
    test(`${path} frames its body beside the rail`, async () => {
      renderAt(path, signedIn);
      await screen.findByRole("heading", { level: 1, name: title });
      expect(contentColumn()?.dataset.slot).toBe("page-flush");
      const frame = document.querySelector<HTMLElement>(
        '[data-slot="detail-layout"] > [data-slot="page-frame"]',
      );
      expect(frame?.className).toContain("md:px-6");
      expect(
        frame?.querySelector('[data-slot="page-frame-body"]')?.className,
      ).toContain("max-w-[var(--werft-w-page)]");
    });
  }

  // Settings tabs and forms run to the frame's edge like the lists: nothing
  // between the frame and the page caps its width.
  for (const [path, title] of [
    ["/sessions", "세션"],
    ["/settings/api-keys", "API 키"],
    ["/settings/workspace", "일반"],
    ["/settings/workspace/integrations/slack", "연동"],
    ["/settings/workspace/integrations/github", "연동"],
    ["/settings/workspace/api-keys", "조직 관리 키"],
    ["/settings/preferences", "언어·테마"],
    ["/settings/linked-accounts", "연동 계정"],
    ["/settings/api-keys/new", "새 개인 키"],
    ["/agents/new", "새 에이전트"],
  ] as const) {
    test(`${path} takes the whole frame`, async () => {
      renderAt(path, signedIn);
      const heading = await screen.findByRole("heading", {
        level: 1,
        name: title,
      });
      const capped: string[] = [];
      let el = heading.closest('[data-slot="page"]');
      for (
        ;
        el && el.getAttribute("data-slot") !== "page-frame-body";
        el = el.parentElement
      ) {
        if (el.className.includes("max-w-")) capped.push(el.className);
      }
      expect(el).not.toBeNull();
      expect(capped).toEqual([]);
    });
  }

  test("/sessions/map is a screen under 세션, not a session", async () => {
    renderAt("/sessions/map", {
      ...signedIn,
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    await screen.findByRole("heading", { level: 1, name: "에이전트 지도" });
    const [header] = await screen.findAllByRole("banner");
    await waitFor(() =>
      expect(header?.textContent).toBe("메뉴 열기세션/에이전트 지도"),
    );
    expect(contentColumn()?.dataset.slot).toBe("page-frame");
  });

  test("the top bar's trail is a named nav: a list, the item a link back, the page current", async () => {
    renderAt("/sessions/map", {
      ...signedIn,
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    const [header] = await screen.findAllByRole("banner");
    const trail = await within(header as HTMLElement).findByRole("navigation", {
      name: "메뉴 위치",
    });
    // The item and the page; the separator between them is hidden.
    await waitFor(() =>
      expect(within(trail).getAllByRole("listitem")).toHaveLength(2),
    );
    const back = within(trail).getByRole("link", { name: "세션" });
    expect(back.getAttribute("href")).toBe("/sessions");
    expect(
      [...trail.querySelectorAll("[aria-current=page]")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["에이전트 지도"]);
    // The separator is drawn, not read.
    expect(
      within(trail)
        .getAllByRole("listitem", { hidden: true })
        .filter((item) => item.getAttribute("aria-hidden") === "true")
        .map((item) => item.textContent),
    ).toEqual(["/"]);
  });

  test("only the current page's sidebar row is marked, and its icon inherits the text colour", async () => {
    renderAt("/sessions/map", signedIn);
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    await waitFor(() =>
      expect(
        [...nav.querySelectorAll("a[aria-current=page]")].map(
          (link) => link.textContent,
        ),
      ).toEqual(["세션"]),
    );
    const current = nav.querySelector("a[aria-current=page]");
    expect(current?.className).toContain(
      "aria-[current=page]:text-sidebar-selected-text",
    );
    expect(current?.querySelector("svg")?.getAttribute("class")).not.toMatch(
      /text-/,
    );
  });

  test("the sessions list opens the agent map", async () => {
    renderAt("/sessions", signedIn);
    await screen.findByRole("heading", { level: 1, name: "세션" });
    expect(
      screen.getByRole("link", { name: "에이전트 지도" }).getAttribute("href"),
    ).toBe("/sessions/map");
  });

  test("a session's detail lays out the whole area itself", async () => {
    renderAt(`/sessions/${FIRST}`, signedIn);
    await waitFor(() =>
      expect(contentColumn()?.dataset.slot).toBe("page-flush"),
    );
    const main = document.getElementById("main");
    expect(main?.className).not.toContain("p-4");
    expect(contentColumn()?.className).not.toContain("max-w-");
  });

  test("the top bar makes nothing; each list offers its own", async () => {
    renderAt("/sessions", signedIn);
    const [header] = await screen.findAllByRole("banner");
    await within(header as HTMLElement).findByText("세션");
    expect(within(header as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(header as HTMLElement).queryByText("새로 만들기")).toBeNull();
  });

  test("the sessions item counts the sessions waiting for an answer", async () => {
    const { api } = renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () =>
        json(200, {
          items: [waiting(FIRST), waiting(SECOND)],
          next_cursor: null,
        }),
    });
    const link = await screen.findByRole("link", {
      name: "세션 답변 대기 2개",
    });
    expect(link.getAttribute("href")).toBe("/sessions");
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/sessions" && call.search === "?status=needs_input",
      ),
    ).toBe(true);
  });

  test("the badge reads again when the core's waiting key goes stale", async () => {
    let answered = 0;
    const { services } = renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () =>
        json(200, {
          items: answered++ === 0 ? [waiting(FIRST)] : [],
          next_cursor: null,
        }),
    });
    await screen.findByRole("link", { name: "세션 답변 대기 1개" });
    // What a session's status event invalidates.
    await services.queryClient.invalidateQueries({
      queryKey: keys.waitingSessions,
      exact: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "세션" })).toBeDefined(),
    );
  });

  test("a first page with more behind it reads as at least that many", async () => {
    renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () =>
        json(200, { items: [waiting(FIRST)], next_cursor: "next-1" }),
    });
    const link = await screen.findByRole("link", {
      name: "세션 답변 대기 1개 이상",
    });
    expect(link.textContent).toContain("1+");
  });

  test("retry on the shell's error screen asks who is signed in again", async () => {
    let failures = 1;
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () =>
        failures-- > 0
          ? json(500, { error: { code: "INTERNAL" } })
          : json(200, me()),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "홈" })).toBeDefined();
    // Only the reads: a console opening in ko with no saved language also saves ko.
    expect(
      api.calls.filter(
        (call) => call.method === "GET" && call.path === "/v1/auth/me",
      ),
    ).toHaveLength(2);
  });

  test("nothing waiting, or a list that failed, shows no badge", async () => {
    renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () => json(500, { error: { code: "INTERNAL" } }),
    });
    const link = await screen.findByRole("link", { name: "세션" });
    expect(link.textContent).toBe("세션");
  });

  test("the account menu holds linked accounts, language, theme, keys and logout", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const trigger = within(region).getByRole("button", {
      name: "Owner owner@example.com · 소유자",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);

    const user = await setupUser();
    await user.click(trigger);
    const menu = screen.getByRole("menu", {
      name: "Owner owner@example.com · 소유자",
    });
    expect(within(menu).getByText("owner@example.com")).toBeDefined();
    expect(within(menu).getByText("소유자 · Acme")).toBeDefined();
    // Each submenu item shows its current value after the label.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "연동 계정",
      "언어한국어",
      "테마시스템 설정",
      "API 키",
      "Werft 문서(새 탭에서 열림)",
      "로그아웃",
    ]);
    expect(
      within(menu)
        .getByRole("menuitem", { name: "API 키" })
        .getAttribute("href"),
    ).toBe("/settings/api-keys");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "연동 계정" })
        .getAttribute("href"),
    ).toBe("/settings/linked-accounts");

    await user.click(within(menu).getByRole("menuitem", { name: /^테마/ }));
    await user.click(
      within(screen.getByRole("menu", { name: /^테마/ })).getByRole(
        "menuitemradio",
        { name: "어둡게" },
      ),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.queryByRole("menu", { name: /^테마/ })).toBeNull();
    const themeItem = within(menu).getByRole("menuitem", { name: /^테마/ });
    expect(themeItem.textContent).toBe("테마어둡게");
    await user.click(themeItem);
    expect(
      within(screen.getByRole("menu", { name: /^테마/ }))
        .getByRole("menuitemradio", { name: "어둡게" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(
      within(screen.getByRole("menu", { name: /^테마/ })).getByRole(
        "menuitemradio",
        { name: "시스템 설정" },
      ),
    );
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await user.click(within(menu).getByRole("menuitem", { name: /^언어/ }));
    const languages = screen.getByRole("menu", { name: /^언어/ });
    expect(
      within(languages)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["한국어", "日本語", "English"]);
    await user.click(
      within(languages).getByRole("menuitemradio", { name: "English" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: /^Language/ }),
    ).toBeDefined();
  });

  test("the docs item opens the public site in the console's language", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    await user.click(within(region).getByRole("button", { name: /Owner/ }));

    const docs = screen.getByRole("menuitem", { name: /^Werft 문서/ });
    expect(docs.getAttribute("href")).toBe(
      "https://jeongjaesoon.github.io/werft/ko/",
    );
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toBe("noopener noreferrer");

    await user.click(screen.getByRole("menuitem", { name: /^언어/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "English" }));
    expect(
      (
        await screen.findByRole("menuitem", { name: /^Werft docs/ })
      ).getAttribute("href"),
    ).toBe("https://jeongjaesoon.github.io/werft/en/");

    await user.click(screen.getByRole("menuitem", { name: /^Language/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "日本語" }));
    expect(
      (
        await screen.findByRole("menuitem", { name: /^Werft ドキュメント/ })
      ).getAttribute("href"),
    ).toBe("https://jeongjaesoon.github.io/werft/ja/");
  });

  test("the docs item is reached by arrow keys and hands focus back to the pill", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    const pill = within(region).getByRole("button", { name: /Owner/ });
    pill.focus();
    await user.keyboard("{ArrowDown}");
    // The first item has focus; up wraps to logout, up again is the docs item.
    await user.keyboard("{ArrowUp}{ArrowUp}");
    const docs = screen.getByRole("menuitem", { name: /^Werft 문서/ });
    expect(document.activeElement === docs).toBe(true);

    await user.click(docs);
    // Not toBeNull(): Bun passes it for an element that is still there.
    expect(screen.queryByRole("menu") === null).toBe(true);
    expect(document.activeElement === pill).toBe(true);
  });

  test("following a link in the account menu puts focus on the page", async () => {
    const { history } = renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    await user.click(within(region).getByRole("button", { name: /Owner/ }));
    await user.click(screen.getByRole("menuitem", { name: "API 키" }));
    expect(history.location.pathname).toBe("/settings/api-keys");
    expect(screen.queryByRole("menu")).toBeNull();
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "API 키",
    });
    await waitFor(() => expect(document.activeElement === title).toBe(true));
  });

  // happy-dom has no layout; the width at 390px is measured in the browser.
  test("below md the account menu spans the whole user bar, not the pill", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    await user.click(within(region).getByRole("button", { name: /Owner/ }));
    const menu = screen.getByRole("menu", { name: /Owner/ });
    expect(menu.classList.contains("inset-x-0")).toBe(true);
    let anchor = menu.parentElement;
    while (anchor && !anchor.classList.contains("relative")) {
      anchor = anchor.parentElement;
    }
    expect(anchor?.contains(region)).toBe(true);
    expect(
      anchor?.querySelector('a[href="/sessions"][aria-label]'),
    ).not.toBeNull();
  });

  test("the account menu works from the keyboard", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const trigger = within(region).getByRole("button", { name: /Owner/ });
    const user = await setupUser();
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("연동 계정");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("한국어");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("日本語");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("English");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: /^언어/ })).toBeNull();
    expect(document.activeElement?.textContent).toBe("언어한국어");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("시스템 설정");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("테마시스템 설정");
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("로그아웃");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement === trigger).toBe(true);

    await user.click(trigger);
    await user.click(screen.getByRole("link", { name: "구성원" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("a stored theme applies on the next load", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderAt("/login", {});
    await screen.findByRole("heading", { name: "로그인" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("the menu button opens the sidebar and a link followed closes it", async () => {
    renderAt("/", signedIn);
    const toggle = await screen.findByRole("button", { name: "메뉴 열기" });
    const sidebar = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(sidebar?.dataset.open).toBe("false");
    const user = await setupUser();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar?.dataset.open).toBe("true");
    await user.click(
      within(sidebar as HTMLElement).getByRole("link", { name: "구성원" }),
    );
    expect(sidebar?.dataset.open).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "메뉴 열기" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "구성원",
    });
    await waitFor(() => expect(document.activeElement === title).toBe(true));
  });
});

describe("focus after a page change", () => {
  test("a sidebar link puts focus on the next page's title", async () => {
    renderAt("/", signedIn);
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    const user = await setupUser();
    await user.click(within(nav).getByRole("link", { name: "에이전트" }));
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "에이전트",
    });
    await waitFor(() => expect(document.activeElement === title).toBe(true));
    expect(title.getAttribute("tabindex")).toBe("-1");
  });

  test("logging out puts focus on the login title", async () => {
    let out = false;
    renderAt("/", {
      "GET /v1/auth/me": () =>
        out
          ? apiError(401, "UNAUTHORIZED", "Authentication is required")
          : json(200, me()),
      "POST /v1/auth/logout": () => {
        out = true;
        return new Response(null, { status: 204 });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner owner@example.com · 소유자",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "로그아웃" }));
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "로그인",
    });
    await waitFor(() => expect(document.activeElement === title).toBe(true));
  });

  test("the first page leaves focus where the browser put it", async () => {
    renderAt("/agents", signedIn);
    await screen.findByRole("heading", { level: 1, name: "에이전트" });
    await screen.findByRole("navigation", { name: "주요 메뉴" });
    expect(document.activeElement?.tagName).toBe("BODY");
  });

  test("a status tab, a change of search alone, keeps focus on the tab", async () => {
    const { history } = renderAt("/sessions", signedIn);
    await screen.findByRole("heading", { level: 1, name: "세션" });
    const user = await setupUser();
    const failed = screen.getByRole("button", { name: "실패" });
    await user.click(failed);
    await waitFor(() =>
      expect(failed.getAttribute("aria-pressed")).toBe("true"),
    );
    expect(history.location.search).toBe("?status=failed");
    expect(document.activeElement === failed).toBe(true);
  });

  test("focus taken while a redirect is decided stays there", async () => {
    let hold: Promise<Response> | null = null;
    let release = () => {};
    const { api, history } = renderAt("/agents", {
      "GET /v1/auth/me": () => hold ?? json(200, me()),
    });
    await screen.findByRole("heading", { level: 1, name: "에이전트" });
    hold = new Promise((resolve) => {
      release = () => resolve(json(200, me()));
    });
    const asked = api.calls.length;
    // A live session on /login goes on to the home page.
    const going = history.push("/login");
    await waitFor(() =>
      expect(
        api.calls.slice(asked).some((call) => call.path === "/v1/auth/me"),
      ).toBe(true),
    );
    const toggle = screen.getByRole("button", { name: "메뉴 열기" });
    toggle.focus();
    release();
    await going;
    await screen.findByRole("heading", { level: 1, name: "홈" });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(document.activeElement === toggle).toBe(true);
  });

  test("a second link followed while the first page loads still moves focus", async () => {
    let hold: Promise<Response> | null = null;
    const { api, history } = renderAt("/", {
      "GET /v1/auth/me": () => hold ?? json(200, me()),
    });
    await screen.findByRole("heading", { level: 1, name: "홈" });
    // The /login check never answers; the sidebar link replaces it.
    hold = new Promise(() => {});
    const asked = api.calls.length;
    void history.push("/login");
    await waitFor(() =>
      expect(
        api.calls.slice(asked).some((call) => call.path === "/v1/auth/me"),
      ).toBe(true),
    );
    hold = null;
    const nav = screen.getByRole("navigation", { name: "주요 메뉴" });
    const user = await setupUser();
    await user.click(within(nav).getByRole("link", { name: "에이전트" }));
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "에이전트",
    });
    await waitFor(() => expect(document.activeElement === title).toBe(true));
  });

  test("back from an open account menu leaves focus in the menu", async () => {
    const { history } = renderAt("/agents", signedIn);
    await screen.findByRole("heading", { level: 1, name: "에이전트" });
    await history.push("/profiles");
    await screen.findByRole("heading", { level: 1, name: "프로필" });
    const region = screen.getByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    within(region).getByRole("button", { name: /Owner/ }).focus();
    await user.keyboard("{ArrowUp}");
    const item = screen.getByRole("menuitem", { name: "연동 계정" });
    expect(document.activeElement === item).toBe(true);
    history.back();
    await screen.findByRole("heading", { level: 1, name: "에이전트" });
    expect(document.activeElement === item).toBe(true);
  });

  test("focus taken while the page changes stays there", async () => {
    const { history } = renderAt("/", signedIn);
    await screen.findByRole("heading", { level: 1, name: "홈" });
    const toggle = screen.getByRole("button", { name: "메뉴 열기" });
    const going = history.push("/agents");
    toggle.focus();
    await going;
    await screen.findByRole("heading", { level: 1, name: "에이전트" });
    expect(document.activeElement === toggle).toBe(true);
  });
});

describe("who the cache belongs to", () => {
  const MATE_ID = "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b";
  const mate = () => {
    const base = memberMe();
    return {
      ...base,
      principal: { ...base.principal, id: MATE_ID },
      user: {
        id: MATE_ID,
        email: "mate@example.com",
        display_name: "Mate",
        locale: null,
      },
    };
  };
  const MATE_SCOPE = { actor: `user:${MATE_ID}`, workspace: WORKSPACE_ID };
  const SIGN_IN_KEYS = [["me"], ["me", "optional"], ["login-methods"]].map(
    (key) => JSON.stringify(key),
  );
  /** Every cached key but the ones that find out who is signed in. */
  const scopedKeys = (services: ReturnType<typeof renderAt>["services"]) =>
    services.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
      .filter((key) => !SIGN_IN_KEYS.includes(JSON.stringify(key)));
  const ownerWaiting = () =>
    json(200, { items: [waiting(FIRST)], next_cursor: null });

  test("every key a screen caches leads with who is signed in and the workspace", async () => {
    const { history, services } = renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: ownerWaiting,
    });
    await screen.findByRole("link", { name: "세션 답변 대기 1개" });
    // Unrouted reads fail, but their keys are cached all the same.
    for (const path of [
      "/sessions",
      "/agents",
      "/members",
      "/members/teams",
      "/operations",
      "/operations/tools",
      "/usage",
      "/settings/api-keys",
      "/settings/linked-accounts",
      "/settings/workspace",
      "/settings/workspace/integrations/slack",
    ]) {
      await history.push(path);
      await waitFor(() => expect(history.location.pathname).toBe(path));
      // Long polls never settle; give the screen's reads a moment to start.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const cached = scopedKeys(services);
    expect(cached.length).toBeGreaterThan(10);
    for (const key of cached) expect(key[0]).toEqual(SCOPE);
  });

  test("someone else signing in on the same browser never sees the last person's entries", async () => {
    let who: "owner" | "mate" = "owner";
    const { services } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, who === "owner" ? me() : mate()),
      // Mate's own count never arrives, so only a leftover could show one.
      [WAITING_SESSIONS]: () =>
        who === "owner" ? ownerWaiting() : new Promise<Response>(() => {}),
    });
    await screen.findByRole("link", { name: "세션 답변 대기 1개" });
    who = "mate";
    await services.queryClient.refetchQueries({ queryKey: ["me"] });
    await screen.findByRole("button", { name: /^Mate mate@example\.com · / });
    await waitFor(() => {
      const cached = scopedKeys(services);
      expect(cached.length).toBeGreaterThan(0);
      for (const key of cached) expect(key[0]).toEqual(MATE_SCOPE);
    });
    expect(
      screen.queryByRole("link", { name: "세션 답변 대기 1개" }),
    ).toBeNull();
  });

  test("a list that keeps its rows while it reloads drops the last person's rows when someone else signs in", async () => {
    let who: "owner" | "mate" = "owner";
    const { services } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, who === "owner" ? me() : mate()),
      // Mate's own list never arrives, so only a leftover could show.
      "GET /v1/sessions": () =>
        who === "owner" ? ownerWaiting() : new Promise<Response>(() => {}),
    });
    await screen.findByRole("link", { name: `세션 열기: ${FIRST}` });
    who = "mate";
    await services.queryClient.refetchQueries({ queryKey: ["me"] });
    await screen.findByRole("button", { name: /^Mate mate@example\.com · / });
    expect(
      screen.queryByRole("link", { name: `세션 열기: ${FIRST}` }),
    ).toBeNull();
  });

  test("after a logout the next person reads their own data, none of the last one's", async () => {
    let who: "owner" | "mate" | null = "owner";
    const { api, history, services } = renderAt("/", {
      "GET /v1/auth/me": () =>
        who === null
          ? apiError(401, "UNAUTHORIZED", "Authentication is required")
          : json(200, who === "owner" ? me() : mate()),
      "POST /v1/auth/logout": () => {
        who = null;
        return new Response(null, { status: 204 });
      },
      [WAITING_SESSIONS]: () =>
        who === "owner"
          ? ownerWaiting()
          : json(200, { items: [], next_cursor: null }),
    });
    await screen.findByRole("link", { name: "세션 답변 대기 1개" });
    const user = await setupUser();
    await user.click(
      screen.getByRole("button", { name: "Owner owner@example.com · 소유자" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "로그아웃" }));
    await screen.findByText("로그아웃했습니다.");
    // Mate signs in elsewhere in this browser; the cookie is theirs now.
    who = "mate";
    await history.push("/");
    await screen.findByRole("button", { name: /^Mate mate@example\.com · / });
    await screen.findByRole("heading", { name: "홈" });
    const waitingReads = api.calls.filter(
      (call) =>
        call.path === "/v1/sessions" && call.search === "?status=needs_input",
    );
    expect(waitingReads.length).toBe(2);
    const cached = scopedKeys(services);
    expect(cached.length).toBeGreaterThan(0);
    for (const key of cached) expect(key[0]).toEqual(MATE_SCOPE);
    expect(
      screen.queryByRole("link", { name: "세션 답변 대기 1개" }),
    ).toBeNull();
  });
});
