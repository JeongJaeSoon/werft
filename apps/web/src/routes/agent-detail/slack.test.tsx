import { describe, expect, test } from "bun:test";
import type { components } from "@werft-ai/client";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
const PATH = `/v1/agents/${AGENT_ID}`;
const DETAIL = `/agents/${AGENT_ID}?tab=slack`;
const ID = "00000000-0000-4000-8000-000000000001";
const AT = "2026-10-24T00:00:00.000Z";
const summary = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
};
const APP: NonNullable<
  components["schemas"]["GetSlackAppResponse"]["slack_app"]
> = {
  id: ID,
  kind: "agent",
  agent_id: AGENT_ID,
  state: "created",
  app_id: "A123",
  client_id: "123",
  redirect_url: `https://console.test/agents/${AGENT_ID}/slack/callback`,
  created_by_token_user: "U123",
  created_at: AT,
  updated_at: AT,
  secrets: {
    slack_signing_secret: summary,
    slack_client_secret: summary,
    slack_bot_token: summary,
  },
};
const appResponse = (
  app: typeof APP | null,
  warnings: components["schemas"]["GetSlackAppResponse"]["warnings"] = [],
  configToken: components["schemas"]["GetSlackAppResponse"]["config_token"] = "active",
): components["schemas"]["GetSlackAppResponse"] => ({
  slack_app: app,
  event_url: null,
  events: { state: "pending", checked_at: null, url: null },
  warnings,
  config_token: configToken,
});
const IDENTITY: components["schemas"]["ListAgentIdentitiesResponse"]["items"][number] =
  {
    id: ID,
    agent_id: AGENT_ID,
    provider: "slack_bot",
    app_id: "A123",
    team_id: "T123",
    bot_user_id: "U123",
    credential_ref: "slack/bot",
    status: "active",
    revision: 0,
    created_by: null,
    created_at: AT,
    revoked_at: null,
  };
const BINDING: components["schemas"]["ListSlackBindingsResponse"]["items"][number] =
  {
    id: ID,
    workspace_id: WORKSPACE_ID,
    owner_id: WORKSPACE_ID,
    surface: "slack",
    installation_id: ID,
    external_surface_id: "C123",
    surface_kind: "public_channel",
    agent_id: AGENT_ID,
    mode: "on",
    ceiling: { actions: ["session.read"], disclosure: "summary" },
    home: true,
    memory_write_policy: "deny",
    status: "ready",
    muted: false,
    revision: 0,
    created_at: AT,
    revoked_at: null,
  };
// The home of a test whose own channel is not it.
const HOME_ROW: typeof BINDING = {
  ...BINDING,
  id: "00000000-0000-4000-8000-0000000000aa",
  external_surface_id: "C0HOME",
};
function routes(app: typeof APP | null = null, installed = false) {
  return {
    ...agentServer().routes,
    "GET /v1/auth/me": () => json(200, me()),
    [`GET ${PATH}/slack/app`]: () => json(200, appResponse(app)),
    [`GET ${PATH}/identities`]: () =>
      json(200, { items: installed ? [IDENTITY] : [] }),
    // An installed agent already has its home unless a test says otherwise.
    [`GET ${PATH}/slack-bindings`]: () =>
      json(200, { items: installed ? [BINDING] : [] }),
    [`GET ${PATH}/slack/app/settings`]: () => json(200, { mention_only: true }),
    [`GET ${PATH}/slack/channels`]: () =>
      json(200, {
        items: [],
        next_cursor: null,
        stale: false,
        truncated: false,
      }),
  };
}

describe("Slack management", () => {
  test("a failed read asks again for that query only and saves nothing", async () => {
    let down = true;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        down
          ? apiError(500, "INTERNAL_ERROR", "down")
          : json(200, { items: [BINDING] }),
    });
    const user = await setupUser();
    const state = await screen.findByRole("region", { name: "상태" });
    const alert = await within(state).findByRole("alert");
    expect(alert.textContent).toContain("불러오지 못했습니다");
    expect(alert.textContent).toContain("INTERNAL_ERROR");
    const reads = (path: string) =>
      api.calls.filter((c) => c.method === "GET" && c.path === path).length;
    const before = {
      app: reads(`${PATH}/slack/app`),
      identities: reads(`${PATH}/identities`),
      bindings: reads(`${PATH}/slack-bindings`),
    };
    down = false;
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(within(state).queryByRole("alert") === null).toBe(true),
    );
    await screen.findByRole("switch", { name: "DM 받기" });
    expect(reads(`${PATH}/slack-bindings`)).toBeGreaterThan(before.bindings);
    expect(reads(`${PATH}/slack/app`)).toBe(before.app);
    expect(reads(`${PATH}/identities`)).toBe(before.identities);
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("a setting row whose read failed offers to read it again, apart from save errors", async () => {
    let down = true;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/app/settings`]: () =>
        down
          ? apiError(500, "INTERNAL_ERROR", "down")
          : json(200, { mention_only: true }),
    });
    const user = await setupUser();
    const basic = await screen.findByRole("region", { name: "기본" });
    const again = await within(basic).findByRole("button", {
      name: "다시 시도",
    });
    const [alert] = within(basic).getAllByRole("alert");
    expect(within(basic).getAllByRole("alert")).toHaveLength(1);
    // Nothing was read yet, so the full failure state, not the kept alert.
    expect(alert?.getAttribute("data-variant") === "red").toBe(false);
    expect(basic.querySelector(".werft-state__code")?.textContent).toBe(
      "INTERNAL_ERROR",
    );
    down = false;
    await user.click(again);
    expect(
      await within(basic).findByRole("switch", { name: "멘션했을 때만 반응" }),
    ).toBeTruthy();
    expect(within(basic).queryByRole("alert") === null).toBe(true);
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("does not claim there are no channels when bindings or search failed", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        apiError(403, "FORBIDDEN", "refused"),
      [`GET ${PATH}/slack/channels`]: () =>
        apiError(403, "FORBIDDEN", "refused"),
    });
    const user = await setupUser();
    await screen.findByText("홈 채널");
    await waitFor(() =>
      expect(document.querySelector("main [role=alert]") !== null).toBe(true),
    );
    const state = screen.getByRole("region", { name: "상태" });
    // Home and DM both read as unknown.
    await waitFor(() =>
      expect(within(state).getAllByText("—")).toHaveLength(2),
    );
    expect(screen.queryByText("설정 안 됨") === null).toBe(true);
    expect(screen.queryByRole("switch", { name: "DM 받기" }) === null).toBe(
      true,
    );
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await waitFor(() =>
      expect(document.querySelector("main [role=alert]") !== null).toBe(true),
    );
    expect(screen.queryByText("연결된 채널이 없습니다") === null).toBe(true);
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    expect(
      screen.queryByText(
        "찾은 채널이 없습니다. 비공개 채널은 먼저 /invite로 초대하세요.",
      ) === null,
    ).toBe(true);
  });

  test("asks for the home channel first and omits empty search result borders", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [] }),
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await screen.findByRole("heading", { name: "홈 채널 지정" });
    // Channels and basic settings wait for the home; advanced stays.
    expect(screen.queryByRole("region", { name: "기본" })).toBeNull();
    expect(screen.queryByRole("button", { name: "채널 추가" })).toBeNull();
    expect(screen.queryByText("연결된 채널이 없습니다")).toBeNull();
    expect(screen.getByRole("region", { name: "고급" })).toBeDefined();
    expect(screen.getByRole("region", { name: "위험 구역" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "기본" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "홈 채널 고르기" }));
    await screen.findByText(
      "찾은 채널이 없습니다. 비공개 채널은 먼저 /invite로 초대하세요.",
    );
    expect(
      document.querySelector(
        "[data-slot=dialog-content] [data-slot=row-list]",
      ) === null,
    ).toBe(true);
  });

  test("the channels section says every channel member reads the replies, managing team or not", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [] }),
    });
    const heading = await screen.findByRole("heading", {
      name: "홈 채널 지정",
    });
    const section = heading.closest("section") as HTMLElement;
    expect(
      within(section).getByText(
        "이 채널의 모든 사람이 답을 읽습니다. 담당 팀 밖 사람도 포함됩니다.",
      ),
    ).toBeDefined();
  });

  test("offers no channel actions until the bindings say which step it is", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: async () => {
        await gate;
        return json(200, { items: [] });
      },
    });
    await screen.findByRole("region", { name: "고급" });
    expect(screen.queryByRole("button", { name: "채널 추가" })).toBeNull();
    expect(screen.queryByRole("button", { name: "홈 지정" })).toBeNull();
    release();
    await screen.findByRole("button", { name: "홈 채널 고르기" });
    expect(screen.queryByRole("button", { name: "채널 추가" })).toBeNull();
    expect(screen.queryByRole("region", { name: "기본" })).toBeNull();
  });

  test("shows DM immediately but keeps the home placeholder until channel names arrive", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, {
          items: [
            BINDING,
            {
              ...BINDING,
              id: "00000000-0000-4000-8000-000000000002",
              external_surface_id: null,
              surface_kind: "dm",
              home: false,
              mode: "off",
            },
          ],
        }),
      [`GET ${PATH}/slack/channels`]: async () => {
        await gate;
        return json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        });
      },
    });
    try {
      const status = await screen.findByRole("region", { name: "상태" });
      await waitFor(() =>
        expect(within(status).queryByText("꺼짐") !== null).toBe(true),
      );
      expect(within(status).queryByText("채널 ID: C123") === null).toBe(true);
    } finally {
      release();
    }
    await screen.findByText("#general");
  });

  test("includes the visible English home action in its accessible name", async () => {
    renderAt(
      DETAIL,
      {
        ...routes(APP, true),
        [`GET ${PATH}/slack/channels`]: () =>
          json(200, {
            items: [
              {
                id: "C123",
                name: "general",
                is_private: false,
                is_member: true,
              },
            ],
            next_cursor: null,
            stale: false,
            truncated: false,
          }),
      },
      "en",
    );
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack sections" });
    await user.click(screen.getByRole("button", { name: "Set home" }));
    expect(
      await screen.findByRole("button", { name: "Set home: #general" }),
    ).toBeDefined();
  });

  test("resolves the overview home from one shared first page", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [BINDING] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: "next",
          stale: false,
          truncated: false,
        }),
    });
    const status = await screen.findByRole("region", { name: "상태" });
    await waitFor(() => expect(status.textContent).toContain("#general"));
    expect(
      api.calls.filter((call) => call.path === `${PATH}/slack/channels`),
    ).toHaveLength(1);
  });

  test("labels unresolved bindings as channel IDs without scanning every channel page", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [BINDING] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            {
              id: "C999",
              name: "another-channel",
              is_private: false,
              is_member: true,
            },
          ],
          next_cursor: "next-page",
          stale: false,
          truncated: false,
        }),
    });
    await screen.findByRole("navigation", { name: "Slack 구역" });
    const list = await screen.findByRole("list", { name: "연결된 채널" });
    expect(await within(list).findByText("채널 ID: C123")).toBeDefined();
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path === `${PATH}/slack/channels`),
      ).toHaveLength(1),
    );
    expect(within(list).queryByText("#C123")).toBeNull();
  });

  test("reads DM and home in the status row and jumps to a section from the side list", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, {
          items: [
            BINDING,
            {
              ...BINDING,
              id: "00000000-0000-4000-8000-000000000002",
              external_surface_id: null,
              surface_kind: "dm",
              home: false,
              mode: "off",
            },
          ],
        }),
    });
    const user = await setupUser();
    const status = await screen.findByRole("region", { name: "상태" });
    await waitFor(() => expect(status.textContent).toContain("C123"));
    expect(within(status).getByText("꺼짐")).toBeDefined();
    const nav = screen.getByRole("navigation", { name: "Slack 구역" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["채널", "기본", "고급", "위험 구역"]);
    expect(within(nav).getByRole("group", { name: "관리" })).toBeDefined();
    const danger = within(nav).getByRole("link", { name: "위험 구역" });
    expect(danger.getAttribute("href")).toBe("#slack-danger");
    await user.click(danger);
    expect(danger.getAttribute("aria-current")).toBe("location");
    expect(
      within(nav)
        .getByRole("link", { name: "채널" })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(
      document.activeElement ===
        screen.getByRole("region", { name: "위험 구역" }),
    ).toBe(true);
    // The router owns the location; the jump stays off the hash.
    expect(window.location.hash).toBe("");
    expect(
      api.calls.filter((call) => call.path === `${PATH}/slack-bindings`),
    ).toHaveLength(1);
  });

  test("hides the wide section list while the whole page fits the window", async () => {
    const root = document.documentElement;
    let pageHeight = 900;
    Object.defineProperty(root, "clientHeight", {
      configurable: true,
      get: () => 900,
    });
    Object.defineProperty(root, "scrollHeight", {
      configurable: true,
      get: () => pageHeight,
    });
    try {
      renderAt(DETAIL, routes(APP, true));
      const nav = await screen.findByRole("navigation", { name: "Slack 구역" });
      // A page that fits from the start never shows the list.
      expect(nav.classList.contains("lg:hidden")).toBe(true);
      pageHeight = 2000;
      window.dispatchEvent(new Event("resize"));
      await waitFor(() =>
        expect(nav.classList.contains("lg:hidden")).toBe(false),
      );
      const link = within(nav).getByRole("link", { name: "기본" });
      link.focus();
      // happy-dom applies no stylesheet: lay the list out as lg:hidden would.
      nav.getClientRects = () => [] as unknown as DOMRectList;
      pageHeight = 900;
      window.dispatchEvent(new Event("resize"));
      await waitFor(() =>
        expect(nav.classList.contains("lg:hidden")).toBe(true),
      );
      // Focus leaves the hidden list for the section it stands for.
      const here = nav.querySelector("a[aria-current=location]");
      expect(`#${document.activeElement?.id}`).toBe(
        here?.getAttribute("href") ?? "",
      );
      // Below lg the folded button stays; widening past lg hides it while
      // the page still fits.
      nav.getClientRects = () => [new DOMRect()] as unknown as DOMRectList;
      within(nav)
        .getByRole("button", { name: /^Slack 구역/ })
        .focus();
      window.dispatchEvent(new Event("resize"));
      expect(document.activeElement?.closest("nav") === nav).toBe(true);
      nav.getClientRects = () => [] as unknown as DOMRectList;
      window.dispatchEvent(new Event("resize"));
      expect(
        `#${document.activeElement?.id}` ===
          nav.querySelector("a[aria-current=location]")?.getAttribute("href"),
      ).toBe(true);
      pageHeight = 1200;
      window.dispatchEvent(new Event("resize"));
      await waitFor(() =>
        expect(nav.classList.contains("lg:hidden")).toBe(false),
      );
      // Another tab's short page says nothing about this one: the panel is
      // hidden, so the measured Slack body has no boxes.
      const body = nav.nextElementSibling?.firstElementChild as HTMLElement;
      body.getClientRects = () => [] as unknown as DOMRectList;
      pageHeight = 900;
      window.dispatchEvent(new Event("resize"));
      await new Promise((done) => setTimeout(done, 100));
      expect(nav.classList.contains("lg:hidden")).toBe(false);
      // Shown again, the same resize does hide it.
      Reflect.deleteProperty(body, "getClientRects");
      window.dispatchEvent(new Event("resize"));
      await waitFor(() =>
        expect(nav.classList.contains("lg:hidden")).toBe(true),
      );
    } finally {
      Reflect.deleteProperty(root, "clientHeight");
      Reflect.deleteProperty(root, "scrollHeight");
    }
  });

  test("folds the narrow list after a pick and leaves focus on the section", async () => {
    renderAt(DETAIL, routes(APP, true));
    const user = await setupUser();
    const nav = await screen.findByRole("navigation", { name: "Slack 구역" });
    const toggle = within(nav).getByRole("button", { name: /^Slack 구역/ });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(within(nav).getByRole("link", { name: "고급" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("고급");
    expect(
      document.activeElement === screen.getByRole("region", { name: "고급" }),
    ).toBe(true);
  });

  test("gives a channel one switch, its use, and no mention choice of its own", async () => {
    let row: typeof BINDING = { ...BINDING };
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [row] }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        row = { ...row, mode: (await request.json()).mode };
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    const list = await screen.findByRole("list", { name: "연결된 채널" });
    const use = await within(list).findByRole("switch", {
      name: "채널 ID: C123에서 사용",
    });
    expect(within(list).getAllByRole("switch")).toEqual([use]);
    expect(list.textContent).not.toContain("멘션");
    expect(list.textContent).not.toContain("꺼짐");
    expect(use.getAttribute("aria-checked")).toBe("true");
    const puts = () =>
      api.calls
        .filter((call) => call.method === "PUT")
        .map((call) => (call.body as { mode: string }).mode);
    await user.click(use);
    await waitFor(() => expect(use.getAttribute("aria-checked")).toBe("false"));
    await user.click(use);
    await waitFor(() => expect(use.getAttribute("aria-checked")).toBe("true"));
    expect(puts()).toEqual(["off", "on"]);
  });

  test("shows the public or private tag beside the row's control, in the picker and the list", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
            { id: "G9", name: "secret", is_private: true, is_member: true },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
    });
    const user = await setupUser();
    const list = await screen.findByRole("list", { name: "연결된 채널" });
    // The list row carries its tag in the control column, next to the switch.
    const use = within(list).getByRole("switch");
    const connected = within(use.closest("li") as HTMLElement);
    expect(connected.getByText("공개").parentElement).toBe(use.parentElement);
    await user.click(screen.getByRole("button", { name: "채널 추가" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("#secret");
    for (const [channel, tag] of [
      ["general", "공개"],
      ["secret", "비공개"],
    ] as const) {
      const button = within(dialog).getByRole("button", {
        name: `#${channel} 연결`,
      });
      const item = within(button.closest("li") as HTMLElement);
      // Same container as the action, not the description under the name.
      expect(item.getByText(tag).parentElement).toBe(button.parentElement);
    }
  });

  test("saves the channel picked in the home step as in use and home, then opens the tab", async () => {
    let items: (typeof BINDING)[] = [{ ...BINDING, home: false, mode: "off" }];
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
            { id: "G9", name: "secret", is_private: true, is_member: false },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        items = [{ ...BINDING, mode: body.mode, home: body.home }];
        return json(200, { slack_binding: items[0], receipt_id: ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("heading", { name: "홈 채널 지정" });
    await user.click(screen.getByRole("button", { name: "홈 채널 고르기" }));
    const dialog = screen.getByRole("dialog");
    // A private channel tells how to let the bot in before it is picked.
    await within(dialog).findByText("#secret");
    expect(within(dialog).getAllByText("/invite 필요")).toHaveLength(1);
    await user.click(
      within(dialog).getByRole("button", { name: "#general 홈 지정" }),
    );
    await screen.findByRole("heading", { name: "연결된 채널" });
    expect(screen.getByRole("region", { name: "기본" })).toBeDefined();
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      channel_id: "C123",
      mode: "on",
      home: true,
      ceiling: BINDING.ceiling,
    });
  });

  test("changes home from the picker while preserving the channel mode and ceiling", async () => {
    let row = { ...BINDING, home: false, mode: "off" as const };
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, { items: [{ ...HOME_ROW, home: !row.home }, row] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        row = { ...row, home: body.home };
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await user.click(await screen.findByRole("button", { name: "홈 지정" }));
    await user.click(
      await screen.findByRole("button", { name: "#general 홈 지정" }),
    );
    await screen.findByText("홈 채널을 지정했습니다.");
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "홈 지정" }),
      ).toBe(true),
    );
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      channel_id: "C123",
      mode: "off",
      home: true,
      ceiling: BINDING.ceiling,
    });
  });

  test("saves mention-only for the whole agent with a toast, and connects a new channel in use", async () => {
    let items: (typeof BINDING)[] = [HOME_ROW];
    let mentionOnly = false;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items }),
      [`GET ${PATH}/slack/app/settings`]: () =>
        json(200, { mention_only: mentionOnly }),
      [`PUT ${PATH}/slack/app/settings`]: async (request: Request) => {
        mentionOnly = (await request.json()).mention_only;
        return json(200, { mention_only: mentionOnly });
      },
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            {
              id: "C123",
              name: "general",
              is_private: false,
              is_member: false,
            },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        const row = { ...BINDING, mode: body.mode, home: body.home };
        items = [HOME_ROW, row];
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    const basic = screen.getByRole("region", { name: "기본" });
    const toggle = await within(basic).findByRole("switch", {
      name: "멘션했을 때만 반응",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("false"),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      within(basic).getByText(
        "켜면 @멘션했을 때만, 끄면 멘션 없이 채널에 쓴 글에도 반응합니다. 어느 쪽이든 이미 대화 중인 스레드의 답글에는 멘션 없이도 답합니다.",
      ),
    ).toBeDefined();
    await user.click(toggle);
    const toast = await screen.findByText("@멘션했을 때만 반응합니다.");
    expect(toast.closest("[data-slot=toast]")).not.toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // The row keeps no saved sentence of its own; the status reads on/off.
    expect(basic.textContent).not.toContain("@멘션했을 때만 반응합니다.");
    const saved = api.calls.find(
      (call) =>
        call.method === "PUT" && call.path === `${PATH}/slack/app/settings`,
    );
    expect(saved?.body).toEqual({ mention_only: true });
    expect(
      (saved?.headers.get("Idempotency-Key") ?? "").length,
    ).toBeGreaterThan(0);
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    await user.click(
      await screen.findByRole("button", { name: "#general 연결" }),
    );
    await screen.findByText("채널을 연결했습니다.");
    expect(document.querySelector("[data-slot=toast]")?.tagName).toBe("OUTPUT");
    expect(
      api.calls
        .filter(
          (call) =>
            call.method === "PUT" && call.path === `${PATH}/slack-bindings`,
        )
        .map((call) => call.body),
    ).toEqual([{ channel_id: "C123", mode: "on", home: false }]);
  });

  test("asks for /invite only on a private channel the bot has not joined", async () => {
    const row = (
      id: string,
      kind: "public_channel" | "private_channel",
      state: "joined" | "awaiting_invite" | "join_failed" | null,
    ) => ({
      ...BINDING,
      id: `${ID.slice(0, -1)}${id.at(-1)}`,
      external_surface_id: id,
      surface_kind: kind,
      home: false,
      ...(state ? { membership: { state, error: null } } : {}),
    });
    const channel = (id: string, name: string, isPrivate: boolean) => ({
      id,
      name,
      is_private: isPrivate,
      is_member: false,
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, {
          items: [
            HOME_ROW,
            row("C1", "public_channel", "joined"),
            row("C2", "private_channel", "awaiting_invite"),
            row("C3", "public_channel", "join_failed"),
            row("C4", "private_channel", null),
            row("C5", "public_channel", null),
            // The server's membership wins over a channel list that lags.
            row("C6", "private_channel", "joined"),
          ],
        }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            channel("C1", "pub-joined", false),
            channel("C2", "priv-waiting", true),
            channel("C3", "pub-failed", false),
            channel("C4", "priv-unchecked", true),
            channel("C5", "pub-unchecked", false),
            channel("C6", "priv-joined", true),
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
    });
    const user = await setupUser();
    const list = await screen.findByRole("list", { name: "연결된 채널" });
    await within(list).findByText("#priv-waiting");
    const hinted = (scope: HTMLElement) =>
      within(scope)
        .queryAllByText("/invite 필요")
        .map(
          (badge) =>
            badge.closest("[data-slot=setting-row], li")?.textContent ?? "",
        );
    expect(hinted(list).map((text) => text.match(/#[a-z-]+/)?.[0])).toEqual([
      "#priv-waiting",
      "#priv-unchecked",
    ]);
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("#pub-joined");
    expect(hinted(dialog).map((text) => text.match(/#[a-z-]+/)?.[0])).toEqual([
      "#priv-waiting",
      "#priv-unchecked",
    ]);
  });

  for (const refused of [false, true]) {
    test(`connects a new channel in use while mention-only is ${refused ? "unreadable" : "loading"}`, async () => {
      const { api } = renderAt(DETAIL, {
        ...routes(APP, true),
        [`GET ${PATH}/slack/app/settings`]: () =>
          refused
            ? apiError(403, "FORBIDDEN", "internal message")
            : new Promise<Response>(() => {}),
        [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [HOME_ROW] }),
        [`PUT ${PATH}/slack-bindings`]: () =>
          json(200, {
            slack_binding: { ...BINDING, home: false },
            receipt_id: ID,
          }),
        [`GET ${PATH}/slack/channels`]: () =>
          json(200, {
            items: [
              {
                id: "C123",
                name: "general",
                is_private: false,
                is_member: true,
              },
            ],
            next_cursor: null,
            stale: false,
            truncated: false,
          }),
      });
      const user = await setupUser();
      await screen.findByRole("navigation", { name: "Slack 구역" });
      await user.click(
        await screen.findByRole("button", { name: "채널 추가" }),
      );
      const dialog = screen.getByRole("dialog");
      const connect = await within(dialog).findByRole("button", {
        name: "#general 연결",
      });
      await waitFor(() => expect(connect.hasAttribute("disabled")).toBe(false));
      await user.click(connect);
      await screen.findByText("채널을 연결했습니다.");
      expect(
        api.calls.find((call) => call.method === "PUT")?.body,
      ).toMatchObject({ channel_id: "C123", mode: "on" });
    });
  }

  test("keeps a saved mention-only setting when an older read lands after the save", async () => {
    let mentionOnly = false;
    let reads = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/app/settings`]: async () => {
        reads += 1;
        const seen = mentionOnly;
        if (reads === 2) await gate;
        return json(200, { mention_only: seen });
      },
      [`PUT ${PATH}/slack/app/settings`]: async (request: Request) => {
        mentionOnly = (await request.json()).mention_only;
        return json(200, { mention_only: mentionOnly });
      },
    });
    const user = await setupUser();
    const toggle = await screen.findByRole("switch", {
      name: "멘션했을 때만 반응",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("false"),
    );
    // Refresh refetches every Slack query, the setting included.
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(reads).toBe(2));
    await user.click(toggle);
    await screen.findByText("@멘션했을 때만 반응합니다.");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("keeps a saved mention-only setting when a read started during the save lands after it", async () => {
    let mentionOnly = false;
    let reads = 0;
    let saved = () => {};
    const saving = new Promise<void>((resolve) => {
      saved = resolve;
    });
    let late = () => {};
    const stale = new Promise<void>((resolve) => {
      late = resolve;
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/app/settings`]: async () => {
        reads += 1;
        const seen = mentionOnly;
        if (reads === 2) await stale;
        return json(200, { mention_only: seen });
      },
      [`PUT ${PATH}/slack/app/settings`]: async (request: Request) => {
        const next = (await request.json()).mention_only;
        await saving;
        mentionOnly = next;
        return json(200, { mention_only: mentionOnly });
      },
    });
    const user = await setupUser();
    const toggle = await screen.findByRole("switch", {
      name: "멘션했을 때만 반응",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("false"),
    );
    await user.click(toggle);
    // The refresh reads the old value while the save is still open.
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(reads).toBe(2));
    saved();
    await screen.findByText("@멘션했을 때만 반응합니다.");
    late();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
  });

  test("withholds the mention-only switch when its setting cannot be read", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/app/settings`]: () =>
        apiError(403, "FORBIDDEN", "internal message"),
    });
    const basic = await screen.findByRole("region", { name: "기본" });
    await waitFor(() =>
      expect(within(basic).queryByText("—") !== null).toBe(true),
    );
    expect(
      within(basic).queryByRole("switch", { name: "멘션했을 때만 반응" }),
    ).toBeNull();
    expect(within(basic).getByRole("alert")).toBeDefined();
    expect(document.body.textContent).not.toContain("internal message");
  });

  test("announces a failed channel connection in a toast", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [HOME_ROW] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
      [`PUT ${PATH}/slack-bindings`]: () =>
        apiError(409, "SLACK_NOT_INSTALLED", "internal message"),
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    await user.click(
      await screen.findByRole("button", { name: "#general 연결" }),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-slot=toast]")?.textContent).toBe(
        "Slack 앱을 설치한 뒤 채널을 연결하세요.",
      ),
    );
    // The picker's alert reads the error; the toast only shows it.
    expect(
      within(screen.getByRole("dialog")).getByRole("alert").textContent,
    ).toContain("Slack 앱을 설치한 뒤 채널을 연결하세요.");
    expect(
      document.querySelector("[data-slot=toast]")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  test("announces a copy made inside the open channel picker", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [HOME_ROW] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            {
              id: "C123",
              name: "general",
              is_private: true,
              is_member: false,
            },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
    });
    const user = await setupUser();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
    try {
      await screen.findByRole("navigation", { name: "Slack 구역" });
      await user.click(
        await screen.findByRole("button", { name: "채널 추가" }),
      );
      const dialog = screen.getByRole("dialog");
      await user.click(
        await within(dialog).findByRole("button", {
          name: "/invite 명령 복사",
        }),
      );
      await waitFor(() =>
        expect(document.querySelector("[data-slot=toast]")?.textContent).toBe(
          "복사됨",
        ),
      );
      // Mounted after the modal hid the page, so it is not hidden with it.
      const toast = document.querySelector("[data-slot=toast]") as HTMLElement;
      expect(
        (
          document.querySelector("nav[aria-label='Slack 구역']") as HTMLElement
        ).closest("[aria-hidden=true]") !== null,
      ).toBe(true);
      expect(toast.closest("[aria-hidden=true]") === null).toBe(true);
      expect(toast.getAttribute("aria-live")).toBe("polite");
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  for (const refused of [false, true]) {
    test(`copies the /invite line for a channel the bot has not joined${refused ? ", selecting it when the clipboard refuses" : ""}`, async () => {
      renderAt(DETAIL, {
        ...routes(APP, true),
        [`GET ${PATH}/slack-bindings`]: () =>
          json(200, {
            items: [
              HOME_ROW,
              {
                ...BINDING,
                surface_kind: "private_channel",
                home: false,
                membership: { state: "awaiting_invite", error: null },
              },
            ],
          }),
        [`GET ${PATH}/slack/channels`]: () =>
          json(200, {
            items: [
              {
                id: "C123",
                name: "general",
                is_private: true,
                is_member: false,
              },
            ],
            next_cursor: null,
            stale: false,
            truncated: false,
          }),
      });
      const user = await setupUser();
      // After setupUser, which installs a clipboard of its own.
      const copied: string[] = [];
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (refused) throw new Error("denied");
            copied.push(text);
          },
        },
      });
      try {
        await screen.findByRole("navigation", { name: "Slack 구역" });
        const list = await screen.findByRole("list", { name: "연결된 채널" });
        await user.click(
          await within(list).findByRole("button", {
            name: "/invite 명령 복사",
          }),
        );
        const toast = () =>
          document.querySelector("[data-slot=toast]")?.textContent;
        if (!refused) {
          expect(copied).toEqual(["/invite @billing"]);
          await waitFor(() => expect(toast()).toBe("복사됨"));
          return;
        }
        const field = (await within(list).findByRole("textbox", {
          name: "/invite 명령",
        })) as HTMLInputElement;
        expect(field.value).toBe("/invite @billing");
        await waitFor(() =>
          expect(document.activeElement === field).toBe(true),
        );
        expect([field.selectionStart, field.selectionEnd]).toEqual([
          0,
          field.value.length,
        ]);
        await waitFor(() =>
          expect(toast()).toBe(
            "클립보드에 복사하지 못했습니다. 선택된 명령을 직접 복사하세요.",
          ),
        );
      } finally {
        if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    });
  }

  test("keeps reinstall in the app card with its own title and description", async () => {
    renderAt(DETAIL, routes(APP, true));
    await screen.findByRole("navigation", { name: "Slack 구역" });
    const title = await screen.findByText("Slack 앱 다시 설치");
    const card = title.closest("[data-slot=row-list]") as HTMLElement;
    expect(within(card).getByText("앱 ID")).toBeDefined();
    expect(
      within(card).getByText(
        "권한이나 이벤트 설정이 바뀌었을 때 다시 설치합니다. Slack 동의 화면으로 이동합니다.",
      ),
    ).toBeDefined();
    expect(
      within(card).getByRole("button", { name: "다시 설치" }),
    ).toBeDefined();
    // The status strip alone carries the bot ID and connection state.
    const advanced = screen.getByRole("region", { name: "고급" });
    const status = screen.getByRole("region", { name: "상태" });
    for (const text of ["봇 ID", "연결됨"]) {
      expect(advanced.textContent?.includes(text)).toBe(false);
      expect(status.textContent?.includes(text)).toBe(true);
    }
  });

  for (const refused of [false, true]) {
    test(`copies the app ID from Advanced${refused ? " and asks for a manual copy when the clipboard refuses" : ""}`, async () => {
      renderAt(DETAIL, routes(APP, true));
      const user = await setupUser();
      const copied: string[] = [];
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (refused) throw new Error("denied");
            copied.push(text);
          },
        },
      });
      try {
        const advanced = await screen.findByRole("region", { name: "고급" });
        const button = within(advanced).getByRole("button", {
          name: "앱 ID 복사",
        });
        await user.click(button);
        await waitFor(() =>
          expect(document.querySelector("[data-slot=toast]")?.textContent).toBe(
            refused
              ? "클립보드에 복사하지 못했습니다. 앱 ID를 직접 선택해 복사하세요."
              : "복사됨",
          ),
        );
        expect(copied).toEqual(refused ? [] : ["A123"]);
        expect(document.activeElement === button).toBe(true);
        const open = within(advanced).getByRole("link", {
          name: "Slack에서 열기 (새 탭에서 열림)",
        });
        expect(open.getAttribute("href")).toBe(
          "https://api.slack.com/apps/A123",
        );
        expect(open.getAttribute("target")).toBe("_blank");
        expect(open.getAttribute("rel")).toBe("noopener noreferrer");
      } finally {
        if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    });
  }

  test("creates the app before requesting installation", async () => {
    const server = agentServer();
    let app: typeof APP | null = null;
    const { api, left } = renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}`]: () => {
        const detail = server.detail();
        return json(200, {
          ...detail,
          agent: {
            ...detail.agent,
            active_release_id: `sha256:${"a".repeat(64)}`,
          },
        });
      },
      [`GET ${PATH}/slack/app`]: () => json(200, appResponse(app)),
      [`POST ${PATH}/slack/app`]: () => {
        app = APP;
        return json(200, { slack_app: APP, created: true, warnings: [] });
      },
      [`POST ${PATH}/slack/install/start`]: () =>
        json(200, {
          authorize_url: "https://slack.com/oauth/v2/authorize",
          expires_at: AT,
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Slack 앱 만들고 설치" }),
    );
    await waitFor(() => expect(left).toHaveLength(1));
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual([`${PATH}/slack/app`, `${PATH}/slack/install/start`]);
  });

  test("warns, with the profile, that Slack cannot start a session of a repository-only agent, and still offers to connect", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        json(
          200,
          appResponse(null, [
            { code: "repository_required", profile_id: "claude-coding-local" },
          ]),
        ),
    });
    expect(
      await screen.findByText("Slack에서는 세션을 시작할 수 없습니다"),
    ).toBeDefined();
    expect(document.body.textContent).toContain(
      "활성 릴리스의 프로필(claude-coding-local)은 세션마다 저장소가 필요한데 릴리스에 쓸 수 있는 저장소가 없습니다",
    );
    expect(
      screen.getByRole("button", { name: "Slack 앱 만들고 설치" }),
    ).toBeDefined();
  });

  test("blocks creating the app without a config token and links an admin to the workspace Slack settings", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        json(200, appResponse(null, [], "unset")),
    });
    const create = await screen.findByRole("button", {
      name: "Slack 앱 만들고 설치",
    });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByText(
      "워크스페이스에 App Configuration Token이 등록되지 않아 앱을 만들 수 없습니다.",
    );
    expect(create.getAttribute("aria-describedby")).toContain(
      reason.closest("[id]")?.id ?? "missing",
    );
    const link = screen.getByRole("link", {
      name: "Slack 연결 설정에서 토큰 등록",
    });
    expect(link.getAttribute("href")).toBe("/settings/workspace/slack");
    expect(api.calls.some((call) => call.path.includes("config-token"))).toBe(
      false,
    );
  });

  test("asks a member to request the config token from an admin, with no settings link", async () => {
    renderAt(DETAIL, {
      ...routes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET ${PATH}/admins`]: () =>
        json(200, {
          users: [
            {
              user_id: USER_ID,
              email: "owner@example.com",
              display_name: "Owner",
              created_by: USER_ID,
              created_at: "2026-10-11T00:00:00.000Z",
            },
          ],
          teams: [],
        }),
      [`GET ${PATH}/slack/app`]: () =>
        json(200, appResponse(null, [], "needs_reentry")),
    });
    const create = await screen.findByRole("button", {
      name: "Slack 앱 만들고 설치",
    });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByText(
      "워크스페이스에 저장된 토큰을 사용할 수 없어 앱을 만들 수 없습니다.",
    ).parentElement;
    expect(reason?.textContent).toContain(
      "소유자나 관리자에게 토큰 등록을 요청하세요.",
    );
    expect(create.getAttribute("aria-describedby")).toBe(reason?.id ?? "");
    expect(
      screen.queryByRole("link", { name: "Slack 연결 설정에서 토큰 등록" }),
    ).toBeNull();
  });

  test("does not block installing an app that already exists when the token is unset", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () => json(200, appResponse(APP, [], "unset")),
    });
    const install = await screen.findByRole("button", {
      name: "Slack 앱 설치",
    });
    expect((install as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/App Configuration Token/)).toBeNull();
  });

  const subscribed = (
    events: components["schemas"]["GetSlackAppResponse"]["events"],
    eventUrl: string | null = `https://events.test/v1/slack/events/${AGENT_ID}`,
  ) => ({
    ...routes(APP, true),
    [`GET ${PATH}/slack/app`]: () =>
      json(200, { ...appResponse(APP), event_url: eventUrl, events }),
  });

  const SENT = `https://events.test/v1/slack/events/${AGENT_ID}`;

  test("points to the Event Subscriptions page while Slack has not checked the sent URL", async () => {
    renderAt(
      DETAIL,
      subscribed({ state: "pending", checked_at: AT, url: SENT }),
    );
    const status = await screen.findByRole("region", { name: "상태" });
    await within(status).findByText(
      "Slack이 Request URL을 아직 확인하지 않았습니다",
    );
    expect(status.textContent).toContain(
      "앱 설정의 Event Subscriptions에서 Request URL의 Verify(또는 Retry)를 누르세요",
    );
    expect(status.textContent).not.toContain("App Manifest");
    const link = within(status).getByRole("link", {
      name: /Event Subscriptions 열기/,
    });
    expect(link.getAttribute("href")).toBe(
      "https://api.slack.com/apps/A123/event-subscriptions",
    );
    expect(link.getAttribute("target")).toBe("_blank");
  });

  for (const [name, events, eventUrl] of [
    [
      "once verified",
      { state: "verified", checked_at: AT, url: SENT },
      undefined,
    ],
    [
      "before a Request URL went to Slack",
      { state: "pending", checked_at: null, url: null },
      undefined,
    ],
    [
      "without an event URL",
      { state: "pending", checked_at: null, url: null },
      null,
    ],
  ] as const) {
    test(`shows no Verify request ${name}`, async () => {
      renderAt(DETAIL, subscribed(events, eventUrl));
      const status = await screen.findByRole("region", { name: "상태" });
      // The app card reads the same query, so the status has it too.
      await screen.findByText("앱 ID");
      expect(status.textContent).not.toContain("Event Subscriptions");
    });
  }

  test("reads an app verified before its Request URL was recorded as verified", async () => {
    renderAt(
      DETAIL,
      subscribed({ state: "verified", checked_at: AT, url: null }, undefined),
    );
    const advanced = await screen.findByRole("region", { name: "고급" });
    await within(advanced).findByText("Slack 확인됨");
    expect(within(advanced).queryByText("아직 보내지 않음")).toBeNull();
  });

  test("sends the Request URL again from the advanced section", async () => {
    let read: components["schemas"]["GetSlackAppResponse"]["events"] = {
      state: "pending",
      checked_at: AT,
      url: SENT,
    };
    const posts: string[] = [];
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/app`]: () =>
        json(200, { ...appResponse(APP), event_url: SENT, events: read }),
      [`POST ${PATH}/slack/app/events/recheck`]: () => {
        posts.push("recheck");
        read = { state: "verified", checked_at: AT, url: SENT };
        return json(200, {
          ...appResponse(APP),
          event_url: SENT,
          events: read,
        });
      },
    });
    const user = await setupUser();
    const advanced = await screen.findByRole("region", { name: "고급" });
    await within(advanced).findByText("Slack 확인 대기");
    await user.click(
      within(advanced).getByRole("button", { name: "다시 확인" }),
    );
    await screen.findByText("Slack이 Request URL을 확인했습니다.");
    await within(advanced).findByText("Slack 확인됨");
    expect(posts).toEqual(["recheck"]);
    await waitFor(() =>
      expect(screen.queryByText("Event Subscriptions 열기")).toBeNull(),
    );
  });

  test("locks picking the home until Slack checks the Request URL", async () => {
    let read: components["schemas"]["GetSlackAppResponse"]["events"] = {
      state: "pending",
      checked_at: AT,
      url: SENT,
    };
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/app`]: () =>
        json(200, { ...appResponse(APP), event_url: SENT, events: read }),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [] }),
      [`POST ${PATH}/slack/app/events/recheck`]: () => {
        read = { state: "verified", checked_at: AT, url: SENT };
        return json(200, {
          ...appResponse(APP),
          event_url: SENT,
          events: read,
        });
      },
    });
    const user = await setupUser();
    const channels = await screen.findByRole("region", {
      name: "홈 채널 지정",
    });
    const pick = await within(channels).findByText("홈 채널 고르기");
    await waitFor(() => expect(pick.closest("[inert]")).not.toBeNull());
    const lock = within(channels).getByRole("group", {
      name: "Request URL 확인 전에는 채널을 고를 수 없습니다",
    });
    expect(lock.closest("[inert]")).toBeNull();
    // The way out stays reachable: the lock leads to it.
    await user.click(
      within(lock).getByRole("button", { name: "다시 확인으로 이동" }),
    );
    const recheck = within(
      screen.getByRole("region", { name: "고급" }),
    ).getByRole("button", { name: "다시 확인" });
    expect(document.activeElement === recheck).toBe(true);
    await user.click(recheck);
    await waitFor(() =>
      expect(within(channels).queryByRole("group")).toBeNull(),
    );
    expect(pick.closest("[inert]")).toBeNull();
  });

  test("locks the connected channels too while Slack has not checked", async () => {
    renderAt(
      DETAIL,
      subscribed({ state: "pending", checked_at: AT, url: SENT }),
    );
    const channels = await screen.findByRole("region", {
      name: "연결된 채널",
    });
    const toggle = await within(channels).findByRole("switch", {
      name: /사용/,
    });
    await waitFor(() => expect(toggle.closest("[inert]")).not.toBeNull());
    expect(
      within(channels)
        .getByRole("button", { name: "채널 추가" })
        .closest("[inert]"),
    ).not.toBeNull();
    // The way out is never locked.
    const advanced = screen.getByRole("region", { name: "고급" });
    expect(
      within(advanced)
        .getByRole("button", { name: "다시 확인" })
        .closest("[inert]"),
    ).toBeNull();
  });

  test("leaves the channels open once Slack checked the Request URL", async () => {
    renderAt(
      DETAIL,
      subscribed({ state: "verified", checked_at: AT, url: SENT }),
    );
    const channels = await screen.findByRole("region", {
      name: "연결된 채널",
    });
    await screen.findByText("앱 ID");
    const add = await within(channels).findByRole("button", {
      name: "채널 추가",
    });
    expect(add.closest("[inert]")).toBeNull();
    expect(within(channels).queryByRole("group")).toBeNull();
  });

  test("says when the active release's profile left the catalog", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        json(
          200,
          appResponse(null, [
            { code: "profile_unavailable", profile_id: "general" },
          ]),
        ),
    });
    expect(
      await screen.findByText("Slack에서는 세션을 시작할 수 없습니다"),
    ).toBeDefined();
    expect(document.body.textContent).toContain(
      "활성 릴리스의 프로필(general)이 지금 카탈로그에 없거나, 릴리스 뒤에 바뀌었거나, 운영자가 차단했습니다.",
    );
  });

  test("says when no release is active", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        json(200, appResponse(null, [{ code: "no_active_release" }])),
    });
    expect(await screen.findByText("활성 릴리스가 없습니다")).toBeDefined();
  });

  test("shows no repository warning when the profile needs none", async () => {
    renderAt(DETAIL, routes(APP, true));
    await screen.findByText("앱 ID");
    expect(document.body.textContent).not.toContain(
      "Slack에서는 세션을 시작할 수 없습니다",
    );
  });

  test("revokes an identity after confirmation and focuses the result", async () => {
    let installed = true;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/identities`]: () =>
        json(200, { items: installed ? [IDENTITY] : [] }),
      [`DELETE ${PATH}/identities/${ID}`]: () => {
        installed = false;
        return json(200, {
          agent_identity: { ...IDENTITY, status: "revoked", revoked_at: AT },
          receipt_id: ID,
        });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await user.click(await screen.findByRole("button", { name: "연결 해제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "연결 해제",
      }),
    );
    const result = await screen.findByText("Slack 연결을 해제했습니다.");
    await waitFor(() => expect(document.activeElement === result).toBe(true));
    // The side list's Advanced link still lands on a section of that name.
    const nav = screen.getByRole("navigation", { name: "Slack 구역" });
    const link = within(nav).getByRole("link", { name: "고급" });
    expect(
      screen.getByRole("region", { name: "고급" }).id ===
        link.getAttribute("href")?.slice(1),
    ).toBe(true);
    expect(
      api.calls.some(
        (call) =>
          call.method === "DELETE" && call.path.endsWith(`/identities/${ID}`),
      ),
    ).toBe(true);
  });

  for (const [configured, label] of [
    [false, "설치 대기"],
    [true, "재설치 필요"],
  ] as const) {
    test(`shows ${label} in the status row after a revoke with bot token configured=${configured}`, async () => {
      const app = {
        ...APP,
        secrets: {
          ...APP.secrets,
          slack_bot_token: { ...APP.secrets.slack_bot_token, configured },
        },
      };
      let installed = true;
      renderAt(DETAIL, {
        ...routes(app, true),
        [`GET ${PATH}/identities`]: () =>
          json(200, { items: installed ? [IDENTITY] : [] }),
        [`DELETE ${PATH}/identities/${ID}`]: () => {
          installed = false;
          return json(200, {
            agent_identity: { ...IDENTITY, status: "revoked", revoked_at: AT },
            receipt_id: ID,
          });
        },
      });
      const user = await setupUser();
      await user.click(
        await screen.findByRole("button", { name: "연결 해제" }),
      );
      await user.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "연결 해제",
        }),
      );
      await screen.findByText("Slack 연결을 해제했습니다.");
      await waitFor(() =>
        expect(
          screen.getByRole("region", { name: "상태" }).textContent,
        ).toContain(label),
      );
    });
  }

  test("saves the DM binding independently of channels", async () => {
    let dm = {
      ...BINDING,
      external_surface_id: null,
      surface_kind: "dm" as const,
      home: false,
      mode: "off" as "off" | "on",
    };
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, { items: [HOME_ROW, dm] }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        dm = { ...dm, mode: body.mode };
        return json(200, { slack_binding: dm, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    const toggle = await screen.findByRole("switch", { name: "DM 받기" });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("false"),
    );
    await user.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(
      await screen.findByText("DM 받기 설정을 저장했습니다."),
    ).toBeDefined();
    const status = screen.getByRole("region", { name: "상태" });
    await waitFor(() =>
      expect(within(status).queryByText("켜짐")).not.toBeNull(),
    );
    // The DM row and the agent's mention-only row.
    expect(
      within(screen.getByRole("region", { name: "기본" })).getAllByText("켜짐"),
    ).toHaveLength(2);
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      channel_id: null,
      mode: "on",
      home: false,
      ceiling: BINDING.ceiling,
    });
  });

  test("reads a missing DM binding as on, as the server answers a first DM", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        return json(200, {
          slack_binding: {
            ...BINDING,
            external_surface_id: null,
            surface_kind: "dm",
            home: false,
            mode: body.mode,
          },
          receipt_id: ID,
        });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    const toggle = await screen.findByRole("switch", { name: "DM 받기" });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("false"),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const status = screen.getByRole("region", { name: "상태" });
    expect(within(status).queryByText("켜짐")).not.toBeNull();
    expect(screen.queryByText("설정 안 됨") === null).toBe(true);
    await user.click(toggle);
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
        channel_id: null,
        mode: "off",
        home: false,
      }),
    );
  });

  test("merges overlapping channel pages by ID", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/channels`]: (request: Request) => {
        const next = new URL(request.url).searchParams.has("cursor");
        const one = {
          id: "C1",
          name: "one",
          is_private: false,
          is_member: true,
        };
        return json(200, {
          items: next ? [one, { ...one, id: "C2", name: "two" }] : [one],
          next_cursor: next ? null : "page2",
          stale: false,
          truncated: false,
        });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    await screen.findByText("#two");
    expect(screen.getAllByText("#one")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: /#(one|two) 연결/ }),
    ).toHaveLength(2);
  });

  test("a failed channel search in the picker is an alert that reads the channels again, apart from save errors", async () => {
    let down = true;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/channels`]: () =>
        down
          ? apiError(500, "INTERNAL_ERROR", "down")
          : json(200, {
              items: [
                { id: "C9", name: "found", is_private: false, is_member: true },
              ],
              next_cursor: null,
              stale: false,
              truncated: false,
            }),
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    const dialog = await screen.findByRole("dialog");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.getAttribute("data-variant")).toBe("red");
    expect(alert.textContent).toContain("불러오지 못했습니다");
    const reads = (path: string) =>
      api.calls.filter((c) => c.method === "GET" && c.path === path).length;
    const bindingsBefore = reads(`${PATH}/slack-bindings`);
    const channelsBefore = reads(`${PATH}/slack/channels`);
    down = false;
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));
    await within(dialog).findByText("#found");
    expect(within(dialog).queryByRole("alert") === null).toBe(true);
    expect(reads(`${PATH}/slack/channels`)).toBeGreaterThan(channelsBefore);
    expect(reads(`${PATH}/slack-bindings`)).toBe(bindingsBefore);
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("clears the previous result for consecutive saves and keeps focus during the request", async () => {
    let row = BINDING;
    let writes = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [row] }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        writes += 1;
        if (writes === 2) await gate;
        if (writes === 3) return apiError(403, "FORBIDDEN", "internal");
        const body = await request.json();
        row = { ...row, mode: body.mode };
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    const toggle = await screen.findByRole("switch", {
      name: "채널 ID: C123에서 사용",
    });
    toggle.focus();
    await user.keyboard(" ");
    await screen.findByText("채널 사용 설정을 저장했습니다.");
    await user.keyboard(" ");
    try {
      await waitFor(() =>
        expect(
          screen.queryByText("채널 사용 설정을 저장했습니다.") === null,
        ).toBe(true),
      );
      expect(document.activeElement === toggle).toBe(true);
    } finally {
      release();
    }
    await screen.findByText("채널 사용 설정을 저장했습니다.");
    await user.keyboard(" ");
    await screen.findByRole("alert");
    expect(screen.queryByText("채널 사용 설정을 저장했습니다.")).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  for (const [label, app, installed] of [
    ["만들기 전", null, false],
    ["설치 대기", APP, false],
    ["연결됨", APP, true],
    [
      "재설치 필요",
      {
        ...APP,
        secrets: {
          ...APP.secrets,
          slack_bot_token: { ...summary, configured: true },
        },
      },
      false,
    ],
  ] as const) {
    test(`shows ${label} from API state`, async () => {
      renderAt(DETAIL, routes(app, installed));
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
      // The /invite hint belongs to the channel picker alone.
      expect(screen.queryByText(/비공개 채널은 \/invite/)).toBeNull();
      if (installed) {
        const user = await setupUser();
        await user.click(
          await screen.findByRole("button", { name: "채널 추가" }),
        );
        expect(
          within(screen.getByRole("dialog")).getByText(
            "공개 채널은 반응을 켜면 봇이 자동으로 참여합니다. 비공개 채널은 /invite로 봇을 초대하세요.",
          ),
        ).toBeDefined();
      }
    });
  }
  test("does not load Slack endpoints from the overview tab", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}`, routes());
    await screen.findByRole("tab", { name: "Slack" });
    expect(api.calls.some((call) => call.path.includes("/slack"))).toBe(false);
  });
  test("starts an existing app installation and leaves through app services", async () => {
    const { left, api } = renderAt(DETAIL, {
      ...routes(APP),
      [`POST ${PATH}/slack/install/start`]: () =>
        json(200, {
          authorize_url: "https://slack.com/oauth/v2/authorize",
          expires_at: AT,
        }),
    });
    const user = await setupUser();
    const button = await screen.findByRole("button", { name: "Slack 앱 설치" });
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(left).toEqual(["https://slack.com/oauth/v2/authorize"]),
    );
    expect(
      api.calls.some(
        (call) => call.method === "POST" && call.path === `${PATH}/slack/app`,
      ),
    ).toBe(false);
  });
  test("warns that another Slack user made the app and says Slack no longer has it when installing", async () => {
    const { left } = renderAt(DETAIL, {
      ...routes(APP),
      [`GET ${PATH}/slack/app`]: () =>
        json(
          200,
          appResponse(APP, [
            {
              code: "config_token_issuer_changed",
              previous_user_id: "U0MOCK",
              user_id: "U123",
            },
            { code: "no_active_release" },
          ]),
        ),
      [`POST ${PATH}/slack/install/start`]: () =>
        apiError(409, "SLACK_APP_GONE", "internal description"),
    });
    expect(
      await screen.findByText("다른 Slack 사용자가 만든 앱입니다"),
    ).toBeDefined();
    expect(document.body.textContent).toContain(
      "앱을 만든 Slack 사용자(U0MOCK)와 지금 App Configuration Token의 사용자(U123)가 다릅니다.",
    );
    expect(screen.getByText("활성 릴리스가 없습니다")).toBeDefined();
    const user = await setupUser();
    const button = screen.getByRole("button", { name: "Slack 앱 설치" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText(
        "Slack에 이 앱이 더 이상 없습니다. 위험 구역에서 앱을 삭제한 뒤 다시 설치하면 새 앱이 만들어집니다.",
      ),
    ).toBeDefined();
    expect(left).toEqual([]);
    expect(document.body.textContent).not.toContain("internal description");
  });
  test("shows 403 and withholds installation", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        apiError(403, "FORBIDDEN", "internal description"),
    });
    expect(await screen.findByText("오류")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Slack 앱 만들고 설치" }),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("internal description");
  });
  test("names the missing secret store as the workspace Slack screen does", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "secret store off"),
    });
    expect(
      await screen.findByText(
        "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
      ),
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("서버가 응답하지 않습니다");
  });
  test("names the missing secret store in English too", async () => {
    renderAt(
      DETAIL,
      {
        ...routes(),
        [`GET ${PATH}/slack/app`]: () =>
          apiError(503, "BACKEND_UNAVAILABLE", "secret store off"),
      },
      "en",
    );
    expect(
      await screen.findByText(
        "The secret store is unavailable. Ask an administrator to check its configuration.",
      ),
    ).toBeDefined();
  });
  test("keeps the try-again text for a 503 a retry can clear", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "busy", true),
    });
    expect(
      await screen.findByText(
        "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
      ),
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("비밀 저장소");
  });
  test("keeps the saved ceiling and home when switching a channel off with the keyboard", async () => {
    let row = BINDING;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [row] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        row = { ...row, mode: body.mode };
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    const toggle = await screen.findByRole("switch", {
      name: "#general에서 사용",
    });
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      channel_id: "C123",
      mode: "off",
      home: true,
      ceiling: BINDING.ceiling,
    });
    expect(
      await screen.findByText("채널 사용 설정을 저장했습니다."),
    ).toBeDefined();
  });
  test("debounces a search and passes the page cursor with the same query", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/channels`]: (request: Request) => {
        const url = new URL(request.url);
        const q = url.searchParams.get("q");
        return json(200, {
          items: [
            {
              id: url.searchParams.has("cursor") ? "C2" : "C1",
              name: q || "general",
              is_private: true,
              is_member: true,
            },
          ],
          next_cursor:
            q === "dev" && !url.searchParams.has("cursor") ? "page2" : null,
          stale: false,
          truncated: false,
        });
      },
    });
    const user = await setupUser();
    await screen.findByRole("navigation", { name: "Slack 구역" });
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    await user.type(await screen.findByLabelText("채널 찾기"), "dev");
    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.search.includes("cursor=page2")),
      ).toBe(true),
    );
    const searches = api.calls.filter((call) =>
      call.path.includes("/slack/channels"),
    );
    expect(
      searches.filter((call) => call.search.includes("q=dev")).length,
    ).toBe(2);
    expect(
      searches.some((call) => /q=d(&|$)|q=de(&|$)/.test(call.search)),
    ).toBe(false);
  });
  test("requires confirmation before deleting an app", async () => {
    let app: typeof APP | null = APP;
    const { api } = renderAt(DETAIL, {
      ...routes(APP),
      [`GET ${PATH}/slack/app`]: () => json(200, appResponse(app)),
      [`DELETE /v1/workspaces/${WORKSPACE_ID}/slack/apps/${ID}`]: () => {
        app = null;
        return json(200, { slack_app: { ...APP, state: "deleted" } });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "앱 삭제" }));
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "앱 삭제",
      }),
    );
    expect(await screen.findByText("Slack 앱을 삭제했습니다.")).toBeDefined();
    expect(
      await within(screen.getByRole("region", { name: "Slack 앱" })).findByText(
        "만들기 전",
      ),
    ).toBeDefined();
  });

  test("lets a delete that Slack refused be asked again", async () => {
    let app: typeof APP | null = { ...APP, state: "deleting" };
    const { api } = renderAt(DETAIL, {
      ...routes(app),
      [`GET ${PATH}/slack/app`]: () => json(200, appResponse(app)),
      [`DELETE /v1/workspaces/${WORKSPACE_ID}/slack/apps/${ID}`]: () => {
        app = null;
        return json(200, { slack_app: { ...APP, state: "deleted" } });
      },
    });
    const user = await setupUser();
    const remove = await screen.findByRole("button", { name: "앱 삭제" });
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Slack 앱 설치",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(remove);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "앱 삭제",
      }),
    );
    expect(await screen.findByText("Slack 앱을 삭제했습니다.")).toBeDefined();
    expect(api.calls.filter((call) => call.method === "DELETE")).toHaveLength(
      1,
    );
  });

  test("drops the danger zone link once the installed app is deleted", async () => {
    let app: typeof APP | null = APP;
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/app`]: () => json(200, appResponse(app)),
      [`DELETE /v1/workspaces/${WORKSPACE_ID}/slack/apps/${ID}`]: () => {
        app = null;
        return json(200, { slack_app: { ...APP, state: "deleted" } });
      },
    });
    const user = await setupUser();
    const nav = await screen.findByRole("navigation", { name: "Slack 구역" });
    expect(within(nav).getByRole("link", { name: "위험 구역" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "앱 삭제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "앱 삭제",
      }),
    );
    await screen.findByText("Slack 앱을 삭제했습니다.");
    await waitFor(() =>
      expect(within(nav).queryByRole("link", { name: "위험 구역" })).toBeNull(),
    );
    expect(document.getElementById("slack-danger")).toBeNull();
  });
});
