import { describe, expect, test } from "bun:test";
import { focusManager } from "@tanstack/react-query";
import {
  type LoginSettingsResponse,
  loginSettingsResponseSchema,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const LIST_PAGE = "/settings/workspace/login";
const API = "/v1/login-settings";
const ME = me().user?.id as string;
const OTHER = "019a0000-0000-7000-8000-0000000000b2";
const THIRD = "019a0000-0000-7000-8000-0000000000b3";

const owner = (user_id: string, display_name: string) => ({
  user_id,
  email: `${display_name.toLowerCase()}@example.com`,
  display_name,
});

/**
 * Passwords open, the signed-in owner named, one provider on, and none of
 * its accounts the signed-in owner's.
 */
const read = (
  rest: Partial<LoginSettingsResponse["settings"]> = {},
  candidates = [owner(ME, "Me"), owner(OTHER, "Dana")],
  linked = false,
): LoginSettingsResponse => ({
  settings: {
    password_login: "on",
    emergency_admin: { ...owner(ME, "Me"), eligible: true },
    enabled_providers: 1,
    ...rest,
  },
  emergency_admin_candidates: candidates,
  caller_has_provider_account: linked,
});
const DANA_NAMED = {
  emergency_admin: { ...owner(OTHER, "Dana"), eligible: true },
};
const LOCKED_OUT =
  "아직 닫을 수 없습니다. 켜진 공급자가 내 계정에 연결되어 있지 않아, 닫으면 내가 다시 들어올 수 없습니다. 켜진 공급자로 한 번 로그인해 내 계정에 연결하세요. 공급자가 확인한 이메일이 내 계정의 이메일과 같으면 자동으로 연결됩니다.";

const routes = (answer: LoginSettingsResponse) => ({
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/login-providers": () =>
    json(200, { providers: [], console_origin_configured: true }),
  [`GET ${API}`]: () => json(200, answer),
});

/** Why a button is withheld: null when it can be pressed. */
const withheld = (button: HTMLElement): string | null => {
  if (!(button as HTMLButtonElement).disabled) return null;
  return (button.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join("");
};
const section = async () =>
  (await screen.findByRole("heading", { name: "비밀번호 로그인" })).closest(
    "section",
  ) as HTMLElement;
const dangerZone = () => screen.findByRole("region", { name: "위험 구역" });
const closeButton = async () =>
  within(await dangerZone()).getByRole("button", {
    name: "비밀번호 로그인 닫기",
  });
const closedDialog = () =>
  waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));

describe("비밀번호 로그인 설정", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    for (const body of [
      read(),
      read({ password_login: "emergency_only" }),
      read({ emergency_admin: null, enabled_providers: 0 }, []),
    ])
      expect(loginSettingsResponseSchema.safeParse(body).success).toBe(true);
  });

  test("누가 비밀번호로 로그인할 수 있는지와 비상 관리자를 보인다", async () => {
    renderAt(LIST_PAGE, routes(read()));
    const area = await section();
    expect(area.textContent).toContain("비밀번호가 있는 모든 사람");
    expect(area.textContent).toContain("Me");
    expect(area.textContent).not.toContain("me@example.com");
    expect(within(area).getByText("Me").getAttribute("title")).toBe(
      "me@example.com",
    );
    expect(withheld(await closeButton())).toBe(null);
    expect(
      withheld(
        within(area).getByRole("button", { name: "비상 관리자 바꾸기" }),
      ),
    ).toBe(null);
  });

  test("두 행의 버튼은 서로의 글자를 안 보이게 품어 같은 폭이고, 위험 구역의 닫기는 제 글자 폭이다", async () => {
    renderAt(LIST_PAGE, routes(read({ password_login: "emergency_only" })));
    const area = await section();
    const buttons = [
      within(area).getByRole("button", { name: "비밀번호 로그인 열기" }),
      within(area).getByRole("button", { name: "비상 관리자 바꾸기" }),
    ];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "열기",
      "바꾸기",
    ]);
    for (const button of buttons)
      expect(
        [
          ...button.querySelectorAll<HTMLElement>(
            "[data-slot=same-width] > [aria-hidden=true]",
          ),
        ].map((ghost) => [ghost.className, ghost.dataset.text]),
      ).toEqual(
        ["열기", "바꾸기"].map((text) => [
          "invisible before:content-[attr(data-text)]",
          text,
        ]),
      );
    const close = await closeButton();
    expect(close.textContent).toBe("닫기");
    expect(close.querySelector("[data-slot=same-width]") === null).toBe(true);
  });

  test("닫기는 위험 구역의 위험 버튼이고, 열기와 바꾸기는 위험 구역 밖에 있다", async () => {
    renderAt(LIST_PAGE, routes(read({ password_login: "emergency_only" })));
    const zone = await dangerZone();
    const area = await section();
    const close = await closeButton();
    expect(close.className.split(" ")).toContain("bg-destructive-solid");
    expect(zone.textContent).toContain(
      "비상 관리자 말고는 비밀번호로 로그인할 수 없게 되고, 그 밖의 비밀번호 세션이 모두 끊깁니다.",
    );
    expect(area.contains(close)).toBe(false);
    for (const name of ["비밀번호 로그인 열기", "비상 관리자 바꾸기"]) {
      expect(within(area).getByRole("button", { name })).toBeDefined();
      expect(within(zone).queryByRole("button", { name }) === null).toBe(true);
    }
    // The state stays in the row above; the zone holds only what is lost.
    expect(area.textContent).toContain("비상 관리자만");
    expect(zone.textContent).not.toContain("비상 관리자만");
  });

  test("닫혀 있으면 위험 구역의 닫기를 이유와 함께 막는다", async () => {
    renderAt(LIST_PAGE, routes(read({ password_login: "emergency_only" })));
    expect(withheld(await closeButton())).toBe("이미 닫혀 있습니다.");
  });

  test("닫으면 키보드가 새로 나타난 열기로, 열면 위험 구역의 닫기로 간다", async () => {
    let answer = read();
    renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: () => json(200, answer),
      [`PATCH ${API}`]: async (request) => {
        answer = read(await request.json());
        return json(200, { settings: answer.settings, sessions_revoked: 0 });
      },
    });
    const user = await setupUser();
    await user.click(await closeButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "닫기",
      }),
    );
    await closedDialog();
    const reopen = await within(await section()).findByRole("button", {
      name: "비밀번호 로그인 열기",
    });
    await waitFor(() => expect(document.activeElement === reopen).toBe(true));
    await user.click(reopen);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "열기",
      }),
    );
    await closedDialog();
    // The button is drawn anew once the read lifts its reason.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("닫기"),
    );
    expect((await dangerZone()).contains(document.activeElement)).toBe(true);
  });

  test("열었는데 닫기가 이유로 막혀 있으면 그 이유로 가고, 나중에 닫기가 풀려도 키보드를 끌어오지 않는다", async () => {
    const lapsed = { emergency_admin: { ...owner(ME, "Me"), eligible: false } };
    let answer = read({ password_login: "emergency_only", ...lapsed });
    renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: () => json(200, answer),
      [`PATCH ${API}`]: async (request) => {
        const body = await request.json();
        answer =
          "password_login" in body
            ? read({ ...body, ...lapsed })
            : read(DANA_NAMED);
        return json(200, { settings: answer.settings, sessions_revoked: 0 });
      },
    });
    const user = await setupUser();
    await user.click(
      await within(await section()).findByRole("button", {
        name: "비밀번호 로그인 열기",
      }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "열기",
      }),
    );
    await closedDialog();
    await waitFor(async () =>
      expect(withheld(await closeButton())).toBe(
        "비상 관리자가 더는 비밀번호로 로그인할 수 없습니다. 다른 오너를 지정하세요.",
      ),
    );
    const reason = (await closeButton()).closest("[data-slot=disabled-reason]");
    await waitFor(() => expect(document.activeElement === reason).toBe(true));
    // The keyboard falls to the page, and a later read lifts the reason
    // (another owner named elsewhere): it is not pulled to 닫기.
    (document.activeElement as HTMLElement).blur();
    answer = read(DANA_NAMED);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(async () => expect(withheld(await closeButton())).toBe(null));
    expect(document.activeElement === document.body).toBe(true);
    focusManager.setFocused(undefined);
  });

  test("다시 읽기가 오기 전에 다른 곳으로 옮긴 키보드는 끌어오지 않는다", async () => {
    let answer = read();
    let release = () => {};
    let held: Promise<void> | null = null;
    renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: async () => {
        if (held) await held;
        return json(200, answer);
      },
      [`PATCH ${API}`]: async (request) => {
        answer = read(await request.json());
        held = new Promise((done) => {
          release = done;
        });
        return json(200, { settings: answer.settings, sessions_revoked: 0 });
      },
    });
    const user = await setupUser();
    await user.click(await closeButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "닫기",
      }),
    );
    await closedDialog();
    const change = within(await section()).getByRole("button", {
      name: "비상 관리자 바꾸기",
    });
    change.focus();
    held = null;
    release();
    await within(await section()).findByRole("button", {
      name: "비밀번호 로그인 열기",
    });
    expect(document.activeElement === change).toBe(true);
  });

  const refusedAhead: Array<[string, LoginSettingsResponse, string]> = [
    [
      "켜진 공급자가 없으면",
      read({ enabled_providers: 0 }),
      "켜진 공급자가 없습니다. 공급자를 먼저 켜세요.",
    ],
    [
      "비상 관리자가 없으면",
      read({ emergency_admin: null }),
      "비상 관리자가 없습니다. 먼저 지정하세요.",
    ],
    [
      "비상 관리자가 자격을 잃었으면",
      read({ emergency_admin: { ...owner(ME, "Me"), eligible: false } }),
      "비상 관리자가 더는 비밀번호로 로그인할 수 없습니다. 다른 오너를 지정하세요.",
    ],
  ];
  for (const [when, answer, reason] of refusedAhead) {
    test(`${when} 닫기를 누르기 전에 이유와 함께 막는다`, async () => {
      renderAt(LIST_PAGE, routes(answer));
      expect(withheld(await closeButton())).toBe(reason);
    });
  }

  test("닫기는 무엇이 끊기는지 확인받고, 끊긴 세션 수를 알린다", async () => {
    let answer = read();
    const { api } = renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: () => json(200, answer),
      [`PATCH ${API}`]: () => {
        answer = read({ password_login: "emergency_only" });
        return json(200, { settings: answer.settings, sessions_revoked: 3 });
      },
    });
    const user = await setupUser();
    await user.click(await closeButton());
    const dialog = await screen.findByRole("dialog");
    // The one asking is the emergency admin: their own session stays, and
    // their password is their way back without a provider account.
    expect(dialog.textContent).toContain("비상 관리자인 나 말고는");
    expect(dialog.textContent).not.toContain("내 세션도 끊깁니다");
    expect(dialog.textContent).not.toContain(LOCKED_OUT);
    expect(api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    const confirm = within(dialog).getByRole("button", { name: "닫기" });
    expect(withheld(confirm)).toBe(null);
    await user.click(confirm);
    await screen.findByText(
      "비밀번호 로그인을 닫았습니다. 세션 3개를 끊었습니다.",
    );
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      password_login: "emergency_only",
    });
    const area = await section();
    await waitFor(() => expect(area.textContent).toContain("비상 관리자만"));
    expect(
      within(area).getByRole("button", { name: "비밀번호 로그인 열기" }),
    ).toBeDefined();
  });

  test("비상 관리자가 아니고 공급자 계정도 없는 소유자는 닫을 수 없고, 왜인지와 무엇을 할지 본다", async () => {
    const { api } = renderAt(LIST_PAGE, routes(read(DANA_NAMED)));
    const user = await setupUser();
    await user.click(await closeButton());
    const dialog = await screen.findByRole("dialog");
    // Dana's password is Dana's way back, not the one asking.
    expect(dialog.textContent).toContain("비상 관리자 Dana 말고는");
    expect(dialog.textContent).toContain(LOCKED_OUT);
    const confirm = within(dialog).getByRole("button", { name: "닫기" });
    expect(withheld(confirm)).toBe(LOCKED_OUT);
    await user.click(confirm);
    expect(api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  test("비상 관리자가 아닌 소유자도 공급자 계정이 있으면 닫는다", async () => {
    let answer = read(DANA_NAMED, undefined, true);
    const { api } = renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: () => json(200, answer),
      [`PATCH ${API}`]: () => {
        answer = read(
          { ...DANA_NAMED, password_login: "emergency_only" },
          undefined,
          true,
        );
        return json(200, { settings: answer.settings, sessions_revoked: 1 });
      },
    });
    const user = await setupUser();
    await user.click(await closeButton());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toContain(LOCKED_OUT);
    const confirm = within(dialog).getByRole("button", { name: "닫기" });
    expect(withheld(confirm)).toBe(null);
    await user.click(confirm);
    await screen.findByText(
      "비밀번호 로그인을 닫았습니다. 세션 1개를 끊었습니다.",
    );
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      password_login: "emergency_only",
    });
  });

  test("비상 관리자가 아닌 소유자에게는 자기 세션도 끊길 수 있다고 말하고, 서버의 거절은 같은 이유로 확인을 막는다", async () => {
    // The page read a provider account that is gone by the time of the close.
    let answer = read(DANA_NAMED, undefined, true);
    const { api } = renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: () => json(200, answer),
      [`PATCH ${API}`]: () => {
        answer = read(DANA_NAMED);
        return apiError(409, "REVISION_CONFLICT", "no", false, {
          reason_code: "locks_out_actor",
        });
      },
    });
    const user = await setupUser();
    await user.click(await closeButton());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("비상 관리자 Dana 말고는");
    // Dana's own password sessions are the ones that stay.
    expect(dialog.textContent).toContain(
      "Dana 말고 비밀번호로 로그인한 사람은 모두 로그아웃됩니다",
    );
    expect(dialog.textContent).toContain("내 세션도 끊깁니다");
    const confirm = within(dialog).getByRole("button", { name: "닫기" });
    await user.click(confirm);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      LOCKED_OUT,
    );
    expect(withheld(confirm)).toBe(LOCKED_OUT);
    // Refused: read again, since the reason is often news.
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "GET" && call.path === API)
          .length,
      ).toBe(2),
    );
    expect(withheld(confirm)).toBe(LOCKED_OUT);
  });

  test("거절 뒤 다시 읽은 설정에 공급자 계정이 있으면 확인을 다시 누를 수 있다", async () => {
    const answer = read(DANA_NAMED, undefined, true);
    let refused = false;
    const { api } = renderAt(LIST_PAGE, {
      ...routes(answer),
      [`PATCH ${API}`]: () => {
        if (refused)
          return json(200, { settings: answer.settings, sessions_revoked: 0 });
        refused = true;
        return apiError(409, "REVISION_CONFLICT", "no", false, {
          reason_code: "locks_out_actor",
        });
      },
    });
    const user = await setupUser();
    await user.click(await closeButton());
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "닫기" });
    await user.click(confirm);
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "GET" && call.path === API)
          .length,
      ).toBe(2),
    );
    // The read after the refusal answers for itself: linked meanwhile.
    await waitFor(() => expect(withheld(confirm)).toBe(null));
    expect(dialog.textContent).not.toContain(LOCKED_OUT);
    await user.click(confirm);
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(
        2,
      ),
    );
  });

  test("닫힌 비밀번호 로그인은 확인 뒤에 연다", async () => {
    let answer = read({ password_login: "emergency_only" });
    const { api } = renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: () => json(200, answer),
      [`PATCH ${API}`]: () => {
        answer = read();
        return json(200, { settings: answer.settings, sessions_revoked: 0 });
      },
    });
    const user = await setupUser();
    await user.click(
      within(await section()).getByRole("button", {
        name: "비밀번호 로그인 열기",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "열기" }));
    await screen.findByText("비밀번호 로그인을 열었습니다.");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      password_login: "on",
    });
  });

  test("비상 관리자는 지정할 수 있는 다른 소유자 가운데서 바꾸고, 포커스는 연 버튼으로 돌아온다", async () => {
    let answer = read({}, [
      owner(ME, "Me"),
      owner(OTHER, "Dana"),
      owner(THIRD, "Eli"),
    ]);
    const { api } = renderAt(LIST_PAGE, {
      ...routes(answer),
      [`GET ${API}`]: () => json(200, answer),
      [`PATCH ${API}`]: () => {
        answer = read(
          { emergency_admin: { ...owner(THIRD, "Eli"), eligible: true } },
          answer.emergency_admin_candidates,
        );
        return json(200, { settings: answer.settings, sessions_revoked: 0 });
      },
    });
    const user = await setupUser();
    const change = within(await section()).getByRole("button", {
      name: "비상 관리자 바꾸기",
    });
    await user.click(change);
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByRole("combobox", { name: "오너" });
    // The one named now is not an option: naming them changes nothing.
    expect(
      [...select.querySelectorAll("option")].map(
        (option) => option.textContent,
      ),
    ).toEqual(["Dana (dana@example.com)", "Eli (eli@example.com)"]);
    expect(dialog.textContent).not.toContain("세션은 끊깁니다");
    await user.selectOptions(select, THIRD);
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await closedDialog();
    await screen.findByText("비상 관리자를 바꿨습니다: Eli");
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({
      emergency_admin_user_id: THIRD,
    });
    expect(document.activeElement === change).toBe(true);
    await waitFor(async () =>
      expect(
        within(await section())
          .getByText("Eli")
          .getAttribute("title"),
      ).toBe("eli@example.com"),
    );
  });

  test("닫힌 동안 비상 관리자를 바꾸면 지금 비상 관리자의 세션이 끊긴다고 말한다", async () => {
    renderAt(LIST_PAGE, routes(read({ password_login: "emergency_only" })));
    const user = await setupUser();
    await user.click(
      within(await section()).getByRole("button", {
        name: "비상 관리자 바꾸기",
      }),
    );
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "지금 비상 관리자의 비밀번호 세션은 끊깁니다",
    );
  });

  test("지정할 다른 소유자가 없으면 바꾸기를 이유와 함께 막고, 자격을 잃은 비상 관리자는 그렇게 표시한다", async () => {
    renderAt(
      LIST_PAGE,
      routes(
        read({ emergency_admin: { ...owner(ME, "Me"), eligible: false } }, []),
      ),
    );
    const area = await section();
    expect(area.textContent).toContain("비밀번호로 로그인할 수 없음");
    expect(
      withheld(
        within(area).getByRole("button", { name: "비상 관리자 바꾸기" }),
      ),
    ).toBe(
      "지정할 수 있는 다른 오너가 없습니다. 켜져 있고 비밀번호가 있는 오너만 지정할 수 있습니다.",
    );
  });

  test("설정을 못 읽으면 그렇게 말하고, 공급자 목록은 그대로 보인다", async () => {
    renderAt(LIST_PAGE, {
      ...routes(read()),
      [`GET ${API}`]: () => apiError(503, "BACKEND_UNAVAILABLE", "down"),
    });
    await screen.findByText("등록된 공급자가 없습니다.");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "비밀번호 로그인" }) === null,
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeDefined();
  });
});
