import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, within, waitFor } = await appHarness();

const PERSONAL = [
  ["언어·테마", "/settings/preferences"],
  ["연동 계정", "/settings/linked-accounts"],
  ["API 키", "/settings/api-keys"],
];

const links = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);

const ROLES = [
  ["owner", me()],
  ["admin", me(undefined, "admin")],
  ["member", memberMe()],
] as const;

describe("settings areas", () => {
  for (const [role, signedInAs] of ROLES) {
    test(`the ${role}'s personal settings list only their own pages`, async () => {
      renderAt("/settings/preferences", {
        "GET /v1/auth/me": () => json(200, signedInAs),
      });
      const nav = await screen.findByRole("navigation", { name: "개인 설정" });
      await waitFor(() => expect(links(nav)).toEqual(PERSONAL));
      expect(within(nav).queryByRole("link", { name: "로그인 수단" })).toBe(
        null,
      );
      expect(
        screen.queryByRole("navigation", { name: "워크스페이스 설정" }),
      ).toBe(null);
    });
  }

  for (const [role, signedInAs, expected] of [
    [
      "owner",
      me(),
      [
        ["일반", "/settings/workspace"],
        ["성과 규칙", "/settings/workspace/achievement-rules"],
        ["로그인", "/settings/workspace/login"],
        ["실행 한도", "/settings/workspace/limits"],
        ["조직 관리 키", "/settings/workspace/api-keys"],
        ["감사 기록", "/settings/workspace/audit-log"],
        ["연동", "/settings/workspace/integrations/slack"],
        ["모델 연결", "/settings/workspace/model-connections"],
        ["MCP 서버", "/settings/workspace/mcp-servers"],
      ],
    ],
    [
      "admin",
      me(undefined, "admin"),
      [
        ["일반", "/settings/workspace"],
        ["성과 규칙", "/settings/workspace/achievement-rules"],
        ["조직 관리 키", "/settings/workspace/api-keys"],
        ["연동", "/settings/workspace/integrations/slack"],
        ["MCP 서버", "/settings/workspace/mcp-servers"],
      ],
    ],
    [
      "member",
      memberMe(),
      [["성과 규칙", "/settings/workspace/achievement-rules"]],
    ],
  ] as const) {
    test(`the ${role}'s workspace settings hold no personal pages`, async () => {
      renderAt("/settings/workspace/achievement-rules", {
        "GET /v1/auth/me": () => json(200, signedInAs),
      });
      const nav = await screen.findByRole("navigation", {
        name: "워크스페이스 설정",
      });
      await waitFor(() =>
        expect(links(nav)).toEqual(expected as unknown as string[][]),
      );
      for (const [, href] of PERSONAL) {
        expect(nav.querySelector(`a[href="${href}"]`)).toBe(null);
      }
      expect(screen.queryByRole("navigation", { name: "개인 설정" })).toBe(
        null,
      );
    });
  }

  test("a member's sidebar has no way into the workspace settings", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    await within(nav).findByRole("link", { name: "에이전트" });
    expect(within(nav).queryByRole("link", { name: "워크스페이스 설정" })).toBe(
      null,
    );
  });

  test("the account menu opens personal settings", async () => {
    const { history } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    await user.click(within(region).getByRole("button", { name: /Owner/ }));
    await user.click(screen.getByRole("menuitem", { name: "개인 설정" }));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/settings/preferences"),
    );
    expect(
      await screen.findByRole("navigation", { name: "개인 설정" }),
    ).toBeDefined();
  });

  for (const path of ["/settings/login-methods", "/settings", "/settings/"]) {
    test(`${path} opens personal settings`, async () => {
      const { history } = renderAt(path, {
        "GET /v1/auth/me": () => json(200, me()),
      });
      await screen.findByRole("heading", { level: 1, name: "언어·테마" });
      expect(history.location.pathname).toBe("/settings/preferences");
      expect(screen.queryByRole("heading", { name: "로그인 수단" })).toBe(null);
    });
  }
});
