import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const TOKEN = "t".repeat(43);
const SECRET = "correct horse battery";
const signedOut = () =>
  apiError(401, "UNAUTHORIZED", "Authentication is required");

type Account = "있음" | "처음";

async function accept(account: Account = "있음", password = SECRET, name = "") {
  const user = await setupUser();
  await user.click(
    await screen.findByRole("button", {
      name: account === "있음" ? "네, 계정이 있습니다" : "아니요, 처음입니다",
    }),
  );
  await user.type(await screen.findByLabelText("비밀번호"), password);
  if (name) await user.type(screen.getByLabelText("이름"), name);
  await user.click(screen.getByRole("button", { name: "초대 수락" }));
  return user;
}

const acceptCalls = (api: {
  calls: readonly { path: string; body?: unknown }[];
}) => api.calls.filter((c) => c.path === "/v1/invites/accept");

describe("초대 수락", () => {
  test("처음이면 비밀번호와 이름을 넣어 수락하고, 수락하면 워크스페이스로 들어간다", async () => {
    let accepted = false;
    const { api, history } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": () => (accepted ? json(200, me()) : signedOut()),
      "POST /v1/invites/accept": () => {
        accepted = true;
        return json(200, {
          user_id: me().user?.id,
          workspace: me().workspace,
          role: "member",
        });
      },
    });
    await accept("처음", SECRET, "Newcomer");
    expect(await screen.findByRole("heading", { name: "홈" })).toBeDefined();
    expect(history.location.pathname).toBe("/");
    const call = api.calls.find((c) => c.path === "/v1/invites/accept");
    expect(call?.body).toEqual({
      token: TOKEN,
      password: SECRET,
      display_name: "Newcomer",
    });
    expect(call?.headers.get("x-requested-with")).toBe("werft-web");
  });

  test("계정이 있으면 이름을 묻지 않고, 비밀번호만 보낸다", async () => {
    const { api } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () => apiError(410, "INVITE_EXPIRED", "gone"),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "네, 계정이 있습니다" }),
    );
    expect(
      (await screen.findByLabelText("비밀번호")).getAttribute("autocomplete"),
    ).toBe("current-password");
    expect(screen.queryByLabelText("이름")).toBeNull();
    await user.type(screen.getByLabelText("비밀번호"), SECRET);
    await user.click(screen.getByRole("button", { name: "초대 수락" }));
    await screen.findByText("쓸 수 없는 초대입니다");
    expect(acceptCalls(api)[0]?.body).toEqual({
      token: TOKEN,
      password: SECRET,
    });
  });

  test("처음이어도 이름을 비우거나 공백만 넣으면 보내지 않는다", async () => {
    const { api } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () => apiError(410, "INVITE_EXPIRED", "gone"),
    });
    await accept("처음", SECRET, "   ");
    await screen.findByText("쓸 수 없는 초대입니다");
    expect(acceptCalls(api)[0]?.body).toEqual({
      token: TOKEN,
      password: SECRET,
    });
  });

  test("처음이면 이름 칸이 비밀번호 칸보다 먼저 나온다", async () => {
    renderAt(`/invite/${TOKEN}`, { "GET /v1/auth/me": signedOut });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "아니요, 처음입니다" }),
    );
    const name = await screen.findByLabelText("이름");
    const secret = screen.getByLabelText("비밀번호");
    expect(
      name.compareDocumentPosition(secret) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("단계가 URL에 남고, 이전으로 돌아가 계정 종류를 다시 고를 수 있다", async () => {
    const { history } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "아니요, 처음입니다" }),
    );
    await screen.findByLabelText("이름");
    expect(history.location.search).toContain("accept.step=password");
    await user.click(screen.getByRole("button", { name: "이전" }));
    expect(
      await screen.findByRole("button", { name: "네, 계정이 있습니다" }),
    ).toBeDefined();
    expect(history.location.pathname).toBe(`/invite/${TOKEN}`);
  });

  test("비밀번호는 단계 기록(history.state)에 남지 않는다", async () => {
    const { history } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "아니요, 처음입니다" }),
    );
    await user.type(await screen.findByLabelText("비밀번호"), SECRET);
    await user.type(screen.getByLabelText("이름"), "Newcomer");
    expect(JSON.stringify(history.location.state)).toContain('"new"');
    expect(JSON.stringify(history.location.state)).not.toContain(SECRET);
    expect(JSON.stringify(history.location.state)).not.toContain("Newcomer");
  });
});

describe("입력 검증(W24 규약)", () => {
  test("빈 비밀번호와 너무 긴 이름은 서버에 묻지 않고 각 칸에 이유를 붙인다", async () => {
    const { api } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "아니요, 처음입니다" }),
    );
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    // The maxLength attribute stops typing, not a pasted or scripted value.
    name.removeAttribute("maxlength");
    await user.type(name, "a".repeat(65));
    await user.click(screen.getByRole("button", { name: "초대 수락" }));
    const password = screen.getByLabelText("비밀번호");
    await waitFor(() =>
      expect(password.getAttribute("aria-invalid")).toBe("true"),
    );
    const describedBy = (input: HTMLElement) =>
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(describedBy(password)).toContain("12자 이상 입력하세요.");
    expect(describedBy(name)).toContain("64자 이하로 입력하세요.");
    expect(acceptCalls(api)).toHaveLength(0);
  });

  test("틀린 비밀번호(401)는 폼 위 한 줄로 보이고 로그인 화면으로 튕기지 않는다", async () => {
    const { history } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(401, "UNAUTHORIZED", "Invite token or password is invalid"),
    });
    await accept("있음", "wrong password!!");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("SSO로만 로그인해 온 계정은");
    expect(history.location.pathname).toBe(`/invite/${TOKEN}`);
    expect(screen.getByRole("button", { name: "초대 수락" })).toBeDefined();
  });

  test("그 밖의 서버 400은 서버 문구 대신 화면의 한 줄로 보인다", async () => {
    renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(400, "BAD_REQUEST", "body.password: too small"),
    });
    await accept();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("body.password");
    // Above the form's fields, not under them.
    expect(
      alert.compareDocumentPosition(screen.getByLabelText("비밀번호")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("쓸 수 없는 초대", () => {
  test("만료·회수된 초대(410)는 폼 대신 새 링크를 요청하라고 한다", async () => {
    renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(410, "INVITE_EXPIRED", "This invite was revoked"),
    });
    await accept();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("만료됐거나 회수된 초대입니다");
    expect(screen.queryByRole("button", { name: "초대 수락" })).toBeNull();
  });

  test("이미 쓴 초대(409)는 로그인으로 안내한다", async () => {
    renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(409, "INVITE_USED", "This invite was already used"),
    });
    await accept();
    expect(await screen.findByText("이미 수락한 초대입니다")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "로그인 화면으로" })
        .getAttribute("href"),
    ).toBe("/login");
  });

  test("잘리거나 지어낸 링크는 서버에 묻지 않고 링크 전체를 다시 열라고 한다", async () => {
    const { api } = renderAt(`/invite/${"t".repeat(10)}`, {
      "GET /v1/auth/me": signedOut,
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("초대 링크가 올바르지 않습니다");
    expect(alert.textContent).toContain("받은 링크 전체를");
    expect(screen.queryByRole("button", { name: "초대 수락" })).toBeNull();
    expect(acceptCalls(api)).toHaveLength(0);
  });

  test("다른 초대 링크로 옮기면 앞 초대의 결과를 들고 가지 않는다", async () => {
    const { history } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(410, "INVITE_EXPIRED", "This invite was revoked"),
    });
    await accept();
    await screen.findByRole("alert");
    history.push(`/invite/${"u".repeat(43)}`);
    expect(
      await screen.findByRole("button", { name: "네, 계정이 있습니다" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
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

  for (const [status, code] of [
    [410, "INVITE_EXPIRED"],
    [409, "INVITE_USED"],
    [401, "UNAUTHORIZED"],
    [400, "BAD_REQUEST"],
    [500, "INTERNAL"],
  ] as const) {
    test(`${status} ${code}에서도 로그와 화면 문구에 나오지 않는다`, async () => {
      renderAt(`/invite/${TOKEN}`, {
        "GET /v1/auth/me": signedOut,
        "POST /v1/invites/accept": () =>
          apiError(status, code, `rejected ${TOKEN}`),
      });
      await accept();
      await screen.findAllByRole("alert");
      expect(document.body.textContent).not.toContain(TOKEN);
      expect(logged.join("\n")).not.toContain(TOKEN);
    });
  }
});

describe("이미 로그인한 사람", () => {
  test("수락할 필요가 없다고 하고, 로그아웃하면 첫 단계를 보인다", async () => {
    let signedIn = true;
    const { api } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": () => (signedIn ? json(200, me()) : signedOut()),
      "POST /v1/auth/logout": () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    expect(
      await screen.findByText("이미 이 워크스페이스의 구성원입니다"),
    ).toBeDefined();
    expect(screen.getByText(/owner@example.com 계정으로 Acme에/)).toBeDefined();
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
    const user = await setupUser();
    await user.click(
      screen.getByRole("button", { name: "로그아웃하고 다른 계정으로 수락" }),
    );
    expect(
      await screen.findByRole("button", { name: "네, 계정이 있습니다" }),
    ).toBeDefined();
    expect(api.calls.some((c) => c.path === "/v1/invites/accept")).toBe(false);
  });

  test("다섯 경우의 문구가 서로 다르다", async () => {
    const { ko } = await import("../i18n/ko.ts");
    const titles = [
      ko["invite.account.question"],
      ko["invite.member.title"],
      ko["invite.expired.title"],
      ko["invite.used.title"],
      ko["invite.invalid.title"],
    ];
    expect(new Set(titles).size).toBe(5);
  });
});

describe("단계 이동", () => {
  test("단계를 옮길 때마다 포커스가 그 단계의 제목으로 간다", async () => {
    renderAt(`/invite/${TOKEN}`, { "GET /v1/auth/me": signedOut });
    const user = await setupUser();
    const focusedHeading = (name: string) =>
      waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("heading", { level: 2, name }),
        ),
      );

    const newcomer = await screen.findByRole("button", {
      name: "아니요, 처음입니다",
    });
    // Arriving on the first step leaves focus where the page put it.
    expect(document.activeElement?.tagName).not.toBe("H2");
    await user.click(newcomer);
    await focusedHeading("새 계정으로 수락");
    await user.click(screen.getByRole("button", { name: "이전" }));
    await focusedHeading("초대받은 이메일로 쓰는 계정이 있나요?");
    await user.click(
      screen.getByRole("button", { name: "네, 계정이 있습니다" }),
    );
    await focusedHeading("기존 계정으로 수락");
  });
});

describe("비밀번호 보존 범위", () => {
  const cachedPassword = (services: { queryClient: QueryClient }) =>
    services.queryClient
      .getMutationCache()
      .getAll()
      .some((m) => JSON.stringify(m.state).includes(SECRET));

  test("틀린 비밀번호(401) 뒤 MutationCache에 비밀번호가 남지 않는다", async () => {
    const { api, services } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(401, "UNAUTHORIZED", "Invite token or password is invalid"),
    });
    await accept();
    await screen.findByRole("alert");
    expect(acceptCalls(api)).toHaveLength(1);
    await waitFor(() => expect(cachedPassword(services)).toBe(false));
    expect(screen.getByRole("button", { name: "초대 수락" })).toBeDefined();
  });

  test("쓸 수 없는 초대(410) 뒤에도 남지 않고, 안내는 그대로 보인다", async () => {
    const { services } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(410, "INVITE_EXPIRED", "This invite was revoked"),
    });
    await accept();
    await screen.findByText("쓸 수 없는 초대입니다");
    await waitFor(() => expect(cachedPassword(services)).toBe(false));
  });
});

describe("공급자 계정으로 가입", () => {
  const KEYCLOAK = {
    id: "0d6a3f1c-2b7e-4c58-9a1d-6e5f4a3b2c1d",
    display_name: "Keycloak",
  };
  const OKTA = {
    id: "5b0c7e2a-9d41-4f6b-8a3e-7c1d2e3f4a5b",
    display_name: "Okta",
  };
  const START = `/v1/auth/providers/${KEYCLOAK.id}/invite/start`;
  const AUTHORIZE = "https://idp.example.test/authorize?state=s1";
  const on = (...providers: (typeof KEYCLOAK)[]) => ({
    "GET /v1/auth/me": signedOut,
    "GET /v1/auth/login-methods": () =>
      json(200, { password: "on", providers }),
  });
  const join = async () => {
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Keycloak 계정으로 가입" }),
    );
  };
  const LEAVING = "로그인 화면으로 이동하는 중…";
  const choices = () =>
    screen.queryByRole("region", { name: "비밀번호 없이 가입" });
  // A count, not `toBeNull()` on an element: that passes on one that is there.
  const shown = () =>
    screen.queryAllByRole("region", { name: "비밀번호 없이 가입" }).length +
    screen.queryAllByRole("button", { name: /계정으로 가입$/ }).length;

  test("켜진 공급자마다 버튼이 있고, 누르면 초대를 그 흐름에 묶은 뒤 공급자 화면으로 간다", async () => {
    sessionStorage.setItem("ap.postLoginPath", "/members");
    const { api, left, services } = renderAt(`/invite/${TOKEN}`, {
      ...on(KEYCLOAK, OKTA),
      [`POST ${START}`]: () => json(200, { authorization_url: AUTHORIZE }),
    });
    await screen.findByRole("button", { name: "Keycloak 계정으로 가입" });
    expect(
      [...(choices()?.querySelectorAll("button") ?? [])].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Keycloak 계정으로 가입", "Okta 계정으로 가입"]);
    await join();
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
    const starts = api.calls.filter((c) => c.path.endsWith("/invite/start"));
    expect(starts.map((c) => c.path)).toEqual([START]);
    expect(starts[0]?.body).toEqual({ invite_token: TOKEN });
    expect(starts[0]?.headers.get("x-requested-with")).toBe("werft-web");
    // The invite is not accepted here: the callback spends it.
    expect(acceptCalls(api)).toHaveLength(0);
    // Where an earlier sign-in of the tab meant to go is not for a new member.
    expect(sessionStorage.getItem("ap.postLoginPath")).toBeNull();
    // What the page keeps of the request names the provider, not the invite.
    expect(
      services.queryClient
        .getMutationCache()
        .getAll()
        .some((m) => JSON.stringify(m.state).includes(TOKEN)),
    ).toBe(false);
    // A refused callback is told by this that it was joining; not the invite.
    expect(sessionStorage.getItem("ap.inviteFlow")).toBe("s1");
  });

  test("떠나는 동안에는 다시 시작하지 못하고, 뒤로 돌아오면 다시 할 수 있다", async () => {
    const { api, left } = renderAt(`/invite/${TOKEN}`, {
      ...on(KEYCLOAK, OKTA),
      [`POST ${START}`]: () => json(200, { authorization_url: AUTHORIZE }),
    });
    const user = await setupUser();
    const held = () =>
      [
        "Keycloak 계정으로 가입",
        "Okta 계정으로 가입",
        LEAVING,
        "아니요, 처음입니다",
      ].map((name) =>
        screen
          .queryAllByRole("button", { name })
          .map((button) => button.hasAttribute("disabled")),
      );
    const starts = () =>
      api.calls.filter((c) => c.path.endsWith("/invite/start")).length;
    await join();
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
    // The page is still here while the provider's loads: a second start
    // would replace the flow the browser is on its way to.
    expect(held()).toEqual([[], [true], [true], [true]]);
    await user.click(screen.getByRole("button", { name: LEAVING }));
    await user.click(
      screen.getByRole("button", { name: "Okta 계정으로 가입" }),
    );
    expect(starts()).toBe(1);
    // Back from the provider's page restores this one as it was left.
    window.dispatchEvent(new Event("pageshow"));
    await waitFor(() =>
      expect(held()).toEqual([[false], [false], [], [false]]),
    );
    await join();
    await waitFor(() => expect(starts()).toBe(2));
  });

  test("시작 요청이 나가 있는 동안 다른 단계로 갔다 와도 두 번째 시작은 없다", async () => {
    let answer: (response: Response) => void = () => {};
    const { api, left, history } = renderAt(`/invite/${TOKEN}`, {
      ...on(KEYCLOAK),
      [`POST ${START}`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const user = await setupUser();
    const starts = () =>
      api.calls.filter((c) => c.path.endsWith("/invite/start")).length;
    const fresh = () =>
      screen.findByRole("button", { name: "아니요, 처음입니다" });
    // The password step was visited, so the browser can go forward to it.
    await user.click(await fresh());
    await screen.findByLabelText("비밀번호");
    history.back();
    await join();
    await waitFor(() => expect(starts()).toBe(1));
    // The page is on its way to a provider: the password steps wait too.
    expect((await fresh()).hasAttribute("disabled")).toBe(true);
    await user.click(await fresh());
    expect(screen.queryAllByLabelText("비밀번호")).toHaveLength(0);
    // A step reached another way (the browser's forward) and left again
    // finds the start still out: it is the flow's, not the step's.
    history.forward();
    await screen.findByLabelText("비밀번호");
    expect(shown()).toBe(0);
    history.back();
    const again = await screen.findByRole("button", { name: LEAVING });
    expect(again.hasAttribute("disabled")).toBe(true);
    await user.click(again);
    expect(starts()).toBe(1);
    answer(json(200, { authorization_url: AUTHORIZE }));
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
  });

  for (const [name, methods] of [
    [
      "켜진 공급자가 없으면",
      () => json(200, { password: "on", providers: [] }),
    ],
    [
      "목록을 못 읽으면",
      () => apiError(503, "BACKEND_UNAVAILABLE", "storage down"),
    ],
  ] as const) {
    test(`${name} 비밀번호 단계만 있다`, async () => {
      const { api, services } = renderAt(`/invite/${TOKEN}`, {
        "GET /v1/auth/me": signedOut,
        "GET /v1/auth/login-methods": methods,
      });
      await screen.findByRole("button", { name: "아니요, 처음입니다" });
      // Not before the answer: nothing is there while the list is out either.
      await waitFor(() => {
        expect(api.calls.some((c) => c.path === "/v1/auth/login-methods")).toBe(
          true,
        );
        expect(services.queryClient.isFetching()).toBe(0);
      });
      expect(shown()).toBe(0);
    });
  }

  for (const [status, code, title] of [
    [410, "INVITE_EXPIRED", "쓸 수 없는 초대입니다"],
    [409, "INVITE_USED", "이미 수락한 초대입니다"],
  ] as const) {
    test(`살아 있지 않은 초대(${code})는 비밀번호 수락과 같은 안내를 보여 주고 어디로도 가지 않는다`, async () => {
      const { left } = renderAt(`/invite/${TOKEN}`, {
        ...on(KEYCLOAK),
        [`POST ${START}`]: () => apiError(status, code, "not live"),
      });
      await join();
      await screen.findByText(title);
      expect(shown()).toBe(0);
      expect(left).toEqual([]);
    });
  }

  test("그 밖의 거절은 까닭을 말하고 두 길을 그대로 둔다", async () => {
    const { left } = renderAt(`/invite/${TOKEN}`, {
      ...on(KEYCLOAK),
      [`POST ${START}`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "CONSOLE_ORIGIN is not set"),
    });
    await join();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
    );
    expect(left).toEqual([]);
    expect(
      screen.getByRole("button", { name: "아니요, 처음입니다" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Keycloak 계정으로 가입" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("비밀번호 단계로 넘어가면 공급자 버튼은 없다", async () => {
    renderAt(`/invite/${TOKEN}`, on(KEYCLOAK));
    const user = await setupUser();
    await screen.findByRole("button", { name: "Keycloak 계정으로 가입" });
    await user.click(
      screen.getByRole("button", { name: "아니요, 처음입니다" }),
    );
    await screen.findByLabelText("비밀번호");
    expect(shown()).toBe(0);
  });
});

describe("공급자 가입의 콜백", () => {
  const CALLBACK = "/auth/callback/0d6a3f1c-2b7e-4c58-9a1d-6e5f4a3b2c1d";
  const REFUSED =
    "가입하지 못했습니다 — 초대가 회수됐거나 만료됐을 수 있고, 공급자가 알려 준 계정 정보가 받아들여지지 않았을 수도 있습니다. 받은 초대 링크를 다시 열어 시도하고, 계속 안 되면 초대한 사람에게 문의하세요.";
  const notAccepted = {
    "POST /v1/auth/oidc/callback": () =>
      apiError(401, "UNAUTHORIZED", "Sign-in was not accepted"),
  };
  afterEach(() => sessionStorage.removeItem("ap.inviteFlow"));

  test("거절된 가입은 초대를 다시 열라고 말하고, 주소를 맞추라고 하지 않는다", async () => {
    // The invite was revoked meanwhile, or the provider did not vouch for
    // the address: the server answers both alike.
    sessionStorage.setItem("ap.inviteFlow", "s1");
    renderAt(`${CALLBACK}?code=c1&state=s1`, notAccepted);
    expect((await screen.findByRole("alert")).textContent).toBe(REFUSED);
    expect(sessionStorage.getItem("ap.inviteFlow")).toBeNull();
  });

  test("공급자에서 그만둔 가입도 초대를 다시 열라고 말하고, 아무것도 보내지 않는다", async () => {
    sessionStorage.setItem("ap.inviteFlow", "s1");
    const { api } = renderAt(`${CALLBACK}?state=s1`, notAccepted);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "가입을 마치지 못했습니다 — 받은 초대 링크를 다시 열어 시도하세요.",
    );
    expect(
      api.calls.filter((c) => c.path === "/v1/auth/oidc/callback"),
    ).toHaveLength(0);
  });

  test("시작했다가 그만둔 가입은 그 탭의 다음 로그인을 가입으로 읽게 하지 않는다", async () => {
    sessionStorage.setItem("ap.inviteFlow", "given-up");
    renderAt(`${CALLBACK}?code=c1&state=s1`, notAccepted);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 계정으로 로그인하지 못했습니다 — 초대받은 이메일 주소의 계정인지 확인하고 다시 시도하세요.",
    );
    expect(sessionStorage.getItem("ap.inviteFlow")).toBeNull();
  });

  test("초대 주소의 계정이 이미 있으면 그렇게 말하고 로그인 화면으로 이끈다", async () => {
    sessionStorage.setItem("ap.inviteFlow", "s1");
    renderAt(`${CALLBACK}?code=c1&state=s1`, {
      "POST /v1/auth/oidc/callback": () =>
        apiError(409, "LOGIN_LINK_REQUIRED", "An account exists"),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이미 이 이메일로 만든 계정이 있습니다 — 비밀번호로 로그인하세요.",
    );
    expect(
      screen
        .getByRole("link", { name: "로그인 화면으로" })
        .getAttribute("href"),
    ).toBe("/login");
  });
});
