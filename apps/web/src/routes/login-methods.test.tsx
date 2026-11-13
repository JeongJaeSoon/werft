import { afterEach, describe, expect, test } from "bun:test";
import {
  type ListMyLoginMethodsResponse,
  listMyLoginMethodsResponseSchema,
  type MyLoginMethod,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PAGE = "/settings/login-methods";
const API = "/v1/auth/me/login-methods";
const AT = "2026-11-01T00:00:00.000Z";
const PASSWORD_ID = "019a0000-0000-7000-8000-0000000000b1";
const ACME_ID = "019a0000-0000-7000-8000-0000000000b2";
const ACME_PROVIDER = "019a0000-0000-7000-8000-0000000000a1";
const OKTA_PROVIDER = "019a0000-0000-7000-8000-0000000000a2";
const LINK_FLOW_KEY = "ap.loginMethodLink";

const password = (rest: Partial<MyLoginMethod> = {}): MyLoginMethod => ({
  id: PASSWORD_ID,
  kind: "password",
  provider: null,
  issuer: null,
  email_at_link: null,
  created_at: AT,
  last_login_at: AT,
  usable: true,
  ...rest,
});

const acme = (rest: Partial<MyLoginMethod> = {}): MyLoginMethod => ({
  id: ACME_ID,
  kind: "oidc",
  provider: { id: ACME_PROVIDER, display_name: "Acme SSO", enabled: true },
  issuer: "https://idp.example.com",
  email_at_link: "owner@idp.example.com",
  created_at: AT,
  last_login_at: null,
  usable: true,
  ...rest,
});

const mine = (
  rest: Partial<ListMyLoginMethodsResponse> = {},
): ListMyLoginMethodsResponse => ({
  methods: [password(), acme()],
  linkable: [{ id: OKTA_PROVIDER, display_name: "Okta" }],
  can_change: true,
  ...rest,
});

const routes = (body: ListMyLoginMethodsResponse, signedIn = me()) => ({
  "GET /v1/auth/me": () => json(200, signedIn),
  [`GET ${API}`]: () => json(200, body),
});

const writes = <C extends { readonly method: string }>(calls: readonly C[]) =>
  calls.filter((call) => call.method !== "GET");

/** Why a button is withheld: null when it can be pressed. */
const withheld = (button: HTMLElement): string | null => {
  if (!(button as HTMLButtonElement).disabled) return null;
  return (button.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join("");
};

afterEach(() => sessionStorage.removeItem(LINK_FLOW_KEY));

describe("내 로그인 수단", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    for (const body of [
      mine(),
      mine({ methods: [password()], linkable: [], can_change: false }),
      mine({
        methods: [acme({ provider: null, usable: false })],
      }),
    ])
      expect(listMyLoginMethodsResponseSchema.safeParse(body).success).toBe(
        true,
      );
  });

  test("a member sees their own ways to sign in, what works, and what can be connected", async () => {
    renderAt(
      PAGE,
      routes(
        mine({
          methods: [
            password(),
            acme({
              provider: {
                id: ACME_PROVIDER,
                display_name: "Acme SSO",
                enabled: false,
              },
              usable: false,
            }),
          ],
        }),
        memberMe(),
      ),
    );
    await screen.findByRole("heading", { level: 1, name: "로그인 수단" });
    const nav = screen.getByRole("navigation", { name: "설정" });
    expect(
      within(nav).getByRole("link", { name: "로그인 수단" }),
    ).toBeDefined();
    const rows = await waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>('[data-slot="setting-row"]'),
      ];
      expect(found).toHaveLength(3);
      return found;
    });
    const [own, sso, okta] = rows.map((row) => row.textContent ?? "");
    expect(own).toContain("비밀번호");
    expect(own).toContain("마지막 로그인");
    expect(own).not.toContain("지금은 쓸 수 없음");
    expect(sso).toContain("Acme SSO");
    expect(sso).toContain("지금은 쓸 수 없음");
    expect(sso).toContain("https://idp.example.com");
    expect(sso).toContain("owner@idp.example.com");
    expect(sso).toContain("로그인한 적 없음");
    expect(okta).toContain("Okta");
    expect(screen.getByRole("button", { name: "Okta 연결" })).toBeDefined();
  });

  test("with no provider left to connect it says so", async () => {
    renderAt(PAGE, routes(mine({ linkable: [] })));
    expect(
      await screen.findByText("연결할 수 있는 공급자가 없습니다."),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /연결$/ }) === null).toBe(true);
  });

  test("connecting leaves for the address the server gives, and the tab remembers why", async () => {
    const { left, api } = renderAt(PAGE, {
      ...routes(mine()),
      [`POST ${API}/${OKTA_PROVIDER}/link/start`]: () =>
        json(200, {
          authorization_url: "https://okta.example.com/authorize?x",
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "Okta 연결" }));
    await waitFor(() =>
      expect(left).toEqual(["https://okta.example.com/authorize?x"]),
    );
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `${API}/${OKTA_PROVIDER}/link/start`,
    ]);
    expect(sessionStorage.getItem(LINK_FLOW_KEY)).toBe("1");
  });

  test("a connection the server refuses says why and goes nowhere", async () => {
    const cases: [Response, string][] = [
      [
        apiError(403, "FORBIDDEN", "Sign in again", false, {
          reason_code: "session_too_old",
        }),
        "로그인한 지 10분이 지났습니다. 다시 로그인한 뒤 바꾸세요.",
      ],
      [
        apiError(404, "NOT_FOUND", "Login provider not found"),
        "이 공급자는 지금 쓸 수 없습니다.",
      ],
    ];
    for (const [answer, text] of cases) {
      const { left, container } = renderAt(PAGE, {
        ...routes(mine()),
        [`POST ${API}/${OKTA_PROVIDER}/link/start`]: () => answer.clone(),
      });
      const user = await setupUser();
      await user.click(
        await within(container).findByRole("button", { name: "Okta 연결" }),
      );
      expect((await within(container).findByRole("alert")).textContent).toBe(
        text,
      );
      expect(left).toEqual([]);
      expect(sessionStorage.getItem(LINK_FLOW_KEY)).toBeNull();
    }
  });

  test("the only way that works cannot be removed, and the row says why", async () => {
    renderAt(
      PAGE,
      routes(mine({ methods: [password(), acme({ usable: false })] })),
    );
    expect(
      withheld(await screen.findByRole("button", { name: "비밀번호 끊기" })),
    ).toBe("쓸 수 있는 로그인 수단이 이것뿐이라 끊을 수 없습니다.");
    // The one that does not work can go.
    expect(
      withheld(screen.getByRole("button", { name: "Acme SSO 끊기" })),
    ).toBeNull();
  });

  test("a session older than ten minutes changes nothing, and the page says how to", async () => {
    const { api } = renderAt(PAGE, routes(mine({ can_change: false })));
    const reason = "로그인한 지 10분이 지났습니다. 다시 로그인한 뒤 바꾸세요.";
    for (const name of ["비밀번호 끊기", "Acme SSO 끊기", "Okta 연결"])
      expect(withheld(await screen.findByRole("button", { name }))).toBe(
        reason,
      );
    expect(
      screen.getByText(
        "로그인한 지 10분이 지나 지금은 바꿀 수 없습니다. 로그아웃하고 다시 로그인한 뒤 바꾸세요.",
      ),
    ).toBeDefined();
    expect(writes(api.calls)).toEqual([]);
  });

  test("removing the password asks first, says it cannot be set again, and reports the sessions ended", async () => {
    let listed = 0;
    const { api } = renderAt(PAGE, {
      ...routes(mine()),
      [`GET ${API}`]: () => {
        listed += 1;
        return json(200, listed === 1 ? mine() : mine({ methods: [acme()] }));
      },
      [`DELETE ${API}/${PASSWORD_ID}`]: () =>
        json(200, {
          sessions_revoked: 2,
          receipt_id: "019a0000-0000-7000-8000-0000000000c1",
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "비밀번호 끊기" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "비밀번호 로그인을 끊을까요?",
    });
    expect(dialog.textContent).toContain(
      "비밀번호가 지워지고, 다시 정할 수 없습니다.",
    );
    expect(writes(api.calls)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "끊기" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(
      await screen.findByText("끊었습니다. 세션 2개가 로그아웃됐습니다."),
    ).toBeDefined();
    expect(
      writes(api.calls).map((call) => `${call.method} ${call.path}`),
    ).toEqual([`DELETE ${API}/${PASSWORD_ID}`]);
    // Read again: the row is gone, and what is left is now the last one.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "비밀번호 끊기" }) === null,
      ).toBe(true),
    );
    expect(
      withheld(screen.getByRole("button", { name: "Acme SSO 끊기" })),
    ).toBe("쓸 수 있는 로그인 수단이 이것뿐이라 끊을 수 없습니다.");
  });

  test("removing a provider account names the address it was connected with", async () => {
    renderAt(PAGE, routes(mine()));
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Acme SSO 끊기" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Acme SSO 로그인을 끊을까요?",
    });
    expect(dialog.textContent).toContain("owner@idp.example.com");
    expect(dialog.textContent).toContain("나중에 다시 연결할 수 있습니다.");
    expect(dialog.textContent).not.toContain("다시 정할 수 없습니다");
  });

  test("a removal the server refuses stays in the dialog with its reason, and the list is read again", async () => {
    const cases: [Response, string][] = [
      [
        apiError(409, "REVISION_CONFLICT", "The only way", false, {
          reason_code: "last_login_method",
        }),
        "쓸 수 있는 로그인 수단이 이것뿐이라 끊을 수 없습니다.",
      ],
      [
        apiError(403, "FORBIDDEN", "Sign in again", false, {
          reason_code: "session_too_old",
        }),
        "로그인한 지 10분이 지났습니다. 다시 로그인한 뒤 바꾸세요.",
      ],
      [
        apiError(404, "NOT_FOUND", "No such way to sign in"),
        "이미 없는 로그인 수단입니다.",
      ],
    ];
    for (const [answer, text] of cases) {
      let listed = 0;
      const { container } = renderAt(PAGE, {
        ...routes(mine()),
        [`GET ${API}`]: () => {
          listed += 1;
          return json(200, mine());
        },
        [`DELETE ${API}/${ACME_ID}`]: () => answer.clone(),
      });
      const user = await setupUser();
      await user.click(
        await within(container).findByRole("button", { name: "Acme SSO 끊기" }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "끊기" }));
      expect((await within(dialog).findByRole("alert")).textContent).toBe(text);
      await waitFor(() => expect(listed).toBe(2));
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog") === null).toBe(true),
      );
    }
  });
});

describe("연결의 콜백", () => {
  const CALLBACK = `/auth/callback/${OKTA_PROVIDER}?code=c1&state=s1`;

  test("a link that went through comes back to the sign-in methods, read there", async () => {
    sessionStorage.setItem(LINK_FLOW_KEY, "1");
    sessionStorage.setItem("ap.postLoginPath", "/members");
    const { history } = renderAt(CALLBACK, {
      ...routes(mine({ linkable: [] })),
      "POST /v1/auth/oidc/callback": () =>
        json(200, { outcome: "linked", provider_id: OKTA_PROVIDER }),
    });
    await waitFor(() => expect(history.location.pathname).toBe(PAGE));
    await screen.findByRole("heading", { level: 1, name: "로그인 수단" });
    await screen.findByText("Acme SSO");
    // The tab forgets the link; where a sign-in would have gone is not spent.
    expect(sessionStorage.getItem(LINK_FLOW_KEY)).toBeNull();
    expect(sessionStorage.getItem("ap.postLoginPath")).toBe("/members");
    sessionStorage.removeItem("ap.postLoginPath");
  });

  test("a refused link says whose the account is and leads back to the sign-in methods", async () => {
    const cases: [string, string][] = [
      [
        "login_method_linked",
        "이 공급자 계정은 이미 다른 사용자에게 연결돼 있습니다.",
      ],
      [
        "issuer_linked",
        "이 공급자의 다른 계정이 이미 내 계정에 연결돼 있습니다. 먼저 그 연결을 끊으세요.",
      ],
    ];
    for (const [reason, text] of cases) {
      sessionStorage.setItem(LINK_FLOW_KEY, "1");
      const { container } = renderAt(CALLBACK, {
        ...routes(mine()),
        "POST /v1/auth/oidc/callback": () =>
          apiError(409, "ALREADY_EXISTS", "Connected already", false, {
            reason_code: reason,
          }),
      });
      expect((await within(container).findByRole("alert")).textContent).toBe(
        text,
      );
      expect(
        within(container)
          .getByRole("link", { name: "로그인 수단으로 돌아가기" })
          .getAttribute("href"),
      ).toBe(PAGE);
      expect(sessionStorage.getItem(LINK_FLOW_KEY)).toBeNull();
    }
  });

  test("a refused sign-in still leads back to the login page", async () => {
    const { container } = renderAt(CALLBACK, {
      "POST /v1/auth/oidc/callback": () =>
        apiError(401, "UNAUTHORIZED", "Sign-in was not accepted"),
    });
    await within(container).findByRole("alert");
    expect(
      within(container)
        .getByRole("link", { name: "로그인 화면으로" })
        .getAttribute("href"),
    ).toBe("/login");
  });
});
