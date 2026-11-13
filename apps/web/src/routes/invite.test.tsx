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
