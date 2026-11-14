import { describe, expect, test } from "bun:test";
import { json, me, memberMe, WORKSPACE_ID } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const harness = await appHarness();
const { screen, waitFor, within } = harness;

const APPS = `/v1/workspaces/${WORKSPACE_ID}/slack/apps`;
const SLACK = "/settings/workspace/integrations/slack";
const EMPTY = "이 콘솔이 만든 Slack 앱이 아직 없습니다.";
// The token card above the list, settled so the page stops loading.
const CONFIG = `/v1/workspaces/${WORKSPACE_ID}/slack/config-token`;
const UNSET = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
  urls: { redirect_url: null, events_url_template: null },
  state: "unset",
  expires_at: null,
  issuer: null,
};
const AGENT_ID = "019a0000-0000-7000-8000-0000000000c1";
const NO_SECRET = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
};

function app(
  kind: "agent" | "link",
  state: "creating" | "created" | "deleting",
  appId: string | null,
  clientSecret = false,
) {
  const made = {
    id: crypto.randomUUID(),
    kind,
    agent_id: kind === "agent" ? AGENT_ID : null,
    state,
    app_id: appId,
    client_id: appId === null ? null : "1000.1",
    redirect_url: "https://console.example.test/callback",
    created_by_token_user: "U0ISSUER",
    created_at: "2026-10-01T00:20:00.000Z",
    updated_at: "2026-10-23T12:48:00.000Z",
    secrets: {
      slack_signing_secret: NO_SECRET,
      slack_client_secret: NO_SECRET,
      slack_bot_token: NO_SECRET,
    },
  };
  const { secrets } = made;
  return {
    ...made,
    secrets: {
      ...secrets,
      slack_client_secret: {
        ...secrets.slack_client_secret,
        configured: clientSecret,
      },
    },
  };
}
const agent = (installed: boolean, name = "Release Notes") => ({
  id: AGENT_ID,
  name,
  slug: "release-notes",
  installed,
});

describe("연동 › Slack의 자동으로 만든 Slack 앱", () => {
  test("소유자는 계정 연결 앱과 에이전트 앱을 상태와 함께 본다", async () => {
    harness.renderAt(SLACK, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APPS}`]: () =>
        json(200, {
          items: [
            {
              slack_app: app("link", "created", "A07LINK000", true),
              agent: null,
            },
            {
              slack_app: app("agent", "created", "A07PLACEHLD"),
              agent: agent(true),
            },
            {
              slack_app: app("agent", "created", "A07SECOND1"),
              agent: agent(false, "Draft"),
            },
            {
              slack_app: app("agent", "creating", null),
              agent: agent(false, "Pending"),
            },
          ],
        }),
    });

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const section = screen
      .getByRole("heading", { level: 3, name: "자동으로 만든 Slack 앱" })
      .closest("section");
    expect(section?.id).toBe("slack-apps");
    expect(section?.contains(table)).toBe(true);
    expect(
      screen.getByRole("heading", { level: 1, name: "연동" }),
    ).toBeTruthy();

    const link = within(rows[0] as HTMLElement);
    expect(link.getByText("계정 연결 앱")).toBeTruthy();
    expect(link.getByText("A07LINK000")).toBeTruthy();
    expect(link.getByText("연결됨")).toBeTruthy();
    expect(link.getByText("Sign in with Slack")).toBeTruthy();
    expect(link.queryByRole("link")).toBeNull();

    const installed = within(rows[1] as HTMLElement);
    expect(installed.getByText("Release Notes 앱")).toBeTruthy();
    expect(installed.getByText("연결됨")).toBeTruthy();
    expect(installed.getByText("@release-notes")).toBeTruthy();
    expect(
      installed
        .getByRole("link", { name: "Release Notes" })
        .getAttribute("href"),
    ).toBe(`/agents/${AGENT_ID}`);
    expect(
      installed
        .getByRole("link", { name: /^자세히\s?: Release Notes 앱$/ })
        .getAttribute("href"),
    ).toBe(`/agents/${AGENT_ID}?tab=slack`);

    // A narrow table drops the agent and time columns; the app cell says them.
    expect(table.dataset.narrowAt).toBe("640");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .filter((head) => head.dataset.hideNarrow === "true")
        .map((head) => head.textContent),
    ).toEqual(["에이전트", "갱신"]);
    const [appCell] = installed.getAllByRole("cell");
    const narrow = [...(appCell?.querySelectorAll("span") ?? [])].find((line) =>
      line.className.includes("[@container(max-width:640px)]:block"),
    );
    expect(narrow?.textContent).toStartWith("Release Notes · ");
    expect(narrow?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-23T12:48:00.000Z",
    );

    expect(within(rows[2] as HTMLElement).getByText("설치 전")).toBeTruthy();
    const creating = within(rows[3] as HTMLElement);
    expect(creating.getByText("만드는 중")).toBeTruthy();
    expect(creating.getByText("앱 ID 없음")).toBeTruthy();
  });

  test("연결 앱은 client secret이 있어야, 에이전트 앱은 kind로 연결됨을 판단한다", async () => {
    harness.renderAt(SLACK, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APPS}`]: () =>
        json(200, {
          items: [
            { slack_app: app("link", "created", "A07LINK000"), agent: null },
            { slack_app: app("agent", "created", "A07ORPHAN1"), agent: null },
          ],
        }),
    });

    const table = await screen.findByRole("table");
    const [link, orphan] = within(table).getAllByRole("row").slice(1);
    const linkRow = within(link as HTMLElement);
    expect(linkRow.getByText("계정 연결 앱")).toBeTruthy();
    expect(linkRow.getByText("비밀값 없음")).toBeTruthy();
    expect(linkRow.queryByText("연결됨")).toBeNull();
    const orphanRow = within(orphan as HTMLElement);
    expect(orphanRow.queryByText("계정 연결 앱")).toBeNull();
    expect(orphanRow.getByText("설치 전")).toBeTruthy();
  });

  test("만든 앱이 없으면 빈 상태를 보인다", async () => {
    harness.renderAt(SLACK, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APPS}`]: () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText("이 콘솔이 만든 Slack 앱이 아직 없습니다."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("설정 메뉴에는 연동 한 항목만 있고 옛 두 항목과 앱 목록 항목은 없다", async () => {
    harness.renderAt(SLACK, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APPS}`]: () => json(200, { items: [] }),
    });
    await screen.findByText("이 콘솔이 만든 Slack 앱이 아직 없습니다.");
    const nav = screen.getByRole("navigation", { name: "설정" });
    expect(
      within(nav).getByRole("link", { name: "연동" }).getAttribute("href"),
    ).toBe("/settings/workspace/integrations/slack");
    expect(
      within(nav).queryByRole("link", { name: "Slack 연결 설정" }),
    ).toBeNull();
    expect(
      within(nav).queryByRole("link", { name: "GitHub 연결 설정" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "자동으로 만든 Slack 앱" }),
    ).toBeNull();
  });

  test("앱 목록 절은 Slack 카드 안 토큰 아래에 오고, 게스트 카드와 위험 구역이 뒤따른다", async () => {
    harness.renderAt(SLACK, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${CONFIG}`]: () =>
        json(200, {
          ...UNSET,
          configured: true,
          last4: "f76d",
          updated_at: "2026-10-23T12:48:00.000Z",
          state: "active",
        }),
      [`GET ${APPS}`]: () => json(200, { items: [] }),
    });
    await screen.findByText(EMPTY);
    const card = screen.getByRole("region", { name: "Slack" });
    expect(
      within(card)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Slack 앱 생성",
      "Slack 앱에 넣을 주소",
      "이벤트 입구 주소",
      "자동으로 만든 Slack 앱",
    ]);
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Slack", "Slack 게스트", "위험 구역"]);
  });

  test.each(["/settings/workspace/slack-apps", "/settings/workspace/slack"])(
    "예전 주소 %s는 어디로도 보내지 않고 찾을 수 없음 화면이다",
    async (old) => {
      const { history } = harness.renderAt(old, {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${APPS}`]: () => json(200, { items: [] }),
      });
      expect(await screen.findByText("찾을 수 없는 화면입니다")).toBeTruthy();
      expect(history.location.pathname).toBe(old);
      expect(
        screen.queryByText("이 콘솔이 만든 Slack 앱이 아직 없습니다."),
      ).toBeNull();
    },
  );

  test("앵커로 들어오면 목록이 그려진 뒤 그 절로 스크롤한다", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    // The router also scrolls on render, before the cards above have loaded.
    Element.prototype.scrollIntoView = function (this: Element) {
      if (this.textContent?.includes(EMPTY)) scrolled.push(this);
    };
    try {
      harness.renderAt(`${SLACK}#slack-apps`, {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${CONFIG}`]: () => json(200, UNSET),
        [`GET ${APPS}`]: () => json(200, { items: [] }),
      });
      await screen.findByText("이 콘솔이 만든 Slack 앱이 아직 없습니다.");
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]?.id).toBe("slack-apps");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  test("앵커 없이 열면 스크롤하지 않는다", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      harness.renderAt(SLACK, {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${CONFIG}`]: () => json(200, UNSET),
        [`GET ${APPS}`]: () => json(200, { items: [] }),
      });
      await screen.findByText("이 콘솔이 만든 Slack 앱이 아직 없습니다.");
      expect(scrolled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  test("구성원은 목록을 부르지 않는다", async () => {
    const calls: string[] = [];
    harness.renderAt(SLACK, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET ${APPS}`]: () => {
        calls.push(APPS);
        return json(200, { items: [] });
      },
    });
    expect(
      (await screen.findAllByText(/워크스페이스 설정 변경/)).length,
    ).toBeGreaterThan(0);
    // The Slack card says why; the list it cannot read is not drawn.
    expect(
      screen.queryByRole("heading", { name: "자동으로 만든 Slack 앱" }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });
});
