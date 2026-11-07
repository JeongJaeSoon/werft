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

const { renderAt, screen, waitFor, within } = await appHarness();

const DETAIL = `/agents/${AGENT_ID}`;
const ADMINS_TAB = `${DETAIL}?tab=admins`;
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
  test("담당 팀이 없고 관리자 팀이 하나면 그 팀을 추천하고, 누르면 담당 팀으로 정한다", async () => {
    const server = agentServer();
    const { api } = renderAt(ADMINS_TAB, {
      ...meAs(me()),
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(
          200,
          adminsOf({
            teams: [
              {
                team_id: TEAM_ID,
                name: TEAM.name,
                created_by: USER_ID,
                created_at: AT,
              },
            ],
          }),
        ),
    });
    const section = (
      await screen.findByRole("heading", { name: "담당 팀" })
    ).closest("section") as HTMLElement;
    expect(section.textContent).toContain(
      "이 팀의 팀 관리자는 이 에이전트를 관리하고, 구성원은 설정을 보고 사용합니다",
    );
    expect(within(section).getByText("담당 팀 미지정")).toBeDefined();
    expect(section.textContent).toContain(
      "담당 팀을 정하면 팀 밖 사람은 이 에이전트의 세션 가운데 자기 세션과 공유받은 것만 봅니다(워크스페이스 설정)",
    );
    const user = await setupUser();
    await user.click(
      await within(section).findByRole("button", {
        name: "관리자 팀 재무을(를) 담당 팀으로",
      }),
    );
    await waitFor(() =>
      expect(
        api.calls.find(
          (c) =>
            c.method === "PUT" &&
            c.path === `/v1/agents/${AGENT_ID}/managing-team`,
        )?.body,
      ).toEqual({ team_id: TEAM_ID }),
    );
    expect(
      await screen.findByText("담당 팀을 재무(으)로 정했습니다."),
    ).toBeDefined();
    await waitFor(() =>
      expect(within(section).queryByText("담당 팀 미지정")).toBeNull(),
    );
    expect(within(section).getByText("재무")).toBeDefined();
  });

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
      "팀 고르기",
      "영업",
    ]);
    expect(
      screen.getByRole("button", { name: "바꾸기" }).hasAttribute("disabled"),
    ).toBe(true);
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
    const { api } = renderAt(`${DETAIL}?tab=card`, routes);
    expect(
      await screen.findByText(
        "담당 팀 구성원은 이 에이전트의 설정을 볼 수만 있습니다. 바꾸는 것은 팀 관리자와 에이전트 관리자입니다.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "상세 설정 편집", hidden: true }),
    ).toBeNull();
    const user = await setupUser();
    await user.click(screen.getByRole("tab", { name: "릴리스" }));
    await screen.findByRole("tabpanel");
    expect(
      screen.queryByRole("button", { name: "새 릴리스", hidden: true }),
    ).toBeNull();
    await user.click(screen.getByRole("tab", { name: "관리자" }));
    expect(await screen.findByText("재무")).toBeDefined();
    expect(screen.queryByLabelText("담당 팀으로 정할 팀")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "관리자로 추가할 사람이나 팀" }),
    ).toBeNull();
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("담당 팀의 팀 관리자는 같은 화면에서 설정을 고칠 수 있다", async () => {
    const server = await managedServer();
    renderAt(`${DETAIL}?tab=card`, {
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
    renderAt(`${DETAIL}?tab=card`, {
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

  test("담당 팀 미지정 탭은 서버에 그 에이전트만 묻는다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents", { ...meAs(me()), ...server.routes });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "담당 팀 미지정 1" }),
    );
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.path === "/v1/agents" &&
            new URLSearchParams(c.search).get("managing_team") === "unassigned",
        ),
      ).toBe(true),
    );
  });

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
