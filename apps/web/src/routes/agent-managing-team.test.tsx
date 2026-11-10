import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentAdminsView, AuthMeResponse } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  AGENT_ID,
  agentServer,
  TEAM,
  TEAM_ID,
} from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

// The words of the floating toast, once it has any.
const toast = () =>
  document.querySelector('[data-slot="toast"]')?.textContent || undefined;

const DETAIL = `/agents/${AGENT_ID}`;
const ADMINS_TAB = `${DETAIL}?tab=settings&section=admins`;
const OTHER_TEAM = { ...TEAM, id: crypto.randomUUID(), name: "영업" };
const AT = "2026-10-01T00:00:00.000Z";

const meAs = (who: AuthMeResponse) => ({
  "GET /v1/auth/me": () => json(200, who),
});
const adminsOf = (over: Partial<AgentAdminsView> = {}): AgentAdminsView => ({
  users: [],
  teams: [],
  ...over,
});
const myTeams = (role: "lead" | "member" | null) =>
  json(200, {
    items: role === null ? [] : [{ id: TEAM_ID, name: TEAM.name, role }],
    next_cursor: null,
  });

// Lead of the current team, so the viewer manages; "영업" is another team they are in.
const leadOfBoth = () =>
  json(200, {
    items: [
      { id: TEAM_ID, name: TEAM.name, role: "lead" },
      { id: OTHER_TEAM.id, name: OTHER_TEAM.name, role: "member" },
    ],
    next_cursor: null,
  });

async function managedServer() {
  const server = agentServer();
  await server.routes[`PUT /v1/agents/${AGENT_ID}/managing-team`](
    new Request("https://console.test/", {
      method: "PUT",
      body: JSON.stringify({ team_id: TEAM_ID }),
    }),
  );
  return server;
}

describe("관리자 탭의 담당 팀", () => {
  test("고를 수 없는 팀은 목록에 없고, 지금 담당 팀도 다시 고를 수 없다", async () => {
    const server = await managedServer();
    renderAt(ADMINS_TAB, {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/my-teams": () =>
        json(200, {
          items: [
            { id: TEAM_ID, name: TEAM.name, role: "lead" },
            { id: OTHER_TEAM.id, name: OTHER_TEAM.name, role: "member" },
          ],
          next_cursor: null,
        }),
    });
    const select = (await screen.findByLabelText(
      "담당 팀으로 정할 팀",
    )) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "바꾸기",
      "영업",
    ]);
    // One control: no second button waits beside the select.
    expect(screen.queryByRole("button", { name: "바꾸기" })).toBeNull();
  });

  test("담당 팀 이름은 팀 상세로 가는 링크다", async () => {
    const server = await managedServer();
    renderAt(ADMINS_TAB, {
      ...meAs(me()),
      ...server.routes,
    });
    expect(
      (await screen.findByRole("link", { name: "재무" })).getAttribute("href"),
    ).toBe(`/members/teams/${TEAM_ID}`);
  });

  test("고르면 바로 반영하고, 반영하는 동안 잠그고, 토스트로 알린다", async () => {
    const server = await managedServer();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current: { id: string; name: string } = TEAM;
    const agentNow = () => ({
      ...server.detail().agent,
      managing_team_id: current.id,
      managing_team_name: current.name,
    });
    const { api } = renderAt(ADMINS_TAB, {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/my-teams": leadOfBoth,
      [`GET /v1/agents/${AGENT_ID}`]: () =>
        json(200, { ...server.detail(), agent: agentNow() }),
      [`PUT /v1/agents/${AGENT_ID}/managing-team`]: async () => {
        await held;
        current = OTHER_TEAM;
        return json(200, {
          agent: agentNow(),
          receipt_id: crypto.randomUUID(),
        });
      },
    });
    const user = await setupUser();
    const select = (await screen.findByLabelText(
      "담당 팀으로 정할 팀",
    )) as HTMLSelectElement;
    await user.selectOptions(select, OTHER_TEAM.id);
    // Locked while the request is out, and it says so.
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(select.options[0]?.textContent).toBe("저장하는 중…");
    expect(toast()).toBeUndefined();
    act(() => release());
    await waitFor(() =>
      expect(toast()).toBe("담당 팀을 영업(으)로 정했습니다."),
    );
    expect(
      (await screen.findByRole("link", { name: "영업" })).getAttribute("href"),
    ).toBe(`/members/teams/${OTHER_TEAM.id}`);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(
      api.calls.find((c) => c.method === "PUT" && c.path.endsWith("team"))
        ?.body,
    ).toEqual({ team_id: OTHER_TEAM.id });
  });

  test("거절되면 선택은 되돌아가고 이유는 화면에 남으며 토스트는 뜨지 않는다", async () => {
    const server = await managedServer();
    renderAt(ADMINS_TAB, {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/my-teams": leadOfBoth,
      [`PUT /v1/agents/${AGENT_ID}/managing-team`]: () =>
        json(403, {
          error: {
            code: "FORBIDDEN",
            message: "This team cannot hold the agent",
            retryable: false,
            request_id: "req-1",
            details: { reason_code: "team_holding" },
          },
        }),
    });
    const user = await setupUser();
    const select = (await screen.findByLabelText(
      "담당 팀으로 정할 팀",
    )) as HTMLSelectElement;
    await user.selectOptions(select, OTHER_TEAM.id);
    expect(
      await screen.findByText(
        "보관용으로 만들어진 팀이라 담당 팀으로 고를 수 없습니다. 다른 팀을 고르세요.",
      ),
    ).toBeDefined();
    // Back to the label, not left showing a team that was not applied.
    expect(select.value).toBe("");
    expect(select.disabled).toBe(false);
    expect(toast()).toBeUndefined();
    expect(screen.getByRole("link", { name: "재무" })).toBeDefined();
  });

  test("담당 팀이 관리자 팀이기도 하면 그 행만 구성원 모두가 관리자라고 알린다", async () => {
    const server = await managedServer();
    renderAt(ADMINS_TAB, {
      ...meAs(me()),
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(
          200,
          adminsOf({
            users: [
              {
                user_id: USER_ID,
                email: "owner@example.com",
                display_name: "Owner",
                created_by: USER_ID,
                created_at: AT,
              },
            ],
            teams: [
              {
                team_id: TEAM_ID,
                name: TEAM.name,
                created_by: USER_ID,
                created_at: AT,
              },
              {
                team_id: OTHER_TEAM.id,
                name: OTHER_TEAM.name,
                created_by: USER_ID,
                created_at: AT,
              },
            ],
          }),
        ),
    });
    const list = await screen.findByRole("list", { name: "에이전트 관리자" });
    const row = (name: string) =>
      within(list).getByText(name).closest("li") as HTMLElement;
    // The same kind label on every row, person or team.
    expect(row("Owner").textContent).toContain("사람");
    expect(row("영업").textContent).toContain("팀");
    expect(row("재무").textContent).toContain(
      "담당 팀이기도 합니다. 팀 관리자만이 아니라 구성원 모두가 관리자입니다",
    );
    expect(row("영업").textContent).not.toContain("담당 팀이기도 합니다");
    expect(row("Owner").textContent).not.toContain("담당 팀이기도 합니다");
  });

  test("담당 팀에 팀 관리자가 없으면 그렇다고 알린다", async () => {
    const server = await managedServer();
    renderAt(ADMINS_TAB, {
      ...meAs(me()),
      ...server.routes,
      [`GET /v1/teams/${TEAM_ID}`]: () => json(200, { ...TEAM, members: [] }),
    });
    expect(
      await screen.findByText("이 담당 팀에는 팀 관리자가 없습니다."),
    ).toBeDefined();
  });
});

describe("담당 팀 구성원과 바깥 구성원", () => {
  test("담당 팀 구성원은 설정을 읽기만 하고 바꾸는 버튼은 보지 못한다", async () => {
    const server = await managedServer();
    const routes = {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/my-teams": () => myTeams("member"),
    };
    const { api } = renderAt(`${DETAIL}?tab=settings&section=card`, routes);
    expect(
      await screen.findByText(
        "담당 팀 구성원은 이 에이전트의 설정을 볼 수만 있습니다. 바꾸는 것은 팀 관리자와 에이전트 관리자입니다.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "상세 설정 편집", hidden: true }),
    ).toBeNull();
    // The release and admin sections share the settings tab with the card.
    await screen.findByRole("tabpanel");
    expect(
      screen.queryByRole("button", { name: "새 릴리스", hidden: true }),
    ).toBeNull();
    expect(await screen.findByText("재무")).toBeDefined();
    expect(screen.queryByLabelText("담당 팀으로 정할 팀")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "관리자로 추가할 사람이나 팀" }),
    ).toBeNull();
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("담당 팀의 팀 관리자는 같은 화면에서 설정을 고칠 수 있다", async () => {
    const server = await managedServer();
    renderAt(`${DETAIL}?tab=settings&section=card`, {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/my-teams": () => myTeams("lead"),
    });
    expect(
      await screen.findByRole("button", {
        name: "상세 설정 편집",
        hidden: true,
      }),
    ).toBeDefined();
    expect(
      screen.queryByText(/담당 팀 구성원은 이 에이전트의 설정을 볼 수만/),
    ).toBeNull();
  });

  test("개인 관리자는 내 팀 목록을 못 읽어도 설정을 고칠 수 있다", async () => {
    const server = await managedServer();
    renderAt(`${DETAIL}?tab=settings&section=card`, {
      ...meAs(memberMe()),
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(
          200,
          adminsOf({
            users: [
              {
                user_id: USER_ID,
                email: "member@example.com",
                display_name: "Member",
                created_by: USER_ID,
                created_at: AT,
              },
            ],
          }),
        ),
      "GET /v1/my-teams": () => apiError(503, "BACKEND_UNAVAILABLE", "down"),
    });
    expect(
      await screen.findByRole("button", {
        name: "상세 설정 편집",
        hidden: true,
      }),
    ).toBeDefined();
  });

  test("바깥 구성원은 상세 대신 이름·담당 팀과 안내를 본다", async () => {
    const server = await managedServer();
    const { api } = renderAt(DETAIL, {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/my-teams": () => myTeams(null),
      [`GET /v1/agents/${AGENT_ID}`]: () =>
        apiError(403, "FORBIDDEN", "This principal may not read the agent"),
      "GET /v1/agents": () =>
        json(200, { items: [server.detail().agent], next_cursor: null }),
    });
    expect(
      await screen.findByText(
        "이 에이전트의 설정은 담당 팀 구성원과 관리자만 봅니다.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "결제 담당",
    );
    expect(screen.getByText("재무")).toBeDefined();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(
      screen.getByRole("link", { name: "에이전트 목록" }).getAttribute("href"),
    ).toBe("/agents");
    expect(api.calls.find((c) => c.path === "/v1/agents")?.search).toContain(
      `ids=${AGENT_ID}`,
    );
  });
});

describe("새 에이전트의 담당 팀", () => {
  beforeEach(() => sessionStorage.clear());

  test("속한 팀이 없는 구성원은 만들 수 없다는 안내만 본다", async () => {
    renderAt("/agents/new", {
      ...meAs(memberMe()),
      ...agentServer().routes,
      "GET /v1/my-teams": () => myTeams(null),
    });
    expect(
      await screen.findByText(
        "속한 팀이 없어 에이전트를 만들 수 없습니다. 워크스페이스 관리자에게 팀에 넣어 달라고 요청하세요.",
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText("이름")).toBeNull();
    expect(screen.queryByRole("button", { name: "다음" })).toBeNull();
  });

  test("팀이 여럿이면 고르기 전에는 넘어가지 않고, 고른 팀으로 만든다", async () => {
    const { api } = renderAt("/agents/new", {
      ...meAs(memberMe()),
      ...agentServer().routes,
      "GET /v1/my-teams": () =>
        json(200, {
          items: [
            { id: OTHER_TEAM.id, name: OTHER_TEAM.name, role: "member" },
            { id: TEAM_ID, name: TEAM.name, role: "member" },
          ],
          next_cursor: null,
        }),
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "결제 담당");
    await user.type(screen.getByLabelText("식별자"), "billing");
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByText("담당 팀을 고르세요.")).toBeDefined();
    const select = screen.getByLabelText("담당 팀") as HTMLSelectElement;
    expect(document.activeElement === select).toBe(true);

    await user.selectOptions(select, TEAM_ID);
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.selectOptions(
      await screen.findByLabelText("모델"),
      "claude-sonnet-5",
    );
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await waitFor(() =>
      expect(
        (
          api.calls.find((c) => c.method === "POST" && c.path === "/v1/agents")
            ?.body as { managing_team_id?: string } | undefined
        )?.managing_team_id,
      ).toBe(TEAM_ID),
    );
  });
});

describe("목록의 담당 팀", () => {
  beforeEach(() => localStorage.clear());

  test("설정을 읽지 못하는 에이전트 카드는 이름·담당 팀만 보이고 따로 읽지 않는다", async () => {
    const server = await managedServer();
    const { api } = renderAt("/agents", {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    const card = (
      await screen.findByRole("link", { name: "결제 담당" })
    ).closest("[data-slot=card]") as HTMLElement;
    expect(card.textContent).toContain("재무");
    expect(card.textContent).toContain("설정은 담당 팀과 관리자만 봅니다.");
    expect(card.textContent).not.toContain("프로필");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      api.calls.some((c) => /^\/v1\/agents\/(?!counts$)[^/]+/.test(c.path)),
    ).toBe(false);
  });
});
