import { describe, expect, test } from "bun:test";
import type { GitHubSettingsResponse } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  GITHUB_SETTINGS,
  githubConnection,
  githubInstallation,
  githubSettings,
  json,
  me,
  memberMe,
  REVIEWER_CONNECTION,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PATH = "/settings/workspace/github";
const APPS = `/v1/workspaces/${WORKSPACE_ID}/github-apps`;
const REPOSITORIES = `/v1/workspaces/${WORKSPACE_ID}/github-repositories`;

/** Checks and issues are on though the console shows no switch for them. */
const settingsOf = (
  over: Partial<GitHubSettingsResponse> = {},
): GitHubSettingsResponse => ({
  ...githubSettings(),
  ceiling: {
    workflows: false,
    actions: false,
    checks: true,
    issues: true,
    review: false,
    merge: false,
  },
  revision: 4,
  agents_using: { workflows: 0, actions: 2, checks: 0, issues: 0, review: 0 },
  connections: [
    githubConnection({
      permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
        actions: "write",
        workflows: "write",
      },
    }),
  ],
  ...over,
});

const routes = (
  read: () => Response,
  write: (body: unknown) => Response,
  who = me(),
) => ({
  "GET /v1/auth/me": () => json(200, who),
  [`GET ${GITHUB_SETTINGS}`]: read,
  [`PUT ${GITHUB_SETTINGS}`]: async (request: Request) =>
    write(await request.clone().json()),
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
});

const refusal = (status: number, code: string) =>
  json(status, {
    error: {
      code,
      message: "server words",
      retryable: false,
      request_id: "req-1",
      details: {},
    },
  });

const featureSwitch = (name: string) =>
  screen.findByRole("switch", { name: new RegExp(`^${name}`) });
const checked = (element: HTMLElement) =>
  element.getAttribute("aria-checked") === "true";

describe("GitHub 연결 › 에이전트가 쓸 수 있는 기능", () => {
  test("스위치는 바로 저장하고, 화면에 없는 상한 칸은 그대로 보낸다", async () => {
    const { api } = renderAt(
      PATH,
      routes(
        () => json(200, settingsOf()),
        (body) => {
          const sent = body as GitHubSettingsResponse;
          return json(200, settingsOf({ ceiling: sent.ceiling, revision: 5 }));
        },
      ),
    );
    const user = await setupUser();
    const workflows = await featureSwitch("워크플로 파일 수정");
    expect(checked(workflows)).toBe(false);
    await user.click(workflows);
    await waitFor(() => expect(checked(workflows)).toBe(true));
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1),
    );
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      ceiling: {
        workflows: true,
        actions: false,
        checks: true,
        issues: true,
        review: false,
        merge: false,
      },
      revision: 4,
    });
    // The next save goes on the revision the last one answered.
    await waitFor(() =>
      expect(workflows.getAttribute("aria-busy") === null).toBe(true),
    );
    const actions = await featureSwitch("Actions 실행");
    await user.click(actions);
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(2),
    );
    expect(api.calls.filter((call) => call.method === "PUT")[1]?.body).toEqual({
      ceiling: {
        workflows: true,
        actions: true,
        checks: true,
        issues: true,
        review: false,
        merge: false,
      },
      revision: 5,
    });
  });

  test("끄기는 확인을 거치고, 저장에 실패하면 저장된 값으로 되돌린다", async () => {
    const { api } = renderAt(
      PATH,
      routes(
        () =>
          json(
            200,
            settingsOf({ ceiling: { ...settingsOf().ceiling, actions: true } }),
          ),
        () => refusal(503, "BACKEND_UNAVAILABLE"),
      ),
    );
    const user = await setupUser();
    const actions = await featureSwitch("Actions 실행");
    expect(checked(actions)).toBe(true);
    await user.click(actions);
    const confirm = await screen.findByRole("dialog", {
      name: "기능을 끌까요?",
    });
    expect(
      within(confirm).getByText(/활성 릴리스에서 켠 에이전트 2개/),
    ).toBeDefined();
    await user.click(within(confirm).getByRole("button", { name: "끄기" }));
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1),
    );
    // Said on the page and to screen readers through the live region.
    expect(
      await screen.findAllByText(
        /저장하지 못해 스위치를 저장된 값으로 되돌렸습니다/,
      ),
    ).toHaveLength(2);
    expect(checked(await featureSwitch("Actions 실행"))).toBe(true);
  });

  test("다른 곳에서 먼저 바꿨으면(409) 지금 저장된 값을 보인다", async () => {
    let reads = 0;
    renderAt(
      PATH,
      routes(
        () => {
          reads += 1;
          return json(
            200,
            reads === 1
              ? settingsOf()
              : settingsOf({
                  ceiling: { ...settingsOf().ceiling, workflows: false },
                  revision: 9,
                }),
          );
        },
        () => refusal(409, "REVISION_CONFLICT"),
      ),
    );
    const user = await setupUser();
    const workflows = await featureSwitch("워크플로 파일 수정");
    await user.click(workflows);
    expect(
      await screen.findAllByText(/다른 곳에서 먼저 바꿨습니다/),
    ).toHaveLength(2);
    await waitFor(() => expect(reads).toBe(2));
    expect(checked(await featureSwitch("워크플로 파일 수정"))).toBe(false);
  });

  test("기능이 쓰는 권한이 App에 없으면 그 기능에 배지를 단다", async () => {
    renderAt(
      PATH,
      routes(
        () =>
          json(
            200,
            settingsOf({
              ceiling: { ...settingsOf().ceiling, workflows: true },
              connections: [githubConnection()],
            }),
          ),
        () => refusal(503, "BACKEND_UNAVAILABLE"),
      ),
    );
    const workflows = await featureSwitch("워크플로 파일 수정");
    const row = workflows.closest("[data-slot=setting-row]") as HTMLElement;
    expect(within(row).getByText("App 권한 필요")).toBeDefined();
  });

  test("기능이 쓰는 권한을 아직 승인하지 않은 계정이 있으면 승인 대기 배지를 단다", async () => {
    renderAt(
      PATH,
      routes(
        () =>
          json(
            200,
            settingsOf({
              ceiling: { ...settingsOf().ceiling, actions: true },
              connections: [
                githubConnection({
                  permissions: {
                    contents: "write",
                    pull_requests: "write",
                    metadata: "read",
                    actions: "write",
                  },
                  installations: [
                    githubInstallation({ status: "approval_pending" }),
                  ],
                }),
              ],
            }),
          ),
        () => refusal(503, "BACKEND_UNAVAILABLE"),
      ),
    );
    const actions = await featureSwitch("Actions 실행");
    const row = actions.closest("[data-slot=setting-row]") as HTMLElement;
    expect(within(row).getByText("일부 계정 승인 대기")).toBeDefined();
  });

  test("리뷰 승인용 App이 없으면 리뷰 승인을 켤 수 없다", async () => {
    renderAt(
      PATH,
      routes(
        () => json(200, settingsOf()),
        () => refusal(503, "BACKEND_UNAVAILABLE"),
      ),
    );
    const review = await featureSwitch("PR 리뷰 승인");
    expect((review as HTMLButtonElement).disabled).toBe(true);
  });

  test("리뷰 승인용 App이 있으면 리뷰 승인 줄에 그 App을 적는다", async () => {
    renderAt(
      PATH,
      routes(
        () =>
          json(
            200,
            settingsOf({
              connections: [
                ...settingsOf().connections,
                githubConnection({
                  connection_id: REVIEWER_CONNECTION,
                  role: "reviewer",
                  name: "werft-review",
                  permissions: {
                    contents: "read",
                    pull_requests: "write",
                    metadata: "read",
                  },
                }),
              ],
            }),
          ),
        () => refusal(503, "BACKEND_UNAVAILABLE"),
      ),
    );
    const review = await featureSwitch("PR 리뷰 승인");
    expect((review as HTMLButtonElement).disabled).toBe(false);
    const row = review.closest("[data-slot=setting-row]") as HTMLElement;
    expect(within(row).getByText(/^werft-review\(으\)로 · /)).toBeDefined();
  });

  test("자기 PR 머지는 꺼진 채로 시작하고, 켜면 merge만 true로 저장한다", async () => {
    const { api } = renderAt(
      PATH,
      routes(
        () => json(200, settingsOf()),
        (body) => {
          const sent = body as GitHubSettingsResponse;
          return json(200, settingsOf({ ceiling: sent.ceiling, revision: 5 }));
        },
      ),
    );
    const user = await setupUser();
    const merge = await featureSwitch("자기 PR 머지");
    expect(checked(merge)).toBe(false);
    const row = merge.closest("[data-slot=setting-row]") as HTMLElement;
    // No release holds merge, so the row counts no agents.
    expect(within(row).queryByText(/에이전트 \d+개/)).toBeNull();
    await user.click(merge);
    await waitFor(() => expect(checked(merge)).toBe(true));
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      ceiling: {
        workflows: false,
        actions: false,
        checks: true,
        issues: true,
        review: false,
        merge: true,
      },
      revision: 4,
    });
  });

  test("자기 PR 머지를 끄기 전에는 개수 없는 문구로 확인한다", async () => {
    renderAt(
      PATH,
      routes(
        () =>
          json(
            200,
            settingsOf({ ceiling: { ...settingsOf().ceiling, merge: true } }),
          ),
        () => refusal(503, "BACKEND_UNAVAILABLE"),
      ),
    );
    const user = await setupUser();
    const merge = await featureSwitch("자기 PR 머지");
    expect(checked(merge)).toBe(true);
    await user.click(merge);
    const confirm = await screen.findByRole("dialog", {
      name: "기능을 끌까요?",
    });
    expect(
      within(confirm).getByText(/자기 PR 머지을\(를\) 끕니다\. .*머지가 거절/),
    ).toBeDefined();
    expect(within(confirm).queryByText(/에이전트 \d+개/)).toBeNull();
  });

  test("구성원은 스위치를 바꿀 수 없고 이유를 본다", async () => {
    const { api } = renderAt(
      PATH,
      routes(
        () => json(200, settingsOf()),
        () => refusal(503, "BACKEND_UNAVAILABLE"),
        memberMe(),
      ),
    );
    const workflows = await featureSwitch("워크플로 파일 수정");
    expect((workflows as HTMLButtonElement).disabled).toBe(true);
    expect(workflows.getAttribute("aria-describedby")).toBeTruthy();
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
