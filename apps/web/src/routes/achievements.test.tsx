import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { agentServer } from "../test-support/fake-agents.ts";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import { achievementPeriod } from "./achievements.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const NOW = new Date("2026-11-02T02:10:00.000Z");
const AGENT = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
const DEV = "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const DOCS = "9d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
const PR_TYPE = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
const DOC_TYPE = "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e";
const MERGED = "2f3e4d5c-6b7a-4980-8b1c-2d3e4f5a6b7c";
const DESIGN = "3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d";
const SESSION = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

const FIGURES = {
  scope: "installation",
  period: {
    since: "2026-10-04T00:00:00.000Z",
    until: "2026-11-03T00:00:00.000Z",
  },
  refreshed_at: NOW.toISOString(),
  session_count: 214,
  sessions_with_achievement_count: 58,
  cost_usd: "412.300000",
  cost_complete: true,
  achievement_count: 73,
  needs_review_count: 3,
  rejected_count: 2,
  judgment_count: 611,
  judge_calls: 1240,
  judge_cost_usd: "0.160000",
  cost_per_achievement_usd: "5.647945",
  by_category: [
    { id: DEV, name: "개발", achievement_count: 71, needs_review_count: 0 },
    { id: DOCS, name: "문서", achievement_count: 2, needs_review_count: 3 },
  ],
  by_type: [
    {
      id: PR_TYPE,
      key: "pull_request",
      name: "GitHub PR",
      achievement_count: 71,
      needs_review_count: 0,
    },
    {
      id: DOC_TYPE,
      key: "document",
      name: "문서",
      achievement_count: 2,
      needs_review_count: 3,
    },
  ],
  by_rule: [
    {
      id: MERGED,
      family_id: MERGED,
      version: 2,
      title: "머지된 PR",
      category_id: DEV,
      category_name: "개발",
      type_id: PR_TYPE,
      type_key: "pull_request",
      achievement_count: 71,
      needs_review_count: 0,
    },
    {
      id: DESIGN,
      family_id: DESIGN,
      version: 3,
      title: "설계 문서 작성",
      category_id: DOCS,
      category_name: "문서",
      type_id: DOC_TYPE,
      type_key: "document",
      achievement_count: 2,
      needs_review_count: 3,
    },
  ],
  by_agent: [
    {
      id: AGENT,
      name: "backend-fixer",
      session_count: 121,
      cost_usd: "288.100000",
      achievement_count: 52,
      cost_per_achievement_usd: "5.540385",
    },
    {
      id: null,
      name: null,
      session_count: 93,
      cost_usd: "124.200000",
      achievement_count: 0,
      cost_per_achievement_usd: null,
    },
  ],
  recent: [
    {
      id: "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e",
      created_at: "2026-11-02T02:05:00.000Z",
      session_id: SESSION,
      session_title: "결제 실패 시 주문이 두 번 생긴다",
      rule_id: DESIGN,
      rule_title: "설계 문서 작성",
      title: "out/payment-retry.md",
      link: `/sessions/${SESSION}`,
      evidence_kind: "out_file",
      judge: "luna",
      review_state: "needs_review",
    },
    {
      id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      created_at: "2026-11-02T02:03:00.000Z",
      session_id: SESSION,
      session_title: "결제 실패 시 주문이 두 번 생긴다",
      rule_id: MERGED,
      rule_title: "머지된 PR",
      title: "acme/shop#412",
      link: "https://github.com/acme/shop/pull/412",
      evidence_kind: "github_pull_request",
      judge: "always",
      review_state: "auto",
    },
    {
      id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
      created_at: "2026-11-01T05:00:00.000Z",
      session_id: null,
      session_title: null,
      rule_id: DESIGN,
      rule_title: "설계 문서 작성",
      title: null,
      link: null,
      evidence_kind: "out_file",
      judge: "luna",
      review_state: "rejected",
    },
  ],
};

function category(id: string, name: string, position: number) {
  return {
    id,
    name,
    position,
    created_by: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-10-01T00:00:00.000Z",
    archived_at: null,
    archived_by: null,
  };
}

function type(id: string, key: string, name: string, evidence: string) {
  return {
    id,
    key,
    name,
    evidence_kind: evidence,
    builtin: true,
    created_by: null,
    created_at: "2026-10-01T00:00:00.000Z",
    archived_at: null,
    archived_by: null,
  };
}

const routes = {
  "GET /v1/usage/achievements": () => json(200, FIGURES),
  "GET /v1/agents": () =>
    json(200, {
      items: [
        { ...agentServer().detail().agent, id: AGENT, name: "backend-fixer" },
      ],
      next_cursor: null,
    }),
  "GET /v1/achievement-types": () =>
    json(200, {
      items: [
        type(PR_TYPE, "pull_request", "GitHub PR", "github_pull_request"),
        type(DOC_TYPE, "document", "문서", "out_file"),
      ],
    }),
  "GET /v1/achievement-categories": () =>
    json(200, {
      items: [category(DEV, "개발", 0), category(DOCS, "문서", 1)],
    }),
};

// The section and the table frame inside it share the name.
const rowsOf = (name: string) =>
  within(screen.getAllByRole("region", { name }).at(-1) as HTMLElement)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );

describe("성과", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("owner: 사이드바 '성과'에서 열고, 설치 전체의 지난 30일 숫자 4개와 표 셋을 보인다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/achievements", {
      "GET /v1/auth/me": () => json(200, me()),
      ...routes,
    });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    expect(
      within(nav)
        .getByRole("link", { name: "성과" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("heading", { level: 1, name: "성과" }).textContent,
    ).toBe("성과");
    expect(
      await screen.findByText("확인 대기 3 · 거절 2", undefined),
    ).toBeTruthy();
    const text = document.body.textContent ?? "";
    for (const value of [
      "집계된 성과73",
      "세션 비용$412.30세션 214개 · 성과 있는 세션 58",
      "판정 비용$0.16판정 611회 · Luna 호출 1,240회",
      "성과당 비용$5.65판정 비용 포함해도 $5.65",
    ]) {
      expect(text).toContain(value);
    }
    expect(rowsOf("규칙별")).toEqual([
      ["개발", "머지된 PR v2", "pull_request", "71", "0"],
      ["문서", "설계 문서 작성 v3", "document", "2", "3"],
    ]);
    expect(rowsOf("에이전트별")).toEqual([
      ["backend-fixer", "121", "52", "$288.10", "$5.54"],
      ["에이전트 없음", "93", "0", "$124.20", "—"],
    ]);
    expect(rowsOf("최근 성과")).toEqual([
      [
        "5분 전",
        "결제 실패 시 주문이 두 번 생긴다",
        "설계 문서 작성",
        "out/payment-retry.md",
        "Luna",
        "확인 필요",
      ],
      [
        "7분 전",
        "결제 실패 시 주문이 두 번 생긴다",
        "머지된 PR",
        "acme/shop#412",
        "바로 인정",
        "집계됨",
      ],
      [
        "어제 14:00",
        "볼 수 없는 세션",
        "설계 문서 작성",
        "볼 수 없는 세션",
        "Luna",
        "거절됨",
      ],
    ]);
    // Number columns end, header and cells alike, in tabular figures; every
    // other header and cell starts. Short columns are as narrow as their
    // content; the text columns take what they leave and wrap between words.
    for (const [name, variants] of [
      ["규칙별", ["nowrap", "default", "nowrap", "numeric", "numeric"]],
      ["에이전트별", ["default", "numeric", "numeric", "numeric", "numeric"]],
      [
        "최근 성과",
        ["nowrap", "default", "default", "default", "nowrap", "nowrap"],
      ],
    ] as const) {
      const table = screen
        .getAllByRole("region", { name })
        .at(-1) as HTMLElement;
      const head = within(table).getAllByRole("columnheader");
      expect(head.map((cell) => cell.getAttribute("data-variant"))).toEqual([
        ...variants,
      ]);
      for (const row of within(table).getAllByRole("row").slice(1))
        expect(
          within(row)
            .getAllByRole("cell")
            .map((cell) => cell.getAttribute("data-variant")),
        ).toEqual([...variants]);
      for (const cell of [...head, ...within(table).getAllByRole("cell")]) {
        const classes = cell.className.split(/\s+/);
        if (cell.getAttribute("data-variant") === "numeric") {
          expect(classes.includes("text-right")).toBe(true);
          expect(classes.includes("tabular-nums")).toBe(true);
          expect(classes.includes("text-left")).toBe(false);
        } else {
          expect(
            classes.filter((c) => /text-(right|end)|justify-end/.test(c)),
          ).toEqual([]);
          expect(classes.includes("text-left")).toBe(true);
        }
      }
    }
    expect(
      screen.getByRole("link", { name: /acme\/shop#412/ }).getAttribute("href"),
    ).toBe("https://github.com/acme/shop/pull/412");
    expect(screen.getByText("out/payment-retry.md").closest("a") === null).toBe(
      true,
    );
    expect(
      screen
        .getAllByRole("link", { name: "결제 실패 시 주문이 두 번 생긴다" })[0]
        ?.getAttribute("href"),
    ).toBe(`/sessions/${SESSION}?tab=outputs`);
    expect(
      screen.getByText(
        "확인 필요 성과는 오너·어드민과 그 에이전트의 관리자가 확인합니다.",
      ),
    ).toBeTruthy();
    const asked = api.calls.find(
      (call) => call.path === "/v1/usage/achievements",
    );
    expect(asked?.search).toBe(
      "?scope=installation&since=2026-10-04T00%3A00%3A00.000Z&until=2026-11-03T00%3A00%3A00.000Z",
    );
  });

  test("필터는 기간·에이전트·type·구분을 그대로 묻는다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/achievements", {
      "GET /v1/auth/me": () => json(200, me()),
      ...routes,
    });
    const user = await setupUser();
    await screen.findByText("확인 대기 3 · 거절 2");
    const select = (name: string) => screen.getByRole("combobox", { name });
    await waitFor(() =>
      expect(
        [...select("성과 type").querySelectorAll("option")].map(
          (option) => option.textContent,
        ),
      ).toEqual(["모든 type", "pull_request", "document"]),
    );
    expect(
      [...select("기간").querySelectorAll("option")].map(
        (option) => option.textContent,
      ),
    ).toEqual(["지난 30일", "지난 7일", "이번 달"]);
    await waitFor(() =>
      expect(
        [...select("에이전트").querySelectorAll("option")].map(
          (option) => option.textContent,
        ),
      ).toEqual(["모든 에이전트", "backend-fixer"]),
    );
    expect(
      [...select("구분").querySelectorAll("option")].map(
        (option) => option.textContent,
      ),
    ).toEqual(["모든 구분", "개발", "문서"]);
    await user.selectOptions(select("기간"), "month");
    await user.selectOptions(select("에이전트"), AGENT);
    await user.selectOptions(select("성과 type"), DOC_TYPE);
    await user.selectOptions(select("구분"), DOCS);
    await waitFor(() =>
      expect(
        api.calls
          .filter((call) => call.path === "/v1/usage/achievements")
          .at(-1)?.search,
      ).toBe(
        `?scope=installation&since=2026-11-01T00%3A00%3A00.000Z&until=2026-11-03T00%3A00%3A00.000Z&agent_id=${AGENT}&type_id=${DOC_TYPE}&category_id=${DOCS}`,
      ),
    );
  });

  test("member: 자기 세션(scope=me)의 성과를 본다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/achievements", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...routes,
      "GET /v1/usage/achievements": () =>
        json(200, { ...FIGURES, scope: "me" }),
    });
    await screen.findByText("확인 대기 3 · 거절 2");
    expect(
      api.calls.find((call) => call.path === "/v1/usage/achievements")?.search,
    ).toStartWith("?scope=me&");
  });

  test("비용이 덜 모였으면 세션 비용과 성과당 비용 카드에 사용량 화면의 안내를 붙인다", async () => {
    setSystemTime(NOW);
    renderAt("/achievements", {
      "GET /v1/auth/me": () => json(200, me()),
      ...routes,
      "GET /v1/usage/achievements": () =>
        json(200, { ...FIGURES, cost_complete: false }),
    });
    await screen.findByText("확인 대기 3 · 거절 2");
    const notes = screen.getAllByText(
      "진행 중이거나 비용을 보고하지 않은 턴이 있어 실제보다 적을 수 있음",
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]?.parentElement?.textContent).toStartWith("세션 214개");
    expect(notes[1]?.parentElement?.textContent).toStartWith(
      "판정 비용 포함해도",
    );
  });
});

test("이번 달은 UTC 1일부터, 지난 N일은 다음 UTC 자정까지 N일이다", () => {
  const now = new Date("2026-11-02T23:59:00.000Z");
  expect(achievementPeriod("month", now)).toEqual({
    since: "2026-11-01T00:00:00.000Z",
    until: "2026-11-03T00:00:00.000Z",
  });
  expect(achievementPeriod("7", now)).toEqual({
    since: "2026-10-27T00:00:00.000Z",
    until: "2026-11-03T00:00:00.000Z",
  });
});
