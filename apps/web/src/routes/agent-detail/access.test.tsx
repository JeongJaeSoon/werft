import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import { json, me } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const ACCESS = `/agents/${AGENT_ID}?tab=access`;
const SETTINGS = `/v1/agents/${AGENT_ID}/mcp/settings`;

const saved = {
  server: "docs",
  allowed_tools: ["mcp__docs__read", "mcp__docs__search"],
  credential_refs: ["docs-key"],
};

const section = async () =>
  (await screen.findByRole("heading", { name: "MCP 서버와 도구" })).closest(
    "section",
  ) as HTMLElement;

const puts = (api: { calls: { method: string; path: string }[] }) =>
  api.calls.filter((c) => c.method === "PUT" && c.path === SETTINGS);

const refused = (reason: string) => ({
  [`PUT ${SETTINGS}`]: () =>
    json(422, {
      error: {
        code: "VALIDATION_FAILED",
        message: "refused",
        retryable: false,
        request_id: "req-1",
        details: { reason_code: reason },
      },
    }),
});

describe("접근 탭", () => {
  test("저장한 설정이 없으면 그 사실을 알리고, 첫 저장은 expected_revision null로 릴리스 없이 보낸다", async () => {
    const server = agentServer();
    const { api } = renderAt(ACCESS, { ...meOk, ...server.routes });
    const user = await setupUser();
    const mcp = await section();
    expect(
      await within(mcp).findByText(/저장된 설정도 활성 릴리스도 없습니다/),
    ).toBeDefined();

    await user.selectOptions(
      within(mcp).getByRole("combobox", { name: "MCP 서버" }),
      "docs",
    );
    await user.type(
      within(mcp).getByRole("textbox", { name: "도구 이름" }),
      "mcp__docs__read",
    );
    await user.click(within(mcp).getByRole("button", { name: "도구 추가" }));
    await user.type(
      within(mcp).getByRole("textbox", { name: "자격 증명 이름" }),
      "docs-key",
    );
    await user.click(within(mcp).getByRole("button", { name: "이름 추가" }));
    const detailReads = () =>
      api.calls.filter(
        (c) => c.method === "GET" && c.path === `/v1/agents/${AGENT_ID}`,
      ).length;
    const before = detailReads();
    await user.click(within(mcp).getByRole("button", { name: "저장" }));

    expect(
      await within(mcp).findByText(
        "MCP 설정을 저장했습니다. 릴리스는 만들어지지 않았습니다.",
      ),
    ).toBeDefined();
    expect(puts(api).map((c) => (c as { body?: unknown }).body)).toEqual([
      {
        expected_revision: null,
        settings: {
          server: "docs",
          allowed_tools: ["mcp__docs__read"],
          credential_refs: ["docs-key"],
        },
      },
    ]);
    // A save is not a release: nothing is activated or re-read as a release.
    expect(
      api.calls.some(
        (c) => c.method === "PATCH" || c.path.endsWith("/activate"),
      ),
    ).toBe(false);
    expect(detailReads()).toBe(before);
    // The row it made is what the tab reads next, at revision 1.
    await waitFor(() =>
      expect(
        within(mcp).queryByText(/저장된 설정도 활성 릴리스도 없습니다/),
      ).toBeNull(),
    );
  });

  test("저장한 행은 이름만 보이고, 뺀 도구는 행 전체를 바꾸는 저장으로 expected_revision을 실어 보낸다", async () => {
    const server = agentServer({ mcpSettings: saved });
    const { api } = renderAt(ACCESS, { ...meOk, ...server.routes });
    const user = await setupUser();
    const mcp = await section();
    const tools = await within(mcp).findByRole("list", {
      name: "허용한 도구",
    });
    expect(tools.textContent).toContain("mcp__docs__read");
    expect(tools.textContent).toContain("mcp__docs__search");
    const creds = within(mcp).getByRole("list", { name: "필요한 자격 증명" });
    expect(creds.textContent).toContain("docs-key");
    expect(creds.textContent).toContain("연결 안 됨");

    await user.click(
      within(mcp).getByRole("button", { name: "mcp__docs__search 빼기" }),
    );
    await user.click(within(mcp).getByRole("button", { name: "저장" }));
    await within(mcp).findByText(/MCP 설정을 저장했습니다/);
    expect(puts(api).map((c) => (c as { body?: unknown }).body)).toEqual([
      {
        expected_revision: 1,
        settings: {
          server: "docs",
          allowed_tools: ["mcp__docs__read"],
          credential_refs: ["docs-key"],
        },
      },
    ]);
  });

  test("서버를 바꾸면 허용 도구가 비워지고, 다른 서버의 도구 이름은 받지 않는다", async () => {
    const server = agentServer({ mcpSettings: saved });
    renderAt(ACCESS, { ...meOk, ...server.routes });
    const user = await setupUser();
    const mcp = await section();
    await within(mcp).findByRole("list", { name: "허용한 도구" });
    await user.type(
      within(mcp).getByRole("textbox", { name: "도구 이름" }),
      "mcp__wiki__read",
    );
    await user.click(within(mcp).getByRole("button", { name: "도구 추가" }));
    expect(
      await within(mcp).findByText("고른 서버(docs)의 도구가 아닙니다."),
    ).toBeDefined();

    await user.selectOptions(
      within(mcp).getByRole("combobox", { name: "MCP 서버" }),
      "wiki",
    );
    expect(within(mcp).queryByRole("list", { name: "허용한 도구" })).toBeNull();
    expect(within(mcp).getByText("허용한 도구가 없습니다.")).toBeDefined();
  });

  test("다른 곳에서 먼저 저장했으면 충돌을 알리고 다시 읽게 한다", async () => {
    const server = agentServer({ mcpSettings: saved });
    renderAt(ACCESS, {
      ...meOk,
      ...server.routes,
      [`PUT ${SETTINGS}`]: () =>
        json(409, {
          error: {
            code: "REVISION_CONFLICT",
            message: "changed",
            retryable: false,
            request_id: "req-1",
            details: null,
          },
        }),
    });
    const user = await setupUser();
    const mcp = await section();
    await user.click(
      await within(mcp).findByRole("button", {
        name: "mcp__docs__search 빼기",
      }),
    );
    await user.click(within(mcp).getByRole("button", { name: "저장" }));
    expect(
      await within(mcp).findByText(/다른 곳에서 먼저 저장했습니다/),
    ).toBeDefined();
    expect(
      within(mcp).getByRole("button", { name: "다시 읽기" }),
    ).toBeDefined();
  });

  test.each([
    [
      "mcp_tool_denied",
      "활성 릴리스의 프로필이 막은 도구는 새로 허용할 수 없습니다.",
    ],
    ["server_unknown", "이 작업 공간에서 쓸 수 있는 MCP 서버가 아닙니다."],
    ["something_new", "요청이 거절되었습니다."],
  ])("거절 사유 %s는 그 문장으로 보인다", async (reason, text) => {
    const server = agentServer({ mcpSettings: saved });
    renderAt(ACCESS, { ...meOk, ...server.routes, ...refused(reason) });
    const user = await setupUser();
    const mcp = await section();
    await user.click(
      await within(mcp).findByRole("button", {
        name: "mcp__docs__search 빼기",
      }),
    );
    await user.click(within(mcp).getByRole("button", { name: "저장" }));
    expect(await within(mcp).findByText(new RegExp(text))).toBeDefined();
  });

  test("에이전트 관리자가 아니면 읽기만 되고 고치는 단추가 없다", async () => {
    const server = agentServer({ mcpSettings: saved });
    renderAt(ACCESS, {
      "GET /v1/auth/me": () => json(200, me([], "member")),
      ...server.routes,
    });
    const mcp = await section();
    expect(
      await within(mcp).findByText("에이전트 관리자만 고칠 수 있습니다."),
    ).toBeDefined();
    expect(within(mcp).queryByRole("button")).toBeNull();
    expect(within(mcp).queryByRole("textbox")).toBeNull();
    expect(
      within(mcp)
        .getByRole("combobox", { name: "MCP 서버" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
