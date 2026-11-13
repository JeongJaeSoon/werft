import { describe, expect, test } from "bun:test";
import type { LoginProviderView } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const LIST_PAGE = "/settings/workspace/login";
const API = "/v1/login-providers";
const AT = "2026-11-01T00:00:00.000Z";
const ID = "019a0000-0000-7000-8000-0000000000a1";
const PAGE = `${LIST_PAGE}/${ID}`;
const REDIRECT = `https://console.test/auth/callback/${ID}`;

const provider = (
  rest: Partial<LoginProviderView> = {},
): LoginProviderView => ({
  id: ID,
  display_name: "Acme SSO",
  issuer: "https://idp.example.com",
  redirect_uri: REDIRECT,
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
  userinfo_endpoint: null,
  endpoint_hosts: ["idp.example.com"],
  signing_algs: ["RS256"],
  pkce_advertised: true,
  discovery_checked_at: AT,
  client_id: null,
  token_auth_method: "client_secret_basic",
  client_secret: null,
  pending_client_secret: null,
  allowed_domains: [],
  jit_role: null,
  require_verified_email: true,
  state: "draft",
  tested_at: null,
  revision: 3,
  created_at: AT,
  updated_at: AT,
  ...rest,
});

const filled = (rest: Partial<LoginProviderView> = {}) =>
  provider({
    client_id: "werft-console",
    client_secret: { last4: "wxyz", updated_at: AT },
    state: "needs_test",
    ...rest,
  });

const routes = (
  providers: readonly LoginProviderView[],
  configured = true,
  signedIn = me(),
) => ({
  "GET /v1/auth/me": () => json(200, signedIn),
  [`GET ${API}`]: () =>
    json(200, { providers, console_origin_configured: configured }),
});

const writes = <C extends { readonly method: string }>(calls: readonly C[]) =>
  calls.filter((call) => call.method !== "GET");

const named = (dialog: HTMLElement, name: string) => {
  const input = dialog.querySelector<HTMLElement>(`[name="${name}"]`);
  if (input === null) throw new Error(`no field ${name}`);
  return input;
};

/** Why a button is withheld: null when it can be pressed. */
const withheld = (button: HTMLElement): string | null => {
  if (!(button as HTMLButtonElement).disabled) return null;
  return (button.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join("");
};

describe("로그인 공급자 목록", () => {
  test("someone who is not the owner sees neither the page nor its nav item, and nothing is asked", async () => {
    const { api } = renderAt(LIST_PAGE, routes([provider()], true, memberMe()));
    await screen.findByRole("heading", { level: 1, name: "로그인" });
    await waitFor(() =>
      expect(screen.queryByText("Acme SSO") === null).toBe(true),
    );
    expect(api.calls.some((call) => call.path === API)).toBe(false);
    const nav = screen.getByRole("navigation", { name: "설정" });
    expect(within(nav).queryByRole("link", { name: "로그인" }) === null).toBe(
      true,
    );
  });

  test("the owner sees each provider with where it stands, and the nav item", async () => {
    renderAt(
      LIST_PAGE,
      routes([
        provider(),
        filled({
          id: "019a0000-0000-7000-8000-0000000000a2",
          display_name: "Google",
          issuer: "https://accounts.google.com",
          state: "enabled",
          tested_at: AT,
        }),
      ]),
    );
    const table = await screen.findByRole("table", { name: "로그인" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Acme SSOhttps://idp.example.com초안"),
      expect.stringContaining("Googlehttps://accounts.google.com켜짐"),
    ]);
    expect(
      within(rows[0] as HTMLElement).getByText("테스트한 적 없음"),
    ).toBeTruthy();
    expect(
      within(table)
        .getByRole("link", { name: "Acme SSO" })
        .getAttribute("href"),
    ).toBe(PAGE);
    const nav = screen.getByRole("navigation", { name: "설정" });
    expect(
      within(nav).getByRole("link", { name: "로그인" }).getAttribute("href"),
    ).toBe(LIST_PAGE);
  });

  test("without CONSOLE_ORIGIN the page says why and offers no way to add one", async () => {
    renderAt(LIST_PAGE, routes([], false));
    await screen.findByText(/CONSOLE_ORIGIN/);
    expect(screen.queryByRole("button", { name: "공급자 추가" }) === null).toBe(
      true,
    );
  });

  test("adding sends the name and the issuer, and opens the new provider's page with its redirect URI", async () => {
    const made = provider();
    let listed: LoginProviderView[] = [];
    const { api, history } = renderAt(LIST_PAGE, {
      ...routes([]),
      [`GET ${API}`]: () =>
        json(200, { providers: listed, console_origin_configured: true }),
      [`POST ${API}`]: () => {
        listed = [made];
        return json(201, { provider: made });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "공급자 추가" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("이름"), " Acme SSO ");
    await user.type(
      within(dialog).getByLabelText("Issuer"),
      "https://idp.example.com",
    );
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await screen.findByText(REDIRECT);
    expect(history.location.pathname).toBe(PAGE);
    expect(writes(api.calls).map((call) => [call.path, call.body])).toEqual([
      [API, { display_name: "Acme SSO", issuer: "https://idp.example.com" }],
    ]);
  });

  test("an issuer the server cannot use is said in the dialog, which stays open", async () => {
    const { history } = renderAt(LIST_PAGE, {
      ...routes([]),
      [`POST ${API}`]: () =>
        apiError(400, "BAD_REQUEST", "no", false, { problem: "unreachable" }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "공급자 추가" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("이름"), "Acme");
    await user.type(
      within(dialog).getByLabelText("Issuer"),
      "https://idp.example.com",
    );
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "이 주소에서 응답을 받지 못했습니다",
    );
    expect(history.location.pathname).toBe(LIST_PAGE);
  });
});

describe("로그인 공급자 상세", () => {
  test("a draft shows what to register at the provider, and withholds the test and turning on with the reason", async () => {
    renderAt(PAGE, routes([provider()]));
    await screen.findByRole("heading", { level: 1, name: "Acme SSO" });
    expect(screen.getByText(REDIRECT)).toBeTruthy();
    expect(screen.getByText("idp.example.com")).toBeTruthy();
    expect(screen.getAllByText("아직 없음")).toHaveLength(2);
    const testing = screen.getByRole("button", { name: "테스트 로그인" });
    expect(withheld(testing)).toBe(
      "Client ID와 client secret을 먼저 넣으세요.",
    );
    expect(withheld(screen.getByRole("button", { name: "켜기" }))).toBe(
      "지금 설정으로 테스트 로그인이 통과해야 켤 수 있습니다.",
    );
  });

  test("the client is changed at the revision that was read", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([provider()]),
      [`PATCH ${API}/${ID}`]: () => json(200, { provider: provider() }),
    });
    const user = await setupUser();
    const row = (await screen.findByText("Client ID")).closest("li");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "바꾸기" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(named(dialog, "client_id"), "werft-console");
    await user.selectOptions(
      named(dialog, "token_auth_method"),
      "client_secret_post",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("저장했습니다.");
    const [patch] = writes(api.calls);
    expect(patch?.headers.get("If-Match")).toBe("3");
    expect(patch?.body).toEqual({
      client_id: "werft-console",
      token_auth_method: "client_secret_post",
    });
  });

  test("a change made on an older revision says so in the dialog and reads the provider again", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([provider()]),
      [`PATCH ${API}/${ID}`]: () =>
        apiError(412, "VERSION_MISMATCH", "no", false, { current_version: 4 }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "이름 바꾸기" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(named(dialog, "display_name"), "!");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "다른 곳에서 설정이 바뀌었습니다",
    );
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "GET" && call.path === API),
      ).toHaveLength(2),
    );
  });

  test("the client secret is sent once and only its last four characters are shown", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([filled()]),
      [`PUT ${API}/${ID}/client-secret`]: () =>
        json(200, { provider: filled() }),
    });
    const user = await setupUser();
    await screen.findByText("저장됨 ••••wxyz");
    await user.click(screen.getByRole("button", { name: "값 바꾸기" }));
    const dialog = await screen.findByRole("dialog");
    expect(named(dialog, "value").getAttribute("type")).toBe("password");
    await user.type(named(dialog, "value"), "typed-once");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("저장했습니다.");
    expect(writes(api.calls).map((call) => [call.path, call.body])).toEqual([
      [`${API}/${ID}/client-secret`, { value: "typed-once" }],
    ]);
    expect(document.body.textContent).not.toContain("typed-once");
  });

  test("once the client secret is on its way the page keeps it nowhere, the re-read still out or a refusal shown", async () => {
    // The write settles when the list has been read again; that read is
    // held, so the first check is made while the write is still pending.
    let hold = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refuse = false;
    const { services } = renderAt(PAGE, {
      ...routes([filled()]),
      [`GET ${API}`]: async () => {
        if (hold) await gate;
        return json(200, {
          providers: [filled()],
          console_origin_configured: true,
        });
      },
      [`PUT ${API}/${ID}/client-secret`]: () =>
        refuse
          ? apiError(503, "BACKEND_UNAVAILABLE", "no")
          : json(200, { provider: filled() }),
    });
    const kept = (value: string) =>
      JSON.stringify(
        services.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => [mutation.state.variables, mutation.state.data]),
      ).includes(value) ||
      [...document.querySelectorAll("input")].some(
        (input) => input.value === value,
      );
    const user = await setupUser();
    await screen.findByText("저장됨 ••••wxyz");
    await user.click(screen.getByRole("button", { name: "값 바꾸기" }));
    await user.type(
      named(await screen.findByRole("dialog"), "value"),
      "typed-once",
    );
    hold = true;
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText("저장했습니다.");
    // Busy, but not `disabled`: a browser will not focus a disabled button,
    // and the dialog that just closed hands the keyboard back to this one.
    const opener = screen.getByRole<HTMLButtonElement>("button", {
      name: "값 바꾸기",
    });
    expect([opener.getAttribute("aria-disabled"), opener.disabled]).toEqual([
      "true",
      false,
    ]);
    expect(document.activeElement === opener).toBe(true);
    expect(kept("typed-once")).toBe(false);
    hold = false;
    release();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "값 바꾸기" })
          .getAttribute("aria-disabled"),
      ).toBe(null),
    );
    expect(kept("typed-once")).toBe(false);

    // A refused value stays in the dialog's field, to be corrected, and
    // nowhere else; closing the dialog drops it.
    refuse = true;
    await user.click(screen.getByRole("button", { name: "값 바꾸기" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(named(dialog, "value"), "typed-twice");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await within(dialog).findByRole("alert");
    expect(
      JSON.stringify(
        services.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state),
      ),
    ).not.toContain("typed-twice");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(kept("typed-twice")).toBe(false);
  });

  test("a dialog gives the keyboard back to the button that opened it, cancelled or saved", async () => {
    renderAt(PAGE, {
      ...routes([filled()]),
      [`PATCH ${API}/${ID}`]: () => json(200, { provider: filled() }),
      [`PUT ${API}/${ID}/client-secret`]: () =>
        json(200, { provider: filled() }),
    });
    const user = await setupUser();
    const closed = () =>
      waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));

    const rename = await screen.findByRole("button", { name: "이름 바꾸기" });
    await user.click(rename);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "취소",
      }),
    );
    await closed();
    expect(document.activeElement === rename).toBe(true);

    await user.click(rename);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "저장",
      }),
    );
    await closed();
    expect(document.activeElement === rename).toBe(true);

    const secret = screen.getByRole("button", { name: "값 바꾸기" });
    await user.click(secret);
    const dialog = await screen.findByRole("dialog");
    await user.type(named(dialog, "value"), "typed-once");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await closed();
    expect(document.activeElement === secret).toBe(true);

    const row = screen.getByText("Client ID").closest("li") as HTMLElement;
    const client = within(row).getByRole("button", { name: "바꾸기" });
    await user.click(client);
    await user.keyboard("{Escape}");
    await closed();
    expect(document.activeElement === client).toBe(true);
  });

  test("a test sign-in leaves for the address the server gives", async () => {
    const { left, api } = renderAt(PAGE, {
      ...routes([filled()]),
      [`POST ${API}/${ID}/test/start`]: () =>
        json(200, { authorization_url: "https://idp.example.com/authorize?x" }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "테스트 로그인" }),
    );
    await waitFor(() =>
      expect(left).toEqual(["https://idp.example.com/authorize?x"]),
    );
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${API}/${ID}/test/start`,
    ]);
  });

  test("a provider whose test passed is turned on", async () => {
    const ready = filled({ state: "ready", tested_at: AT });
    const { api } = renderAt(PAGE, {
      ...routes([ready]),
      [`POST ${API}/${ID}/enable`]: () =>
        json(200, { provider: { ...ready, state: "enabled" } }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "켜기" }));
    await screen.findByText("켰습니다. 로그인 화면에 버튼이 나옵니다.");
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${API}/${ID}/enable`,
    ]);
  });

  test("while it is on, how it connects is withheld with the reason; a new secret is said to wait", async () => {
    renderAt(
      PAGE,
      routes([
        filled({
          state: "enabled_secret_pending",
          tested_at: AT,
          pending_client_secret: { last4: "9876", updated_at: AT },
        }),
      ]),
    );
    await screen.findByText(/새 값 ••••9876이 테스트를 기다립니다/);
    const locked =
      "켜진 동안에는 바꿀 수 없습니다. 끄고, 바꾸고, 테스트한 뒤 다시 켜세요.";
    for (const name of ["바꾸기", "다시 읽기"]) {
      const button = screen.getByRole("button", { name });
      expect(withheld(button)).toBe(locked);
    }
    expect(withheld(screen.getByRole("button", { name: "삭제" }))).toBe(
      "켜진 공급자는 끈 뒤에 지울 수 있습니다.",
    );
    expect(screen.queryByRole("button", { name: "켜기" }) === null).toBe(true);
    for (const name of ["테스트 로그인", "값 바꾸기", "끄기"]) {
      expect(withheld(screen.getByRole("button", { name }))).toBe(null);
    }
  });

  test("turning off is confirmed with what it ends, and says how many sessions ended", async () => {
    const on = filled({ state: "enabled", tested_at: AT });
    const { api } = renderAt(PAGE, {
      ...routes([on]),
      [`POST ${API}/${ID}/disable`]: () =>
        json(200, {
          provider: { ...on, state: "ready" },
          sessions_revoked: 2,
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "끄기" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("내 세션도 끊깁니다");
    expect(writes(api.calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "끄기" }));
    await screen.findByText("껐습니다. 세션 2개를 끊었습니다.");
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${API}/${ID}/disable`,
    ]);
  });

  const closedAccess = (enabled_providers: number) => ({
    "GET /v1/login-settings": () =>
      json(200, {
        settings: {
          password_login: "emergency_only",
          emergency_admin: null,
          enabled_providers,
        },
        emergency_admin_candidates: [],
      }),
  });
  const LAST =
    "비밀번호 로그인이 닫혀 있는 동안에는 켜진 마지막 공급자를 끌 수 없습니다. 비밀번호 로그인을 먼저 여세요.";

  test("while passwords are closed the last provider that is on is not turned off", async () => {
    renderAt(PAGE, {
      ...routes([filled({ state: "enabled", tested_at: AT })]),
      ...closedAccess(1),
    });
    await waitFor(() =>
      expect(withheld(screen.getByRole("button", { name: "끄기" }))).toBe(LAST),
    );
  });

  test("with another provider on it is turned off; a refusal that raced says why, and how many are on is read again", async () => {
    const on = filled({ state: "enabled", tested_at: AT });
    const { api } = renderAt(PAGE, {
      ...routes([on]),
      ...closedAccess(2),
      [`POST ${API}/${ID}/disable`]: () =>
        apiError(409, "REVISION_CONFLICT", "no", false, {
          reason_code: "last_provider",
        }),
    });
    const user = await setupUser();
    const off = await screen.findByRole("button", { name: "끄기" });
    await waitFor(() =>
      expect(api.calls.some((call) => call.path === "/v1/login-settings")).toBe(
        true,
      ),
    );
    expect(withheld(off)).toBe(null);
    await user.click(off);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "끄기" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(LAST);
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path === "/v1/login-settings").length,
      ).toBe(2),
    );
  });

  test("a provider that is off is deleted after a confirmation, and the list opens", async () => {
    let listed = [filled()];
    const { api, history } = renderAt(PAGE, {
      ...routes([]),
      [`GET ${API}`]: () =>
        json(200, { providers: listed, console_origin_configured: true }),
      [`DELETE ${API}/${ID}`]: () => {
        listed = [];
        return new Response(null, { status: 204 });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await screen.findByText("등록된 공급자가 없습니다.");
    expect(history.location.pathname).toBe(LIST_PAGE);
    expect(writes(api.calls).map((call) => call.method)).toEqual(["DELETE"]);
  });

  const openRules = async (user: Awaited<ReturnType<typeof setupUser>>) => {
    await user.click(
      await screen.findByRole("button", { name: "규칙 바꾸기" }),
    );
    return screen.findByRole("dialog");
  };

  test("who may come in is shown, and changed together at the revision that was read", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([filled({ allowed_domains: ["example.com"] })]),
      [`PATCH ${API}/${ID}`]: () => json(200, { provider: filled() }),
    });
    const user = await setupUser();
    const shown = (title: string) =>
      (screen.getByText(title).closest("li") as HTMLElement).textContent;
    await screen.findByText("허용 도메인");
    expect(shown("허용 도메인")).toContain("example.com");
    expect(shown("초대 없이 가입")).toContain("받지 않음");
    expect(shown("검증된 이메일")).toContain("요구함");

    const dialog = await openRules(user);
    const domains = named(dialog, "allowed_domains") as HTMLInputElement;
    expect(domains.value).toBe("example.com");
    await user.clear(domains);
    await user.type(domains, " Example.com,  corp.example.org ");
    await user.selectOptions(named(dialog, "jit_role"), "member");
    await user.selectOptions(named(dialog, "require_verified_email"), "false");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("저장했습니다.");
    const [patch] = writes(api.calls);
    expect(patch?.headers.get("If-Match")).toBe("3");
    expect(patch?.body).toEqual({
      allowed_domains: ["example.com", "corp.example.org"],
      jit_role: "member",
      require_verified_email: false,
    });
  });

  test("an emptied domain list and a turned-off join are sent as such, not left out", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([
        filled({ allowed_domains: ["example.com"], jit_role: "member" }),
      ]),
      [`PATCH ${API}/${ID}`]: () => json(200, { provider: filled() }),
    });
    const user = await setupUser();
    const dialog = await openRules(user);
    await user.clear(named(dialog, "allowed_domains"));
    await user.selectOptions(named(dialog, "jit_role"), "");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("저장했습니다.");
    expect(writes(api.calls)[0]?.body).toEqual({
      allowed_domains: [],
      jit_role: null,
      require_verified_email: true,
    });
  });

  test("a form filled before someone else's change is refused, then starts over on what they saved", async () => {
    // Another owner narrows the domains (revision 4) while this form is open.
    let stored = filled({ allowed_domains: ["example.com"] });
    const { api, services } = renderAt(PAGE, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${API}`]: () =>
        json(200, { providers: [stored], console_origin_configured: true }),
      [`PATCH ${API}/${ID}`]: (request) =>
        request.headers.get("If-Match") === String(stored.revision)
          ? json(200, { provider: stored })
          : apiError(412, "VERSION_MISMATCH", "no", false, {
              current_version: stored.revision,
            }),
    });
    const user = await setupUser();
    const dialog = await openRules(user);
    await user.clear(named(dialog, "allowed_domains"));
    stored = filled({ allowed_domains: ["corp.example.org"], revision: 4 });
    // The tab comes back and reads the list again under the open form.
    await services.queryClient.invalidateQueries();
    // The row behind the dialog shows it; the dialog has the same label.
    await waitFor(() =>
      expect(
        screen
          .getAllByText("허용 도메인")
          .map((label) => label.closest("li")?.textContent ?? "")
          .join(" "),
      ).toContain("corp.example.org"),
    );

    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "다른 곳에서 설정이 바뀌었습니다",
    );
    // The emptied list went under the revision it was typed over.
    const [refusedWrite] = writes(api.calls);
    expect(refusedWrite?.headers.get("If-Match")).toBe("3");
    expect(refusedWrite?.body).toMatchObject({ allowed_domains: [] });
    // What the form holds now is what the other owner saved.
    await waitFor(() =>
      expect((named(dialog, "allowed_domains") as HTMLInputElement).value).toBe(
        "corp.example.org",
      ),
    );

    await user.type(named(dialog, "allowed_domains"), ", example.com");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await screen.findByText("저장했습니다.");
    const [, accepted] = writes(api.calls);
    expect(accepted?.headers.get("If-Match")).toBe("4");
    expect(accepted?.body).toMatchObject({
      allowed_domains: ["corp.example.org", "example.com"],
    });
  });

  test("a Google provider is not offered an unverified email, and the server's refusal of its rules is said", async () => {
    const { api } = renderAt(PAGE, {
      ...routes([filled({ issuer: "https://accounts.google.com" })]),
      [`PATCH ${API}/${ID}`]: () =>
        apiError(400, "BAD_REQUEST", "no", false, {
          problem: "jit_requires_domains",
        }),
    });
    const user = await setupUser();
    const dialog = await openRules(user);
    expect(dialog.querySelector('[name="require_verified_email"]')).toBeNull();
    within(dialog).getByText("Google 공급자는 항상 요구합니다.");
    await user.selectOptions(named(dialog, "jit_role"), "member");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Google 공급자는 허용 도메인 없이 자동 가입을 켤 수 없습니다.",
    );
    // What the form does not hold is not sent: the stored value stands.
    expect(writes(api.calls)[0]?.body).toEqual({
      allowed_domains: [],
      jit_role: "member",
    });
  });

  test("an id that is not in the list says so", async () => {
    renderAt(PAGE, routes([]));
    await screen.findByText("이 공급자는 없습니다. 지워졌을 수 있습니다.");
  });
});

describe("테스트 로그인이 돌아온 화면", () => {
  const CALLBACK = `/auth/callback/${ID}?code=c&state=s`;
  const callback = (test: unknown) => ({
    "GET /v1/auth/me": () => json(200, me()),
    "POST /v1/auth/oidc/callback": () =>
      json(200, { outcome: "tested", provider_id: ID, test }),
  });

  test("a pass shows who the provider vouched for and what their sign-in would do, and goes nowhere", async () => {
    const { history } = renderAt(
      CALLBACK,
      callback({
        passed: true,
        recorded: true,
        subject: "sub-1001",
        email: "alice@example.com",
        email_verified: null,
        address_owned: false,
        entry: "refused",
      }),
    );
    await screen.findByRole("heading", {
      level: 1,
      name: "테스트 로그인 결과",
    });
    expect(screen.getByRole("status").textContent).toContain(
      "테스트가 통과했습니다.",
    );
    const terms = [...document.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(terms).toEqual([
      ["Subject (sub)", "sub-1001"],
      ["이메일", "alice@example.com"],
      ["email_verified", "보내지 않음"],
      [
        "주소 증명",
        "공급자가 이 주소를 증명하지 않습니다. 이 주소로는 계정을 찾지도, 가입시키지도 않습니다.",
      ],
      [
        "이 계정이 로그인하면",
        "거절됩니다. 연결된 계정이 꺼져 있거나, 공급자가 주소를 증명하지 않습니다.",
      ],
    ]);
    expect(
      screen
        .getByRole("link", { name: "공급자 설정으로" })
        .getAttribute("href"),
    ).toBe(PAGE);
    expect(history.location.pathname).toBe(`/auth/callback/${ID}`);
  });

  test("the result goes with the screen, and what the owner had read before the test stays", async () => {
    const { services } = renderAt(CALLBACK, {
      ...callback({
        passed: true,
        recorded: true,
        subject: "sub-1001",
        email: "alice@example.com",
        email_verified: true,
        address_owned: true,
        entry: "invite_only",
      }),
      [`GET ${API}`]: () =>
        json(200, { providers: [filled()], console_origin_configured: true }),
    });
    services.queryClient.setQueryData(["read-before-the-test"], "kept");
    const answers = () =>
      JSON.stringify(
        services.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data ?? null),
      );
    const user = await setupUser();
    const back = await screen.findByRole("link", { name: "공급자 설정으로" });
    expect(answers()).toContain("alice@example.com");
    expect(
      services.queryClient.getQueryData<string>(["read-before-the-test"]),
    ).toBe("kept");
    await user.click(back);
    await screen.findByRole("heading", { level: 1, name: "Acme SSO" });
    await waitFor(() => expect(answers()).not.toContain("alice@example.com"));
  });

  test("a pass that was not written down says to test again", async () => {
    renderAt(
      CALLBACK,
      callback({
        passed: true,
        recorded: false,
        subject: "sub-1001",
        email: null,
        email_verified: true,
        address_owned: true,
        entry: "invite_only",
      }),
    );
    await screen.findByText(/통과로 기록하지 않았습니다. 다시 테스트하세요./);
    expect(screen.queryByText("테스트가 통과했습니다.") === null).toBe(true);
  });

  test("a failed test shows its reason code", async () => {
    renderAt(CALLBACK, callback({ passed: false, reason: "code_refused" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "테스트가 실패했습니다.",
    );
    expect(screen.getByText("code_refused")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "공급자 설정으로" })
        .getAttribute("href"),
    ).toBe(PAGE);
  });
});
