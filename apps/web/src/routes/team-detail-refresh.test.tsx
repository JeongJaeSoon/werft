import { describe, expect, test } from "bun:test";
import type { MemberView, TeamDetail } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberPage,
  RECEIPT_ID,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const PAY_ID = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
const OPS_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MATE_ID = "2c7e1d4a-5b6f-4a8e-9d0c-1e2f3a4b5c6d";
const AT = "2026-10-11T00:00:00.000Z";

const mate: MemberView = {
  user_id: MATE_ID,
  email: "mate@example.com",
  display_name: "Mate",
  role: "member",
  disabled_at: null,
  created_at: AT,
};

function team(id: string, name: string): TeamDetail {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    name,
    member_count: 1,
    created_by: USER_ID,
    created_at: AT,
    revision: 1,
    members: [
      {
        user_id: MATE_ID,
        email: mate.email,
        display_name: mate.display_name,
        role: "member",
        added_by: USER_ID,
        added_at: AT,
        disabled_at: null,
      },
    ],
  };
}

/**
 * Two teams the owner manages. `fail` names a read that answers an error
 * until it is cleared, so a test can break a refresh and then mend it.
 */
function server() {
  const fail: { team?: () => Response; members?: () => Response } = {};
  const teams = new Map([
    [PAY_ID, team(PAY_ID, "결제팀")],
    [OPS_ID, team(OPS_ID, "운영팀")],
  ]);
  const routes: Record<string, (request: Request) => Response> = {
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/members": () =>
      fail.members?.() ??
      json(200, memberPage({ items: [mate], next_cursor: null })),
    "GET /v1/teams": () =>
      json(200, {
        items: [...teams.values()].map(({ members: _m, ...rest }) => rest),
        next_cursor: null,
      }),
  };
  for (const [id, detail] of teams) {
    routes[`GET /v1/teams/${id}`] = () =>
      fail.team?.() ?? json(200, teams.get(id) ?? detail);
    routes[`PATCH /v1/teams/${id}`] = () =>
      json(200, { team: detail, receipt_id: RECEIPT_ID });
  }
  return { fail, routes };
}

const failed = () =>
  apiError(500, "INTERNAL_ERROR", "the team read failed this time");

describe("팀 상세 다시 읽기", () => {
  test("다시 읽다 실패하면 마지막으로 읽은 팀을 그대로 두고, 위에서 원인과 다시 시도를 말한다", async () => {
    const { fail, routes } = server();
    const { services } = renderAt(`/members/teams/${PAY_ID}`, routes);
    await screen.findByRole("heading", { level: 2, name: "결제팀" });
    await screen.findByRole("button", { name: "구성원 추가" });

    fail.team = failed;
    await act(() => services.queryClient.refetchQueries());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "팀 정보를 새로 읽지 못했습니다. 아래는 마지막으로 읽은 내용입니다.",
    );
    // The cause and the next step come from the error's code.
    expect(alert.textContent).toContain("잠시 뒤 다시 시도하세요");
    // What was read last stays, and so does the section's one action.
    expect(
      screen.getByRole("heading", { level: 2, name: "결제팀" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "구성원 추가" })).toBeDefined();
    expect(screen.getByRole("table", { name: "팀 구성원" })).toBeDefined();

    delete fail.team;
    await (await setupUser()).click(
      within(alert).getByRole("button", { name: "다시 시도" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(
          "팀 정보를 새로 읽지 못했습니다. 아래는 마지막으로 읽은 내용입니다.",
        ),
      ).toBeNull(),
    );
  });

  test("다시 읽을 때 팀이 없어졌으면 마지막 내용 대신 찾을 수 없다고 말한다", async () => {
    const { fail, routes } = server();
    const { services } = renderAt(`/members/teams/${PAY_ID}`, routes);
    await screen.findByRole("heading", { level: 2, name: "결제팀" });

    fail.team = () => apiError(404, "NOT_FOUND", "Resource not found");
    await act(() => services.queryClient.refetchQueries());

    await screen.findByRole("heading", { level: 2, name: "팀" });
    expect(screen.queryByRole("button", { name: "구성원 추가" })).toBeNull();
    expect(screen.queryByRole("table", { name: "팀 구성원" })).toBeNull();
  });

  test("구성원의 워크스페이스 역할을 읽지 못하면 열을 숨긴 까닭과 다시 시도를 말한다", async () => {
    const { fail, routes } = server();
    fail.members = failed;
    renderAt(`/members/teams/${PAY_ID}`, routes);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "구성원의 워크스페이스 역할을 읽지 못해 역할 열을 숨겼습니다.",
    );
    const table = screen.getByRole("table", { name: "팀 구성원" });
    expect(
      within(table).queryByRole("columnheader", { name: "워크스페이스 역할" }),
    ).toBeNull();

    delete fail.members;
    await (await setupUser()).click(
      within(alert).getByRole("button", { name: "다시 시도" }),
    );
    await screen.findByRole("columnheader", { name: "워크스페이스 역할" });
    expect(
      screen.queryByText(
        "구성원의 워크스페이스 역할을 읽지 못해 역할 열을 숨겼습니다.",
      ),
    ).toBeNull();
  });
});

describe("팀 사이를 옮겨 갈 때", () => {
  test("고치던 이름과 구성원 추가는 새 팀의 것으로 처음부터 다시 선다", async () => {
    const { routes } = server();
    // 운영팀 is read first, so coming back to it shows the cached team at
    // once, with no loading screen in between to reset anything.
    const { history } = renderAt(`/members/teams/${OPS_ID}`, routes);
    const user = await setupUser();
    await screen.findByRole("heading", { level: 2, name: "운영팀" });
    await act(() => history.push(`/members/teams/${PAY_ID}`));
    await screen.findByRole("heading", { level: 2, name: "결제팀" });
    const name = await screen.findByRole("textbox", { name: "팀 이름" });
    await user.clear(name);
    await user.type(name, "고치던 이름");
    expect(
      screen
        .getByRole("button", { name: "이름 바꾸기" })
        .hasAttribute("disabled"),
    ).toBe(false);

    await act(() => history.push(`/members/teams/${OPS_ID}`));
    await screen.findByRole("heading", { level: 2, name: "운영팀" });

    const next = screen.getByRole("textbox", { name: "팀 이름" });
    expect((next as HTMLInputElement).value).toBe("운영팀");
    expect(
      screen
        .getByRole("button", { name: "이름 바꾸기" })
        .hasAttribute("disabled"),
    ).toBe(true);
    // The section's head action now adds to this team, not the last one.
    await user.click(screen.getByRole("button", { name: "구성원 추가" }));
    expect(
      await screen.findByRole("dialog", { name: "운영팀에 구성원 추가" }),
    ).toBeDefined();
  });

  test("한 팀에서 실패한 다시 읽기 알림은 다른 팀으로 따라가지 않는다", async () => {
    const { fail, routes } = server();
    const { history, services } = renderAt(`/members/teams/${PAY_ID}`, routes);
    await screen.findByRole("heading", { level: 2, name: "결제팀" });
    fail.team = failed;
    await act(() => services.queryClient.refetchQueries());
    await screen.findByText(
      "팀 정보를 새로 읽지 못했습니다. 아래는 마지막으로 읽은 내용입니다.",
    );

    delete fail.team;
    await act(() => history.push(`/members/teams/${OPS_ID}`));
    await screen.findByRole("heading", { level: 2, name: "운영팀" });
    expect(
      screen.queryByText(
        "팀 정보를 새로 읽지 못했습니다. 아래는 마지막으로 읽은 내용입니다.",
      ),
    ).toBeNull();
  });
});
