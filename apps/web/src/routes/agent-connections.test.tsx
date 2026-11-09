import { describe, expect, test } from "bun:test";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, within } = await appHarness();

const MODEL = "/settings/workspace/model-connections";
const MCP = "/settings/workspace/mcp-servers";
const OLD = "/settings/workspace/connections";
const GROUP = "에이전트 연결";

const owner = { "GET /v1/auth/me": () => json(200, me()) };
const as = (role: "admin") => ({
  "GET /v1/auth/me": () => json(200, me(undefined, role)),
});

const sidebar = async () =>
  within(await screen.findByRole("navigation", { name: "설정" }));
const group = async () =>
  within((await sidebar()).getByRole("group", { name: GROUP }));

describe("설정 사이드바의 에이전트 연결 그룹", () => {
  test("소유자에게는 모델 연결과 MCP 서버가 이 그룹 아래에 새 주소로 있다", async () => {
    renderAt("/settings/workspace/achievement-rules", owner);
    const items = await group();
    expect(
      items.getByRole("link", { name: "모델 연결" }).getAttribute("href"),
    ).toBe(MODEL);
    expect(
      items.getByRole("link", { name: "MCP 서버" }).getAttribute("href"),
    ).toBe(MCP);
    expect(
      items.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual([MODEL, MCP]);
    expect(
      (await sidebar())
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-labelledby"))
        .map((id) => (id ? document.getElementById(id)?.textContent : null)),
    ).toEqual(["워크스페이스", GROUP, "내 설정"]);
  });

  test("워크스페이스 그룹에는 두 항목이 없고 옛 주소를 가리키는 링크도 없다", async () => {
    renderAt("/settings/workspace/achievement-rules", owner);
    const nav = await sidebar();
    const workspace = within(nav.getByRole("group", { name: "워크스페이스" }));
    expect(workspace.queryByRole("link", { name: "모델 연결" }) === null).toBe(
      true,
    );
    expect(workspace.queryByRole("link", { name: "MCP 서버" }) === null).toBe(
      true,
    );
    const hrefs = nav.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(hrefs.includes(OLD)).toBe(false);
  });

  test.each([
    [MODEL, "모델 연결", "MCP 서버"],
    [`${MODEL}/`, "모델 연결", "MCP 서버"],
    [MCP, "MCP 서버", "모델 연결"],
    [`${MCP}/`, "MCP 서버", "모델 연결"],
  ])("%s에서는 %s 항목만 현재 페이지다", async (path, current, other) => {
    renderAt(path, {
      ...owner,
      "GET /v1/profiles": () => json(200, { items: [] }),
    });
    const items = await group();
    expect(
      items.getByRole("link", { name: current }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      items.getByRole("link", { name: other }).getAttribute("aria-current") ===
        null,
    ).toBe(true);
  });

  test.each([
    ["관리자", as("admin")],
    ["구성원", { "GET /v1/auth/me": () => json(200, memberMe()) }],
  ])("%s 메뉴에는 그룹이 통째로 없다", async (_role, routes) => {
    renderAt("/settings/workspace/achievement-rules", routes);
    const nav = await sidebar();
    expect(nav.queryByRole("group", { name: GROUP }) === null).toBe(true);
    expect(nav.queryByRole("link", { name: "모델 연결" }) === null).toBe(true);
    expect(nav.queryByRole("link", { name: "MCP 서버" }) === null).toBe(true);
  });
});

describe("지운 모델 연결 경로", () => {
  test.each([OLD, `${OLD}/`])(
    "%s는 어디로도 보내지 않고 찾을 수 없음 화면이다",
    async (old) => {
      const { history } = renderAt(old, owner);
      expect(await screen.findByText("찾을 수 없는 화면입니다")).toBeTruthy();
      expect(history.location.pathname === old).toBe(true);
      expect(screen.queryByRole("table", { name: "모델 연결" }) === null).toBe(
        true,
      );
    },
  );
});
