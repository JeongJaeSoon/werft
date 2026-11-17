import { describe, expect, test } from "bun:test";
import {
  type MemberView,
  memberViewSchema,
  WORKSPACE_ROLE_VALUES,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  memberPage,
  openActions,
  RECEIPT_ID,
  refusedActions,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

// The toast's region mounts empty and is filled a beat later (so a screen
// reader announces it): wait for the words, not just the region.
async function toastAlert(persistent = false): Promise<string> {
  const region = await screen.findByRole("alert");
  await waitFor(() => expect(region.textContent).not.toBe(""));
  expect(region.getAttribute("data-slot")).toBe("toast");
  // An error nobody must act on goes by itself: no dismiss button. One that
  // follows a confirm dialog waits to be dismissed, so it has one.
  const dismiss = screen.queryByRole("button", { name: "알림 닫기" });
  if (persistent) expect(dismiss).not.toBeNull();
  else expect(dismiss).toBeNull();
  return region.textContent ?? "";
}

const OTHER_ID = "2c7e1d4a-5b6f-4a8e-9d0c-1e2f3a4b5c6d";
const GONE_ID = "3d8f2e5b-6c7a-4b9f-8e1d-2f3a4b5c6d7e";

function member(overrides: Partial<MemberView>): MemberView {
  return {
    user_id: USER_ID,
    email: "owner@example.com",
    display_name: "Owner",
    role: "owner",
    disabled_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const owner = member({});
const teammate = member({
  user_id: OTHER_ID,
  email: "mate@example.com",
  display_name: "Mate",
  role: "member",
});
const gone = member({
  user_id: GONE_ID,
  email: "gone@example.com",
  display_name: "Gone",
  role: "member",
  disabled_at: "2026-10-05T00:00:00.000Z",
});

const noInvites = { "GET /v1/invites": () => json(200, { items: [] }) };

type User = Awaited<ReturnType<typeof setupUser>>;

const ROLE_NAME = { owner: "오너", admin: "어드민", member: "멤버" };

/** Opens a row's ⋯ menu and returns it. */
async function menuOf(user: User, name: string) {
  await user.click(await screen.findByRole("button", { name: `${name} 메뉴` }));
  return screen.findByRole("menu", { name: `${name} 메뉴` });
}

/** Opens a row's ⋯ menu and chooses one of its items. */
async function choose(user: User, name: string, item: string) {
  const menu = await menuOf(user, name);
  await user.click(within(menu).getByRole("menuitem", { name: item }));
}

/**
 * Whether a row's menu item is refused, and why; closes the menu again. A
 * refused item stays in the menu, dimmed, with its reason as description.
 */
async function itemRule(user: User, name: string, item: string) {
  const menu = await menuOf(user, name);
  const element = within(menu).getByRole("menuitem", { name: item });
  const rule = {
    refused: element.getAttribute("aria-disabled") === "true",
    reason: descriptionOf(element),
  };
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return rule;
}

/** The item names in a row's ⋯ menu; closes the menu again. */
async function itemsOf(user: User, name: string) {
  const menu = await menuOf(user, name);
  const names = within(menu)
    .getAllByRole("menuitem")
    .map(
      (item) =>
        document.getElementById(item.getAttribute("aria-labelledby") ?? "")
          ?.textContent ?? item.textContent,
    );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return names;
}

/** Opens 구성원 편집 for a member and returns the dialog. */
async function openEdit(user: User, name: string) {
  await choose(user, name, "구성원 편집");
  return screen.findByRole("dialog", { name: "구성원 편집" });
}

/** Picks a role in 구성원 편집, whose one button then confirms the change. */
async function pickRole(
  user: User,
  name: string,
  role: keyof typeof ROLE_NAME,
) {
  const edit = await openEdit(user, name);
  await user.click(within(edit).getByRole("radio", { name: ROLE_NAME[role] }));
  return edit;
}

/** Picks a role and confirms it in the same dialog. */
async function changeRole(
  user: User,
  name: string,
  role: keyof typeof ROLE_NAME,
) {
  const edit = await pickRole(user, name, role);
  await user.click(within(edit).getByRole("button", { name: "역할 바꾸기" }));
}

function descriptionOf(element: HTMLElement) {
  return document.getElementById(element.getAttribute("aria-describedby") ?? "")
    ?.textContent;
}

/** A member's row, found by its ⋯ button. */
function rowOf(name: string) {
  // Also while a dialog hides the page from the accessibility tree.
  return screen
    .getByRole("button", { name: `${name} 메뉴`, hidden: true })
    .closest("[role=row]") as HTMLElement;
}

/** A cell's text without the label a narrow card shows before it. */
function cellText(cell: Element | undefined) {
  if (cell === undefined) return undefined;
  return [...cell.childNodes]
    .filter(
      (node) => (node as Element).getAttribute?.("aria-hidden") !== "true",
    )
    .map((node) => node.textContent)
    .join("");
}

/** The role badge in a member's row: name | email | role | status | ⋯. */
function roleIn(name: string) {
  return cellText(rowOf(name).querySelectorAll("[role=cell]")[2]);
}

/** Whether 구성원 편집 lets the role change, and the reason when not. */
async function roleRule(user: User, name: string) {
  const edit = await openEdit(user, name);
  const radios = within(edit).getAllByRole("radio") as HTMLButtonElement[];
  const group = within(edit).getByRole("radiogroup");
  const rule = {
    disabled: radios.every((radio) => radio.disabled),
    reason: document.getElementById(
      group.getAttribute("aria-describedby") ?? "",
    )?.textContent,
  };
  await user.click(within(edit).getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  return rule;
}

const pendingInvite = {
  id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
  workspace_id: WORKSPACE_ID,
  email: "late@example.com",
  role: "member",
  invited_by: USER_ID,
  status: "pending",
  expires_at: "2026-10-18T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
  created_at: "2026-10-11T00:00:00.000Z",
};

describe("구성원 화면", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    for (const view of [owner, teammate, gone])
      expect(memberViewSchema.safeParse(view).success).toBe(true);
  });

  test("구성원 표의 이름은 한 줄로 말줄임하고 전체 이름은 title에 남는다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const name = await screen.findByText("Mate");
    expect(name.getAttribute("title")).toBe("Mate");
    expect(name.className.split(" ")).toContain("truncate");
  });

  test("행에 actions가 없는 이전 API에서도 화면이 오류로 떨어지지 않고 동작을 연다", async () => {
    renderAt(
      "/members",
      {
        "GET /v1/auth/me": () => json(200, me()),
        // What the API answered before rows carried actions.
        "GET /v1/members": () =>
          json(200, { items: [owner, teammate, gone], next_cursor: null }),
        ...noInvites,
      },
      "ko",
      "warn",
    );
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    expect(
      within(edit)
        .getAllByRole("radio")
        .map((radio) => (radio as HTMLButtonElement).disabled),
    ).toEqual([false, false, false]);
    await user.click(within(edit).getByRole("button", { name: "취소" }));
    expect(screen.queryByText("문제가 생겼습니다")).toBeNull();
    expect(await itemRule(user, "Gone", "다시 활성화")).toEqual({
      refused: false,
      reason: undefined,
    });
  });

  test("목록과 상태를 보이고, 역할 선택지는 contracts의 역할 그대로다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({ items: [owner, teammate, gone], next_cursor: null }),
        ),
      ...noInvites,
    });
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    expect(
      within(edit)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual([...WORKSPACE_ROLE_VALUES]);
    await user.click(within(edit).getByRole("button", { name: "취소" }));
    const region = screen.getByRole("table", { name: "구성원 표" });
    expect(
      within(region)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
      // The ⋯ column has no visible title, only one a screen reader reads.
    ).toEqual(["이름", "이메일", "역할", "상태", "관리"]);
    const headers = within(region).getAllByRole("columnheader");
    expect(headers.at(-1)?.querySelector(".sr-only")?.textContent).toBe("관리");
    const mateRow = rowOf("Mate");
    const cells = (row: HTMLElement) =>
      [...row.querySelectorAll("[role=cell]")].map(cellText);
    expect(cells(mateRow).slice(0, 4)).toEqual([
      "Mate",
      "mate@example.com",
      "멤버",
      "활성",
    ]);
    // On a phone each row is a card: the name and email head it, the other
    // cells carry their column's name, hidden from screen readers.
    expect(region.getAttribute("data-narrow-cards")).toBe("true");
    expect(
      [...mateRow.querySelectorAll("[role=cell]")].map(
        (cell) =>
          cell.querySelector(":scope > [aria-hidden=true]")?.textContent,
      ),
    ).toEqual([undefined, undefined, "역할", "상태", "관리"]);
    // No initials mark beside the name.
    expect(mateRow.querySelector("[data-slot=avatar]") === null).toBe(true);
    expect(roleIn("Mate")).toBe("멤버");
    expect(roleIn("Owner")).toBe("오너");
    // Each role has its own tone: owner violet, admin blue, member grey.
    expect(
      rowOf("Owner").querySelector("[data-role=owner]")?.className,
    ).toContain("tone-violet");
    expect(mateRow.querySelector("[data-role=member]")?.className).toContain(
      "tone-neutral",
    );
    const goneRow = rowOf("Gone");
    expect(goneRow.getAttribute("data-disabled")).toBe("true");
    // The grey fill is for the eye; the status names the state in text so
    // colour is not the only signal. The row is not toned down as a whole,
    // so the red status dot keeps its colour.
    expect(goneRow.hasAttribute("data-inactive")).toBe(false);
    expect(goneRow.classList.contains("bg-hover")).toBe(true);
    const status = (row: HTMLElement) =>
      row.querySelector("[data-slot=status-text]");
    expect(status(goneRow)?.textContent).toBe("정지됨");
    expect(status(goneRow)?.getAttribute("data-status")).toBe("failed");
    expect(status(mateRow)?.textContent).toBe("활성");
    expect(status(mateRow)?.getAttribute("data-status")).toBe("done");
    expect(mateRow.classList.contains("bg-hover")).toBe(false);
    expect(mateRow.hasAttribute("data-inactive")).toBe(false);
  });

  test("비활성 구성원의 행은 열리지 않고, 남은 동작은 다시 활성화 하나다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({ items: [owner, teammate, gone], next_cursor: null }),
        ),
      ...noInvites,
    });
    await screen.findByRole("button", { name: "Mate 메뉴" });
    const goneRow = rowOf("Gone");
    // No row opener on any row: a click on the row opens nothing; every
    // action is in the row's ⋯ menu.
    expect(document.querySelector("[data-slot=grid-table-row-opener]")).toBe(
      null,
    );
    expect(
      within(goneRow)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Gone 메뉴"]);
    const user = await setupUser();
    await user.click(within(goneRow).getByText("gone@example.com"));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Editing is refused with why; re-enabling is what is left.
    expect(await itemsOf(user, "Gone")).toEqual(["구성원 편집", "다시 활성화"]);
    expect(await itemRule(user, "Gone", "구성원 편집")).toEqual({
      refused: true,
      reason: "비활성 구성원의 역할은 다시 활성화한 뒤 바꿀 수 있습니다.",
    });
    expect(await itemRule(user, "Gone", "다시 활성화")).toEqual({
      refused: false,
      reason: undefined,
    });
    // Choosing the refused item does nothing.
    await choose(user, "Gone", "구성원 편집");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await itemsOf(user, "Mate")).toEqual(["구성원 편집", "비활성화"]);
  });

  test("행에는 비활성화만 있고 역할 select는 없다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const region = await screen.findByRole("table", { name: "구성원 표" });
    await screen.findByRole("button", { name: "Mate 메뉴" });
    expect(within(region).queryByRole("combobox")).toBeNull();
    expect(within(region).queryByRole("button", { name: /삭제/ })).toBeNull();
  });

  test("역할 변경은 서버가 답한 뒤에야 바뀐 것으로 보인다", async () => {
    let current = teammate;
    let release: () => void = () => {};
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, current], next_cursor: null })),
      ...noInvites,
      "PATCH /v1/members/2c7e1d4a-5b6f-4a8e-9d0c-1e2f3a4b5c6d": () =>
        new Promise((resolve) => {
          release = () => {
            current = { ...teammate, role: "owner" };
            resolve(json(200, current));
          };
        }),
    });
    const user = await setupUser();
    await changeRole(user, "Mate", "owner");
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "PATCH")).toBe(true),
    );
    expect(roleIn("Mate")).toBe("멤버");
    expect(screen.queryByText(/지금 역할은 오너입니다/) === null).toBe(true);
    release();
    expect(
      await screen.findByText(
        "Mate의 역할을 바꿨습니다. 지금 역할은 오너입니다.",
      ),
    ).toBeDefined();
    await waitFor(() => expect(roleIn("Mate")).toBe("오너"));
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ role: "owner" });
    expect(patch?.headers.get("x-requested-with")).toBe("werft-web");
  });

  test("마지막 소유자(409 LAST_OWNER)는 행이 미리 막는 이유와 같은 말로 보인다", async () => {
    // The list still showed two owners when the other one left.
    const boss = member({
      user_id: GONE_ID,
      email: "boss@example.com",
      display_name: "Boss",
      role: "owner",
    });
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({ items: [owner, boss, teammate], next_cursor: null }),
        ),
      ...noInvites,
      [`PATCH /v1/members/${GONE_ID}`]: () =>
        apiError(409, "LAST_OWNER", "The last owner cannot be demoted"),
    });
    const user = await setupUser();
    await changeRole(user, "Boss", "member");
    expect(await toastAlert(true)).toBe(
      "하나뿐인 오너의 역할은 바꿀 수 없습니다 — 다른 사람을 먼저 오너로 정하세요.",
    );
  });

  test("소유자 부여가 서버에서 403 OWNER_PROTECTED로 거절되면 그 이유를 보인다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
      [`PATCH /v1/members/${teammate.user_id}`]: () =>
        apiError(403, "OWNER_PROTECTED", "Only an owner can grant owner"),
    });
    const user = await setupUser();
    await changeRole(user, "Mate", "owner");
    expect(await toastAlert(true)).toBe(
      "오너 역할을 주거나 오너의 역할·접근(비활성화·정지·다시 활성화)을 바꾸는 일은 오너만 할 수 있습니다 — 오너에게 요청하세요.",
    );
  });

  test("소유자를 고른 뒤 서버가 소유자 부여를 막으면 저장이 막힌다", async () => {
    let mate: typeof teammate & {
      actions?: ReturnType<typeof openActions>;
    } = teammate;
    const { api, services } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, mate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    await user.click(within(edit).getByRole("radio", { name: "오너" }));
    const save = within(edit).getByRole("button", {
      name: "역할 바꾸기",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // Stepped down to admin since: the row now withholds the owner role.
    mate = {
      ...teammate,
      actions: {
        ...openActions(teammate),
        change_role: {
          ...openActions(teammate).change_role,
          owner: { allowed: false, reason: "owner_protected" },
        },
      },
    };
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(
      (within(edit).getByRole("radio", { name: "오너" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("소유자에게는 소유자 선택지가 열려 있고 역할 설명이 그대로다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    const ownerRadio = within(edit).getByRole("radio", {
      name: "오너",
    }) as HTMLButtonElement;
    expect(ownerRadio.disabled).toBe(false);
    expect(descriptionOf(ownerRadio)).toBe(
      "워크스페이스 설정과 오너까지 모두 바꿉니다.",
    );
  });

  test("관리자는 비활성 소유자를 다시 활성화하지 못하고, 메뉴 항목에 이유를 둔다", async () => {
    const boss = {
      ...gone,
      display_name: "Boss",
      role: "owner" as const,
      actions: refusedActions("owner_protected"),
    };
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [{ ...owner, role: "admin" }, teammate, boss],
            next_cursor: null,
          }),
        ),
      ...noInvites,
    });
    await screen.findByText("Boss");
    const user = await setupUser();
    expect(await itemRule(user, "Boss", "다시 활성화")).toEqual({
      refused: true,
      reason: "오너는 어드민이 다시 활성화할 수 없습니다.",
    });
    // Choosing it sends nothing.
    await choose(user, "Boss", "다시 활성화");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("다시 활성화가 403 OWNER_PROTECTED로 거절되면 그 동작의 말로 보인다", async () => {
    const boss = { ...gone, display_name: "Boss", role: "owner" as const };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, boss], next_cursor: null })),
      ...noInvites,
      [`POST /v1/members/${GONE_ID}/enable`]: () =>
        apiError(403, "OWNER_PROTECTED", "Only an owner may enable an owner"),
    });
    const user = await setupUser();
    await choose(user, "Boss", "다시 활성화");
    expect(await toastAlert()).toBe(
      "오너는 어드민이 다시 활성화할 수 없습니다.",
    );
  });

  test("비활성은 결과를 확인받고, 서버가 답하면 메뉴가 다시 활성화로 바뀐다", async () => {
    let current = teammate;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, current], next_cursor: null })),
      ...noInvites,
      [`POST /v1/members/${OTHER_ID}/disable`]: () => {
        current = { ...teammate, disabled_at: "2026-10-11T00:00:00.000Z" };
        return json(200, { member: current, receipt_id: null });
      },
    });
    const user = await setupUser();
    await choose(user, "Mate", "비활성화");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "웹 로그인과 개인 API 키가 바로 끊기고",
    );
    await user.click(within(dialog).getByRole("button", { name: "비활성화" }));
    expect(
      await screen.findByText("Mate 계정을 비활성화했습니다."),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        rowOf("Mate").querySelector("[data-slot=status-text]")?.textContent,
      ).toBe("정지됨"),
    );
    expect(await itemsOf(user, "Mate")).toEqual(["구성원 편집", "다시 활성화"]);
    expect(api.calls.find((c) => c.path.endsWith("/disable"))?.body).toEqual(
      {},
    );
  });

  test("재활성", async () => {
    let current = gone;
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, current], next_cursor: null })),
      ...noInvites,
      [`POST /v1/members/${GONE_ID}/enable`]: () => {
        current = { ...gone, disabled_at: null };
        return json(200, { member: current, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    await choose(user, "Gone", "다시 활성화");
    expect(
      await screen.findByText(
        "Gone 계정을 다시 활성화했습니다. 이제 다시 로그인할 수 있습니다.",
      ),
    ).toBeDefined();
  });

  test("초대 링크는 한 번 보이고, 비활성 구성원의 주소면 재활성을 안내한다", async () => {
    const token = "k".repeat(43);
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      // Beyond the first page: only the dialog's search finds them, on its
      // second page, after an address that merely contains the typed one.
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/members?q=GONE%40example.com": () =>
        json(
          200,
          memberPage({
            items: [{ ...gone, user_id: USER_ID, email: "xgone@example.com" }],
            next_cursor: "c2",
          }),
        ),
      "GET /v1/members?q=GONE%40example.com&cursor=c2": () =>
        json(200, memberPage({ items: [gone], next_cursor: null })),
      ...noInvites,
      "POST /v1/invites": () =>
        json(201, {
          invite_id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
          invite_token: token,
          expires_at: "2026-10-18T00:00:00.000Z",
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "구성원 초대" }),
    );
    const email = await screen.findByLabelText("이메일");
    await user.type(email, "GONE@example.com");
    await waitFor(() =>
      expect(
        document.getElementById(email.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toContain("다시 초대하지 말고 목록에서 다시 활성화하세요"),
    );
    // The server is asked about the typed address once typing pauses, not
    // for every member.
    expect(
      api.calls
        .filter((c) => c.path === "/v1/members")
        .map((c) => new URLSearchParams(c.search).get("q")),
    ).toEqual([null, null, "GONE@example.com", "GONE@example.com"]);
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: "초대 링크 만들기" }));
    const link = (await screen.findByLabelText(
      "초대 링크",
    )) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/invite/${token}`);
    expect(
      api.calls.find((c) => c.path === "/v1/invites" && c.method === "POST")
        ?.body,
    ).toEqual({
      email: "new@example.com",
      role: "member",
    });
  });

  test("검색어 한도(200자)보다 긴 주소도 앞부분으로 찾아 같은 주소면 재활성을 안내한다", async () => {
    const long = `${"g".repeat(230)}@example.com`;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": (request) =>
        json(
          200,
          memberPage({
            items: new URL(request.url).searchParams.has("q")
              ? [{ ...gone, email: long }]
              : [owner],
            next_cursor: null,
          }),
        ),
      ...noInvites,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "구성원 초대" }),
    );
    const email = await screen.findByLabelText("이메일");
    await user.click(email);
    await user.paste(long);
    await waitFor(() =>
      expect(
        document.getElementById(email.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toContain("다시 초대하지 말고 목록에서 다시 활성화하세요"),
    );
    expect(
      api.calls
        .map((c) => new URLSearchParams(c.search).get("q"))
        .filter((q) => q !== null),
    ).toEqual([long.slice(0, 200)]);
  });

  test("대기 중인 초대를 확인받고 회수한다", async () => {
    const invite = pendingInvite;
    let revoked = false;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: revoked ? [] : [invite] }),
      [`DELETE /v1/invites/${invite.id}`]: () => {
        revoked = true;
        return new Response(null, { status: 204 });
      },
    });
    const user = await setupUser();
    await choose(user, "late@example.com", "회수");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("보낸 링크로는 더 가입할 수 없습니다");
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "회수" }));
    expect(
      await screen.findByText("late@example.com 초대를 회수했습니다."),
    ).toBeDefined();
    // The invite's row leaves the members table; the members stay.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "late@example.com 메뉴" }) ===
          null,
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Owner 메뉴" })).toBeDefined();
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  test("초대 회수를 취소하면 아무것도 보내지 않는다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    const user = await setupUser();
    await choose(user, "late@example.com", "회수");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "late@example.com 메뉴" }),
    ).toBeDefined();
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  for (const [why, clipboard] of [
    [
      "클립보드가 거부하면",
      {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    ],
    ["클립보드가 없으면(비보안 컨텍스트)", undefined],
  ] as const) {
    test(`${why} 직접 복사하라고 알리고 링크 칸을 선택해 둔다`, async () => {
      renderAt("/members", {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/members": () =>
          json(200, memberPage({ items: [owner], next_cursor: null })),
        ...noInvites,
        "POST /v1/invites": () =>
          json(201, {
            invite_id: pendingInvite.id,
            invite_token: "k".repeat(43),
            expires_at: "2026-10-18T00:00:00.000Z",
          }),
      });
      const user = await setupUser();
      await user.click(
        await screen.findByRole("button", { name: "구성원 초대" }),
      );
      await user.type(await screen.findByLabelText("이메일"), "n@example.com");
      await user.click(
        screen.getByRole("button", { name: "초대 링크 만들기" }),
      );
      const copyButton = await screen.findByRole("button", {
        name: "링크 복사",
      });
      const field = screen.getByLabelText<HTMLInputElement>("초대 링크");
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: clipboard,
      });
      try {
        // The refusal settles after the click returns; act flushes it.
        await act(async () => copyButton.click());
        expect((await screen.findByRole("alert")).textContent).toBe(
          "초대 링크를 복사하지 못했습니다 — 링크 칸을 눌러 직접 복사하세요.",
        );
        expect(document.activeElement).toBe(field);
        expect(
          field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0),
        ).toBe(field.value);
      } finally {
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    });
  }
});

describe("되돌리기 어려운 동작의 확인", () => {
  const routes = (calls: string[]) => ({
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/members": () =>
      json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
    ...noInvites,
    [`PATCH /v1/members/${OTHER_ID}`]: () => {
      calls.push("PATCH");
      return json(200, { ...teammate, role: "owner" });
    },
  });

  test("역할을 골라 넘기기만 해서는 아무것도 보내지 않는다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    const save = within(edit).getByRole("button", {
      name: "역할 바꾸기",
    }) as HTMLButtonElement;
    // The role it already has is nothing to save.
    expect(save.disabled).toBe(true);
    await user.click(within(edit).getByRole("radio", { name: "어드민" }));
    await user.click(within(edit).getByRole("radio", { name: "오너" }));
    expect(calls).toEqual([]);
    // One dialog: it says the resulting role before its button sends it.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(edit.textContent).toContain("바꾸면 Mate의 역할은 오너입니다.");
    expect(edit.textContent).toContain("오너는 워크스페이스 설정과");
    await Bun.sleep(20);
    expect(calls).toEqual([]);
    await user.click(save);
    await waitFor(() => expect(calls).toEqual(["PATCH"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("역할 변경을 취소하면 원래 역할 그대로다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const dialog = await pickRole(user, "Mate", "admin");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(roleIn("Mate")).toBe("멤버");
    expect(calls).toEqual([]);
  });

  test("저장하는 동안에는 편집을 닫을 수 없고, 응답이 오면 닫힌다", async () => {
    let release: () => void = () => {};
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
      [`PATCH /v1/members/${OTHER_ID}`]: () =>
        new Promise((resolve) => {
          release = () => resolve(json(200, { ...teammate, role: "admin" }));
        }),
    });
    const user = await setupUser();
    const edit = await pickRole(user, "Mate", "admin");
    await user.click(within(edit).getByRole("button", { name: "역할 바꾸기" }));
    const cancel = (await within(edit).findByRole("button", {
      name: "취소",
    })) as HTMLButtonElement;
    try {
      await waitFor(() => expect(cancel.disabled).toBe(true));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog") === null).toBe(false);
    } finally {
      release();
    }
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
  });

  test("편집을 닫으면 키보드가 그 행의 ⋯ 버튼으로 돌아온다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const name = await screen.findByRole("button", { name: "Mate 메뉴" });
    await openEdit(user, "Mate");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    const edit = await openEdit(user, "Mate");
    await user.click(within(edit).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
  });

  test("역할을 바꾼 뒤에도 키보드가 그 행의 ⋯ 버튼으로 돌아온다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const name = await screen.findByRole("button", { name: "Mate 메뉴" });
    await changeRole(user, "Mate", "owner");
    await waitFor(() => expect(calls).toEqual(["PATCH"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
  });

  test("자기 자신과 서버가 소유자라 막은 행은 비활성화를 막고 이유를 붙인다", async () => {
    const other = {
      ...member({
        user_id: GONE_ID,
        email: "boss@example.com",
        display_name: "Boss",
        role: "owner",
      }),
      actions: refusedActions("owner_protected"),
    };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [{ ...owner, role: "admin" }, other, teammate],
            next_cursor: null,
          }),
        ),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await itemRule(user, "Owner", "비활성화")).toEqual({
      refused: true,
      reason: "자기 자신은 비활성화할 수 없습니다.",
    });
    expect(await itemRule(user, "Boss", "비활성화")).toEqual({
      refused: true,
      reason: "오너는 어드민이 비활성화할 수 없습니다.",
    });
    expect(await itemRule(user, "Mate", "비활성화")).toEqual({
      refused: false,
      reason: undefined,
    });
    // A refused item opens no confirmation.
    await choose(user, "Boss", "비활성화");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The arrow keys reach a refused item, so a keyboard hears its reason;
    // the menu opens on the first item that can be chosen.
    const menu = await menuOf(user, "Owner");
    const edit = within(menu).getByRole("menuitem", { name: "구성원 편집" });
    await waitFor(() => expect(document.activeElement === edit).toBe(true));
    await user.keyboard("{ArrowDown}");
    const refused = within(menu).getByRole("menuitem", { name: "비활성화" });
    expect(document.activeElement === refused).toBe(true);
    expect(descriptionOf(refused)).toBe("자기 자신은 비활성화할 수 없습니다.");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("본인 행은 이름 옆에 '나'를 달고, 관리 열에는 ⋯ 버튼 하나만 둔다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "owner")),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const button = await screen.findByRole("button", { name: "Owner 메뉴" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(within(rowOf("Owner")).getByText("나")).toBeDefined();
    expect(within(rowOf("Mate")).queryByText("나")).toBeNull();
    // No "›" beside the name: the row itself does not open.
    expect(rowOf("Owner").textContent).not.toContain("›");
    // Only the ⋯ button in the last cell.
    const cell = button.closest("[role=cell]") as HTMLElement;
    expect(within(cell).getAllByRole("button")).toEqual([button]);
    const user = await setupUser();
    expect(await itemRule(user, "Owner", "비활성화")).toEqual({
      refused: true,
      reason: "자기 자신은 비활성화할 수 없습니다.",
    });
  });

  test("비활성 구성원의 역할은 편집에서 막고, 다시 활성화하라고 한다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [
              { ...owner, role: "admin" },
              {
                // Disabled by someone else after this list was read: the
                // refreshed actions say so before the row does.
                ...gone,
                disabled_at: null,
                display_name: "Boss",
                actions: {
                  ...openActions(gone),
                  change_role: refusedActions("member_disabled").change_role,
                },
              },
            ],
            next_cursor: null,
          }),
        ),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await roleRule(user, "Boss")).toEqual({
      disabled: true,
      reason: "비활성 구성원의 역할은 다시 활성화한 뒤 바꿀 수 있습니다.",
    });
  });

  test("역할도 같은 규칙으로 편집에서 막고, 비활성화 이유는 메뉴 항목 아래에 둔다", async () => {
    const boss = {
      ...member({
        user_id: GONE_ID,
        email: "boss@example.com",
        display_name: "Boss",
        role: "owner",
      }),
      actions: refusedActions("owner_protected"),
    };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [{ ...owner, role: "admin" }, boss, teammate],
            next_cursor: null,
          }),
        ),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await roleRule(user, "Owner")).toEqual({
      disabled: true,
      reason: "자기 자신의 역할은 바꿀 수 없습니다.",
    });
    expect(await roleRule(user, "Boss")).toEqual({
      disabled: true,
      reason: "오너의 역할은 어드민이 바꿀 수 없습니다.",
    });
    expect((await roleRule(user, "Mate")).disabled).toBe(false);

    // The reason is under the refused item, which keeps its plain name.
    const menu = await menuOf(user, "Boss");
    const item = within(menu).getByRole("menuitem", { name: "비활성화" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(
      "오너는 어드민이 비활성화할 수 없습니다.",
    );
    expect(descriptionOf(item)).toBe("오너는 어드민이 비활성화할 수 없습니다.");
    // Escape closes the menu and gives the keyboard back to the ⋯ button.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "Boss 메뉴" }),
      ).toBe(true),
    );
  });
});

/**
 * GET /v1/members as the server pages it: `size` a page unless the request
 * names a limit, `q` matched in name or email ignoring case, the cursor the
 * index of the next row. Each answer may be held or failed by `gate`.
 */
function pagedMembers(
  all: readonly MemberView[],
  size: number,
  gate: (search: URLSearchParams) => Promise<Response | undefined> = () =>
    Promise.resolve(undefined),
) {
  return async (request: Request) => {
    const search = new URL(request.url).searchParams;
    const held = await gate(search);
    if (held) return held;
    const q = search.get("q")?.toLowerCase();
    const found = q
      ? all.filter((row) =>
          `${row.display_name}\n${row.email}`.toLowerCase().includes(q),
        )
      : all;
    const from = Number(search.get("cursor") ?? 0);
    const to = from + Number(search.get("limit") ?? size);
    return json(
      200,
      memberPage({
        items: found.slice(from, to),
        next_cursor: to < found.length ? String(to) : null,
      }),
    );
  };
}

/** The 구성원 tab's own reads; the head's invite button reads every page. */
function screenReads(calls: readonly { path: string; search: string }[]) {
  return calls
    .filter((c) => c.path === "/v1/members" && !c.search.includes("limit="))
    .map((c) => c.search);
}

function rowNames() {
  return screen
    .getAllByRole("button", { name: / 메뉴$/ })
    .map((button) => button.getAttribute("aria-label")?.replace(/ 메뉴$/, ""));
}

const crowd = Array.from({ length: 5 }, (_, index) =>
  member({
    user_id: `00000000-0000-4000-8000-00000000000${index}`,
    email: `person${index}@example.com`,
    display_name: `Person ${index}`,
    role: "member",
  }),
);

describe("구성원 페이지와 서버 검색", () => {
  test("첫 페이지만 받고, 더 보기로 다음 페이지를 이어 붙이며, 끝이면 버튼이 없다", async () => {
    let release: () => void = () => {};
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(crowd, 2, (search) =>
        search.get("cursor") === "2"
          ? new Promise((resolve) => {
              release = () => resolve(undefined);
            })
          : Promise.resolve(undefined),
      ),
      ...noInvites,
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Person 1 메뉴" });
    expect(rowNames()).toEqual(["Person 0", "Person 1"]);
    expect(screenReads(api.calls)).toEqual([""]);

    const more = screen.getByRole("button", { name: "더 보기" });
    await act(async () => more.focus());
    await user.keyboard("{Enter}");
    const loading = await screen.findByRole("button", { name: "불러오는 중…" });
    expect(loading === more).toBe(true);
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement === more).toBe(true);
    // A second Enter while the page is on its way asks for nothing more.
    await user.keyboard("{Enter}");
    release();
    await screen.findByRole("button", { name: "Person 3 메뉴" });
    expect(rowNames()).toEqual([
      "Person 0",
      "Person 1",
      "Person 2",
      "Person 3",
    ]);
    expect(more.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement === more).toBe(true);

    await user.keyboard("{Enter}");
    const first = await screen.findByRole("button", { name: "Person 4 메뉴" });
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
    // The button went with the last page; the keyboard lands on its row.
    await waitFor(() => expect(document.activeElement === first).toBe(true));
    // One read a page, each from where the last one stopped.
    expect(screenReads(api.calls)).toEqual(["", "?cursor=2", "?cursor=4"]);
  });

  test("구성원을 바꾼 뒤 받은 페이지를 다시 읽는 동안에는 더 보기를 막는다", async () => {
    let hold = false;
    // The invite button reads the first page too, and its request may go out
    // before the list's: release every held read, not just the last.
    const releases: Array<() => void> = [];
    const release = () => {
      for (const resolve of releases.splice(0)) resolve();
    };
    const rows = [...crowd];
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(rows, 2, () =>
        hold
          ? new Promise((resolve) => {
              releases.push(() => resolve(undefined));
            })
          : Promise.resolve(undefined),
      ),
      ...noInvites,
      [`POST /v1/members/${crowd[0]?.user_id}/disable`]: () => {
        rows[0] = {
          ...crowd[0],
          disabled_at: "2026-10-11T00:00:00.000Z",
        } as MemberView;
        hold = true;
        return json(200, { member: rows[0], receipt_id: null });
      },
    });
    const user = await setupUser();
    await choose(user, "Person 0", "비활성화");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "비활성화" }));
    await screen.findByText("Person 0 계정을 비활성화했습니다.");
    const more = screen.getByRole("button", { name: "더 보기" });
    await waitFor(() =>
      expect(more.getAttribute("aria-disabled")).toBe("true"),
    );
    // Pressed now it would cancel the reread and keep the stale rows.
    await user.click(more);
    hold = false;
    release();
    await waitFor(() =>
      expect(rowOf("Person 0").getAttribute("data-disabled")).toBe("true"),
    );
    expect(more.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Person 2 메뉴" })).toBeNull();
  });

  test("구성원을 바꾼 뒤 다시 읽기가 실패하면 더 보기 대신 다시 시도만 보인다", async () => {
    let failing = false;
    const rows = [...crowd];
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(rows, 2, () =>
        Promise.resolve(
          failing ? apiError(500, "INTERNAL_ERROR", "boom") : undefined,
        ),
      ),
      ...noInvites,
      [`POST /v1/members/${crowd[0]?.user_id}/disable`]: () => {
        rows[0] = {
          ...crowd[0],
          disabled_at: "2026-10-11T00:00:00.000Z",
        } as MemberView;
        failing = true;
        return json(200, { member: rows[0], receipt_id: null });
      },
    });
    const user = await setupUser();
    await choose(user, "Person 0", "비활성화");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "비활성화" }));
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-variant")).toBe("red");
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();

    failing = false;
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("button", { name: "더 보기" });
    expect(rowOf("Person 0").getAttribute("data-disabled")).toBe("true");
  });

  test("늦게 온 이전 검색 결과는 지금 검색 결과를 덮지 않는다", async () => {
    let release: () => void = () => {};
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(
        [owner, teammate, ...crowd],
        2,
        (search) =>
          search.get("q") === "Person"
            ? new Promise((resolve) => {
                release = () => resolve(undefined);
              })
            : Promise.resolve(undefined),
      ),
      ...noInvites,
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Owner 메뉴" });
    const box = screen.getByRole("searchbox");
    await user.type(box, "Person");
    await waitFor(() => expect(screenReads(api.calls)).toContain("?q=Person"));
    await user.clear(box);
    await user.type(box, "Mate");
    await waitFor(() => expect(rowNames()).toEqual(["Mate"]));
    release();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(rowNames()).toEqual(["Mate"]);
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  test("다음 페이지가 실패하면 받은 행은 두고 빨간 알림과 다시 시도를 보인다", async () => {
    let failing = true;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(crowd, 2, (search) =>
        Promise.resolve(
          search.get("cursor") === "2" && failing
            ? apiError(500, "INTERNAL_ERROR", "boom")
            : undefined,
        ),
      ),
      ...noInvites,
    });
    const user = await setupUser();
    const more = await screen.findByRole("button", { name: "더 보기" });
    await act(async () => more.focus());
    await user.keyboard("{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert.getAttribute("data-variant")).toBe("red");
    expect(alert.textContent).toContain("불러오지 못했습니다");
    expect(rowNames()).toEqual(["Person 0", "Person 1"]);
    // 더 보기 stays, and the keyboard with it.
    expect(screen.getByRole("button", { name: "더 보기" }) === more).toBe(true);
    expect(document.activeElement === more).toBe(true);

    failing = false;
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("button", { name: "Person 3 메뉴" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screenReads(api.calls)).toEqual(["", "?cursor=2", "?cursor=2"]);
  });

  test("다음 페이지가 실패한 뒤 더 보기로 다시 받아도 포커스가 버튼에 남는다", async () => {
    let failing = true;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(crowd, 2, (search) =>
        Promise.resolve(
          search.get("cursor") === "2" && failing
            ? apiError(500, "INTERNAL_ERROR", "boom")
            : undefined,
        ),
      ),
      ...noInvites,
    });
    const user = await setupUser();
    const more = await screen.findByRole("button", { name: "더 보기" });
    await act(async () => more.focus());
    await user.keyboard("{Enter}");
    await screen.findByRole("alert");
    failing = false;
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Person 3 메뉴" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(document.activeElement === more).toBe(true);
    expect(screenReads(api.calls)).toEqual(["", "?cursor=2", "?cursor=2"]);
  });

  test("검색어는 다듬어 서버 q로 한 번 보내고, 바꾸면 첫 페이지부터 다시 받는다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers([owner, teammate, gone, ...crowd], 2),
      ...noInvites,
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Owner 메뉴" });
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "Gone 메뉴" });

    const box = screen.getByRole("searchbox", {
      name: "이름이나 이메일로 찾기",
    });
    await user.type(box, "  PERSON ");
    await waitFor(() => expect(rowNames()).toEqual(["Person 0", "Person 1"]));
    // The loaded rows are not filtered in the browser: the server answers.
    expect(screenReads(api.calls)).toEqual(["", "?cursor=2", "?q=PERSON"]);
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "Person 3 메뉴" });
    expect(screenReads(api.calls).at(-1)).toBe("?q=PERSON&cursor=2");

    await user.clear(box);
    await user.type(box, "nobody");
    await screen.findByText("검색어에 맞는 구성원이 없습니다");
    expect(screenReads(api.calls).filter((s) => s.includes("q=n"))).toEqual([
      "?q=nobody",
    ]);

    await user.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect(document.activeElement === box).toBe(true);
    await waitFor(() => expect(rowNames()).toEqual(["Owner", "Mate"]));
    expect(screen.getByRole("button", { name: "더 보기" })).toBeDefined();
    // An emptied box is the whole list again, from its first page alone.
    expect(screenReads(api.calls)).toEqual([
      "",
      "?cursor=2",
      "?q=PERSON",
      "?q=PERSON&cursor=2",
      "",
      "?q=nobody",
      "",
    ]);
  });

  const boss = member({
    user_id: GONE_ID,
    email: "boss@example.com",
    display_name: "Boss",
    role: "owner",
  });
  const disableOf = async (user: User, name: string) =>
    itemRule(user, name, "비활성화");

  test("화면은 마지막 소유자를 스스로 세지 않는다: 다음 페이지 전에도 뒤에도 서버가 연 행은 열려 있다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      // The viewer, the other owner, is on the second page.
      "GET /v1/members": pagedMembers([boss, teammate, owner], 2),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await disableOf(user, "Boss")).toEqual({
      refused: false,
      reason: undefined,
    });
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "Owner 메뉴" });
    expect(await disableOf(user, "Boss")).toEqual({
      refused: false,
      reason: undefined,
    });
  });

  test("검색 결과의 행도 서버가 준 동작 그대로다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers([owner, boss, teammate], 2),
      ...noInvites,
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Owner 메뉴" });
    await user.type(screen.getByRole("searchbox"), "boss");
    await waitFor(() => expect(rowNames()).toEqual(["Boss"]));
    expect(await disableOf(user, "Boss")).toEqual({
      refused: false,
      reason: undefined,
    });
  });

  test("계정이 정지된 행은 서버가 준 이유로 다시 활성화를 막고, 열리지 않는다", async () => {
    const suspended = {
      ...gone,
      actions: {
        change_role: refusedActions("account_disabled").change_role,
        disable: { allowed: true },
        enable: { allowed: false, reason: "account_disabled" },
      },
    } as const;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, suspended], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await itemRule(user, "Gone", "다시 활성화")).toEqual({
      refused: true,
      reason:
        "계정이 정지된 사람은 여기서 다시 활성화할 수 없습니다 — 계정 정지를 먼저 풀어야 합니다.",
    });
    await choose(user, "Gone", "다시 활성화");
    // A suspended row is inactive too: nothing on it opens a role dialog.
    await user.click(screen.getByText("gone@example.com"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.calls.some((call) => call.method !== "GET")).toBe(false);
  });

  test("관리자에게 서버가 막은 소유자 선택지만 비활성이고, 그 자리와 묶음에 이유를 둔다", async () => {
    const mate = {
      ...teammate,
      actions: {
        ...openActions(teammate),
        change_role: {
          owner: { allowed: false, reason: "owner_protected" },
          admin: { allowed: true },
          member: { allowed: false, reason: "unchanged" },
        },
      },
    } as const;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, mate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    const radio = (name: string) =>
      within(edit).getByRole("radio", { name }) as HTMLButtonElement;
    expect(radio("오너").disabled).toBe(true);
    expect(descriptionOf(radio("오너"))).toBe(
      "오너 역할은 오너만 줄 수 있습니다.",
    );
    expect(descriptionOf(within(edit).getByRole("radiogroup"))).toBe(
      "오너 역할은 오너만 줄 수 있습니다.",
    );
    expect(radio("어드민").disabled).toBe(false);
    expect(radio("멤버").disabled).toBe(false);
    // Arrow keys skip the withheld radio.
    radio("멤버").focus();
    await user.keyboard("{ArrowDown>}");
    await waitFor(() =>
      expect(document.activeElement === radio("어드민")).toBe(true),
    );
    await user.keyboard("{/ArrowDown}{ArrowDown>}");
    await waitFor(() =>
      expect(document.activeElement === radio("멤버")).toBe(true),
    );
    await user.keyboard("{/ArrowDown}");
    await user.click(radio("멤버"));
    const save = within(edit).getByRole("button", {
      name: "역할 바꾸기",
    }) as HTMLButtonElement;
    // The role it already has saves nothing.
    expect(save.disabled).toBe(true);
    await user.click(radio("어드민"));
    expect(save.disabled).toBe(false);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("열린 편집은 다시 받은 행의 허용 동작을 따른다", async () => {
    let mate: typeof teammate & {
      actions?: ReturnType<typeof refusedActions>;
    } = teammate;
    const { services } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, mate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    await user.click(within(edit).getByRole("radio", { name: "어드민" }));
    const save = within(edit).getByRole("button", {
      name: "역할 바꾸기",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // Another owner's change since: the server now refuses this row.
    mate = { ...teammate, actions: refusedActions("owner_protected") };
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(descriptionOf(within(edit).getByRole("radiogroup"))).toBe(
      "오너의 역할은 어드민이 바꿀 수 없습니다.",
    );
  });

  test("편집을 연 채 대상이 비활성화되면 닫을 때 포커스가 그 행의 ⋯ 버튼으로 가고, 메뉴는 다시 활성화를 준다", async () => {
    let mate: MemberView = teammate;
    const { services } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, mate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    await openEdit(user, "Mate");
    mate = { ...teammate, disabled_at: "2026-10-11T00:00:00.000Z" };
    await act(() => services.queryClient.refetchQueries());
    // Behind the open dialog the page is aria-hidden.
    await waitFor(() =>
      expect(
        rowOf("Mate").querySelector("[data-slot=status-text]")?.textContent,
      ).toBe("정지됨"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "Mate 메뉴" }),
      ).toBe(true),
    );
    expect(await itemsOf(user, "Mate")).toEqual(["구성원 편집", "다시 활성화"]);
  });

  test("편집을 연 채 계정이 정지되면 닫을 때 포커스가 ⋯ 버튼으로 가고, 메뉴는 다시 활성화를 이유와 함께 막는다", async () => {
    const suspended = {
      ...teammate,
      disabled_at: "2026-10-11T00:00:00.000Z",
      actions: {
        change_role: refusedActions("account_disabled").change_role,
        disable: { allowed: true },
        enable: { allowed: false, reason: "account_disabled" },
      },
    } as const;
    let mate: MemberView | typeof suspended = teammate;
    const { services } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, mate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    await openEdit(user, "Mate");
    mate = suspended;
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() =>
      expect(
        rowOf("Mate").querySelector("[data-slot=status-text]")?.textContent,
      ).toBe("정지됨"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "Mate 메뉴" }),
      ).toBe(true),
    );
    expect(await itemRule(user, "Mate", "다시 활성화")).toEqual({
      refused: true,
      reason:
        "계정이 정지된 사람은 여기서 다시 활성화할 수 없습니다 — 계정 정지를 먼저 풀어야 합니다.",
    });
  });

  test("고르지 않은 열린 편집은 다시 받은 행의 역할을 따라, 바뀐 역할을 되돌리지 않는다", async () => {
    let mate: MemberView = teammate;
    const { api, services } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, mate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    const save = within(edit).getByRole("button", {
      name: "역할 바꾸기",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Another owner made Mate an admin since the dialog opened.
    mate = { ...teammate, role: "admin" };
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() =>
      expect(
        within(edit)
          .getByRole("radio", { name: "어드민" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(save.disabled).toBe(true);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("서버가 409로 거절하면 목록을 다시 받는다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
      [`PATCH /v1/members/${OTHER_ID}`]: () =>
        apiError(409, "MEMBER_DISABLED", "The membership is disabled"),
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Mate 메뉴" });
    const reads = () =>
      api.calls.filter(
        (call) => call.method === "GET" && call.path === "/v1/members",
      ).length;
    const before = reads();
    await changeRole(user, "Mate", "admin");
    expect(await toastAlert(true)).toBe(
      "비활성 구성원의 역할은 다시 활성화한 뒤 바꿀 수 있습니다.",
    );
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});
describe("구성원 · 팀 탭", () => {
  const tabsOf = () =>
    within(screen.getByRole("navigation", { name: "구성원 보기" }))
      .getAllByRole("link")
      .map((link) => [
        link.textContent,
        link.getAttribute("href"),
        link.getAttribute("aria-current"),
      ]);

  test("관리하는 사람은 구성원과 팀 두 탭만 보고, 초대 탭은 없다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    await screen.findByRole("button", { name: "Mate 메뉴" });
    expect(tabsOf()).toEqual([
      ["구성원", "/members", "page"],
      ["팀", "/members/teams", null],
    ]);
    expect(screen.queryByRole("link", { name: "초대" }) === null).toBe(true);
  });

  test("예전 초대 탭 주소는 404 대신 구성원 탭으로 가서 초대 행을 보인다", async () => {
    const { history } = renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    expect(
      await screen.findByRole("button", { name: "late@example.com 메뉴" }),
    ).toBeDefined();
    expect(tabsOf()[0]).toEqual(["구성원", "/members", "page"]);
    expect(history.location.pathname).toBe("/members");
  });

  test("대기 중인 초대는 구성원 표의 행으로, '초대 중' 상태와 회수 메뉴를 갖는다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "late@example.com 메뉴" });
    // One table: the invite is a row under the member's, not a table of its own.
    expect(screen.getAllByRole("table")).toHaveLength(1);
    const table = screen.getByRole("table", { name: "구성원 표" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const row = rowOf("late@example.com");
    const cells = [...row.querySelectorAll("[role=cell]")];
    // No name until it is accepted: the email stands in.
    expect(cells[0]?.textContent).toBe("late@example.com");
    expect(cells[1]?.textContent).toBe("late@example.com");
    expect(roleIn("late@example.com")).toBe("멤버");
    const status = row.querySelector("[data-slot=status-text]");
    expect(status?.textContent).toBe("초대 중");
    expect(status?.getAttribute("data-status")).toBe("wait");
    // The status keeps one line; the full expiry is the note of an icon
    // button beside it.
    const expiry = within(cells[3] as HTMLElement).getByRole("button", {
      name: "late@example.com 초대의 만료 시각",
    });
    expect(expiry.dataset.slot).toBe("invite-expiry");
    const note = "2026년 10월 18일 09:00:00 GMT+9에 만료";
    expect(descriptionOf(expiry)).toBe(note);
    expect(
      [...(cells[3]?.children ?? [])]
        .filter(
          (child) =>
            !(child as HTMLElement).hidden &&
            child.getAttribute("aria-hidden") !== "true",
        )
        .map((child) => child.textContent),
    ).toEqual(["초대 중", ""]);
    // A keyboard reaches the icon after the member row's ⋯ and opens the note.
    screen.getByRole("button", { name: "Owner 메뉴" }).focus();
    await user.tab();
    expect(document.activeElement === expiry).toBe(true);
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]')?.textContent,
      ).toBe(note),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]') === null,
      ).toBe(true),
    );
    expect(await itemsOf(user, "late@example.com")).toEqual(["회수"]);
  });

  test("만료된 초대는 만료 표시와 시각만 두고 회수 버튼이 없다", async () => {
    const expired = {
      ...pendingInvite,
      id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b2b",
      email: "old@example.com",
      status: "expired",
    };
    const revoked = {
      ...pendingInvite,
      id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b3c",
      email: "gone@example.com",
      status: "revoked",
      revoked_at: "2026-10-12T00:00:00.000Z",
    };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () =>
        json(200, { items: [pendingInvite, expired, revoked] }),
    });
    await screen.findByRole("button", { name: "late@example.com 메뉴" });
    const row = document.querySelector<HTMLElement>(
      `[data-invite-id="${expired.id}"]`,
    );
    if (!row) throw new Error("no row for the expired invite");
    expect(row.dataset.expired).toBe("true");
    const status = row.querySelector("[data-slot=status-text]");
    expect(status?.textContent).toBe("만료");
    expect(status?.getAttribute("data-status")).toBe("idle");
    // Its one button is the expiry note's: no ⋯ menu.
    const buttons = within(row).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe(
      "old@example.com 초대의 만료 시각",
    );
    expect(descriptionOf(buttons[0] as HTMLElement)).toBe(
      "2026년 10월 18일 09:00:00 GMT+9에 만료됨",
    );
    // Waiting invites keep their ⋯ menu; revoked ones are history.
    const user = await setupUser();
    expect(await itemsOf(user, "late@example.com")).toEqual(["회수"]);
    expect(screen.queryByText("gone@example.com") === null).toBe(true);
  });

  test("검색어는 초대의 이메일에도 맞춰 거른다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": (request) =>
        json(
          200,
          memberPage({
            items: new URL(request.url).searchParams.has("q")
              ? []
              : [owner, teammate],
            next_cursor: null,
          }),
        ),
      "GET /v1/invites": () =>
        json(200, {
          items: [
            pendingInvite,
            {
              ...pendingInvite,
              id: `${pendingInvite.id.slice(0, -1)}0`,
              email: "zed@example.com",
            },
          ],
        }),
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "zed@example.com 메뉴" });
    await user.type(
      screen.getByRole("searchbox", { name: "이름이나 이메일로 찾기" }),
      "LATE",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "zed@example.com 메뉴" }) === null,
      ).toBe(true),
    );
    expect(
      await screen.findByRole("button", { name: "late@example.com 메뉴" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Mate 메뉴" }) === null).toBe(
      true,
    );
    expect(
      api.calls.some(
        (c) =>
          c.path === "/v1/members" &&
          new URLSearchParams(c.search).get("q") === "LATE",
      ),
    ).toBe(true);
  });

  test("구성원 목록을 못 불러오면 초대 버튼 대신 오류와 다시 시도를 보이고, 다시 시도하면 둘 다 돌아온다", async () => {
    const user = await setupUser();
    let fail = true;
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        fail
          ? apiError(500, "INTERNAL", "boom")
          : json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.queryByRole("button", { name: "구성원 초대" }) === null).toBe(
      true,
    );
    fail = false;
    await user.click(retry);
    expect(
      await screen.findByRole("button", { name: "구성원 초대" }),
    ).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "late@example.com 메뉴" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "다시 시도" }) === null).toBe(
      true,
    );
  });

  test("초대만 못 불러오면 구성원은 그대로 보이고, 그 자리에 다시 시도를 둔다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      "GET /v1/invites": () => apiError(500, "INTERNAL", "boom"),
    });
    expect(
      await screen.findByRole("button", { name: "Mate 메뉴" }),
    ).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeDefined();
  });

  test("초대 버튼이 읽는 첫 페이지만 실패하면 표는 그대로 두고 다시 시도로 버튼을 되찾는다", async () => {
    const user = await setupUser();
    let fail = true;
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": (request) =>
        fail && new URL(request.url).searchParams.has("limit")
          ? apiError(500, "INTERNAL", "boom")
          : json(200, memberPage({ items: [owner], next_cursor: null })),
      ...noInvites,
    });
    await screen.findByRole("button", { name: "Owner 메뉴" });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.queryByRole("button", { name: "구성원 초대" }) === null).toBe(
      true,
    );
    fail = false;
    await user.click(retry);
    expect(
      await screen.findByRole("button", { name: "구성원 초대" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "다시 시도" }) === null).toBe(
        true,
      ),
    );
  });

  test("서버가 초대 목록만 거절하면(403) 구성원은 그대로 두고 그 이유를 말한다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      "GET /v1/invites": () =>
        apiError(
          403,
          "FORBIDDEN",
          "This principal does not hold member.manage",
        ),
    });
    await screen.findByRole("button", { name: "Mate 메뉴" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 오너.",
    );
    expect(screen.queryByRole("button", { name: "다시 시도" }) === null).toBe(
      true,
    );
  });

  test("관리 권한이 없으면 팀 탭만 보인다", async () => {
    renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
    });
    expect(await screen.findByText("아직 속한 팀이 없습니다.")).toBeDefined();
    expect(tabsOf()).toEqual([["팀", "/members/teams", "page"]]);
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
  });
});

describe("권한", () => {
  const forbidden = () =>
    apiError(403, "FORBIDDEN", "This principal does not hold member.manage");

  test("관리 권한이 없으면 초대 폼 대신 안내 한 줄만 보이고 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
    });
    expect(
      await screen.findByText(
        "구성원 초대와 관리는 워크스페이스 오너나 어드민이 합니다.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("member.manage");
    expect(api.calls.some((c) => c.path.startsWith("/v1/members"))).toBe(false);
    expect(api.calls.some((c) => c.path === "/v1/invites")).toBe(false);
  });

  test("서버가 거절한 동작(403)은 비활성 버튼과 같은 문구로 보인다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
      [`PATCH /v1/members/${OTHER_ID}`]: forbidden,
    });
    const user = await setupUser();
    await changeRole(user, "Mate", "owner");
    expect(await toastAlert(true)).toBe(
      "구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 오너.",
    );
  });

  test("이 빌드가 모르는 역할이어도 서버가 목록을 주면 관리할 수 있다", async () => {
    const future = { ...me(undefined, "admin"), permissions: me().permissions };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, future),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const button = await screen.findByRole("button", {
      name: "구성원 초대",
    });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

// The page head carries the open tab's one primary action, as on the agents
// page; no section title sits between the tabs and the list.
describe("페이지 머리의 버튼", () => {
  const head = () => {
    const found = document.querySelector<HTMLElement>(
      "[data-slot=page-header]",
    );
    if (!found) throw new Error("no page head");
    return found;
  };

  test("구성원 탭은 머리 끝에 '구성원 초대'를 두고, 탭 아래에 구역 제목이 없다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const invite = await screen.findByRole("button", { name: "구성원 초대" });
    expect(head().contains(invite)).toBe(true);
    expect(screen.getAllByRole("button", { name: "구성원 초대" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: "팀 만들기" }) === null).toBe(
      true,
    );
    await screen.findByRole("table", { name: "구성원 표" });
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  test("팀 탭은 머리 끝에 '팀 만들기'를 두고, 탭 아래에 구역 제목이 없다", async () => {
    renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/teams": () => json(200, { items: [], next_cursor: null }),
    });
    const create = await screen.findByRole("button", { name: "팀 만들기" });
    expect(head().contains(create)).toBe(true);
    expect(screen.getAllByRole("button", { name: "팀 만들기" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: "구성원 초대" }) === null).toBe(
      true,
    );
    // An empty list keeps its box with only the empty state in it.
    const empty = await screen.findByText("아직 팀이 없습니다.");
    expect(empty.closest("[class*='rounded-card']") === null).toBe(false);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });
});

describe("역할로 보기", () => {
  const admin = member({
    user_id: GONE_ID,
    email: "adm@example.com",
    display_name: "Adm",
    role: "admin",
  });
  const adminInvite = {
    ...pendingInvite,
    id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b4d",
    email: "boss@example.com",
    role: "admin",
  };
  const group = () => screen.getByRole("group", { name: "역할로 보기" });
  const segments = () =>
    within(group())
      .getAllByRole("button")
      .map((segment) => segment.textContent);
  const shownRows = () =>
    within(screen.getByRole("table", { name: "구성원 표" }))
      .getAllByRole("button", { name: / 메뉴$/ })
      .map((button) => button.getAttribute("aria-label"));

  test("전체·오너·어드민·멤버마다 개수를 보이고, 초대도 그 역할로 센다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({ items: [owner, admin, teammate], next_cursor: null }),
        ),
      "GET /v1/invites": () =>
        json(200, { items: [pendingInvite, adminInvite] }),
    });
    await screen.findByRole("button", { name: "boss@example.com 메뉴" });
    await waitFor(() =>
      expect(segments()).toEqual(["전체 5", "오너 1", "어드민 2", "멤버 2"]),
    );
  });

  test("역할을 고르면 그 역할의 구성원과 초대만 남고, 검색과 함께 거른다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": (request) => {
        const q = new URL(request.url).searchParams.get("q");
        const items = [owner, admin, teammate].filter(
          (row) => !q || row.email.includes(q),
        );
        return json(200, memberPage({ items, next_cursor: null }));
      },
      "GET /v1/invites": () =>
        json(200, { items: [pendingInvite, adminInvite] }),
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "boss@example.com 메뉴" });
    await user.click(within(group()).getByRole("button", { name: /^어드민/ }));
    await waitFor(() =>
      expect(shownRows()).toEqual(["Adm 메뉴", "boss@example.com 메뉴"]),
    );
    expect(
      within(group())
        .getByRole("button", { name: /^어드민/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // The search narrows the same rows; the counts follow it.
    await user.type(
      screen.getByRole("searchbox", { name: "이름이나 이메일로 찾기" }),
      "boss",
    );
    await waitFor(() => expect(shownRows()).toEqual(["boss@example.com 메뉴"]));
    await waitFor(() =>
      expect(segments()).toEqual(["전체 1", "오너 0", "어드민 1", "멤버 0"]),
    );
    // With a search, an empty result offers to clear the search.
    await user.click(within(group()).getByRole("button", { name: /^오너/ }));
    expect(
      await screen.findByText("검색어에 맞는 구성원이 없습니다"),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: "검색어 지우기" }));
    await waitFor(() => expect(shownRows()).toEqual(["Owner 메뉴"]));
  });

  test("검색 없이 고른 역할에 아무도 없으면 그 역할로 말한다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Mate 메뉴" });
    await user.click(within(group()).getByRole("button", { name: /^어드민/ }));
    expect(
      await screen.findByText("어드민 역할인 구성원이 없습니다."),
    ).toBeDefined();
  });

  test("다음 페이지가 남아 있으면 개수를 세지 않는다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: "c2" })),
      ...noInvites,
    });
    await screen.findByRole("button", { name: "Owner 메뉴" });
    expect(segments()).toEqual(["전체", "오너", "어드민", "멤버"]);
  });

  test("초대를 못 불러오면 개수를 세지 않는다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      "GET /v1/invites": () => apiError(500, "INTERNAL", "boom"),
    });
    await screen.findByRole("button", { name: "Mate 메뉴" });
    await screen.findByRole("button", { name: "다시 시도" });
    expect(segments()).toEqual(["전체", "오너", "어드민", "멤버"]);
  });

  test("초대 목록과 초대 버튼의 첫 페이지가 함께 실패하면 알림 하나의 다시 시도가 둘 다 되찾는다", async () => {
    const user = await setupUser();
    let fail = true;
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": (request) =>
        fail && new URL(request.url).searchParams.has("limit")
          ? apiError(500, "INTERNAL", "boom")
          : json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () =>
        fail ? apiError(500, "INTERNAL", "boom") : json(200, { items: [] }),
    });
    await screen.findByRole("button", { name: "Owner 메뉴" });
    await screen.findByRole("button", { name: "다시 시도" });
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(
      1,
    );
    fail = false;
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(
      await screen.findByRole("button", { name: "구성원 초대" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(segments()).toEqual(["전체 1", "오너 1", "어드민 0", "멤버 0"]),
    );
    expect(screen.queryByRole("button", { name: "다시 시도" }) === null).toBe(
      true,
    );
  });

  test("받은 페이지에 고른 역할이 없어도 더 보기가 남아 다음 페이지에서 찾는다", async () => {
    const people = [
      owner,
      member({
        user_id: GONE_ID,
        email: "owen@example.com",
        display_name: "Owen",
      }),
      teammate,
    ];
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(people, 2),
      ...noInvites,
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Owner 메뉴" });
    await user.click(within(group()).getByRole("button", { name: /^멤버/ }));
    expect(
      await screen.findByText("멤버 역할인 구성원이 없습니다."),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    expect(
      await screen.findByRole("button", { name: "Mate 메뉴" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  for (const others of [0, 1]) {
    test(`역할을 바꿔 행이 필터에서 빠지면 키보드가 고른 역할 버튼으로 간다 (남은 멤버 ${others}명)`, async () => {
      let current = teammate;
      const pat = member({
        user_id: GONE_ID,
        email: "pat@example.com",
        display_name: "Pat",
        role: "member",
      });
      renderAt("/members", {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/members": () =>
          json(
            200,
            memberPage({
              items: [owner, current, ...(others > 0 ? [pat] : [])],
              next_cursor: null,
            }),
          ),
        ...noInvites,
        [`PATCH /v1/members/${OTHER_ID}`]: () => {
          current = { ...teammate, role: "admin" };
          return json(200, current);
        },
      });
      const user = await setupUser();
      await screen.findByRole("button", { name: "Mate 메뉴" });
      const pressed = within(group()).getByRole("button", { name: /^멤버/ });
      await user.click(pressed);
      await changeRole(user, "Mate", "admin");
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Mate 메뉴" })).toBeNull(),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(document.activeElement === pressed).toBe(true),
      );
      expect(
        screen.queryByText("멤버 역할인 구성원이 없습니다.") === null,
      ).toBe(others > 0);
    });
  }

  test("끝까지 읽어도 고른 역할이 없으면 더 보기가 사라진 자리에서 키보드가 목록에 남는다", async () => {
    const people = [
      owner,
      member({
        user_id: GONE_ID,
        email: "owen@example.com",
        display_name: "Owen",
        role: "owner",
      }),
      { ...teammate, role: "owner" as const },
    ];
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(people, 2),
      ...noInvites,
    });
    const user = await setupUser();
    await screen.findByRole("button", { name: "Owner 메뉴" });
    await user.click(within(group()).getByRole("button", { name: /^멤버/ }));
    const more = screen.getByRole("button", { name: "더 보기" });
    const scope = more.parentElement;
    await act(async () => more.focus());
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull(),
    );
    expect(screen.getByText("멤버 역할인 구성원이 없습니다.")).toBeDefined();
    expect(scope !== null && document.activeElement === scope).toBe(true);
  });
});
