import { describe, expect, test } from "bun:test";
import type {
  AgentListItem,
  InstallationProfileOptionsResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import {
  CATALOG_ID,
  ceiling,
  imported,
  OPTIONS,
  RECEIPT_ID,
  version,
} from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const CODING = imported("coding-claude");

function agent(
  n: number,
  name: string,
  profile: string | null,
  release: string | null,
): AgentListItem {
  return {
    id: `5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8${n}`,
    workspace_id: WORKSPACE_ID,
    slug: `agent-${n}`,
    name,
    description: null,
    managing_team_id: null,
    managing_team_name: null,
    status: "active",
    active_release_id: release,
    activation_revision: release === null ? -1 : 0,
    created_by: USER_ID,
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
    summary: {
      version: {
        version_no: n,
        role: "역할",
        instructions: "지시",
        mcp_servers: [],
        credential_refs: [],
      },
      runtime_profile_id: profile,
      release_label: profile === null ? null : `2026-10-20_09:00:0${n}`,
      bound_credential_refs: [],
      admins: [],
      needs_input_count: 0,
      running_count: 0,
      slack_action: null,
    },
  };
}

const RELEASE = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const AGENTS = [
  agent(1, "결제 담당", "op_wl_strict_v2", RELEASE),
  agent(2, "리뷰 담당", "op_wl_strict_v1", RELEASE),
  agent(3, "초안 담당", null, null),
];

function catalog(
  start: ProfileSummary[] = [
    CODING,
    version(1, "usable"),
    version(2, "usable", { tools: ["Read", "Edit"] }),
  ],
  signedIn = me(),
  options: InstallationProfileOptionsResponse = OPTIONS,
) {
  const items = [...start];
  const retire = (id: string) => {
    const at = items.findIndex((item) => item.id === id);
    const item = items[at] as ProfileSummary;
    const retired: ProfileSummary = item.installation
      ? {
          ...item,
          installation: {
            ...item.installation,
            state: "retired",
            retired_by: USER_ID,
            retired_at: "2026-10-28T00:00:00.000Z",
          },
        }
      : {
          ...item,
          workspace: {
            ...(item.workspace as NonNullable<ProfileSummary["workspace"]>),
            state: "retired",
            retired_by: USER_ID,
            retired_at: "2026-10-28T00:00:00.000Z",
          },
        };
    items[at] = retired;
    return json(200, { profile: retired, receipt_id: RECEIPT_ID });
  };
  const setBlocked = (id: string, blocked: boolean) => {
    const at = items.findIndex((item) => item.id === id);
    const item = items[at] as ProfileSummary;
    const changed: ProfileSummary = {
      ...item,
      installation: {
        ...(item.installation as NonNullable<ProfileSummary["installation"]>),
        state: blocked ? "blocked" : "usable",
      },
    };
    items[at] = changed;
    return json(200, { profile: changed, receipt_id: RECEIPT_ID });
  };
  return {
    "GET /v1/auth/me": () => json(200, signedIn),
    "GET /v1/profiles": () => json(200, { items }),
    "GET /v1/installation-profiles/options": () => json(200, options),
    // As the server filters: agents whose active release runs on the profile.
    "GET /v1/agents": (request: Request) => {
      const profile = new URL(request.url).searchParams.get(
        "runtime_profile_id",
      );
      const items = AGENTS.filter(
        (agent) =>
          profile === null ||
          (agent.active_release_id !== null &&
            agent.summary?.runtime_profile_id === profile),
      );
      return json(200, { items, next_cursor: null });
    },
    "POST /v1/installation-profiles/op_wl_strict_v2/retire": () =>
      retire("op_wl_strict_v2"),
    "POST /v1/installation-profiles/op_wide_v2/retire": () =>
      retire("op_wide_v2"),
    "POST /v1/installation-profiles/op_wide_v2/block": () =>
      setBlocked("op_wide_v2", true),
    "POST /v1/installation-profiles/op_wide_v2/unblock": () =>
      setBlocked("op_wide_v2", false),
  };
}

/** The settings and record lists, term by term. */
const values = (title: string) =>
  Object.fromEntries(
    Array.from(
      screen.getByRole("region", { name: title }).querySelectorAll("dt"),
      (term) => [term.textContent, term.nextElementSibling?.textContent],
    ),
  );

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      Array.from(row.querySelectorAll('[role="cell"]'), (cell) =>
        cell.textContent?.trim(),
      ),
    );

/** The page header's buttons: the second block beside the title, if any. */
const actions = () => {
  const header = document.querySelector("[data-slot=page-header]");
  const side = header?.querySelectorAll(":scope > div")[1];
  return side
    ? Array.from(side.querySelectorAll("a, button"), (item) => item.textContent)
    : [];
};
// The hard-to-undo ones, last on the page.
const dangers = () =>
  Array.from(
    document.querySelectorAll("[data-slot=danger-zone] button"),
    (item) => item.textContent,
  );

describe("프로필 상세", () => {
  test("a workspace profile opens like any other, with its source, record, history and the agents on it", async () => {
    const { history, api } = renderAt("/profiles", catalog());
    const user = await setupUser();
    await user.click(
      await screen.findByRole("link", {
        name: "op_wl_strict_v2 자세히 보기",
      }),
    );
    // The server picks the profile's agents; no agent list is read whole.
    await waitFor(() =>
      expect(
        api.calls
          .filter((c) => c.path === "/v1/agents")
          .map((c) => new URLSearchParams(c.search).get("runtime_profile_id")),
      ).toEqual(["op_wl_strict_v2"]),
    );
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(values("설정")).toEqual({
      id: "op_wl_strict_v2",
      "바탕 프로필": "coding-claude",
      연결: "anthropic",
      런타임: "claude_agent_sdk 0.3.270",
      "기본 모델": "claude-sonnet-5",
      "고를 수 있는 모델": "claude-sonnet-5",
      "제목 모델": "기본 모델",
      "차단한 도구": "WriteBashWebFetchWebSearch",
      "실행하는 도구": "ReadEdit",
      "권한 모드": "default",
      "저장소의 CLAUDE.md 읽기": "끔",
      비용: "비용 집계",
    });
    expect(values("기록")).toMatchObject({
      "만든 사람": `${USER_ID} (나)`,
    });
    expect(
      cells(screen.getByRole("table", { name: "버전 기록" })).map((row) =>
        row.slice(0, 2),
      ),
    ).toEqual([
      ["strict v2 지금 보는 버전op_wl_strict_v2", "사용 가능"],
      ["strict v1op_wl_strict_v1", "사용 가능"],
    ]);
    const agents = await screen.findByRole("table", {
      name: "이 프로필을 쓰는 에이전트",
    });
    expect(cells(agents)).toEqual([["결제 담당", "2026-10-20_09:00:01"]]);
    expect(actions()).toEqual(["이 프로필을 복제해 만들기", "새 버전"]);
    expect(dangers()).toEqual(["차단", "사용 중지"]);
    expect(
      within(agents)
        .getByRole("link", { name: "결제 담당의 릴리스 보기" })
        .getAttribute("href"),
    ).toBe(`/agents/${AGENTS[0]?.id}?tab=release`);

    await user.click(
      screen.getByRole("link", { name: "op_wl_strict_v1 자세히 보기" }),
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe("/profiles/op_wl_strict_v1"),
    );
    await waitFor(() =>
      expect(
        cells(screen.getByRole("table", { name: "이 프로필을 쓰는 에이전트" })),
      ).toEqual([["리뷰 담당", "2026-10-20_09:00:02"]]),
    );
  });

  test("새 버전 opens the creation page on this version", async () => {
    const { history } = renderAt("/profiles/op_wl_strict_v2", catalog());
    const user = await setupUser();
    await user.click(await screen.findByRole("link", { name: "새 버전" }));
    await screen.findByRole("heading", { level: 1, name: "strict 새 버전" });
    expect(history.location.pathname).toBe("/profiles/new");
    expect(history.location.search).toContain("from=op_wl_strict_v2");
    expect(history.location.search).toContain("mode=version");
  });

  test("retiring a version asks first, then shows it retired with who did it", async () => {
    const { api } = renderAt("/profiles/op_wl_strict_v2", catalog());
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "이 버전 사용 중지" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "op_wl_strict_v2 버전을 사용 중지할까요?",
    });
    expect(within(dialog).getByText(/되돌릴 수 없습니다/)).toBeDefined();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    await screen.findByText("op_wl_strict_v2 버전을 사용 중지했습니다.");
    await waitFor(() =>
      expect(values("기록")).toMatchObject({
        "사용 중지한 사람": `${USER_ID} (나)`,
      }),
    );
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual(["/v1/installation-profiles/op_wl_strict_v2/retire"]);
    expect(
      screen.queryAllByRole("button", { name: "이 버전 사용 중지" }).length,
    ).toBe(0);
  });

  test("a ceiling shows its definition, its record and the versions linked to it", async () => {
    renderAt(
      "/profiles/op_wide_v2",
      catalog([
        CODING,
        ceiling("wide", 1, {}, { previous_id: "coding-claude" }),
        ceiling("wide", 2, { permission_mode: "auto" }),
        version(1, "usable", {}, "op_wide_v2"),
      ]),
    );
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(values("설정")).toEqual({
      id: "op_wide_v2",
      연결: "anthropic",
      런타임: "claude_agent_sdk 0.3.270",
      "기본 모델": "claude-sonnet-5",
      "고를 수 있는 모델": "claude-sonnet-5claude-haiku-5",
      "제목 모델": "claude-haiku-5",
      "차단한 도구": "WriteWebFetchWebSearch",
      "실행하는 도구": "ReadEditBash",
      "권한 모드": "auto",
      비용: "비용 집계",
      "저장소의 CLAUDE.md 읽기": "켬",
    });
    expect(values("기록")).toEqual({
      출처: "콘솔에서 만듦",
      "만든 사람": `${USER_ID} (나)`,
      "만든 때": expect.any(String),
      "앞 버전": "op_wide_v1",
    });
    // The line runs back through v1 to the import it replaced.
    expect(
      cells(screen.getByRole("table", { name: "버전 기록" })).map(
        (row) => row[0],
      ),
    ).toEqual([
      "wide v2 지금 보는 버전op_wide_v2",
      "wide v1op_wide_v1",
      "coding-claude v1coding-claude",
    ]);
    expect(
      cells(
        screen.getByRole("table", {
          name: "이 프로필로 만든 프로필",
        }),
      ),
    ).toEqual([["strict v1op_wl_strict_v1", "사용 가능", "claude-sonnet-5"]]);
    expect(actions()).toEqual(["이 프로필을 복제해 만들기", "새 버전"]);
    expect(dangers()).toEqual(["차단", "사용 중지"]);
  });

  test("an earlier ceiling version offers no 새 버전, which only the latest takes", async () => {
    renderAt(
      "/profiles/op_wide_v1",
      catalog([CODING, ceiling("wide", 1), ceiling("wide", 2)]),
    );
    await screen.findByRole("region", { name: "기록" });
    expect(actions()).toEqual(["이 프로필을 복제해 만들기"]);
    expect(dangers()).toEqual(["차단", "사용 중지"]);
  });

  test("a ceiling followed only under another name still offers 새 버전", async () => {
    renderAt(
      "/profiles/op_wide_v1",
      catalog([
        CODING,
        ceiling("wide", 1),
        ceiling("other", 1, {}, { previous_id: "op_wide_v1" }),
        ceiling("coding", 1, {}, { previous_id: "coding-claude" }),
      ]),
    );
    await screen.findByRole("region", { name: "기록" });
    expect(actions()).toEqual(["이 프로필을 복제해 만들기", "새 버전"]);
    expect(dangers()).toEqual(["차단", "사용 중지"]);
  });

  test("an imported ceiling with a successor still offers 새 버전 under a new name", async () => {
    renderAt(
      "/profiles/coding-claude",
      catalog([
        CODING,
        ceiling("coding", 1, {}, { previous_id: "coding-claude" }),
      ]),
    );
    await screen.findByRole("region", { name: "기록" });
    expect(actions()).toContain("새 버전");
  });

  test("an imported ceiling says where it came from", async () => {
    renderAt("/profiles/coding-claude", catalog());
    // The title is the id while it loads too; wait for the record itself.
    await screen.findByRole("region", { name: "기록" });
    expect(values("기록")).toEqual({
      출처: "설정 문서에서 가져옴",
      "만든 사람": "설정 문서",
      "만든 때": expect.any(String),
      "앞 버전": "없음",
    });
    expect(
      screen.getByRole("link", { name: "새 버전" }).getAttribute("href"),
    ).toBe("/profiles/new?from=coding-claude&mode=version");
  });

  test("an owner retires a ceiling, told that what runs on it keeps running", async () => {
    const { api } = renderAt(
      "/profiles/op_wide_v2",
      catalog([CODING, ceiling("wide", 1), ceiling("wide", 2)]),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "이 버전 사용 중지" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "op_wide_v2 버전을 사용 중지할까요?",
    });
    expect(
      within(dialog).getByText(
        /이 프로필을 바탕으로 범위를 줄인 프로필은 계속 동작합니다/,
      ),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    await screen.findByText("op_wide_v2 버전을 사용 중지했습니다.");
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual(["/v1/installation-profiles/op_wide_v2/retire"]);
    expect(
      await screen.findByText(/^사용 중지했습니다\. 이미 쓰는 릴리스와 세션은/),
    ).toBeDefined();
  });

  test("a refused ceiling retire says only an owner may", async () => {
    renderAt("/profiles/op_wide_v2", {
      ...catalog([CODING, ceiling("wide", 2)]),
      "POST /v1/installation-profiles/op_wide_v2/retire": () =>
        apiError(403, "FORBIDDEN", "role"),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "이 버전 사용 중지" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    expect(
      await within(dialog).findByText(
        "연결과 실행 방식을 직접 정하는 프로필은 워크스페이스 owner만 만들고 사용 중지할 수 있습니다.",
      ),
    ).toBeDefined();
  });

  test("an owner blocks a ceiling after a warning, then unblocks it from the same button", async () => {
    const { api } = renderAt(
      "/profiles/op_wide_v2",
      catalog([CODING, ceiling("wide", 2)]),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "이 프로필 차단" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "프로필 op_wide_v2을(를) 차단할까요?",
    });
    expect(
      within(dialog).getByText(/이미 쓰는 세션도 다음 턴에서 멈추고/),
    ).toBeDefined();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "차단" }));
    await screen.findByText("프로필 op_wide_v2을(를) 차단했습니다.");
    expect((await screen.findAllByText("차단됨")).length).toBeGreaterThan(0);
    // The block button left with the refetch; focus goes to its undo.
    const unblock = await screen.findByRole("button", { name: "차단 해제" });
    await waitFor(() => expect(document.activeElement === unblock).toBe(true));

    await user.click(unblock);
    const undo = await screen.findByRole("dialog", {
      name: "프로필 op_wide_v2의 차단을 해제할까요?",
    });
    await user.click(within(undo).getByRole("button", { name: "차단 해제" }));
    await screen.findByText("프로필 op_wide_v2의 차단을 해제했습니다.");
    const again = await screen.findByRole("button", {
      name: "이 프로필 차단",
    });
    await waitFor(() => expect(document.activeElement === again).toBe(true));
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual([
      "/v1/installation-profiles/op_wide_v2/block",
      "/v1/installation-profiles/op_wide_v2/unblock",
    ]);
  });

  test("a refused block says only an owner may block", async () => {
    renderAt("/profiles/op_wide_v2", {
      ...catalog([CODING, ceiling("wide", 2)]),
      "POST /v1/installation-profiles/op_wide_v2/block": () =>
        apiError(403, "FORBIDDEN", "role"),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "이 프로필 차단" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "차단" }));
    expect(
      await within(dialog).findByText(
        "프로필은 워크스페이스 owner만 차단하고 해제할 수 있습니다.",
      ),
    ).toBeDefined();
  });

  test("an admin narrows a ceiling but neither versions nor retires it", async () => {
    renderAt(
      "/profiles/op_wide_v2",
      catalog([CODING, ceiling("wide", 2)], me(undefined, "admin")),
    );
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(actions()).toEqual(["이 프로필을 복제해 만들기"]);
    expect(
      screen.getByText(
        "연결과 실행 방식을 직접 정하는 프로필은 워크스페이스 owner만 바꿀 수 있습니다",
      ),
    ).toBeDefined();
  });

  test("a member reads the detail without actions and without the agent list", async () => {
    renderAt("/profiles/op_wl_strict_v2", catalog(undefined, memberMe()));
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(actions()).toEqual([]);
    expect(
      screen.getByText(
        "에이전트 목록은 에이전트를 관리할 수 있는 사람만 봅니다",
      ),
    ).toBeDefined();
  });

  test("a ceiling that does not run here says why and is no base to make from", async () => {
    renderAt(
      "/profiles/coding-claude",
      catalog([imported("coding-claude", {}, "connection_missing")]),
    );
    expect(
      await screen.findByText(/^이 프로필의 연결이 이 설치에 없어/),
    ).toBeDefined();
    expect(actions()).toEqual(["새 버전"]);
    expect(dangers()).toEqual(["차단", "사용 중지"]);
  });

  test("an unknown id says the profile is not there", async () => {
    renderAt("/profiles/nope", catalog());
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "프로필을 찾을 수 없습니다",
      }),
    ).toBeDefined();
  });
});

describe("프로필 상세의 새 버전 적용 현황", () => {
  const AGENT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
  const rolled = (over: Partial<ProfileSummary["installation"]> = {}) =>
    ceiling(
      "wide",
      2,
      {},
      {
        rollout: {
          total: 3,
          applied: 1,
          pending: 1,
          failed: 1,
          failed_agents: [
            {
              agent_id: AGENT,
              name: "재무 분석가",
              reason: "credential_unbound",
            },
          ],
          fixed_model_agents: 2,
        },
        ...over,
      },
    );

  test("an owner reads how many took the version, who was refused, and retries one", async () => {
    const { api } = renderAt("/profiles/op_wide_v2", {
      ...catalog([CODING, ceiling("wide", 1), rolled()]),
      "POST /v1/installation-profiles/op_wide_v2/rollout/retry": () =>
        json(200, { retried: true }),
    });
    const user = await setupUser();
    const region = await screen.findByRole("region", {
      name: "새 버전 적용 현황",
    });
    expect(within(region).getByText("3개 중 1개 적용")).toBeDefined();
    expect(
      within(region).getByText("1개는 적용을 기다리는 중입니다."),
    ).toBeDefined();
    expect(
      within(region).getByText(
        "고른 모델을 쓰는 에이전트 2개는 기본 모델이 바뀌어도 그대로 유지됩니다.",
      ),
    ).toBeDefined();
    expect(
      cells(
        within(region).getByRole("table", { name: "적용하지 못한 에이전트" }),
      ),
    ).toEqual([["재무 분석가", "credential_unbound", "다시 시도"]]);
    await user.click(
      within(region).getByRole("button", { name: "재무 분석가 다시 시도" }),
    );
    await screen.findByText("다시 적용하도록 올렸습니다: 재무 분석가");
    const retry = api.calls.find((call) => call.method === "POST");
    expect(retry?.path).toBe(
      "/v1/installation-profiles/op_wide_v2/rollout/retry",
    );
    expect(retry?.body).toEqual({ agent_id: AGENT });
  });

  test("an admin reads the numbers but is offered no retry", async () => {
    renderAt(
      "/profiles/op_wide_v2",
      catalog([CODING, ceiling("wide", 1), rolled()], me(undefined, "admin")),
    );
    const region = await screen.findByRole("region", {
      name: "새 버전 적용 현황",
    });
    expect(within(region).getByText("3개 중 1개 적용")).toBeDefined();
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
  });

  test("a version nobody was put in for shows no section", async () => {
    renderAt("/profiles/op_wide_v2", catalog([CODING, ceiling("wide", 2)]));
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(
      screen.queryByRole("region", { name: "새 버전 적용 현황" }),
    ).toBeNull();
  });
});

describe("프로필 상세의 도구", () => {
  const NEWER: InstallationProfileOptionsResponse = {
    ...OPTIONS,
    // Oldest first, as the runtime codecs install them.
    tool_catalogs: [
      {
        id: "claude_agent_sdk@0.3.260+claude-code@2.1.260",
        runtime_kind: "claude_agent_sdk",
        runtime_version: "0.3.260",
        tools: [
          { name: "Read", boundary: "local" },
          { name: "Edit", boundary: "local" },
          { name: "Write", boundary: "local" },
          { name: "Bash", boundary: "local" },
          { name: "WebFetch", boundary: "egress" },
        ],
      },
      ...(OPTIONS.tool_catalogs ?? []),
    ],
  };

  test("a version on an older catalog says how many new tools it blocks and links to a new version", async () => {
    const { history } = renderAt(
      "/profiles/op_wide_v1",
      catalog(
        [
          CODING,
          ceiling("wide", 1, {
            runtime_version: "0.3.260",
            deny: ["Write", "WebFetch"],
          }),
        ],
        me(),
        NEWER,
      ),
    );
    const notice = await screen.findByText("이 버전에서 막힌 새 도구 1개");
    const alert = notice.closest("[data-slot=alert]") as HTMLElement;
    expect(alert.textContent).toContain(
      `이 버전이 차단 여부를 정한 적 없는 도구라 돌지 않습니다: WebSearch. 열려면 지원 카탈로그 ${CATALOG_ID}로 새 버전을 만들어 받아들입니다.`,
    );
    expect(values("설정")).toMatchObject({
      "차단한 도구": "WriteWebFetch",
      "실행하는 도구": "ReadEditBash",
    });
    const user = await setupUser();
    await user.click(
      within(alert).getByRole("link", { name: "새 버전 만들기" }),
    );
    await screen.findByRole("heading", { level: 1, name: "wide 새 버전" });
    expect(history.location.search).toContain("from=op_wide_v1");
    expect(history.location.search).toContain("mode=version");
  });

  test("a version on the newest catalog has no new tools to tell about", async () => {
    renderAt(
      "/profiles/op_wide_v1",
      catalog([CODING, ceiling("wide", 1)], me(), NEWER),
    );
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(values("설정")).toMatchObject({
      "차단한 도구": "WriteWebFetchWebSearch",
    });
    expect(screen.queryAllByText(/막힌 새 도구/)).toHaveLength(0);
  });

  test("a version no catalog lists shows its tool list read-only", async () => {
    renderAt(
      "/profiles/op_wide_v1",
      catalog([CODING, ceiling("wide", 1, { runtime_version: "0.3.100" })]),
    );
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(values("설정")).toMatchObject({
      "차단한 도구":
        "이 버전의 런타임 버전에는 지원 카탈로그가 없습니다. 도구 목록(허용목록)으로만 정한 버전이라 콘솔에서는 읽기만 합니다.",
      "실행하는 도구": "ReadEditBash",
    });
  });

  test("an admin, who cannot read the catalogs, is not asked to", async () => {
    const { api } = renderAt(
      "/profiles/op_wide_v1",
      catalog(
        [CODING, ceiling("wide", 1, { runtime_version: "0.3.260" })],
        me(undefined, "admin"),
        NEWER,
      ),
    );
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(
      api.calls.some((call) =>
        call.path.startsWith("/v1/installation-profiles"),
      ),
    ).toBe(false);
    expect(screen.queryAllByText(/막힌 새 도구/)).toHaveLength(0);
  });
});
