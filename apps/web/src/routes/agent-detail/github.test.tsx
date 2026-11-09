import { describe, expect, test } from "bun:test";
import type { components } from "@werft-ai/client";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import { apiError, json, me, RECEIPT_ID } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
// After the harness: the screen pulls in @werft-ai/ui, which must load
// against the test DOM.
const { pendingCount, refusesAgentRef } = await import("./github.tsx");
const PATH = `/v1/agents/${AGENT_ID}`;
const DETAIL = `/agents/${AGENT_ID}?tab=github`;
const SESSION = "00000000-0000-4000-8000-0000000000c1";

type Tab = components["schemas"]["AgentGitHubResponse"];
type Settings = NonNullable<Tab["github"]>;

const SETTINGS: Settings = {
  repositories: ["werft-sandbox"],
  push_approval: true,
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [{ workflow: "ci.yml", ref: "release/*" }],
};
const open = { available: true, reason: null } as const;
const UNKNOWN = { author: null, reviewer: null };
const TAB: Tab = {
  enabled: true,
  active_release_id: null,
  github: SETTINGS,
  settings_revision: 3,
  selected_repositories: [
    {
      id: "werft-sandbox",
      repository: "acme/werft-sandbox",
      private: null,
      ref: "r1.werft-sandbox",
    },
  ],
  start_repository_id: null,
  push_attached: "ask",
  legacy_defaults: null,
  options: {
    repository_ceiling_unset: false,
    repositories: [
      {
        id: "werft-sandbox",
        url: "https://github.com/acme/werft-sandbox.git",
        repository: "acme/werft-sandbox",
        ref: "r1.werft-sandbox",
        available: true,
        reason: null,
        installed: UNKNOWN,
      },
      {
        id: "docs-site",
        url: "https://github.com/acme/docs-site.git",
        repository: "acme/docs-site",
        ref: "r1.docs-site",
        available: true,
        reason: null,
        installed: UNKNOWN,
      },
    ],
    features: {
      workflows: open,
      actions: open,
      checks: open,
      issues: open,
      review: open,
    },
  },
};

/** An agent whose v1 is released under claude-coding-local and active. */
async function activeAgent({
  repository = "werft-sandbox",
  github = SETTINGS,
}: {
  repository?: string | null;
  github?: Settings | null;
} = {}) {
  const server = agentServer();
  const versionId = server.versions[0]?.id ?? "";
  await server.routes[`PATCH ${PATH}`](
    new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({
        card: server.versions[0]?.card,
        runtime_profile_id: "claude-coding-local",
      }),
    }),
  );
  const release = server.releases[0];
  if (!release) throw new Error("no release");
  release.repository_id = repository;
  release.policy_pins = github === null ? {} : { github };
  return { server, release, versionId };
}

const PULL_REQUEST = {
  pull_request: { formatting: "inherit", template: null, template_name: null },
  pull_request_revision: 0,
};

function routesFor(
  server: ReturnType<typeof agentServer>,
  tab: Tab,
  extra: Record<
    string,
    (request: Request) => Response | Promise<Response>
  > = {},
) {
  return {
    "GET /v1/auth/me": () => json(200, me()),
    ...server.routes,
    [`GET ${PATH}/github`]: () =>
      json(200, {
        ...tab,
        active_release_id: server.detail().agent.active_release_id,
      }),
    [`GET ${PATH}/github/activity`]: () => json(200, { items: [] }),
    [`GET ${PATH}/github/pull-request`]: () => json(200, PULL_REQUEST),
    [`GET ${PATH}/github/repositories`]: () =>
      json(200, {
        installations: [],
        installation_id: null,
        page: 1,
        per_page: 30,
        total_count: 0,
        repositories: [],
        unavailable: "ceiling_listed",
      }),
    ...extra,
  };
}

const switchNamed = (name: string) =>
  screen.getByRole("switch", { name }) as HTMLButtonElement;
/** The repository switch of `acme/<repo>`. */
const repoSwitch = (repo: string) => switchNamed(`acme/${repo} 사용`);
const ACCESS = `PUT ${PATH}/github/repository-access`;
const accessed = (revision = 4) =>
  json(200, {
    settings_revision: revision,
    receipt_id: RECEIPT_ID,
    enabled: true,
    repository: { ref: "r1.x", repository: "acme/x", private: null },
  });
/** Opens a folded section the way the side nav does. */
async function openSection(
  user: Awaited<ReturnType<typeof setupUser>>,
  name: string,
) {
  Element.prototype.scrollIntoView ??= () => {};
  const nav = screen.getAllByRole("navigation", { name: "GitHub 구역" })[0];
  if (!nav) throw new Error("no section nav");
  await user.click(within(nav).getByRole("link", { name }));
}

describe("에이전트 GitHub 탭", () => {
  test("받은 설정이 있는 중 다시 읽기가 실패하면 설정을 남기고 위에 알린다", async () => {
    const { server } = await activeAgent();
    const base: Record<
      string,
      (request: Request) => Response | Promise<Response>
    > = routesFor(server, TAB);
    const key = `GET ${PATH}/github`;
    let down = false;
    renderAt(DETAIL, {
      ...base,
      [key]: (request: Request) =>
        down
          ? apiError(500, "INTERNAL_ERROR", "down")
          : (base[key] as NonNullable<(typeof base)[string]>)(request),
    });
    await screen.findByRole("switch", { name: "acme/werft-sandbox 사용" });
    down = true;
    window.dispatchEvent(new Event("visibilitychange"));
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-variant")).toBe("red");
    expect(repoSwitch("werft-sandbox") !== null).toBe(true);
  });

  for (const read of ["github", "github/activity"]) {
    test(`${read} 읽기가 실패하면 그 query만 다시 읽고 저장하지 않는다`, async () => {
      const { server } = await activeAgent();
      const base: Record<
        string,
        (request: Request) => Response | Promise<Response>
      > = routesFor(server, TAB);
      const key = `GET ${PATH}/${read}`;
      let failed = false;
      const { api } = renderAt(DETAIL, {
        ...base,
        [key]: (request: Request) => {
          if (failed)
            return (base[key] as NonNullable<(typeof base)[string]>)(request);
          failed = true;
          return apiError(500, "INTERNAL_ERROR", "down");
        },
      });
      const user = await setupUser();
      // Closed, the activity asks for nothing; opening it is what reads.
      if (read === "github/activity") {
        await screen.findByRole("heading", { name: "저장소" });
        await openSection(user, "최근 기록");
      }
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("불러오지 못했습니다");
      await user.click(
        within(alert).getByRole("button", { name: "다시 시도" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("alert") === null).toBe(true),
      );
      const reads = api.calls.filter(
        (c) => c.method === "GET" && c.path === `${PATH}/${read}`,
      );
      expect(reads).toHaveLength(2);
      expect(
        api.calls.filter(
          (c) => c.method !== "GET" && c.path.startsWith(`${PATH}/github`),
        ),
      ).toEqual([]);
    });
  }

  test("상한이 App 저장소 전체를 허용하면 설치 목록의 저장소도 한 목록에 보이고, 켜면 바로 저장한다", async () => {
    const { server } = await activeAgent();
    const tab = structuredClone(TAB);
    const { api } = renderAt(
      DETAIL,
      routesFor(server, tab, {
        [`GET ${PATH}/github/repositories`]: () =>
          json(200, {
            installations: [
              {
                id: 77,
                account: "acme",
                connection_id: "app-author",
                role: "author",
                permissions: { contents: "write" },
                repository_count: 2,
              },
            ],
            installation_id: 77,
            page: 1,
            per_page: 30,
            total_count: 2,
            repositories: [
              {
                github_repository_id: 11,
                full_name: "acme/werft-sandbox",
                default_branch: "main",
                private: true,
                catalog_id: "werft-sandbox",
              },
              {
                github_repository_id: 12,
                full_name: "acme/api",
                default_branch: "main",
                private: false,
                // Once turned on, the server's page names the catalog row.
                catalog_id: tab.options.repositories.some((r) => r.id === "api")
                  ? "api"
                  : null,
              },
            ],
            unavailable: null,
          }),
        [ACCESS]: () => {
          // Turned on, the catalog now holds it and the tab follows.
          tab.options.repositories.push({
            id: "api",
            url: "https://github.com/acme/api.git",
            repository: "acme/api",
            ref: "r1.api",
            available: true,
            reason: null,
            installed: UNKNOWN,
          });
          tab.github = { ...SETTINGS, repositories: ["werft-sandbox", "api"] };
          return accessed();
        },
      }),
    );
    const user = await setupUser();
    // One list: the catalog's rows and the installation's page together.
    await screen.findByRole("switch", { name: "acme/werft-sandbox 사용" });
    expect(repoSwitch("werft-sandbox").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(repoSwitch("docs-site").getAttribute("aria-checked")).toBe("false");
    const api77 = await screen.findByRole("switch", { name: "acme/api 사용" });
    expect(api77.getAttribute("aria-checked")).toBe("false");
    // The installation says which repository is private; a public one has no tag.
    expect(
      within(
        repoSwitch("werft-sandbox").closest("li") as HTMLElement,
      ).getByText("비공개"),
    ).toBeTruthy();
    expect(
      within(api77.closest("li") as HTMLElement).queryByText("비공개"),
    ).toBeNull();
    expect(screen.queryByText("목록에 있음")).toBeNull();
    expect(screen.queryByRole("button", { name: /고르기/ })).toBeNull();
    await user.click(api77);
    await waitFor(() =>
      expect(
        api.calls.filter(
          (c) => c.method === "PUT" && c.path.endsWith("/repository-access"),
        ),
      ).toHaveLength(1),
    );
    expect(
      api.calls.find((c) => c.path.endsWith("/repository-access"))?.body,
    ).toEqual({
      repository: { installation_id: 77, github_repository_id: 12 },
      enabled: true,
    });
    // Saved at once: no draft box, no settings PUT.
    expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull();
    expect(
      api.calls.filter((c) => c.path.endsWith("/github/settings")),
    ).toEqual([]);
    await waitFor(() =>
      expect(switchNamed("acme/api 사용").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
  });

  test("워크스페이스에 저장소 상한이 아직 없으면, 저장소를 범위 밖으로 막지 않고 저장 시 기본 허용 목록이 적용된다고 안내한다", async () => {
    const { server } = await activeAgent();
    renderAt(
      DETAIL,
      routesFor(server, {
        ...TAB,
        options: { ...TAB.options, repository_ceiling_unset: true },
      }),
    );
    await screen.findByRole("heading", { name: "저장소" });
    expect(screen.getByText(/저장하면 기본 허용 목록/)).toBeTruthy();
    expect(repoSwitch("werft-sandbox").disabled).toBe(false);
    expect(screen.queryByText(/저장소 범위 밖/)).toBeNull();
  });

  test("쓸 수 없는 저장소와 권한은 그 이유를 행에 적고 스위치를 잠근다", async () => {
    const { server } = await activeAgent();
    const reason = <R,>(r: R) => ({ available: false, reason: r });
    renderAt(
      DETAIL,
      routesFor(server, {
        ...TAB,
        github: {
          ...SETTINGS,
          features: { ...SETTINGS.features, actions: false },
        },
        options: {
          repository_ceiling_unset: false,
          repositories: [
            ...TAB.options.repositories,
            {
              id: "billing-api",
              url: "https://github.com/acme/billing-api",
              repository: "acme/billing-api",
              ref: "r1.billing-api",
              ...reason("repository_not_allowed" as const),
              installed: UNKNOWN,
            },
            {
              id: "legacy-pat",
              url: "https://github.com/acme/legacy-pat",
              repository: "acme/legacy-pat",
              ref: "r1.legacy-pat",
              ...reason("app_required" as const),
              installed: UNKNOWN,
            },
          ],
          features: {
            workflows: reason("over_workspace_ceiling" as const),
            actions: reason("github_host_unsupported" as const),
            // Not offered on the tab; the contract still carries them.
            checks: reason("app_permission_missing" as const),
            issues: open,
            review: reason("no_reviewer_app" as const),
          },
        },
      }),
    );
    await screen.findByRole("heading", { name: "저장소" });
    const rowOf = (name: string) =>
      switchNamed(name).closest("li") as HTMLElement;
    const expectLocked = (name: string, text: RegExp) => {
      expect(switchNamed(name).disabled).toBe(true);
      expect(within(rowOf(name)).getByText(text)).toBeTruthy();
    };
    expectLocked(
      "acme/billing-api 사용",
      /워크스페이스가 허용한 저장소 범위 밖/,
    );
    expectLocked("acme/legacy-pat 사용", /PAT로 연결된 저장소라/);
    expectLocked("워크플로 파일 수정", /워크스페이스 상한 밖입니다/);
    expectLocked("Actions 실행", /GitHub Enterprise에 있어/);
    expectLocked("리뷰 승인", /리뷰용 App이 없습니다/);
    // No repository is pinned by a release any more: those with no reason
    // may change, the one in use included.
    expect(repoSwitch("werft-sandbox").disabled).toBe(false);
    expect(repoSwitch("docs-site").disabled).toBe(false);
    // Checks and issues have no work behind them, so they are not offered.
    expect(screen.queryByRole("switch", { name: "검사 결과 쓰기" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "이슈 쓰기" })).toBeNull();
    // A ceiling reason links to where it is lifted; the host one does not.
    expect(
      within(rowOf("워크플로 파일 수정"))
        .getByRole("link", { name: "GitHub 연결 설정" })
        .getAttribute("href"),
    ).toBe("/settings/workspace/github");
    expect(
      within(rowOf("Actions 실행")).queryByRole("link", {
        name: "GitHub 연결 설정",
      }),
    ).toBeNull();
  });

  test("작성용 App이 없는 저장소와, 고른 저장소에 리뷰용 App이 없는 리뷰 승인에 App 미설치를 단다", async () => {
    const { server } = await activeAgent();
    const [sandbox, docs] = TAB.options.repositories;
    if (!sandbox || !docs) throw new Error("fixture");
    renderAt(
      DETAIL,
      routesFor(server, {
        ...TAB,
        options: {
          ...TAB.options,
          repositories: [
            { ...sandbox, installed: { author: true, reviewer: false } },
            { ...docs, installed: { author: false, reviewer: true } },
          ],
        },
      }),
    );
    await screen.findByRole("heading", { name: "저장소" });
    const rowOf = (name: string) =>
      switchNamed(name).closest("li") as HTMLElement;
    expect(
      within(rowOf("acme/docs-site 사용")).getByText("App 미설치"),
    ).toBeTruthy();
    expect(
      within(rowOf("acme/werft-sandbox 사용")).queryByText("App 미설치"),
    ).toBeNull();
    const review = rowOf("리뷰 승인");
    expect(within(review).getByText("App 미설치")).toBeTruthy();
    expect(
      within(review).getByText(
        /리뷰용 App이 설치되지 않은 저장소: acme\/werft-sandbox\./,
      ),
    ).toBeTruthy();
    expect(
      within(review)
        .getByRole("link", { name: "GitHub 연결 설정" })
        .getAttribute("href"),
    ).toBe("/settings/workspace/github");
    // A warning, not a lock: GitHub decides per repository.
    expect(switchNamed("리뷰 승인").disabled).toBe(false);
  });

  test("구역 목차의 링크는 같은 id의 구역으로 포커스를 옮기고, 구역 이름은 제목이다", async () => {
    const { server } = await activeAgent();
    renderAt(DETAIL, routesFor(server, TAB));
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    Element.prototype.scrollIntoView ??= () => {};

    const nav = screen.getAllByRole("navigation", { name: "GitHub 구역" })[0];
    if (!nav) throw new Error("no section nav");
    // The permission, allow-list and push sections live in the collapsed
    // details, so the nav stops at the details itself.
    const sections = [
      ["사용", "github-use"],
      ["저장소", "github-repositories"],
      ["Pull request 서식", "github-pull-request"],
      ["세부 설정", "github-details"],
      ["최근 기록", "github-activity"],
    ] as const;
    // The nav lists them in the order they sit on the page.
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(sections.map(([name]) => name));
    for (const [name, id] of sections) {
      await user.click(within(nav).getByRole("link", { name }));
      const section = document.getElementById(id) as HTMLElement;
      expect(section.id).toBe(id);
      // The DOM shim focuses any element and reports tabIndex -1 by default; only the attribute shows the section is focusable.
      expect(section.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement === section).toBe(true);
    }
    // A jump to a folded section opens it first.
    for (const id of ["github-details", "github-activity"]) {
      expect(document.getElementById(id)?.hasAttribute("open")).toBe(true);
    }
  });

  test("구역은 사용, 저장소, PR 서식, 세부 설정, 최근 기록 순이고 세부 설정과 최근 기록은 접혀 있다", async () => {
    const { server } = await activeAgent();
    const { api } = renderAt(DETAIL, routesFor(server, TAB));
    await screen.findByRole("heading", { name: "저장소" });
    await screen.findByRole("heading", { name: "Pull request 서식" });
    const ids = [
      "github-use",
      "github-repositories",
      "github-pull-request",
      "github-details",
      "github-activity",
    ];
    const nodes = ids.map((id) => document.getElementById(id) as HTMLElement);
    for (const [i, node] of nodes.entries()) {
      const next = nodes[i + 1];
      if (!next) break;
      expect(
        (node.compareDocumentPosition(next) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
      ).toBe(true);
    }
    expect(nodes[3]?.hasAttribute("open")).toBe(false);
    expect(nodes[4]?.hasAttribute("open")).toBe(false);
    // Folded, the record reads nothing.
    expect(
      api.calls.filter((c) => c.path === `${PATH}/github/activity`),
    ).toEqual([]);
    // No badge says "from the next session" any more.
    expect(screen.queryByText("다음 세션부터")).toBeNull();
  });

  test("최근 기록은 열 때 읽고, 열어야 행이 보인다", async () => {
    const { server } = await activeAgent();
    const { api } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}/github/activity`]: () =>
          json(200, {
            items: [
              {
                id: RECEIPT_ID,
                operation: "set_agent_github",
                target_ref: {
                  resource: { kind: "agent", id: AGENT_ID },
                  workspace_id: null,
                },
                status: "succeeded",
                result: { change: "settings", enabled: true },
                error: null,
                created_at: "2026-10-30T00:00:00.000Z",
                updated_at: "2026-10-30T00:00:00.000Z",
              },
            ],
          }),
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    await openSection(user, "최근 기록");
    expect(await screen.findByText("GitHub 설정 저장")).toBeTruthy();
    expect(
      api.calls.filter((c) => c.path === `${PATH}/github/activity`),
    ).toHaveLength(1);
  });

  test("바꾼 것은 저장 전 상자에 세고, 되돌리면 상자가 사라진다", async () => {
    const { server } = await activeAgent();
    renderAt(DETAIL, routesFor(server, TAB));
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();

    await user.click(switchNamed("push 전 사람 승인"));
    await screen.findByText("저장하지 않은 변경 1건");
    await user.type(screen.getByLabelText("워크플로 파일"), "deploy.yml");
    await user.type(screen.getByLabelText("ref 패턴(선택)"), "main");
    await user.click(screen.getByRole("button", { name: "워크플로 추가" }));
    await screen.findByText("저장하지 않은 변경 2건");
    const added = screen.getByText("deploy.yml").closest("li") as HTMLElement;
    expect(within(added).getByText("저장 전")).toBeTruthy();
    // A held entry carries no such badge.
    const held = screen.getByText("ci.yml").closest("li") as HTMLElement;
    expect(within(held).queryByText("저장 전")).toBeNull();

    await user.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() =>
      expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull(),
    );
    expect(screen.queryByText("deploy.yml")).toBeNull();
    expect(switchNamed("push 전 사람 승인").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  test("설정이 없는 릴리스는 첫 저장을 push 승인 꺼짐에서 시작해도 지금은 승인이 켜졌다고 보인다", async () => {
    const { server, release } = await activeAgent();
    release.policy_pins = {};
    renderAt(
      DETAIL,
      routesFor(server, {
        ...TAB,
        github: null,
        legacy_defaults: { ...SETTINGS, push_approval: false },
      }),
    );
    await screen.findByRole("heading", { name: "권한" });
    expect(switchNamed("push 전 사람 승인").getAttribute("aria-checked")).toBe(
      "false",
    );
    const status = screen.getByText("push 전 승인")
      .parentElement as HTMLElement;
    expect(within(status).getByText("켜짐")).toBeTruthy();
    expect(within(status).queryByText("꺼짐")).toBeNull();
  });

  test("설정이 없으면 바꾼 것이 없어도 기본값을 PUT으로 저장하고 새 릴리스는 만들지 않는다", async () => {
    const { server } = await activeAgent({ github: null });
    const defaults = { ...SETTINGS, push_approval: false };
    const sent: unknown[] = [];
    let row = false;
    const tab = {
      ...TAB,
      github: null,
      settings_revision: null,
      push_attached: "allow" as const,
      legacy_defaults: defaults,
    };
    const { api } = renderAt(
      DETAIL,
      routesFor(server, tab, {
        // The tab follows the row once it is saved.
        [`GET ${PATH}/github`]: () =>
          json(
            200,
            row
              ? { ...TAB, github: defaults, settings_revision: 0 }
              : { ...tab, active_release_id: null },
          ),
        [`PUT ${PATH}/github/settings`]: async (request) => {
          sent.push(await request.json());
          row = true;
          return json(200, { settings_revision: 0, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await screen.findByText("GitHub 설정을 아직 저장하지 않았습니다");
    // Nothing drafted yet, so there is nothing to revert.
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();

    const save = screen.getByRole("button", {
      name: "저장",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);
    await screen.findByText(
      "GitHub 설정을 저장했습니다. 새 릴리스는 만들지 않았습니다.",
    );
    expect(sent).toEqual([
      {
        expected_revision: null,
        settings: defaults,
        start_repository_id: null,
        // What a first save starts from (owner decision D6).
        push_attached: "allow",
      },
    ]);
    expect(api.calls.filter((c) => c.path.endsWith("/releases"))).toEqual([]);
    await waitFor(() =>
      expect(
        screen.queryByText("GitHub 설정을 아직 저장하지 않았습니다"),
      ).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
  });

  test("설정이 없으면 되돌려도 첫 저장을 남기고, 되돌리기를 누르면 포커스를 저장 상자로 옮긴다", async () => {
    const { server } = await activeAgent({ github: null });
    let made = 0;
    renderAt(
      DETAIL,
      routesFor(
        server,
        {
          ...TAB,
          github: null,
          settings_revision: null,
          legacy_defaults: { ...SETTINGS, push_approval: false },
        },
        {
          [`PUT ${PATH}/github/settings`]: () => {
            made += 1;
            return apiError(409, "REVISION_CONFLICT", "saved by someone else");
          },
        },
      ),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    const region = () =>
      screen.getByRole("region", {
        name: "GitHub 설정을 아직 저장하지 않았습니다",
      });

    // Undone by hand still leaves the first save.
    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(switchNamed("push 전 사람 승인"));
    expect(region() !== null).toBe(true);
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();

    await user.click(switchNamed("push 전 사람 승인"));
    const revert = await screen.findByRole("button", { name: "되돌리기" });
    revert.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull(),
    );
    expect(document.activeElement === region()).toBe(true);
    expect(switchNamed("push 전 사람 승인").getAttribute("aria-checked")).toBe(
      "false",
    );

    // A conflict on a save without a draft keeps the first save on offer.
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/다른 곳에서 GitHub 설정이 먼저 바뀌어/);
    expect(made).toBe(1);
    expect(region().getAttribute("data-variant")).toBe("red");
    await user.click(screen.getByRole("button", { name: "버리고 새로 읽기" }));
    expect(document.activeElement === region()).toBe(true);
    expect(
      screen.queryByText(/다른 곳에서 GitHub 설정이 먼저 바뀌어/),
    ).toBeNull();
  });

  test("설정이 없는 릴리스라도 GitHub 사용이 꺼져 있으면 첫 저장을 내밀지 않는다", async () => {
    const { server } = await activeAgent({ github: null });
    renderAt(
      DETAIL,
      routesFor(server, {
        ...TAB,
        enabled: false,
        github: null,
        legacy_defaults: { ...SETTINGS, push_approval: false },
      }),
    );
    await screen.findByRole("heading", { name: "권한" });
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(
      screen.queryByText("GitHub 설정을 아직 저장하지 않았습니다"),
    ).toBeNull();
  });

  test("허용 목록은 agent/ 브랜치와 경로·중복을 받지 않는다", async () => {
    const { server } = await activeAgent();
    renderAt(DETAIL, routesFor(server, TAB));
    const user = await setupUser();
    const file = await screen.findByLabelText("워크플로 파일");
    const ref = screen.getByLabelText("ref 패턴(선택)");
    const add = screen.getByRole("button", { name: "워크플로 추가" });

    await user.type(file, ".github/workflows/ci.yml");
    await user.click(add);
    await screen.findByText(/\.yml이나 \.yaml로 끝나는 파일 이름만/);
    await user.clear(file);
    await user.type(file, "ci.yml");
    await user.type(ref, "agent/*");
    await user.click(add);
    await screen.findByText(/agent\/ 브랜치는 에이전트가 내용을 정하므로/);
    await user.clear(ref);
    await user.type(ref, "release/*");
    await user.click(add);
    await screen.findByText("이미 목록에 있는 항목입니다.");
    expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull();
  });

  test("저장하면 현재 revision과 함께 PUT하고 릴리스는 만들지 않는다", async () => {
    const { server } = await activeAgent();
    const sent: unknown[] = [];
    const { api } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`PUT ${PATH}/github/settings`]: async (request) => {
          sent.push(await request.json());
          return json(200, { settings_revision: 4, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(await screen.findByRole("button", { name: "저장" }));

    await screen.findByText(
      "GitHub 설정을 저장했습니다. 새 릴리스는 만들지 않았습니다.",
    );
    expect(sent).toEqual([
      {
        expected_revision: 3,
        settings: { ...SETTINGS, push_approval: false },
        start_repository_id: null,
        // A row from before the column reads `ask`; saving keeps it.
        push_attached: "ask",
      },
    ]);
    expect(
      api.calls.filter(
        (c) => c.path.endsWith("/releases") || c.path.endsWith("/activate"),
      ),
    ).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull(),
    );
  });

  test("첨부 저장소 push는 저장된 값을 보여 주고, 바꾸면 한 칸만 PUT하며, 되돌리면 초안이 사라진다", async () => {
    const { server } = await activeAgent();
    const sent: unknown[] = [];
    const { api } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`PUT ${PATH}/github/settings`]: async (request) => {
          sent.push(await request.json());
          return json(200, { settings_revision: 4, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    const select = screen.getByLabelText(
      "첨부 저장소 push",
    ) as HTMLSelectElement;
    // The row holds `ask` (a row from before the column reads as it).
    expect(select.value).toBe("ask");

    await user.selectOptions(select, "deny");
    await screen.findByText(/저장하지 않은 변경 1건/);
    await user.selectOptions(select, "ask");
    await waitFor(() =>
      expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull(),
    );

    await user.selectOptions(select, "allow");
    await screen.findByText(/첨부 저장소는 사람 승인 없이 붙으므로/);
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await screen.findByText(
      "GitHub 설정을 저장했습니다. 새 릴리스는 만들지 않았습니다.",
    );
    expect(sent).toEqual([
      {
        expected_revision: 3,
        settings: SETTINGS,
        start_repository_id: null,
        push_attached: "allow",
      },
    ]);
    expect(
      api.calls.filter(
        (c) => c.path.endsWith("/releases") || c.path.endsWith("/activate"),
      ),
    ).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull(),
    );
  });

  test("시작 저장소 칸은 없고, 저장은 서버가 가진 시작 저장소를 그대로 보낸다", async () => {
    const { server } = await activeAgent();
    const sent: { start_repository_id: string | null }[] = [];
    renderAt(
      DETAIL,
      routesFor(
        server,
        { ...TAB, start_repository_id: "werft-sandbox" },
        {
          [`PUT ${PATH}/github/settings`]: async (request) => {
            sent.push(
              (await request.json()) as { start_repository_id: string | null },
            );
            return json(200, { settings_revision: 4, receipt_id: RECEIPT_ID });
          },
        },
      ),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    expect(screen.queryByRole("heading", { name: "시작 저장소" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "시작 저장소" })).toBeNull();
    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.start_repository_id).toBe("werft-sandbox");
  });

  test("저장소 스위치 하나는 요청 하나이고, 저장 버튼 없이 바로 반영된다", async () => {
    const { server } = await activeAgent();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [ACCESS]: async () => {
          await held;
          return accessed();
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    expect(repoSwitch("werft-sandbox").getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(repoSwitch("werft-sandbox"));
    // The click shows at once, before the server answers.
    await waitFor(() =>
      expect(repoSwitch("werft-sandbox").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    const puts = () =>
      api.calls.filter((c) => c.method === "PUT" && c.path.endsWith("-access"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({
      repository: { ref: "r1.werft-sandbox" },
      enabled: false,
    });
    release();
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.path === `${PATH}/github`).length,
      ).toBeGreaterThan(1),
    );
    expect(puts()).toHaveLength(1);
    // No draft: no box, no save button, no settings PUT.
    expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(
      api.calls.filter((c) => c.path.endsWith("/github/settings")),
    ).toEqual([]);
  });

  test("저장소 스위치가 거절되면 행이 원래대로 돌아가고 이유가 행에 보인다", async () => {
    const { server } = await activeAgent();
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [ACCESS]: () => apiError(403, "FORBIDDEN", "not yours"),
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    await user.click(repoSwitch("docs-site"));
    const row = repoSwitch("docs-site").closest("li") as HTMLElement;
    expect(
      await within(row).findByText(/저장소를 바꾸지 못했습니다/),
    ).toBeTruthy();
    expect(repoSwitch("docs-site").getAttribute("aria-checked")).toBe("false");
    // The other row carries no message.
    expect(
      within(
        repoSwitch("werft-sandbox").closest("li") as HTMLElement,
      ).queryByText(/저장소를 바꾸지 못했습니다/),
    ).toBeNull();
  });

  test("연속한 스위치는 겹치지 않고 클릭한 값 그대로 차례로 보낸다", async () => {
    const { server } = await activeAgent();
    const bodies: unknown[] = [];
    let running = 0;
    let overlapped = false;
    const gates: (() => void)[] = [];
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [ACCESS]: async (request) => {
          running += 1;
          if (running > 1) overlapped = true;
          bodies.push(await request.json());
          await new Promise<void>((resolve) => gates.push(resolve));
          running -= 1;
          return accessed();
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    // Off, on again, then another row: three clicks while the first is out.
    await user.click(repoSwitch("werft-sandbox"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    await user.click(repoSwitch("werft-sandbox"));
    await user.click(repoSwitch("docs-site"));
    // The row shows the newest wish while earlier requests are still on the way.
    expect(repoSwitch("werft-sandbox").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(repoSwitch("docs-site").getAttribute("aria-checked")).toBe("true");
    for (let sent = 1; sent <= 3; sent += 1) {
      await waitFor(() => expect(gates).toHaveLength(sent));
      gates[sent - 1]?.();
    }
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(overlapped).toBe(false);
    expect(bodies).toEqual([
      { repository: { ref: "r1.werft-sandbox" }, enabled: false },
      { repository: { ref: "r1.werft-sandbox" }, enabled: true },
      { repository: { ref: "r1.docs-site" }, enabled: true },
    ]);
  });

  test("앞 요청이 거절돼도 다음 요청은 그대로 나간다", async () => {
    const { server } = await activeAgent();
    const bodies: unknown[] = [];
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [ACCESS]: async (request) => {
          bodies.push(await request.json());
          return bodies.length === 1
            ? apiError(500, "INTERNAL_ERROR", "down")
            : accessed();
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    await user.click(repoSwitch("werft-sandbox"));
    await user.click(repoSwitch("docs-site"));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      repository: { ref: "r1.docs-site" },
      enabled: true,
    });
  });

  test("저장은 됐는데 다시 읽기가 실패해도 스위치 오류로 세지 않는다", async () => {
    const { server } = await activeAgent();
    const base = routesFor(server, TAB);
    const key = `GET ${PATH}/github`;
    let saved = false;
    renderAt(DETAIL, {
      ...base,
      [key]: (request: Request) =>
        saved
          ? apiError(500, "INTERNAL_ERROR", "down")
          : (base[key] as NonNullable<(typeof base)[string]>)(request),
      [ACCESS]: () => {
        saved = true;
        return accessed();
      },
    });
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    await user.click(repoSwitch("docs-site"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("불러오지 못했습니다");
    expect(screen.queryByText(/저장소를 바꾸지 못했습니다/)).toBeNull();
    // The cache still says off, but the save went through.
    expect(repoSwitch("docs-site").getAttribute("aria-checked")).toBe("true");
  });

  test("세부 설정 초안이 있어도 켠 저장소는 켜진 채로 보인다", async () => {
    const { server } = await activeAgent();
    const tab = structuredClone(TAB);
    renderAt(
      DETAIL,
      routesFor(server, tab, {
        [ACCESS]: () => {
          tab.github = {
            ...SETTINGS,
            repositories: ["werft-sandbox", "docs-site"],
          };
          return accessed();
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.selectOptions(screen.getByLabelText("첨부 저장소 push"), "deny");
    await screen.findByText(/저장하지 않은 변경 1건/);
    await user.click(repoSwitch("docs-site"));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("switch", { name: "acme/docs-site 사용" })[0]
          ?.getAttribute("aria-checked"),
      ).toBe("true"),
    );
    // Settled: the draft's older repository list does not undo it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(repoSwitch("docs-site").getAttribute("aria-checked")).toBe("true");
  });

  test("카탈로그가 받은 뒤에도 옛 설치 목록이 catalog_id 없이 오면 같은 이름의 행에 합친다", async () => {
    const { repositoryRows } = await import("./github-repositories.tsx");
    const rows = repositoryRows(
      TAB,
      ["werft-sandbox"],
      [
        {
          github_repository_id: 11,
          full_name: "Acme/Werft-Sandbox",
          default_branch: "main",
          private: true,
          catalog_id: null,
        },
      ],
      77,
    );
    expect(rows.filter((row) => /werft-sandbox/i.test(row.name))).toHaveLength(
      1,
    );
    expect(rows.find((row) => row.key === "werft-sandbox")?.on).toBe(true);
  });

  test("저장소 행은 owner/repo 링크와 스위치 하나뿐이다", async () => {
    const { server } = await activeAgent();
    renderAt(DETAIL, routesFor(server, TAB));
    await screen.findByRole("heading", { name: "저장소" });
    const row = repoSwitch("docs-site").closest("li") as HTMLElement;
    const link = within(row).getByRole("link", { name: "acme/docs-site" });
    // The clone URL's ".git" never reaches the person.
    expect(link.getAttribute("href")).toBe("https://github.com/acme/docs-site");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(row.textContent).toBe("acme/docs-site");
    expect(within(row).getAllByRole("switch")).toHaveLength(1);
    expect(screen.queryByText("사용 중")).toBeNull();
    expect(screen.queryByText("안 씀")).toBeNull();
    expect(screen.queryByText(/\.git/)).toBeNull();
    expect(screen.queryByRole("button", { name: /고르기/ })).toBeNull();
  });

  test("저장소 스위치가 대기 중이면 세부 설정 저장은 잠깐 막는다", async () => {
    const { server } = await activeAgent();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [ACCESS]: async () => {
          await held;
          return accessed();
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    const save = (await screen.findByRole("button", {
      name: "저장",
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(repoSwitch("docs-site"));
    await waitFor(() => expect(save.disabled).toBe(true));
    release();
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  test("시작 저장소가 없던 초안은, 다른 곳에서 시작 저장소를 정해도 손으로 되돌리면 사라진다", async () => {
    const { server } = await activeAgent();
    let live: Tab = TAB;
    const { services } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}/github`]: () => json(200, live),
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    await screen.findByText("저장하지 않은 변경 1건");
    live = {
      ...TAB,
      settings_revision: 4,
      start_repository_id: "werft-sandbox",
    };
    await services.queryClient.invalidateQueries();
    await screen.findByText(/다른 곳에서 GitHub 설정이 바뀌어/);
    await user.click(switchNamed("push 전 사람 승인"));
    await waitFor(() =>
      expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull(),
    );
    expect(screen.queryByText(/다른 곳에서 GitHub 설정이 바뀌어/)).toBeNull();
  });

  test("저장소 없이 시작한 설정도 첫 저장은 바로 낼 수 있다", async () => {
    const { server } = await activeAgent({ repository: null, github: null });
    const sent: unknown[] = [];
    const empty: Settings = {
      repositories: [],
      push_approval: false,
      features: {
        workflows: false,
        actions: false,
        checks: false,
        issues: false,
        review: false,
      },
      actions_allow: [],
    };
    renderAt(
      DETAIL,
      routesFor(
        server,
        {
          ...TAB,
          github: null,
          settings_revision: null,
          push_attached: "allow" as const,
          legacy_defaults: empty,
        },
        {
          [`PUT ${PATH}/github/settings`]: async (request) => {
            sent.push(await request.json());
            return json(200, { settings_revision: 0, receipt_id: RECEIPT_ID });
          },
        },
      ),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    expect(
      screen.getByText(/이 에이전트에는 저장한 GitHub 설정이 아직/),
    ).toBeTruthy();
    for (const id of ["werft-sandbox", "docs-site"]) {
      expect(repoSwitch(id).getAttribute("aria-checked")).toBe("false");
      expect(repoSwitch(id).disabled).toBe(false);
    }

    expect(switchNamed("push 전 사람 승인").getAttribute("aria-checked")).toBe(
      "false",
    );
    // The first save is on offer before any change, even with no repository.
    await screen.findByText("GitHub 설정을 아직 저장하지 않았습니다");
    const save = screen.getByRole("button", {
      name: "저장",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(
      "GitHub 설정을 저장했습니다. 새 릴리스는 만들지 않았습니다.",
    );
    expect(sent).toEqual([
      {
        expected_revision: null,
        settings: empty,
        start_repository_id: null,
        push_attached: "allow",
      },
    ]);
  });

  test("다른 곳에서 먼저 저장했으면 덮어쓰지 않고 알리며, 초안은 남겨 둔다", async () => {
    const { server } = await activeAgent();
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`PUT ${PATH}/github/settings`]: () =>
          json(409, {
            error: {
              code: "REVISION_CONFLICT",
              message: "The settings changed",
              retryable: false,
              request_id: "req-1",
            },
          }),
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await screen.findByText(/다른 곳에서 GitHub 설정이 먼저 바뀌어/);
    // The draft stays until it is discarded.
    expect(screen.getByText("저장하지 않은 변경 1건")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "버리고 새로 읽기" }),
    ).toBeTruthy();
  });

  test("다른 곳에서 저장한 뒤 다시 읽어도, 그 전에 만든 초안은 저장하지 않는다", async () => {
    const { server } = await activeAgent();
    let live: Tab = TAB;
    let puts = 0;
    const { services } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}/github`]: () => json(200, live),
        [`PUT ${PATH}/github/settings`]: () => {
          puts += 1;
          return json(200, { settings_revision: 5, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    // Someone else saves while the draft is open.
    live = {
      ...TAB,
      settings_revision: 4,
      github: { ...SETTINGS, push_approval: false },
    };
    await services.queryClient.invalidateQueries();
    await screen.findByText(/다른 곳에서 GitHub 설정이 바뀌어/);
    const save = screen.getByRole("button", {
      name: "저장",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(puts).toBe(0);

    await user.click(screen.getByRole("button", { name: "버리고 새로 읽기" }));
    await waitFor(() =>
      expect(screen.queryByText(/다른 곳에서 GitHub 설정이 바뀌어/)).toBeNull(),
    );
    expect(switchNamed("push 전 사람 승인").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  test("손으로 되돌린 변경은 초안을 남기지 않아, 다른 곳에서 저장한 뒤의 새 변경이 새 revision으로 저장된다", async () => {
    const { server } = await activeAgent();
    let live: Tab = TAB;
    const sent: { expected_revision: number | null }[] = [];
    const { services } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}/github`]: () => json(200, live),
        [`PUT ${PATH}/github/settings`]: async (request) => {
          sent.push(
            (await request.json()) as { expected_revision: number | null },
          );
          return json(200, { settings_revision: 5, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "권한" });
    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(switchNamed("push 전 사람 승인"));
    expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull();

    live = { ...TAB, settings_revision: 4 };
    await services.queryClient.invalidateQueries();
    await waitFor(() =>
      expect(screen.queryByText(/저장하지 않은 변경/)).toBeNull(),
    );

    await user.click(switchNamed("push 전 사람 승인"));
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.expected_revision).toBe(4);
    expect(screen.queryByText(/다른 곳에서 GitHub 설정이 바뀌어/)).toBeNull();
  });

  test("Actions를 끄면 허용 목록도 비워서 저장한다", async () => {
    const { server } = await activeAgent();
    const sent: { settings: Settings }[] = [];
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`PUT ${PATH}/github/settings`]: async (request) => {
          sent.push((await request.json()) as { settings: Settings });
          return json(200, { settings_revision: 4, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "Actions 허용 목록" });
    await user.click(switchNamed("Actions 실행"));
    expect(
      screen.queryByRole("heading", { name: "Actions 허용 목록" }),
    ).toBeNull();
    expect(screen.getByText("저장하지 않은 변경 2건")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.settings.features.actions).toBe(false);
    expect(sent[0]?.settings.actions_allow).toEqual([]);
  });

  test("GitHub 사용을 끄려면 확인을 거치고, 꺼지면 설정은 읽기만 한다", async () => {
    const { server } = await activeAgent();
    let enabled = true;
    const puts: unknown[] = [];
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}/github`]: () => json(200, { ...TAB, enabled }),
        [`PUT ${PATH}/github/enabled`]: async (request) => {
          const body = (await request.json()) as { enabled: boolean };
          puts.push(body);
          enabled = body.enabled;
          return json(200, { enabled, receipt_id: RECEIPT_ID });
        },
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    await user.click(switchNamed("GitHub 사용"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/진행 중인 세션도 다음 GitHub 요청부터/),
    ).toBeTruthy();
    expect(puts).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "끄기" }));
    await screen.findByText(
      "GitHub 사용이 꺼져 있어 아래 설정은 읽기만 할 수 있습니다.",
    );
    expect(puts).toEqual([{ enabled: false }]);
    expect(repoSwitch("docs-site").disabled).toBe(true);
    expect(switchNamed("push 전 사람 승인").disabled).toBe(true);
  });

  test("기록은 세션으로 잇고, 설정 저장 기록은 따로 이름 붙인다", async () => {
    const { server } = await activeAgent();
    const receipt: components["schemas"]["Receipt"] = {
      id: RECEIPT_ID,
      operation: "dispatch_workflow",
      target_ref: { session_id: SESSION, turn_id: null, request_id: null },
      status: "failed",
      result: {
        session_id: SESSION,
        repository_id: "werft-sandbox",
        purpose: "dispatch",
        workflow: "deploy.yml",
        ref: "main",
        reason_code: "workflow_not_allowed",
      },
      error: { code: "GITHUB_REFUSED", message: "GitHub work refused" },
      created_at: "2026-10-30T00:00:00.000Z",
      updated_at: "2026-10-30T00:00:00.000Z",
    };
    renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [`GET ${PATH}/github/activity`]: () =>
          json(200, {
            items: [
              receipt,
              {
                ...receipt,
                id: "00000000-0000-4000-8000-0000000000d2",
                operation: "set_agent_github",
                target_ref: {
                  resource: { kind: "agent", id: AGENT_ID },
                  workspace_id: null,
                },
                status: "succeeded",
                result: { change: "settings", enabled: true },
                error: null,
              },
            ],
            // The receipt only holds the catalog id; the name comes beside it.
            receipt_repositories: [
              { receipt_id: RECEIPT_ID, repository: "acme/werft-sandbox" },
            ],
          }),
      }),
    );
    const user = await setupUser();
    await screen.findByRole("heading", { name: "저장소" });
    await openSection(user, "최근 기록");
    const rows = await screen.findByRole("list", { name: "최근 기록" });
    expect(within(rows).getByText("GitHub 설정 저장")).toBeTruthy();
    expect(within(rows).getByText("워크플로 실행 거절")).toBeTruthy();
    expect(
      within(rows).getByText(
        /^deploy\.yml @ main · acme\/werft-sandbox · 허용 목록 밖 ·$/,
      ),
    ).toBeTruthy();
    // The alias is not shown anywhere on the row.
    expect(within(rows).queryByText(/(^| )werft-sandbox( |$)/)).toBeNull();
    expect(
      within(rows).getByRole("link", { name: /세션/ }).getAttribute("href"),
    ).toBe(`/sessions/${SESSION}`);
  });
});

describe("에이전트 GitHub 탭 › Pull request 서식", () => {
  const PUT = `PUT ${PATH}/github/pull-request`;
  const saved = (over: object = {}) => ({
    pull_request: {
      formatting: "on",
      template: null,
      template_name: "feature.md",
      ...over,
    },
    pull_request_revision: 1,
    receipt_id: RECEIPT_ID,
  });

  test("화면의 템플릿 최대치는 계약의 최대치와 같다", async () => {
    const { PULL_REQUEST_TEMPLATE_MAX_BYTES } = await import(
      "@werft-ai/contracts"
    );
    const { AGENT_TEMPLATE_MAX_BYTES } = await import(
      "./github-pull-request.tsx"
    );
    expect(AGENT_TEMPLATE_MAX_BYTES).toBe(PULL_REQUEST_TEMPLATE_MAX_BYTES);
  });

  test("자기 버튼으로 자기 경로에만 저장한다: GitHub 설정 PUT은 부르지 않는다", async () => {
    const { server } = await activeAgent();
    const { api } = renderAt(
      DETAIL,
      routesFor(server, TAB, { [PUT]: () => json(200, saved()) }),
    );
    const user = await setupUser();
    await user.selectOptions(await screen.findByLabelText("서식"), "on");
    await user.type(
      screen.getByLabelText("저장소 템플릿 파일 이름"),
      "feature.md",
    );
    const card = screen
      .getByRole("heading", { name: "Pull request 서식" })
      .closest("section") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "서식 저장" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(1),
    );
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`${PATH}/github/pull-request`);
    expect(put?.body).toEqual({
      pull_request: {
        formatting: "on",
        template: null,
        template_name: "feature.md",
      },
      revision: 0,
    });
  });

  test("다른 곳에서 먼저 바꿨으면 그 문장을 보이고 값을 다시 읽는다", async () => {
    const { server } = await activeAgent();
    const { api } = renderAt(
      DETAIL,
      routesFor(server, TAB, {
        [PUT]: () => apiError(409, "REVISION_CONFLICT", "stale"),
      }),
    );
    const user = await setupUser();
    await user.selectOptions(await screen.findByLabelText("서식"), "off");
    const card = screen
      .getByRole("heading", { name: "Pull request 서식" })
      .closest("section") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "서식 저장" }));
    expect(
      await screen.findByText(/다른 곳에서 먼저 바꿨습니다/),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        api.calls.filter(
          (c) => c.method === "GET" && c.path === `${PATH}/github/pull-request`,
        ).length,
      ).toBeGreaterThan(1),
    );
  });
});

describe("GitHub 탭 계산", () => {
  test("agent/ 브랜치를 가리킬 수 있는 ref 패턴을 알아본다", () => {
    expect(refusesAgentRef("agent/*")).toBe(true);
    expect(refusesAgentRef("ag*/x")).toBe(true);
    expect(refusesAgentRef("*/x")).toBe(true);
    expect(refusesAgentRef("release/*")).toBe(false);
    expect(refusesAgentRef("main")).toBe(false);
    expect(refusesAgentRef("agent")).toBe(false);
  });

  test("바뀐 권한·허용 목록 항목을 하나씩 세고, 저장소는 세지 않는다", () => {
    expect(pendingCount(SETTINGS, SETTINGS)).toBe(0);
    expect(
      pendingCount(SETTINGS, {
        ...SETTINGS,
        features: { ...SETTINGS.features, review: true },
        // Added and removed: one entry each way.
        actions_allow: [{ workflow: "ci.yml" }],
      }),
    ).toBe(3);
    // Each repository switch saves on its own, so the list is not drafted.
    expect(
      pendingCount(SETTINGS, { ...SETTINGS, repositories: ["docs-site"] }),
    ).toBe(0);
    expect(pendingCount(SETTINGS, SETTINGS, "ask", "deny")).toBe(1);
  });
});
