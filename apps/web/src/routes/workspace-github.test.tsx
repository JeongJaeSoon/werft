import { describe, expect, test } from "bun:test";
import type { GitHubSettingsResponse } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  AUTHOR_CONNECTION,
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

const PATH = "/settings/workspace/integrations/github";
const APPS = `/v1/workspaces/${WORKSPACE_ID}/github-apps`;
const REPOSITORIES = `/v1/workspaces/${WORKSPACE_ID}/github-repositories`;
const PERMISSIONS_URL =
  "https://github.com/organizations/acme/settings/apps/werft-agent/permissions";

const reviewer = githubConnection({
  connection_id: REVIEWER_CONNECTION,
  role: "reviewer",
  name: "werft-review",
  app_id: 202,
  html_url: "https://github.com/apps/werft-review",
  permissions: { contents: "read", pull_requests: "write", metadata: "read" },
});

const settingsWith = (
  connections: GitHubSettingsResponse["connections"],
  over: Partial<GitHubSettingsResponse> = {},
): GitHubSettingsResponse => ({
  ...githubSettings(),
  connections,
  ...over,
});

const twoAccounts = () =>
  settingsWith([
    githubConnection({
      installations: [
        githubInstallation({
          id: 11,
          account: "acme",
          detail: {
            connected: {
              by: {
                user_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
                display_name: "Kim",
              },
              at: "2026-10-20T00:00:00.000Z",
            },
          },
        }),
        githubInstallation({
          id: 12,
          account: "jae",
          account_type: "user",
          detail: {
            repository_selection: "all",
            repository_count: 3,
            html_url: "https://github.com/settings/installations/12",
          },
        }),
      ],
    }),
  ]);

const repositoryPage = (over: object = {}) => ({
  installations: [],
  installation_id: null,
  page: 1,
  per_page: 20,
  total_count: 0,
  repositories: [],
  unavailable: "no_installation",
  catalog: [],
  ...over,
});

const routes = (
  settings: GitHubSettingsResponse,
  extra: Record<string, () => Response> = {},
  who = me(),
) => ({
  "GET /v1/auth/me": () => json(200, who),
  [`GET ${GITHUB_SETTINGS}`]: () => json(200, settings),
  [`GET ${APPS}`]: () => json(200, { github_apps: [] }),
  [`GET ${REPOSITORIES}`]: () => json(200, repositoryPage()),
  ...extra,
});

const installationTable = () =>
  screen.findByRole("table", {
    name: "GitHub App을 설치한 조직과 개인 계정",
  });
const cellsOf = (row: HTMLElement) =>
  Array.from(row.children).filter((cell) =>
    ["columnheader", "cell", "rowheader"].includes(
      cell.getAttribute("role") ?? "",
    ),
  );

/** Every link destination visible now, menus included only while open. */
const hrefs = () =>
  Array.from(document.querySelectorAll("a[href]"), (link) =>
    link.getAttribute("href"),
  ).filter((href): href is string => href?.startsWith("https://") ?? false);

describe("GitHub 연결 › 카드와 설치 표", () => {
  test("설치 표의 머리와 본문은 칸 수가 같다(관리자·구성원)", async () => {
    renderAt(PATH, routes(twoAccounts()));
    const rows = within(await installationTable()).getAllByRole("row");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(cellsOf(row)).toHaveLength(7);
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["이름", "유형", "저장소", "App", "연결한 사람", "상태", "메뉴"]);
  });

  test("구성원에게는 저장소 칸·메뉴·관리 동작이 없다", async () => {
    const members = settingsWith(
      twoAccounts().connections.map((connection) => ({
        ...connection,
        installations: connection.installations.map((installation) => ({
          ...installation,
          detail: null,
        })),
      })),
    );
    renderAt(PATH, routes(members, {}, memberMe()));
    const rows = within(await installationTable()).getAllByRole("row");
    for (const row of rows) expect(cellsOf(row)).toHaveLength(4);
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["이름", "유형", "App", "상태"]);
    expect(screen.queryAllByRole("button", { name: /메뉴$/ })).toEqual([]);
    expect(screen.queryByRole("button", { name: "저장소 관리" }) === null).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: /조직 추가/ }) === null).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "App 추가" }) === null).toBe(
      true,
    );
    expect(screen.queryByText("에이전트가 쓰는 저장소") === null).toBe(true);
  });

  test("좁은 폭에서 접히는 칸의 내용은 이름 칸 안에 들어 있다", async () => {
    renderAt(PATH, routes(twoAccounts()));
    const table = await installationTable();
    expect(table.getAttribute("data-narrow-at")).toBe("760");
    const [header, first] = within(table).getAllByRole("row") as HTMLElement[];
    const kept = (row: HTMLElement | undefined) =>
      cellsOf(row as HTMLElement).filter(
        (cell) => !cell.hasAttribute("data-hide-narrow"),
      );
    // Name, status, menu stay; the rest folds into the name.
    expect(kept(header)).toHaveLength(3);
    expect(kept(first)).toHaveLength(3);
    const name = within(first as HTMLElement).getByRole("rowheader");
    const moved = Array.from(
      name.querySelectorAll("[class*='min-width:761px']"),
      (line) => line.textContent,
    );
    expect(moved).toEqual([
      "조직 · 12개 선택 · werft-agent",
      expect.stringMatching(/^연결: Kim · 2026/),
    ]);
  });

  test("연결한 사람이 없으면 설치 날짜를 보인다", async () => {
    renderAt(PATH, routes(twoAccounts()));
    const rows = within(await installationTable()).getAllByRole("row");
    expect(
      within(rows[2] as HTMLElement).getByText(/^설치 2026/),
    ).toBeDefined();
  });

  test("확인 못 한 설치는 승인 대기로 보이지 않는다", async () => {
    const unread = settingsWith([
      githubConnection({
        key_status: "unknown",
        check: {
          state: "failed",
          reason_code: "github_unavailable",
          checked_at: "2026-11-01T00:00:00.000Z",
        },
        installations: [
          githubInstallation({
            status: "unknown",
            detail: { permissions: { metadata: "read" }, approval: "unknown" },
          }),
        ],
      }),
    ]);
    renderAt(PATH, routes(unread));
    const table = await installationTable();
    expect(within(table).getByText("확인 못 함")).toBeDefined();
    await screen.findByText("에이전트가 쓸 수 있는 기능");
    expect(screen.queryByText(/승인 대기/) === null).toBe(true);
    expect(screen.queryByText("GitHub에서 승인") === null).toBe(true);
  });

  test("없애야 할 것이 화면에 없다", async () => {
    renderAt(PATH, routes(twoAccounts()));
    await installationTable();
    expect(screen.getAllByRole("table")).toHaveLength(1);
    for (const gone of [
      /위험 구역/,
      /repositories\.yaml/,
      /키 교체/,
      /최대 권한/,
    ]) {
      expect(screen.queryByText(gone) === null).toBe(true);
    }
    expect(screen.queryByRole("alert") === null).toBe(true);
  });
});

describe("GitHub 연결 › App 목록과 GitHub 링크", () => {
  test("권한이 모자란 App 행에만 권한 추가 링크가 하나 있고, 같은 App의 두 기능도 링크는 하나다", async () => {
    const short = settingsWith([githubConnection()], {
      ceiling: { ...githubSettings().ceiling, actions: true, workflows: true },
    });
    renderAt(PATH, routes(short));
    const need = await screen.findByText(
      /Actions 실행, 워크플로 파일 수정을\(를\) 쓰려면 이 App에 Actions 쓰기, Workflows 쓰기 권한이 필요합니다/,
    );
    expect(need).toBeDefined();
    expect(
      screen.getAllByRole("link", { name: /GitHub에서 권한 추가/ }),
    ).toHaveLength(1);
    expect(hrefs()).toEqual([PERMISSIONS_URL]);
    expect(screen.getByText("권한 추가 필요")).toBeDefined();
  });

  test("구성원은 모자란 권한을 읽기만 하고 링크·안내 복사는 보지 않는다", async () => {
    const short = settingsWith(
      [
        githubConnection({
          installations: [
            githubInstallation({ id: 2, status: "approval_pending" }),
          ],
        }),
      ],
      { ceiling: { ...githubSettings().ceiling, workflows: true } },
    );
    renderAt(PATH, routes(short, {}, memberMe()));
    expect(
      await screen.findByText(/이 App에 Workflows 쓰기 권한이 필요합니다/),
    ).toBeDefined();
    expect(screen.getByText(/acme의 owner가 .*승인하면/)).toBeDefined();
    expect(hrefs()).toEqual([]);
    expect(screen.queryByText(/안내 복사/) === null).toBe(true);
  });

  test("권한이 맞으면 GitHub 링크는 설치 행 메뉴의 관리뿐이고, 화면의 링크 목적지는 겹치지 않는다", async () => {
    renderAt(PATH, routes(twoAccounts()));
    await installationTable();
    expect(hrefs()).toEqual([]);
    const user = await setupUser();
    for (const name of ["acme · werft-agent 메뉴", "jae · werft-agent 메뉴"]) {
      await user.click(screen.getByRole("button", { name }));
      const menu = await screen.findByRole("menu", { name });
      const items = within(menu).getAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual([
        "GitHub에서 관리(새 탭에서 열림)",
      ]);
      const seen = hrefs();
      expect(new Set(seen).size).toBe(seen.length);
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("menu", { name }) === null).toBe(true),
      );
    }
  });

  test("기능과 상관없는 권한의 승인 대기는 기능 배지를 더하지 않고 App 행에만 보인다", async () => {
    const pending = settingsWith(
      [
        githubConnection({
          permissions: {
            actions: "write",
            issues: "write",
            metadata: "read",
            contents: "write",
            pull_requests: "write",
          },
          installations: [
            githubInstallation({
              status: "approval_pending",
              detail: {
                approval: "pending",
                permissions: {
                  actions: "write",
                  metadata: "read",
                  contents: "write",
                  pull_requests: "write",
                },
              },
            }),
          ],
        }),
      ],
      { ceiling: { ...githubSettings().ceiling, actions: true } },
    );
    renderAt(PATH, routes(pending));
    expect(await screen.findByText("승인 대기 1곳")).toBeDefined();
    expect(
      screen.getByText(/acme의 owner가 Issues 쓰기을\(를\) 승인하면/),
    ).toBeDefined();
    expect(screen.queryByText("일부 계정 승인 대기") === null).toBe(true);
    expect(screen.queryByText("App 권한 필요") === null).toBe(true);
  });

  test("⋯ 새 키 등록은 같은 연결에 같은 App ID로 키를 저장한다", async () => {
    const { api } = renderAt(
      PATH,
      routes(twoAccounts(), {
        [`PUT ${APPS}/${AUTHOR_CONNECTION}`]: () =>
          json(200, {
            github_app: {
              role: "author",
              connection_id: AUTHOR_CONNECTION,
              app_id: 101,
              slug: "werft-agent",
              name: "werft-agent",
              html_url: "https://github.com/apps/werft-agent",
              private_key: {
                updated_at: "2026-11-03T00:00:00.000Z",
                updated_by: null,
              },
              created_at: "2026-10-01T00:00:00.000Z",
              updated_at: "2026-11-03T00:00:00.000Z",
            },
            receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          }),
      }),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "werft-agent 메뉴" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "새 키 등록" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "werft-agent의 새 키 등록",
    });
    expect(within(dialog).queryByLabelText("App ID") === null).toBe(true);
    const pem = new File(
      [
        "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
      ],
      "key.pem",
    );
    await user.upload(within(dialog).getByLabelText("Private key (.pem)"), pem);
    await user.click(
      within(dialog).getByRole("button", { name: "확인하고 저장" }),
    );
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "PUT").map((c) => c.path),
      ).toEqual([`${APPS}/${AUTHOR_CONNECTION}`]),
    );
    const body = api.calls.find((call) => call.method === "PUT")?.body as {
      app_id?: unknown;
    };
    expect(body.app_id).toBe(101);
    expect(await screen.findByText("새 키를 저장했습니다.")).toBeDefined();
  });

  test("리뷰 승인용으로 연결할 때만 작성·승인 위험 안내를 보인다", async () => {
    renderAt(PATH, routes(settingsWith([githubConnection()])));
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "App 추가" }));
    await user.click(
      await screen.findByRole("button", { name: "이미 있는 App 연결" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "이미 있는 App 연결",
    });
    expect(
      within(dialog).queryByText("같은 에이전트의 작성과 승인") === null,
    ).toBe(true);
    await user.click(
      within(dialog).getByRole("radio", { name: /리뷰 승인용/ }),
    );
    expect(
      await within(dialog).findByText("같은 에이전트의 작성과 승인"),
    ).toBeDefined();
  });

  test("App마다 역할 배지가 붙고 역할별 구획은 없다", async () => {
    renderAt(PATH, routes(settingsWith([githubConnection(), reviewer])));
    const list = await screen.findByRole("list", { name: "GitHub App" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("작성용")).toBeDefined();
    expect(
      within(items[1] as HTMLElement).getByText("리뷰 승인용"),
    ).toBeDefined();
  });
});

describe("GitHub 연결 › App 연결 해제", () => {
  const OTHER = "1a2b3c4d-0000-4000-8000-00000000000c";
  const usage = (userLink: boolean) => () =>
    json(200, {
      github_app: null,
      check: null,
      installations: [],
      repositories: [],
      manifest_blocked: null,
      usage: {
        pinned_repository_count: 3,
        agent_count: 2,
        active_session_count: 1,
        user_link: userLink,
      },
    });

  test("구성원 계정 연결에 쓰는 App은 다른 작성용 App이 있으면 해제하지 않게 한다", async () => {
    const { api } = renderAt(
      PATH,
      routes(
        settingsWith([
          githubConnection(),
          githubConnection({ connection_id: OTHER, name: "werft-agent-2" }),
        ]),
        { [`GET ${APPS}/${AUTHOR_CONNECTION}`]: usage(true) },
      ),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "werft-agent 메뉴" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "연결 해제" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "App 연결을 해제할까요?",
    });
    expect(
      await within(dialog).findByText(/다른 작성용 App으로 바꾼 뒤 해제할 수/),
    ).toBeDefined();
    const confirm = within(dialog).getByRole("button", { name: "연결 해제" });
    expect(
      (confirm as HTMLButtonElement).disabled ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await user.click(confirm);
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("영향을 읽지 못하면 해제하지 않게 한다", async () => {
    const { api } = renderAt(
      PATH,
      routes(settingsWith([githubConnection()]), {
        [`GET ${APPS}/${AUTHOR_CONNECTION}`]: () =>
          json(503, {
            error: {
              code: "BACKEND_UNAVAILABLE",
              message: "down",
              retryable: false,
              request_id: "req-1",
            },
          }),
      }),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "werft-agent 메뉴" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "연결 해제" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "App 연결을 해제할까요?",
    });
    expect(
      await within(dialog).findByText(/읽지 못해 해제할 수 없습니다/),
    ).toBeDefined();
    const confirm = within(dialog).getByRole("button", { name: "연결 해제" });
    await user.click(confirm);
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("마지막 작성용 App은 영향을 보이고 해제한다", async () => {
    const { api } = renderAt(
      PATH,
      routes(settingsWith([githubConnection()]), {
        [`GET ${APPS}/${AUTHOR_CONNECTION}`]: usage(true),
        [`DELETE ${APPS}/${AUTHOR_CONNECTION}`]: () =>
          json(200, { receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f" }),
      }),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "werft-agent 메뉴" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "연결 해제" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "App 연결을 해제할까요?",
    });
    expect(
      await within(dialog).findByText(
        /고정된 저장소 3개, 활성 릴리스에서 쓰는 에이전트 적어도 2개, 끝나지 않은 세션 1개.*새로 GitHub 계정을 연결할 수 없게.*다시 더하면 이 고정이 되살아납니다/,
      ),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "연결 해제" }));
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "DELETE").map((c) => c.path),
      ).toEqual([`${APPS}/${AUTHOR_CONNECTION}`]),
    );
  });
});

describe("GitHub 연결 › 구역의 추가 버튼 위치", () => {
  // The heading's row holds the section's main action; a button elsewhere
  // would read as belonging to another list.
  const titleRowOf = (name: string) =>
    screen.getByRole("heading", { level: 3, name }).parentElement
      ?.parentElement as HTMLElement;

  test("App 추가와 조직 추가는 각 목록의 제목 줄에 있다", async () => {
    renderAt(PATH, routes(twoAccounts()));
    await screen.findByRole("table", {
      name: "GitHub App을 설치한 조직과 개인 계정",
    });
    expect(
      within(titleRowOf("GitHub App")).getByRole("button", {
        name: "App 추가",
      }),
    ).toBeDefined();
    expect(
      within(titleRowOf("설치")).getByRole("button", { name: "조직 추가" }),
    ).toBeDefined();
    expect(
      within(titleRowOf("설치")).queryByRole("button", { name: "App 추가" }),
    ).toBeNull();
  });

  test("설치가 없으면 조직 추가는 빈 상자 안에 있다", async () => {
    renderAt(PATH, routes(settingsWith([githubConnection()])));
    const empty = await screen.findByText(
      "아직 GitHub App을 설치한 계정이 없습니다.",
    );
    const box = empty.parentElement as HTMLElement;
    expect(
      within(box).getByRole("button", { name: "조직 추가" }),
    ).toBeDefined();
    expect(
      within(titleRowOf("설치")).queryByRole("button", { name: "조직 추가" }),
    ).toBeNull();
  });
});

describe("GitHub 연결 › 저장소 관리", () => {
  test("설치가 모두 사라져도 저장소 관리로 들어갈 수 있다", async () => {
    renderAt(
      PATH,
      routes(settingsWith([githubConnection()]), {
        [`GET ${REPOSITORIES}`]: () =>
          json(
            200,
            repositoryPage({
              catalog: [
                {
                  id: "sandbox",
                  github_repository_id: 7,
                  full_name: "acme/sandbox",
                  url: "https://github.com/acme/sandbox.git",
                  branch: "main",
                  source: "selection",
                  version: 1,
                  installed: false,
                  updated_at: "2026-11-03T00:00:00.000Z",
                  agent_count: 2,
                  pins: { author: null, reviewer: null },
                },
              ],
            }),
          ),
      }),
    );
    expect(
      await screen.findByText("아직 GitHub App을 설치한 계정이 없습니다."),
    ).toBeDefined();
    expect(
      await screen.findByText("에이전트가 고른 저장소 1개 · 설치 밖 1개"),
    ).toBeDefined();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "저장소 관리" }));
    const sheet = await screen.findByRole("dialog", { name: "저장소" });
    const outside = within(sheet).getByRole("table", {
      name: "설치 밖 저장소",
    });
    expect(within(outside).getByText("acme/sandbox")).toBeDefined();
    expect(within(outside).getAllByText("설치 밖").length).toBeGreaterThan(0);
  });
});

describe("GitHub 연결 › 설치를 마치고 돌아오면", () => {
  test("연결한 사람을 한 번 기록하고 주소에서 지운다", async () => {
    const { api, history } = renderAt(
      `${PATH}?installation_id=11&setup_action=install&state=st4te`,
      routes(twoAccounts(), {
        [`POST ${APPS}/installations/complete`]: () =>
          json(200, {
            connection_id: AUTHOR_CONNECTION,
            installation_id: 11,
            recorded: true,
          }),
      }),
    );
    expect(
      await screen.findByText("GitHub 설치를 연결했습니다."),
    ).toBeDefined();
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([{ installation_id: 11, state: "st4te" }]);
    await waitFor(() => expect(history.location.search).toBe(""));
  });

  test("state가 만료되면 연결한 사람을 기록하지 못했다고 알린다", async () => {
    renderAt(
      `${PATH}?installation_id=11&state=old`,
      routes(twoAccounts(), {
        [`POST ${APPS}/installations/complete`]: () =>
          json(400, {
            error: {
              code: "BAD_REQUEST",
              message: "state",
              retryable: false,
              request_id: "req-1",
              details: { reason_code: "state_invalid" },
            },
          }),
      }),
    );
    expect(
      await screen.findByText(/1시간이 지났거나 이미 쓰인 링크/),
    ).toBeDefined();
  });
});
