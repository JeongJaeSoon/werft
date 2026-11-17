import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  json,
  me,
  memberMe,
  memberPage,
  RECEIPT_ID,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness, type Routes } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
// After the harness: Radix decides at import whether a DOM exists.
const { subjectParticle } = await import("./achievement-rules.tsx");

const NOW = new Date("2026-11-02T02:10:00.000Z");
const PATH = "/settings/workspace/achievement-rules";
const JUDGE = `/v1/workspaces/${WORKSPACE_ID}/achievement-judge`;
const AT = "2026-10-28T03:00:00.000Z";

const DEV = "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const REVIEW = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DOCS = "9d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
const PR_TYPE = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
const REVIEW_TYPE = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";
const DOC_TYPE = "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e";
const BUG_TYPE = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const TALK_TYPE = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";
const MERGED = "2f3e4d5c-6b7a-4980-8b1c-2d3e4f5a6b7c";
const BUGFIX = "0c1d2e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f";
const REVIEWED = "1d2e3f4a-5b6c-4d7e-8f9a-9b0c1d2e3f4a";
const DESIGN = "3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d";

function category(id: string, name: string, position: number) {
  return {
    id,
    name,
    position,
    created_by: USER_ID,
    created_at: AT,
    archived_at: null,
    archived_by: null,
  };
}

function type(
  id: string,
  key: string,
  name: string,
  evidence: string,
  builtin = true,
) {
  return {
    id,
    key,
    name,
    evidence_kind: evidence,
    builtin,
    created_by: builtin ? null : USER_ID,
    created_at: AT,
    archived_at: null,
    archived_by: null,
  };
}

function rule(
  family: string,
  categoryId: string,
  title: string,
  typeId: string,
  judge: "always" | "luna",
  version: number,
  disabled = false,
) {
  return {
    id: family,
    family_id: family,
    version,
    category_id: categoryId,
    title,
    type_id: typeId,
    definition: "사용자가 보고한 오류나 잘못된 동작을 고친 PR.",
    judge,
    agent_ids: null,
    created_by: USER_ID,
    created_at: AT,
    superseded_by: null,
    disabled_at: disabled ? AT : null,
    disabled_by: disabled ? USER_ID : null,
  };
}

const CATEGORIES = [
  category(DEV, "개발", 0),
  category(REVIEW, "리뷰", 1),
  category(DOCS, "문서", 2),
];
const TYPES = [
  type(PR_TYPE, "pull_request", "GitHub PR", "github_pull_request"),
  type(REVIEW_TYPE, "code_review", "코드 리뷰", "github_review"),
  type(DOC_TYPE, "document", "문서", "out_file"),
  type(BUG_TYPE, "bugfix_pr", "버그 수정 PR", "github_pull_request", false),
  type(TALK_TYPE, "solved_talk", "대화로 해결", "conversation", false),
];
const RULES = [
  rule(MERGED, DEV, "머지된 PR", PR_TYPE, "luna", 2),
  rule(BUGFIX, DEV, "버그 수정 PR", BUG_TYPE, "luna", 1),
  rule(REVIEWED, REVIEW, "코드 리뷰 제출", REVIEW_TYPE, "always", 1),
  rule(DESIGN, DOCS, "설계 문서 작성", DOC_TYPE, "luna", 3, true),
];

const SETTINGS = {
  connection_id: null,
  threshold: 0.9,
  on_evidence: true,
  every_n_turns: null,
  on_idle: false,
  transcript: "recent",
  daily_budget_usd: 1,
  max_per_session: 20,
};

function byRule(family: string, achievements: number, waiting: number) {
  const found = RULES.find((r) => r.family_id === family);
  if (!found) throw new Error(family);
  return {
    id: found.id,
    family_id: family,
    version: found.version,
    title: found.title,
    category_id: found.category_id,
    category_name: "",
    type_id: found.type_id,
    type_key: "",
    achievement_count: achievements,
    needs_review_count: waiting,
  };
}

// One recording per period the screen asks for, told apart by `since`.
function usage(request: Request) {
  const since = new URL(request.url).searchParams.get("since") ?? "";
  const cost = since.startsWith("2026-11-02")
    ? "0.010000"
    : since.startsWith("2026-11-01")
      ? "0.160000"
      : "0.420000";
  return json(200, {
    scope: "installation",
    period: { since, until: "2026-11-03T00:00:00.000Z" },
    refreshed_at: NOW.toISOString(),
    session_count: 0,
    sessions_with_achievement_count: 0,
    cost_usd: "0.000000",
    cost_complete: true,
    achievement_count: 0,
    needs_review_count: 0,
    rejected_count: 0,
    judgment_count: 3,
    judge_calls: 4,
    judge_cost_usd: cost,
    cost_per_achievement_usd: null,
    by_category: [],
    by_type: [],
    by_rule: [
      byRule(MERGED, 41, 0),
      byRule(BUGFIX, 12, 0),
      byRule(DESIGN, 2, 3),
    ],
    by_agent: [],
    recent: [],
  });
}

const OWNER = {
  name: "김지민",
  member: {
    user_id: USER_ID,
    email: "owner@example.com",
    display_name: "김지민",
    role: "owner" as const,
    disabled_at: null,
    created_at: AT,
  },
};

function routes(overrides: Routes = {}) {
  return {
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/achievement-categories": () => json(200, { items: CATEGORIES }),
    "GET /v1/achievement-types": () => json(200, { items: TYPES }),
    "GET /v1/achievement-rules": () => json(200, { items: RULES }),
    [`GET ${JUDGE}`]: () =>
      json(200, { achievement_judge: SETTINGS, connections: ["luna-a"] }),
    "GET /v1/usage/achievements": usage,
    "GET /v1/members": () =>
      json(200, memberPage({ items: [OWNER.member], next_cursor: null })),
    ...overrides,
  };
}

const writes = <C extends { readonly method: string }>(calls: readonly C[]) =>
  calls.filter((call) => call.method !== "GET");

const SETTINGS_CONNECTIONS = "/v1/installation/settings/connections";

function decisionConnection(id: string, rest: Record<string, unknown> = {}) {
  return {
    id,
    origin: "console",
    state: "active",
    kind: "openai_decisions",
    endpoint: "https://api.openai.com",
    billing: "per_token",
    auth_kind: "api_key",
    credential: { source: "stored", last4: "abcd" },
    models: [],
    model_families: null,
    created_at: AT,
    disabled_at: null,
    ...rest,
  };
}

/** A withheld button's reason, which its tooltip describes it by. */
const reasonOf = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-describedby") ?? "")
    ?.textContent;

const section = (name: string) =>
  screen
    .getByRole("heading", { level: 2, name })
    .closest("section") as HTMLElement | null;

async function opened(overrides?: Parameters<typeof routes>[0], who = me()) {
  setSystemTime(NOW);
  const rendered = renderAt(
    PATH,
    routes({
      "GET /v1/auth/me": () => json(200, who),
      ...overrides,
    }),
  );
  await screen.findByRole("heading", { level: 2, name: "규칙" });
  await screen.findByRole("heading", { level: 2, name: "판정 설정" });
  return rendered;
}

// A rules list whose GET reflects the writes, as the server would.
function liveRules() {
  let items = RULES.map((r) => ({ ...r }));
  const replace = (family: string, next: (typeof items)[number]) => {
    items = items.map((r) => (r.family_id === family ? next : r));
  };
  const current = (family: string) => {
    const found = items.find((r) => r.family_id === family);
    if (!found) throw new Error(family);
    return found;
  };
  const toggled = (family: string, on: boolean) => () => {
    const next = {
      ...current(family),
      disabled_at: on ? null : AT,
      disabled_by: on ? null : USER_ID,
    };
    replace(family, next);
    return json(200, { rule: next, receipt_id: RECEIPT_ID });
  };
  return {
    "GET /v1/achievement-rules": () => json(200, { items }),
    "POST /v1/achievement-rules": async (request: Request) => {
      const body = (await request.json()) as {
        category_id: string;
        title: string;
        type_id: string;
        definition: string;
        judge: "always" | "luna";
      };
      const created = {
        ...rule(
          "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
          body.category_id,
          body.title,
          body.type_id,
          body.judge,
          1,
        ),
        definition: body.definition,
      };
      const after = items
        .map((r) => r.category_id)
        .lastIndexOf(body.category_id);
      items = [
        ...items.slice(0, after + 1),
        created,
        ...items.slice(after + 1),
      ];
      return json(201, { rule: created, receipt_id: RECEIPT_ID });
    },
    [`POST /v1/achievement-rules/${BUGFIX}/versions`]: async (
      request: Request,
    ) => {
      const body = (await request.json()) as Record<string, unknown>;
      const previous = current(BUGFIX);
      const next = {
        ...previous,
        ...body,
        id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
        version: previous.version + 1,
      };
      replace(BUGFIX, next);
      return json(201, { rule: next, receipt_id: RECEIPT_ID });
    },
    [`POST /v1/achievement-rules/${MERGED}/disable`]: toggled(MERGED, false),
    [`POST /v1/achievement-rules/${MERGED}/enable`]: toggled(MERGED, true),
  };
}

const ruleRows = () =>
  within(within(section("규칙") as HTMLElement).getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .slice(0, 4)
        .map((cell) => cell.textContent),
    );

describe("성과 규칙", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("설정 메뉴의 '성과 규칙'에 있고, 성과 화면 머리에서도 연다", async () => {
    setSystemTime(NOW);
    renderAt("/achievements", routes());
    const link = await screen.findByRole("link", { name: "성과 규칙" });
    expect(link.getAttribute("href")).toBe(PATH);
    const user = await setupUser();
    await user.click(link);
    await screen.findByRole("heading", { level: 1, name: "성과 규칙" });
    const nav = screen.getByRole("navigation", { name: "워크스페이스 설정" });
    expect(
      within(nav)
        .getByRole("link", { name: "성과 규칙" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  test("판정 설정: 켜진 판정 모델을 고를 수 있고, 오늘·이번 달 판정 비용을 보인다", async () => {
    await opened();
    const select = screen.getByRole("combobox", { name: "Luna 연결" });
    expect(select.textContent).toBe(
      "연결 없음 · Luna 규칙은 판정하지 않습니다luna-a",
    );
    const card = section("판정 설정");
    await waitFor(() =>
      expect(card?.textContent).toContain(
        "오늘 판정 비용 $0.01 / $1.00 · 이번 달 $0.16 · 판정 1회 예상 약 $0.00025 (근거 요약만)",
      ),
    );
  });

  test("판정 비용과 지난 30일 수는 설치 전체(scope=installation)로만 묻는다", async () => {
    const { api } = await opened();
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path === "/v1/usage/achievements"),
      ).toHaveLength(3),
    );
    for (const call of api.calls.filter(
      (call) => call.path === "/v1/usage/achievements",
    )) {
      expect(call.search).toStartWith("?scope=installation&");
    }
  });

  for (const [who, setup] of [
    [
      "설치 전체를 읽지 못하는 admin",
      () => ({ who: me(undefined, "admin"), overrides: {} }),
    ],
    [
      "403을 받은 owner",
      () => ({
        who: me(),
        overrides: {
          "GET /v1/usage/achievements": () =>
            json(403, {
              error: {
                code: "FORBIDDEN",
                message: "no",
                retryable: false,
                request_id: "req-1",
                details: null,
              },
            }),
        },
      }),
    ],
  ] as const) {
    test(`${who}에게는 판정 비용 줄과 지난 30일 칸을 숨긴다`, async () => {
      const { who: principal, overrides } = setup();
      const { api } = await opened(overrides, principal);
      const table = within(section("규칙") as HTMLElement).getByRole("table");
      await waitFor(() =>
        expect(
          within(table).getAllByRole("row")[2]?.querySelectorAll("td").length,
        ).toBe(5),
      );
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((cell) => cell.textContent),
      ).toEqual(["제목", "성과 type", "판정", "버전", "사용"]);
      expect(section("판정 설정")?.textContent).not.toContain("오늘 판정 비용");
      expect(
        api.calls.some(
          (call) =>
            call.path === "/v1/usage/achievements" &&
            !call.search.startsWith("?scope=installation&"),
        ),
      ).toBe(false);
    });
  }

  test("판정 설정: 서버가 준 openai_decisions 연결을 고르고, 사용 중지된 저장 연결은 쓸 수 없다고 보인다", async () => {
    await opened({
      [`GET ${JUDGE}`]: () =>
        json(200, {
          achievement_judge: { ...SETTINGS, connection_id: "luna-old" },
          connections: ["luna-a", "luna-b"],
        }),
    });
    const select = (await screen.findByRole("combobox", {
      name: "Luna 연결",
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("luna-old"));
    expect(
      [...select.options].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ["", "연결 없음 · Luna 규칙은 판정하지 않습니다"],
      ["luna-a", "luna-a"],
      ["luna-b", "luna-b"],
      ["luna-old", "luna-old · 쓸 수 없음"],
    ]);
  });

  test("판정 설정: 연결을 고르고 저장하면 그 connection_id를 PUT 한다", async () => {
    let sent: Record<string, unknown> | null = null;
    await opened({
      [`GET ${JUDGE}`]: () =>
        json(200, { achievement_judge: SETTINGS, connections: ["luna-a"] }),
      [`PUT ${JUDGE}`]: async (request) => {
        sent = (await request.json()) as Record<string, unknown>;
        return json(200, {
          achievement_judge: { ...SETTINGS, ...sent },
          receipt_id: RECEIPT_ID,
        });
      },
    });
    const user = await setupUser();
    const card = section("판정 설정") as HTMLElement;
    await user.selectOptions(
      within(card).getByRole("combobox", { name: "Luna 연결" }),
      "luna-a",
    );
    await user.click(within(card).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(sent).not.toBe(null));
    expect(sent).toMatchObject({ connection_id: "luna-a" });
    // The list survives the save's answer, which carries none.
    expect(
      (
        within(card).getByRole("combobox", {
          name: "Luna 연결",
        }) as HTMLSelectElement
      ).value,
    ).toBe("luna-a");
  });

  test("판정 설정: 행은 폼의 gap-4를 받지 않는 한 블록 안에 있다", async () => {
    await opened();
    const card = section("판정 설정") as HTMLElement;
    const form = card.querySelector("form") as HTMLFormElement;
    const rows = [...form.querySelectorAll("fieldset.border-b")].filter((row) =>
      row.className.includes("py-3.5"),
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      // A row that is a direct child of the form gets 16px added to its rule.
      expect(row.parentElement === form).toBe(false);
    }
    expect(new Set(rows.map((row) => row.parentElement)).size).toBe(1);
  });

  test("판정 설정을 저장하면 바꾼 값과 연결·문턱을 그대로 PUT 한다", async () => {
    const saved = { ...SETTINGS };
    const { api } = await opened({
      [`PUT ${JUDGE}`]: async (request) => {
        Object.assign(saved, await request.json());
        return json(200, { achievement_judge: saved, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    const card = section("판정 설정") as HTMLElement;
    await user.click(within(card).getByRole("checkbox", { name: "턴마다" }));
    const turns = within(card).getByRole("spinbutton", { name: "턴 수" });
    await user.clear(turns);
    await user.type(turns, "15");
    await user.click(
      within(card).getByRole("checkbox", {
        name: "세션이 멈출 때 (대기·일시정지·종료)",
      }),
    );
    await user.click(within(card).getByRole("radio", { name: "보내지 않음" }));
    const budget = within(card).getByRole("spinbutton", { name: "하루 예산" });
    await user.clear(budget);
    await user.type(budget, "2.5");
    const perSession = within(card).getByRole("spinbutton", {
      name: "세션당 최대",
    });
    await user.clear(perSession);
    await user.type(perSession, "30");
    await user.click(within(card).getByRole("button", { name: "저장" }));
    await screen.findByText("판정 설정을 저장했습니다.");
    expect(writes(api.calls).map((call) => [call.method, call.path])).toEqual([
      ["PUT", JUDGE],
    ]);
    expect(writes(api.calls)[0]?.body).toEqual({
      connection_id: null,
      threshold: 0.9,
      on_evidence: true,
      every_n_turns: 15,
      on_idle: true,
      transcript: "none",
      daily_budget_usd: 2.5,
      max_per_session: 30,
    });
  });

  test("구분: 규칙 수와 함께 보이고, 추가·이름 바꾸기를 보낸다", async () => {
    const { api } = await opened({
      "POST /v1/achievement-categories": () =>
        json(201, {
          category: category("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", "운영", 3),
          receipt_id: RECEIPT_ID,
        }),
      [`PATCH /v1/achievement-categories/${REVIEW}`]: () =>
        json(200, {
          category: category(REVIEW, "코드 리뷰", 1),
          receipt_id: RECEIPT_ID,
        }),
    });
    const card = section("구분") as HTMLElement;
    expect(
      within(card)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "개발규칙 2이름 바꾸기",
      "리뷰규칙 1이름 바꾸기",
      "문서규칙 1이름 바꾸기",
    ]);
    const user = await setupUser();
    await user.click(within(card).getByRole("button", { name: "구분 추가" }));
    let dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: "이름" }),
      "운영",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );

    await user.click(
      within(card).getByRole("button", { name: "리뷰 이름 바꾸기" }),
    );
    dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "이름" });
    await user.clear(name);
    await user.type(name, "코드 리뷰");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(
      writes(api.calls).map((call) => [call.method, call.path, call.body]),
    ).toEqual([
      ["POST", "/v1/achievement-categories", { name: "운영" }],
      ["PATCH", `/v1/achievement-categories/${REVIEW}`, { name: "코드 리뷰" }],
    ]);
  });

  test("구분 보관: 사용 중인 규칙이 남으면 막고, 서버의 거절도 그 문장으로 보인다", async () => {
    const { api } = await opened({
      [`POST /v1/achievement-categories/${DOCS}/archive`]: () =>
        json(409, {
          error: {
            code: "REVISION_CONFLICT",
            message: "category in use",
            retryable: false,
            request_id: "req-1",
            details: { reason_code: "category_in_use" },
          },
        }),
    });
    const card = section("구분") as HTMLElement;
    const user = await setupUser();
    await user.click(
      within(card).getByRole("button", { name: "개발 이름 바꾸기" }),
    );
    let dialog = await screen.findByRole("dialog");
    const withheld = within(dialog).getByRole("button", { name: "보관" });
    expect(withheld.getAttribute("aria-disabled")).toBe("true");
    await user.click(withheld);
    expect(writes(api.calls)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );

    // Its one rule is disabled, so the screen lets it try; the server says no.
    await user.click(
      within(card).getByRole("button", { name: "문서 이름 바꾸기" }),
    );
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "보관" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "규칙이 남은 구분은 보관할 수 없습니다.",
    );
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `/v1/achievement-categories/${DOCS}/archive`,
    ]);
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
  });

  test("구분 보관: 보관하면 사라진 버튼 대신 구분 추가로 초점이 간다", async () => {
    let archived = false;
    await opened({
      "GET /v1/achievement-categories": () =>
        json(200, {
          items: archived
            ? CATEGORIES.filter((item) => item.id !== DOCS)
            : CATEGORIES,
        }),
      [`POST /v1/achievement-categories/${DOCS}/archive`]: () => {
        archived = true;
        return json(200, {
          category: {
            ...category(DOCS, "문서", 2),
            archived_at: AT,
            archived_by: USER_ID,
          },
          receipt_id: RECEIPT_ID,
        });
      },
    });
    const card = section("구분") as HTMLElement;
    const user = await setupUser();
    await user.click(
      within(card).getByRole("button", { name: "문서 이름 바꾸기" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "보관" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(card).queryByRole("button", { name: "문서 이름 바꾸기" }) ===
          null,
      ).toBe(true),
    );
    const add = within(card).getByRole("button", { name: "구분 추가" });
    await waitFor(() => expect(document.activeElement === add).toBe(true));
  });

  test("성과 type 표: 이름·key·근거 종류·저장되는 칸·쓰는 규칙, 내장 표시, 추가·이름 바꾸기", async () => {
    const created = type(
      "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      "hotfix_pr",
      "긴급 수정 PR",
      "github_pull_request",
      false,
    );
    const { api } = await opened({
      "POST /v1/achievement-types": () =>
        json(201, { type: created, receipt_id: RECEIPT_ID }),
      [`PATCH /v1/achievement-types/${BUG_TYPE}`]: () =>
        json(200, {
          type: { ...TYPES[3], name: "버그 수정" },
          receipt_id: RECEIPT_ID,
        }),
    });
    const table = within(section("성과 type") as HTMLElement).getByRole(
      "table",
    );
    const rows = within(table).getAllByRole("row");
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "이름",
      "key",
      "근거 종류",
      "저장되는 칸",
      "쓰는 규칙",
      "이름 바꾸기",
    ]);
    expect(
      rows.slice(1).map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      [
        "GitHub PR 내장",
        "pull_request",
        "PR",
        "공통 + 저장소·번호·상태·머지 시각·변경 줄 수",
        "머지된 PR",
        "",
      ],
      [
        "코드 리뷰 내장",
        "code_review",
        "리뷰",
        "공통 + 저장소·번호·event·commit",
        "코드 리뷰 제출",
        "",
      ],
      [
        "문서 내장",
        "document",
        "out/ 파일",
        "공통 + 경로·크기",
        "설계 문서 작성",
        "",
      ],
      [
        "버그 수정 PR ",
        "bugfix_pr",
        "PR",
        "공통 (제목·링크·근거)",
        "버그 수정 PR",
        "이름 바꾸기",
      ],
      [
        "대화로 해결 ",
        "solved_talk",
        "대화",
        "공통 (제목·링크·근거)",
        "",
        "이름 바꾸기",
      ],
    ]);

    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "type 추가" }));
    let dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: "이름" }),
      "긴급 수정 PR",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "key" }),
      "hotfix_pr",
    );
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "근거 종류" }),
      "github_pull_request",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );

    await user.click(
      screen.getByRole("button", { name: "버그 수정 PR 이름 바꾸기" }),
    );
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).queryByRole("textbox", { name: "key" }) === null,
    ).toBe(true);
    const name = within(dialog).getByRole("textbox", { name: "이름" });
    await user.clear(name);
    await user.type(name, "버그 수정");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    expect(
      writes(api.calls).map((call) => [call.method, call.path, call.body]),
    ).toEqual([
      [
        "POST",
        "/v1/achievement-types",
        {
          key: "hotfix_pr",
          name: "긴급 수정 PR",
          evidence_kind: "github_pull_request",
        },
      ],
      ["PATCH", `/v1/achievement-types/${BUG_TYPE}`, { name: "버그 수정" }],
    ]);
  });

  test("규칙 표는 구분별로 묶이고, 지난 30일 수와 판정·사람 확인 표시를 보인다", async () => {
    await opened();
    const table = within(section("규칙") as HTMLElement).getByRole("table");
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) =>
            within(row)
              .getAllByRole("cell")
              .map((cell) => cell.textContent),
          ),
      ).toEqual([
        ["개발"],
        ["머지된 PR", "pull_request", "Luna 판정 ", "v2", "41", ""],
        ["버그 수정 PR", "bugfix_pr", "Luna 판정 ", "v1", "12", ""],
        ["리뷰"],
        ["코드 리뷰 제출", "code_review", "바로 인정 ", "v1", "0", ""],
        ["문서"],
        [
          "설계 문서 작성",
          "document",
          "Luna 판정 사람 확인",
          "v3",
          "2 +3 확인 대기",
          "",
        ],
      ]),
    );
    // The 30-day count ends, header and cells, in tabular figures, and so
    // does the 사용 switch under its header; every other column starts, and
    // so does every value in the stacked phone layout. 제목 takes the
    // leftover width and the rest are as narrow as their content.
    const head = within(table).getAllByRole("columnheader");
    const firstRow = within(table).getAllByRole("row")[2] as HTMLElement;
    const cells = within(firstRow).getAllByRole("cell");
    for (const [index, cell] of [...head, ...cells].entries()) {
      const classes = cell.className.split(/\s+/);
      const column = index % head.length;
      if (column === 4 || column === 5) {
        expect(classes.includes("text-right")).toBe(true);
        expect(classes.includes("tabular-nums")).toBe(column === 4);
        expect(classes.includes("text-left")).toBe(false);
      } else {
        expect(
          classes.filter((name) => /text-right|justify-end/.test(name)),
        ).toEqual([]);
        expect(classes.includes("text-left")).toBe(true);
      }
    }
    for (const cell of [cells[4], cells[5]]) {
      expect(cell?.className.split(/\s+/).includes("max-md:text-left")).toBe(
        true,
      );
    }
    expect(
      cells[5]?.className
        .split(/\s+/)
        .includes("max-md:[&>[data-slot=switch]]:ml-0"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "머지된 PR" })
        .className.split(/\s+/)
        .filter((name) => name.includes("text-right")),
    ).toEqual([]);
    expect(head.map((cell) => cell.getAttribute("data-variant"))).toEqual([
      "text",
      "nowrap",
      "nowrap",
      "nowrap",
      "numeric",
      "switch",
    ]);
    const used = screen.getByRole("switch", { name: "머지된 PR 사용" });
    expect(used.className.split(/\s+/).includes("flex")).toBe(true);
    expect(used.className.split(/\s+/).includes("inline-flex")).toBe(false);
    expect(
      screen
        .getByRole("switch", { name: "설계 문서 작성 사용" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "머지된 PR 사용" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  // jsdom has no layout; the 390px demo measurement is the real check.
  test("긴 규칙 제목은 칸 안에서 줄을 바꾼다", async () => {
    await opened();
    const title = await screen.findByRole("button", { name: "버그 수정 PR" });
    const classes = title.className.split(/\s+/);
    expect(classes.includes("whitespace-nowrap")).toBe(false);
    expect(classes.includes("shrink-0")).toBe(false);
    expect(classes.includes("whitespace-normal")).toBe(true);
    expect(classes.includes("min-w-0")).toBe(true);
    // A title without spaces may break anywhere in the types table too.
    const table = within(section("성과 type") as HTMLElement).getByRole(
      "table",
    );
    const used = within(table)
      .getAllByRole("cell")
      .find((cell) => cell.getAttribute("data-k") === "규칙");
    expect(
      used?.className.split(/\s+/).includes("[overflow-wrap:anywhere]"),
    ).toBe(true);
  });

  test("규칙 편집: 다른 사용 중 규칙이 쓰지 않는 type만 고르고, 저장하면 새 버전을 보낸다", async () => {
    const { api } = await opened({
      [`POST /v1/achievement-rules/${BUGFIX}/versions`]: async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        return json(201, {
          rule: { ...RULES[1], ...body, id: crypto.randomUUID(), version: 2 },
          receipt_id: RECEIPT_ID,
        });
      },
    });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "버그 수정 PR" }));
    const editor = (
      await screen.findByRole("heading", {
        level: 2,
        name: "규칙 편집 — 버그 수정 PR",
      })
    ).closest("section") as HTMLElement;
    await waitFor(() =>
      expect(editor.textContent).toContain("v1 · 2026-10-28 김지민이 만듦"),
    );
    const typeSelect = within(editor).getByRole("combobox", {
      name: "성과 type",
    }) as HTMLSelectElement;
    expect([...typeSelect.options].map((option) => option.textContent)).toEqual(
      [
        "document — 문서 (근거: out/ 파일)",
        "bugfix_pr — 버그 수정 PR (근거: PR)",
        "solved_talk — 대화로 해결 (근거: 대화)",
        "새 type 만들기…",
      ],
    );
    expect(typeSelect.value).toBe(BUG_TYPE);
    expect(editor.textContent).toContain(
      "다른 규칙이 쓰지 않는 type만 고를 수 있습니다. 저장되는 칸: 제목, 링크, 근거(PR). PR 상태는 근거에서 읽어 보입니다.",
    );
    expect(
      [
        ...(
          within(editor).getByRole("combobox", {
            name: "구분",
          }) as HTMLSelectElement
        ).options,
      ].map((option) => option.textContent),
    ).toEqual(["개발", "리뷰", "문서"]);
    expect(within(editor).queryByText(/대상 PR/) === null).toBe(true);
    expect(within(editor).getByText("모든 에이전트")).toBeTruthy();
    expect(
      within(editor)
        .getByRole("radio", { name: /^Luna 판정/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const foot = within(editor).getByText(/생깁니다/);
    expect(foot.textContent).toBe("저장하면 v2가 생깁니다.");

    const definition = within(editor).getByRole("textbox", {
      name: "성과 정의",
    });
    await user.clear(definition);
    await user.type(definition, "머지된 버그 수정 PR");
    await user.click(within(editor).getByRole("radio", { name: /^바로 인정/ }));
    await user.click(
      within(editor).getByRole("button", { name: "새 버전 저장" }),
    );
    await screen.findByText("버그 수정 PR v2을 저장했습니다.");
    expect(
      writes(api.calls).map((call) => [call.method, call.path, call.body]),
    ).toEqual([
      [
        "POST",
        `/v1/achievement-rules/${BUGFIX}/versions`,
        {
          category_id: DEV,
          title: "버그 수정 PR",
          type_id: BUG_TYPE,
          definition: "머지된 버그 수정 PR",
          judge: "always",
        },
      ],
    ]);
  });

  test("규칙 편집에서 새 type을 만들면 type만 POST 하고, 그 type을 고른다", async () => {
    const created = type(
      "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      "hotfix_pr",
      "긴급 수정 PR",
      "github_pull_request",
      false,
    );
    const types = [...TYPES];
    const { api } = await opened({
      "GET /v1/achievement-types": () => json(200, { items: types }),
      "POST /v1/achievement-types": () => {
        types.push(created);
        return json(201, { type: created, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "버그 수정 PR" }));
    const editor = (
      await screen.findByRole("heading", {
        level: 2,
        name: "규칙 편집 — 버그 수정 PR",
      })
    ).closest("section") as HTMLElement;
    const typeSelect = within(editor).getByRole("combobox", {
      name: "성과 type",
    }) as HTMLSelectElement;
    await user.selectOptions(typeSelect, "새 type 만들기…");
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: "이름" }),
      "긴급 수정 PR",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "key" }),
      "hotfix_pr",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    await waitFor(() => expect(typeSelect.value).toBe(created.id));
    expect(writes(api.calls).map((call) => [call.method, call.path])).toEqual([
      ["POST", "/v1/achievement-types"],
    ]);
  });

  test("멈춘 규칙의 type을 다른 사용 중 규칙이 가져갔으면 그 type은 고를 수 없다", async () => {
    const taker = rule(
      "4b5c6d7e-8f9a-4b0c-8d1e-2f3a4b5c6d7e",
      DOCS,
      "회의록",
      DOC_TYPE,
      "always",
      1,
    );
    await opened({
      "GET /v1/achievement-rules": () =>
        json(200, { items: [...RULES, taker] }),
    });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "설계 문서 작성" }));
    const editor = (
      await screen.findByRole("heading", {
        level: 2,
        name: "규칙 편집 — 설계 문서 작성",
      })
    ).closest("section") as HTMLElement;
    const typeSelect = within(editor).getByRole("combobox", {
      name: "성과 type",
    }) as HTMLSelectElement;
    expect([...typeSelect.options].map((option) => option.textContent)).toEqual(
      ["solved_talk — 대화로 해결 (근거: 대화)", "새 type 만들기…"],
    );
    expect(typeSelect.value).toBe(TALK_TYPE);
  });

  test("규칙 추가: 첫 버전을 만든다", async () => {
    const { api } = await opened({
      "POST /v1/achievement-rules": async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        return json(201, {
          rule: {
            ...RULES[1],
            ...body,
            id: "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
            family_id: "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
          },
          receipt_id: RECEIPT_ID,
        });
      },
    });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "규칙 추가" }));
    const editor = (
      await screen.findByRole("heading", {
        level: 2,
        name: "규칙 추가",
      })
    ).closest("section") as HTMLElement;
    expect(within(editor).queryByText(/생깁니다/) === null).toBe(true);
    await user.type(
      within(editor).getByRole("textbox", { name: "제목" }),
      "대화로 해결",
    );
    await user.selectOptions(
      within(editor).getByRole("combobox", { name: "성과 type" }),
      TALK_TYPE,
    );
    await user.type(
      within(editor).getByRole("textbox", { name: "성과 정의" }),
      "대화로 문제를 풀었다",
    );
    await user.click(within(editor).getByRole("button", { name: "저장" }));
    await screen.findByText("대화로 해결 v1을 저장했습니다.");
    expect(writes(api.calls).map((call) => call.body)).toEqual([
      {
        category_id: DEV,
        title: "대화로 해결",
        type_id: TALK_TYPE,
        definition: "대화로 문제를 풀었다",
        judge: "always",
      },
    ]);
  });

  test("사용 스위치는 규칙을 멈추고 다시 켠다", async () => {
    const { api } = await opened({
      [`POST /v1/achievement-rules/${MERGED}/disable`]: () =>
        json(200, {
          rule: { ...RULES[0], disabled_at: AT, disabled_by: USER_ID },
          receipt_id: RECEIPT_ID,
        }),
    });
    const user = await setupUser();
    await user.click(screen.getByRole("switch", { name: "머지된 PR 사용" }));
    await waitFor(() =>
      expect(writes(api.calls).map((call) => call.path)).toEqual([
        `/v1/achievement-rules/${MERGED}/disable`,
      ]),
    );
  });

  test("새 버전을 저장하면 표가 새 제목과 버전을 보인다", async () => {
    await opened(liveRules());
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "버그 수정 PR" }));
    const editor = (
      await screen.findByRole("heading", {
        level: 2,
        name: "규칙 편집 — 버그 수정 PR",
      })
    ).closest("section") as HTMLElement;
    const title = within(editor).getByRole("textbox", { name: "제목" });
    await user.clear(title);
    await user.type(title, "고객 버그 수정 PR");
    await user.click(
      within(editor).getByRole("button", { name: "새 버전 저장" }),
    );
    await screen.findByText("고객 버그 수정 PR v2을 저장했습니다.");
    await waitFor(() =>
      expect(ruleRows()[2]).toEqual([
        "고객 버그 수정 PR",
        "bugfix_pr",
        "Luna 판정 ",
        "v2",
      ]),
    );
  });

  test("규칙을 추가하면 그 구분 아래에 v1로 보인다", async () => {
    await opened(liveRules());
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "규칙 추가" }));
    const editor = (
      await screen.findByRole("heading", { level: 2, name: "규칙 추가" })
    ).closest("section") as HTMLElement;
    await user.selectOptions(
      within(editor).getByRole("combobox", { name: "구분" }),
      REVIEW,
    );
    await user.type(
      within(editor).getByRole("textbox", { name: "제목" }),
      "대화로 해결",
    );
    await user.selectOptions(
      within(editor).getByRole("combobox", { name: "성과 type" }),
      TALK_TYPE,
    );
    await user.type(
      within(editor).getByRole("textbox", { name: "성과 정의" }),
      "대화로 문제를 풀었다",
    );
    await user.click(within(editor).getByRole("button", { name: "저장" }));
    await screen.findByText("대화로 해결 v1을 저장했습니다.");
    await waitFor(() =>
      expect(ruleRows().slice(3, 6)).toEqual([
        ["리뷰"],
        ["코드 리뷰 제출", "code_review", "바로 인정 ", "v1"],
        ["대화로 해결", "solved_talk", "바로 인정 사람 확인", "v1"],
      ]),
    );
    expect(
      screen
        .getByRole("switch", { name: "대화로 해결 사용" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("멈춘 규칙은 스위치가 꺼지고, 다시 누르면 enable을 보내 켜진다", async () => {
    const { api } = await opened(liveRules());
    const user = await setupUser();
    const name = { name: "머지된 PR 사용" };
    await user.click(screen.getByRole("switch", name));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", name).getAttribute("aria-checked"),
      ).toBe("false"),
    );
    await user.click(screen.getByRole("switch", name));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", name).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(writes(api.calls).map((call) => call.path)).toEqual([
      `/v1/achievement-rules/${MERGED}/disable`,
      `/v1/achievement-rules/${MERGED}/enable`,
    ]);
  });

  test("한도에 걸리면 어떤 한도인지와 할 일을 말한다", async () => {
    const limit = () =>
      json(409, {
        error: {
          code: "REVISION_CONFLICT",
          message: "limit reached",
          retryable: false,
          request_id: "req-1",
          details: { reason_code: "limit_reached" },
        },
      });
    await opened({
      "POST /v1/achievement-types": limit,
      [`POST /v1/achievement-rules/${DESIGN}/enable`]: limit,
    });
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "type 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: "이름" }),
      "긴급 수정 PR",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "key" }),
      "hotfix_pr",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "보관하지 않은 성과 type은 50개까지입니다. type 하나를 보관한 뒤 다시 하세요.",
    );
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    await user.click(
      screen.getByRole("switch", { name: "설계 문서 작성 사용" }),
    );
    expect(
      await screen.findByText(
        "사용 중인 규칙은 30개까지입니다. 규칙 하나의 사용을 멈춘 뒤 다시 하세요.",
      ),
    ).toBeTruthy();
  });

  test("대화상자가 닫히면 연 버튼으로, 규칙 편집에서 열었으면 type 칸으로 초점이 돌아간다", async () => {
    const created = type(
      "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      "hotfix_pr",
      "긴급 수정 PR",
      "github_pull_request",
      false,
    );
    const types = [...TYPES];
    await opened({
      [`PATCH /v1/achievement-categories/${REVIEW}`]: () =>
        json(200, {
          category: category(REVIEW, "리뷰", 1),
          receipt_id: RECEIPT_ID,
        }),
      "GET /v1/achievement-types": () => json(200, { items: types }),
      "POST /v1/achievement-types": () => {
        types.push(created);
        return json(201, { type: created, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    const closed = () =>
      waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    const focused = (element: HTMLElement) =>
      waitFor(() => expect(document.activeElement === element).toBe(true));

    const add = screen.getByRole("button", { name: "구분 추가" });
    await user.click(add);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "취소",
      }),
    );
    await closed();
    await focused(add);

    await user.click(add);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await closed();
    await focused(add);

    const rename = screen.getByRole("button", { name: "리뷰 이름 바꾸기" });
    await user.click(rename);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "저장",
      }),
    );
    await closed();
    await focused(rename);

    await user.click(screen.getByRole("button", { name: "버그 수정 PR" }));
    const editor = (
      await screen.findByRole("heading", {
        level: 2,
        name: "규칙 편집 — 버그 수정 PR",
      })
    ).closest("section") as HTMLElement;
    const typeSelect = within(editor).getByRole("combobox", {
      name: "성과 type",
    });
    await user.selectOptions(typeSelect, "새 type 만들기…");
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: "이름" }),
      "긴급 수정 PR",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "key" }),
      "hotfix_pr",
    );
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await closed();
    await focused(typeSelect);

    const addType = screen.getByRole("button", { name: "type 추가" });
    await user.click(addType);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await closed();
    await focused(addType);
  });

  test("머리의 '판정 모델 설정'은 '규칙 추가' 바로 왼쪽에 있고, owner만 누를 수 있다", async () => {
    await opened();
    const setup = screen.getByRole("button", { name: "판정 모델 설정" });
    const add = screen.getByRole("button", { name: "규칙 추가" });
    const buttons = screen.getAllByRole("button");
    expect(buttons.indexOf(setup) + 1).toBe(buttons.indexOf(add));
    expect(setup.getAttribute("aria-disabled") === null).toBe(true);
    expect(add.getAttribute("aria-disabled") === null).toBe(true);
  });

  for (const [who, principal, reason] of [
    ["admin", () => me(undefined, "admin"), "어드민"],
    ["member", () => memberMe(), "멤버"],
  ] as const) {
    test(`${who}에게 '판정 모델 설정'은 설치 설정 권한이 없다는 이유와 함께 막힌다`, async () => {
      const { api } = await opened({}, principal());
      const user = await setupUser();
      const setup = screen.getByRole("button", { name: "판정 모델 설정" });
      expect(setup.getAttribute("aria-disabled")).toBe("true");
      const text = reasonOf(setup);
      expect(text).toContain("설치 설정 관리");
      expect(text).toContain(reason);
      await user.click(setup);
      expect(screen.queryByRole("dialog") === null).toBe(true);
      // Owner-only: the connections are never read.
      expect(api.calls.some((call) => call.path === SETTINGS_CONNECTIONS)).toBe(
        false,
      );
    });
  }

  test("판정 모델이 없으면 머리 아래를 잠금이 덮고, 덮인 곳은 inert이며 '규칙 추가'는 이유와 함께 막힌다", async () => {
    const { api } = await opened({
      [`GET ${JUDGE}`]: () =>
        json(200, { achievement_judge: SETTINGS, connections: [] }),
    });
    const user = await setupUser();
    const lock = await screen.findByRole("group", { name: "사용할 수 없음" });
    expect(lock.textContent).toContain(
      "판정 모델을 설정해야 성과 규칙을 쓸 수 있습니다",
    );
    const covered = (section("규칙") as HTMLElement).closest("[inert]");
    expect(covered === null).toBe(false);
    expect(section("판정 설정")?.closest("[inert]") === covered).toBe(true);
    expect(covered?.contains(lock)).toBe(false);
    expect(lock.closest("[inert]") === null).toBe(true);
    // The way out is the header's button alone; the notice holds none.
    expect(within(lock).queryAllByRole("button")).toHaveLength(0);
    const setup = screen.getByRole("button", { name: "판정 모델 설정" });
    expect(setup.closest("[inert]") === null).toBe(true);
    expect(setup.getAttribute("aria-disabled") === null).toBe(true);

    const add = screen.getByRole("button", { name: "규칙 추가" });
    expect(add.closest("[inert]") === null).toBe(true);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(add)).toBe(
      "판정 모델을 설정해야 성과 규칙을 바꿀 수 있습니다.",
    );
    await user.click(add);
    expect(
      screen.queryByRole("heading", { level: 2, name: "규칙 추가" }) === null,
    ).toBe(true);
    expect(writes(api.calls)).toEqual([]);
  });

  test("판정 모델을 설정하면 새로고침 없이 잠금이 풀리고, 판정기가 그 연결을 쓴다", async () => {
    const made: string[] = [];
    let judged: Record<string, unknown> | null = null;
    const { api } = await opened({
      [`GET ${JUDGE}`]: () =>
        json(200, {
          achievement_judge: { ...SETTINGS, ...judged },
          connections: made,
        }),
      [`GET ${SETTINGS_CONNECTIONS}`]: () =>
        json(200, {
          items: made.map((id) => decisionConnection(id)),
          credential_hosts: null,
          endpoint_defaults: { openai_decisions: "https://api.openai.com" },
        }),
      // As the API: a judge that names no connection takes the new one.
      [`POST ${SETTINGS_CONNECTIONS}`]: async (request) => {
        const body = (await request.json()) as { id: string };
        made.push(body.id);
        judged ??= { connection_id: body.id };
        return json(201, { id: body.id, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("group", { name: "사용할 수 없음" });
    const opener = screen.getByRole("button", { name: "판정 모델 설정" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", {
      name: "판정 모델 연결 추가",
    });
    expect(dialog.textContent).toContain("gpt-6-luna");
    expect(within(dialog).queryByLabelText("종류") === null).toBe(true);
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("엔드포인트").value,
    ).toBe("https://api.openai.com");
    await user.type(within(dialog).getByLabelText("id"), "luna-main");
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "사용할 수 없음" }) === null,
      ).toBe(true),
    );
    // The judge the API set is read again, with no write of the screen's own.
    const judge = (await screen.findByRole("combobox", {
      name: "Luna 연결",
    })) as HTMLSelectElement;
    await waitFor(() => expect(judge.value).toBe("luna-main"));
    expect(document.querySelector("[inert]") === null).toBe(true);
    await waitFor(() => expect(document.activeElement === opener).toBe(true));
    expect(
      screen
        .getByRole("button", { name: "규칙 추가" })
        .getAttribute("aria-disabled") === null,
    ).toBe(true);
    expect(
      writes(api.calls).map((call) => [call.method, call.path, call.body]),
    ).toEqual([
      [
        "POST",
        SETTINGS_CONNECTIONS,
        {
          id: "luna-main",
          kind: "openai_decisions",
          billing: "per_token",
          auth_kind: "api_key",
          value: "example-key",
        },
      ],
    ]);
  });

  test("화면을 연 뒤 다른 사람이 판정기를 골랐으면, 새 판정 모델을 만들어도 그 설정을 덮어쓰지 않는다", async () => {
    let reads = 0;
    const { api } = await opened({
      // The screen's first read sees no judge; anyone's later read sees the
      // one another person saved meanwhile.
      [`GET ${JUDGE}`]: () => {
        reads += 1;
        return json(200, {
          achievement_judge:
            reads === 1
              ? SETTINGS
              : { ...SETTINGS, connection_id: "luna-a", threshold: 0.8 },
          connections: reads === 1 ? [] : ["luna-a"],
        });
      },
      [`GET ${SETTINGS_CONNECTIONS}`]: () =>
        json(200, {
          items: [],
          credential_hosts: null,
          endpoint_defaults: { openai_decisions: "https://api.openai.com" },
        }),
      [`POST ${SETTINGS_CONNECTIONS}`]: async (request) => {
        const body = (await request.json()) as { id: string };
        return json(201, { id: body.id, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("group", { name: "사용할 수 없음" });
    await user.click(screen.getByRole("button", { name: "판정 모델 설정" }));
    const dialog = await screen.findByRole("dialog", {
      name: "판정 모델 연결 추가",
    });
    await user.type(within(dialog).getByLabelText("id"), "luna-main");
    await user.type(within(dialog).getByLabelText("키 값"), "example-key");
    await user.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "사용할 수 없음" }) === null,
      ).toBe(true),
    );
    await waitFor(() => expect(reads >= 2).toBe(true));
    const judge = (await screen.findByRole("combobox", {
      name: "Luna 연결",
    })) as HTMLSelectElement;
    await waitFor(() => expect(judge.value).toBe("luna-a"));
    expect(writes(api.calls).map((call) => call.method)).toEqual(["POST"]);
  });

  test("이미 있는 판정 모델은 여기서 키를 바꾸고 사용 중지하며, 에이전트의 연결은 보이지 않는다", async () => {
    const { api } = await opened({
      [`GET ${SETTINGS_CONNECTIONS}`]: () =>
        json(200, {
          items: [
            decisionConnection("anthropic", {
              kind: "anthropic",
              endpoint: "https://api.anthropic.com",
            }),
            decisionConnection("luna-a"),
            decisionConnection("luna-off", {
              state: "disabled",
              disabled_at: AT,
              credential: { source: "stored", last4: null },
            }),
          ],
          credential_hosts: null,
          endpoint_defaults: {},
        }),
      [`POST ${SETTINGS_CONNECTIONS}/luna-a/credential`]: () =>
        json(200, { id: "luna-a", receipt_id: RECEIPT_ID }),
      [`POST ${SETTINGS_CONNECTIONS}/luna-a/disable`]: () =>
        json(200, { id: "luna-a", receipt_id: RECEIPT_ID }),
    });
    const user = await setupUser();
    const opener = screen.getByRole("button", { name: "판정 모델 설정" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "판정 모델" });
    await within(dialog).findByText("luna-a");
    expect(dialog.textContent).not.toContain("anthropic");
    expect(dialog.textContent).toContain("저장 값 ••••abcd");
    expect(dialog.textContent).toContain("https://api.openai.com");
    // Disabled with no value: it takes its first, so it can be enabled again.
    expect(
      within(dialog).queryByRole("button", {
        name: "luna-off의 API 키 설정",
      }) !== null,
    ).toBe(true);
    // jsdom has no layout; the 390px demo shot is the real check.
    const row = within(dialog)
      .getByRole("button", { name: "luna-a 사용 중지" })
      .closest("li");
    for (const name of [
      "max-sm:[&>span:nth-child(2)]:col-1",
      "max-sm:[&>div]:row-end-3",
      "max-sm:[&>div]:self-center",
    ]) {
      expect(row?.className.split(/\s+/).includes(name)).toBe(true);
    }

    await user.click(
      within(dialog).getByRole("button", { name: "luna-a의 API 키 설정" }),
    );
    const keyDialog = await screen.findByRole("dialog", {
      name: "luna-a의 값 바꾸기",
    });
    await user.type(within(keyDialog).getByLabelText("값"), "example-key-2");
    await user.click(within(keyDialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "luna-a의 값 바꾸기" }) === null,
      ).toBe(true),
    );

    await user.click(
      within(dialog).getByRole("button", { name: "luna-a 사용 중지" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "luna-a를 사용 중지할까요?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "사용 중지" }),
    );
    await waitFor(() =>
      expect(
        writes(api.calls).map((call) => [call.method, call.path, call.body]),
      ).toEqual([
        [
          "POST",
          `${SETTINGS_CONNECTIONS}/luna-a/credential`,
          { value: "example-key-2" },
        ],
        ["POST", `${SETTINGS_CONNECTIONS}/luna-a/disable`, null],
      ]),
    );
  });

  test("member: 읽기만 한다", async () => {
    const { api } = await opened({}, memberMe());
    const user = await setupUser();
    const card = section("판정 설정") as HTMLElement;
    await waitFor(() =>
      expect(
        (
          within(card).getByRole("spinbutton", {
            name: "하루 예산",
          }) as HTMLInputElement
        ).disabled,
      ).toBe(true),
    );
    expect(
      within(card)
        .getByRole("checkbox", { name: "턴마다" })
        .hasAttribute("disabled"),
    ).toBe(true);
    const save = within(card).getByRole("button", { name: "저장" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.click(save);
    for (const name of [
      "규칙 추가",
      "구분 추가",
      "type 추가",
      "개발 이름 바꾸기",
    ]) {
      expect(
        screen.getByRole("button", { name }).getAttribute("aria-disabled"),
      ).toBe("true");
    }
    expect(
      screen
        .getByRole("switch", { name: "머지된 PR 사용" })
        .hasAttribute("disabled"),
    ).toBe(true);
    // The editor opens to read; its fields and save stay closed.
    await user.click(screen.getByRole("button", { name: "버그 수정 PR" }));
    const editor = (
      await screen.findByRole("heading", {
        level: 2,
        name: "규칙 편집 — 버그 수정 PR",
      })
    ).closest("section") as HTMLElement;
    expect(editor.textContent).toContain("v1 · 2026-10-28");
    expect(editor.textContent).not.toContain("만듦");
    expect(
      (
        within(editor).getByRole("textbox", {
          name: "제목",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    const saveVersion = within(editor).getByRole("button", {
      name: "새 버전 저장",
    });
    expect(saveVersion.getAttribute("aria-disabled")).toBe("true");
    await user.click(saveVersion);
    expect(writes(api.calls)).toEqual([]);
    expect(api.calls.some((call) => call.path === "/v1/members")).toBe(false);
  });
});

test("받침이 있으면 '이', 없으면 '가', 한글이 아니면 '이(가)'", () => {
  expect(subjectParticle("김지민")).toBe("이");
  expect(subjectParticle("이수")).toBe("가");
  expect(subjectParticle("Owner")).toBe("이(가)");
});

test("화면의 상한은 계약의 상한과 같다", async () => {
  const contract = await import("@werft-ai/contracts");
  const screenLimits = await import("./achievement-rules.tsx");
  expect(screenLimits.ACHIEVEMENT_RULE_DEFINITION_MAX).toBe(
    contract.ACHIEVEMENT_RULE_DEFINITION_MAX,
  );
  expect(screenLimits.ACHIEVEMENT_CATEGORY_NAME_MAX).toBe(
    contract.ACHIEVEMENT_CATEGORY_NAME_MAX,
  );
  expect(screenLimits.ACHIEVEMENT_TYPE_NAME_MAX).toBe(
    contract.ACHIEVEMENT_TYPE_NAME_MAX,
  );
  expect(screenLimits.ACHIEVEMENT_RULE_TITLE_MAX).toBe(
    contract.ACHIEVEMENT_RULE_TITLE_MAX,
  );
  expect(screenLimits.ACHIEVEMENT_TYPE_LIMIT).toBe(
    contract.ACHIEVEMENT_TYPE_LIMIT,
  );
  expect(screenLimits.ACHIEVEMENT_RULE_LIMIT).toBe(
    contract.ACHIEVEMENT_RULE_LIMIT,
  );
});
