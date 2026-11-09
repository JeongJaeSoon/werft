import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  AUTHOR_CONNECTION,
  GITHUB_SETTINGS,
  githubConnection,
  githubInstallation,
  githubSettings,
  json,
  me,
  REVIEWER_CONNECTION,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PATH = "/settings/workspace/integrations/github";
const BASE = `/v1/workspaces/${WORKSPACE_ID}`;
const LIST = `${BASE}/github-repositories`;
const RECEIPT = "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f";
const OTHER_AUTHOR = "1a2b3c4d-0000-4000-8000-00000000000c";

const SETTINGS = {
  ...githubSettings(),
  connections: [
    githubConnection({
      installations: [
        githubInstallation({ id: 77, account: "acme" }),
        githubInstallation({ id: 78, account: "beta" }),
      ],
    }),
  ],
};

const catalogRow = (fields: Record<string, unknown>) => ({
  id: "api",
  github_repository_id: 11,
  full_name: "acme/api",
  url: "https://github.com/acme/api.git",
  branch: "main",
  source: "selection",
  version: 3,
  installed: true,
  updated_at: "2026-11-01T00:00:00.000Z",
  agent_count: 1,
  pins: { author: AUTHOR_CONNECTION, reviewer: null },
  ...fields,
});

const installations = [
  {
    id: 77,
    account: "acme",
    connection_id: AUTHOR_CONNECTION,
    role: "author",
    permissions: {},
    repository_count: 21,
  },
  {
    id: 78,
    account: "beta",
    connection_id: AUTHOR_CONNECTION,
    role: "author",
    permissions: {},
    repository_count: 1,
  },
];

const repository = (id: number, name: string, catalogId: string | null) => ({
  github_repository_id: id,
  full_name: name,
  default_branch: "main",
  private: id % 2 === 0,
  catalog_id: catalogId,
  agent_count: catalogId === null ? 0 : 1,
});

const page = (installation: number, number: number) => ({
  installations,
  installation_id: installation,
  page: number,
  per_page: 20,
  total_count: installation === 77 ? 21 : 1,
  repositories:
    installation === 78
      ? [repository(90, "beta/site", null)]
      : number === 1
        ? [
            repository(11, "acme/api", "api"),
            ...Array.from({ length: 19 }, (_, at) =>
              repository(100 + at, `acme/r${at}`, null),
            ),
          ]
        : [repository(200, "acme/last", null)],
  unavailable: null,
  catalog: [
    catalogRow({}),
    catalogRow({
      id: "gone",
      github_repository_id: 12,
      full_name: "acme/gone",
      url: "https://github.com/acme/gone.git",
      installed: false,
      agent_count: 2,
    }),
  ],
});

const routes = (
  extra: Record<string, (request: Request) => Response> = {},
) => ({
  "GET /v1/auth/me": () => json(200, me()),
  [`GET ${GITHUB_SETTINGS}`]: () => json(200, SETTINGS),
  [`GET ${BASE}/github-apps`]: () => json(200, { github_apps: [] }),
  [`GET ${LIST}`]: (request: Request) => {
    const query = new URL(request.url).searchParams;
    return json(
      200,
      page(
        Number(query.get("installation_id") ?? 77),
        Number(query.get("page") ?? 1),
      ),
    );
  },
  ...extra,
});

async function openSheet() {
  const user = await setupUser();
  await user.click(await screen.findByRole("button", { name: "저장소 관리" }));
  const sheet = await screen.findByRole("dialog", { name: "저장소" });
  return { user, sheet };
}

describe("GitHub 연결 › 저장소 시트", () => {
  test("설치의 저장소를 한 쪽씩 읽고, 설치를 바꾸면 첫 쪽부터 읽는다", async () => {
    const { api } = renderAt(PATH, routes());
    const { user, sheet } = await openSheet();
    const table = await within(sheet).findByRole("table", {
      name: "acme · werft-agent 설치의 저장소",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(21);
    for (const row of rows) {
      expect(
        Array.from(row.children).filter((cell) => cell.getAttribute("role")),
      ).toHaveLength(4);
    }
    expect(within(sheet).getByText("21개 중 1–20")).toBeDefined();
    await user.click(within(sheet).getByRole("button", { name: "다음" }));
    expect(await within(sheet).findByText("acme/last")).toBeDefined();

    await user.selectOptions(
      within(sheet).getByLabelText("설치"),
      "beta · werft-agent (1개)",
    );
    expect(await within(sheet).findByText("beta/site")).toBeDefined();
    const lists = api.calls
      .filter((call) => call.method === "GET" && call.path === LIST)
      .map((call) => call.search);
    expect(lists.at(-1)).toBe("?installation_id=78&page=1&per_page=20");
  });

  test("좁은 폭에서 접히는 기본 브랜치·상태는 이름 칸 안에 들어 있다", async () => {
    renderAt(PATH, routes());
    const { sheet } = await openSheet();
    const table = await within(sheet).findByRole("table", {
      name: "acme · werft-agent 설치의 저장소",
    });
    const outside = within(sheet).getByRole("table", {
      name: "설치 밖 저장소",
    });
    for (const each of [table, outside]) {
      expect(each.getAttribute("data-narrow-at")).toBe("480");
      for (const row of within(each).getAllByRole("row")) {
        // Name, agents, menu stay; the second column folds into the name.
        expect(
          Array.from(row.children).filter(
            (cell) =>
              cell.getAttribute("role") &&
              !cell.hasAttribute("data-hide-narrow"),
          ),
        ).toHaveLength(3);
      }
    }
    const moved = (each: HTMLElement) =>
      Array.from(
        within(each)
          .getAllByRole("rowheader")[0]
          ?.querySelectorAll("[class*='width>=480px']") ?? [],
        (line) => line.textContent,
      );
    expect(moved(table)).toEqual(["main"]);
    expect(moved(outside)).toEqual(["설치 밖"]);
  });

  test("닫기 버튼으로 시트를 닫으면 저장소 관리로 포커스가 돌아온다", async () => {
    renderAt(PATH, routes());
    const { user, sheet } = await openSheet();
    await user.click(within(sheet).getByRole("button", { name: "닫기" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "저장소" }) === null).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "저장소 관리" }),
      ).toBe(true),
    );
  });

  test("행 메뉴로 연 창을 닫으면 그 행의 메뉴 버튼으로 포커스가 돌아온다", async () => {
    renderAt(PATH, routes());
    const { user, sheet } = await openSheet();
    const menu = await within(sheet).findByRole("button", {
      name: "acme/api 메뉴",
    });
    await user.click(menu);
    await user.click(
      await screen.findByRole("menuitem", { name: "기본 브랜치 바꾸기" }),
    );
    await screen.findByRole("dialog", { name: "acme/api의 기본 브랜치" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "acme/api의 기본 브랜치" }) ===
          null,
      ).toBe(true),
    );
    await waitFor(() => expect(document.activeElement === menu).toBe(true));
  });

  test("같은 역할 App이 여럿이면 정지·확인 못 함이 아닌 첫 설치를 이름으로 읽는다", async () => {
    const twoApps = {
      ...SETTINGS,
      connections: [
        githubConnection({
          installations: [
            githubInstallation({ id: 76, account: "aaa", status: "suspended" }),
            githubInstallation({ id: 75, account: "aab", status: "unknown" }),
            githubInstallation({ id: 78, account: "beta" }),
          ],
        }),
        githubConnection({
          connection_id: OTHER_AUTHOR,
          name: "werft-agent-2",
          installations: [githubInstallation({ id: 77, account: "acme" })],
        }),
      ],
    };
    const { api } = renderAt(PATH, {
      ...routes(),
      [`GET ${GITHUB_SETTINGS}`]: () => json(200, twoApps),
      [`GET ${LIST}`]: (request: Request) => {
        const query = new URL(request.url).searchParams;
        const id = query.get("installation_id");
        return id === null
          ? json(400, {
              error: {
                code: "BAD_REQUEST",
                message: "name it",
                retryable: false,
                request_id: "req-1",
                details: { reason_code: "installation_required" },
              },
            })
          : json(200, page(Number(id), 1));
      },
    });
    expect(
      await screen.findByText("에이전트가 고른 저장소 2개 · 설치 밖 1개"),
    ).toBeDefined();
    const { sheet } = await openSheet();
    expect(
      await within(sheet).findByRole("table", {
        name: "acme · werft-agent 설치의 저장소",
      }),
    ).toBeDefined();
    const searches = api.calls
      .filter((call) => call.method === "GET" && call.path === LIST)
      .map((call) => call.search);
    expect(new Set(searches)).toEqual(
      new Set(["?installation_id=77&page=1&per_page=20"]),
    );
  });

  test("작성용 App 설치가 모두 사라지면 리뷰 승인용 App 설치를 이름으로 읽는다", async () => {
    const authorsGone = {
      ...SETTINGS,
      connections: [
        githubConnection({ installations: [] }),
        githubConnection({
          connection_id: OTHER_AUTHOR,
          name: "werft-agent-2",
          installations: [],
        }),
        githubConnection({
          connection_id: REVIEWER_CONNECTION,
          role: "reviewer",
          name: "werft-review",
          app_id: 202,
          installations: [githubInstallation({ id: 78, account: "beta" })],
        }),
      ],
    };
    const { api } = renderAt(PATH, {
      ...routes(),
      [`GET ${GITHUB_SETTINGS}`]: () => json(200, authorsGone),
    });
    expect(
      await screen.findByText("에이전트가 고른 저장소 2개 · 설치 밖 1개"),
    ).toBeDefined();
    const searches = api.calls
      .filter((call) => call.method === "GET" && call.path === LIST)
      .map((call) => call.search);
    expect(new Set(searches)).toEqual(
      new Set(["?installation_id=78&page=1&per_page=20"]),
    );
  });

  test("설치 밖 저장소는 따로 모여 남는다", async () => {
    renderAt(PATH, routes());
    expect(
      await screen.findByText("에이전트가 고른 저장소 2개 · 설치 밖 1개"),
    ).toBeDefined();
    const { sheet } = await openSheet();
    const outside = await within(sheet).findByRole("table", {
      name: "설치 밖 저장소",
    });
    const rows = within(outside).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText("acme/gone")).toBeDefined();
    expect(
      within(rows[1] as HTMLElement).getAllByText("설치 밖").length,
    ).toBeGreaterThan(0);
  });

  test("기본 브랜치를 바꾸면 읽은 version과 함께 보낸다", async () => {
    const { api } = renderAt(
      PATH,
      routes({
        [`PATCH ${LIST}/api`]: () =>
          json(200, {
            repository: { ...catalogRow({ branch: "develop", version: 4 }) },
            receipt_id: RECEIPT,
          }),
      }),
    );
    const { user, sheet } = await openSheet();
    await user.click(
      await within(sheet).findByRole("button", { name: "acme/api 메뉴" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "기본 브랜치 바꾸기" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "acme/api의 기본 브랜치",
    });
    const input = within(dialog).getByLabelText("기본 브랜치");
    await user.clear(input);
    await user.type(input, "develop");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "PATCH").map((c) => c.body),
      ).toEqual([{ branch: "develop", version: 3 }]),
    );
  });

  test("맡을 App을 바꾸면 바뀐 역할만 보낸다", async () => {
    const { api } = renderAt(
      PATH,
      routes({
        [`GET ${LIST}/api/app-pins`]: () =>
          json(200, {
            catalog_id: "api",
            pins: { author: AUTHOR_CONNECTION, reviewer: null },
            candidates: [
              {
                connection_id: AUTHOR_CONNECTION,
                role: "author",
                name: "werft-agent",
                app_id: 101,
                installed: true,
              },
              {
                connection_id: OTHER_AUTHOR,
                role: "author",
                name: "werft-agent-2",
                app_id: 103,
                installed: false,
              },
              {
                connection_id: REVIEWER_CONNECTION,
                role: "reviewer",
                name: "werft-review",
                app_id: 202,
                installed: true,
              },
            ],
          }),
        [`PUT ${LIST}/api/app-pins/author`]: () =>
          json(200, {
            catalog_id: "api",
            role: "author",
            connection_id: OTHER_AUTHOR,
            receipt_id: RECEIPT,
          }),
      }),
    );
    const { user, sheet } = await openSheet();
    await user.click(
      await within(sheet).findByRole("button", { name: "acme/api 메뉴" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "맡을 App 바꾸기" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "acme/api을(를) 맡을 App",
    });
    await user.selectOptions(
      await within(dialog).findByLabelText("작성용"),
      "werft-agent-2 (이 저장소에 설치 안 됨)",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(
        api.calls
          .filter((call) => call.method === "PUT")
          .map((call) => [call.path, call.body]),
      ).toEqual([
        [`${LIST}/api/app-pins/author`, { connection_id: OTHER_AUTHOR }],
      ]),
    );
    expect(
      await screen.findByText("acme/api을(를) 맡을 App을 바꿨습니다."),
    ).toBeDefined();
  });
});
