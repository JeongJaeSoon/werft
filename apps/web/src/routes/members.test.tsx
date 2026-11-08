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

const ROLE_NAME = { owner: "소유자", admin: "관리자", member: "구성원" };

/** Opens 구성원 편집 for a member and returns the dialog. */
async function openEdit(user: User, name: string) {
  // An inactive row's opener adds "(비활성)" after the name.
  await user.click(
    await screen.findByRole("button", {
      name: (label) =>
        label === `${name} 편집` || label === `${name} 편집 (비활성)`,
    }),
  );
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

/** The focusable box that carries a disabled row button's reason. */
function lockOf(button: HTMLElement): HTMLElement {
  const lock = button.parentElement;
  if (lock?.dataset.slot !== "disabled-reason")
    throw new Error("the button has no reason box");
  expect(lock.tabIndex).toBe(0);
  expect(lock.getAttribute("role")).toBe("group");
  expect(lock.getAttribute("aria-disabled")).toBe("true");
  // The button is described by the same reason as the box around it.
  expect(descriptionOf(button)).toBe(descriptionOf(lock));
  return lock;
}

function descriptionOf(element: HTMLElement) {
  return document.getElementById(element.getAttribute("aria-describedby") ?? "")
    ?.textContent;
}

/** The role badge in a member's row. */
function roleIn(name: string) {
  // Also while a dialog hides the page from the accessibility tree.
  const row = screen
    .getByRole("button", { name: `${name} 편집`, hidden: true })
    .closest("[role=row]");
  return (row as HTMLElement).querySelectorAll("[role=cell]")[1]?.textContent;
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
    const goneRow = screen
      .getByText(/^Gone/)
      .closest("[role=row]") as HTMLElement;
    expect(
      (
        within(goneRow).getByRole("button", {
          name: /다시 활성화/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
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
    ).toEqual(["구성원", "역할", "관리"]);
    const mateRow = within(region)
      .getByRole("button", { name: "Mate 편집" })
      .closest("[role=row]") as HTMLElement;
    expect(mateRow.textContent).toContain("mate@example.com");
    expect(roleIn("Mate")).toBe("구성원");
    expect(roleIn("Owner")).toBe("소유자");
    const goneRow = screen.getByText(/^Gone/).closest("[role=row]");
    expect(goneRow?.getAttribute("data-disabled")).toBe("true");
    // The grey fill is for the eye; the badge names the state in text so
    // colour is not the only signal, and only an inactive row gets either.
    expect(goneRow?.getAttribute("data-inactive")).toBe("true");
    expect(goneRow?.classList.contains("bg-hover")).toBe(true);
    expect(
      within(goneRow as HTMLElement).getByText("비활성", {
        selector: "[data-slot=badge]",
      }),
    ).toBeDefined();
    expect(mateRow.classList.contains("bg-hover")).toBe(false);
    expect(
      within(mateRow).queryByText("비활성", {
        selector: "[data-slot=badge]",
      }),
    ).toBeNull();
    expect(
      within(goneRow as HTMLElement).getByRole("button", {
        name: "Gone 편집 (비활성)",
      }),
    ).toBeDefined();
    expect(mateRow.hasAttribute("data-inactive")).toBe(false);
    expect(
      within(goneRow as HTMLElement).getByRole("button", {
        // Named for its row, as "Disable Mate" is.
        name: "Gone 다시 활성화",
      }),
    ).toBeDefined();
  });

  test("행에는 비활성화만 있고 역할 select는 없다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const region = await screen.findByRole("table", { name: "구성원 표" });
    await screen.findByRole("button", { name: "Mate 편집" });
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
    expect(roleIn("Mate")).toBe("구성원");
    expect(screen.queryByText(/지금 역할은 소유자입니다/)).toBeNull();
    release();
    expect(
      await screen.findByText(
        "Mate의 역할을 바꿨습니다. 지금 역할은 소유자입니다.",
      ),
    ).toBeDefined();
    await waitFor(() => expect(roleIn("Mate")).toBe("소유자"));
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
      "하나뿐인 소유자의 역할은 바꿀 수 없습니다 — 다른 사람을 먼저 소유자로 정하세요.",
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
      "소유자 역할을 주거나 소유자의 역할·접근(비활성화·정지·다시 활성화)을 바꾸는 일은 소유자만 할 수 있습니다 — 소유자에게 요청하세요.",
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
    await user.click(within(edit).getByRole("radio", { name: "소유자" }));
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
      (within(edit).getByRole("radio", { name: "소유자" }) as HTMLButtonElement)
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
      name: "소유자",
    }) as HTMLButtonElement;
    expect(ownerRadio.disabled).toBe(false);
    expect(descriptionOf(ownerRadio)).toBe(
      "워크스페이스 설정과 소유자까지 모두 바꿉니다.",
    );
  });

  test("관리자는 비활성 소유자를 다시 활성화하지 못하고, 이유를 버튼의 툴팁에 둔다", async () => {
    const boss = {
      ...gone,
      display_name: "Boss",
      role: "owner" as const,
      actions: refusedActions("owner_protected"),
    };
    renderAt("/members", {
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
    const row = (await screen.findByText("Boss")).closest(
      "[role=row]",
    ) as HTMLElement;
    const enable = within(row).getByRole("button", {
      name: /^\S+ 다시 활성화$/,
    }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(descriptionOf(lockOf(enable))).toBe(
      "소유자는 관리자가 다시 활성화할 수 없습니다.",
    );
    expect(
      within(enable.closest("[role=cell]") as HTMLElement).getAllByRole(
        "button",
      ),
    ).toHaveLength(1);
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
    await user.click(
      await screen.findByRole("button", { name: /^\S+ 다시 활성화$/ }),
    );
    expect(await toastAlert()).toBe(
      "소유자는 관리자가 다시 활성화할 수 없습니다.",
    );
  });

  test("비활성은 결과를 확인받고, 서버가 답하면 재활성 버튼으로 바뀐다", async () => {
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
    await user.click(
      await screen.findByRole("button", { name: "Mate 비활성화" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "웹 로그인과 개인 API 키가 바로 끊기고",
    );
    await user.click(within(dialog).getByRole("button", { name: "비활성화" }));
    expect(
      await screen.findByText("Mate 계정을 비활성화했습니다."),
    ).toBeDefined();
    const row = (await screen.findByText("Mate")).closest(
      "[role=row]",
    ) as HTMLElement;
    await waitFor(() =>
      expect(
        within(row).getByRole("button", { name: /^\S+ 다시 활성화$/ }),
      ).toBeDefined(),
    );
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
    await user.click(
      await screen.findByRole("button", { name: /^\S+ 다시 활성화$/ }),
    );
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
    const { api } = renderAt("/members/invites", {
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
    await user.click(
      await screen.findByRole("button", { name: "late@example.com 초대 회수" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("보낸 링크로는 더 가입할 수 없습니다");
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "회수" }));
    expect(
      await screen.findByText("late@example.com 초대를 회수했습니다."),
    ).toBeDefined();
    expect(await screen.findByText("남아 있는 초대가 없습니다.")).toBeDefined();
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  test("초대 회수를 취소하면 아무것도 보내지 않는다", async () => {
    const { api } = renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "late@example.com 초대 회수" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("late@example.com")).toBeDefined();
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
    await user.click(within(edit).getByRole("radio", { name: "관리자" }));
    await user.click(within(edit).getByRole("radio", { name: "소유자" }));
    expect(calls).toEqual([]);
    // One dialog: it says the resulting role before its button sends it.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(edit.textContent).toContain("바꾸면 Mate의 역할은 소유자입니다.");
    expect(edit.textContent).toContain("소유자는 워크스페이스 설정과");
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
    expect(roleIn("Mate")).toBe("구성원");
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

  test("편집을 닫으면 키보드가 그 이름 버튼으로 돌아온다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const name = await screen.findByRole("button", { name: "Mate 편집" });
    await openEdit(user, "Mate");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    const edit = await openEdit(user, "Mate");
    await user.click(within(edit).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
  });

  test("역할을 바꾼 뒤에도 키보드가 그 이름 버튼으로 돌아온다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const name = await screen.findByRole("button", { name: "Mate 편집" });
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
    const reasonOf = async (name: string) => {
      const button = (await screen.findByRole("button", {
        name: `${name} 비활성화`,
      })) as HTMLButtonElement;
      const lock = button.closest<HTMLElement>("[data-slot=disabled-reason]");
      return {
        disabled: button.disabled,
        reason: lock ? descriptionOf(lock) : undefined,
      };
    };
    expect(await reasonOf("Owner")).toEqual({
      disabled: true,
      reason: "자기 자신은 비활성화할 수 없습니다.",
    });
    expect(await reasonOf("Boss")).toEqual({
      disabled: true,
      reason: "소유자는 관리자가 비활성화할 수 없습니다.",
    });
    expect(await reasonOf("Mate")).toEqual({
      disabled: false,
      reason: undefined,
    });
  });

  test("본인 행은 이름 옆에 '나'를 달고, 관리 열에 버튼 하나만 둔다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "owner")),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    const buttonOf = async (name: string) =>
      (await screen.findByRole("button", {
        name: `${name} 비활성화`,
      })) as HTMLButtonElement;
    const rowOf = (button: HTMLElement) =>
      button.closest("[role=row]") as HTMLElement;
    const button = await buttonOf("Owner");
    expect(within(rowOf(button)).getByText("나")).toBeDefined();
    expect(within(rowOf(await buttonOf("Mate"))).queryByText("나")).toBeNull();
    // The row's hover and pointer say it opens; no "›" beside the name.
    expect(rowOf(button).textContent).not.toContain("›");
    // Only the disable button: no (i) beside it to push it out of line.
    const cell = button.closest("[role=cell]") as HTMLElement;
    expect(within(cell).getAllByRole("button")).toHaveLength(1);
    expect(cell.querySelector("svg")).toBeNull();
    expect(button.disabled).toBe(true);
    expect(descriptionOf(lockOf(button))).toBe(
      "자기 자신은 비활성화할 수 없습니다.",
    );
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
                ...gone,
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

  test("역할도 같은 규칙으로 편집에서 막고, 비활성화 이유는 버튼 위 툴팁으로 연다", async () => {
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
      reason: "소유자의 역할은 관리자가 바꿀 수 없습니다.",
    });
    expect((await roleRule(user, "Mate")).disabled).toBe(false);

    // Nothing under the control: the reason opens above it from the keyboard.
    const lock = lockOf(screen.getByRole("button", { name: "Boss 비활성화" }));
    const note = () => document.querySelector('[data-slot="popover-content"]');
    expect(note()).toBeNull();
    await act(async () => lock.focus());
    await waitFor(() =>
      expect(note()?.textContent).toBe(
        "소유자는 관리자가 비활성화할 수 없습니다.",
      ),
    );
    expect(note()?.getAttribute("data-side")).toBe("top");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(note()).toBeNull());
    expect(document.activeElement === lock).toBe(true);
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
    .getAllByRole("button", { name: / 편집$/ })
    .map((button) => button.getAttribute("aria-label")?.replace(/ 편집$/, ""));
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
    await screen.findByRole("button", { name: "Person 1 편집" });
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
    await screen.findByRole("button", { name: "Person 3 편집" });
    expect(rowNames()).toEqual([
      "Person 0",
      "Person 1",
      "Person 2",
      "Person 3",
    ]);
    expect(more.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement === more).toBe(true);

    await user.keyboard("{Enter}");
    const first = await screen.findByRole("button", { name: "Person 4 편집" });
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
    // The button went with the last page; the keyboard lands on its row.
    await waitFor(() => expect(document.activeElement === first).toBe(true));
    // One read a page, each from where the last one stopped.
    expect(screenReads(api.calls)).toEqual(["", "?cursor=2", "?cursor=4"]);
  });

  test("구성원을 바꾼 뒤 받은 페이지를 다시 읽는 동안에는 더 보기를 막는다", async () => {
    let hold = false;
    let release: () => void = () => {};
    const rows = [...crowd];
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": pagedMembers(rows, 2, () =>
        hold
          ? new Promise((resolve) => {
              release = () => resolve(undefined);
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
    await user.click(
      await screen.findByRole("button", { name: "Person 0 비활성화" }),
    );
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
      expect(
        screen
          .getByRole("button", { name: "Person 0 편집 (비활성)" })
          .closest("[role=row]")
          ?.getAttribute("data-disabled"),
      ).toBe("true"),
    );
    expect(more.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Person 2 편집" })).toBeNull();
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
    await user.click(
      await screen.findByRole("button", { name: "Person 0 비활성화" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "비활성화" }));
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-variant")).toBe("red");
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();

    failing = false;
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("button", { name: "더 보기" });
    expect(
      screen
        .getByRole("button", { name: "Person 0 편집 (비활성)" })
        .closest("[role=row]")
        ?.getAttribute("data-disabled"),
    ).toBe("true");
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
    await screen.findByRole("button", { name: "Owner 편집" });
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
    await screen.findByRole("button", { name: "Person 3 편집" });
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
    await screen.findByRole("button", { name: "Person 3 편집" });
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
    await screen.findByRole("button", { name: "Owner 편집" });
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "Gone 편집 (비활성)" });

    const box = screen.getByRole("searchbox", {
      name: "이름이나 이메일로 찾기",
    });
    await user.type(box, "  PERSON ");
    await waitFor(() => expect(rowNames()).toEqual(["Person 0", "Person 1"]));
    // The loaded rows are not filtered in the browser: the server answers.
    expect(screenReads(api.calls)).toEqual(["", "?cursor=2", "?q=PERSON"]);
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "Person 3 편집" });
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
  const disableOf = async (name: string) => {
    const button = (await screen.findByRole("button", {
      name: `${name} 비활성화`,
    })) as HTMLButtonElement;
    const lock = button.closest<HTMLElement>("[data-slot=disabled-reason]");
    return {
      disabled: button.disabled,
      reason: lock ? descriptionOf(lock) : undefined,
    };
  };

  test("화면은 마지막 소유자를 스스로 세지 않는다: 다음 페이지 전에도 뒤에도 서버가 연 행은 열려 있다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      // The viewer, the other owner, is on the second page.
      "GET /v1/members": pagedMembers([boss, teammate, owner], 2),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await disableOf("Boss")).toEqual({
      disabled: false,
      reason: undefined,
    });
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("button", { name: "Owner 편집" });
    expect(await disableOf("Boss")).toEqual({
      disabled: false,
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
    await screen.findByRole("button", { name: "Owner 편집" });
    await user.type(screen.getByRole("searchbox"), "boss");
    await waitFor(() => expect(rowNames()).toEqual(["Boss"]));
    expect(await disableOf("Boss")).toEqual({
      disabled: false,
      reason: undefined,
    });
  });

  test("계정이 정지된 행은 서버가 준 이유로 다시 활성화와 역할 편집을 막는다", async () => {
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
    const enable = (await screen.findByRole("button", {
      name: /^\S+ 다시 활성화$/,
    })) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(descriptionOf(lockOf(enable))).toBe(
      "계정이 정지된 사람은 여기서 다시 활성화할 수 없습니다 — 계정 정지를 먼저 풀어야 합니다.",
    );
    expect(await roleRule(user, "Gone")).toEqual({
      disabled: true,
      reason:
        "계정이 정지된 사람의 역할은 바꿀 수 없습니다 — 계정 정지를 먼저 풀어야 합니다.",
    });
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
    expect(radio("소유자").disabled).toBe(true);
    expect(descriptionOf(radio("소유자"))).toBe(
      "소유자 역할은 소유자만 줄 수 있습니다.",
    );
    expect(descriptionOf(within(edit).getByRole("radiogroup"))).toBe(
      "소유자 역할은 소유자만 줄 수 있습니다.",
    );
    expect(radio("관리자").disabled).toBe(false);
    expect(radio("구성원").disabled).toBe(false);
    // Arrow keys skip the withheld radio.
    radio("구성원").focus();
    await user.keyboard("{ArrowDown>}");
    await waitFor(() =>
      expect(document.activeElement === radio("관리자")).toBe(true),
    );
    await user.keyboard("{/ArrowDown}{ArrowDown>}");
    await waitFor(() =>
      expect(document.activeElement === radio("구성원")).toBe(true),
    );
    await user.keyboard("{/ArrowDown}");
    await user.click(radio("구성원"));
    const save = within(edit).getByRole("button", {
      name: "역할 바꾸기",
    }) as HTMLButtonElement;
    // The role it already has saves nothing.
    expect(save.disabled).toBe(true);
    await user.click(radio("관리자"));
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
    await user.click(within(edit).getByRole("radio", { name: "관리자" }));
    const save = within(edit).getByRole("button", {
      name: "역할 바꾸기",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // Another owner's change since: the server now refuses this row.
    mate = { ...teammate, actions: refusedActions("owner_protected") };
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(descriptionOf(within(edit).getByRole("radiogroup"))).toBe(
      "소유자의 역할은 관리자가 바꿀 수 없습니다.",
    );
  });

  test("관리자가 보는 비활성 구성원은 소유자 선택지의 이유가 아니라 비활성 이유로 막힌다", async () => {
    const off = { allowed: false, reason: "member_disabled" } as const;
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [
              { ...owner, role: "admin" },
              {
                ...gone,
                actions: {
                  ...openActions(gone),
                  change_role: {
                    owner: { allowed: false, reason: "owner_protected" },
                    admin: off,
                    member: off,
                  },
                },
              },
            ],
            next_cursor: null,
          }),
        ),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await roleRule(user, "Gone")).toEqual({
      disabled: true,
      reason: "비활성 구성원의 역할은 다시 활성화한 뒤 바꿀 수 있습니다.",
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
          .getByRole("radio", { name: "관리자" })
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
    await screen.findByRole("button", { name: "Mate 편집" });
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
describe("구성원 · 팀 · 초대 탭", () => {
  const tabsOf = () =>
    within(screen.getByRole("navigation", { name: "구성원 보기" }))
      .getAllByRole("link")
      .map((link) => [
        link.textContent,
        link.getAttribute("href"),
        link.getAttribute("aria-current"),
      ]);

  test("관리하는 사람은 세 탭을 보고, 지금 탭 하나만 현재다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, teammate], next_cursor: null })),
      ...noInvites,
    });
    await screen.findByRole("button", { name: "Mate 편집" });
    expect(tabsOf()).toEqual([
      ["구성원", "/members", "page"],
      ["팀", "/members/teams", null],
      ["초대", "/members/invites", null],
    ]);
    // The head's primary action follows the tab.
    expect(screen.getByRole("button", { name: "구성원 초대" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "팀 만들기" })).toBeNull();
    // Pending invites have their own tab now.
    expect(screen.queryByText("대기 중인 초대")).toBeNull();
  });

  test("초대 탭은 대기 중인 초대를 보이고 초대 버튼을 둔다", async () => {
    renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    expect(await screen.findByText("late@example.com")).toBeDefined();
    expect(tabsOf()[2]).toEqual(["초대", "/members/invites", "page"]);
    expect(screen.getByRole("button", { name: "구성원 초대" })).toBeDefined();
    expect(screen.queryByRole("table", { name: "구성원 표" })).toBeNull();
    // Same shape as the 구성원 table: header row, then one row per invite.
    const table = screen.getByRole("table", { name: "초대 표" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["초대", "역할", "관리"]);
    expect(within(table).getAllByRole("row")).toHaveLength(2);
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
    renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () =>
        json(200, { items: [pendingInvite, expired, revoked] }),
    });
    const row = (
      await screen.findByText("old@example.com")
    ).closest<HTMLElement>("[data-slot=grid-table-row]");
    if (!row) throw new Error("no row for the expired invite");
    expect(row.dataset.expired).toBe("true");
    expect(within(row).getByText("만료")).toBeDefined();
    expect(row.textContent).toContain("에 만료됨");
    expect(within(row).queryByRole("button")).toBeNull();
    // Waiting invites keep their one neutral button; revoked ones are history.
    expect(
      screen.getByRole("button", { name: "late@example.com 초대 회수" }),
    ).toBeDefined();
    expect(screen.queryByText("gone@example.com")).toBeNull();
  });

  describe("초대 검색", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...pendingInvite,
        id: `9e8d7c6b-5a49-4382-9170-6f5e4d3c${String(index).padStart(4, "0")}`,
        email: `person${index}@example.com`,
      }));
    const open = (items: readonly unknown[]) =>
      renderAt("/members/invites", {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/members": () =>
          json(200, memberPage({ items: [owner], next_cursor: null })),
        "GET /v1/invites": () => json(200, { items }),
      });

    test("초대가 열 개까지는 검색 칸이 없다", async () => {
      open(many(10));
      expect(await screen.findByText("person0@example.com")).toBeDefined();
      expect(screen.queryByRole("searchbox")).toBeNull();
    });

    test("열한 개부터 검색 칸이 생기고, 검색은 이메일로 거른다", async () => {
      open(many(11));
      const user = await setupUser();
      const box = await screen.findByRole("searchbox", {
        name: "이메일로 찾기",
      });
      await user.type(box, "person10");
      await waitFor(() =>
        expect(screen.queryByText("person0@example.com")).toBeNull(),
      );
      expect(screen.getByText("person10@example.com")).toBeDefined();
    });

    test("목록이 열 개 아래로 줄어도 한 번 보인 검색 칸은 남고 포커스를 받는다", async () => {
      let items = many(11);
      const { services } = renderAt("/members/invites", {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/members": () =>
          json(200, memberPage({ items: [owner], next_cursor: null })),
        "GET /v1/invites": () => json(200, { items }),
      });
      const user = await setupUser();
      const box = await screen.findByRole("searchbox", {
        name: "이메일로 찾기",
      });
      await user.type(box, "nobody");
      await screen.findByRole("button", { name: "검색어 지우기" });
      items = many(10);
      await act(() => services.queryClient.refetchQueries());
      await user.click(screen.getByRole("button", { name: "검색어 지우기" }));
      await waitFor(() =>
        expect(screen.getByText("person0@example.com")).toBeDefined(),
      );
      const still = screen.getByRole("searchbox", { name: "이메일로 찾기" });
      expect(still === box).toBe(true);
      expect(document.activeElement === box).toBe(true);
    });

    test("맞는 초대가 없으면 안내와 지우기를 보이고, 지우면 검색 칸으로 돌아온다", async () => {
      open(many(11));
      const user = await setupUser();
      const box = await screen.findByRole("searchbox", {
        name: "이메일로 찾기",
      });
      await user.type(box, "nobody");
      await user.click(
        await screen.findByRole("button", { name: "검색어 지우기" }),
      );
      await waitFor(() =>
        expect(screen.getByText("person0@example.com")).toBeDefined(),
      );
      expect(document.activeElement === box).toBe(true);
      expect((box as HTMLInputElement).value).toBe("");
    });
  });

  test("초대 탭에서 구성원 목록을 못 불러오면 초대 버튼 대신 오류와 다시 시도를 보인다", async () => {
    const user = await setupUser();
    let fail = true;
    renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        fail
          ? apiError(500, "INTERNAL", "boom")
          : json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    expect(await screen.findByText("late@example.com")).toBeDefined();
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
    fail = false;
    await user.click(retry);
    expect(
      await screen.findByRole("button", { name: "구성원 초대" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
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
        "구성원 초대와 관리는 워크스페이스 소유자나 관리자가 합니다.",
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
      "구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
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
