import { describe, expect, test } from "bun:test";
import type { GitHubWebhookSettings } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  GITHUB_SETTINGS,
  githubSettings,
  json,
  me,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PATH = "/settings/workspace/integrations/github";
const API = "/v1/github-webhook-settings";
const APPS = `/v1/workspaces/${WORKSPACE_ID}/github-apps`;
const REPOSITORIES = `/v1/workspaces/${WORKSPACE_ID}/github-repositories`;
const BASE = "https://hooks.example.test/in";
const URL = `${BASE}/v1/github/webhook`;
const TITLE = "웹훅 입구 주소";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

const APP_LIST = [
  { app_id: 7, name: "werft-agent", other_workspaces: 0 },
  { app_id: 8, name: "werft-shared", other_workspaces: 2 },
];

const settings = (
  saved: string | null,
  apps = APP_LIST,
): GitHubWebhookSettings => ({
  webhook_public_url: saved,
  webhook_url: saved === null ? null : `${saved}/v1/github/webhook`,
  apps,
});

const routes = (
  extra: Record<string, () => Response> = {},
  role: "owner" | "admin" = "owner",
) => ({
  "GET /v1/auth/me": () => json(200, me(undefined, role)),
  [`GET ${GITHUB_SETTINGS}`]: () => json(200, githubSettings()),
  [`GET ${APPS}`]: () => json(200, { github_apps: [] }),
  [`GET ${REPOSITORIES}`]: () =>
    json(200, {
      installations: [],
      installation_id: null,
      page: 1,
      per_page: 20,
      total_count: 0,
      repositories: [],
      unavailable: "no_installation",
      catalog: [],
    }),
  [`GET ${API}`]: () => json(200, settings(null)),
  ...extra,
});

const section = async () =>
  (await screen.findByRole("heading", { name: TITLE })).closest(
    "section",
  ) as HTMLElement;
const field = (area: HTMLElement) =>
  within(area).getByRole("textbox", {
    name: "입구의 https 주소",
  }) as HTMLInputElement;

describe("연동 › GitHub의 웹훅 입구 주소", () => {
  test("저장 전에 바꿀 App과 다른 워크스페이스의 App도 바뀐다는 것을 보인다", async () => {
    renderAt(PATH, routes());
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe(""));
    expect(area.textContent).toContain(
      "주소가 없어 GitHub App은 webhook을 받지 않습니다.",
    );
    expect(area.textContent).not.toContain("werft-shared");
    await user.type(field(area), `${BASE}/`);
    expect(area.textContent).toContain(URL);
    expect(area.textContent).toContain(
      "저장하면 아래 GitHub App 2개의 webhook URL을 GitHub에서 이 주소로 바꿉니다.",
    );
    expect(area.textContent).toContain("werft-agent");
    expect(area.textContent).toContain(
      "werft-shared (다른 워크스페이스 2곳에도 연결됨)",
    );
    expect(area.textContent).toContain(
      "다른 워크스페이스에 연결된 App도 함께 바뀝니다.",
    );
  });

  test("저장은 정리한 주소를 보내고, 바꾸지 못한 App은 이유와 다시 시도를 남긴다", async () => {
    let retried = false;
    const { api } = renderAt(
      PATH,
      routes({
        [`PUT ${API}`]: () =>
          json(200, {
            ...settings(BASE),
            receipt_id: RECEIPT,
            updates: [
              { app_id: 7, name: "werft-agent", outcome: "updated" },
              {
                app_id: 8,
                name: "werft-shared",
                outcome: "failed",
                reason_code: "url_refused",
              },
            ],
          }),
        [`POST ${API}/retry`]: () => {
          retried = true;
          return json(200, {
            updates: [{ app_id: 8, name: "werft-shared", outcome: "updated" }],
          });
        },
      }),
    );
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe(""));
    await user.type(field(area), ` ${BASE}/ `);
    await user.click(within(area).getByRole("button", { name: "저장" }));
    const failure = await within(area).findByRole("alert");
    await waitFor(() =>
      expect(document.activeElement?.contains(failure) === true).toBe(true),
    );
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      webhook_public_url: BASE,
    });
    expect(failure.textContent).toContain(
      "werft-shared: GitHub가 이 주소를 받지 않았습니다. 인터넷에서 닿는 https 주소인지 확인하세요.",
    );
    expect(failure.textContent).not.toContain("werft-agent");
    await screen.findByText(
      "웹훅 입구 주소를 저장하고 GitHub App 1개의 webhook URL을 바꿨습니다.",
    );
    await user.click(
      within(failure).getByRole("button", { name: "다시 시도" }),
    );
    await screen.findByText("남은 App의 webhook URL을 모두 바꿨습니다.");
    expect(retried).toBe(true);
    expect(
      api.calls.find(
        (call) => call.method === "POST" && call.path === `${API}/retry`,
      )?.body,
    ).toEqual({ app_ids: [8] });
    await waitFor(() =>
      expect(within(area).queryByRole("alert") === null).toBe(true),
    );
    expect(field(area).value).toBe(BASE);
    expect(document.activeElement === field(area)).toBe(true);
  });

  test("http, query, 계정 정보는 보내기 전에 막는다", async () => {
    const { api } = renderAt(PATH, routes());
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe(""));
    for (const value of [
      "http://hooks.example.test",
      "https://hooks.example.test/?a=1",
      "https://user:pass@hooks.example.test",
    ]) {
      await user.clear(field(area));
      await user.type(field(area), value);
      await user.click(within(area).getByRole("button", { name: "저장" }));
      expect(document.activeElement === field(area)).toBe(true);
      expect(field(area).getAttribute("aria-invalid")).toBe("true");
    }
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  test("서버가 주소를 거절하면 그 이유를 칸 아래에 보인다", async () => {
    renderAt(
      PATH,
      routes({
        [`PUT ${API}`]: () =>
          apiError(400, "BAD_REQUEST", "no", false, {
            reason_code: "webhook_url_invalid",
          }),
      }),
    );
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe(""));
    await user.type(field(area), BASE);
    await user.click(within(area).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(area.textContent).toContain(
        "https 주소여야 하고 ?·#·계정 정보는 넣을 수 없습니다.",
      ),
    );
    expect(document.activeElement === field(area)).toBe(true);
  });

  test("비우기는 null을 보내고 App의 URL은 바꾸지 않았다고 말한다", async () => {
    let saved: string | null = BASE;
    const { api } = renderAt(
      PATH,
      routes({
        [`GET ${API}`]: () => json(200, settings(saved)),
        [`PUT ${API}`]: () => {
          saved = null;
          return json(200, {
            ...settings(null),
            receipt_id: RECEIPT,
            updates: [],
          });
        },
      }),
    );
    const user = await setupUser();
    const area = await section();
    await waitFor(() => expect(field(area).value).toBe(BASE));
    await user.click(within(area).getByRole("button", { name: "저장" }));
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    await user.click(within(area).getByRole("button", { name: "비우기" }));
    await screen.findByText(
      "웹훅 입구 주소를 비웠습니다. GitHub App에 걸린 webhook URL은 바꾸지 않았습니다.",
    );
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      webhook_public_url: null,
    });
    await waitFor(() => expect(field(area).value).toBe(""));
  });

  test("owner가 아닌 admin에게는 칸이 없고 설정을 읽지도 않는다", async () => {
    const { api } = renderAt(PATH, routes({}, "admin"));
    await screen.findByRole("heading", { name: "GitHub" });
    await waitFor(() =>
      expect(api.calls.some((call) => call.path === GITHUB_SETTINGS)).toBe(
        true,
      ),
    );
    expect(screen.queryByRole("heading", { name: TITLE }) === null).toBe(true);
    expect(api.calls.some((call) => call.path === API)).toBe(false);
  });
});
