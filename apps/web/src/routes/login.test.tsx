import { describe, expect, test } from "bun:test";
import { loginMethodsResponseSchema } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberPage } from "../test-support/fake-api.ts";
import { appHarness, comeBack } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor } = await appHarness();

const GOOGLE = {
  id: "5b0c7e2a-9d41-4f6b-8a3e-7c1d2e3f4a5b",
  display_name: "Google",
};
const KEYCLOAK = {
  id: "0d6a3f1c-2b7e-4c58-9a1d-6e5f4a3b2c1d",
  display_name: "Keycloak",
};
const loginMethods = (...providers: (typeof GOOGLE)[]) => ({
  password: "on",
  providers,
});
const methods = (...providers: (typeof GOOGLE)[]) => ({
  "GET /v1/auth/login-methods": () => json(200, loginMethods(...providers)),
});
/** Passwords closed to everyone but the emergency admin. */
const closedLoginMethods = (...providers: (typeof GOOGLE)[]) => ({
  password: "emergency_only",
  providers,
});
const closedMethods = (...providers: (typeof GOOGLE)[]) => ({
  "GET /v1/auth/login-methods": () =>
    json(200, closedLoginMethods(...providers)),
});
const AUTHORIZE = "https://accounts.google.test/o/oauth2/v2/auth?state=s1";
const START = `/v1/auth/providers/${GOOGLE.id}/start`;
const CALLBACK_PAGE = `/auth/callback/${GOOGLE.id}`;
const signedIn = {
  user_id: me().user?.id,
  workspace_id: me().workspace?.id,
  role: "owner",
  scopes: me().scopes,
  expires_at: "2026-10-12T00:00:00.000Z",
};

describe("로그인 수단 선택", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    for (const body of [
      loginMethods(),
      loginMethods(GOOGLE, KEYCLOAK),
      closedLoginMethods(GOOGLE),
    ])
      expect(loginMethodsResponseSchema.safeParse(body).success).toBe(true);
  });

  test("켜진 공급자가 없으면 비밀번호만 보인다", async () => {
    renderAt("/login", methods());
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "다른 로그인 방법" }),
      ).toBeNull(),
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "로그인",
    ]);
  });

  test("켜진 공급자마다 그 이름의 버튼을 받은 순서대로 보인다", async () => {
    renderAt("/login", methods(GOOGLE, KEYCLOAK));
    const choices = await screen.findByRole("region", {
      name: "다른 로그인 방법",
    });
    expect(
      [...choices.querySelectorAll("button")].map((b) => b.textContent),
    ).toEqual(["Google 계정으로 로그인", "Keycloak 계정으로 로그인"]);
  });

  test("목록을 못 읽어도 비밀번호 로그인은 남는다", async () => {
    renderAt("/login", {
      "GET /v1/auth/login-methods": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "storage down"),
    });
    expect(await screen.findByRole("button", { name: "로그인" })).toBeDefined();
    expect(
      screen.queryByRole("region", { name: "다른 로그인 방법" }),
    ).toBeNull();
  });

  test("비밀번호 로그인을 닫은 설치는 공급자가 먼저이고, 폼은 '비상 관리자 로그인' 뒤에 있다", async () => {
    renderAt("/login", closedMethods(GOOGLE));
    const choices = await screen.findByRole("region", { name: "SSO 로그인" });
    expect(
      [...choices.querySelectorAll("button")].map((b) => b.textContent),
    ).toEqual(["Google 계정으로 로그인"]);
    expect(screen.queryByText("또는")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "이메일" })).toBeNull();
    expect(screen.queryByRole("button", { name: "로그인" })).toBeNull();

    const user = await setupUser();
    await user.click(
      screen.getByRole("button", { name: "비상 관리자 로그인" }),
    );
    const email = screen.getByRole("textbox", { name: "이메일" });
    // The button that had the focus is gone; the field takes it.
    await waitFor(() => expect(document.activeElement === email).toBe(true));
    expect(
      screen.getByText(
        "이 설치는 비밀번호 로그인을 꺼 두었습니다. 비상 관리자만 비밀번호로 로그인할 수 있습니다.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "로그인" })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "비상 관리자 로그인" }) === null,
    ).toBe(true);
    // Still the provider first, and one set of buttons.
    expect(screen.getAllByRole("region").length).toBe(1);
  });

  test("닫혔다는 답이 오기 전에 쓰기 시작한 폼은 그대로 남는다", async () => {
    let answer = (_: Response) => {};
    const answered = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    renderAt("/login", { "GET /v1/auth/login-methods": () => answered });
    const user = await setupUser();
    await user.type(
      await screen.findByRole("textbox", { name: "이메일" }),
      "owner@example.com",
    );
    await act(async () => answer(json(200, closedLoginMethods(GOOGLE))));
    await screen.findByRole("region", { name: "SSO 로그인" });
    const email = screen.getByRole("textbox", { name: "이메일" });
    expect((email as HTMLInputElement).value).toBe("owner@example.com");
    expect(
      screen.queryByRole("button", { name: "비상 관리자 로그인" }) === null,
    ).toBe(true);
    // Clearing the field to retype it is not leaving the form: it stays,
    // and so does the keyboard.
    await user.clear(email);
    const cleared = screen.getByRole("textbox", { name: "이메일" });
    expect((cleared as HTMLInputElement).value).toBe("");
    expect(document.activeElement === cleared).toBe(true);
    expect(
      screen.queryByRole("button", { name: "비상 관리자 로그인" }) === null,
    ).toBe(true);
  });

  test("공급자를 고르면 그 공급자의 시작 요청 뒤 공급자 화면으로 가고, 돌아올 곳을 기억한다", async () => {
    sessionStorage.clear();
    const { api, left } = renderAt("/login?redirect=%2Fmembers", {
      ...methods(GOOGLE, KEYCLOAK),
      [`POST ${START}`]: () => json(200, { authorization_url: AUTHORIZE }),
    });
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Google 계정으로 로그인" }),
    );
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
    // The page is still here while the provider's loads: a second start
    // would replace the flow the browser is on its way to.
    const held = () =>
      screen
        .getAllByRole("button", { name: /Keycloak|이동하는 중/ })
        .map((button) => button.hasAttribute("disabled"));
    expect(held()).toEqual([true, true]);
    // A page shown for the first time is not one come back to. Inside act,
    // so what the event changed is drawn before the buttons are read.
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(held()).toEqual([true, true]);
    await user.click(
      screen.getByRole("button", { name: "Keycloak 계정으로 로그인" }),
    );
    // Coming back from the provider's page (back button) can start again.
    comeBack();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: /계정으로 로그인$/ })
          .map((button) => button.hasAttribute("disabled")),
      ).toEqual([false, false]),
    );
    const starts = api.calls.filter((c) => c.path.endsWith("/start"));
    expect(starts.map((c) => c.path)).toEqual([START]);
    expect(starts[0]?.headers.get("x-requested-with")).toBe("werft-web");
    expect(sessionStorage.getItem("ap.postLoginPath")).toBe("/members");
  });

  test("버튼이 잡힌 것으로 다시 그려지기 전에 또 눌려도 시작은 한 번이다", async () => {
    const { api, left } = renderAt("/login", {
      ...methods(GOOGLE, KEYCLOAK),
      [`POST ${START}`]: () => json(200, { authorization_url: AUTHORIZE }),
      [`POST /v1/auth/providers/${KEYCLOAK.id}/start`]: () =>
        json(200, { authorization_url: "https://keycloak.test/authorize" }),
    });
    const google = await screen.findByRole("button", {
      name: "Google 계정으로 로그인",
    });
    const keycloak = screen.getByRole("button", {
      name: "Keycloak 계정으로 로그인",
    });
    // Inside one act React draws nothing between the two presses.
    await act(async () => {
      google.click();
      keycloak.click();
    });
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
    expect(
      api.calls.filter((c) => c.path.endsWith("/start")).map((c) => c.path),
    ).toEqual([START]);
  });
});

describe("공급자 콜백", () => {
  test("경로의 공급자와 code·state·iss를 한 번 보내고 기억한 곳으로 간다", async () => {
    sessionStorage.setItem("ap.postLoginPath", "/members");
    const { api, history } = renderAt(
      `${CALLBACK_PAGE}?code=c1&state=s1&iss=${encodeURIComponent("https://accounts.google.test")}`,
      {
        "POST /v1/auth/oidc/callback": () =>
          json(200, { outcome: "signed_in", ...signedIn }),
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/members": () =>
          json(200, memberPage({ items: [], next_cursor: null })),
        "GET /v1/invites": () => json(200, { items: [] }),
      },
    );
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
    const posts = api.calls.filter((c) => c.path === "/v1/auth/oidc/callback");
    expect(posts.map((c) => c.body)).toEqual([
      {
        provider_id: GOOGLE.id,
        code: "c1",
        state: "s1",
        iss: "https://accounts.google.test",
      },
    ]);
    expect(posts[0]?.headers.get("x-requested-with")).toBe("werft-web");
    expect(sessionStorage.getItem("ap.postLoginPath")).toBeNull();
  });

  test("공급자가 iss를 주지 않으면 iss 없이 보낸다", async () => {
    const { api, history } = renderAt(`${CALLBACK_PAGE}?code=c1&state=s1`, {
      "POST /v1/auth/oidc/callback": () =>
        json(200, { outcome: "signed_in", ...signedIn }),
      "GET /v1/auth/me": () => json(200, me()),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(
      api.calls.find((c) => c.path === "/v1/auth/oidc/callback")?.body,
    ).toEqual({ provider_id: GOOGLE.id, code: "c1", state: "s1" });
  });

  test("연결로 끝난 흐름은 내 로그인 수단으로 돌아가고, 기억한 곳은 쓰지 않는다", async () => {
    sessionStorage.setItem("ap.postLoginPath", "/members");
    const { history } = renderAt(`${CALLBACK_PAGE}?code=c1&state=s1`, {
      "POST /v1/auth/oidc/callback": () =>
        json(200, { outcome: "linked", provider_id: GOOGLE.id }),
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/auth/me/login-methods": () =>
        json(200, { methods: [], linkable: [], can_change: true }),
    });
    await waitFor(() =>
      expect(history.location.pathname).toBe("/settings/login-methods"),
    );
    expect(sessionStorage.getItem("ap.postLoginPath")).toBe("/members");
    sessionStorage.removeItem("ap.postLoginPath");
  });

  test("기억한 곳이 다른 origin이면 홈으로 간다", async () => {
    sessionStorage.setItem("ap.postLoginPath", "//evil.example");
    const { history } = renderAt(`${CALLBACK_PAGE}?code=c1&state=s1`, {
      "POST /v1/auth/oidc/callback": () =>
        json(200, { outcome: "signed_in", ...signedIn }),
      "GET /v1/auth/me": () => json(200, me()),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
  });

  test("거절은 이유별 문구와 로그인 링크다", async () => {
    const cases: [Response, string][] = [
      [
        apiError(401, "UNAUTHORIZED", "Sign-in was not accepted"),
        "이 계정으로 로그인하지 못했습니다 — 초대받은 이메일 주소의 계정인지 확인하고 다시 시도하세요.",
      ],
      [
        apiError(403, "FORBIDDEN", "This account's domain is not allowed here"),
        "이 계정으로는 로그인할 수 없습니다 — 워크스페이스가 허용한 도메인의 계정을 쓰세요.",
      ],
      [
        apiError(404, "NOT_FOUND", "Login provider not found"),
        "이 로그인 방법은 지금 쓸 수 없습니다 — 로그인 화면에서 다른 방법을 고르세요.",
      ],
      [
        apiError(
          409,
          "LOGIN_LINK_REQUIRED",
          "Sign in with your existing account",
        ),
        "이미 이 이메일로 만든 계정이 있습니다 — 비밀번호로 로그인하세요.",
      ],
    ];
    for (const [response, text] of cases) {
      const { container } = renderAt(`${CALLBACK_PAGE}?code=c&state=s`, {
        "POST /v1/auth/oidc/callback": () => response.clone(),
      });
      await waitFor(() =>
        expect(container.querySelector("[role=alert]")?.textContent).toBe(text),
      );
      expect(container.querySelector('a[href="/login"]')?.textContent).toBe(
        "로그인 화면으로",
      );
      container.remove();
    }
  });

  test("code 없이 돌아오면(동의 취소) 보내지 않고 다시 하라고 한다", async () => {
    const { api } = renderAt(`${CALLBACK_PAGE}?error=access_denied`, {});
    expect((await screen.findByRole("alert")).textContent).toBe(
      "로그인을 마치지 못했습니다 — 다시 시도하세요.",
    );
    expect(api.calls).toEqual([]);
  });
});

describe("로그인 화면 안내", () => {
  test("로그인에 실패하면 '소유자를 만들었습니다' 알림을 거둔다", async () => {
    renderAt("/login?notice=created", {
      ...methods(),
      "POST /v1/auth/login": () =>
        apiError(401, "UNAUTHORIZED", "Invalid credentials"),
    });
    expect(await screen.findByText(/소유자를 만들었습니다/)).toBeDefined();
    const user = await setupUser();
    await user.type(screen.getByLabelText("이메일"), "owner@example.com");
    await user.type(screen.getByLabelText("비밀번호"), "wrong-wrong-wrong");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByText(/소유자를 만들었습니다/)).toBeNull();
  });

  test("이미 로그인했으면 폼 없이 홈으로 바꿔 간다", async () => {
    const { history } = renderAt("/login", {
      ...methods(),
      "GET /v1/auth/me": () => json(200, me()),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(history.length).toBe(1);
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
  });

  test("로그인된 화면에서 /login으로 가도 뒤로 가기에 /login이 남지 않는다", async () => {
    const { history } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
    history.push("/login");
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(history.length).toBe(2);
    history.back();
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
  });

  test("이미 로그인했으면 안전한 redirect 경로로 간다", async () => {
    const { history } = renderAt("/login?redirect=%2Fmembers", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
    expect(history.length).toBe(1);
  });

  test("redirect의 query도 그대로 가져간다", async () => {
    const { history } = renderAt(
      `/login?redirect=${encodeURIComponent("/sessions?status=needs_input")}`,
      {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
      },
    );
    await waitFor(() => expect(history.location.pathname).toBe("/sessions"));
    expect(history.location.search).toBe("?status=needs_input");
  });

  test("세션 확인이 401 말고 다른 오류로 실패해도 폼을 보인다", async () => {
    renderAt("/login", {
      ...methods(),
      "GET /v1/auth/me": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "storage down"),
    });
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    expect(screen.getByRole("button", { name: "로그인" })).toBeDefined();
  });

  test("다른 origin을 가리키는 redirect는 홈으로 간다", async () => {
    for (const unsafe of [
      "//evil.example",
      "https://evil.example/",
      "/\\evil.example",
    ]) {
      const { history, container } = renderAt(
        `/login?redirect=${encodeURIComponent(unsafe)}`,
        { "GET /v1/auth/me": () => json(200, me()) },
      );
      await waitFor(() => expect(history.location.pathname).toBe("/"));
      expect(history.location.href).toBe("/");
      container.remove();
    }
  });

  test("세션을 확인하는 동안에는 폼을 그리지 않는다", async () => {
    let answer: (response: Response) => void = () => {};
    renderAt("/login", {
      ...methods(),
      "GET /v1/auth/me": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    expect(
      await screen.findByText("로그인 상태를 확인하는 중입니다"),
    ).toBeDefined();
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
    answer(apiError(401, "UNAUTHORIZED", "Authentication is required"));
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
  });

  test("로그인하지 않았으면 폼을 그대로 보인다", async () => {
    renderAt("/login", {
      ...methods(),
      "GET /v1/auth/me": () =>
        apiError(401, "UNAUTHORIZED", "Authentication is required"),
    });
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    expect(screen.queryByText("로그인이 필요합니다")).toBeNull();
  });
});
