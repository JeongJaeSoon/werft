import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const NOW = new Date("2026-10-24T12:40:00.000Z");

const COUNTS = {
  counts: {
    queued: 2,
    running: 7,
    needs_input: 3,
    idle: 41,
    failed: 1,
    stopped: 12,
  },
  total: 66,
};

const LIMITS = {
  scope: "installation",
  refreshed_at: "2026-10-24T12:40:00.000Z",
  limits: {
    execution_slot_limit: 10,
    queued_input_limit_per_session: 20,
    storage_limit_bytes: 10737418240,
    max_turn_seconds: 3600,
    session_cost_limit_usd: "25.00",
    session_token_limit: null,
    provider_max_retries: 3,
  },
  usage: {
    execution_slots_used: 7,
    queued_input_count: 4,
    storage: {
      used_bytes: 2147483648,
      accounted_content: ["input_messages"],
      updated_at: "2026-10-24T12:31:00.000Z",
    },
    outputs: { used_bytes: 0, updated_at: null, complete: true },
    archived_events: { used_bytes: 0, updated_at: null },
  },
};

function series(scope: "me" | "installation", days: number) {
  return {
    period: {
      since: new Date(Date.UTC(2026, 9, 25 - days)).toISOString(),
      until: "2026-10-25T00:00:00.000Z",
    },
    refreshed_at: NOW.toISOString(),
    buckets: Array.from({ length: days }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, 25 - days + i))
        .toISOString()
        .slice(0, 10),
      session_count: scope === "me" ? (i < 17 ? 1 : 0) : i,
      cost_usd: "34.85",
      cost_complete: true,
      token_count: 1_272_000,
      run_seconds: 7710,
    })),
  };
}

function figures(sessions: number, cost: string) {
  return {
    session_count: sessions,
    input_tokens: 1000 * sessions,
    output_tokens: 500 * sessions,
    cache_read_input_tokens: 2000 * sessions,
    cache_creation_input_tokens: 100 * sessions,
    token_count: 3600 * sessions,
    cost_usd: cost,
  };
}

const BREAKDOWN = {
  agent: [
    { key: "a1", label: "release-notes-writer", ...figures(40, "412.30") },
    { key: "a2", label: "triage-bot", ...figures(30, "301.20") },
    { key: "a3", label: "pr-reviewer", ...figures(20, "200.00") },
    { key: null, label: null, ...figures(10, "132.00") },
  ],
  model: [
    {
      key: "claude-sonnet-4-5-20250929",
      label: "claude-sonnet-4-5-20250929",
      ...figures(80, "900.00"),
    },
    { key: null, label: null, ...figures(5, "145.50") },
  ],
};

const TOOLS = {
  tools: [
    {
      name: "Bash",
      calls: 1840,
      failed: 21,
      total_ms: 13320000,
      median_ms: 3100,
      max_ms: 298000,
      description: null,
    },
    {
      name: "Read",
      calls: 1204,
      failed: 2,
      total_ms: 1080000,
      median_ms: 400,
      max_ms: 9100,
      description: null,
    },
    {
      name: "Edit",
      calls: 702,
      failed: 12,
      total_ms: 1620000,
      median_ms: 900,
      max_ms: 14200,
      description: null,
    },
    {
      name: "WebFetch",
      calls: 214,
      failed: 1,
      total_ms: 3960000,
      median_ms: 12400,
      max_ms: 61000,
      description: null,
    },
  ],
  findings: [
    { kind: "most_time", name: "Bash" },
    { kind: "fails_often", name: "Edit" },
    { kind: "slowest", name: "WebFetch" },
  ],
};

function toolCalls(name: string) {
  return {
    calls: [
      {
        session_id: "11111111-1111-4111-8111-111111111111",
        title: `${name} 리뷰`,
        agent: "리뷰 봇",
        occurred_at: "2026-10-24T12:39:10.000Z",
        duration_ms: null,
        outcome: "unknown",
      },
      {
        session_id: null,
        title: null,
        agent: "배포 도우미",
        occurred_at: "2026-10-24T12:36:41.000Z",
        duration_ms: 41200,
        outcome: "ok",
      },
      {
        session_id: "22222222-2222-4222-8222-222222222222",
        title: "에이전트 없는 세션",
        agent: null,
        occurred_at: "2026-10-24T12:31:15.000Z",
        duration_ms: 3400,
        outcome: "failed",
      },
    ],
    next_cursor: null,
    per_day: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 25 + i)).toISOString().slice(0, 10),
      calls: i + 1,
    })),
  };
}

// The fake API answers by path, and nothing for /v1/usage/summary; the call
// log says which period was asked.
const usageRoutes = {
  "GET /v1/sessions/counts": () => json(200, COUNTS),
  "GET /v1/usage/tools": () => json(200, TOOLS),
  ...Object.fromEntries(
    TOOLS.tools.map(({ name }) => [
      `GET /v1/usage/tools/${name}/calls`,
      () => json(200, toolCalls(name)),
    ]),
  ),
  "GET /v1/usage/breakdown": (request: Request) => {
    const by = new URL(request.url).searchParams.get("by") as "agent" | "model";
    return json(200, {
      rows: BREAKDOWN[by],
      totals: figures(100, "1045.50"),
    });
  },
  "GET /v1/usage/series": (request: Request) => {
    const query = new URL(request.url).searchParams;
    const days = Math.round(
      (Date.parse(query.get("until") ?? "") -
        Date.parse(query.get("since") ?? "")) /
        86_400_000,
    );
    return json(200, series(query.get("scope") as "me" | "installation", days));
  },
};

describe("사용량·한도", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("owner: 사이드바 '사용량·한도'에서 개요를 열고, '지금' 숫자는 /v1/sessions/counts 그대로다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
    });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    expect(
      within(nav)
        .getByRole("link", { name: "사용량·한도" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const counts = await screen.findByRole("link", {
      name: /^실행 중|작업 중/,
    });
    expect(counts.textContent).toBe("작업 중7");
    const cells = screen
      .getAllByRole("link")
      .filter(
        (a) =>
          a.getAttribute("href")?.startsWith("/sessions") &&
          /\d$/.test(a.textContent ?? ""),
      )
      .map((a) => [a.textContent, a.getAttribute("href")]);
    expect(cells).toEqual([
      ["대기 중2", "/sessions"],
      ["작업 중7", "/sessions?status=running"],
      ["답변 대기3", "/sessions?status=needs_input"],
      ["쉬는 중41", "/sessions?status=idle"],
      ["실패1", "/sessions?status=failed"],
      ["멈춤12", "/sessions?status=stopped"],
    ]);
    expect(await screen.findByText("동시 실행 슬롯 · 설치 전체")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "사용량·한도 탭" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["개요", "사용량", "도구 활동", "한도"]);
    expect(screen.getByRole("group", { name: "집계 범위" })).toBeTruthy();
    const asked = api.calls.find((call) => call.path === "/v1/usage/series");
    expect(asked?.search).toBe(
      "?scope=installation&since=2026-09-25T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z",
    );
  });

  test("KPI 4개는 summary를 부르지 않고 같은 series 버킷의 합이다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
    });
    expect(await screen.findByText("435")).toBeTruthy();
    const text = document.body.textContent ?? "";
    for (const value of ["64시간 15분", "$1,045.50", "3,816만"]) {
      expect(text).toContain(value);
    }
    expect(
      api.calls
        .filter((call) => call.path.startsWith("/v1/usage/"))
        .map((call) => call.path)
        .sort(),
    ).toEqual(["/v1/usage/breakdown", "/v1/usage/series", "/v1/usage/tools"]);
  });

  test("개요의 '살펴볼 것'은 /v1/usage/tools의 findings이고 도구 활동 탭으로 이어진다", async () => {
    setSystemTime(NOW);
    renderAt("/operations?days=7", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
    });
    const section = (
      await screen.findByRole("heading", { name: "살펴볼 것" })
    ).closest("section");
    if (!section) throw new Error("no 살펴볼 것 section");
    await waitFor(() =>
      expect(
        within(section)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "가장 오래 걸리는 도구: Bash3시간 42분 · 전체 도구 시간의 67%",
        "자주 실패하는 도구: Edit702번 중 12번 실패 (1.7%)",
        "가장 느린 도구: WebFetch보통 12.4초 · 호출 214번",
      ]),
    );
    expect(
      within(section)
        .getByRole("link", { name: "도구 활동" })
        .getAttribute("href"),
    ).toBe("/operations/tools?days=7");
  });

  test("개요의 '비용이 큰 에이전트'는 에이전트별 비용 위 3개이고, '사용량 자세히'는 기간을 들고 간다", async () => {
    setSystemTime(NOW);
    const { api, history } = renderAt("/operations?days=7", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
    });
    const table = await screen.findByRole("table", {
      name: "비용이 큰 에이전트",
    });
    await within(table).findByText("release-notes-writer");
    expect(within(table).getByText("pr-reviewer")).toBeTruthy();
    expect(within(table).queryByText("에이전트 없음")).toBeNull();
    expect(within(table).queryByText("토큰")).toBeNull();
    expect(screen.getByText("최근 7일 추정 비용 순")).toBeTruthy();
    const asked = api.calls.find((call) => call.path === "/v1/usage/breakdown");
    expect(asked?.search).toBe(
      "?scope=me&since=2026-10-18T00%3A00%3A00.000Z&by=agent&until=2026-10-25T00%3A00%3A00.000Z",
    );
    const user = await setupUser();
    await user.click(screen.getByRole("link", { name: "사용량 자세히" }));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/operations/usage"),
    );
    expect(history.location.search).toBe("?days=7");
  });

  test("사용량·도구 활동 탭은 비활성 없이 제 화면을 연다", async () => {
    setSystemTime(NOW);
    const { history } = renderAt("/operations", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
    });
    const tabs = await screen.findByRole("navigation", {
      name: "사용량·한도 탭",
    });
    const usage = within(tabs).getByRole("link", { name: "사용량" });
    const tools = within(tabs).getByRole("link", { name: "도구 활동" });
    expect(usage.getAttribute("aria-disabled")).toBeNull();
    expect(usage.getAttribute("href")).toBe("/operations/usage");
    expect(tools.getAttribute("aria-disabled")).toBeNull();
    expect(tools.getAttribute("href")).toBe("/operations/tools");
    const user = await setupUser();
    await user.click(usage);
    await waitFor(() =>
      expect(history.location.pathname).toBe("/operations/usage"),
    );
  });

  test("탭을 오가도 기간·범위가 남고, 한도 탭과 도구의 에이전트는 들고 가지 않는다", async () => {
    setSystemTime(NOW);
    const { history } = renderAt(
      "/operations/tools?days=7&scope=me&agent_id=00000000-0000-4000-8000-000000000001",
      {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/limits": () => json(200, LIMITS),
        ...usageRoutes,
      },
    );
    const tab = async (name: string) =>
      within(
        await screen.findByRole("navigation", { name: "사용량·한도 탭" }),
      ).getByRole("link", { name });
    const search = () =>
      Object.fromEntries(new URLSearchParams(history.location.search));
    const user = await setupUser();
    for (const [name, path] of [
      ["개요", "/operations"],
      ["사용량", "/operations/usage"],
      ["도구 활동", "/operations/tools"],
    ] as const) {
      await user.click(await tab(name));
      await waitFor(() => expect(history.location.pathname).toBe(path));
      expect(search()).toEqual({ days: "7", scope: "me" });
    }
    await user.click(await tab("한도"));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/operations/limits"),
    );
    expect(search()).toEqual({});
  });

  for (const [role, who] of [
    ["admin", () => me(undefined, "admin")],
    ["member", memberMe],
  ] as const) {
    test(`${role}: 개요에 설치 전체 범위·slot 줄이 없고 /v1/limits를 읽지 않으며, 한도 탭은 있다`, async () => {
      setSystemTime(NOW);
      const { api } = renderAt("/operations", {
        "GET /v1/auth/me": () => json(200, who()),
        ...usageRoutes,
      });
      expect(await screen.findByText("17")).toBeTruthy();
      const tabs = screen.getByRole("navigation", { name: "사용량·한도 탭" });
      expect(
        within(tabs)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ).toEqual(["개요", "사용량", "도구 활동", "한도"]);
      expect(screen.queryByRole("group", { name: "집계 범위" })).toBeNull();
      expect(screen.queryByText("동시 실행 슬롯 · 설치 전체")).toBeNull();
      expect(api.calls.some((call) => call.path === "/v1/limits")).toBe(false);
      expect(
        api.calls
          .filter((call) => call.path.startsWith("/v1/usage/"))
          .every((call) => call.search.startsWith("?scope=me&")),
      ).toBe(true);
    });
  }

  test("기간을 바꾸면 URL이 바뀌고 그 기간을 한 번씩 읽는다", async () => {
    setSystemTime(NOW);
    const { api, history } = renderAt("/operations", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
    });
    expect(
      await screen.findByRole("heading", { name: "최근 30일" }),
    ).toBeTruthy();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "7일" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "최근 7일" })).toBeTruthy(),
    );
    expect(history.location.search).toBe("?days=7");
    await waitFor(() =>
      expect(
        api.calls
          .filter(
            (call) =>
              call.path.startsWith("/v1/usage/") &&
              call.search.includes("since=2026-10-18"),
          )
          .map((call) => call.path)
          .sort(),
      ).toEqual(["/v1/usage/breakdown", "/v1/usage/series", "/v1/usage/tools"]),
    );
  });

  test("도구 활동 탭: 표와 레일, 볼 수 없는 세션은 링크가 없고 결과 모름·시간 없음·에이전트 없음을 그대로 쓴다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations/tools", {
      "GET /v1/auth/me": () => json(200, me()),
      ...usageRoutes,
    });
    const table = await screen.findByRole("table", { name: "도구와 명령" });
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) => row.textContent),
      ).toEqual([
        "Bash셸 명령1,8403시간 42분3.1초21",
        "Read파일을 읽는다1,20418분0.4초2",
        "Edit파일 일부를 고친다70227분0.9초12",
        "WebFetch웹 페이지를 가져온다2141시간 6분12.4초1",
      ]),
    );
    const tabs = screen.getByRole("navigation", { name: "사용량·한도 탭" });
    expect(
      within(tabs)
        .getByRole("link", { name: "도구 활동" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.querySelector("[data-slot=page-flush]")).not.toBeNull();
    const rail = screen.getByRole("complementary", { name: "선택한 도구" });
    expect(within(rail).getByRole("heading", { name: "Bash" })).toBeTruthy();
    const items = await within(rail).findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Bash 리뷰리뷰 봇 · 12:39—결과 모름",
      "볼 수 없는 세션배포 도우미 · 12:3641.2초완료",
      "에이전트 없는 세션12:313.4초실패",
    ]);
    expect(
      within(rail)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/sessions/11111111-1111-4111-8111-111111111111",
      "/sessions/22222222-2222-4222-8222-222222222222",
    ]);
    expect(
      within(rail)
        .getByRole("img", { name: /^Bash 일자별 호출/ })
        .getAttribute("aria-label"),
    ).toBe("Bash 일자별 호출, 최근 14일, 합계 329번, 가장 많은 날 10/24 30번");
    expect(
      api.calls
        .filter((call) => call.path.startsWith("/v1/usage/tools"))
        .map((call) => `${call.path}${call.search}`),
    ).toEqual([
      "/v1/usage/tools?scope=installation&since=2026-09-25T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z",
      "/v1/usage/tools/Bash/calls?scope=installation&since=2026-09-25T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z&sort=recent&limit=7",
    ]);
  });

  test("도구 활동 탭: 다른 도구를 고르면 그 도구의 호출을 한 번 읽고, 정렬·검색은 다시 읽지 않는다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations/tools", {
      "GET /v1/auth/me": () => json(200, me()),
      ...usageRoutes,
    });
    const table = await screen.findByRole("table", { name: "도구와 명령" });
    const user = await setupUser();
    await user.click(
      await within(table).findByRole("button", { name: "Edit 자세히 보기" }),
    );
    const rail = screen.getByRole("complementary", { name: "선택한 도구" });
    await waitFor(() =>
      expect(within(rail).getByText("Edit 리뷰")).toBeTruthy(),
    );
    const callsOf = (name: string) =>
      api.calls.filter((call) => call.path === `/v1/usage/tools/${name}/calls`);
    expect(callsOf("Edit")).toHaveLength(1);

    const before = api.calls.length;
    await user.click(
      within(screen.getByRole("group", { name: "정렬" })).getByRole("button", {
        name: "느린 순",
      }),
    );
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) => row.querySelector(".font-mono")?.textContent),
      ).toEqual(["WebFetch", "Bash", "Edit", "Read"]),
    );
    await user.type(screen.getByRole("searchbox", { name: "도구 찾기" }), "ed");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    await waitFor(() =>
      expect(
        screen
          .getByRole("table", { name: "도구와 명령" })
          .querySelectorAll("[role=row]"),
      ).toHaveLength(2),
    );
    expect(api.calls.length).toBe(before);
  });

  test("도구 활동 탭: MCP 도구는 API의 설명을, 모르는 도구는 설명 줄 없이 쓴다", async () => {
    setSystemTime(NOW);
    const mcp = {
      ...TOOLS.tools[0],
      name: "mcp__docs__find",
      description: "Finds a page in the docs",
    };
    const unknown = { ...TOOLS.tools[0], name: "Mystery", description: null };
    renderAt("/operations/tools", {
      "GET /v1/auth/me": () => json(200, me()),
      ...usageRoutes,
      "GET /v1/usage/tools": () =>
        json(200, { tools: [mcp, unknown], findings: [] }),
    });
    const table = await screen.findByRole("table", { name: "도구와 명령" });
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) => row.textContent),
      ).toEqual([
        "mcp__docs__findFinds a page in the docs1,8403시간 42분3.1초21",
        "Mystery1,8403시간 42분3.1초21",
      ]),
    );
  });

  test("도구 활동 탭: agent_id search param은 두 API에 그대로 간다", async () => {
    setSystemTime(NOW);
    const agent = "33333333-3333-4333-8333-333333333333";
    const { api } = renderAt(`/operations/tools?agent_id=${agent}`, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
    });
    await screen.findByRole("complementary", { name: "선택한 도구" });
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path.startsWith("/v1/usage/tools")),
      ).toHaveLength(2),
    );
    for (const call of api.calls.filter((c) =>
      c.path.startsWith("/v1/usage/tools"),
    )) {
      expect(new URLSearchParams(call.search).get("agent_id")).toBe(agent);
      expect(new URLSearchParams(call.search).get("scope")).toBe("me");
    }
  });

  test("사용량 탭: 일자별 비용·토큰 구성·모델별·에이전트별을 series 1회와 breakdown 2회로 그린다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
    });
    const models = await screen.findByRole("table", { name: "모델별" });
    await within(models).findByText("claude-sonnet-4-5-20250929");
    expect(within(models).getByText("호출 기록이 없는 비용")).toBeTruthy();
    const agents = screen.getByRole("table", { name: "에이전트별" });
    expect(within(agents).getByText("에이전트 없음")).toBeTruthy();
    expect(within(agents).getByText("triage-bot")).toBeTruthy();
    expect(
      screen.getByRole("figure", { name: "일자별 추정 비용, 30일" }),
    ).toBeTruthy();
    expect(screen.getByRole("table", { name: "토큰 구성" })).toBeTruthy();
    expect(screen.getByText("435")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "사용량·한도 탭" });
    expect(
      within(tabs)
        .getByRole("link", { name: "사용량" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const usage = api.calls.filter((call) =>
      call.path.startsWith("/v1/usage/"),
    );
    expect(usage.map((call) => call.path).sort()).toEqual([
      "/v1/usage/breakdown",
      "/v1/usage/breakdown",
      "/v1/usage/series",
    ]);
    expect(
      usage
        .filter((call) => call.path === "/v1/usage/breakdown")
        .map((call) => new URLSearchParams(call.search).get("by"))
        .sort(),
    ).toEqual(["agent", "model"]);
  });

  test("사용량 탭: 비용 보고가 안 끝난 지난 날의 막대만 빗금이다", async () => {
    setSystemTime(NOW);
    renderAt("/operations/usage?days=7", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
      "GET /v1/usage/series": () => {
        const body = series("me", 7);
        return json(200, {
          ...body,
          buckets: body.buckets.map((bucket) =>
            bucket.date === "2026-10-20"
              ? { ...bucket, cost_complete: false }
              : bucket,
          ),
        });
      },
    });
    const chart = await screen.findByRole("figure", {
      name: "일자별 추정 비용, 7일",
    });
    const partial = [...chart.querySelectorAll("[data-partial]")].map(
      (bar) => bar.getAttribute("aria-label") ?? "",
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]).toContain("10/20");
  });

  test("사용량 탭: 기간에 세션이 없으면 KPI 아래 빈 상태만 보인다", async () => {
    setSystemTime(NOW);
    renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
      "GET /v1/usage/series": () => {
        const body = series("me", 30);
        return json(200, {
          ...body,
          buckets: body.buckets.map((bucket) => ({
            ...bucket,
            session_count: 0,
            cost_usd: "0.00",
            token_count: 0,
            run_seconds: 0,
          })),
        });
      },
    });
    expect(
      await screen.findByText("이 기간에 시작한 세션이 없습니다."),
    ).toBeTruthy();
    expect(screen.queryByRole("table", { name: "모델별" })).toBeNull();
    expect(
      screen.queryByRole("figure", { name: /일자별 추정 비용/ }),
    ).toBeNull();
  });

  test("사용량 탭에서 90일을 고르면 URL과 차트가 함께 바뀐다", async () => {
    setSystemTime(NOW);
    const { history } = renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
    });
    await screen.findByRole("figure", { name: "일자별 추정 비용, 30일" });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "90일" }));
    expect(
      await screen.findByRole("figure", { name: "일자별 추정 비용, 90일" }),
    ).toBeTruthy();
    expect(history.location.pathname).toBe("/operations/usage");
    expect(history.location.search).toBe("?days=90");
  });

  test("사용량 탭: 새 기간·범위를 읽는 동안 남은 수치에는 그 수치의 기준 줄이 붙는다", async () => {
    setSystemTime(NOW);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
      "GET /v1/usage/series": async (request: Request) => {
        const query = new URL(request.url).searchParams;
        if (query.get("scope") === "me") await held;
        return usageRoutes["GET /v1/usage/series"](request);
      },
    });
    const basis = (scope: string, first: string) =>
      screen.getByText(
        (_, el) =>
          el?.textContent ===
          `${scope} · ${first} – 2026-10-24 (UTC) · 비용·토큰·실행 시간은 세션을 시작한 날에 붙습니다 · 오후 12:40에 읽은 값`,
      );
    await waitFor(() => basis("설치 전체", "2026-09-25"));
    const user = await setupUser();
    // 7 days of the installation, then my own, which the API holds back.
    await user.click(screen.getByRole("button", { name: "7일" }));
    await waitFor(() => basis("설치 전체", "2026-10-18"));
    await user.click(screen.getByRole("button", { name: "내 사용량" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "내 사용량" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(basis("설치 전체", "2026-10-18")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "30일" }));
    expect(basis("설치 전체", "2026-10-18")).toBeTruthy();
    expect(
      screen.getByRole("figure", { name: "일자별 추정 비용, 7일" }),
    ).toBeTruthy();
    release();
    await waitFor(() => basis("내 사용량", "2026-09-25"));
    expect(
      screen.getByRole("figure", { name: "일자별 추정 비용, 30일" }),
    ).toBeTruthy();
  });

  test("사용량 탭: series가 먼저 와도 표·기준 줄은 breakdown까지 와야 함께 바뀐다", async () => {
    setSystemTime(NOW);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
      "GET /v1/usage/breakdown": async (request: Request) => {
        const query = new URL(request.url).searchParams;
        if (query.get("scope") !== "me")
          return usageRoutes["GET /v1/usage/breakdown"](request);
        await held;
        return json(200, {
          rows: [{ key: "a9", label: "my-own-agent", ...figures(3, "9.00") }],
          totals: figures(3, "9.00"),
        });
      },
    });
    const agents = await screen.findByRole("table", { name: "에이전트별" });
    await within(agents).findByText("triage-bot");
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "내 사용량" }));
    // series for "me" answers at once; the breakdowns are held.
    await waitFor(() =>
      expect(
        screen.getByRole("figure", { name: "일자별 추정 비용, 30일" }),
      ).toBeTruthy(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText(/^설치 전체 · 2026-09-25/)).toBeTruthy();
    expect(
      within(screen.getByRole("table", { name: "에이전트별" })).getByText(
        "triage-bot",
      ),
    ).toBeTruthy();
    release();
    await within(
      await screen.findByRole("table", { name: "에이전트별" }),
    ).findByText("my-own-agent");
    expect(screen.getByText(/^내 사용량 · 2026-09-25/)).toBeTruthy();
  });

  test("사용량 탭: series가 먼저 실패해도 세 응답이 다 와야 오류가 나고, 다시 시도하는 동안 그 화면이 남는다", async () => {
    setSystemTime(NOW);
    const gate = () => {
      let open = () => {};
      const shut = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { shut, open };
    };
    const breakdowns = gate();
    const retry = gate();
    let sevenDayCalls = 0;
    const sevenDays = (request: Request) =>
      new URL(request.url).searchParams.get("since")?.startsWith("2026-10-18");
    renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
      "GET /v1/usage/series": async (request: Request) => {
        if (sevenDays(request)) {
          sevenDayCalls += 1;
          if (sevenDayCalls === 1)
            return json(500, { error: { code: "INTERNAL", message: "x" } });
          await retry.shut;
        }
        return usageRoutes["GET /v1/usage/series"](request);
      },
      "GET /v1/usage/breakdown": async (request: Request) => {
        if (sevenDays(request)) await breakdowns.shut;
        return usageRoutes["GET /v1/usage/breakdown"](request);
      },
    });
    const busy = () =>
      document.querySelector("[aria-busy]")?.getAttribute("aria-busy") ?? null;
    await screen.findByRole("figure", { name: "일자별 추정 비용, 30일" });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "7일" }));
    // The series failed at once; the breakdowns are still coming.
    await waitFor(() => expect(sevenDayCalls).toBe(1));
    await waitFor(() => expect(busy()).toBe("true"));
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(
      screen.getByRole("figure", { name: "일자별 추정 비용, 30일" }),
    ).toBeTruthy();
    expect(screen.getByText(/^설치 전체 · 2026-09-25/)).toBeTruthy();
    breakdowns.open();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    // The retry is held: the failure stays, busy, not a skeleton.
    await waitFor(() => expect(sevenDayCalls).toBe(2));
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(busy()).toBe("true");
    retry.open();
    expect(
      await screen.findByRole("figure", { name: "일자별 추정 비용, 7일" }),
    ).toBeTruthy();
    expect(screen.getByText(/^설치 전체 · 2026-10-18/)).toBeTruthy();
  });

  test("사용량 탭: 모델별을 다시 시도하는 동안 다른 수치와 오류 자리가 그대로다", async () => {
    setSystemTime(NOW);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let modelCalls = 0;
    renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
      "GET /v1/usage/breakdown": async (request: Request) => {
        if (new URL(request.url).searchParams.get("by") === "model") {
          modelCalls += 1;
          if (modelCalls === 1)
            return json(500, { error: { code: "INTERNAL", message: "x" } });
          await held;
        }
        return usageRoutes["GET /v1/usage/breakdown"](request);
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(modelCalls).toBe(2));
    expect(
      screen.getByRole("figure", { name: "일자별 추정 비용, 30일" }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("table", { name: "에이전트별" })).getByText(
        "triage-bot",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    release();
    const models = await screen.findByRole("table", { name: "모델별" });
    expect(within(models).getByText("claude-sonnet-4-5-20250929")).toBeTruthy();
  });

  test("사용량 탭: 오래된 캐시 기간으로 돌아오면 수치는 바로 보이고 다시 읽는 동안 aria-busy다", async () => {
    setSystemTime(NOW);
    let release = () => {};
    let held: Promise<void> | undefined;
    const { api } = renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
      // A refetched series comes back at once with its new read time.
      "GET /v1/usage/series": async (request: Request) => {
        const body = await usageRoutes["GET /v1/usage/series"](request).json();
        return json(200, { ...body, refreshed_at: new Date().toISOString() });
      },
      "GET /v1/usage/breakdown": async (request: Request) => {
        await held;
        return usageRoutes["GET /v1/usage/breakdown"](request);
      },
    });
    const busy = () =>
      document.querySelector("[aria-busy]")?.getAttribute("aria-busy") ?? null;
    await screen.findByRole("figure", { name: "일자별 추정 비용, 30일" });
    await waitFor(() => expect(busy()).toBeNull());
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "7일" }));
    await screen.findByRole("figure", { name: "일자별 추정 비용, 7일" });
    await waitFor(() => expect(busy()).toBeNull());
    // The 30-day answers are past their stale time; the breakdown refetches
    // are held.
    setSystemTime(new Date(NOW.getTime() + 61_000));
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = api.calls.length;
    await user.click(screen.getByRole("button", { name: "30일" }));
    expect(
      screen.getByRole("figure", { name: "일자별 추정 비용, 30일" }),
    ).toBeTruthy();
    await waitFor(() => expect(busy()).toBe("true"));
    expect(api.calls.length).toBeGreaterThan(before);
    // The new series is in, but it waits for the breakdowns.
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) =>
            call.path === "/v1/usage/series" &&
            call.search.includes("since=2026-09-25"),
        ),
      ).toHaveLength(2),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText(/오후 12:40에 읽은 값$/)).toBeTruthy();
    release();
    await waitFor(() => expect(busy()).toBeNull());
    expect(screen.getByText(/오후 12:41에 읽은 값$/)).toBeTruthy();
  });

  test("사용량 탭: 모델별만 실패하면 나머지는 그 기간으로 보이고 모델별 자리에 오류가 난다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
      "GET /v1/usage/breakdown": (request: Request) =>
        new URL(request.url).searchParams.get("by") === "model"
          ? json(500, { error: { code: "INTERNAL", message: "x" } })
          : usageRoutes["GET /v1/usage/breakdown"](request),
    });
    // First load: the series and the agents show although the models failed.
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("figure", { name: "일자별 추정 비용, 30일" }),
    ).toBeTruthy();
    expect(screen.getByText(/^설치 전체 · 2026-09-25/)).toBeTruthy();
    expect(
      within(screen.getByRole("table", { name: "에이전트별" })).getByText(
        "triage-bot",
      ),
    ).toBeTruthy();
    // A switch where the models fail again: the basis is the new period's,
    // the one the error card belongs to.
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "7일" }));
    await screen.findByRole("figure", { name: "일자별 추정 비용, 7일" });
    expect(screen.getByText(/^설치 전체 · 2026-10-18/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(
      api.calls.filter(
        (call) =>
          call.path === "/v1/usage/breakdown" &&
          call.search.includes("by=model") &&
          call.search.includes("since=2026-10-18"),
      ),
    ).toHaveLength(1);
  });

  test("한도 탭: owner는 한도 표를 본다", async () => {
    setSystemTime(NOW);
    renderAt("/operations/limits", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
    });
    const table = await screen.findByRole("table", { name: "한도" });
    expect(await within(table).findByText("설정 안 됨")).toBeTruthy();
    expect(within(table).getByText("7 / 10")).toBeTruthy();
  });

  const MEMBER_LIMITS = {
    scope: "me",
    refreshed_at: "2026-10-24T12:40:00.000Z",
    limits: {
      queued_input_limit_per_session: 20,
      max_turn_seconds: 3600,
      session_cost_limit_usd: "25.00",
      session_token_limit: null,
    },
  };

  for (const [role, who] of [
    ["admin", () => me(undefined, "admin")],
    ["member", memberMe],
  ] as const) {
    test(`한도 탭: ${role}는 /v1/limits?scope=me만 읽어 세션 한도 4개와 정적 행을 본다`, async () => {
      setSystemTime(NOW);
      const { api } = renderAt("/operations/limits", {
        "GET /v1/auth/me": () => json(200, who()),
        "GET /v1/limits?scope=me": () => json(200, MEMBER_LIMITS),
      });
      const table = await screen.findByRole("table", { name: "한도" });
      await within(table).findByText("$25.00");
      const rows = [...table.querySelectorAll("[role=row]")]
        .slice(1)
        .map((row) =>
          [...row.querySelectorAll("[role=cell]")]
            .slice(0, 3)
            .map((cell) => cell.textContent),
        );
      expect(rows).toEqual([
        ["구성원당 동시 실행 슬롯", "—제공 안 됨", "설정 안 됨"],
        ["구성원당 월 비용", "—제공 안 됨", "설정 안 됨"],
        ["구성원당 성과물 저장", "미계측", "한도 없음"],
        ["세션당 비용", "세션마다 셉니다", "$25.00"],
        ["세션당 토큰", "세션마다 셉니다", "설정 안 됨"],
        ["세션당 대기 입력", "세션마다 셉니다", "20건"],
        ["턴 최대 시간", "세션마다 셉니다", "1시간 0분"],
      ]);
      expect(screen.queryByText("실행 용량") === null).toBe(true);
      expect(
        api.calls
          .filter((call) => call.path === "/v1/limits")
          .map((call) => call.search),
      ).toEqual(["?scope=me"]);
    });
  }

  test("한도 탭: member의 한도 읽기가 실패하면 0이나 빈 표가 아니라 다시 시도할 수 있는 실패를 보인다", async () => {
    let calls = 0;
    renderAt("/operations/limits", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/limits?scope=me": () =>
        ++calls === 1
          ? json(500, { error: { code: "INTERNAL", message: "x" } })
          : json(200, MEMBER_LIMITS),
    });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.queryByRole("table", { name: "한도" }) === null).toBe(true);
    expect(screen.queryByText("설정 안 됨") === null).toBe(true);
    const user = await setupUser();
    await user.click(retry);
    const table = await screen.findByRole("table", { name: "한도" });
    expect(await within(table).findByText("$25.00")).toBeTruthy();
    expect(calls).toBe(2);
  });
});
