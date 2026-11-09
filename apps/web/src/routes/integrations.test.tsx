import { describe, expect, test } from "bun:test";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, within } = await appHarness();

const BASE = "/settings/workspace/integrations";
const SLACK = `${BASE}/slack`;
const GITHUB = `${BASE}/github`;
const CALLBACK = `${BASE}/github/new-app`;
const owner = { "GET /v1/auth/me": () => json(200, me()) };

const tabs = async () =>
  within(await screen.findByRole("navigation", { name: "연동 종류" }));
const sidebar = async () =>
  within(await screen.findByRole("navigation", { name: "설정" }));

describe("연동 페이지의 탭", () => {
  test.each([
    [SLACK, "Slack", "GitHub"],
    [GITHUB, "GitHub", "Slack"],
    [`${SLACK}/`, "Slack", "GitHub"],
    [`${GITHUB}/`, "GitHub", "Slack"],
    // The App callback sits under the GitHub address and keeps its tab lit.
    [CALLBACK, "GitHub", "Slack"],
  ])("%s에서는 %s 탭만 현재 페이지다", async (path, current, other) => {
    renderAt(path, owner);
    const nav = await tabs();
    expect(
      nav.getByRole("link", { name: current }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      nav.getByRole("link", { name: other }).getAttribute("aria-current") ===
        null,
    ).toBe(true);
    expect(nav.getByRole("link", { name: "Slack" }).getAttribute("href")).toBe(
      SLACK,
    );
    expect(nav.getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe(
      GITHUB,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "연동" }).tagName === "H1",
    ).toBe(true);
  });
});

describe("설정 사이드바의 연동 항목", () => {
  test.each([SLACK, GITHUB, `${GITHUB}/`, CALLBACK])(
    "%s에서 연동 한 항목이 현재 페이지고 옛 두 항목은 없다",
    async (path) => {
      renderAt(path, owner);
      const nav = await sidebar();
      const item = nav.getByRole("link", { name: "연동" });
      expect(item.getAttribute("aria-current")).toBe("page");
      expect(item.getAttribute("href")).toBe(SLACK);
      expect(nav.queryByRole("link", { name: "Slack 연결 설정" })).toBeNull();
      expect(nav.queryByRole("link", { name: "GitHub 연결 설정" })).toBeNull();
    },
  );

  test("관리자에게는 보이고 구성원에게는 항목이 없다", async () => {
    renderAt("/settings/workspace/achievement-rules", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
    });
    expect(
      (await sidebar())
        .getByRole("link", { name: "연동" })
        .getAttribute("href"),
    ).toBe(SLACK);
  });

  test("구성원 메뉴에는 연동이 없다", async () => {
    renderAt("/settings/workspace/achievement-rules", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    const nav = await sidebar();
    expect(nav.queryByRole("link", { name: "연동" })).toBeNull();
  });

  test("구성원이 주소로 열면 페이지는 열리지만 메뉴 항목은 없다", async () => {
    renderAt(SLACK, { "GET /v1/auth/me": () => json(200, memberMe()) });
    expect(
      await screen.findByRole("heading", { level: 1, name: "연동" }),
    ).toBeTruthy();
    expect((await sidebar()).queryByRole("link", { name: "연동" })).toBeNull();
  });
});

describe("지운 경로", () => {
  test.each([
    BASE,
    `${BASE}/`,
    "/settings/workspace/slack",
    "/settings/workspace/slack-apps",
    "/settings/workspace/github",
    "/settings/workspace/github/new-app",
  ])("%s는 어디로도 보내지 않고 찾을 수 없음 화면이다", async (old) => {
    const { history } = renderAt(old, owner);
    expect(await screen.findByText("찾을 수 없는 화면입니다")).toBeTruthy();
    expect(history.location.pathname === old).toBe(true);
    expect(
      screen.queryByRole("heading", { level: 1, name: "연동" }),
    ).toBeNull();
  });
});
