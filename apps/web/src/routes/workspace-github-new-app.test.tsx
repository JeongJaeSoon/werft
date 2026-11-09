import { afterEach, describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  GITHUB_SETTINGS,
  githubConnection,
  githubSettings,
  json,
  me,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { cleanup, renderAt, screen, waitFor, within } = await appHarness();
const { githubNavigation } = await import("./workspace-github-new-app.tsx");

const PATH = "/settings/workspace/integrations/github";
const APPS = `/v1/workspaces/${WORKSPACE_ID}/github-apps`;
const APP = `${APPS}/author`;
const START = `${APP}/manifest`;
const COMPLETE = `${APP}/manifest/complete`;
const CONN_NEW = "0d3a5c1e-7b2f-4e6a-9c1d-2b3a4c5d6e7f";
const GITHUB_APP = {
  connection_id: CONN_NEW,
  app_id: 4242,
  slug: "werft-test",
  name: "werft test",
  html_url: "https://github.com/apps/werft-test",
  private_key: { updated_at: "2026-10-30T05:00:00.000Z", updated_by: null },
  created_at: "2026-10-30T05:00:00.000Z",
  updated_at: "2026-10-30T05:00:00.000Z",
};
const STARTED = {
  action_url:
    "https://github.com/organizations/acme/settings/apps/new?state=s1",
  manifest: '{"name":"werft-acme-1a2b"}',
  expires_at: "2026-11-01T10:00:00.000Z",
};
const refusal = (status: number, code: string, details: object) =>
  json(status, {
    error: {
      code,
      message: "server words",
      retryable: false,
      request_id: "req-1",
      details,
    },
  });

const posted: Array<{ url: string; manifest: string }> = [];
const assigned: string[] = [];
githubNavigation.post = (url, manifest) => {
  posted.push({ url, manifest });
};
githubNavigation.assign = (url) => {
  assigned.push(url);
};
afterEach(() => {
  posted.length = 0;
  assigned.length = 0;
});

const settingsRoutes = (settings = githubSettings()) => ({
  "GET /v1/auth/me": () => json(200, me()),
  [`GET ${GITHUB_SETTINGS}`]: () => json(200, settings),
  [`GET ${APPS}`]: () => json(200, { github_apps: [] }),
});

/** The empty card's "GitHub App 만들기", which opens the add dialog on its form. */
async function openNewApp(user: Awaited<ReturnType<typeof setupUser>>) {
  const card = within(await screen.findByRole("region", { name: "GitHub" }));
  await user.click(
    await card.findByRole("button", { name: "GitHub App 만들기" }),
  );
  return screen.findByRole("dialog", { name: "새 App 만들기" });
}

describe("새 GitHub App 만들기", () => {
  test("조직과 비공개가 기본이고, 조직 이름 없이는 보내지 않으며, 보낸 manifest를 GitHub로 POST한다", async () => {
    const { api } = renderAt(PATH, {
      ...settingsRoutes(),
      [`POST ${START}`]: () => json(200, STARTED),
    });
    const user = await setupUser();
    await openNewApp(user);
    const login = await screen.findByLabelText("조직 이름");
    await waitFor(() => expect(document.activeElement === login).toBe(true));
    expect(
      (screen.getByRole("radio", { name: "조직" }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "이 계정에서만 (비공개 App)" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    expect(
      await screen.findByText(
        "GitHub 조직 이름(영문·숫자·하이픈, 39자 이하)을 적어 주세요.",
      ),
    ).toBeDefined();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);

    await user.type(login, "acme");
    await user.click(
      screen.getByRole("checkbox", { name: "Actions·워크플로 권한도 받기" }),
    );
    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: STARTED.action_url,
      manifest: STARTED.manifest,
    });
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([
      {
        owner: { kind: "organization", login: "acme" },
        public: false,
        actions: true,
        replace: false,
      },
    ]);
  });

  test("개인 계정과 공개를 고르면 그대로 보낸다", async () => {
    const { api } = renderAt(PATH, {
      ...settingsRoutes(),
      [`POST ${START}`]: () =>
        json(200, {
          ...STARTED,
          action_url: "https://github.com/settings/apps/new?state=s2",
        }),
    });
    const user = await setupUser();
    await openNewApp(user);
    await user.click(
      await screen.findByRole("radio", { name: "내 개인 계정" }),
    );
    expect(screen.queryByLabelText("조직 이름") === null).toBe(true);
    await user.click(
      screen.getByRole("radio", { name: "여러 조직에서 (공개 App)" }),
    );
    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([
      { owner: { kind: "user" }, public: true, actions: false, replace: false },
    ]);
  });

  test("CONSOLE_ORIGIN이 없으면 이유를 보이고 만들기를 막는다", async () => {
    const { api } = renderAt(
      PATH,
      settingsRoutes(githubSettings({ callback_url: null })),
    );
    const user = await setupUser();
    await openNewApp(user);
    const submit = await screen.findByRole("button", {
      name: "GitHub에서 만들기",
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/CONSOLE_ORIGIN이 설정되지 않아/)).toBeDefined();
    expect(submit.getAttribute("aria-describedby")).toBeTruthy();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("App이 있어도 App 추가에서 새로 만들고, GitHub로 넘긴 뒤에는 다시 보내지 않는다", async () => {
    const { api } = renderAt(PATH, {
      ...settingsRoutes({
        ...githubSettings(),
        connections: [githubConnection()],
      }),
      [`POST ${START}`]: () => json(200, STARTED),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "App 추가" }));
    const choose = await screen.findByRole("dialog", { name: "App 추가" });
    await user.click(
      within(choose).getByRole("button", { name: "새 App 만들기" }),
    );
    await user.type(await screen.findByLabelText("조직 이름"), "acme");
    const submit = screen.getByRole("button", { name: "GitHub에서 만들기" });
    await user.click(submit);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([expect.objectContaining({ replace: false })]);
    // Handed off to GitHub: another click mints no second state.
    await user.click(submit);
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);

    // Back from GitHub restores the page from the bfcache: the form works again.
    const back = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(back, "persisted", { value: true });
    window.dispatchEvent(back);
    await user.click(submit);
    await waitFor(() => expect(posted).toHaveLength(2));
  });
});

describe("GitHub에서 돌아온 화면", () => {
  const CALLBACK = "/settings/workspace/integrations/github/new-app";
  const INSTALL_START = `${APPS}/${CONN_NEW}/installations/start`;

  test("code와 state를 한 번 보내고, 주소에서 지운 뒤 연결한 사람을 남기는 설치 화면으로 보낸다", async () => {
    const { api, history } = renderAt(`${CALLBACK}?code=c0de&state=st4te`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${COMPLETE}`]: () =>
        json(200, {
          github_app: GITHUB_APP,
          install_url: "https://github.com/apps/werft-test/installations/new",
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        }),
      [`POST ${INSTALL_START}`]: () =>
        json(200, {
          install_url:
            "https://github.com/apps/werft-test/installations/new?state=i1",
          expires_at: "2026-11-01T10:00:00.000Z",
        }),
    });
    await waitFor(() =>
      expect(assigned).toEqual([
        "https://github.com/apps/werft-test/installations/new?state=i1",
      ]),
    );
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual([COMPLETE, INSTALL_START]);
    expect(api.calls.find((call) => call.path === COMPLETE)?.body).toEqual({
      code: "c0de",
      state: "st4te",
    });
    // Replaced, not pushed: Back does not return to the code either.
    await waitFor(() => expect(history.location.search).toBe(""));
    expect(history.location.pathname).toBe(CALLBACK);
    expect(history.length).toBe(1);
    expect(
      await screen.findByText("App을 저장했습니다. 설치 화면으로 이동합니다."),
    ).toBeDefined();
  });

  test("설치 시작이 실패해도 GitHub가 준 설치 화면으로 보낸다", async () => {
    renderAt(`${CALLBACK}?code=c0de&state=st4te`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${COMPLETE}`]: () =>
        json(200, {
          github_app: GITHUB_APP,
          install_url: "https://github.com/apps/werft-test/installations/new",
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        }),
      [`POST ${INSTALL_START}`]: () => refusal(503, "BACKEND_UNAVAILABLE", {}),
    });
    await waitFor(() =>
      expect(assigned).toEqual([
        "https://github.com/apps/werft-test/installations/new",
      ]),
    );
  });

  test("키를 저장하지 못했으면 '이미 있는 App 연결' 안내와 GitHub의 App 링크를 보인다", async () => {
    renderAt(`${CALLBACK}?code=c0de&state=st4te`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${COMPLETE}`]: () =>
        refusal(503, "BACKEND_UNAVAILABLE", {
          reason_code: "store_failed",
          app_id: 9,
          html_url: "https://github.com/apps/werft-acme-1a2b",
        }),
    });
    expect(
      await screen.findByText(/키를 저장하지 못했습니다.*이미 있는 App 연결/),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: /GitHub에서 App 열기/ })
        .getAttribute("href"),
    ).toBe("https://github.com/apps/werft-acme-1a2b");
    expect(assigned).toEqual([]);
  });

  test("state가 없거나 거절되면 다시 시작하라고 알린다", async () => {
    const { api } = renderAt(CALLBACK, {
      "GET /v1/auth/me": () => json(200, me()),
    });
    expect(
      await screen.findByText(/만료되었거나 이미 쓰였습니다/),
    ).toBeDefined();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    expect(screen.getByRole("link", { name: "연동 › GitHub로" })).toBeDefined();
  });

  test("서버가 state를 거절하면 다시 시작하라고 알리고, 바뀐 App이면 GitHub의 App 링크를 준다", async () => {
    renderAt(`${CALLBACK}?code=c0de&state=used`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${COMPLETE}`]: () =>
        refusal(400, "BAD_REQUEST", { reason_code: "state_invalid" }),
    });
    expect(
      await screen.findByText(/만료되었거나 이미 쓰였습니다/),
    ).toBeDefined();
    expect(
      screen.queryByRole("link", { name: /GitHub에서 App 열기/ }) === null,
    ).toBe(true);
    cleanup();

    renderAt(`${CALLBACK}?code=c0de&state=raced`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${COMPLETE}`]: () =>
        refusal(409, "GITHUB_APP_CONFLICT", {
          reason_code: "author_app_changed",
          app_id: 9,
          html_url: "https://github.com/apps/werft-acme-1a2b",
        }),
    });
    expect(await screen.findByText(/그사이 다른 App이 등록되어/)).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: /GitHub에서 App 열기/ })
        .getAttribute("href"),
    ).toBe("https://github.com/apps/werft-acme-1a2b");
  });
});
