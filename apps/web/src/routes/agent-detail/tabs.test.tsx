import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  AGENT_ID,
  agentServer,
  seedRelease as releaseFixture,
} from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  keys,
  me,
  memberMe,
  memberPage,
  USER_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
const { formatExactTime, formatRelativeTime } = await import("@werft-ai/ui");

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;
const AGENT_SESSIONS_SEARCH = `?agent_id=${AGENT_ID}&limit=5`;

const selected = () =>
  screen.getByRole("tab", { selected: true }).textContent ?? "";
const visiblePanel = () => screen.getByRole("tabpanel");

function releaseCells(row: HTMLElement) {
  const [version, status, activated, by] = within(row).getAllByRole("cell");
  const times = [...(activated?.querySelectorAll("time") ?? [])].map((time) =>
    time.getAttribute("datetime"),
  );
  return [
    version?.firstElementChild?.firstElementChild?.textContent,
    status?.textContent,
    times.length > 0 ? times.join(" ~ ") : activated?.textContent,
    by?.textContent,
  ];
}
const tabIn = (history: { location: { search: string } }) =>
  new URLSearchParams(history.location.search).get("tab");
/** Each figure's label, value and note line, as drawn. */
const figureTexts = (glance: HTMLElement) =>
  within(glance)
    .getAllByRole("listitem")
    .map((item) =>
      [...(item.querySelector("[data-slot=stat-card]")?.children ?? [])].map(
        (line) => line.textContent,
      ),
    );
/** A GET /v1/agents item with the counts its summary carries. */
const listed = (
  id: string,
  counts: { needs_input_count: number; running_count: number },
) => ({
  ...agentServer().detail().agent,
  id,
  summary: {
    version: {
      version_no: 1,
      role: "결제 문의 담당",
      instructions: "결제 문의에 답한다",
      mcp_servers: [],
      credential_refs: [],
    },
    runtime_profile_id: null,
    release_label: null,
    bound_credential_refs: [],
    admins: ["Owner"],
    slack_action: null,
    ...counts,
  },
});

describe("에이전트 상세 탭", () => {
  test("개요·카드·배포·관리자 탭이 있고, 화살표로 옮기면 주소의 tab이 따라간다", async () => {
    const { history } = renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    const list = await screen.findByRole("tablist", { name: "에이전트 상세" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["개요", "상세 설정", "릴리스", "관리자", "Slack", "GitHub"]);
    expect(selected()).toBe("개요");
    expect(tabIn(history)).toBeNull();
    // Only the chosen panel is in the accessibility tree.
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: "개요" }));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(selected()).toBe("상세 설정"));
    expect(document.activeElement?.textContent).toBe("상세 설정");
    expect(tabIn(history)).toBe("card");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(selected()).toBe("릴리스"));
    expect(tabIn(history)).toBe("release");
    await user.keyboard("{End}");
    await waitFor(() => expect(selected()).toBe("GitHub"));
    expect(tabIn(history)).toBe("github");
    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(selected()).toBe("관리자"));
    expect(tabIn(history)).toBe("admins");
    await user.click(screen.getByRole("tab", { name: "개요" }));
    await waitFor(() => expect(tabIn(history)).toBeNull());
    // Tab leaves the tab list for the panel instead of walking the tabs.
    // (happy-dom keeps controls inside hidden panels focusable, so this is
    // checked from the first panel; browsers skip hidden ones.)
    await user.tab();
    expect(document.activeElement === visiblePanel()).toBe(true);
  });

  test("머리의 버튼 줄은 새 세션 뒤 맨 끝에 에이전트 목록으로 돌아가는 버튼을 두고, 제목 위 위치 줄은 없다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const heading = await screen.findByRole("heading", { level: 1 });
    const header = heading.closest("header") as HTMLElement;
    expect(
      within(header).queryByRole("navigation", { name: "위치" }),
    ).toBeNull();
    const back = within(header).getByRole("link", { name: "에이전트 목록" });
    expect(back.getAttribute("href")).toBe("/agents");
    const create = within(header).getByRole("button", {
      name: /이 에이전트로 새 세션/,
    });
    expect(
      within(header)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["이 에이전트로 새 세션"]);
    // The keyboard reaches the title, the command, then the way back.
    expect(
      heading.compareDocumentPosition(create) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      create.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("상태 태그는 제목 줄의 이름 옆에 있되 제목 이름에 섞이지 않고, 설명 줄에는 설명만 둔다", async () => {
    renderAt(DETAIL, {
      ...meOk,
      ...agentServer({ description: "결제 문의 담당" }).routes,
    });
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "결제 담당",
    });
    await waitFor(() =>
      expect(heading.nextElementSibling?.textContent).toBe("초안"),
    );
    expect(heading.nextElementSibling?.getAttribute("data-slot")).toBe("badge");
    const description = document.getElementById(
      heading.getAttribute("aria-describedby") ?? "",
    );
    expect(description?.textContent).toBe("결제 문의 담당");
  });

  test("주소의 tab으로 다시 열면 그 탭이고, 탭 이동은 뒤로 가기 기록을 쌓지 않는다", async () => {
    const server = agentServer();
    const { history } = renderAt("/agents", { ...meOk, ...server.routes });
    const user = await setupUser();
    history.push(`${DETAIL}?tab=release`);
    await waitFor(() => expect(selected()).toBe("릴리스"));
    expect(
      within(visiblePanel()).getByRole("heading", { name: "릴리스", level: 2 }),
    ).toBeDefined();

    await user.click(screen.getByRole("tab", { name: "상세 설정" }));
    await user.click(screen.getByRole("tab", { name: "관리자" }));
    expect(tabIn(history)).toBe("admins");
    history.push("/");
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    history.back();
    await waitFor(() => expect(selected()).toBe("관리자"));
    history.back();
    await waitFor(() => expect(history.location.pathname).toBe("/agents"));
  });

  test("모르는 tab 값은 개요로 연다", async () => {
    renderAt(`${DETAIL}?tab=secrets`, { ...meOk, ...agentServer().routes });
    await screen.findByRole("tablist");
    expect(selected()).toBe("개요");
  });

  test("카드 탭은 읽기 두 칸으로 시작하고, 카드 편집은 제자리에서 열고 취소하면 버튼으로 돌아간다", async () => {
    renderAt(`${DETAIL}?tab=card`, { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const summary = await screen.findByRole("region", {
      name: "에이전트 카드",
    });
    expect(
      within(summary).getByRole("heading", { level: 2, name: "에이전트 카드" }),
    ).toBeDefined();
    expect(
      [...summary.querySelectorAll("dt")].map((term) => term.textContent),
    ).toEqual([
      "이름",
      "식별자",
      "릴리스",
      "설명",
      "에이전트 지시문",
      "자격 증명",
      "MCP",
      "모델",
      "답변 언어",
      "쓸 수 있는 도구",
      "금지 도구",
    ]);
    expect(
      within(summary).getByText("릴리스", { selector: "dt" }).nextElementSibling
        ?.textContent,
    ).toBe("-");
    expect(within(summary).getByText("v1")).toBeDefined();
    // Not released yet: the raw card is the latest version's.
    expect(screen.getByText("최신 버전 기준 · 읽기 전용")).toBeDefined();
    expect(screen.queryByLabelText("에이전트 지시문")).toBeNull();
    const history = screen
      .getByRole("heading", { name: "버전 기록" })
      .closest("details") as HTMLDetailsElement;
    expect(history.open).toBe(false);

    const edit = within(summary).getByRole("button", {
      name: "상세 설정 편집",
    });
    await user.click(edit);
    const title = screen.getByRole("heading", { name: "상세 설정" });
    expect(document.activeElement === title).toBe(true);
    expect(screen.queryByRole("heading", { name: "에이전트 카드" })).toBeNull();
    await user.type(screen.getByLabelText("에이전트 지시문"), " 버릴 줄.");
    await user.click(screen.getByRole("button", { name: "취소" }));
    const back = await screen.findByRole("button", { name: "상세 설정 편집" });
    expect(document.activeElement === back).toBe(true);
    await user.click(back);
    expect(
      (screen.getByLabelText("에이전트 지시문") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  test("다른 탭에 다녀와도 저장하지 않은 카드 입력은 남는다", async () => {
    renderAt(`${DETAIL}?tab=card`, { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "상세 설정 편집" }),
    );
    const instructions = await screen.findByLabelText("에이전트 지시문");
    await user.clear(instructions);
    await user.type(instructions, "아직 저장하지 않은 지시.");
    await user.click(screen.getByRole("tab", { name: "릴리스" }));
    await user.click(screen.getByRole("tab", { name: "상세 설정" }));
    expect(
      (screen.getByLabelText("에이전트 지시문") as HTMLTextAreaElement).value,
    ).toBe("아직 저장하지 않은 지시.");
  });

  test("다른 탭으로 옮긴 뒤 끝난 저장은 카드 탭을 다시 열고 결과로 포커스를 옮긴다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    let respond: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      respond = resolve;
    });
    const { history } = renderAt(`${DETAIL}?tab=card`, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        await gate;
        return patch ? patch(request) : json(500, {});
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "상세 설정 편집" }),
    );
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await user.click(screen.getByRole("tab", { name: "개요" }));
    await waitFor(() => expect(selected()).toBe("개요"));
    respond();
    const saved = await screen.findByText(/저장했습니다/);
    await waitFor(() => expect(selected()).toBe("상세 설정"));
    expect(visiblePanel().contains(saved)).toBe(true);
    await waitFor(() => expect(tabIn(history)).toBe("card"));
    expect(document.activeElement?.contains(saved)).toBe(true);
  });

  test("카드 편집의 도구는 프로필 도구 체크 목록이고, 프로필에 없는 도구·금지 도구는 끄거나 지울 수만 있다", async () => {
    const server = agentServer();
    const first = server.versions[0];
    if (!first) throw new Error("agentServer starts with a version");
    server.versions[0] = {
      ...first,
      card: {
        ...first.card,
        capabilities: {
          tools: ["Read", "WebFetch"],
          mcp: null,
          forbidden: ["Bash"],
        },
      },
    };
    const { api } = renderAt(`${DETAIL}?tab=card`, {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "상세 설정 편집" }),
    );
    expect(screen.queryByRole("textbox", { name: /도구/ })).toBeNull();
    const all = await screen.findByRole("switch", {
      name: "릴리스할 때 프로필이 막지 않은 도구 전부",
    });
    expect(all.getAttribute("aria-checked")).toBe("false");
    const read = screen.getByRole("checkbox", { name: /^Read/ });
    expect(read.getAttribute("aria-checked")).toBe("true");
    const outside = screen.getByRole("checkbox", { name: /^WebFetch/ });
    expect(outside.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText("프로필에 없는 도구 · 끌 수만 있습니다"),
    ).toBeDefined();
    expect(
      screen.getByText(
        /고른 도구를 모두 허용하는 프로필이 없어 저장할 수 없습니다/,
      ),
    ).toBeDefined();
    const save = screen.getByRole("button", { name: "저장" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    const blocked = screen.getByRole("group", { name: "금지 도구" });
    expect(within(blocked).getByText("Bash")).toBeDefined();
    await user.click(
      within(blocked).getByRole("button", { name: "금지 도구 지우기" }),
    );
    expect(screen.queryByRole("group", { name: "금지 도구" })).toBeNull();

    await user.click(outside);
    expect(screen.queryByRole("checkbox", { name: /^WebFetch/ })).toBeNull();
    expect(
      screen.getByText("고른 도구를 모두 허용하는 프로필 1개"),
    ).toBeDefined();
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find(
      (call) =>
        call.method === "PATCH" && call.path === `/v1/agents/${AGENT_ID}`,
    );
    expect(
      (patch?.body as { card: { capabilities: unknown } }).card.capabilities,
    ).toEqual({ tools: ["Read"], mcp: null, forbidden: [] });
  });

  test("금지 도구는 지우기 전까지 체크 목록에서 꺼진 채 바꿀 수 없고, 저장해도 금지로 남는다", async () => {
    const server = agentServer();
    const first = server.versions[0];
    if (!first) throw new Error("agentServer starts with a version");
    server.versions[0] = {
      ...first,
      card: {
        ...first.card,
        role: "금지 확인",
        capabilities: { tools: null, mcp: null, forbidden: ["Read"] },
      },
    };
    const { api } = renderAt(`${DETAIL}?tab=card`, {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "상세 설정 편집" }),
    );
    await user.click(
      await screen.findByRole("switch", {
        name: "릴리스할 때 프로필이 막지 않은 도구 전부",
      }),
    );
    const read = screen.getByRole("checkbox", { name: /^Read/ });
    expect(read.getAttribute("aria-checked")).toBe("false");
    expect((read as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("금지 도구 · 아래에서 지우면 고를 수 있습니다"),
    ).toBeDefined();
    await user.click(read);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find(
      (call) =>
        call.method === "PATCH" && call.path === `/v1/agents/${AGENT_ID}`,
    );
    expect(
      (patch?.body as { card: { capabilities: unknown } }).card.capabilities,
    ).toEqual({ tools: [], mcp: null, forbidden: ["Read"] });
  });

  test("개요의 켜기까지 단계는 아직 켜지지 않았다고 하고 배포 탭으로 잇는다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const section = (
      await screen.findByRole("heading", { name: "켜기까지" })
    ).closest("section") as HTMLElement;
    expect(
      await within(section).findByText(/아직 켜지지 않았습니다/),
    ).toBeDefined();
    within(section).getByRole("button", { name: "릴리스 탭으로" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(selected()).toBe("릴리스"));
    // The keyboard goes on to the tab it opened.
    const releaseTab = screen.getByRole("tab", { name: "릴리스" });
    expect(document.activeElement === releaseTab).toBe(true);
  });

  test("최근 세션은 이 에이전트의 세션만 묻는다", async () => {
    const session = (id: string, rest: object) => ({
      id,
      title: null,
      agent: {
        id: AGENT_ID,
        name: "agent",
        release_version_no: 2,
        release_label: "2026-10-30_14:30:28",
      },
      created_by: null,
      channel: "web",
      revision: 1,
      admission_state: "active",
      status: "idle",
      runtime: null,
      repository_id: null,
      current_turn_id: null,
      queued_turn_count: 0,
      model: "model-default",
      last_event_at: null,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      ...rest,
    });
    const { api } = renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      [`GET /v1/sessions${AGENT_SESSIONS_SEARCH}`]: () =>
        json(200, {
          items: [
            session("0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01", {
              title: "배포 점검",
              status: "running",
              last_event_at: "2026-10-02T00:00:00.000Z",
            }),
            // A server from before release labels names the card version.
            session("1a2b3c4d-3d1e-4c7a-9b2f-5e6d7c8a9b02", {
              admission_state: "paused",
              agent: { id: AGENT_ID, name: "agent", release_version_no: 2 },
            }),
          ],
          next_cursor: "c2",
        }),
    });
    const table = await screen.findByRole("table", { name: "최근 세션" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        [...row.querySelectorAll("[role=cell]")]
          .slice(0, 4)
          .map((cell) => cell.textContent?.replace(/\s+/g, " ").trim()),
      ),
    ).toEqual([
      [
        "배포 점검0f8b6a52",
        "작업 상태: 작업 중",
        "세션 상태: 열림",
        "릴리스: 2026-10-30_14:30:28",
      ],
      [
        "1a2b3c4d",
        "작업 상태: 쉬는 중",
        "세션 상태: 일시정지됨",
        "릴리스: 버전 2",
      ],
    ]);
    expect(
      within(table)
        .getByRole("link", { name: "세션 열기: 배포 점검" })
        .getAttribute("href"),
    ).toBe("/sessions/0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01");
    expect(
      api.calls.filter((c) => c.search === AGENT_SESSIONS_SEARCH).length,
    ).toBe(1);
    const recent = table.closest("section") as HTMLElement;
    expect(
      within(recent)
        .getByRole("link", { name: "모든 세션" })
        .getAttribute("href"),
    ).toBe("/sessions");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  const recentSessions = async () =>
    (await screen.findByRole("heading", { name: "최근 세션" })).closest(
      "section",
    ) as HTMLElement;

  test("최근 세션에 볼 세션이 없으면 빈 상태를 말하고 다시 시도는 없다", async () => {
    renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      [`GET /v1/sessions${AGENT_SESSIONS_SEARCH}`]: () =>
        json(200, { items: [], next_cursor: null }),
    });
    const section = await recentSessions();
    expect(
      await within(section).findByText(
        "이 에이전트로 만든 세션 중 볼 수 있는 세션이 없습니다.",
      ),
    ).toBeDefined();
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("table")).toBeNull();
  });

  test("최근 세션을 읽지 못하면 빈 상태가 아니라 실패를 말하고, 다시 시도한다", async () => {
    let fail = true;
    const { api } = renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      [`GET /v1/sessions${AGENT_SESSIONS_SEARCH}`]: () =>
        fail
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: [], next_cursor: null }),
    });
    const section = await recentSessions();
    const retry = await within(section).findByRole("button", {
      name: "다시 시도",
    });
    expect(
      within(section).queryByText(
        "이 에이전트로 만든 세션 중 볼 수 있는 세션이 없습니다.",
      ),
    ).toBeNull();
    fail = false;
    const user = await setupUser();
    await user.click(retry);
    expect(
      await within(section).findByText(
        "이 에이전트로 만든 세션 중 볼 수 있는 세션이 없습니다.",
      ),
    ).toBeDefined();
    expect(
      api.calls.filter((c) => c.search === AGENT_SESSIONS_SEARCH).length,
    ).toBe(2);
  });

  test("설치 사용량을 읽는 사람에게는 셋째 칸에 이 에이전트의 최근 7일 추정 비용이 보인다", async () => {
    const figures = (cost: string) => ({
      session_count: 3,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      token_count: 0,
      cost_usd: cost,
    });
    const { api } = renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/usage/breakdown": () =>
        json(200, {
          rows: [
            { key: "other-agent", label: "other", ...figures("4.000000") },
            { key: AGENT_ID, label: "agent", ...figures("0.960000") },
          ],
          totals: figures("4.960000"),
        }),
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    await within(glance).findByText("$0.96");
    const cost = within(glance).getAllByRole("listitem")[2] as HTMLElement;
    expect(cost.textContent).toContain("최근 7일 비용");
    expect(cost.textContent).toContain("추정");
    expect(cost.textContent).toContain("제공업체 청구액과 다를 수 있음");
    const asked = new URLSearchParams(
      api.calls.find((call) => call.path === "/v1/usage/breakdown")?.search,
    );
    expect(asked.get("scope")).toBe("installation");
    expect(asked.get("by")).toBe("agent");
    expect(
      Date.parse(asked.get("until") ?? "") -
        Date.parse(asked.get("since") ?? ""),
    ).toBe(7 * 86_400_000);
  });

  test("기간 안에 이 에이전트의 세션이 없으면 비용은 $0.00이다", async () => {
    renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/usage/breakdown": () =>
        json(200, {
          rows: [],
          totals: {
            session_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            token_count: 0,
            cost_usd: "0",
          },
        }),
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    await within(glance).findByText("$0.00");
  });

  test("비용을 읽지 못하면 비용 칸은 —와 이유를 보인다", async () => {
    renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/usage/breakdown": () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    await waitFor(() =>
      expect(figureTexts(glance)[2]).toEqual([
        "최근 7일 비용추정",
        "—",
        "불러오지 못함",
      ]),
    );
  });

  test("개요 지표는 시안 순서로 답변 대기·작업 중·최근 7일 비용이고, 수는 에이전트 목록의 summary에서 읽는다", async () => {
    const { api } = renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/agents": () =>
        json(200, {
          items: [
            listed("00000000-0000-4000-8000-0000000000aa", {
              needs_input_count: 9,
              running_count: 9,
            }),
            listed(AGENT_ID, { needs_input_count: 2, running_count: 0 }),
          ],
          next_cursor: null,
        }),
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    await waitFor(() =>
      expect(figureTexts(glance).slice(0, 2)).toEqual([
        ["답변 대기", "2", "담당자가 답할 요청"],
        ["작업 중", "0", "지금 실행 중인 세션"],
      ]),
    );
    expect(figureTexts(glance)[2]?.[0]).toBe("최근 7일 비용추정");
    const lists = api.calls.filter((call) => call.path === "/v1/agents");
    expect(lists).toHaveLength(1);
    expect(lists[0]?.search).toContain("include=summary");
  });

  test("수를 읽지 못하면 두 칸은 —와 이유를 보인다", async () => {
    renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/agents": () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    await waitFor(() =>
      expect(figureTexts(glance).slice(0, 2)).toEqual([
        ["답변 대기", "—", "불러오지 못함"],
        ["작업 중", "—", "불러오지 못함"],
      ]),
    );
  });

  test("다시 읽기가 실패하면 앞서 읽은 수를 그대로 두지 않고 —와 이유를 보인다", async () => {
    let fail = false;
    const { services } = renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/agents": () =>
        fail
          ? apiError(500, "INTERNAL_ERROR", "boom")
          : json(200, {
              items: [
                listed(AGENT_ID, { needs_input_count: 2, running_count: 1 }),
              ],
              next_cursor: null,
            }),
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    await waitFor(() =>
      expect(figureTexts(glance)[0]).toEqual([
        "답변 대기",
        "2",
        "담당자가 답할 요청",
      ]),
    );
    fail = true;
    await services.queryClient.refetchQueries({ queryKey: keys.agents });
    await waitFor(() =>
      expect(figureTexts(glance).slice(0, 2)).toEqual([
        ["답변 대기", "—", "불러오지 못함"],
        ["작업 중", "—", "불러오지 못함"],
      ]),
    );
  });

  test("관리자에게 수는 보이고, 설치 사용량을 못 읽으니 비용은 —와 이유이며 묻지 않는다", async () => {
    const { api } = renderAt(DETAIL, {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      ...agentServer().routes,
      "GET /v1/agents": () =>
        json(200, {
          items: [listed(AGENT_ID, { needs_input_count: 1, running_count: 3 })],
          next_cursor: null,
        }),
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    await waitFor(() =>
      expect(figureTexts(glance)).toEqual([
        ["답변 대기", "1", "담당자가 답할 요청"],
        ["작업 중", "3", "지금 실행 중인 세션"],
        ["최근 7일 비용추정", "—", "소유자만 볼 수 있음"],
      ]),
    );
    expect(api.calls.some((call) => call.path === "/v1/usage/breakdown")).toBe(
      false,
    );
  });

  test("에이전트 목록도 설치 사용량도 못 읽는 구성원에게는 세 칸 모두 —와 이유이고 묻지도 않는다", async () => {
    const { api } = renderAt(DETAIL, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...agentServer().routes,
    });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    expect(figureTexts(glance)).toEqual([
      ["답변 대기", "—", "소유자와 관리자만 볼 수 있음"],
      ["작업 중", "—", "소유자와 관리자만 볼 수 있음"],
      ["최근 7일 비용추정", "—", "소유자만 볼 수 있음"],
    ]);
    // The dash is not read out; the reason under it is.
    expect(
      within(glance)
        .getAllByText("—")
        .every((dash) => dash.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/usage/breakdown" || call.path === "/v1/agents",
      ),
    ).toBe(false);
  });

  test("머리 태그는 릴리스한 에이전트를 목록과 같은 상태 이름으로 부른다", async () => {
    const server = agentServer();
    await released(server);
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() =>
      expect(heading.nextElementSibling?.textContent).toBe("릴리스"),
    );
  });

  test("일시정지된 에이전트는 최신 release가 켜져 있어도 켜짐이라 하지 않는다", async () => {
    const server = agentServer();
    const path = `/v1/agents/${AGENT_ID}`;
    await released(server);
    const release = server.detail().releases[0];
    const live = server.detail();
    expect(live.agent.active_release_id).toBe(release?.id ?? "");
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`GET ${path}`]: () =>
        json(200, {
          ...live,
          agent: { ...live.agent, status: "paused" },
        }),
    });
    const section = (
      await screen.findByRole("heading", { name: "켜기까지" })
    ).closest("section") as HTMLElement;
    expect(await within(section).findByText("할 일 있음")).toBeDefined();
    expect(within(section).queryByText("켜짐")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1 }).nextElementSibling?.textContent,
    ).toBe("일시정지");
    expect(
      within(section).getByText(
        "에이전트가 일시정지 상태라 새 세션이 이 에이전트를 쓰지 않습니다.",
      ),
    ).toBeDefined();
    expect(
      within(section).queryByRole("button", { name: "릴리스 탭으로" }),
    ).toBeNull();
    expect(section.textContent).not.toContain(
      "새 세션은 최신 버전으로 시작합니다",
    );
    const user = await setupUser();
    await user.click(screen.getByRole("tab", { name: "상세 설정" }));
    const summary = await screen.findByRole("region", {
      name: "에이전트 카드",
    });
    expect(
      within(summary).getByText(/일시정지 상태라 새 세션은 쓰지 않습니다/),
    ).toBeDefined();
    expect(within(summary).queryByText(/새 세션에 쓰이는/)).toBeNull();
  });

  for (const [status, label] of [
    ["paused", "일시정지"],
    ["archived", "보관됨"],
  ] as const) {
    test(`${label} 에이전트는 최신 version이 더 새로워도 새 세션이 활성 version으로 시작한다고 하지 않는다`, async () => {
      const server = agentServer();
      const path = `/v1/agents/${AGENT_ID}`;
      const first = server.detail().versions[0];
      await released(server);
      const live = server.detail();
      if (!first) throw new Error("fake agent has no version");
      const second = {
        ...first,
        id: "00000000-0000-4000-8000-000000000002",
        version_no: first.version_no + 1,
        created_at: new Date(
          Date.parse(first.created_at) + 60_000,
        ).toISOString(),
      };
      renderAt(DETAIL, {
        ...meOk,
        ...server.routes,
        [`GET ${path}`]: () =>
          json(200, {
            ...live,
            agent: { ...live.agent, status },
            versions: [...live.versions, second],
          }),
      });
      const section = (
        await screen.findByRole("heading", { name: "켜기까지" })
      ).closest("section") as HTMLElement;
      await waitFor(() =>
        expect(section.textContent).toContain(`${label} 상태라 새 세션이`),
      );
      expect(section.textContent).not.toContain("로 시작합니다");
    });
  }

  test("release만 만들고 켜지 않은 version은 배포하지 않았다고 하지 않는다", async () => {
    const server = agentServer();
    server.releases.push(releaseFixture(0));
    expect(server.detail().releases).toHaveLength(1);
    renderAt(`${DETAIL}?tab=card`, { ...meOk, ...server.routes });
    const summary = await screen.findByRole("region", {
      name: "에이전트 카드",
    });
    expect(
      await within(summary).findByText(/릴리스는 만들었지만 아직 켜지 않은/),
    ).toBeDefined();
    expect(within(summary).queryByText(/아직 릴리스를 만들지 않은/)).toBeNull();
  });

  test("version이 없는 에이전트도 카드 탭에 이름과 식별자를 보인다", async () => {
    const server = agentServer();
    const path = `/v1/agents/${AGENT_ID}`;
    renderAt(`${DETAIL}?tab=card`, {
      ...meOk,
      ...server.routes,
      [`GET ${path}`]: () => json(200, { ...server.detail(), versions: [] }),
    });
    const summary = await screen.findByRole("region", {
      name: "에이전트 카드",
    });
    await waitFor(() =>
      expect(
        within(summary).getByText("식별자", { selector: "dt" })
          .nextElementSibling?.textContent,
      ).toBe("billing"),
    );
    expect(within(summary).queryByText("역할", { selector: "dt" })).toBeNull();
  });

  test("릴리스가 없으면 머리의 새 세션 버튼이 꺼지고 이유를 읽어 주며 페이지에도 보인다", async () => {
    const { history } = renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const button = await screen.findByRole("button", {
      name: "이 에이전트로 새 세션",
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("활성 릴리스가 없어 세션을 시작할 수 없습니다");
    expect(
      screen
        .getAllByText(/활성 릴리스가 없어 세션을 시작할 수 없습니다/)
        .filter((node) => node.closest("[hidden]") === null),
    ).toHaveLength(1);
    await user.click(button);
    expect(history.location.pathname).toBe(DETAIL);
  });

  test("카드 탭은 카드를 읽기 전용으로 보이고 원문 JSON을 함께 둔다", async () => {
    renderAt(`${DETAIL}?tab=card`, {
      ...meOk,
      ...agentServer({ description: "결제 문의 담당" }).routes,
    });
    const summary = await screen.findByRole("region", {
      name: "에이전트 카드",
    });
    const value = (term: string) =>
      within(summary).getByText(term, { selector: "dt" }).nextElementSibling
        ?.textContent;
    await waitFor(() => expect(value("설명")).toBe("결제 문의 담당"));
    expect(value("에이전트 지시문")).toBe("없음");
    expect(
      within(summary).queryByText("이전 지시 사항 (적용된 적 없음)"),
    ).toBeNull();
    expect(value("식별자")).toBe("billing");
    expect(value("모델")).toBe("claude-sonnet-5");
    expect(value("쓸 수 있는 도구")).toBe(
      "릴리스할 때 프로필이 막지 않은 도구 전부",
    );
    expect(within(summary).queryByRole("textbox")).toBeNull();
    const raw = screen
      .getByRole("region", { name: "카드 원문" })
      .querySelector("pre");
    expect(JSON.parse(raw?.textContent ?? "").model).toBe("claude-sonnet-5");
  });

  test("카드 원문을 복사하면 버튼이 복사했다고 바뀌고, 실패하면 직접 복사하라고 한다", async () => {
    renderAt(`${DETAIL}?tab=card`, { ...meOk, ...agentServer().routes });
    const section = await screen.findByRole("region", { name: "카드 원문" });
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    let refuse = true;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (refuse) throw new Error("denied");
          written.push(text);
        },
      },
    });
    try {
      const button = within(section).getByRole("button", { name: "복사" });
      button.click();
      await within(section).findByText(
        "복사하지 못했습니다. 원문을 직접 선택해 복사하세요.",
      );
      expect(button.textContent).toBe("복사");

      refuse = false;
      button.click();
      await waitFor(() => expect(button.textContent).toBe("복사했습니다"));
      expect(written).toEqual([
        section.querySelector("pre")?.textContent ?? "",
      ]);
      expect(
        within(section).queryByText(
          "복사하지 못했습니다. 원문을 직접 선택해 복사하세요.",
        ),
      ).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("관리하지 않는 구성원에게 관리자 탭은 담당 팀과 관리자 목록만 보이고 편집 행동이 없다", async () => {
    renderAt(`${DETAIL}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
    });
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText("담당 팀 미지정");
    await within(panel).findByText(/에이전트 관리자는/);
    expect(within(panel).queryByRole("button")).toBeNull();
    expect(within(panel).queryByRole("combobox")).toBeNull();
  });

  test("영어 화면도 탭 이름을 옮긴다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes }, "en");
    const list = await screen.findByRole("tablist", { name: "Agent details" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Overview", "Settings", "Release", "Admins", "Slack", "GitHub"]);
  });

  test("릴리스는 만든 시각으로 불리고, 이전 릴리스는 활성이었던 기간을 보인다", async () => {
    const server = agentServer();
    await released(server);
    const first = server.versions[0] as (typeof server.versions)[number];
    server.versions.push({
      ...first,
      id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      version_no: 2,
      content_sha256: "f".repeat(64),
      card: { ...first.card, agent_instructions: "환불도 맡는다." },
    });
    await released(server, server.versions[1]?.card);
    renderAt(`${DETAIL}?tab=release`, { ...meOk, ...server.routes });
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() =>
      expect(heading.nextElementSibling?.textContent).toBe("릴리스"),
    );
    const table = await screen.findByRole("table");
    expect(
      within(table).getAllByRole("row").slice(1).map(releaseCells),
    ).toEqual([
      ["2026-10-11_10:01:00 v2", "활성", "2026-10-11T02:01:00.000Z", "구성원"],
      [
        "2026-10-11_10:00:00 v1",
        "이전",
        "2026-10-11T02:00:00.000Z ~ 2026-10-11T02:01:00.000Z",
        "구성원",
      ],
    ]);
    // Each end reads relative, with the exact instant in its tooltip, in
    // the locale's period form.
    const previous = within(table).getAllByRole("row")[2] as HTMLElement;
    const period = within(previous).getAllByRole("cell")[2];
    const end = (iso: string) =>
      `${formatRelativeTime(iso, "ko")}${formatExactTime(iso, "ko")}`;
    expect(period?.textContent).toBe(
      `${end("2026-10-11T02:00:00.000Z")} ~ ${end("2026-10-11T02:01:00.000Z")}`,
    );
  });

  test("이름·활성화 시각이 없는 예전 API 응답이면 카드 버전과 —로 보이고 깨지지 않는다", async () => {
    const server = agentServer();
    await released(server);
    for (const release of server.releases as Record<string, unknown>[]) {
      delete release.label;
      delete release.activated_at;
      delete release.deactivated_at;
    }
    renderAt(
      `${DETAIL}?tab=release`,
      { ...meOk, ...server.routes },
      "ko",
      "warn",
    );
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() =>
      expect(heading.nextElementSibling?.textContent).toBe("릴리스"),
    );
    const table = await screen.findByRole("table");
    expect(
      within(table).getAllByRole("row").slice(1).map(releaseCells),
    ).toEqual([["버전 1 v1", "활성", "—", "구성원"]]);
  });

  test("배포 탭은 배포 기록 표 다음에 자격 연결을 두고, 만든 사람은 구성원 이름으로 쓴다", async () => {
    const server = agentServer();
    await released(server);
    renderAt(`${DETAIL}?tab=release`, {
      ...meOk,
      ...server.routes,
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [
              {
                user_id: USER_ID,
                email: "minho@acme.test",
                display_name: "이민호",
                role: "owner",
                disabled_at: null,
                created_at: "2026-10-01T00:00:00.000Z",
              },
            ],
            next_cursor: null,
          }),
        ),
    });
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["버전", "상태", "활성화 시각", "만든 사람", "동작"]);
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    // The column and the version cell's narrow-only list both say it.
    await within(row).findAllByText("이민호");
    expect(releaseCells(row)).toEqual([
      "2026-10-11_10:00:00 v1",
      "활성",
      "2026-10-11T02:00:00.000Z",
      "이민호",
    ]);
    expect(row.textContent).toContain("활성");
    // A narrow table keeps the version and action columns; the version
    // cell shows the status and lists every column it drops, the
    // activation as a time.
    expect(table.dataset.narrowAt).toBe("860");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .filter((head) => head.dataset.hideNarrow !== "true")
        .map((head) => head.textContent),
    ).toEqual(["버전", "동작"]);
    expect(table.style.getPropertyValue("--grid-table-narrow-columns")).toBe(
      "minmax(0,1fr) 120px",
    );
    expect(
      within(row)
        .getAllByRole("cell")
        .filter(
          (cell) =>
            !cell.className.includes("[@container(max-width:860px)]:hidden"),
        ),
    ).toHaveLength(2);
    const narrowStatus = row.querySelector(
      "span[class*='[@container(max-width:860px)]:flex']",
    );
    expect(narrowStatus?.className).toContain("hidden");
    expect(narrowStatus?.textContent).toBe("활성");
    const narrow = row.querySelector("dl");
    expect(narrow?.className).toContain("hidden");
    expect(narrow?.className).toContain("[@container(max-width:860px)]:flex");
    expect(
      [...(narrow?.querySelectorAll("dt") ?? [])].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]),
    ).toEqual([
      ["활성화 시각", expect.any(String)],
      ["만든 사람", "이민호"],
    ]);
    expect(narrow?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-11T02:00:00.000Z",
    );
    expect(
      within(visiblePanel())
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["릴리스", "자격 증명 연결"]);
  });

  test("구성원 목록은 배포 탭을 열 때 읽고, 다른 탭을 볼 때는 읽지 않는다", async () => {
    const server = agentServer();
    await released(server);
    const { api } = renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      "GET /v1/members": () =>
        json(200, memberPage({ items: [], next_cursor: null })),
    });
    const user = await setupUser();
    const memberReads = () =>
      api.calls.filter((c) => c.path === "/v1/members").length;
    await user.click(await screen.findByRole("tab", { name: "상세 설정" }));
    expect(memberReads()).toBe(0);
    await user.click(screen.getByRole("tab", { name: "릴리스" }));
    await waitFor(() => expect(memberReads()).toBe(1));
  });

  test("구성원 목록을 못 읽으면 만든 사람을 '구성원'으로 쓴다", async () => {
    const server = agentServer();
    await released(server);
    renderAt(`${DETAIL}?tab=release`, {
      ...meOk,
      ...server.routes,
      "GET /v1/members": () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    await waitFor(() => expect(row.textContent).toContain("구성원"));
  });

  test("release가 없으면 빈 상태만 보이고 릴리스를 만드는 단추는 없다", async () => {
    renderAt(`${DETAIL}?tab=release`, { ...meOk, ...agentServer().routes });
    expect(await screen.findByText("아직 릴리스가 없습니다.")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "새 릴리스" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/** One release of version 1, activated, as the server would hold it. */
async function released(
  server: ReturnType<typeof agentServer>,
  card = server.versions.at(-1)?.card,
) {
  await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
    new Request("https://console.test/", {
      method: "PATCH",
      body: JSON.stringify({ card, runtime_profile_id: "claude-coding-local" }),
    }),
  );
}
