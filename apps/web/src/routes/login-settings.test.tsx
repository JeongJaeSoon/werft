import { describe, expect, test } from "bun:test";
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

/** Passwords open, the signed-in owner named, one provider on. */
const read = (
  rest: Partial<LoginSettingsResponse["settings"]> = {},
  candidates = [owner(ME, "Me"), owner(OTHER, "Dana")],
): LoginSettingsResponse => ({
  settings: {
    password_login: "on",
    emergency_admin: { ...owner(ME, "Me"), eligible: true },
    enabled_providers: 1,
    ...rest,
  },
  emergency_admin_candidates: candidates,
});

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
    expect(area.textContent).toContain("Me · me@example.com");
    expect(
      withheld(
        within(area).getByRole("button", { name: "비밀번호 로그인 닫기" }),
      ),
    ).toBe(null);
    expect(
      withheld(
        within(area).getByRole("button", { name: "비상 관리자 바꾸기" }),
      ),
    ).toBe(null);
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
      "비상 관리자가 더는 비밀번호로 로그인할 수 없습니다. 다른 소유자를 지정하세요.",
    ],
  ];
  for (const [when, answer, reason] of refusedAhead) {
    test(`${when} 닫기를 누르기 전에 이유와 함께 막는다`, async () => {
      renderAt(LIST_PAGE, routes(answer));
      expect(
        withheld(
          within(await section()).getByRole("button", {
            name: "비밀번호 로그인 닫기",
          }),
        ),
      ).toBe(reason);
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
    const close = within(await section()).getByRole("button", {
      name: "비밀번호 로그인 닫기",
    });
    await user.click(close);
    const dialog = await screen.findByRole("dialog");
    // The one asking is the emergency admin: their own session stays.
    expect(dialog.textContent).toContain("비상 관리자인 나 말고는");
    expect(dialog.textContent).not.toContain("내 세션도 끊깁니다");
    expect(api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
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

  test("비상 관리자가 아닌 소유자에게는 자기 세션도 끊길 수 있다고 말하고, 거절은 대화상자에 남는다", async () => {
    const { api } = renderAt(LIST_PAGE, {
      ...routes(
        read({ emergency_admin: { ...owner(OTHER, "Dana"), eligible: true } }),
      ),
      [`PATCH ${API}`]: () =>
        apiError(409, "REVISION_CONFLICT", "no", false, {
          reason_code: "locks_out_actor",
        }),
    });
    const user = await setupUser();
    await user.click(
      within(await section()).getByRole("button", {
        name: "비밀번호 로그인 닫기",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("비상 관리자 Dana 말고는");
    // Dana's own password sessions are the ones that stay.
    expect(dialog.textContent).toContain(
      "Dana 말고 비밀번호로 로그인한 사람은 모두 로그아웃됩니다",
    );
    expect(dialog.textContent).toContain("내 세션도 끊깁니다");
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "이대로는 내가 다시 들어올 수 없습니다. 켜진 공급자의 계정을 내 로그인 수단에 먼저 연결하세요.",
    );
    // Refused: read again, since the reason is often news.
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "GET" && call.path === API)
          .length,
      ).toBe(2),
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
    const select = within(dialog).getByRole("combobox", { name: "소유자" });
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
      expect((await section()).textContent).toContain("Eli · eli@example.com"),
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
      "지정할 수 있는 다른 소유자가 없습니다. 켜져 있고 비밀번호가 있는 소유자만 지정할 수 있습니다.",
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
