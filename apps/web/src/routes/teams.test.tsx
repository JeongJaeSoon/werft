import { describe, expect, test } from "bun:test";
import {
  type AgentAdminsView,
  agentAdminsViewSchema,
  type MemberView,
  TEAM_LIST_LIMIT,
  type TeamDetail,
  teamDetailSchema,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  keys,
  me,
  memberMe,
  memberPage,
  RECEIPT_ID,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();
// After the DOM exists, like every module that loads Radix.
const { ADMINISTERED_LIST_LIMIT } = await import(
  "../components/agent-admins.tsx"
);

const TEAM_ID = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
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
const owner: MemberView = {
  ...mate,
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
};

const people = new Map([owner, mate].map((m) => [m.user_id, m]));

/** Every polite status on screen: the picker's count and any toast. */
const said = () => screen.getAllByRole("status").map((s) => s.textContent);

const toastRegion = () =>
  document.querySelector<HTMLElement>('[data-slot="toast"]');

// The toast's region mounts empty and is filled a beat later (so a screen
// reader announces it): wait for the words, not just the region.
async function toastSaid(): Promise<string> {
  const region = await waitFor(() => {
    const found = toastRegion();
    expect(found === null).toBe(false);
    return found as HTMLElement;
  });
  await waitFor(() => expect(region.textContent).not.toBe(""));
  return region.textContent ?? "";
}

const optionTexts = () =>
  screen
    .queryAllByRole("option")
    .filter((o) => o.tagName !== "OPTION")
    .map((o) => o.textContent);

/** Types into a server-searched picker and takes the one match once the search settles. */
async function pick(
  user: Awaited<ReturnType<typeof setupUser>>,
  picker: HTMLElement,
  text: string,
) {
  await user.type(picker, text);
  await waitFor(() => expect(optionTexts()).toHaveLength(1), {
    timeout: 3000,
  });
  await user.keyboard("{ArrowDown}{Enter}");
}

async function openAdd(user: Awaited<ReturnType<typeof setupUser>>) {
  await user.click(await screen.findByRole("button", { name: "구성원 추가" }));
  const dialog = await screen.findByRole("dialog", {
    name: "결제팀에 구성원 추가",
  });
  const picker = within(dialog).getByRole("combobox", { name: "추가할 사람" });
  await waitFor(() => expect(document.activeElement === picker).toBe(true));
  return { dialog, picker };
}

/** The teams API as one stateful server, as the real routes answer. */
function teamServer({
  refuse = {},
  members = [],
  deleteRefusal,
}: {
  refuse?: Record<string, () => Response>;
  members?: TeamDetail["members"];
  deleteRefusal?: () => Response;
} = {}) {
  let team: TeamDetail | null = {
    id: TEAM_ID,
    workspace_id: WORKSPACE_ID,
    name: "결제팀",
    member_count: members.length,
    created_by: USER_ID,
    created_at: AT,
    revision: 1,
    members,
  };
  const view = () => {
    if (!team) throw new Error("deleted");
    const { members: _members, ...rest } = team;
    return { ...rest, member_count: team.members.length };
  };
  const change = () => json(200, { team: view(), receipt_id: RECEIPT_ID });
  const path = `/v1/teams/${TEAM_ID}`;
  return {
    get team() {
      return team;
    },
    routes: {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": (request: Request) => {
        const params = new URL(request.url).searchParams;
        const q = params.get("q")?.toLowerCase();
        const ids = params.get("user_ids")?.split(",");
        const items = [owner, mate].filter(
          (m) =>
            (!q || `${m.display_name} ${m.email}`.toLowerCase().includes(q)) &&
            (!ids || ids.includes(m.user_id)),
        );
        return json(200, memberPage({ items, next_cursor: null }));
      },
      "GET /v1/teams": () =>
        json(200, { items: team ? [view()] : [], next_cursor: null }),
      "POST /v1/teams": async (request: Request) => {
        const { name } = (await request.json()) as { name: string };
        if (name === team?.name)
          return apiError(409, "ALREADY_EXISTS", "A team by that name exists");
        return json(201, { team: { ...view(), name }, receipt_id: RECEIPT_ID });
      },
      [`GET ${path}`]: () =>
        team
          ? json(200, team)
          : apiError(404, "NOT_FOUND", "Resource not found"),
      [`PATCH ${path}`]: async (request: Request) => {
        const { name } = (await request.json()) as { name: string };
        if (team) team = { ...team, name, revision: team.revision + 1 };
        return change();
      },
      [`DELETE ${path}`]: () => {
        if (deleteRefusal) return deleteRefusal();
        team = null;
        return json(200, { receipt_id: RECEIPT_ID });
      },
      [`PATCH ${path}/members/${MATE_ID}`]: async (request: Request) => {
        const { role } = (await request.json()) as {
          role: TeamDetail["members"][number]["role"];
        };
        if (team)
          team = {
            ...team,
            members: team.members.map((m) =>
              m.user_id === MATE_ID ? { ...m, role } : m,
            ),
          };
        return change();
      },
      [`POST ${path}/members`]: async (request: Request) => {
        const { user_id } = (await request.json()) as { user_id: string };
        const refusal = refuse[user_id];
        if (refusal) return refusal();
        const person = people.get(user_id);
        if (team && person)
          team = {
            ...team,
            members: [
              ...team.members,
              {
                user_id,
                email: person.email,
                display_name: person.display_name,
                role: "member",
                added_by: USER_ID,
                added_at: AT,
                disabled_at: null,
              },
            ],
          };
        return change();
      },
      [`DELETE ${path}/members/${MATE_ID}`]: () => {
        if (team)
          team = {
            ...team,
            members: team.members.filter((m) => m.user_id !== MATE_ID),
          };
        return change();
      },
    },
  };
}

describe("팀 화면", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(teamDetailSchema.safeParse(teamServer().team).success).toBe(true);
  });

  // Console v4 navWs: 구성원 is the workspace managers' item; a member's
  // teams still open by address.
  test("팀은 구성원 메뉴 아래에 있고 팀 메뉴는 따로 없다. 구성원 메뉴는 소유자·관리자에게만 보인다", async () => {
    for (const [who, shows] of [
      [me(), true],
      [memberMe(), false],
    ] as const) {
      const shown = renderAt("/", { "GET /v1/auth/me": () => json(200, who) });
      const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
      await within(nav).findByRole("link", { name: "프로필" });
      expect(within(nav).queryByRole("link", { name: "구성원" }) !== null).toBe(
        shows,
      );
      expect(within(nav).queryByRole("link", { name: "팀" })).toBeNull();
      shown.container.remove();
    }
  });

  test("사이드바에서 빠져도 팀 주소는 그대로 열린다", async () => {
    const server = teamServer();
    renderAt("/teams", server.routes);
    expect(
      await screen.findByRole("link", { name: "팀 열기: 결제팀" }),
    ).toBeDefined();
  });

  test("헤더의 팀 만들기가 대화상자를 열어 만든다. 같은 이름은 대화상자 안에서 말한다", async () => {
    const server = teamServer();
    const { api } = renderAt("/members/teams", server.routes);
    const link = await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    expect(link.getAttribute("href")).toBe(`/members/teams/${TEAM_ID}`);
    // Same table as 구성원: a header row, and the row opens as a whole
    // through one link that covers it.
    const table = screen.getByRole("table", { name: "팀 표" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["팀", "구성원"]);
    expect(link.getAttribute("data-slot")).toBe("grid-table-row-opener");
    // Keyboard reachable, and a list link is not the current page.
    expect(link.getAttribute("tabindex")).toBeNull();
    expect(link.getAttribute("aria-current")).toBeNull();
    const row = link.closest("[role=row]") as HTMLElement;
    expect(row.querySelectorAll("a").length).toBe(1);
    expect(row.textContent).toContain("결제팀");
    expect(row.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(link.querySelector("svg")).toBeNull();
    // The tab no longer carries a form of its own.
    expect(screen.queryByLabelText("팀 이름")).toBeNull();
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await waitFor(() =>
      expect(
        document.activeElement === within(dialog).getByLabelText("팀 이름"),
      ).toBe(true),
    );
    await user.keyboard("지원팀{Enter}");
    expect(await toastSaid()).toBe("지원팀 팀을 만들었습니다.");
    // A confirmation is polite: a screen reader waits for a pause to read it.
    expect(toastRegion()?.tagName).toBe("OUTPUT");
    expect(toastRegion()?.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "지원팀",
    });
    await waitFor(() => expect(document.activeElement === open).toBe(true));

    await user.click(open);
    const again = await screen.findByRole("dialog", { name: "팀 만들기" });
    // Each opening starts empty.
    expect(
      (within(again).getByLabelText("팀 이름") as HTMLInputElement).value,
    ).toBe("");
    await user.keyboard("결제팀{Enter}");
    // A taken name belongs to its box, not to a banner above the form.
    const taken = await within(again).findByText(
      "같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.",
    );
    const nameBox = within(again).getByLabelText("팀 이름");
    expect(nameBox.getAttribute("aria-invalid")).toBe("true");
    expect(
      nameBox.getAttribute("aria-describedby")?.split(" ").includes(taken.id),
    ).toBe(true);
    expect(taken.closest("[data-slot=alert]")).toBeNull();
    // Editing the name drops the mark; the refusal was about the old one.
    await user.type(nameBox, "2");
    expect(nameBox.getAttribute("aria-invalid")).toBeNull();
    await user.keyboard("{Backspace}");
    expect(nameBox.getAttribute("aria-invalid")).toBe("true");
    // Closing and reopening starts clean.
    await user.click(within(again).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(open);
    const reopened = await screen.findByRole("dialog", { name: "팀 만들기" });
    expect(
      within(reopened).getByLabelText("팀 이름").getAttribute("aria-invalid"),
    ).toBeNull();
    await user.keyboard("결제팀{Enter}");
    await within(reopened).findByText(
      "같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.",
    );
    // Refused, the dialog stays with the name to fix.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      (within(reopened).getByLabelText("팀 이름") as HTMLInputElement).value,
    ).toBe("결제팀");
  });

  test("팀 목록을 못 불러오면 헤더에 팀 만들기 대신 목록 자리에 다시 시도를 보인다", async () => {
    const server = teamServer();
    renderAt("/members/teams", {
      ...server.routes,
      "GET /v1/teams": () => apiError(500, "INTERNAL", "boom"),
    });
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "팀 만들기" })).toBeNull();
  });

  test("팀 만들기는 팀 구역 제목 줄에 있고, 팀이 없으면 상자에 빈 상태만 둔다", async () => {
    const server = teamServer();
    renderAt("/members/teams", {
      ...server.routes,
      "GET /v1/teams": () => json(200, { items: [], next_cursor: null }),
    });
    const create = await screen.findByRole("button", { name: "팀 만들기" });
    expect(create.closest("header") === null).toBe(true);
    const owned = create.closest("section");
    if (!owned) throw new Error("the button is not in a section");
    expect(owned.querySelector("h2")?.textContent).toBe("팀");
    const empty = await within(owned).findByText(/아직 팀이 없습니다/);
    expect(empty.closest("[class*='rounded-card']") === null).toBe(false);
    // No search box over a list that is empty to begin with.
    expect(within(owned).queryByRole("searchbox")).toBeNull();
    expect(
      within(owned).getAllByRole("button", { name: "팀 만들기" }),
    ).toHaveLength(1);
  });

  test("검색 결과를 읽는 동안에도 팀 만들기는 잠기지 않는다", async () => {
    const server = teamServer();
    // A search is answered with a request that never settles.
    const { api } = renderAt("/members/teams", {
      ...server.routes,
      "GET /v1/teams": (request: Request) =>
        new URL(request.url).searchParams.has("q")
          ? new Promise<Response>(() => {})
          : server.routes["GET /v1/teams"](),
    });
    const user = await setupUser();
    const box = await screen.findByRole("searchbox", {
      name: "이름으로 팀 찾기",
    });
    await user.type(box, "결제");
    await waitFor(() =>
      expect(api.calls.some((c) => c.search.startsWith("?q="))).toBe(true),
    );
    // A reason locks a button with aria-disabled, not `disabled`.
    for (const create of screen.getAllByRole("button", { name: "팀 만들기" })) {
      expect(create.hasAttribute("disabled")).toBe(false);
      expect(create.getAttribute("aria-disabled") === "true").toBe(false);
    }
  });

  test("팀 이름을 비우면 이름 바꾸기가 잠기고 아무것도 보내지 않는다", async () => {
    const server = teamServer();
    const { api } = renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const user = await setupUser();
    const name = await screen.findByLabelText("팀 이름");
    await user.clear(name);
    const rename = screen.getByRole("button", { name: "이름 바꾸기" });
    expect(rename.hasAttribute("disabled")).toBe(true);
    await user.type(name, "{Enter}");
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("끝에 / 가 붙은 팀 목록 주소에서도 헤더에 팀 만들기가 있다", async () => {
    const server = teamServer();
    renderAt("/members/teams/", server.routes);
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    expect(
      await screen.findByRole("button", { name: "팀 만들기" }),
    ).toBeDefined();
  });

  test("만드는 중에 다른 탭으로 갔다 돌아와도 늦게 온 성공은 토스트로 알린다", async () => {
    const server = teamServer();
    let answer: ((response: Response) => void) | undefined;
    const { api, history } = renderAt("/members/teams", {
      ...server.routes,
      "POST /v1/teams": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await user.type(within(dialog).getByLabelText("팀 이름"), "지원팀{Enter}");
    await within(dialog).findByRole("button", { name: "만드는 중…" });
    // Settled before polling: the dialog leaves with the teams screen, and
    // Bun's DOM crashes when the poll runs while it unmounts.
    await act(async () => history.push("/members"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "팀 만들기" })).toBeNull(),
    );
    act(() => history.back());
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    answer?.(
      json(201, {
        team: {
          ...server.team,
          members: undefined,
          name: "지원팀",
          member_count: 0,
        },
        receipt_id: RECEIPT_ID,
      }),
    );
    // The success handler ends by refreshing the list: once that request
    // goes out, the handler has run.
    const lists = api.calls.filter(
      (c) => c.method === "GET" && c.path === "/v1/teams",
    ).length;
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === "GET" && c.path === "/v1/teams")
          .length,
      ).toBeGreaterThan(lists),
    );
    // The team exists whichever tab asked: the toast says so.
    expect(await toastSaid()).toBe("지원팀 팀을 만들었습니다.");
  });

  test("팀 상세의 주 버튼은 구성원 구역 제목 줄의 구성원 추가 하나이고 팀 만들기·초대는 없다", async () => {
    const server = teamServer();
    renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    await screen.findByRole("heading", { level: 2, name: "결제팀" });
    const add = await screen.findByRole("button", { name: "구성원 추가" });
    // On the members section's title row (R1), not in the page head.
    expect(add.closest("header") === null).toBe(true);
    const section = add.closest("section");
    expect(section === null).toBe(false);
    const title = section?.querySelector("h3");
    expect(title?.id === section?.getAttribute("aria-labelledby")).toBe(true);
    expect(title?.nextElementSibling?.textContent).toContain("명");
    expect(screen.getAllByRole("button", { name: "구성원 추가" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: "팀 만들기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
  });

  test("팀 상세를 읽지 못하면 헤더에 구성원 추가 버튼도 없다", async () => {
    const server = teamServer();
    renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
      [`GET /v1/teams/${TEAM_ID}`]: () =>
        apiError(404, "NOT_FOUND", "Resource not found"),
    });
    await screen.findByRole("heading", { level: 2, name: "팀" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "구성원 추가" })).toBeNull(),
    );
  });

  test("팀 상세에는 팀 목록으로 가는 뒤로가기가 없고, 돌아가는 길은 팀 탭이다", async () => {
    const server = teamServer();
    const { history } = renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    await screen.findByRole("heading", { level: 2, name: "결제팀" });
    expect(screen.queryByRole("link", { name: "팀 목록" })).toBeNull();
    expect(screen.queryByRole("button", { name: "팀 목록" })).toBeNull();
    // The 팀 tab stays current on a team's address and leads back to the list.
    const tab = screen.getByRole("link", { name: "팀" });
    expect(tab.getAttribute("aria-current")).toBe("page");
    expect(tab.getAttribute("href")).toBe("/members/teams");
    await (await setupUser()).click(tab);
    await waitFor(() =>
      expect(history.location.pathname).toBe("/members/teams"),
    );
  });

  test("Esc로 닫으면 포커스가 헤더의 팀 만들기로 돌아오고 아무것도 보내지 않는다", async () => {
    const server = teamServer();
    const { api } = renderAt("/members/teams", server.routes);
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    open.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await waitFor(() =>
      expect(
        document.activeElement === within(dialog).getByLabelText("팀 이름"),
      ).toBe(true),
    );
    await user.keyboard("지원팀{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement === open).toBe(true);
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("만드는 중에는 저장 버튼이 aria-disabled로 포커스를 지키고 다시 보내지 않는다", async () => {
    const server = teamServer();
    let answer: ((response: Response) => void) | undefined;
    const { api } = renderAt("/members/teams", {
      ...server.routes,
      "POST /v1/teams": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await user.type(within(dialog).getByLabelText("팀 이름"), "지원팀");
    const save = within(dialog).getByRole("button", { name: "팀 만들기" });
    save.focus();
    await user.keyboard("{Enter}");
    const busy = await within(dialog).findByRole("button", {
      name: "만드는 중…",
    });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement === busy).toBe(true);
    await user.keyboard("{Enter}");
    // Neither Escape nor 취소 drops a request on its way.
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog", { name: "팀 만들기" })).not.toBeNull();
    answer?.(
      json(201, {
        team: {
          ...server.team,
          members: undefined,
          name: "지원팀",
          member_count: 0,
        },
        receipt_id: RECEIPT_ID,
      }),
    );
    expect(await toastSaid()).toBe("지원팀 팀을 만들었습니다.");
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("구성원에게는 만들기 폼·전체 목록·권한 없음 화면이 없고 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold team.manage"),
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
    });
    expect(await screen.findByText("아직 속한 팀이 없습니다.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "팀 만들기" })).toBeNull();
    expect(screen.queryByLabelText("팀 이름")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("team.manage");
    expect(api.calls.some((c) => c.path === "/v1/teams")).toBe(false);
  });

  test("구성원은 자기가 속한 팀을 본다", async () => {
    const refused = () =>
      apiError(403, "FORBIDDEN", "This principal does not hold team.manage");
    const joined = renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": refused,
      "GET /v1/my-teams": () =>
        json(200, {
          items: [{ id: TEAM_ID, name: "결제팀", role: "member" }],
          next_cursor: null,
        }),
    });
    const section = await screen.findByRole("region", {
      name: "내가 속한 팀",
    });
    expect(
      within(section)
        .getByRole("link", { name: "결제팀" })
        .getAttribute("href"),
    ).toBe(`/members/teams/${TEAM_ID}`);
    joined.container.remove();

    renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": refused,
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
    });
    expect(await screen.findByText("아직 속한 팀이 없습니다.")).toBeDefined();
  });

  test("구성원이 연 자기 팀 상세는 읽기 전용이고 구성원 목록을 묻지 않는다", async () => {
    const detail: TeamDetail = {
      id: TEAM_ID,
      workspace_id: WORKSPACE_ID,
      name: "결제팀",
      created_by: USER_ID,
      created_at: AT,
      revision: 1,
      member_count: 1,
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
    const { api } = renderAt(`/members/teams/${TEAM_ID}`, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET /v1/teams/${TEAM_ID}`]: () => json(200, detail),
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "결제팀" }),
    ).toBeDefined();
    const table = screen.getByRole("table", { name: "팀 구성원" });
    expect(within(table).getByText("Mate")).toBeDefined();
    // Workspace roles come from the member list, which only managers read;
    // the team role comes with the team.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["구성원", "팀 역할", "추가한 날"]);
    expect(
      within(within(table).getAllByRole("row")[1] as HTMLElement)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["Matemate@example.com", "구성원", "2026. 10. 11. 09:00"]);
    for (const control of ["이름 바꾸기", "구성원 추가", "팀 삭제"])
      expect(
        screen.queryByRole("button", { name: control }),
        control,
      ).toBeNull();
    expect(screen.queryByRole("button", { name: /제외/ })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText("팀 이름")).toBeNull();
    expect(screen.queryByLabelText("추가할 사람")).toBeNull();
    expect(api.calls.some((c) => c.path === "/v1/members")).toBe(false);
  });

  test("관리자의 팀 상세 표는 관리 열을 고정 폭으로 두어 머리글과 모든 행의 열이 같은 자리에 선다", async () => {
    const teamMember = (person: MemberView): TeamDetail["members"][number] => ({
      user_id: person.user_id,
      email: person.email,
      display_name: person.display_name,
      role: "member",
      added_by: USER_ID,
      added_at: AT,
      disabled_at: null,
    });
    const server = teamServer({
      members: [teamMember(owner), teamMember(mate)],
    });
    renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
    });
    const table = await screen.findByRole("table", { name: "팀 구성원" });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(3),
    );
    await waitFor(() =>
      expect(within(table).getAllByText("소유자").length).toBeGreaterThan(0),
    );
    // Each row is its own grid: a max-content track would size to that
    // row's buttons (the header has none) and shift the columns before it.
    // The narrow tracks are 4.5rem for the button and 7rem for the select:
    // the longest language of each, so the name keeps the rest at 390px.
    for (const [name, last] of [
      ["--grid-table-columns", "var(--werft-row-action-min-width)"],
      ["--grid-table-narrow-columns", "4.5rem"],
    ] as const) {
      const template = (table as HTMLElement).style.getPropertyValue(name);
      expect(template, name).not.toBe("");
      expect(template, name).not.toContain("max-content");
      expect(template.split(" ").at(-1), name).toBe(last);
    }
  });

  test("팀 상세를 볼 수 없는 사람에게도 화면 제목이 있다", async () => {
    renderAt(`/members/teams/${TEAM_ID}`, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET /v1/teams/${TEAM_ID}`]: () =>
        apiError(403, "FORBIDDEN", "This principal does not hold team.manage"),
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "이 화면을 볼 권한이 없습니다",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "구성원" }),
    ).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "팀" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "팀 목록" })).toBeNull();
  });

  test("팀을 관리하는 사람의 팀 화면에는 전체 목록만 있다", async () => {
    const server = teamServer();
    const { api } = renderAt("/members/teams", server.routes);
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    expect(screen.queryByRole("heading", { name: "내가 속한 팀" })).toBeNull();
    expect(api.calls.some((c) => c.path === "/v1/my-teams")).toBe(false);
  });

  test("팀 목록은 한 쪽씩 읽고 더 보기로 다음 쪽을 읽으며 검색은 서버에 맡긴다. 내가 속한 팀은 다음 쪽까지 모두 읽는다", async () => {
    const SECOND_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
    const server = teamServer();
    const { items } = await server.routes["GET /v1/teams"]().json();
    const second = { ...items[0], id: SECOND_ID, name: "지원팀" };
    const { api } = renderAt("/members/teams", {
      ...server.routes,
      "GET /v1/teams": () => json(200, { items, next_cursor: "c2" }),
      "GET /v1/teams?cursor=c2": () =>
        json(200, { items: [second], next_cursor: null }),
      "GET /v1/teams?q=%EC%A7%80%EC%9B%90": () =>
        json(200, { items: [second], next_cursor: null }),
    });
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    const shown = (name: string) =>
      screen.queryByRole("link", { name: `팀 열기: ${name}` }) !== null;
    expect(shown("지원팀")).toBe(false);
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    expect(
      await screen.findByRole("link", { name: "팀 열기: 지원팀" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "더 보기" }) === null).toBe(
      true,
    );
    await user.type(
      screen.getByRole("searchbox", { name: "이름으로 팀 찾기" }),
      "지원",
    );
    await waitFor(
      () =>
        expect(
          api.calls.some((c) => c.search.startsWith("?q=") && !shown("결제팀")),
        ).toBe(true),
      { timeout: 3000 },
    );
    expect(
      await screen.findByRole("link", { name: "팀 열기: 지원팀" }),
    ).toBeDefined();
    expect(
      api.calls
        .filter((c) => c.path === "/v1/teams")
        .map((c) => decodeURIComponent(c.search)),
    ).toEqual(["", "?cursor=c2", "?q=지원"]);
    api.calls.length = 0;

    renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold team.manage"),
      "GET /v1/my-teams?limit=100": () =>
        json(200, {
          items: [{ id: TEAM_ID, name: "결제팀", role: "lead" }],
          next_cursor: "c2",
        }),
      "GET /v1/my-teams?cursor=c2&limit=100": () =>
        json(200, {
          items: [{ id: SECOND_ID, name: "지원팀", role: "member" }],
          next_cursor: null,
        }),
    });
    const section = await screen.findByRole("region", {
      name: "내가 속한 팀",
    });
    expect(await within(section).findByText("지원팀")).toBeDefined();
    expect(within(section).getByText("결제팀")).toBeDefined();
  });

  test("예전 팀 주소는 구성원의 팀 탭으로 옮겨 간다", async () => {
    const server = teamServer();
    const list = renderAt("/teams", server.routes);
    await screen.findByRole("link", { name: "팀 열기: 결제팀" });
    expect(list.history.location.pathname).toBe("/members/teams");
    const tab = screen.getByRole("link", { name: "팀", current: "page" });
    expect(tab.getAttribute("href")).toBe("/members/teams");
    list.container.remove();

    const detail = renderAt(`/teams/${TEAM_ID}`, server.routes);
    expect(
      await screen.findByRole("heading", { level: 2, name: "결제팀" }),
    ).toBeDefined();
    expect(detail.history.location.pathname).toBe(`/members/teams/${TEAM_ID}`);
    // The team opens inside the 팀 tab, which stays the current one.
    expect(
      screen.getByRole("link", { name: "팀", current: "page" }),
    ).toBeDefined();
  });

  test("관리자는 이름이나 이메일로 찾아 여러 명을 고른 뒤 한 번에 추가하고, 표에서 역할과 함께 본다", async () => {
    const server = teamServer();
    const { api } = renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const user = await setupUser();
    const memberReads = () =>
      api.calls.filter((c) => c.path === "/v1/members").map((c) => c.search);
    await screen.findByRole("button", { name: "구성원 추가" });
    expect(screen.queryByRole("combobox")).toBeNull();
    // The team page asks for no member list until the dialog's picker does.
    expect(memberReads()).toEqual([]);
    const { dialog, picker } = await openAdd(user);
    await waitFor(() => expect(memberReads()).toEqual([""]));
    expect(dialog.textContent).toContain(
      "추가하면 수락 없이 바로 구성원이 됩니다.",
    );
    const submit = within(dialog).getByRole("button", { name: "구성원 추가" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    await user.click(submit);
    expect(
      api.calls.some((c) => c.method === "POST" && c.path.endsWith("/members")),
    ).toBe(false);

    await user.click(picker);
    await pick(user, picker, "mate@");
    // The server did the search.
    expect(
      api.calls
        .filter((c) => c.path === "/v1/members")
        .map((c) => decodeURIComponent(c.search)),
    ).toContain("?q=mate@");
    // The search box empties and keeps the keyboard for the next one.
    expect((picker as HTMLInputElement).value).toBe("");
    expect(document.activeElement === picker).toBe(true);
    await pick(user, picker, "own");
    const chosen = screen.getByRole("list", { name: "추가할 사람" });
    expect(
      within(chosen)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Mate", "Owner"]);
    // Nobody is offered twice.
    await user.click(picker);
    await waitFor(
      () => expect(said()).toContain("추가할 수 있는 활성 구성원이 없습니다."),
      { timeout: 3000 },
    );
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeDefined();

    // Taking one off hands the keyboard back to the search box.
    await user.click(
      within(chosen).getByRole("button", {
        name: "Owner님을 추가할 사람에서 빼기",
      }),
    );
    expect(document.activeElement === picker).toBe(true);
    await pick(user, picker, "Own");

    await user.click(within(dialog).getByRole("button", { name: "2명 추가" }));
    await waitFor(() => expect(said()).toContain("2명을 팀에 추가했습니다."));
    expect(
      api.calls
        .filter((c) => c.method === "POST" && c.path.endsWith("/members"))
        .map((c) => c.body),
    ).toEqual([{ user_id: MATE_ID }, { user_id: USER_ID }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      document.activeElement ===
        screen.getByRole("button", { name: "구성원 추가" }),
    ).toBe(true);

    const table = await screen.findByRole("table", { name: "팀 구성원" });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(3),
    );
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["구성원", "워크스페이스 역할", "팀 역할", "추가한 날", "관리"]);
    const mateRow = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(
      within(mateRow)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "Matemate@example.com",
      "구성원",
      // The inline select's two options.
      "팀 관리자구성원",
      "2026. 10. 11. 09:00",
      "제외",
    ]);
    // One neutral row button; red belongs to the confirm only.
    expect(within(mateRow).getAllByRole("button")).toHaveLength(1);
    const remove = within(mateRow).getByRole("button", {
      name: "Mate님을 팀에서 제외",
    });
    expect(remove.className).not.toContain("text-destructive");
    expect(remove.className).toContain(
      "min-w-[var(--werft-row-action-button-min-width)]",
    );
    expect(remove.getAttribute("data-size")).toBe("sm");
    expect(
      screen.getByRole("heading", { level: 3, name: "팀 구성원" })
        .nextElementSibling?.textContent,
    ).toBe("2명");

    // The list's own search narrows the table, and says when nobody matches.
    const [search, ...more] = screen.getAllByRole("searchbox");
    expect(more).toHaveLength(0);
    expect(search?.getAttribute("aria-label")).toBe(
      "이름이나 이메일로 구성원 찾기",
    );
    if (!search) throw new Error("no search box");
    await user.type(search, "OWNER@");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Owner")).toBeDefined();
    await user.type(search, "nobody");
    expect(screen.getByText("검색어에 맞는 구성원이 없습니다")).toBeDefined();
    expect(
      screen.getByText("다른 이름이나 이메일로 찾아 보세요."),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect((search as HTMLInputElement).value).toBe("");
    expect(document.activeElement === search).toBe(true);
    expect(
      within(screen.getByRole("table", { name: "팀 구성원" })).getAllByRole(
        "row",
      ),
    ).toHaveLength(3);
  });

  test("한 번에 추가하다 거절된 사람은 대화상자에 고른 채로 남고, 누가 왜 안 됐는지 이유마다 말한다", async () => {
    const server = teamServer({
      refuse: { [USER_ID]: () => apiError(403, "FORBIDDEN", "Not permitted") },
    });
    renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const user = await setupUser();
    const { dialog, picker } = await openAdd(user);
    for (const name of ["Mate", "Owner"]) await pick(user, picker, name);
    await user.click(within(dialog).getByRole("button", { name: "2명 추가" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    // Who joined is the toast's to say; the dialog keeps only who was refused.
    expect(alert.textContent).toStartWith("Owner님을 추가하지 못했습니다.");
    expect(await toastSaid()).toBe("Mate님을 팀에 추가했습니다.");
    expect(
      within(within(dialog).getByRole("list", { name: "추가할 사람" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Owner"]);
    expect(
      within(dialog).getByRole("button", { name: "구성원 추가" }),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(said()).toContain("Mate님을 팀에 추가했습니다.");
    await waitFor(() =>
      expect(server.team?.members.map((m) => m.user_id)).toEqual([MATE_ID]),
    );
  });

  test("거절 이유가 다르면 이유마다 한 문장으로 말한다", async () => {
    const server = teamServer({
      refuse: {
        [MATE_ID]: () => apiError(403, "FORBIDDEN", "Not permitted"),
        [USER_ID]: () =>
          apiError(409, "REVISION_CONFLICT", "Changed meanwhile"),
      },
    });
    renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const user = await setupUser();
    const { dialog, picker } = await openAdd(user);
    for (const name of ["Mate", "Owner"]) await pick(user, picker, name);
    await user.click(within(dialog).getByRole("button", { name: "2명 추가" }));
    const text = (await within(dialog).findByRole("alert")).textContent ?? "";
    expect(text.match(/추가하지 못했습니다/g)).toHaveLength(2);
    expect(text).not.toContain("Mate, Owner");
    const [mate = "", owner = ""] = text.split(" Owner님을");
    expect(mate).toStartWith("Mate님을 추가하지 못했습니다.");
    expect(mate).not.toContain("다른 곳에서 먼저 바꿨습니다");
    expect(owner).toStartWith(
      " 추가하지 못했습니다. 다른 곳에서 먼저 바꿨습니다",
    );
  });

  test("추가하는 동안 새로 고른 사람은 끝난 뒤에도 고른 채로 남는다", async () => {
    let answer: () => void = () => {};
    const asked = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const server = teamServer();
    const post = server.routes[`POST /v1/teams/${TEAM_ID}/members`];
    renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
      [`POST /v1/teams/${TEAM_ID}/members`]: async (request: Request) => {
        await asked;
        return post(request);
      },
    });
    const user = await setupUser();
    const { dialog, picker } = await openAdd(user);
    await pick(user, picker, "Mate");
    await user.click(
      within(dialog).getByRole("button", { name: "구성원 추가" }),
    );
    await pick(user, picker, "Owner");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.getByRole("dialog") === dialog).toBe(true);
    act(() => answer());
    await waitFor(() =>
      expect(said()).toContain("Mate님을 팀에 추가했습니다."),
    );
    expect(screen.getByRole("dialog") === dialog).toBe(true);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(
      within(within(dialog).getByRole("list", { name: "추가할 사람" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Owner"]);
  });

  test("구성원을 빼고, 이름을 바꾸고, 팀을 지운다", async () => {
    const server = teamServer();
    const { api, history } = renderAt(
      `/members/teams/${TEAM_ID}`,
      server.routes,
    );
    const user = await setupUser();
    const add = await openAdd(user);
    await pick(user, add.picker, "Mate");
    await user.click(
      within(add.dialog).getByRole("button", { name: "구성원 추가" }),
    );
    await waitFor(() =>
      expect(said()).toContain("Mate님을 팀에 추가했습니다."),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const removeMate = await screen.findByRole("button", {
      name: "Mate님을 팀에서 제외",
    });
    // Cancelling sends nothing; Mate stays.
    await user.click(removeMate);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "취소",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(removeMate);
    const removeDialog = await screen.findByRole("dialog");
    expect(removeDialog.textContent).toContain(
      "Mate님을 결제팀 팀에서 제외할까요?",
    );
    await user.click(
      within(removeDialog).getByRole("button", { name: "제외" }),
    );
    await waitFor(() =>
      expect(said()).toContain("Mate님을 팀에서 제외했습니다."),
    );

    const name = screen.getByLabelText("팀 이름");
    await user.clear(name);
    await user.type(name, "청구팀");
    await user.click(screen.getByRole("button", { name: "이름 바꾸기" }));
    await waitFor(() =>
      expect(said()).toContain(
        "팀 이름을 바꿨습니다. 지금 이름은 청구팀입니다.",
      ),
    );

    // Deleting sits last on the page, in its own danger zone, behind a confirm.
    const danger = screen.getByRole("region", { name: "위험 구역" });
    expect(screen.getAllByRole("region").at(-1) === danger).toBe(true);
    const teamPath = `/v1/teams/${TEAM_ID}`;
    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "취소",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      api.calls.some((c) => c.method === "DELETE" && c.path === teamPath),
    ).toBe(false);

    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "팀 삭제" }));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/members/teams"),
    );
    expect(server.team).toBeNull();
    expect(await screen.findByText("아직 팀이 없습니다.")).toBeDefined();
    // The page that raised it is gone; the toast stays with the tabs.
    expect(await toastSaid()).toBe("청구팀 팀을 삭제했습니다.");
  });

  const mateMember: TeamDetail["members"][number] = {
    user_id: MATE_ID,
    email: mate.email,
    display_name: mate.display_name,
    role: "member",
    added_by: USER_ID,
    added_at: AT,
    disabled_at: null,
  };

  const roleSelect = async () =>
    within(await screen.findByRole("table", { name: "팀 구성원" })).getByRole(
      "combobox",
      { name: "Mate님의 팀 역할" },
    ) as HTMLSelectElement;
  const rolePatches = (api: { calls: { method: string; body?: unknown }[] }) =>
    api.calls.filter((c) => c.method === "PATCH");

  test("팀 역할은 행의 선택 상자로 바로 바뀌고, 팀 관리자로 올릴 때만 확인을 묻는다", async () => {
    const server = teamServer({ members: [mateMember] });
    const { api } = renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const user = await setupUser();
    const select = await roleSelect();
    expect(select.value).toBe("member");

    // Promotion asks first; cancelling sends nothing and leaves the role.
    await user.selectOptions(select, "lead");
    const ask = await screen.findByRole("dialog", {
      name: "Mate님을 팀 관리자로 바꿀까요?",
    });
    expect(rolePatches(api)).toHaveLength(0);
    await user.click(within(ask).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rolePatches(api)).toHaveLength(0);
    expect(select.value).toBe("member");

    await user.selectOptions(select, "lead");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "팀 관리자로 바꾸기",
      }),
    );
    await waitFor(() =>
      expect(said()).toContain(
        "Mate님의 팀 역할을 바꿨습니다. 지금 역할은 팀 관리자입니다.",
      ),
    );
    expect(rolePatches(api).map((c) => c.body)).toEqual([{ role: "lead" }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.team?.members[0]?.role).toBe("lead");
    await waitFor(async () => expect((await roleSelect()).value).toBe("lead"));
  });

  test("팀 관리자를 구성원으로 내리는 일은 확인 없이 바로 적용된다", async () => {
    const server = teamServer({
      members: [{ ...mateMember, role: "lead" }],
    });
    const { api } = renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const user = await setupUser();
    const select = await roleSelect();
    expect(select.value).toBe("lead");
    await user.selectOptions(select, "member");
    await waitFor(() =>
      expect(said()).toContain(
        "Mate님의 팀 역할을 바꿨습니다. 지금 역할은 구성원입니다.",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rolePatches(api).map((c) => c.body)).toEqual([{ role: "member" }]);
  });

  test("역할을 바꾸는 동안 선택 상자는 잠기고, 거절되면 원래 역할로 돌아오며 오류 토스트가 뜬다", async () => {
    const server = teamServer({ members: [mateMember] });
    let answer: (response: Response) => void = () => {};
    const { api } = renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
      [`PATCH /v1/teams/${TEAM_ID}/members/${MATE_ID}`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const user = await setupUser();
    const select = await roleSelect();
    await user.selectOptions(select, "lead");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "팀 관리자로 바꾸기",
      }),
    );
    await waitFor(() => expect(rolePatches(api)).toHaveLength(1));
    // Locked while the request runs, showing what was asked for.
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(select.value).toBe("lead");
    answer(apiError(403, "FORBIDDEN", "Not permitted"));
    expect(await toastSaid()).toContain("팀 관리 권한이 있어야");
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("member");
    expect(server.team?.members[0]?.role).toBe("member");
  });

  test("비활성 구성원은 팀 상세 표에서 구성원 탭과 같은 비활성 행으로 보이고 활성 행은 그대로다", async () => {
    const server = teamServer({
      members: [
        mateMember,
        {
          ...mateMember,
          user_id: USER_ID,
          email: owner.email,
          display_name: owner.display_name,
          disabled_at: AT,
        },
      ],
    });
    renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const table = await screen.findByRole("table", { name: "팀 구성원" });
    const rows = within(table).getAllByRole("row");
    const [, activeRow, inactiveRow] = rows as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(within(activeRow).queryByText("비활성")).toBeNull();
    expect(activeRow.getAttribute("data-disabled")).toBe("false");
    expect(within(inactiveRow).getByText("비활성")).toBeDefined();
    expect(inactiveRow.getAttribute("data-disabled")).toBe("true");
    expect(inactiveRow.className.split(" ")).toContain("bg-hover");
    expect(activeRow.className.split(" ")).not.toContain("bg-hover");
    // Still two lines, no avatar: the name beside its badge, then the email.
    expect(within(inactiveRow).getByText("owner@example.com")).toBeDefined();
    expect(table.querySelector('[data-slot="avatar"]')).toBeNull();
    // The server refuses both changes on a disabled member, so the row offers
    // neither: its team role reads as a badge, and no 제외 button is there.
    expect(within(activeRow).queryByRole("combobox")).not.toBeNull();
    expect(
      within(activeRow).queryByRole("button", { name: /제외/ }),
    ).not.toBeNull();
    expect(within(inactiveRow).queryByRole("combobox")).toBeNull();
    expect(within(inactiveRow).queryByRole("button")).toBeNull();
    expect(
      within(inactiveRow).getAllByText("구성원", {
        selector: "[data-slot=badge]",
      }).length,
    ).toBeGreaterThan(0);
  });

  test("팀 상세 표의 이름과 이메일은 말줄임이 나도 전체 글이 title에 남고, 이름은 두 줄까지 접힌다", async () => {
    const server = teamServer({ members: [mateMember] });
    renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const table = await screen.findByRole("table", { name: "팀 구성원" });
    const name = within(table).getByText("Mate");
    expect(name.getAttribute("title")).toBe("Mate");
    expect(name.className.split(" ")).toContain("line-clamp-2");
    expect(name.className.split(" ")).not.toContain("truncate");
    // The select's tighter padding switches at the table's own 820px, the same
    // query as the narrow tracks, so it never overflows a 7rem track in between.
    expect(within(table).getByRole("combobox").className.split(" ")).toContain(
      "[@container(max-width:820px)]:pe-6",
    );
    expect(
      within(table).getByText("mate@example.com").getAttribute("title"),
    ).toBe("mate@example.com");
  });

  test("담당 팀인 팀을 지우려 하면 지우지 않고 그 에이전트 이름을 링크로 알린다", async () => {
    const OTHER_ID = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
    const server = teamServer({
      deleteRefusal: () =>
        json(409, {
          error: {
            code: "TEAM_MANAGES_AGENTS",
            message: "The team manages agents",
            retryable: false,
            request_id: "req-1",
            details: { agent_ids: [AGENT_ID, OTHER_ID] },
          },
        }),
    });
    const { api, history } = renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
      "GET /v1/agents": (request: Request) => {
        const ids =
          new URL(request.url).searchParams.get("ids")?.split(",") ?? [];
        // Only one of them is still readable to this caller.
        return json(200, {
          items: ids
            .filter((id) => id === AGENT_ID)
            .map((id) => ({
              id,
              workspace_id: WORKSPACE_ID,
              slug: "billing-bot",
              name: "결제 봇",
              description: null,
              managing_team_id: TEAM_ID,
              managing_team_name: "결제팀",
              status: "active",
              active_release_id: null,
              activation_revision: 0,
              auto_model_migration: true,
              created_by: USER_ID,
              created_at: AT,
              updated_at: AT,
            })),
          next_cursor: null,
        });
      },
    });
    const user = await setupUser();
    const danger = await screen.findByRole("region", { name: "위험 구역" });
    expect(danger.textContent).toContain(
      "이 팀이 담당 팀인 에이전트가 있으면 그 에이전트의 담당 팀을 먼저 바꿔야 삭제할 수 있습니다.",
    );
    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "팀 삭제",
      }),
    );
    const alert = await screen.findByRole("alert");
    await waitFor(() =>
      expect(alert.textContent).toContain(
        "이 팀이 담당 팀인 에이전트가 있어 삭제하지 못했습니다. 아래 에이전트의 담당 팀을 먼저 바꾸세요.",
      ),
    );
    const list = within(alert).getByRole("list", {
      name: "이 팀이 담당 팀인 에이전트",
    });
    await waitFor(() =>
      expect(
        within(list)
          .getByRole("link", { name: "결제 봇" })
          .getAttribute("href"),
      ).toBe(`/agents/${AGENT_ID}`),
    );
    expect(list.textContent).toContain("그 밖에 1개");
    expect(
      api.calls
        .filter((c) => c.path === "/v1/agents")
        .map((c) => new URLSearchParams(c.search).get("ids")),
    ).toEqual([[AGENT_ID, OTHER_ID].sort().join(",")]);
    expect(server.team).not.toBeNull();
    expect(history.location.pathname).toBe(`/members/teams/${TEAM_ID}`);
  });

  test("담당 팀인 에이전트의 이름을 읽지 못하면 개수로 알린다", async () => {
    const server = teamServer({
      deleteRefusal: () =>
        json(409, {
          error: {
            code: "TEAM_MANAGES_AGENTS",
            message: "The team manages agents",
            retryable: false,
            request_id: "req-1",
            details: { agent_ids: [AGENT_ID] },
          },
        }),
    });
    renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
      "GET /v1/agents": () => apiError(500, "INTERNAL", "boom"),
    });
    const user = await setupUser();
    const danger = await screen.findByRole("region", { name: "위험 구역" });
    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "팀 삭제",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "이 팀이 담당 팀인 에이전트 1개가 있어 삭제하지 못했습니다. 각 에이전트의 담당 팀을 먼저 바꾸세요.",
      ),
    );
  });

  test("삭제가 거절되면 닫는 순간까지 남는 경고 토스트로 알린다", async () => {
    const server = teamServer({
      deleteRefusal: () => apiError(403, "FORBIDDEN", "Not permitted"),
    });
    renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    const user = await setupUser();
    const danger = await screen.findByRole("region", { name: "위험 구역" });
    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "팀 삭제",
      }),
    );
    const said = await toastSaid();
    expect(said).toContain("팀 관리 권한이 있어야");
    const alert = toastRegion();
    expect(alert?.getAttribute("role")).toBe("alert");
    // Explicit, so a modal opened later does not aria-hide it.
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    // Past the 8s an error nobody must act on would last.
    await new Promise((resolve) => setTimeout(resolve, 8300));
    expect(alert?.isConnected).toBe(true);
    // A later notice sits beside it instead of replacing it.
    const name = screen.getByLabelText("팀 이름");
    await user.clear(name);
    await user.type(name, "청구팀");
    await user.click(screen.getByRole("button", { name: "이름 바꾸기" }));
    await waitFor(() => {
      const texts = [...document.querySelectorAll("[data-slot=toast]")].map(
        (region) => region.textContent,
      );
      expect(texts).toHaveLength(2);
      expect(texts.some((s) => s?.includes("지금 이름은 청구팀"))).toBe(true);
      expect(texts.some((s) => s?.includes("팀 관리 권한이 있어야"))).toBe(
        true,
      );
    });
    expect(alert?.isConnected).toBe(true);
    await user.click(screen.getByRole("button", { name: "알림 닫기" }));
    await waitFor(() => expect(alert?.isConnected).toBe(false));
    // The button left with the toast: the keyboard stays on the page.
    expect(document.activeElement === document.body).toBe(false);
    expect(document.activeElement?.closest("main") === null).toBe(false);
  }, 20000);

  test("이미 있는 이름으로 바꾸려 하면 이름 칸 옆에서 말하고 토스트는 없다", async () => {
    const server = teamServer();
    renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
      [`PATCH /v1/teams/${TEAM_ID}`]: () =>
        apiError(409, "ALREADY_EXISTS", "A team by that name exists"),
    });
    const user = await setupUser();
    const name = await screen.findByLabelText("팀 이름");
    await user.clear(name);
    await user.type(name, "청구팀");
    await user.click(screen.getByRole("button", { name: "이름 바꾸기" }));
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByRole("alert").textContent).toBe(
      "같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.",
    );
    expect(toastRegion() === null).toBe(true);
    await user.type(name, "2");
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBeNull());
  });

  test("이름이 중복이라는 답이 늦게 와도 그 사이 고친 이름에는 붙지 않는다", async () => {
    const server = teamServer();
    let answer: ((response: Response) => void) | undefined;
    renderAt(`/members/teams/${TEAM_ID}`, {
      ...server.routes,
      [`PATCH /v1/teams/${TEAM_ID}`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const user = await setupUser();
    const name = await screen.findByLabelText("팀 이름");
    await user.clear(name);
    await user.type(name, "청구팀");
    await user.click(screen.getByRole("button", { name: "이름 바꾸기" }));
    await user.type(name, "2");
    answer?.(apiError(409, "ALREADY_EXISTS", "A team by that name exists"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(name.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // Back to the refused name, the refusal is about it again.
    await user.type(name, "{Backspace}");
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
  });

  test("내가 속한 팀에 그 팀에서의 내 역할이 보인다", async () => {
    renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold team.manage"),
      "GET /v1/my-teams": () =>
        json(200, {
          items: [{ id: TEAM_ID, name: "결제팀", role: "lead" }],
          next_cursor: null,
        }),
    });
    const section = await screen.findByRole("region", {
      name: "내가 속한 팀",
    });
    const row = within(section).getByRole("link", { name: "결제팀" })
      .parentElement as HTMLElement;
    expect(row.textContent).toBe("결제팀팀 관리자");
  });
});

const admins = (over: Partial<AgentAdminsView> = {}): AgentAdminsView => ({
  users: [
    {
      user_id: MATE_ID,
      email: "mate@example.com",
      display_name: "Mate",
      created_by: USER_ID,
      created_at: AT,
    },
  ],
  teams: [],
  ...over,
});

describe("에이전트 관리자", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(agentAdminsViewSchema.safeParse(admins()).success).toBe(true);
  });

  test("member인 에이전트 관리자는 팀을 붙이는 길이 없고 이유를 듣는다. 이미 붙은 팀은 뗄 수 있다 (94S-837)", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(
          200,
          admins({
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
                name: "결제팀",
                created_by: USER_ID,
                created_at: AT,
              },
            ],
          }),
        ),
    });
    const picker = (await screen.findByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    })) as HTMLInputElement;
    // No team list is read for someone who cannot name a team, and the
    // picker says why instead of offering one.
    expect(picker.getAttribute("aria-describedby")).not.toBeNull();
    expect(api.calls.some((c) => c.path === "/v1/teams")).toBe(false);
    expect(picker.disabled).toBe(true);
    expect(
      await screen.findByRole("button", {
        name: "결제팀을(를) 관리자에서 빼기",
      }),
    ).toBeDefined();
  });

  test("사람 고르기 칸에 키보드로 오면 그때 구성원을 읽는다", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
    });
    const picker = await screen.findByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    });
    const memberReads = () =>
      api.calls.filter((c) => c.path === "/v1/members").length;
    expect(memberReads()).toBe(0);
    act(() => picker.focus());
    await waitFor(() => expect(memberReads()).toBe(1));
    const user = await setupUser();
    await user.keyboard("{ArrowDown}");
    // Owner and the team; Mate already administers it.
    await waitFor(() =>
      expect(optionTexts()).toEqual(["Ownerowner@example.com", "결제팀팀"]),
    );
  });

  test("더 고를 사람·팀이 없으면 칸을 끄지 않고 포커스를 둔 채 이유를 보인다", async () => {
    let answer: () => void = () => {};
    const ask = () =>
      new Promise<void>((resolve) => {
        answer = resolve;
      });
    let asked = ask();
    let teamItems: object[] = [];
    const everyone = admins({
      users: [owner, mate].map((member) => ({
        user_id: member.user_id,
        email: member.email,
        display_name: member.display_name,
        created_by: USER_ID,
        created_at: AT,
      })),
    });
    const { api, services } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      "GET /v1/teams": async () => {
        await asked;
        return json(200, { items: teamItems, next_cursor: null });
      },
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, everyone),
    });
    const picker = (await screen.findByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    })) as HTMLInputElement;
    const reasonShown = () =>
      document.getElementById(picker.getAttribute("aria-describedby") ?? "")
        ?.textContent ?? "";
    act(() => picker.focus());
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/members")).toBe(true),
    );
    // Teams are still on their way, so nothing is known to be left out yet.
    expect(picker.disabled).toBe(false);
    expect(picker.getAttribute("aria-describedby")).toBeNull();

    act(() => answer());
    const reason = "추가할 수 있는 사람이나 팀이 없습니다.";
    await waitFor(() => expect(reasonShown()).toContain(reason));
    expect(picker.disabled).toBe(false);
    expect(document.activeElement === picker).toBe(true);

    // A team made since is on its way back: the old empty list says nothing.
    asked = ask();
    teamItems = [
      {
        id: TEAM_ID,
        workspace_id: WORKSPACE_ID,
        name: "결제팀",
        member_count: 0,
        created_by: USER_ID,
        created_at: AT,
        revision: 1,
      },
    ];
    act(() => {
      void services.queryClient.invalidateQueries({
        queryKey: keys.teams,
      });
    });
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === "/v1/teams").length).toBe(2),
    );
    expect(reasonShown()).not.toContain(reason);
    act(() => answer());
    const user = await setupUser();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(optionTexts()).toEqual(["결제팀팀"]));
    expect(reasonShown()).not.toContain(reason);
  });

  test("사람·팀 검색이 둘 다 실패해도 칸은 고칠 수 있고, 서버가 받는 길이까지만 받는다", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      "GET /v1/members": () => apiError(500, "INTERNAL", "boom"),
      "GET /v1/teams": () => apiError(500, "INTERNAL", "boom"),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
    });
    const picker = (await screen.findByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    })) as HTMLInputElement;
    expect(picker.maxLength).toBe(200);
    act(() => picker.focus());
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/teams")).toBe(true),
    );
    // Both lists failed: the reason is said under the picker, which stays
    // open for typing.
    await waitFor(() =>
      expect(picker.getAttribute("aria-describedby")).not.toBeNull(),
    );
    // The id must resolve to a real element: a dangling aria-describedby reads
    // as `undefined`, which a bare `.not.toBe("")` would let through.
    const hintText = document.getElementById(
      picker.getAttribute("aria-describedby") ?? "",
    )?.textContent;
    expect(hintText?.length ?? 0).toBeGreaterThan(0);
    expect(picker.disabled).toBe(false);
    const user = await setupUser();
    await user.type(picker, "a");
    await waitFor(
      () =>
        expect(
          api.calls.some(
            (c) => c.path === "/v1/members" && c.search === "?q=a",
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
  });

  test("관리자를 추가하는 동안 칸이 잠겨, 그사이 고른 사람이 말없이 사라지지 않는다", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = admins();
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, current),
      [`POST /v1/agents/${AGENT_ID}/admins`]: async (request: Request) => {
        const body = (await request.json()) as { team_id?: string };
        await gate;
        current = admins({
          teams: [
            {
              team_id: body.team_id ?? "",
              name: "결제팀",
              created_by: USER_ID,
              created_at: AT,
            },
          ],
        });
        return json(200, { admins: current, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    const picker = (await screen.findByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    })) as HTMLInputElement;
    await pick(user, picker, "결제");
    // The request is held: the picker clears its query on select, so an open
    // picker here would swallow a second choice with nothing left to retry.
    await waitFor(() => expect(picker.disabled).toBe(true));
    // happy-dom keeps focus on a disabled input; a browser drops it to <body>.
    act(() => {
      const sink = document.createElement("button");
      document.body.append(sink);
      sink.focus();
      sink.remove();
    });
    expect(document.activeElement === picker).toBe(false);
    expect(document.activeElement === document.body).toBe(true);
    expect(
      api.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/admins"),
      ),
    ).toHaveLength(1);

    act(() => release());
    expect(await toastSaid()).toBe("결제팀을(를) 관리자로 추가했습니다.");
    await waitFor(() => expect(picker.disabled).toBe(false));
    // The lock dropped focus to the page; it comes back so the next admin can
    // be typed at once.
    await waitFor(() => expect(document.activeElement === picker).toBe(true));
  });

  test("owner는 사람·팀을 지정하고 해제한다", async () => {
    const agentsApi = agentServer();
    const teams = teamServer();
    let current = admins();
    const { api, services } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      ...teams.routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, current),
      [`POST /v1/agents/${AGENT_ID}/admins`]: async (request: Request) => {
        const body = (await request.json()) as { team_id?: string };
        current = admins({
          teams: [
            {
              team_id: body.team_id ?? "",
              name: "결제팀",
              created_by: USER_ID,
              created_at: AT,
            },
          ],
        });
        return json(200, { admins: current, receipt_id: RECEIPT_ID });
      },
      [`DELETE /v1/agents/${AGENT_ID}/admins/users/${MATE_ID}`]: () => {
        current = { ...current, users: [] };
        return json(200, { admins: current, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    expect(
      (await screen.findByText("Mate")).closest("li")?.textContent,
    ).toContain("mate@example.com · 10/11부터 관리자");
    // The list's summaries name the admins, so a change marks them stale; the
    // overview watches this agent's summary, so it may be read again at once.
    const summary = keys.agentSummaries([AGENT_ID]);
    const listReads = () =>
      api.calls.filter((c) => c.method === "GET" && c.path === "/v1/agents")
        .length;
    await waitFor(() =>
      expect(services.queryClient.getQueryState(summary)?.fetchStatus).toBe(
        "idle",
      ),
    );
    const reads = listReads();
    const picker = screen.getByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    }) as HTMLInputElement;
    // There is no add button: choosing from the results adds at once.
    expect(screen.queryByRole("button", { name: "관리자로 추가" })).toBeNull();
    // People and teams are searched on the server together.
    await pick(user, picker, "결제");
    expect(
      api.calls
        .filter((c) => c.path === "/v1/members" || c.path === "/v1/teams")
        .map((c) => `${c.path}${decodeURIComponent(c.search)}`),
    ).toEqual(
      expect.arrayContaining(["/v1/members?q=결제", "/v1/teams?q=결제"]),
    );
    expect(await toastSaid()).toBe("결제팀을(를) 관리자로 추가했습니다.");
    await waitFor(() => expect(picker.value).toBe(""));
    expect(
      api.calls.find((c) => c.method === "POST" && c.path.endsWith("/admins"))
        ?.body,
    ).toEqual({ team_id: TEAM_ID });
    await waitFor(() =>
      expect(
        services.queryClient.getQueryState(summary)?.isInvalidated === true ||
          listReads() > reads,
      ).toBe(true),
    );

    await user.click(
      screen.getByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("다시 관리자로 추가하면 돌아옵니다");
    expect(dialog.textContent).not.toContain("나 자신을 빼면");
    await user.click(within(dialog).getByRole("button", { name: "빼기" }));
    await waitFor(() =>
      expect(toastRegion()?.textContent).toBe(
        "Mate을(를) 관리자에서 뺐습니다.",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeNull();
  });

  test("관리자 추가가 거절되면 목록은 그대로이고, 사유가 남고, 토스트 없이 칸이 풀린다", async () => {
    const refusal = "더 이상 없는 항목입니다 — 목록을 다시 불러오세요.";
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
      [`POST /v1/agents/${AGENT_ID}/admins`]: () =>
        apiError(404, "NOT_FOUND", "gone"),
    });
    const user = await setupUser();
    const picker = (await screen.findByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    })) as HTMLInputElement;
    await screen.findByText("Mate");
    await pick(user, picker, "결제");
    expect(await screen.findByText(refusal)).toBeDefined();
    await waitFor(() => expect(picker.disabled).toBe(false));
    // Nothing was added, nothing is announced as done.
    expect(screen.queryByText("결제팀")).toBeNull();
    expect(screen.getByText("Mate")).toBeDefined();
    // A toast region mounts as soon as one is raised and is filled later, so
    // its absence is the check; reading its text would pass before the fill.
    expect(toastRegion() === null).toBe(true);
    expect(
      api.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/admins"),
      ),
    ).toHaveLength(1);
  });

  test("관리자 빼기가 거절되면 그 사람은 목록에 남고, 사유가 남고, 토스트가 없다", async () => {
    const refusal = "더 이상 없는 항목입니다 — 목록을 다시 불러오세요.";
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
      [`DELETE /v1/agents/${AGENT_ID}/admins/users/${MATE_ID}`]: () =>
        apiError(404, "NOT_FOUND", "gone"),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "빼기" }));
    expect(await screen.findByText(refusal)).toBeDefined();
    // The dialog is gone and the row stays: the server did not remove them.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeDefined();
    expect(toastRegion() === null).toBe(true);
  });

  test("에이전트 관리자인 구성원이 자기 자신을 빼면 관리 권한을 잃는다고 경고하고, 취소하면 보내지 않는다", async () => {
    const agentsApi = agentServer();
    const agent = agentsApi.detail().agent;
    const self = {
      user_id: USER_ID,
      email: "owner@example.com",
      display_name: "Owner",
      created_by: USER_ID,
      created_at: AT,
    };
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(200, admins({ users: [self] })),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner을(를) 관리자에서 빼기",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("나 자신을 빼면 관리 권한을 잃습니다");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("모든 에이전트를 관리하는 소유자가 자기 자신을 빼도 권한을 잃는다고 하지 않는다", async () => {
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(200, {
          users: [
            {
              user_id: USER_ID,
              email: "owner@example.com",
              display_name: "Owner",
              created_by: USER_ID,
              created_at: AT,
            },
          ],
          teams: [],
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner을(를) 관리자에서 빼기",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toContain("나 자신을 빼면");
  });

  test("관리 목록 상한은 서버의 상한과 같다", () => {
    expect(ADMINISTERED_LIST_LIMIT).toBe(TEAM_LIST_LIMIT);
  });

  test("관리자 목록이 길어도 관리 여부는 이 에이전트의 관리자 목록으로 정한다", async () => {
    const agentsApi = agentServer();
    const agent = agentsApi.detail().agent;
    const others = Array.from({ length: TEAM_LIST_LIMIT }, () => ({
      ...agent,
      id: crypto.randomUUID(),
    }));
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: others }),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(
          200,
          admins({
            users: [
              ...admins().users,
              {
                user_id: USER_ID,
                email: "owner@example.com",
                display_name: "Owner",
                created_by: USER_ID,
                created_at: AT,
              },
            ],
          }),
        ),
    });
    expect(
      await screen.findByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeDefined();
  });

  test("관리 여부를 묻지 못하면 목록만 읽고 권한 문구는 없다", async () => {
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/my-teams": () => apiError(500, "INTERNAL", "Internal error"),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
    });
    expect(await screen.findByText("Mate")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeNull();
    expect(
      screen.queryByText(
        "에이전트 관리자 지정 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.",
      ),
    ).toBeNull();
  });

  test("관리자 목록이 실패하면 권한 문구가 아니라 실패를 보인다", async () => {
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Backend unavailable"),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
    );
    expect(
      within(alert).getByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
  });

  test("관리하지 않는 담당 팀 구성원은 관리자 목록을 읽기만 한다", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
    });
    expect(await screen.findByText("Mate")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "관리자로 추가할 사람이나 팀" }),
    ).toBeNull();
    expect(
      api.calls.some((c) => c.path === "/v1/members" || c.path === "/v1/teams"),
    ).toBe(false);
  });

  test("자기 에이전트의 관리자인 구성원은 목록을 보고, 고르기는 이유와 함께 닫혀 있다", async () => {
    const agentsApi = agentServer();
    const agent = (
      (await (
        await agentsApi.routes[`GET /v1/agents/${AGENT_ID}`]()
      ).json()) as { agent: unknown }
    ).agent;
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
      "GET /v1/my-teams": () =>
        json(200, {
          items: [{ id: TEAM_ID, name: "결제팀", role: "member" }],
          next_cursor: null,
        }),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(
          200,
          admins({
            teams: [
              {
                team_id: TEAM_ID,
                name: "결제팀",
                created_by: USER_ID,
                created_at: AT,
              },
            ],
          }),
        ),
    });
    expect(
      await screen.findByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeDefined();
    // There is no add button to carry the reason: the shut picker says it.
    expect(screen.queryByRole("button", { name: "관리자로 추가" })).toBeNull();
    const picker = screen.getByRole("combobox", {
      name: "관리자로 추가할 사람이나 팀",
    }) as HTMLInputElement;
    expect(picker.disabled).toBe(true);
    expect(
      document.getElementById(picker.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      "구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 구성원. 팀 관리 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.",
    );
    // Neither list is asked for, so no refused decision is left behind.
    expect(
      api.calls.some((c) => c.path === "/v1/members" || c.path === "/v1/teams"),
    ).toBe(false);
  });
});
