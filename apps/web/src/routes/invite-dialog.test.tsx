import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import type { UserEvent } from "@testing-library/user-event";
import type { MemberView } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberPage,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const TOKEN = "k".repeat(43);
const owner: MemberView = {
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
  disabled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
};
const created = () =>
  json(201, {
    invite_id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
    invite_token: TOKEN,
    expires_at: "2026-10-18T00:00:00.000Z",
  });

// Each answer a token of its own, as the server gives.
const createdEach = () => {
  let n = 0;
  return () =>
    json(201, {
      invite_id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
      invite_token: `${"k".repeat(42)}${n++}`,
      expires_at: "2026-10-18T00:00:00.000Z",
    });
};

function renderMembers(invite: () => Response = created) {
  return renderAt("/members/invites", {
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/members": () =>
      json(200, memberPage({ items: [owner], next_cursor: null })),
    "GET /v1/invites": () => json(200, { items: [] }),
    "POST /v1/invites": invite,
  });
}

async function open() {
  const user = await setupUser();
  await user.click(await screen.findByRole("button", { name: "구성원 초대" }));
  const dialog = await screen.findByRole("dialog");
  return { user, dialog };
}

const currentStep = (dialog: HTMLElement) =>
  dialog.querySelector('[aria-current="step"]')?.textContent;

async function toLink() {
  const opened = await open();
  await opened.user.type(
    within(opened.dialog).getByLabelText("이메일"),
    "new@example.com",
  );
  await opened.user.click(
    within(opened.dialog).getByRole("button", { name: "초대 링크 만들기" }),
  );
  await within(opened.dialog).findByLabelText("초대 링크");
  return opened;
}

async function copy(user: UserEvent, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole("button", { name: "링크 복사" }));
  await within(dialog).findByText("초대 링크를 복사했습니다.");
}

const LEAVE = "링크를 복사하지 않고 나갈까요?";

const invitePosts = (api: {
  calls: readonly { path: string; method: string; body?: unknown }[];
}) => api.calls.filter((c) => c.path === "/v1/invites" && c.method === "POST");

describe("초대 보내기 대화상자", () => {
  test("받는 사람 단계에서 링크 단계로 넘어가고, 마지막 단계에 링크와 만료 시각이 보인다", async () => {
    const { api, history } = renderMembers();
    const { user, dialog } = await open();
    expect(currentStep(dialog)).toContain("받는 사람");
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.selectOptions(within(dialog).getByLabelText("역할"), "admin");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    const link = (await within(dialog).findByLabelText(
      "초대 링크",
    )) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/invite/${TOKEN}`);
    expect(currentStep(dialog)).toContain("초대 링크");
    expect(dialog.textContent).toContain("한 번만 보입니다");
    expect(history.location.search).toContain("invite.step=link");
    expect(invitePosts(api)[0]?.body).toEqual({
      email: "new@example.com",
      role: "admin",
    });
  });

  test("관리자에게 역할의 소유자 선택지는 비활성이고, 칸 아래에 이유를 둔다", async () => {
    const { api } = renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [{ ...owner, role: "admin" }],
            next_cursor: null,
            assignable_roles: ["admin", "member"],
          }),
        ),
      "GET /v1/invites": () => json(200, { items: [] }),
      "POST /v1/invites": created,
    });
    const { dialog } = await open();
    const select = within(dialog).getByLabelText("역할") as HTMLSelectElement;
    expect(
      [...select.options].map((option) => [option.value, option.disabled]),
    ).toEqual([
      ["owner", true],
      ["admin", false],
      ["member", false],
    ]);
    expect(
      document.getElementById(select.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("소유자 역할은 소유자만 줄 수 있습니다.");
    expect(invitePosts(api)).toHaveLength(0);
  });

  test("소유자를 고른 뒤 관리자로 내려가면 초대 링크 만들기가 막힌다", async () => {
    let role: "owner" | "admin" = "owner";
    const { api, services } = renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me(undefined, role)),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [owner],
            next_cursor: null,
            assignable_roles:
              role === "owner"
                ? ["owner", "admin", "member"]
                : ["admin", "member"],
          }),
        ),
      "GET /v1/invites": () => json(200, { items: [] }),
      "POST /v1/invites": created,
    });
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.selectOptions(within(dialog).getByLabelText("역할"), "owner");
    const submit = within(dialog).getByRole("button", {
      name: "초대 링크 만들기",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    role = "admin";
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(invitePosts(api)).toHaveLength(0);
  });

  test("역할 선택지는 로그인 역할이 아니라 목록이 준 assignable_roles를 따른다", async () => {
    const { api } = renderAt("/members/invites", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [owner],
            next_cursor: null,
            assignable_roles: ["member"],
          }),
        ),
      "GET /v1/invites": () => json(200, { items: [] }),
      "POST /v1/invites": created,
    });
    const { dialog } = await open();
    const select = within(dialog).getByLabelText("역할") as HTMLSelectElement;
    expect(
      [...select.options].map((option) => [option.value, option.disabled]),
    ).toEqual([
      ["owner", true],
      ["admin", true],
      ["member", false],
    ]);
    expect(invitePosts(api)).toHaveLength(0);
  });

  test("assignable_roles가 없는 이전 API면 모든 역할을 열어 두고 서버의 거절에 맡긴다", async () => {
    const { items } = memberPage({ items: [owner], next_cursor: null });
    renderAt(
      "/members/invites",
      {
        "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
        // What the API answered before the field existed.
        "GET /v1/members": () => json(200, { items, next_cursor: null }),
        "GET /v1/invites": () => json(200, { items: [] }),
        "POST /v1/invites": created,
      },
      "ko",
      "warn",
    );
    const { dialog } = await open();
    const select = within(dialog).getByLabelText("역할") as HTMLSelectElement;
    expect([...select.options].every((option) => !option.disabled)).toBe(true);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "초대 링크 만들기",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test("소유자에게는 역할 선택지가 모두 열려 있고 이유 줄이 없다", async () => {
    renderMembers();
    const { dialog } = await open();
    const select = within(dialog).getByLabelText("역할") as HTMLSelectElement;
    expect([...select.options].every((option) => !option.disabled)).toBe(true);
    expect(select.hasAttribute("aria-describedby")).toBe(false);
  });

  test("링크의 token은 단계 기록(history.state)에 남지 않는다", async () => {
    const { history } = renderMembers();
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    expect(JSON.stringify(history.location.state)).toContain("expires");
    expect(JSON.stringify(history.location.state)).not.toContain(TOKEN);
  });

  test("닫았다 다시 열면 첫 단계의 빈 칸에서 시작한다", async () => {
    renderMembers();
    const first = await open();
    await first.user.type(
      within(first.dialog).getByLabelText("이메일"),
      "new@example.com",
    );
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(first.dialog).findByLabelText("초대 링크");
    await copy(first.user, first.dialog);
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "닫기" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const again = await open();
    const email = within(again.dialog).getByLabelText(
      "이메일",
    ) as HTMLInputElement;
    expect(email.value).toBe("");
    expect(within(again.dialog).queryByLabelText("초대 링크")).toBeNull();
    expect(currentStep(again.dialog)).toContain("받는 사람");
  });

  test("링크 단계가 열리면 링크 칸에 포커스가 가고, 닫으면 여는 버튼으로 돌아온다", async () => {
    renderMembers();
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    const link = await within(dialog).findByLabelText("초대 링크");
    await waitFor(() => expect(document.activeElement).toBe(link));
    await copy(user, dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "구성원 초대" }),
    );
  });

  test("닫은 뒤에 도착한 응답은 다시 연 흐름을 옮기지 않는다", async () => {
    let answer: (response: Response) => void = () => {};
    const { history } = renderMembers(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }) as unknown as Response,
    );
    const first = await open();
    await first.user.type(
      within(first.dialog).getByLabelText("이메일"),
      "slow@example.com",
    );
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "취소" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const again = await open();
    answer(created());
    // The pending list refetches once the late answer lands.
    expect(await screen.findByText("남아 있는 초대가 없습니다.")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(currentStep(again.dialog)).toContain("받는 사람");
    expect(within(again.dialog).queryByLabelText("초대 링크")).toBeNull();
    expect(
      (history.location.state as unknown as Record<string, unknown>)[
        "invite.histories"
      ],
    ).toEqual([{ step: "details", context: {} }]);
  });

  test("다시 연 뒤 앞으로 가기로 지난 링크 단계에 닿으면 첫 단계부터 다시 한다", async () => {
    const { history } = renderMembers();
    const first = await open();
    await first.user.type(
      within(first.dialog).getByLabelText("이메일"),
      "new@example.com",
    );
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(first.dialog).findByLabelText("초대 링크");
    history.back();
    await waitFor(() =>
      expect(currentStep(first.dialog)).toContain("받는 사람"),
    );
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "취소" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const again = await open();
    await waitFor(() =>
      expect(history.location.search).toContain("invite.step=details"),
    );
    history.forward();
    await waitFor(() =>
      expect(history.location.search).toContain("invite.step=details"),
    );
    expect(currentStep(again.dialog)).toContain("받는 사람");
    expect(within(again.dialog).getByLabelText("이메일")).toBeDefined();
  });

  test("다른 사람 초대는 첫 단계로 돌아가 앞 링크를 지운다", async () => {
    renderMembers();
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "a@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    await copy(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "다른 사람 초대" }),
    );
    const email = (await within(dialog).findByLabelText(
      "이메일",
    )) as HTMLInputElement;
    expect(email.value).toBe("");
    expect(within(dialog).queryByLabelText("초대 링크")).toBeNull();
  });
});

describe("복사하지 않은 링크를 두고 나가기", () => {
  test("닫기는 확인을 묻고, 돌아가면 링크가 그대로이며 나가면 여는 버튼으로 돌아온다", async () => {
    renderMembers();
    const { user, dialog } = await toLink();
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    const confirm = await screen.findByRole("dialog", { name: LEAVE });
    expect(confirm.textContent).toContain("다시 볼 수 없습니다");
    await user.click(
      within(confirm).getByRole("button", { name: "링크로 돌아가기" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: LEAVE })).toBeNull(),
    );
    expect(
      (within(dialog).getByLabelText("초대 링크") as HTMLInputElement).value,
    ).toContain(TOKEN);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "닫기" }),
    );

    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    const leave = await screen.findByRole("dialog", { name: LEAVE });
    // Losing the link for good is a danger confirmation, like a revoke.
    expect(leave.getAttribute("data-tone")).toBe("danger");
    await user.click(
      within(leave).getByRole("button", { name: "복사하지 않고 나가기" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "구성원 초대" }),
    );
  });

  test("Escape는 확인을 묻고, 확인 위의 Escape는 확인만 닫는다", async () => {
    renderMembers();
    const { user, dialog } = await toLink();
    await user.keyboard("{Escape}");
    const confirm = await screen.findByRole("dialog", { name: LEAVE });
    await waitFor(() =>
      expect(confirm.contains(document.activeElement)).toBe(true),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: LEAVE })).toBeNull(),
    );
    expect(within(dialog).getByLabelText("초대 링크")).toBeDefined();
    expect(screen.getByRole("dialog", { name: "초대" })).toBe(dialog);
  });

  test("바깥 클릭은 확인을 묻는다", async () => {
    renderMembers();
    const { user } = await toLink();
    const overlay = document.querySelector(
      '[data-slot="dialog-overlay"]',
    ) as HTMLElement;
    await user.pointer({ keys: "[MouseLeft]", target: overlay });
    expect(await screen.findByRole("dialog", { name: LEAVE })).toBeDefined();
  });

  test("다른 사람 초대는 확인을 묻고, 나가면 첫 단계의 빈 칸이 된다", async () => {
    renderMembers();
    const { user, dialog } = await toLink();
    await user.click(
      within(dialog).getByRole("button", { name: "다른 사람 초대" }),
    );
    await user.click(
      within(await screen.findByRole("dialog", { name: LEAVE })).getByRole(
        "button",
        { name: "복사하지 않고 나가기" },
      ),
    );
    const email = (await within(dialog).findByLabelText(
      "이메일",
    )) as HTMLInputElement;
    expect(email.value).toBe("");
    expect(within(dialog).queryByLabelText("초대 링크")).toBeNull();
    // The button that opened the confirmation is gone; the keyboard lands on
    // the field the next invite starts from instead of <body>.
    await waitFor(() => expect(document.activeElement).toBe(email));
  });

  test("앞 링크를 복사한 뒤 뒤로 가서 새로 만든 링크는 다시 묻는다", async () => {
    const { history } = renderMembers(createdEach());
    const { user, dialog } = await toLink();
    await copy(user, dialog);
    history.back();
    const email = await within(dialog).findByLabelText("이메일");
    await user.clear(email);
    await user.type(email, "other@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await waitFor(() => expect(currentStep(dialog)).toContain("초대 링크"));
    expect(within(dialog).queryByText("초대 링크를 복사했습니다.")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(await screen.findByRole("dialog", { name: LEAVE })).toBeDefined();
  });

  test("앞 링크의 복사가 새 링크를 만든 뒤에 끝나도 새 링크는 다시 묻는다", async () => {
    let finish: () => void = () => {};
    const { history } = renderMembers(createdEach());
    // After setupUser, which installs a clipboard of its own.
    const { user, dialog } = await toLink();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
    });
    try {
      await user.click(
        within(dialog).getByRole("button", { name: "링크 복사" }),
      );
      history.back();
      const email = await within(dialog).findByLabelText("이메일");
      await user.type(email, "other@example.com");
      await user.click(
        within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
      );
      await waitFor(() => expect(currentStep(dialog)).toContain("초대 링크"));
      finish();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await user.click(within(dialog).getByRole("button", { name: "닫기" }));
      expect(await screen.findByRole("dialog", { name: LEAVE })).toBeDefined();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("새 링크의 복사가 먼저 끝나고 앞 링크의 복사가 늦게 끝나도 새 링크는 복사한 것이다", async () => {
    const pending: (() => void)[] = [];
    const { history } = renderMembers(createdEach());
    const { user, dialog } = await toLink();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            pending.push(resolve);
          }),
      },
    });
    try {
      const copyButton = () =>
        within(dialog).getByRole("button", { name: "링크 복사" });
      await user.click(copyButton());
      history.back();
      const email = await within(dialog).findByLabelText("이메일");
      await user.type(email, "other@example.com");
      await user.click(
        within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
      );
      await waitFor(() => expect(currentStep(dialog)).toContain("초대 링크"));
      await user.click(copyButton());
      const [first, second] = pending;
      second?.();
      await within(dialog).findByText("초대 링크를 복사했습니다.");
      first?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await user.click(within(dialog).getByRole("button", { name: "닫기" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("복사한 뒤에는 묻지 않고 닫힌다", async () => {
    renderMembers();
    const { user, dialog } = await toLink();
    await copy(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("복사가 실패했으면 여전히 묻는다", async () => {
    renderMembers();
    const { user, dialog } = await toLink();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    try {
      await user.click(
        within(dialog).getByRole("button", { name: "링크 복사" }),
      );
      await within(dialog).findByRole("alert");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(await screen.findByRole("dialog", { name: LEAVE })).toBeDefined();
  });
});

describe("mutation 캐시", () => {
  const cached = (services: { queryClient: QueryClient }) =>
    services.queryClient
      .getMutationCache()
      .getAll()
      .some((m) => JSON.stringify(m.state.data ?? null).includes(TOKEN));

  test("닫은 뒤에는 token이 남지 않는다", async () => {
    const { services } = renderMembers();
    const { user, dialog } = await toLink();
    expect(cached(services)).toBe(true);
    await copy(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(cached(services)).toBe(false));
  });

  test("다른 사람 초대로 첫 단계에 돌아가면 token이 남지 않는다", async () => {
    const { services } = renderMembers();
    const { user, dialog } = await toLink();
    await copy(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "다른 사람 초대" }),
    );
    await within(dialog).findByLabelText("이메일");
    await waitFor(() => expect(cached(services)).toBe(false));
  });

  test("닫은 뒤에 도착한 응답의 token도 남지 않는다", async () => {
    let answer: (response: Response) => void = () => {};
    const { services } = renderMembers(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }) as unknown as Response,
    );
    const { user, dialog } = await open();
    await user.type(
      within(dialog).getByLabelText("이메일"),
      "slow@example.com",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    answer(created());
    expect(await screen.findByText("남아 있는 초대가 없습니다.")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cached(services)).toBe(false);
  });
});

describe("입력 검증(W24 규약)", () => {
  test("빈 이메일과 이메일 아닌 값은 서버에 묻지 않고 칸에 이유를 붙인다", async () => {
    const { api } = renderMembers();
    const { user, dialog } = await open();
    const email = within(dialog).getByLabelText("이메일");
    const submit = within(dialog).getByRole("button", {
      name: "초대 링크 만들기",
    });
    const reason = () =>
      (email.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");

    // The contract's email check has no minimum, so blank reads as a format.
    for (const value of ["   ", "not-an-email"]) {
      await user.clear(email);
      await user.type(email, value);
      await user.click(submit);
      await waitFor(() =>
        expect(reason()).toContain("이메일 주소 형식이 아닙니다."),
      );
      expect(email.getAttribute("aria-invalid")).toBe("true");
    }
    expect(invitePosts(api)).toHaveLength(0);
  });

  test("앞뒤 공백은 지우고 보낸다", async () => {
    const { api } = renderMembers();
    const { user, dialog } = await open();
    await user.type(
      within(dialog).getByLabelText("이메일"),
      "  new@example.com  ",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    expect(invitePosts(api)[0]?.body).toEqual({
      email: "new@example.com",
      role: "member",
    });
  });

  test("서버 400은 서버 문구 대신 폼 위 한 줄로 보이고 첫 단계에 남는다", async () => {
    renderMembers(() =>
      apiError(400, "BAD_REQUEST", "body.email: Invalid email address"),
    );
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    const alerts = await within(dialog).findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).not.toContain("body.email");
    const email = within(dialog).getByLabelText("이메일");
    // Above the form's fields, not under them.
    expect(
      (alerts[0] as HTMLElement).compareDocumentPosition(email) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("서버가 거절한 초대(403)는 비활성 버튼과 같은 문구로 보인다", async () => {
    renderMembers(() =>
      apiError(403, "FORBIDDEN", "This principal does not hold member.manage"),
    );
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });
});

describe("invite token", () => {
  const logged: string[] = [];
  const originals = { ...console };
  beforeEach(() => {
    logged.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      console[level] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
  });
  afterEach(() => {
    Object.assign(console, originals);
  });

  test("링크 칸 밖의 화면 문구와 로그에 나오지 않는다", async () => {
    renderMembers();
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
