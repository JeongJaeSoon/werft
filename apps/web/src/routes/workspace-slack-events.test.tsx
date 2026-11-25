import { describe, expect, test } from "bun:test";
import type { SlackEventsUpdate, SlackSettings } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, WORKSPACE_ID } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import { eventsBaseOf } from "./workspace-slack-events.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const SLACK = "/settings/workspace/integrations/slack";
const API = "/v1/slack-settings";
const CONFIG = `/v1/workspaces/${WORKSPACE_ID}/slack/config-token`;
const APPS = `/v1/workspaces/${WORKSPACE_ID}/slack/apps`;
const CONSOLE = "https://werft.example.test";
const EVENTS = "https://events.example.test/in";
const TEMPLATE = "/v1/slack/events/{agent_id}";
const TITLE = "이벤트 입구 주소";
const INVALID =
  "https 주소여야 하고 ?·#·계정 정보는 넣을 수 없습니다. 경로(/werft 등)는 넣을 수 있습니다.";

const TOKEN = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
  urls: { redirect_url: null, events_url_template: null },
  state: "unset",
  expires_at: null,
  issuer: null,
};

const settings = (saved: string | null): SlackSettings => ({
  events_public_url: saved,
  computed_events_base: CONSOLE,
  events_url_template: `${saved ?? CONSOLE}${TEMPLATE}`,
});

const routes = (saved: string | null, role: "owner" | "admin" = "owner") => ({
  "GET /v1/auth/me": () => json(200, me(undefined, role)),
  [`GET ${CONFIG}`]: () => json(200, TOKEN),
  [`GET ${APPS}`]: () => json(200, { items: [] }),
  [`GET ${API}`]: () => json(200, settings(saved)),
});

const section = async () =>
  (await screen.findByRole("heading", { name: TITLE })).closest(
    "section",
  ) as HTMLElement;
const field = (area: HTMLElement) =>
  within(area).getByRole("textbox", {
    name: "입구의 https 주소 (선택)",
  }) as HTMLInputElement;

describe("연동 › Slack의 이벤트 입구 주소", () => {
  test("owner는 토큰이 없어도 본다: 비어 있으면 콘솔 주소로 보낼 URL을 미리 보여 준다", async () => {
    renderAt(SLACK, routes(null));
    const area = await section();
    await waitFor(() =>
      expect(area.textContent).toContain(`비워 두면 쓰는 주소: ${CONSOLE}`),
    );
    // The token's state settling around it does not replace the section.
    expect(area.isConnected).toBe(true);
    expect(field(area).value).toBe("");
    expect(area.textContent).toContain(`${CONSOLE}${TEMPLATE}`);
  });

  test("입력하면 저장 전에 보낼 URL이 바뀌고, 저장은 정리한 주소를 보내 주소 칸을 다시 읽는다", async () => {
    let saved: string | null = null;
    const { api } = renderAt(SLACK, {
      ...routes(null),
      [`GET ${API}`]: () => json(200, settings(saved)),
      [`PUT ${API}`]: () => {
        saved = EVENTS;
        return json(200, {
          ...settings(saved),
          receipt_id: "019a0000-0000-7000-8000-0000000000e1",
          updates: [],
        });
      },
    });
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(area.textContent).toContain(CONSOLE));
    await user.type(field(area), `${EVENTS}/`);
    expect(area.textContent).toContain(`${EVENTS}${TEMPLATE}`);
    const tokenReads = () =>
      api.calls.filter((call) => call.method === "GET" && call.path === CONFIG)
        .length;
    const before = tokenReads();
    await user.click(within(area).getByRole("button", { name: "저장" }));
    await screen.findByText("이벤트 입구 주소를 저장했습니다.");
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      events_public_url: EVENTS,
    });
    await waitFor(() => expect(tokenReads()).toBeGreaterThan(before));
    expect(field(area).value).toBe(EVENTS);
  });

  test("http, query, 계정 정보는 보내기 전에 막고 칸으로 돌아간다", async () => {
    const { api } = renderAt(SLACK, routes(null));
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(area.textContent).toContain(CONSOLE));
    for (const value of [
      "http://events.example.test",
      "https://events.example.test/?a=1",
      "https://user:pass@events.example.test",
    ]) {
      await user.clear(field(area));
      await user.type(field(area), value);
      expect(area.textContent).toContain(INVALID);
      await user.click(within(area).getByRole("button", { name: "저장" }));
      expect(document.activeElement === field(area)).toBe(true);
      expect(field(area).getAttribute("aria-invalid")).toBe("true");
    }
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  test("저장된 주소는 비우기로 지우고, 같은 주소는 다시 보내지 않는다", async () => {
    let saved: string | null = EVENTS;
    const { api } = renderAt(SLACK, {
      ...routes(EVENTS),
      [`GET ${API}`]: () => json(200, settings(saved)),
      [`PUT ${API}`]: () => {
        saved = null;
        return json(200, {
          ...settings(null),
          receipt_id: "019a0000-0000-7000-8000-0000000000e2",
          updates: [],
        });
      },
    });
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe(EVENTS));
    await user.click(within(area).getByRole("button", { name: "저장" }));
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    await user.click(within(area).getByRole("button", { name: "비우기" }));
    await screen.findByText("이벤트 입구 주소를 비웠습니다.");
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      events_public_url: null,
    });
    await waitFor(() => expect(field(area).value).toBe(""));
    expect(
      within(area).queryByRole("button", { name: "비우기" }) === null,
    ).toBe(true);
  });

  test("저장하면 앱마다 보낸 결과를 보이고, 보내지 못한 앱만 그 자리에서 다시 보낸다", async () => {
    const sent: SlackEventsUpdate = {
      slack_app_id: "019a0000-0000-7000-8000-0000000000b1",
      agent_id: "019a0000-0000-7000-8000-0000000000c1",
      name: "Release notes",
      outcome: "updated",
      reinstall_required: false,
    };
    const unsent: SlackEventsUpdate = {
      slack_app_id: "019a0000-0000-7000-8000-0000000000b2",
      agent_id: "019a0000-0000-7000-8000-0000000000c2",
      name: "Triage",
      outcome: "failed",
      reason_code: "config_token_inactive",
    };
    const { api } = renderAt(SLACK, {
      ...routes(null),
      [`PUT ${API}`]: () =>
        json(200, {
          ...settings(EVENTS),
          receipt_id: "019a0000-0000-7000-8000-0000000000e3",
          updates: [sent, unsent],
        }),
      [`POST ${API}/retry`]: () =>
        json(200, {
          updates: [
            {
              slack_app_id: unsent.slack_app_id,
              agent_id: unsent.agent_id,
              name: unsent.name,
              outcome: "updated",
              reinstall_required: true,
            },
          ],
        }),
    });
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(area.textContent).toContain(CONSOLE));
    await user.type(field(area), EVENTS);
    await user.click(within(area).getByRole("button", { name: "저장" }));
    await screen.findByText(
      "이벤트 입구 주소를 저장하고 앱 1개에 새 주소를 보냈습니다.",
    );
    const list = within(area).getByRole("list", { name: "앱별 결과" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Release notes보냄",
      "Triage보내지 못함App Configuration Token이 활성 상태가 아닙니다. 토큰을 다시 넣은 뒤 다시 보내세요.",
    ]);
    // The reader lands on the list, the retry inside it.
    await waitFor(() =>
      expect(document.activeElement?.contains(list)).toBe(true),
    );
    await user.click(
      within(area).getByRole("button", { name: "보내지 못한 앱 다시 보내기" }),
    );
    await screen.findByText("남은 앱에 새 주소를 모두 보냈습니다.");
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      slack_app_ids: [unsent.slack_app_id],
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      "Release notes보냄",
      "Triage보냄Slack이 새 권한도 함께 받았습니다. 에이전트의 Slack 탭에서 앱을 다시 설치하세요.",
    ]);
    expect(
      within(area).queryByRole("button", {
        name: "보내지 못한 앱 다시 보내기",
      }) === null,
    ).toBe(true);
  });

  test("서버가 주소를 거절하면 그 이유를 칸 아래에 보인다", async () => {
    renderAt(SLACK, {
      ...routes(null),
      [`PUT ${API}`]: () =>
        apiError(400, "BAD_REQUEST", "no", false, {
          reason_code: "events_url_invalid",
        }),
    });
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(area.textContent).toContain(CONSOLE));
    await user.type(field(area), "https://events.example.test");
    await user.click(within(area).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(area.textContent).toContain(INVALID));
    expect(document.activeElement === field(area)).toBe(true);
  });

  test("owner가 아닌 admin에게는 칸이 없고 설정을 읽지도 않는다", async () => {
    const { api } = renderAt(SLACK, routes(null, "admin"));
    await screen.findByRole("heading", { name: "Slack 앱 생성" });
    expect(screen.queryByRole("heading", { name: TITLE }) === null).toBe(true);
    expect(api.calls.some((call) => call.path === API)).toBe(false);
  });
});

describe("eventsBaseOf", () => {
  test("keeps what the server keeps, and refuses what it refuses", () => {
    expect(eventsBaseOf("  ")).toBe("");
    expect(eventsBaseOf(" https://events.example.test/in/ ")).toBe(EVENTS);
    expect(eventsBaseOf("https://events.example.test/한")).toBe(
      "https://events.example.test/%ED%95%9C",
    );
    for (const refused of [
      "http://127.0.0.1:3000",
      "https://events.example.test/?",
      "https://events.example.test/#",
      "https://user@events.example.test",
      "events.example.test",
      `https://events.example.test/${"a".repeat(2030)}`,
      // Short as typed, past the limit once percent-encoded.
      `https://events.example.test/${"한".repeat(230)}`,
    ]) {
      expect(eventsBaseOf(refused)).toBe(null);
    }
  });
});
