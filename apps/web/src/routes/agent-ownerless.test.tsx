import { describe, expect, test } from "bun:test";
import type { AuthMeResponse } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const meAs = (who: AuthMeResponse) => ({
  "GET /v1/auth/me": () => json(200, who),
});
const SINCE = "2026-11-01T00:00:00.000Z";

describe("관리자 없는 에이전트: 목록", () => {
  const base = agentServer().detail().agent;
  const owned = { ...base, name: "결제 봇" };
  const orphan = {
    ...base,
    id: "00000000-0000-4000-8000-000000000002",
    slug: "orphan",
    name: "주인 없는 봇",
    ownerless: true,
    ownerless_since: SINCE,
  };
  const routes = {
    "GET /v1/agents": (request: Request) => {
      const ownerless =
        new URL(request.url).searchParams.get("ownerless") === "true";
      return json(200, {
        items: [owned, orphan].filter((a) => !ownerless || a.ownerless),
        next_cursor: null,
      });
    },
    "GET /v1/administered-agents": () => json(200, { items: [] }),
  };

  test("워크스페이스 관리자는 알림을 보고, 모아 보기로 관리자 없는 에이전트만 읽는다", async () => {
    const user = await setupUser();
    const { api } = renderAt("/agents", { ...meAs(me()), ...routes });
    const alert = await screen.findByText("관리자가 없는 에이전트 1개");
    expect(
      within(
        alert.closest("[role=alert], [data-slot=alert]") as HTMLElement,
      ).getByText(/14일 뒤에 새 실행이 막힙니다/),
    ).toBeDefined();
    const row = (
      await screen.findByRole("link", { name: "주인 없는 봇" })
    ).closest("[role=row]") as HTMLElement;
    expect(within(row).getByText("관리자 없음")).toBeDefined();
    const ownedRow = screen
      .getByRole("link", { name: "결제 봇" })
      .closest("[role=row]") as HTMLElement;
    expect(within(ownedRow).queryByText("관리자 없음")).toBeNull();

    await user.click(screen.getByRole("button", { name: "모아 보기" }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.method === "GET" &&
            c.path === "/v1/agents" &&
            new URLSearchParams(c.search).get("ownerless") === "true",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "결제 봇" })).toBeNull(),
    );
    expect(screen.getByRole("link", { name: "주인 없는 봇" })).toBeDefined();
    expect(screen.queryByText("관리자가 없는 에이전트 1개")).toBeNull();
  });

  test("관리자가 아닌 구성원에게는 알림이 없다", async () => {
    renderAt("/agents", { ...meAs(memberMe()), ...routes });
    await screen.findByRole("link", { name: "주인 없는 봇" });
    expect(screen.queryByText("관리자가 없는 에이전트 1개")).toBeNull();
  });
});

describe("관리자 없는 에이전트: 상세", () => {
  const DETAIL = `/agents/${AGENT_ID}`;

  test("차단 날짜와 인계 안내를 보이고, 버튼은 관리자 탭을 연다", async () => {
    const user = await setupUser();
    const server = agentServer({ ownerlessSince: SINCE });
    const { history } = renderAt(DETAIL, { ...meAs(me()), ...server.routes });
    expect(
      await screen.findByText("이 에이전트를 관리할 사람이 없습니다"),
    ).toBeDefined();
    expect(
      screen.getByText(/2026\. 11\. 15\. 09:00부터 새 실행이 막힙니다/),
    ).toBeDefined();
    expect(
      screen.getByText(/요청자가 비활성화된 기존 세션은 따로 인계해야 할 수/),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: "관리자 지정하기" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "관리자" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(history.location.search).toContain("tab=admins");
  });

  test("아직 표시되지 않았으면 날짜 대신 곧 정해진다고 말한다", async () => {
    const server = agentServer({ ownerlessSince: null });
    renderAt(DETAIL, { ...meAs(me()), ...server.routes });
    expect(
      await screen.findByText(/새 실행이 막히는 날짜는 곧 정해집니다/),
    ).toBeDefined();
  });

  const OTHER_AGENT = "00000000-0000-4000-8000-0000000000ff";
  const waitingRow = (session: string, agent: string) => ({
    session_id: session,
    agent_id: agent,
    departed_user_id: "019a0000-0000-7000-8000-0000000000c1",
    status: "idle",
    created_at: SINCE,
    takeover_required_at: "2026-11-02T00:00:00.000Z",
  });
  const WAITING = [
    waitingRow("0a000000-0000-4000-8000-000000000001", AGENT_ID),
    waitingRow("0b000000-0000-4000-8000-000000000002", OTHER_AGENT),
    waitingRow("0c000000-0000-4000-8000-000000000003", AGENT_ID),
  ];
  // The server's filter, so the screen's list can be held to it.
  const takeovers = {
    "GET /v1/takeovers": (request: Request) => {
      const agent = new URL(request.url).searchParams.get("agent_id");
      return json(200, {
        items: WAITING.filter((row) => agent === null || row.agent_id === agent),
      });
    },
  };
  const sessionLinks = () =>
    screen
      .queryAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith("/sessions/"));

  test("인계 목록을 읽는 사람에게 이 에이전트의 인계 대기 세션 수와 목록을 보인다", async () => {
    const server = agentServer({ ownerlessSince: SINCE });
    const { api } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      ...takeovers,
    });
    const mine = WAITING.filter((row) => row.agent_id === AGENT_ID);
    expect(
      await screen.findByText(`인계를 기다리는 세션 ${mine.length}개`),
    ).toBeDefined();
    expect(sessionLinks()).toEqual(
      mine.map((row) => `/sessions/${row.session_id}`),
    );
    expect(sessionLinks()).not.toContain(
      `/sessions/${WAITING[1]?.session_id}`,
    );
    expect(
      api.calls.some(
        (c) =>
          c.path === "/v1/takeovers" &&
          new URLSearchParams(c.search).get("agent_id") === AGENT_ID,
      ),
    ).toBe(true);
    expect(
      screen.getByText(/요청자가 비활성화된 기존 세션은 따로 인계해야 할 수/),
    ).toBeDefined();
  });

  test("인계 목록 권한이 없으면 수도 목록도 묻지 않고, 고정 안내만 남는다", async () => {
    const server = agentServer({ ownerlessSince: SINCE });
    const { api } = renderAt(DETAIL, {
      ...meAs(memberMe()),
      ...server.routes,
      ...takeovers,
    });
    expect(
      await screen.findByText(
        /요청자가 비활성화된 기존 세션은 따로 인계해야 할 수/,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/인계를 기다리는 세션/) === null).toBe(true);
    expect(sessionLinks()).toEqual([]);
    expect(api.calls.some((c) => c.path === "/v1/takeovers")).toBe(false);
  });

  test("승계 뒤에도 인계 대기 세션이 남으면 경고가 그 목록으로 남는다", async () => {
    const server = agentServer();
    renderAt(DETAIL, { ...meAs(me()), ...server.routes, ...takeovers });
    expect(
      await screen.findByText("인계를 기다리는 세션이 있습니다"),
    ).toBeDefined();
    expect(screen.getByText("인계를 기다리는 세션 2개")).toBeDefined();
    expect(
      screen.queryByText("이 에이전트를 관리할 사람이 없습니다") === null,
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "관리자 지정하기" }) === null,
    ).toBe(true);
  });

  test("관리하는 사람이 있으면 경고가 없다", async () => {
    const server = agentServer();
    const { api } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "GET /v1/takeovers": () => json(200, { items: [] }),
    });
    await screen.findByRole("tab", { name: "관리자" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/takeovers")).toBe(true),
    );
    expect(
      screen.queryByText("이 에이전트를 관리할 사람이 없습니다"),
    ).toBeNull();
    expect(
      screen.queryByText("인계를 기다리는 세션이 있습니다") === null,
    ).toBe(true);
  });
});
