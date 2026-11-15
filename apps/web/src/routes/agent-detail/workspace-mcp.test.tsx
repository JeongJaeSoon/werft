import { describe, expect, test } from "bun:test";
import type { AgentWorkspaceMcpServer } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
  USER_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const ACCESS = `/agents/${AGENT_ID}?tab=access`;
const SERVERS = `/v1/agents/${AGENT_ID}/mcp/workspace-servers`;
const id = (n: number) => `3f2b1c4d-0000-4000-8000-00000000000${n}`;

function server(
  n: number,
  over: Partial<AgentWorkspaceMcpServer> = {},
): AgentWorkspaceMcpServer {
  return {
    server_id: id(n),
    name: `srv-${n}`,
    on: false,
    state: "active",
    connected_by: { user_id: USER_ID, display_name: "Owner" },
    tool_count: 3,
    ...over,
  };
}

const section = async () =>
  (
    await screen.findByRole("heading", { name: "워크스페이스 MCP 서버" })
  ).closest("section") as HTMLElement;

const puts = (api: {
  calls: { method: string; path: string; body: unknown }[];
}) => api.calls.filter((c) => c.method === "PUT" && c.path === SERVERS);

describe("에이전트의 워크스페이스 MCP 서버", () => {
  test("turning one on sends the whole set and keeps the others", async () => {
    const items = [
      server(1, { on: true }),
      server(2),
      server(3, { state: "none", connected_by: null, tool_count: 0 }),
    ];
    const { api } = renderAt(ACCESS, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${SERVERS}`]: () => json(200, { items, limit: 8 }),
      [`PUT ${SERVERS}`]: () =>
        json(200, {
          servers: {
            items: items.map((item) =>
              item.server_id === id(2) ? { ...item, on: true } : item,
            ),
            limit: 8,
          },
          receipt_id: RECEIPT_ID,
        }),
    });
    const user = await setupUser();
    const mcp = await section();
    const row = (name: string) =>
      within(mcp)
        .getAllByRole("listitem")
        .find((item) => item.textContent?.includes(name)) as HTMLElement;
    await within(mcp).findByRole("switch", { name: "srv-2 켜기" });
    expect(row("srv-1").textContent).toContain("Owner의 외부 계정으로 동작");
    expect(row("srv-3").textContent).toContain(
      "연결 전에는 도구가 보이지 않습니다.",
    );
    await user.click(within(mcp).getByRole("switch", { name: "srv-2 켜기" }));
    expect(
      await within(mcp).findByText("켠 서버를 저장했습니다."),
    ).toBeDefined();
    expect(puts(api).map((c) => c.body)).toEqual([
      { server_ids: [id(1), id(2)] },
    ]);
    expect(
      within(mcp)
        .getByRole("switch", { name: "srv-2 켜기" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("at the limit the servers still off cannot be turned on", async () => {
    const items = [server(1, { on: true }), server(2, { on: true }), server(3)];
    renderAt(ACCESS, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${SERVERS}`]: () => json(200, { items, limit: 2 }),
    });
    const mcp = await section();
    const off = await within(mcp).findByRole("switch", { name: "srv-3 켜기" });
    expect((off as HTMLButtonElement).disabled).toBe(true);
    expect(
      (
        within(mcp).getByRole("switch", {
          name: "srv-1 켜기",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(within(mcp).getByText(/2개를 모두 켰습니다/)).toBeDefined();
  });

  test("a refused save says why and reads the list again", async () => {
    const { api } = renderAt(ACCESS, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${SERVERS}`]: () => json(200, { items: [server(1)], limit: 8 }),
      [`PUT ${SERVERS}`]: () =>
        apiError(400, "BAD_REQUEST", "refused", false, {
          reason_code: "server_unknown",
        }),
    });
    const user = await setupUser();
    const mcp = await section();
    const reads = () =>
      api.calls.filter((c) => c.method === "GET" && c.path === SERVERS).length;
    await user.click(
      await within(mcp).findByRole("switch", { name: "srv-1 켜기" }),
    );
    expect(
      await within(mcp).findByText(/워크스페이스에 없는 서버입니다/),
    ).toBeDefined();
    await waitFor(() => expect(reads()).toBe(2));
  });

  test("someone who may not read it gets the reason and no switches", async () => {
    renderAt(ACCESS, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET ${SERVERS}`]: () => apiError(403, "FORBIDDEN", "forbidden"),
    });
    const mcp = await section();
    await waitFor(() =>
      expect(within(mcp).queryAllByRole("switch")).toEqual([]),
    );
    expect(mcp.textContent).toMatch(/권한/);
  });
});
