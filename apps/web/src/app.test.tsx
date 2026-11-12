import { describe, expect, test } from "bun:test";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  fakeApi,
  json,
  me,
  type Recorded,
} from "./test-support/fake-api.ts";

const { render, screen, waitFor, within } = await setupDom();
// After the DOM exists: the router and Testing Library look for it on load.
const { createMemoryHistory } = await import("@tanstack/react-router");
const { App } = await import("./app.tsx");
const { useCan } = await import("./auth/guard.tsx");
const { ReasonButton } = await import("./auth/reason-button.tsx");
const { I18nProvider, useI18n } = await import("./i18n/i18n.tsx");
const { createServices } = await import("./services.tsx");
const { WerftProvider } = await import("@werft-ai/react");

type Routes = Parameters<typeof fakeApi>[0];

function renderAt(path: string, routes: Routes, locale: "ko" | "en" = "ko") {
  const api = fakeApi(routes);
  const services = createServices({
    baseUrl: "https://console.test",
    fetch: api.fetch,
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<App services={services} history={history} locale={locale} />);
  return { api, history, services };
}

const meOk = {
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
  // Home lists the waiting and recent sessions; an unrouted read would put
  // its error alert beside the one a test looks for.
  "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
};
const signedOut = () =>
  apiError(401, "UNAUTHORIZED", "Authentication is required");
const callsTo = (calls: Recorded[], path: string) =>
  calls.filter((call) => call.path === path);

describe("상태 화면", () => {
  test("확인 중에는 로딩 화면이다", async () => {
    renderAt("/", { "GET /v1/auth/me": () => new Promise(() => {}) });
    expect(
      await screen.findByText("로그인 상태를 확인하는 중입니다"),
    ).toBeDefined();
  });

  test("401이면 로그인 화면이 '로그인 필요' 문구로 열리고 돌아올 곳을 기억한다", async () => {
    const { history } = renderAt("/", {
      "GET /v1/auth/me": () =>
        apiError(401, "UNAUTHORIZED", "Authentication is required"),
    });
    expect(await screen.findByText("로그인이 필요합니다")).toBeDefined();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "로그인",
    );
    expect(history.location.pathname).toBe("/login");
    expect(history.location.search).toContain("redirect=%2F");
  });

  test("403이면 권한 없음 화면만 보이고 서버의 영어 문구는 보이지 않는다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () =>
        apiError(
          403,
          "FORBIDDEN",
          "This credential does not hold sessions:read",
        ),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("이 화면을 볼 권한이 없습니다");
    expect(document.body.textContent).not.toContain("does not hold");
    expect(document.body.textContent).not.toContain("sessions:read");
    expect(screen.queryByText("로그인이 필요합니다")).toBeNull();
  });

  // Nothing public says whether an owner exists, so the screen must not claim it.
  test("bootstrap 화면은 소유자 유무를 단정하지 않고 안내를 한 번만 한다", async () => {
    renderAt("/bootstrap", {});
    expect(
      await screen.findByRole("heading", { name: "첫 소유자 만들기" }),
    ).toBeDefined();
    expect(screen.queryByText("아직 소유자가 없습니다")).toBeNull();
    expect(screen.getAllByText(/설치 때 출력된/)).toHaveLength(1);
    expect(screen.queryByText("로그인이 필요합니다")).toBeNull();
    expect(screen.queryByText("이 화면을 볼 권한이 없습니다")).toBeNull();
  });

  test("네 상태의 제목이 서로 다르다", async () => {
    const { ko } = await import("./i18n/ko.ts");
    const titles = [
      ko["status.loading.title"],
      ko["status.loginRequired.title"],
      ko["status.forbidden.title"],
      ko["status.bootstrapRequired.title"],
    ];
    expect(new Set(titles).size).toBe(4);
  });
});

describe("workspace shell", () => {
  test("/auth/me의 사용자·워크스페이스와 bootstrap checklist를 보인다", async () => {
    renderAt("/", meOk);
    expect(await screen.findByRole("heading", { name: "홈" })).toBeDefined();
    expect(
      screen.getByText("설치 전체 현황과 워크스페이스 점검 항목입니다."),
    ).toBeDefined();
    const steps = within(
      await screen.findByRole("region", { name: "시작하기" }),
    ).getAllByRole("listitem");
    // This server answers neither the connections, members
    // nor agents: those steps are unreadable, not open.
    expect(steps.map((step) => step.getAttribute("data-state"))).toEqual([
      "done",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "todo",
    ]);
  });

  test("로그아웃은 서버에 알리고 캐시를 비운 뒤 로그인으로 간다", async () => {
    let signedIn = true;
    const { api, history, services } = renderAt("/", {
      ...meOk,
      "GET /v1/auth/me": () => (signedIn ? json(200, me()) : signedOut()),
      "POST /v1/auth/logout": () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    // A screen like the invite page may have cached the signed-in viewer;
    // the login gate must ask the server again, not trust it.
    services.queryClient.setQueryData(["me", "optional"], me());
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner owner@example.com · 소유자",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "로그아웃" }));
    expect(await screen.findByText("로그아웃했습니다.")).toBeDefined();
    expect(history.location.pathname).toBe("/login");
    const [logout] = callsTo(api.calls, "/v1/auth/logout");
    expect(logout?.headers.get("x-requested-with")).toBe("werft-web");
    expect(services.queryClient.getQueryData(["me"])).toBeUndefined();
  });
  test("로그아웃이 실패하면 로그인된 채로 남고 그렇게 말한다", async () => {
    const { history } = renderAt("/", {
      ...meOk,
      "POST /v1/auth/logout": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Storage is unavailable"),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner owner@example.com · 소유자",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "로그아웃" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "로그아웃하지 못해 아직 로그인된 상태입니다.",
    );
    expect(history.location.pathname).toBe("/");
    expect(screen.queryByText("로그아웃했습니다.")).toBeNull();
  });

  test("이미 끝난 세션의 로그아웃(401)은 로그아웃으로 친다", async () => {
    let signedIn = true;
    const { history } = renderAt("/", {
      ...meOk,
      "GET /v1/auth/me": () => (signedIn ? json(200, me()) : signedOut()),
      "POST /v1/auth/logout": () => {
        signedIn = false;
        return signedOut();
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner owner@example.com · 소유자",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "로그아웃" }));
    expect(await screen.findByText("로그아웃했습니다.")).toBeDefined();
    expect(history.location.pathname).toBe("/login");
  });

  test("캐시된 신원이 있어도 세션이 끝나면(401) 지우고 로그인으로 간다", async () => {
    let expired = false;
    const { history, services } = renderAt("/", {
      "GET /v1/auth/me": () =>
        expired
          ? apiError(401, "UNAUTHORIZED", "Authentication is required")
          : json(200, me()),
    });
    expect(await screen.findByRole("heading", { name: "홈" })).toBeDefined();
    expired = true;
    await services.queryClient.refetchQueries({ queryKey: ["me"] });
    expect(await screen.findByText("로그인이 필요합니다")).toBeDefined();
    expect(history.location.pathname).toBe("/login");
    expect(screen.queryByText("Acme")).toBeNull();
    expect(services.queryClient.getQueryData(["me"])).toBeUndefined();
  });
});

describe("로그인", () => {
  test("성공하면 캐시를 비우고 원래 가려던 곳으로 간다", async () => {
    let signedIn = false;
    const { api, history, services } = renderAt("/login?redirect=%2F", {
      ...meOk,
      "GET /v1/auth/me": () => (signedIn ? json(200, me()) : signedOut()),
      "POST /v1/auth/login": () => {
        signedIn = true;
        return json(200, {
          user_id: me().user?.id,
          workspace_id: me().workspace?.id,
          role: "owner",
          scopes: me().scopes,
          expires_at: "2026-10-12T00:00:00.000Z",
        });
      },
    });
    services.queryClient.setQueryData(["stale"], "from another account");
    const user = await setupUser();
    await user.type(
      await screen.findByLabelText("이메일"),
      "owner@example.com",
    );
    await user.type(screen.getByLabelText("비밀번호"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("heading", { name: "홈" })).toBeDefined();
    expect(history.location.pathname).toBe("/");
    expect(services.queryClient.getQueryData(["stale"])).toBeUndefined();
    expect(callsTo(api.calls, "/v1/auth/login")[0]?.body).toEqual({
      email: "owner@example.com",
      password: "correct horse battery",
    });
  });

  test("틀린 비밀번호와 잠금은 각자의 문구다", async () => {
    let attempt = 0;
    renderAt("/login", {
      "POST /v1/auth/login": () =>
        ++attempt === 1
          ? apiError(401, "UNAUTHORIZED", "Invalid email or password")
          : apiError(429, "RATE_LIMITED", "Too many attempts, try again later"),
    });
    const user = await setupUser();
    await user.type(
      await screen.findByLabelText("이메일"),
      "owner@example.com",
    );
    await user.type(screen.getByLabelText("비밀번호"), "wrong password!");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이메일 또는 비밀번호가 맞지 않습니다.",
    );
    await user.click(screen.getByRole("button", { name: "로그인" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "시도가 너무 많습니다 — 잠시 뒤 다시 시도하세요.",
      ),
    );
  });

  test("다른 origin으로 가는 redirect는 버린다", async () => {
    const { safeRedirect } = await import("./routes/login.tsx");
    expect(safeRedirect("/sessions?x=1")).toBe("/sessions?x=1");
    for (const bad of [
      "//evil.example",
      "https://evil.example",
      "/\\evil",
      "x",
    ]) {
      expect(safeRedirect(bad)).toBeUndefined();
    }
  });
});

describe("bootstrap", () => {
  async function fill() {
    const user = await setupUser();
    await user.type(
      await screen.findByLabelText("Bootstrap 토큰"),
      "t".repeat(40),
    );
    await user.type(
      screen.getByLabelText("소유자 이메일"),
      "owner@example.com",
    );
    await user.type(screen.getByLabelText("이름"), "Owner");
    await user.type(screen.getByLabelText("비밀번호"), "correct horse battery");
    await user.type(screen.getByLabelText("워크스페이스 이름"), "Acme");
    await user.type(
      screen.getByLabelText("워크스페이스 식별자 (slug)"),
      "acme",
    );
    await user.click(screen.getByRole("button", { name: "소유자 만들기" }));
  }

  test("입력 힌트는 이름이 아니라 설명으로 붙는다", async () => {
    renderAt("/bootstrap", {});
    const password = await screen.findByLabelText("비밀번호");
    const hint = document.getElementById(
      password.getAttribute("aria-describedby") ?? "",
    );
    expect(hint?.textContent).toBe("12자 이상");
  });

  test("만들고 나면 로그인으로 보낸다", async () => {
    const { api, history } = renderAt("/bootstrap", {
      "POST /v1/auth/bootstrap": () => json(201, {}),
    });
    await fill();
    expect(
      await screen.findByText(
        "소유자를 만들었습니다. 방금 정한 비밀번호로 로그인하세요.",
      ),
    ).toBeDefined();
    expect(history.location.pathname).toBe("/login");
    expect(callsTo(api.calls, "/v1/auth/bootstrap")[0]?.body).toMatchObject({
      email: "owner@example.com",
      workspace_slug: "acme",
    });
    expect((screen.getByLabelText("이메일") as HTMLInputElement).value).toBe(
      "owner@example.com",
    );
    expect(history.location.search).not.toContain("owner");
  });

  test("이미 소유자가 있으면(409) 그 자리에서 로그인 링크를 보인다", async () => {
    const { history } = renderAt("/bootstrap", {
      "POST /v1/auth/bootstrap": () =>
        apiError(409, "BOOTSTRAP_DONE", "owner@example.com tttttttt"),
    });
    await fill();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "이미 소유자가 있습니다. 로그인해 주세요.",
    );
    expect(alert.textContent).not.toContain("owner@example.com");
    expect(alert.textContent).not.toContain("tttttttt");
    expect(
      within(alert)
        .getByRole("link", { name: "로그인하기" })
        .getAttribute("href"),
    ).toBe("/login");
    expect(history.location.pathname).toBe("/bootstrap");
  });

  test("토큰이 틀리면(401) 토큰 문구다", async () => {
    renderAt("/bootstrap", {
      "POST /v1/auth/bootstrap": () =>
        apiError(401, "UNAUTHORIZED", "Bootstrap token is invalid"),
    });
    await fill();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Bootstrap 토큰이 맞지 않습니다");
    expect(within(alert).queryByRole("link")).toBeNull();
  });

  test("입력이 틀리면(400) 입력 문구이고 로그인 안내가 없다", async () => {
    renderAt("/bootstrap", {
      "POST /v1/auth/bootstrap": () =>
        apiError(400, "BAD_REQUEST", "Request body is invalid"),
    });
    await fill();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("입력을 확인하고 다시 보내세요.");
    expect(within(alert).queryByRole("link")).toBeNull();
  });
});

describe("권한 없는 버튼", () => {
  // What a screen does with a scope: the reason is set while it is missing.
  function RecoverButton({ onClick }: { onClick: () => void }) {
    const allowed = useCan("sessions:recover");
    const { t } = useI18n();
    return (
      <ReasonButton
        type="submit"
        onClick={onClick}
        reason={
          allowed
            ? undefined
            : t("guard.missingScope", { scope: "sessions:recover" })
        }
      >
        복구
      </ReasonButton>
    );
  }

  async function renderButton(scopes: Parameters<typeof me>[0]) {
    const services = createServices({ baseUrl: "https://console.test" });
    const { queryClient } = services;
    queryClient.setQueryData(["me"], me(scopes));
    const { QueryClientProvider } = await import("@tanstack/react-query");
    const pressed: string[] = [];
    render(
      <I18nProvider locale="ko">
        <QueryClientProvider client={queryClient}>
          <WerftProvider
            client={services.client}
            locale="ko"
            renderLink={({ children }) => children}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                pressed.push("submit");
              }}
            >
              <input aria-label="이름" />
              <RecoverButton onClick={() => pressed.push("click")} />
            </form>
          </WerftProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
    return { button: screen.getByRole("button", { name: "복구" }), pressed };
  }

  // The note is aria-hidden: the button reads its hidden copy instead.
  function note() {
    return document.querySelector('[role="tooltip"]');
  }

  test("scope가 없으면 누를 수 없게 두고, 이유는 설명으로 읽힌다", async () => {
    const { button } = await renderButton(["sessions:read"]);
    // Focusable, so the keyboard reaches the reason.
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe(
      "sessions:recover 권한이 있어야 할 수 있습니다.",
    );
    expect(note()).toBeNull();
  });

  test("scope가 없으면 누르거나 칸에서 Enter를 쳐도 아무 일도 없다", async () => {
    const user = await setupUser();
    const { button, pressed } = await renderButton(["sessions:read"]);
    await user.click(button);
    await user.type(screen.getByLabelText("이름"), "x{Enter}");
    expect(pressed).toEqual([]);
  });

  test("Tab으로 닿으면 이유가 보이고, Escape로 닫혀도 포커스는 버튼에 남는다", async () => {
    const user = await setupUser();
    const { button } = await renderButton(["sessions:read"]);
    screen.getByLabelText("이름").focus();
    await user.tab();
    expect(document.activeElement === button).toBe(true);
    await waitFor(() =>
      expect(note()?.textContent).toBe(
        "sessions:recover 권한이 있어야 할 수 있습니다.",
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(note()).toBeNull());
    expect(document.activeElement === button).toBe(true);
  });

  test("scope가 있으면 누를 수 있고 이유가 없다", async () => {
    const user = await setupUser();
    const { button, pressed } = await renderButton([
      "sessions:read",
      "sessions:recover",
    ]);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    await user.hover(button);
    expect(note()).toBeNull();
    await user.click(button);
    expect(pressed).toEqual(["click", "submit"]);
  });
});

describe("i18n·반응형·키보드", () => {
  test("en이면 영어로 그린다", async () => {
    renderAt("/login", {}, "en");
    expect(
      await screen.findByRole("heading", { name: "Log in" }),
    ).toBeDefined();
    expect(document.documentElement.lang).toBe("en");
  });

  test("언어를 바꾸면 바로 바뀐다", async () => {
    renderAt("/login", {});
    const user = await setupUser();
    await user.selectOptions(await screen.findByLabelText("언어"), "en");
    expect(
      await screen.findByRole("heading", { name: "Log in" }),
    ).toBeDefined();
  });

  test("일본어를 고르면 바로 바뀌고 다음 방문을 위해 기억한다", async () => {
    renderAt("/login", {});
    const user = await setupUser();
    const select = await screen.findByLabelText("언어");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["한국어", "日本語", "English"]);
    await user.selectOptions(select, "ja");
    expect(
      await screen.findByRole("heading", { name: "ログイン" }),
    ).toBeDefined();
    expect(document.documentElement.lang).toBe("ja");
    expect(localStorage.getItem("ap.locale")).toBe("ja");
    localStorage.removeItem("ap.locale");
  });

  test.each([360, 768, 1440])(
    "%ipx에서 shell이 같은 내용으로 그려진다",
    async (width) => {
      const { setViewport } = await import("@werft-ai/ui/test-support/dom");
      setViewport({ width, height: 800 });
      renderAt("/", meOk);
      expect(await screen.findByRole("heading", { name: "홈" })).toBeDefined();
      expect(
        screen.getByRole("button", {
          name: "Owner owner@example.com · 소유자",
        }),
      ).toBeDefined();
      expect(window.innerWidth).toBe(width);
    },
  );

  test("사용자 메뉴 버튼의 접근 이름은 보이는 이름으로 시작한다", async () => {
    renderAt("/", meOk);
    const trigger = await screen.findByRole("button", { name: /^Owner/ });
    // axe label-content-name-mismatch compares an aria-label with the
    // visible text, avatar letter included; the name comes from content.
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.textContent).toBe("OOwner owner@example.com · 소유자");
    // A long address is cut on screen; the title holds all of it.
    expect(
      within(trigger).getByText("owner@example.com").getAttribute("title"),
    ).toBe("owner@example.com");
  });

  test("본문 건너뛰기 링크가 처음 Tab에 잡힌다", async () => {
    renderAt("/login", {});
    await screen.findByRole("heading", { name: "로그인" });
    const user = await setupUser();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("본문으로 건너뛰기");
    expect(document.getElementById("main")).not.toBeNull();
  });
});
