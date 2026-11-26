import { beforeEach, describe, expect, test } from "bun:test";
import type { ApiError } from "@werft-ai/client";
import type { AgentCard, AgentDetail } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import type { Locale } from "../i18n/i18n.tsx";
import {
  AGENT_ID,
  agentServer,
  CARD,
  CONNECTIONS,
  seedRelease as releaseFixture,
  TEAM_ID,
} from "../test-support/fake-agents.ts";

const DESCRIPTION = "결제 문의 담당";
/** What an earlier card held: never applied, shown to be copied in. */
const EARLIER = "결제 문의에 답한다.";

import {
  apiError,
  json,
  keys,
  me,
  memberMe,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, render, renderAt, screen, waitFor, within } = await appHarness();
// After the DOM exists: Radix picks a no-op layout effect when loaded before
// it, and its dialogs then never reach the page.
const { agentRefusal } = await import("../components/agent-refusal.ts");
const { translate } = await import("../i18n/i18n.tsx");
const { createBrowserHistory } = await import("@tanstack/react-router");
const { App } = await import("../app.tsx");
const { createServices } = await import("../services.tsx");
const { fakeApi } = await import("../test-support/fake-api.ts");
const { WAITING_SESSIONS } = await import("../test-support/render-app.tsx");

/**
 * The app on a browser history over the window's own history, so back is a
 * popstate and history.state survives; a reload is a new app reading it.
 */
function openInBrowser(path: string, routes: Parameters<typeof fakeApi>[0]) {
  window.history.replaceState(null, "", path);
  const api = fakeApi({
    [WAITING_SESSIONS]: () => json(200, { items: [], next_cursor: null }),
    ...routes,
  });
  const services = createServices({
    baseUrl: "https://console.test",
    fetch: api.fetch,
    validate: "strict",
    leave: () => {},
  });
  const open = () => {
    const history = createBrowserHistory();
    const view = render(
      <App services={services} history={history} locale="ko" />,
    );
    return () => {
      view.unmount();
      history.destroy();
    };
  };
  let close = open();
  return {
    api,
    reload: () => {
      close();
      close = open();
    },
  };
}

const stepsInState = () =>
  (
    (window.history.state as Record<string, unknown> | null)?.[
      "new-agent.histories"
    ] as { step: string }[] | undefined
  )?.map(({ step }) => step);
type User = Awaited<ReturnType<typeof setupUser>>;
type Api = ReturnType<typeof renderAt>["api"];

const currentStep = () =>
  screen
    .getByRole("navigation", { name: "에이전트 만들기 단계" })
    .querySelector('[aria-current="step"]')?.textContent;
const STEP_NO = {
  이름: 1,
  "하는 일": 2,
  "미리 써 보기": 3,
  "채널 연결": 4,
} as const;
const atStep = (label: keyof typeof STEP_NO) =>
  waitFor(() => expect(currentStep()).toBe(`${STEP_NO[label]}${label}`));
const posted = (api: Api, path: string) =>
  api.calls.find((c) => c.method === "POST" && c.path === path)?.body;

async function toJobStep(user: User) {
  await user.type(await screen.findByLabelText("이름"), "결제 담당");
  await user.type(screen.getByLabelText("식별자"), "billing");
  await user.click(screen.getByRole("button", { name: "다음" }));
  await atStep("하는 일");
}

const pickModel = async (user: User) =>
  user.selectOptions(await screen.findByLabelText("모델"), CARD.model);

async function fillJob(user: User) {
  await pickModel(user);
  await user.click(
    screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
  );
}

const connectionSelect = async () =>
  (await screen.findByLabelText("모델 연결")) as HTMLSelectElement;

const meOk = { "GET /v1/auth/me": () => json(200, me()) };

const PREVIEW_SESSION = "0a000000-0000-4000-8000-000000000001";

/** A preview session the first message starts; its stream never opens. */
function previewSession() {
  const at = "2026-11-02T00:00:00.000Z";
  const detail = {
    id: PREVIEW_SESSION,
    revision: 1,
    admission_state: "active",
    status: "idle",
    runtime: null,
    repository_id: null,
    current_turn_id: "1",
    queued_turn_count: 0,
    model: null,
    last_event_at: at,
    created_at: at,
    updated_at: at,
    execution: null,
    checkpoint_revision: null,
    pending_request_count: 0,
    attention: null,
    preview: true,
    agent: {
      id: AGENT_ID,
      name: "결제 담당",
      release_version_no: 1,
      release_label: null,
      release_is_active: false,
    },
    durability: {
      last_transcript_persisted_at: at,
      checkpoint_committed_at: at,
      checkpoint_revision: null,
      last_completed_turn_id: "1",
      last_checkpointed_turn_id: null,
      checkpoint_pending_reason: null,
      checkpoint_fallback_revision: null,
      context_reset_turn_id: null,
    },
  };
  return {
    "POST /v1/sessions": () =>
      json(201, {
        session_id: PREVIEW_SESSION,
        turn_id: "1",
        receipt_id: crypto.randomUUID(),
        receipt_status: "accepted",
        status: "queued",
      }),
    [`GET /v1/sessions/${PREVIEW_SESSION}`]: () => json(200, detail),
    [`GET /v1/sessions/${PREVIEW_SESSION}/turns`]: () =>
      json(200, { items: [], next_cursor: null }),
    [`GET /v1/sessions/${PREVIEW_SESSION}/pending-requests`]: () =>
      json(200, { answerable: true, items: [] }),
    [`GET /v1/sessions/${PREVIEW_SESSION}/events`]: (request: Request) =>
      new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
    [`POST /v1/sessions/${PREVIEW_SESSION}/messages`]: () =>
      json(202, {
        turn_id: "2",
        receipt_id: crypto.randomUUID(),
        receipt_status: "accepted",
      }),
  };
}
const DETAIL = `/agents/${AGENT_ID}`;
const CARD_TAB = `${DETAIL}?tab=card`;

// The card tab reads first; its form opens behind this button.
async function openCardEditor(user: User) {
  await user.click(
    await screen.findByRole("button", {
      name: "상세 설정 편집",
      hidden: true,
    }),
  );
}
const RELEASE_TAB = `${DETAIL}?tab=release`;

const CONNECTION = "anthropic-main";
const showTab = async (user: User, name: string) =>
  user.click(await screen.findByRole("tab", { name }));
const showList = async (user: User, name: string) =>
  user.click(await screen.findByRole("button", { name }));
// The state (a dot and a word) of the row an agent's name links from.
const stateOf = (link: HTMLElement) =>
  link
    .closest("[role=row]")
    ?.querySelector("[data-slot=status-text][data-state]");

const SECOND_VERSION = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

async function releasedTwice(server: ReturnType<typeof agentServer>) {
  await seedRelease(server);
  const first = server.versions[0] as (typeof server.versions)[number];
  server.versions.push({
    ...first,
    id: SECOND_VERSION,
    version_no: 2,
    content_sha256: "f".repeat(64),
    card: { ...CARD, instructions: "환불도 맡는다." },
  });
  await seedRelease(server);
}

async function seedRelease(
  server: ReturnType<typeof agentServer>,
  options: { card?: typeof CARD; connection?: string } = {},
) {
  await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
    new Request("https://console.test/", {
      method: "PATCH",
      body: JSON.stringify({
        card: options.card ?? server.versions.at(-1)?.card,
        connection_id: options.connection ?? CONNECTION,
      }),
    }),
  );
}

describe("agentRefusal", () => {
  const refusal = (locale: Locale, code: string, message: string) =>
    agentRefusal(
      (key, vars) => translate(locale, key, vars),
      { code, message, status: 422 } as ApiError,
      "owner",
    );

  test("모델 불일치는 공백이 든 모델 이름도 원문 없이 옮긴다", () => {
    const message =
      "card.model: model custom model is not a model of connection anthropic-main";
    expect(refusal("ko", "UNSUPPORTED_CAPABILITY", message)).toBe(
      "카드 모델 custom model을(를) 연결 anthropic-main이(가) 제공하지 않아 릴리스를 만들지 못했습니다. 이 모델을 제공하는 연결을 고르거나 모델을 바꾸세요.",
    );
    expect(refusal("en", "UNSUPPORTED_CAPABILITY", message)).toBe(
      "Connection anthropic-main does not offer the card's model custom model, so no release was created. Choose a connection that offers it, or change the model.",
    );
  });

  test("다른 거부는 지금처럼 이유 뒤에 서버 설명을 붙인다", () => {
    const tools = "card.capabilities.tools: WebFetch is not a known tool";
    expect(refusal("ko", "UNSUPPORTED_CAPABILITY", tools)).toBe(
      `${translate("ko", "error.UNSUPPORTED_CAPABILITY")} ${tools}`,
    );
    expect(refusal("ko", "BAD_REQUEST", "card.model: required")).toBe(
      `${translate("ko", "error.BAD_REQUEST")} card.model: required`,
    );
  });
});

describe("에이전트 목록", () => {
  beforeEach(() => localStorage.clear());

  test("표는 이름·엔진·상태·연결 채널·실행 중인 세션을 보이고, 좁으면 같은 정보를 행마다 카드로 보인다", async () => {
    const base = agentServer().detail().agent;
    const summary = {
      version: {
        version_no: 1,
        role: null,
        instructions: null,
        mcp_servers: [],
        credential_refs: [],
      },
      connection_id: null,
      release_label: null,
      release_model: null,
      bound_credential_refs: [],
      admins: [],
      needs_input_count: 0,
      slack_action: null,
    };
    const agents = [
      {
        ...base,
        summary: {
          ...summary,
          running_count: 2,
          engine: "claude_agent_sdk" as const,
          channels: ["slack" as const, "github" as const],
        },
      },
      {
        ...base,
        id: crypto.randomUUID(),
        slug: "drafts",
        name: "초안 담당",
        summary: { ...summary, running_count: 0, engine: null, channels: [] },
      },
    ];
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: agents, next_cursor: null }),
    });
    const table = await screen.findByRole("table", { name: "에이전트" });
    expect(table.dataset.narrowAt).toBe("640");
    expect(table.dataset.narrowCards).toBe("true");
    // No column drops out; a card shows every one.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((head) => [head.textContent, head.dataset.hideNarrow ?? null]),
    ).toEqual([
      ["이름", null],
      ["엔진", null],
      ["상태", null],
      ["연결 채널", null],
      ["실행 중인 세션", null],
    ]);
    // Text columns start; the running count ends, header and cells alike.
    for (const row of within(table).getAllByRole("row"))
      expect(
        [...row.querySelectorAll("[role=columnheader], [role=cell]")].map(
          (cell) => cell.className.includes("justify-end"),
        ),
      ).toEqual([false, false, false, false, true]);
    const cellsOf = async (name: string) =>
      within(
        (await within(table).findByRole("link", { name })).closest(
          "[role=row]",
        ) as HTMLElement,
      ).getAllByRole("cell");
    const [, engine, , channels, running] = await cellsOf("결제 담당");
    // On a card each value follows its column's name, hidden from screen
    // readers, which have the column header.
    expect(
      [engine, channels, running].map((cell) => {
        const label = cell?.querySelector("[aria-hidden=true]");
        return label?.parentElement === cell ? label?.textContent : null;
      }),
    ).toEqual(["엔진", "연결 채널", "실행 중인 세션"]);
    expect(within(engine as HTMLElement).getByText("Claude")).toBeDefined();
    expect(
      within(channels as HTMLElement)
        .getAllByRole("img")
        .map((mark) => mark.getAttribute("aria-label")),
    ).toEqual(["Slack", "GitHub"]);
    expect(running?.textContent).toBe("실행 중인 세션2");
    // Without a release, a channel or a running session, each is a dash a
    // screen reader hears as "없음".
    const [, noEngine, , noChannels, noRunning] = await cellsOf("초안 담당");
    expect(
      [noEngine, noChannels, noRunning].map((cell) => cell?.textContent),
    ).toEqual(["엔진—없음", "연결 채널—없음", "실행 중인 세션—없음"]);
  });

  test("긴 이름과 식별자는 한 줄에서 말줄임으로 자르고, 전체는 title에 둔다", async () => {
    const long = "결제와 환불과 정산 문의를 모두 맡는 아주 긴 이름의 에이전트";
    const slug = "billing-refunds-settlements-and-everything-else-agent";
    const base = agentServer().detail().agent;
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () =>
        json(200, {
          items: [{ ...base, name: long, slug }],
          next_cursor: null,
        }),
    });
    const link = await screen.findByRole("link", { name: long });
    await waitFor(() => expect(link.closest("[role=row]")).not.toBeNull());
    expect(link.getAttribute("title")).toBe(long);
    expect(link.className).toContain("truncate");
    expect(link.className).toContain("min-w-0");
    const code = (link.closest("[role=row]") as HTMLElement).querySelector(
      `code[title="${slug}"]`,
    );
    expect(code?.className).toContain("truncate");
    expect(code?.textContent).toBe(`식별자 ${slug}`);
  });

  test("목록은 보기 전환 없이 표로 보이고, 행 전체가 상세로 잇는다", async () => {
    const server = agentServer();
    renderAt("/agents", { ...meOk, ...server.routes });
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(screen.queryByRole("button", { name: "카드" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "표" }) === null).toBe(true);
    expect(link.getAttribute("href")).toBe(DETAIL);
    const row = link.closest("[role=row]") as HTMLElement;
    expect(within(row).getAllByRole("link")).toHaveLength(1);
    expect(row.className).toContain("cursor-pointer");
    expect(link.className).toContain("after:inset-0");
    expect(within(row).getByText("미게시")).toBeDefined();
    expect(row.textContent).toContain("식별자 billing");
  });

  test("배지는 미게시·릴리스·일시 정지·보관됨을 이름만으로 서로 다르게 보인다", async () => {
    const base = agentServer().detail().agent;
    const agent = (
      name: string,
      status: "active" | "paused" | "archived",
      released: boolean,
    ) => ({
      ...base,
      id: crypto.randomUUID(),
      slug: name,
      name,
      status,
      active_release_id: released ? crypto.randomUUID() : null,
      activation_revision: released ? 0 : -1,
    });
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () =>
        json(200, {
          items: [
            agent("draft", "active", false),
            agent("live", "active", true),
            agent("held", "paused", true),
            agent("old", "archived", false),
          ],
          next_cursor: null,
        }),
    });
    const states = () =>
      ["draft", "live", "held", "old"].map((name) => {
        const state = stateOf(screen.getByRole("link", { name }));
        return [state?.textContent, state?.getAttribute("data-state")];
      });
    await screen.findByRole("link", { name: "draft" });
    // A row says a released agent's state as its status, "활성".
    await waitFor(() =>
      expect(states()).toEqual([
        ["미게시", "draft"],
        ["활성", "active"],
        ["일시 정지", "paused"],
        ["보관됨", "archived"],
      ]),
    );
    // Only the archived row takes the inactive tone; its badge still says so.
    expect(
      ["draft", "live", "held", "old"].map((name) =>
        screen
          .getByRole("link", { name })
          .closest("[role=row]")
          ?.hasAttribute("data-inactive"),
      ),
    ).toEqual([false, false, false, true]);
  });

  test("켜졌는지는 status가 아니라 activation으로 읽는다", async () => {
    const base = agentServer().detail().agent;
    const row = (
      name: string,
      activation: "inactive" | "draft" | "active",
    ) => ({
      ...base,
      id: crypto.randomUUID(),
      slug: name,
      name,
      status: "active" as const,
      // Set either way, so only activation tells the two apart.
      active_release_id: crypto.randomUUID(),
      activation_revision: 0,
      activation,
    });
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () =>
        json(200, {
          items: [
            row("held", "inactive"),
            row("off", "draft"),
            row("on", "active"),
          ],
          next_cursor: null,
        }),
    });
    await screen.findByRole("link", { name: "off" });
    await waitFor(() =>
      expect(
        ["held", "off", "on"].map(
          (name) =>
            stateOf(screen.getByRole("link", { name }))?.getAttribute(
              "data-state",
            ) ?? null,
        ),
      ).toEqual(["paused", "draft", "active"]),
    );
  });

  test("구성원은 전체 목록 대신 안내를 보고, 새 에이전트는 만들 수 있다", async () => {
    const { history } = renderAt("/agents", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/agents": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText(/전체 에이전트 목록은 오너와 어드민만 봅니다/),
    ).toBeDefined();
    // Whoever may create is offered it once, at the head of the list.
    const [button, ...others] = screen.getAllByRole("button", {
      name: "새 에이전트",
    });
    expect(others).toEqual([]);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("agent.manage");
    expect(document.body.textContent).not.toContain("does not hold");
    const user = await setupUser();
    await user.click(button as HTMLElement);
    await waitFor(() => expect(history.location.pathname).toBe("/agents/new"));
  });

  test("agent.create가 없으면 새 에이전트 버튼을 끈 채 말로 된 이유를 적는다", async () => {
    const none = { ...memberMe(), permissions: [] };
    const { history } = renderAt("/agents", {
      "GET /v1/auth/me": () => json(200, none),
      "GET /v1/agents": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    const user = await setupUser();
    const button = await screen.findByRole("button", { name: "새 에이전트" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await user.click(button);
    expect(history.location.pathname).toBe("/agents");
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("에이전트 만들기 권한이 있어야 할 수 있습니다. 지금 역할: 멤버.");
  });

  test("영어 화면도 권한 식별자와 서버 문구 없이 안내한다", async () => {
    renderAt(
      "/agents",
      {
        "GET /v1/auth/me": () => json(200, memberMe()),
        "GET /v1/agents": () =>
          apiError(
            403,
            "FORBIDDEN",
            "This principal does not hold agent.manage",
          ),
        "GET /v1/administered-agents": () => json(200, { items: [] }),
      },
      "en",
    );
    expect(
      await screen.findByText(
        /Only owners and admins can see the full agent list/,
      ),
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("agent.manage");
    expect(document.body.textContent).not.toContain("does not hold");
  });

  test("목록 위에 세션 요약 줄을 두지 않고, 개수는 상태 탭에만 둔다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents/counts": () =>
        json(200, {
          counts: {
            all: 7,
            administered: 2,
            active: 0,
            draft: 7,
            inactive: 0,
            ownerless: 0,
          },
        }),
    });
    await screen.findByRole("table", { name: "에이전트" });
    const tabs = screen.getByRole("group", { name: "보여 줄 에이전트" });
    expect(
      within(tabs)
        .getAllByRole("button")
        .map((tab) => tab.textContent),
    ).toEqual(["전체 7", "관리하는 에이전트 2"]);
    expect(screen.queryByRole("list", { name: "세션 요약" })).toBeNull();
    expect(document.body.textContent).not.toContain("예상 비용");
    // Nothing on this screen reads the sessions' counts any more.
    expect(api.calls.some((call) => call.path === "/v1/sessions/counts")).toBe(
      false,
    );
  });

  test("에이전트 목록 응답이 비공개 채널을 확인 중이면 한 번 말한다", async () => {
    const server = agentServer();
    const list = server.routes["GET /v1/agents"];
    if (!list) throw new Error("agentServer has no GET /v1/agents");
    renderAt("/agents", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents": async (request) =>
        json(200, {
          ...(await (await list(request)).json()),
          private_channels_pending: true,
        }),
    });
    await screen.findByRole("table", { name: "에이전트" });
    expect(await screen.findAllByText("비공개 채널 확인 중…")).toHaveLength(1);
  });
});

describe("에이전트 목록 탭과 검색", () => {
  beforeEach(() => localStorage.clear());

  test("에이전트가 없어도 탭은 남고 전체 탭이 비었다고 알린다", async () => {
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(await screen.findByRole("button", { name: "전체 0" })).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "관리하는 에이전트 0" }),
    ).toBeDefined();
    expect(screen.getByText("아직 에이전트가 없습니다.")).toBeDefined();
  });

  test("관리하는 에이전트 탭은 개수와 그 목록만 보인다", async () => {
    const server = agentServer();
    const other = {
      ...server.detail().agent,
      id: crypto.randomUUID(),
      slug: "other",
      name: "다른 에이전트",
    };
    renderAt("/agents", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents": () =>
        json(200, { items: [server.detail().agent, other], next_cursor: null }),
      "GET /v1/administered-agents": () =>
        json(200, { items: [server.detail().agent] }),
    });
    expect(
      (await screen.findByRole("button", { name: "전체 2" })).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    const user = await setupUser();
    await showList(user, "관리하는 에이전트 1");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "다른 에이전트" })).toBeNull(),
    );
    expect(screen.getByRole("link", { name: "결제 담당" })).toBeDefined();
  });

  test("검색은 이름·식별자로 목록만 좁히고 개수는 서버 값 그대로 둔다", async () => {
    // The page has other live regions (the waiting bell); this one is the
    // list's own.
    const results = () =>
      document.querySelector("main output") as HTMLOutputElement;
    const server = agentServer();
    const other = {
      ...server.detail().agent,
      id: crypto.randomUUID(),
      slug: "refund-desk",
      name: "다른 에이전트",
    };
    // The server matches q; the screen only sends it.
    const { api } = renderAt("/agents", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents": (request) => {
        const q = new URL(request.url).searchParams.get("q")?.toLowerCase();
        const items = [server.detail().agent, other].filter(
          (agent) =>
            !q ||
            agent.name.toLowerCase().includes(q) ||
            agent.slug.includes(q),
        );
        return json(200, { items, next_cursor: null });
      },
      "GET /v1/administered-agents": () => json(200, { items: [other] }),
    });
    const all = await screen.findByRole("button", { name: "전체 2" });
    const search = screen.getByRole("searchbox", {
      name: "이름이나 식별자로 찾기",
    });
    // Categories, then search: the toolbar's reading order.
    expect(
      all.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const user = await setupUser();
    // Empty until someone types, then the match count for a screen reader.
    expect(results().textContent).toBe("");
    await user.type(search, "  REFUND ");
    // Typing pauses, then the server answers: longer than waitFor's default.
    await waitFor(() => expect(results().textContent).toBe("1개 표시"), {
      timeout: 3000,
    });
    expect(screen.queryByRole("link", { name: "결제 담당" }) === null).toBe(
      true,
    );
    expect(screen.getByRole("link", { name: "다른 에이전트" })).toBeDefined();
    expect(screen.getByRole("button", { name: "전체 2" })).toBeDefined();
    expect(
      api.calls
        .filter((c) => c.path === "/v1/agents")
        .map((c) => new URLSearchParams(c.search).get("q")),
    ).toEqual([null, "REFUND"]);

    const region = results();
    await showList(user, "관리하는 에이전트 1");
    expect(
      await screen.findByRole("link", { name: "다른 에이전트" }),
    ).toBeDefined();
    // The same live region across categories, so the new count is heard.
    expect(results() === region).toBe(true);
    expect(results().textContent).toBe("1개 표시");

    await user.clear(search);
    await user.type(search, "없는 이름");
    expect(
      await screen.findByText("검색어에 맞는 에이전트가 없습니다"),
    ).toBeDefined();
    expect(results().textContent).toBe("0개 표시");
    await user.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect(
      await screen.findByRole("link", { name: "다른 에이전트" }),
    ).toBeDefined();
    expect((search as HTMLInputElement).value).toBe("");
    expect(document.activeElement === search).toBe(true);
  });

  /** The agent as GET /v1/agents?include=summary lists it. */
  function withSummary(
    agent: ReturnType<ReturnType<typeof agentServer>["detail"]>["agent"],
    {
      running_count = 3,
      channels = ["slack", "github"] as ("slack" | "github")[],
    } = {},
  ) {
    return {
      ...agent,
      summary: {
        version: {
          version_no: 1,
          role: null,
          instructions: null,
          mcp_servers: [],
          credential_refs: [],
        },
        connection_id: null,
        release_label: null,
        release_model: null,
        bound_credential_refs: [],
        admins: [],
        needs_input_count: 0,
        slack_action: null,
        running_count,
        engine: "claude_agent_sdk" as const,
        channels,
      },
    };
  }

  test("관리하는 에이전트 탭도 전체 탭과 같은 엔진·연결 채널·실행 중인 세션을 보인다", async () => {
    const base = agentServer().detail().agent;
    const second = {
      ...base,
      id: crypto.randomUUID(),
      slug: "second",
      name: "두 번째",
    };
    const { api } = renderAt("/agents", {
      ...meOk,
      // The list API's order differs from the administered list's.
      "GET /v1/agents": () =>
        json(200, {
          // Different summaries, so a merge by position instead of id shows.
          items: [
            withSummary(second, { running_count: 1, channels: ["github"] }),
            withSummary(base),
          ],
          next_cursor: null,
        }),
      // As the server answers it: the agents alone, no summary.
      "GET /v1/administered-agents": () => json(200, { items: [base, second] }),
    });
    const names = () =>
      [
        ...(screen
          .getByRole("table", { name: "에이전트" })
          .querySelectorAll("[role=row] a[href^='/agents/']") ?? []),
      ].map((link) => link.textContent);
    const columns = async (name = "결제 담당") => {
      const link = await screen.findByRole("link", { name });
      const [, engine, , channels, running] = within(
        link.closest("[role=row]") as HTMLElement,
      ).getAllByRole("cell");
      return [
        engine?.querySelector("[data-engine]")?.textContent,
        [...(channels?.querySelectorAll("[data-channel]") ?? [])].map((mark) =>
          mark.getAttribute("aria-label"),
        ),
        running?.textContent,
      ];
    };
    const all = await columns();
    expect(all).toEqual(["Claude", ["Slack", "GitHub"], "실행 중인 세션3"]);
    const allSecond = await columns("두 번째");
    expect(allSecond).toEqual(["Claude", ["GitHub"], "실행 중인 세션1"]);
    await showList(await setupUser(), "관리하는 에이전트 2");
    await waitFor(async () => expect(await columns()).toEqual(all));
    expect(await columns("두 번째")).toEqual(allSecond);
    // In the administered list's order, whatever order the summaries came in.
    expect(names()).toEqual(["결제 담당", "두 번째"]);
    // Read by id with summaries, as the all tab's items carry them.
    const byId = api.calls.find(
      (call) =>
        call.path === "/v1/agents" &&
        new URLSearchParams(call.search).has("ids"),
    );
    const sent = new URLSearchParams(byId?.search);
    expect(sent.get("ids")?.split(",").sort()).toEqual(
      [base.id, second.id].sort(),
    );
    expect(sent.get("include")).toBe("summary");
  });

  test("관리하는 에이전트의 요약을 읽지 못하면 빈 값 대신 실패와 다시 시도를 보인다", async () => {
    const base = agentServer().detail().agent;
    let failing = true;
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": (request) =>
        new URL(request.url).searchParams.has("ids") && failing
          ? apiError(500, "INTERNAL", "down")
          : json(200, { items: [withSummary(base)], next_cursor: null }),
      "GET /v1/administered-agents": () => json(200, { items: [base] }),
    });
    const user = await setupUser();
    await showList(user, "관리하는 에이전트 1");
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.queryByRole("link", { name: "결제 담당" }) === null).toBe(
      true,
    );
    failing = false;
    await user.click(retry);
    const row = (
      await screen.findByRole("link", { name: "결제 담당" })
    ).closest("[role=row]");
    // Recovered with the summary, not dashes.
    expect(row?.querySelector("[data-engine]")?.textContent).toBe("Claude");
  });

  test("관리하는 에이전트가 서버 상한만큼 오면 일부만 보인다고 알리고, 개수는 서버가 센 값이다", async () => {
    const base = agentServer().detail().agent;
    const items = Array.from({ length: 200 }, (_, n) => ({
      ...base,
      id: crypto.randomUUID(),
      slug: `agent-${n}`,
      name: `에이전트 ${n}`,
    }));
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: [base], next_cursor: null }),
      "GET /v1/administered-agents": () => json(200, { items }),
      "GET /v1/agents/counts": () =>
        json(200, {
          counts: {
            all: 1,
            administered: 250,
            active: 0,
            draft: 1,
            inactive: 0,
            ownerless: 0,
          },
        }),
    });
    await showList(await setupUser(), "관리하는 에이전트 250");
    expect(await screen.findByText("처음 200개만 보입니다.")).toBeDefined();
  });
});

describe("에이전트 목록 페이지", () => {
  beforeEach(() => localStorage.clear());

  const base = agentServer().detail().agent;
  /** Agents named "에이전트 1".."에이전트 count", as the list API holds them. */
  const many = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
      slug: `agent-${n + 1}`,
      name: `에이전트 ${n + 1}`,
    }));
  /** GET /v1/agents over `agents`: q, ids, limit (default 50) and cursor. */
  const agentsRoute =
    (agents: ReturnType<typeof many>) => (request: Request) => {
      const params = new URL(request.url).searchParams;
      const ids = params.get("ids")?.split(",");
      const q = params.get("q");
      const matched = agents.filter(
        (agent) =>
          (!ids || ids.includes(agent.id)) && (!q || agent.name.includes(q)),
      );
      const limit = Number(params.get("limit") ?? 50);
      const from = Number(params.get("cursor")?.slice(1) ?? 0);
      const to = from + limit;
      return json(200, {
        items: matched.slice(from, to),
        next_cursor: to < matched.length ? `c${to}` : null,
      });
    };
  const counted = (all: number, administered = 0, ownerless = 0) => ({
    "GET /v1/agents/counts": () =>
      json(200, {
        counts: {
          all,
          administered,
          active: 0,
          draft: all,
          inactive: 0,
          ownerless,
        },
      }),
  });
  const listedNames = () =>
    [
      ...screen
        .getByRole("table", { name: "에이전트" })
        .querySelectorAll("[role=row] a[href^='/agents/']"),
    ].map((link) => link.textContent);
  const nav = () => screen.queryByRole("navigation", { name: "페이지 이동" });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, n) => `에이전트 ${from + n}`);

  test("전체 탭은 한 페이지에 15개씩 읽어 보이고, 이전·다음과 주소의 page로 오간다", async () => {
    const user = await setupUser();
    const { api, history } = renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": agentsRoute(many(40)),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...counted(40),
    });
    await screen.findByRole("link", { name: "에이전트 15" });
    expect(listedNames()).toEqual(range(1, 15));
    expect(screen.getByText("1–15 / 40")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "1페이지" })
        .getAttribute("aria-current"),
    ).toBe("page");

    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: "에이전트 30" });
    expect(listedNames()).toEqual(range(16, 30));
    expect(history.location.search).toBe("?page=2");
    expect(screen.getByText("16–30 / 40")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "3페이지" }));
    await screen.findByRole("link", { name: "에이전트 40" });
    expect(listedNames()).toEqual(range(31, 40));
    expect(history.location.search).toBe("?page=3");

    await user.click(screen.getByRole("button", { name: "이전 페이지" }));
    await screen.findByRole("link", { name: "에이전트 16" });
    expect(history.location.search).toBe("?page=2");
    // Each page is its own history entry.
    act(() => history.back());
    await screen.findByRole("link", { name: "에이전트 31" });
    expect(history.location.search).toBe("?page=3");

    const reads = api.calls.filter((call) => call.path === "/v1/agents");
    expect(
      reads.every(
        (call) => new URLSearchParams(call.search).get("limit") === "15",
      ),
    ).toBe(true);
    expect(
      reads.map((call) => new URLSearchParams(call.search).get("cursor")),
    ).toEqual([null, "c15", "c30"]);
  });

  test("한 페이지에 다 들어가면 페이지 이동을 보이지 않는다", async () => {
    const { api } = renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": agentsRoute(many(15)),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...counted(15),
    });
    await screen.findByRole("link", { name: "에이전트 15" });
    expect(listedNames()).toHaveLength(15);
    expect(nav()).toBeNull();
    // Read at the page size: fifteen rows, and nothing past them.
    expect(
      api.calls
        .filter((call) => call.path === "/v1/agents")
        .map((call) => call.search),
    ).toEqual(["?include=summary&limit=15"]);
  });

  test("주소의 page가 끝을 넘으면 마지막 페이지로 옮긴다", async () => {
    const { history } = renderAt("/agents?page=9", {
      ...meOk,
      "GET /v1/agents": agentsRoute(many(20)),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...counted(20),
    });
    await screen.findByRole("link", { name: "에이전트 20" });
    expect(listedNames()).toEqual(range(16, 20));
    await waitFor(() => expect(history.location.search).toBe("?page=2"));
  });

  test("검색이나 탭을 바꾸면 첫 페이지로 돌아간다", async () => {
    const user = await setupUser();
    const agents = many(40);
    const { history } = renderAt("/agents?page=2", {
      ...meOk,
      "GET /v1/agents": agentsRoute(agents),
      "GET /v1/administered-agents": () =>
        json(200, { items: agents.slice(0, 20) }),
      ...counted(40, 20),
    });
    await screen.findByRole("link", { name: "에이전트 16" });
    await user.type(
      screen.getByRole("searchbox", { name: "이름이나 식별자로 찾기" }),
      "에이전트 1",
    );
    await waitFor(() => expect(history.location.search).toBe(""));
    // "에이전트 1" and 10–19: eleven, so one page and no page links.
    await waitFor(
      () => expect(listedNames()).toEqual(["에이전트 1", ...range(10, 19)]),
      { timeout: 3000 },
    );
    expect(nav()).toBeNull();

    await user.clear(
      screen.getByRole("searchbox", { name: "이름이나 식별자로 찾기" }),
    );
    await screen.findByRole("link", { name: "에이전트 15" }, { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: "에이전트 30" });
    expect(history.location.search).toBe("?page=2");
    await showList(user, "관리하는 에이전트 20");
    await waitFor(() => expect(history.location.search).toBe(""));
    await waitFor(() => expect(listedNames()).toEqual(range(1, 15)));
  });

  test("관리하는 에이전트 탭은 받은 목록을 15개씩 나눠 보인다", async () => {
    const user = await setupUser();
    const agents = many(20);
    const { history } = renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": agentsRoute(agents),
      "GET /v1/administered-agents": () => json(200, { items: agents }),
      ...counted(20, 20),
    });
    await showList(user, "관리하는 에이전트 20");
    await waitFor(() => expect(listedNames()).toEqual(range(1, 15)));
    expect(screen.getByText("1–15 / 20")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(listedNames()).toEqual(range(16, 20)));
    expect(history.location.search).toBe("?page=2");
    expect(screen.getByText("16–20 / 20")).toBeDefined();
  });
});

describe("Slack 조치 링크", () => {
  beforeEach(() => localStorage.clear());

  const ACTIONS = [
    ["events_failed", "이벤트 주소 등록 실패"],
    ["events_unverified", "이벤트 주소 확인 대기"],
    ["install", "앱 설치 대기"],
    ["reinstall", "다시 설치 필요"],
    ["home_unset", "홈 채널 지정 필요"],
    [null, null],
  ] as const;

  function listed() {
    const base = agentServer().detail().agent;
    return ACTIONS.map(([action], n) => ({
      ...base,
      id: `5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8${n}`,
      slug: `agent-${n}`,
      name: `에이전트 ${n}`,
      summary: {
        version: {
          version_no: 1,
          role: null,
          instructions: null,
          mcp_servers: [],
          credential_refs: [],
        },
        connection_id: null,
        release_label: null,
        release_model: null,
        bound_credential_refs: [],
        admins: [],
        needs_input_count: 0,
        running_count: 0,
        slack_action: action,
        engine: null,
        channels: [],
      },
    }));
  }

  // The link in the row the agent's name opens, if any.
  const slackLinkOf = (name: string) =>
    screen
      .getByRole("link", { name })
      .closest("[role=row]")
      ?.querySelector<HTMLAnchorElement>("a[href*='tab=slack']") ?? null;

  test("조치가 필요한 행에만 그 에이전트의 Slack 탭으로 가는 경고 표시를 이유와 함께 단다", async () => {
    const agents = listed();
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: agents, next_cursor: null }),
    });
    await screen.findByRole("link", { name: "에이전트 0" });
    // The warning mark's note holds the reason in words.
    ACTIONS.forEach(([, reason], n) => {
      const link = slackLinkOf(`에이전트 ${n}`);
      if (reason === null) {
        expect(link === null).toBe(true);
        return;
      }
      expect(link?.getAttribute("aria-label")).toBe("Slack 조치 필요");
      expect(link?.dataset.slot).toBe("slack-action");
      expect(
        document.getElementById(link?.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBe(`Slack 조치 필요: ${reason}`);
      expect(link?.getAttribute("href")).toBe(
        `/agents/${agents[n]?.id}?tab=slack`,
      );
    });
  });

  test("행의 Slack 경고 표시는 Tab으로 닿으면 이유를 열고, 누르면 Slack 탭으로 간다", async () => {
    const user = await setupUser();
    const agents = listed();
    const { history } = renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: agents, next_cursor: null }),
    });
    await screen.findByRole("link", { name: "에이전트 0" });
    const mark = slackLinkOf("에이전트 0") as HTMLAnchorElement;
    // The row's name link comes first, then its mark.
    screen.getByRole("link", { name: "에이전트 0" }).focus();
    await user.tab();
    expect(document.activeElement === mark).toBe(true);
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]')?.textContent,
      ).toBe("Slack 조치 필요: 이벤트 주소 등록 실패"),
    );
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(history.location.href).toBe(`/agents/${agents[0]?.id}?tab=slack`),
    );
  });
});

describe("목록을 볼 수 없는 구성원", () => {
  const member = {
    "GET /v1/auth/me": () => json(200, memberMe()),
    "GET /v1/agents": () =>
      apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
  };

  test("관리자로 지정된 에이전트는 목록 안내 아래에서 상세로 잇는다", async () => {
    const agent = agentServer().detail().agent;
    renderAt("/agents", {
      ...member,
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
    });
    const section = (
      await screen.findByRole("heading", { name: "내가 관리하는 에이전트" })
    ).closest("section") as HTMLElement;
    expect(
      within(section)
        .getByRole("link", { name: "결제 담당" })
        .getAttribute("href"),
    ).toBe(DETAIL);
    expect(
      screen.getByText(/전체 에이전트 목록은 오너와 어드민만 봅니다/),
    ).toBeDefined();
  });

  test("관리하는 에이전트가 없으면 없다고 적는다", async () => {
    renderAt("/agents", {
      ...member,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText("아직 관리자로 지정된 에이전트가 없습니다."),
    ).toBeDefined();
  });
});

describe("찾을 수 없는 에이전트", () => {
  test.each([
    ["없는 id(404)", me(), 404, "NOT_FOUND", "Agent not found"],
    [
      "볼 수 없는 구성원(403)",
      memberMe(),
      403,
      "FORBIDDEN",
      "This principal does not hold agent.manage",
    ],
  ] as const)(
    "%s는 제목과 목록 링크가 있는 찾을 수 없음 화면이다",
    async (_label, who, status, code, message) => {
      renderAt("/agents/missing", {
        "GET /v1/auth/me": () => json(200, who),
        "GET /v1/agents/missing": () => apiError(status, code, message),
        "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      });
      expect(
        await screen.findByRole("heading", {
          name: "에이전트를 찾을 수 없습니다",
        }),
      ).toBeDefined();
      expect(
        screen
          .getByRole("link", { name: "에이전트 목록으로" })
          .getAttribute("href"),
      ).toBe("/agents");
      expect(document.body.textContent).not.toContain(message);
      expect(screen.queryByText("이 화면을 볼 권한이 없습니다")).toBeNull();
    },
  );
});

describe("새 에이전트", () => {
  test("이름부터 채널 연결까지 만들고 Slack 연결은 나중에 할 수 있다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      ...previewSession(),
      [`GET /v1/agents/${AGENT_ID}/slack/app`]: () =>
        json(200, {
          slack_app: null,
          event_url: null,
          events: { state: "pending", checked_at: null, url: null },
          manifest_sync: null,
          reauthorization: null,
          warnings: [],
          config_token: "active",
        }),
      [`GET /v1/agents/${AGENT_ID}/identities`]: () => json(200, { items: [] }),
    });
    const user = await setupUser();
    await atStep("이름");
    await user.type(await screen.findByLabelText("이름"), "결제 담당");
    await user.type(screen.getByLabelText("식별자"), "billing");
    expect(
      screen.getByText(
        "목록과 상세 화면에 보입니다. 모델에게는 전해지지 않습니다.",
      ),
    ).toBeDefined();
    await user.type(screen.getByLabelText("설명 (선택)"), ` ${DESCRIPTION} `);
    await user.click(screen.getByRole("button", { name: "다음" }));

    await atStep("하는 일");
    expect(
      screen.getByRole("button", { name: /^이름\s*, 완료$/ }),
    ).toBeDefined();
    // How the agent works is written later, in its settings tab.
    expect(screen.queryByLabelText("역할")).toBeNull();
    expect(screen.queryByLabelText("에이전트 지시문")).toBeNull();
    const model = screen.getByLabelText("모델") as HTMLSelectElement;
    expect(model.getAttribute("data-slot")).toBe("native-select");
    expect(model.value).toBe("");
    expect([...model.options].map((option) => option.textContent)).toEqual([
      "모델을 고르세요",
      "claude-haiku-5",
      "claude-sonnet-5",
    ]);
    await user.selectOptions(model, CARD.model);
    expect(screen.queryByRole("textbox", { name: /도구/ })).toBeNull();
    // The first connection listed until another is picked.
    expect(
      (screen.getByLabelText("모델 연결") as HTMLSelectElement).value,
    ).toBe(CONNECTION);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "릴리스 만들기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "에이전트 켜기" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );

    await atStep("미리 써 보기");
    expect(posted(api, "/v1/agents")).toEqual({
      slug: "billing",
      name: "결제 담당",
      description: DESCRIPTION,
      managing_team_id: TEAM_ID,
      card: {
        ...CARD,
        // A new card follows the person's language until a language is chosen.
        language: "follow-user",
        capabilities: { mcp: null, forbidden: [] },
      },
      connection_id: CONNECTION,
      activate: false,
    });
    expect(server.releases).toHaveLength(1);
    expect(server.detail().agent.active_release_id).toBeNull();
    expect(
      api.calls.some(
        (c) => c.path.endsWith("/releases") || c.path.endsWith("/activate"),
      ),
    ).toBe(false);
    expect(
      screen.getByText(
        "아직 게시하지 않았습니다. 이 에이전트의 관리자와 워크스페이스 관리자만 이 에이전트를 봅니다.",
      ),
    ).toBeDefined();
    // Channels open once the agent is published.
    expect(
      (screen.getByRole("button", { name: /^채널 연결/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await user.type(
      screen.getByLabelText("보낼 메시지"),
      "환불 문의에 답해 봐",
    );
    await user.click(screen.getByRole("button", { name: "보내기" }));
    const session = await screen.findByRole("link", { name: "세션 열기" });
    expect(session.getAttribute("href")).toBe(`/sessions/${PREVIEW_SESSION}`);
    expect(posted(api, "/v1/sessions")).toEqual({
      agent_release_id: server.releases[0]?.id ?? "missing",
      message: "환불 문의에 답해 봐",
      preview: true,
    });
    // The next message goes to the same session.
    await user.type(screen.getByLabelText("보낼 메시지"), "한 번 더");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() =>
      expect(
        posted(api, `/v1/sessions/${PREVIEW_SESSION}/messages`),
      ).toMatchObject({ message: "한 번 더" }),
    );
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/sessions"),
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "게시" }));
    const confirm = await screen.findByRole("dialog");
    expect(
      within(confirm).getByText(
        "게시하면 담당 팀 재무이(가) 이 에이전트를 쓸 수 있습니다.",
      ),
    ).toBeDefined();
    await user.click(within(confirm).getByRole("button", { name: "게시" }));
    await atStep("채널 연결");
    expect(posted(api, `/v1/agents/${AGENT_ID}/activate`)).toEqual({
      release_id: server.releases[0]?.id ?? "missing",
      expected_revision: -1,
    });
    expect(server.detail().agent.active_release_id).toBe(
      server.releases[0]?.id ?? "missing",
    );
    expect(
      await screen.findByText(
        "결제 담당을(를) 게시했습니다. 이제 담당 팀 재무이(가) 이 에이전트를 씁니다.",
      ),
    ).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Slack 앱 만들고 설치" }),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "나중에 하기" }).getAttribute("href"),
    ).toBe(DETAIL);
  });

  test("고른 연결이 카드 모델을 제공하지 않으면 이유를 알리고 저장하지 못한다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents/new", { ...meOk, ...server.routes });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    await user.selectOptions(await connectionSelect(), "anthropic-fast");
    expect(
      await screen.findByText("고른 연결은 이 모델을 제공하지 않습니다"),
    ).toBeDefined();
    const save = screen.getByRole("button", {
      name: "저장하고 미리 써 보기",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(posted(api, "/v1/agents")).toBeUndefined();
  });

  test("다른 연결을 골라 저장하면 그 연결로 릴리스한다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents/new", { ...meOk, ...server.routes });
    const user = await setupUser();
    await toJobStep(user);
    await user.selectOptions(await connectionSelect(), "anthropic-fast");
    await user.selectOptions(
      await screen.findByLabelText("모델"),
      "claude-haiku-5",
    );
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    expect(
      (posted(api, "/v1/agents") as { connection_id: string }).connection_id,
    ).toBe("anthropic-fast");
    expect(server.releases[0]?.connection_id).toBe("anthropic-fast");
  });

  test("이 탭에서 다른 사람이 로그인하면 앞사람이 적던 흐름을 이어 보이지 않고 처음부터 연다", async () => {
    const MATE_ID = "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b";
    const mate = {
      ...me(),
      principal: { ...me().principal, id: MATE_ID },
      user: {
        id: MATE_ID,
        email: "mate@example.com",
        display_name: "Mate",
        locale: null,
      },
    };
    let who: "owner" | "mate" = "owner";
    const { services } = renderAt("/agents/new", {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, who === "owner" ? me() : mate),
    });
    const user = await setupUser();
    await toJobStep(user);
    who = "mate";
    await services.queryClient.refetchQueries({ queryKey: ["me"] });
    await screen.findByRole("button", { name: /^Mate mate@example\.com · / });
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    expect(currentStep()).toBe("1이름");
    expect(name.value).toBe("");
    expect((screen.getByLabelText("식별자") as HTMLInputElement).value).toBe(
      "",
    );
  });

  test("식별자는 이름에서 채워지고, 고친 뒤에는 이름을 따라가지 않는다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    const slug = screen.getByLabelText("식별자") as HTMLInputElement;
    await user.type(name, "Refund Desk 2");
    expect(slug.value).toBe("refund-desk-2");
    await user.clear(slug);
    await user.type(slug, "refunds");
    await user.type(name, "b");
    expect(slug.value).toBe("refunds");
  });

  test("영문이 없는 이름은 식별자를 비워 두고, 빈 칸은 다음으로 넘기지 않는다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "결제 담당");
    const slug = screen.getByLabelText("식별자") as HTMLInputElement;
    expect(slug.value).toBe("");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(slug.getAttribute("aria-invalid")).toBe("true"));
    expect(currentStep()).toBe("1이름");
  });

  test("하는 일 칸이 비면 칸마다 이유를 보이고 아무것도 저장하지 않는다", async () => {
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("모델").getAttribute("aria-invalid")).toBe(
        "true",
      ),
    );
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    expect(currentStep()).toBe("2하는 일");
  });

  test("하는 일까지 마치고 나가면 에이전트는 목록에 미게시로 남는다", async () => {
    const server = agentServer();
    let saved = false;
    const { history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents": () =>
        json(200, {
          items: saved ? [server.detail().agent] : [],
          next_cursor: null,
        }),
      "POST /v1/agents": (request: Request) => {
        saved = true;
        return server.routes["POST /v1/agents"](request);
      },
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");

    await user.click(screen.getByRole("link", { name: "나중에 게시" }));
    await waitFor(() => expect(history.location.pathname).toBe(DETAIL));
    act(() => history.push("/agents"));
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(stateOf(link)?.getAttribute("data-state")).toBe("draft");
    expect(stateOf(link)?.textContent).toBe("미게시");
  });

  test("초안을 다시 저장해도 다른 곳에서 넣은 규칙은 그대로 남는다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");
    const first = server.versions[0] as (typeof server.versions)[number];
    const rules = [
      { id: "r1", text: " 환불은 사람에게 넘긴다 ", source: "user" as const },
    ];
    server.versions.push({
      ...first,
      id: "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b",
      version_no: 2,
      card: { ...first.card, rules },
    });

    act(() => history.back());
    await atStep("하는 일");
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    const patch = api.calls.find((c) => c.method === "PATCH");
    const card = (patch?.body as { card: { rules?: unknown } }).card;
    expect(card.rules).toEqual(rules);
  });

  test("초안을 저장한 뒤 뒤로 가서 고치면 새로 만들지 않고 그 초안을 고친다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");
    // Until it is published the saved agent can still be changed.
    expect(
      (
        screen.getByRole("button", {
          name: /^하는 일\s*, 완료$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    act(() => history.back());
    await atStep("하는 일");
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { card: { language: string } }).card.language).toBe(
      "en",
    );
    expect(patch?.body).toMatchObject({
      connection_id: CONNECTION,
      activate: false,
    });
    expect(server.detail().agent.active_release_id).toBeNull();
    expect(server.releases.at(-1)?.version_id).toBe(
      server.versions[1]?.id ?? "missing",
    );

    act(() => history.go(-2));
    await atStep("이름");
    expect((screen.getByLabelText("식별자") as HTMLInputElement).readOnly).toBe(
      true,
    );
  });

  test("나갔다가 뒤로 돌아와도 그 초안을 이어서 고치고 새로 만들지 않는다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");

    // Leaving unmounts the flow; coming back mounts a new one.
    await user.click(screen.getByRole("link", { name: "나중에 게시" }));
    await waitFor(() => expect(history.location.pathname).toBe(DETAIL));
    act(() => history.back());
    await atStep("미리 써 보기");
    act(() => history.back());
    await atStep("하는 일");
    expect((screen.getByLabelText("모델") as HTMLSelectElement).value).toBe(
      CARD.model,
    );
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(true);
    // The release goes to the version that save made, not the first one.
    expect(server.releases.at(-1)?.version_id).toBe(
      server.versions[1]?.id ?? "missing",
    );
  });

  test("고른 연결은 단계를 오가도 남고, 저장은 그 연결로 릴리스한다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.selectOptions(await connectionSelect(), "anthropic-fast");
    await user.selectOptions(
      await screen.findByLabelText("모델"),
      "claude-haiku-5",
    );
    act(() => history.back());
    await atStep("이름");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    expect((await connectionSelect()).value).toBe("anthropic-fast");
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    expect(
      (posted(api, "/v1/agents") as { connection_id: string }).connection_id,
    ).toBe("anthropic-fast");
  });

  test("첫 단계에서 나갔다 돌아와도 그 초안의 이름·식별자를 이어 간다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");

    act(() => history.go(-2));
    await atStep("이름");
    act(() => history.push("/agents"));
    await screen.findByRole("link", { name: "결제 담당" });
    act(() => history.back());
    await atStep("이름");
    const slug = screen.getByLabelText("식별자") as HTMLInputElement;
    expect(slug.value).toBe("billing");
    expect(slug.readOnly).toBe(true);
    expect((screen.getByLabelText("이름") as HTMLInputElement).value).toBe(
      "결제 담당",
    );
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    expect((screen.getByLabelText("모델") as HTMLSelectElement).value).toBe(
      CARD.model,
    );
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
  });

  test("저장한 초안의 설명을 이름 단계에서 고치면 그 초안의 설명만 바꾼다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "결제 담당");
    await user.type(screen.getByLabelText("식별자"), "billing");
    await user.type(screen.getByLabelText("설명 (선택)"), DESCRIPTION);
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    await fillJob(user);
    await atStep("미리 써 보기");
    expect(
      (posted(api, "/v1/agents") as { description?: string }).description,
    ).toBe(DESCRIPTION);

    act(() => history.go(-2));
    await atStep("이름");
    const description = screen.getByLabelText(
      "설명 (선택)",
    ) as HTMLTextAreaElement;
    expect(description.value).toBe(DESCRIPTION);
    await user.clear(description);
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    const patch = api.calls.find((c) => c.method === "PATCH")?.body as {
      name?: string;
      description?: string;
    };
    expect(patch.description).toBe("");
    expect("name" in patch).toBe(false);
    expect(server.detail().agent.description).toBe("");
  });

  test("Stepper로 앞 단계에 돌아가면 그 단계 제목이 포커스를 받는다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await toJobStep(user);
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("하는 일"),
    );
    await user.click(screen.getByRole("button", { name: /^이름\s*, 완료$/ }));
    await atStep("이름");
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    expect(document.activeElement?.textContent).toBe("이름");
  });

  test("이름 단계 카드는 칸 이름과 겹치는 제목을 보이지 않고, 제목은 읽는 이에게 남는다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    await atStep("이름");
    const field = await screen.findByLabelText("이름");
    const heading = screen.getByRole("heading", { name: "이름" });
    expect(heading.classList.contains("sr-only")).toBe(true);
    expect(heading.closest("form") === field.closest("form")).toBe(true);
    // The next step's heading has no field saying the same, so it shows.
    const user = await setupUser();
    await toJobStep(user);
    const job = await screen.findByRole("heading", { name: "하는 일" });
    expect(job.classList.contains("sr-only")).toBe(false);
  });

  test("거부된 초안 저장은 서버 이유를 한 줄로 보이고 그 단계에 머문다", async () => {
    renderAt("/agents/new", {
      ...meOk,
      ...agentServer().routes,
      "POST /v1/agents": () =>
        apiError(409, "ALREADY_EXISTS", "slug billing is taken"),
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 식별자는 다른 에이전트가 이미 씁니다. '이름' 단계로 돌아가 식별자를 바꾸세요.",
    );
    expect(currentStep()).toBe("2하는 일");
  });

  test("모델 목록을 읽는 동안과 못 읽었을 때는 이유를 보이고 만들지 못하게 한다", async () => {
    let fail: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      fail = resolve;
    });
    renderAt("/agents/new", {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/connections": async () => {
        await gate;
        return apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "The catalog cannot be read",
        );
      },
    });
    await toJobStep(await setupUser());
    const create = () =>
      screen.getByRole("button", {
        name: "저장하고 미리 써 보기",
      }) as HTMLButtonElement;
    // The model select's slot waits as a skeleton that names what it waits for.
    expect(
      (await screen.findByText(/모델 목록을 불러오는 중/)).closest(
        "output[aria-busy=true]",
      ),
    ).not.toBeNull();
    expect(create().disabled).toBe(true);
    fail();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "모델 목록을 불러오지 못해 저장할 수 없습니다",
    );
    expect(screen.queryByLabelText("모델")).toBeNull();
    expect(create().disabled).toBe(true);
  });
});

describe("새 에이전트: 첫 릴리스", () => {
  test("첫 릴리스가 거절되면 저장한 에이전트에 이유를 보이고, 다시 저장하면 같은 에이전트를 고쳐 릴리스한다", async () => {
    const server = agentServer();
    const create = server.routes["POST /v1/agents"];
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "POST /v1/agents": async (request: Request) => {
        const body = (await request.json()) as Record<string, unknown>;
        return create(
          new Request("https://console.test/", {
            method: "POST",
            body: JSON.stringify({
              ...body,
              connection_id: "connection_gone",
            }),
          }),
        );
      },
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "에이전트는 저장했지만 첫 릴리스를 만들지 못했습니다: 켜진 연결이 아닙니다. 저장을 다시 누르면 같은 에이전트를 고쳐 다시 시도합니다.",
    );
    expect(currentStep()).toBe("2하는 일");
    expect(server.detail().agent.active_release_id).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    const patches = api.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toMatchObject({
      connection_id: CONNECTION,
      activate: false,
    });
    expect(server.releases).toHaveLength(1);
    expect(server.detail().agent.active_release_id).toBeNull();
  });

  test("연결 칸은 하나이고 연결마다 id와 종류로 보인다", async () => {
    const server = agentServer();
    renderAt("/agents/new", { ...meOk, ...server.routes });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    const select = await connectionSelect();
    expect(screen.getAllByLabelText("모델 연결")).toHaveLength(1);
    expect([...select.options].map((option) => option.textContent)).toEqual(
      CONNECTIONS.map((connection) => `${connection.id} · anthropic`),
    );
    expect(screen.queryByLabelText("저장소")).toBeNull();
  });
});

describe("게시 전 에이전트", () => {
  const slackRoutes = {
    [`GET /v1/agents/${AGENT_ID}/slack/app`]: () =>
      json(200, {
        slack_app: null,
        event_url: null,
        events: { state: "pending", checked_at: null, url: null },
        manifest_sync: null,
        reauthorization: null,
        warnings: [],
        config_token: null,
      }),
    [`GET /v1/agents/${AGENT_ID}/identities`]: () => json(200, { items: [] }),
  };

  /** Tab until `target` holds focus; fails if the tab order never reaches it. */
  async function tabTo(user: User, target: HTMLElement) {
    for (let i = 0; i < 120 && document.activeElement !== target; i++)
      await user.tab();
    expect(document.activeElement === target).toBe(true);
  }

  /** A saved release the agent has not turned on. */
  async function saveOnly(
    server: ReturnType<typeof agentServer>,
    card: typeof CARD,
  ) {
    await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
      new Request("https://console.test/", {
        method: "PATCH",
        body: JSON.stringify({
          card,
          connection_id: CONNECTION,
          activate: false,
        }),
      }),
    );
  }

  test("새 에이전트는 키보드만으로 저장·미리 써 보기·게시까지 간다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      ...previewSession(),
      ...slackRoutes,
    });
    const user = await setupUser();
    await atStep("이름");
    await tabTo(user, await screen.findByLabelText("이름"));
    await user.keyboard("Billing Desk");
    await tabTo(user, screen.getByLabelText("식별자"));
    expect((document.activeElement as HTMLInputElement).value).toBe(
      "billing-desk",
    );
    await tabTo(user, screen.getByRole("button", { name: "다음" }));
    await user.keyboard("{Enter}");

    await atStep("하는 일");
    // The step's heading takes the keyboard, not the page top.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("하는 일"),
    );
    const model = screen.getByLabelText("모델") as HTMLSelectElement;
    await tabTo(user, model);
    // happy-dom's select has no arrow-key list; the focused select is picked.
    await user.selectOptions(model, CARD.model);
    await tabTo(
      user,
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await user.keyboard("{Enter}");

    await atStep("미리 써 보기");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("미리 써 보기"),
    );
    await tabTo(user, screen.getByLabelText("보낼 메시지"));
    await user.keyboard("안녕");
    await tabTo(user, screen.getByRole("button", { name: "보내기" }));
    await user.keyboard("{Enter}");
    await screen.findByRole("link", { name: "세션 열기" });
    expect(posted(api, "/v1/sessions")).toMatchObject({ preview: true });

    await tabTo(user, screen.getByRole("button", { name: "게시" }));
    await user.keyboard("{Enter}");
    const confirm = await screen.findByRole("dialog");
    await tabTo(user, within(confirm).getByRole("button", { name: "게시" }));
    await user.keyboard("{Enter}");
    await atStep("채널 연결");
    expect(server.detail().agent.active_release_id).toBe(
      server.releases[0]?.id ?? "missing",
    );
  });

  const unchangedAt = (
    server: ReturnType<typeof agentServer>,
    versionId: string,
  ) =>
    json(200, {
      ...server.detail(),
      release: {
        status: "unchanged",
        reason: null,
        release_id: null,
        version_id: versionId,
      },
    });

  test("다시 저장해 바뀐 것이 없다고 하면 그 버전의 릴리스를 미리 써 본다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    let unchanged = false;
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      ...previewSession(),
      [`PATCH /v1/agents/${AGENT_ID}`]: (request: Request) =>
        unchanged ? unchangedAt(server, SECOND_VERSION) : patch(request),
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");
    // Another admin saved, as a release of its own, what this screen saves.
    const first = server.versions[0] as (typeof server.versions)[number];
    server.versions.push({
      ...first,
      id: SECOND_VERSION,
      version_no: 2,
      content_sha256: "f".repeat(64),
    });
    server.releases.push(
      releaseFixture(5, { id: "rel-other", versionId: SECOND_VERSION }),
    );
    unchanged = true;
    act(() => history.back());
    await atStep("하는 일");
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    await user.type(screen.getByLabelText("보낼 메시지"), "안녕");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByRole("link", { name: "세션 열기" });
    expect(
      (posted(api, "/v1/sessions") as { agent_release_id: string })
        .agent_release_id,
    ).toBe("rel-other");
  });

  test("마지막 저장의 릴리스를 만들지 못했으면 상세는 이전 릴리스 대신 이유를 보인다", async () => {
    const server = agentServer();
    await saveOnly(server, CARD);
    await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
      new Request("https://console.test/", {
        method: "PATCH",
        body: JSON.stringify({
          card: CARD,
          connection_id: "connection_gone",
          activate: false,
        }),
      }),
    );
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const notice = (
      await screen.findByText("아직 게시하지 않았습니다")
    ).closest("[data-status=unpublished]") as HTMLElement;
    expect(notice.textContent).toContain(
      "마지막으로 저장한 설정으로 릴리스를 만들지 못했습니다",
    );
    expect(within(notice).queryByRole("button")).toBeNull();
  });

  test("같은 설정을 다시 저장했다가 거절되면 예전 릴리스로 미리 써 보게 하지 않는다", async () => {
    const server = agentServer();
    await saveOnly(server, CARD);
    const refused = () => {
      const detail = server.detail();
      return json(200, {
        ...detail,
        draft: detail.draft && { ...detail.draft, failure: "release_refused" },
      });
    };
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: refused,
    });
    const notice = (
      await screen.findByText("아직 게시하지 않았습니다")
    ).closest("[data-status=unpublished]") as HTMLElement;
    expect(notice.textContent).toContain(
      "마지막으로 저장한 설정으로 릴리스를 만들지 못했습니다",
    );
    expect(within(notice).queryByRole("button")).toBeNull();
  });

  test("모델 목록을 읽지 못하면 이름만 고쳐도 저장만 하고 미리 써 보기는 막힌다", async () => {
    const server = agentServer();
    await seedRelease(server);
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      "GET /v1/connections": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "The catalog cannot be read"),
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.type(await screen.findByLabelText("이름"), " 2");
    const saveOnlyButton = (await screen.findByRole("button", {
      name: "저장만 하고 미리 써 보기",
    })) as HTMLButtonElement;
    await waitFor(() => expect(saveOnlyButton.disabled).toBe(true));
    // The name alone sends no card, so the plain save still goes.
    expect(
      (screen.getByRole("button", { name: "저장" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("답을 받지 못한 다음 메시지는 다시 보내도 같은 키로 간다", async () => {
    const server = agentServer();
    await saveOnly(server, CARD);
    const session = previewSession();
    const answers = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      session[`POST /v1/sessions/${PREVIEW_SESSION}/messages`],
    ];
    const { api } = renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      ...session,
      [`POST /v1/sessions/${PREVIEW_SESSION}/messages`]: () =>
        (answers.shift() as () => Response | Promise<Response>)(),
    });
    const user = await setupUser();
    const notice = (
      await screen.findByText("아직 게시하지 않았습니다")
    ).closest("[data-status=unpublished]") as HTMLElement;
    await user.click(
      within(notice).getByRole("button", { name: "미리 써 보기" }),
    );
    const preview = await screen.findByRole("dialog");
    const field = within(preview).getByLabelText("보낼 메시지");
    const sendButton = within(preview).getByRole("button", { name: "보내기" });
    await user.type(field, "처음");
    await user.click(sendButton);
    await within(preview).findByRole("link", { name: "세션 열기" });
    await user.type(field, "다음");
    await user.click(sendButton);
    await within(preview).findByRole("alert");
    await user.click(sendButton);
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(""));
    const keys = api.calls
      .filter((c) => c.path === `/v1/sessions/${PREVIEW_SESSION}/messages`)
      .map((c) => c.headers.get("idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1] ?? "missing");
  });

  test("바뀐 것 없이 저장만 하고 미리 써 보기는 켜져 있는 릴리스로 미리보기를 연다", async () => {
    const server = agentServer();
    await seedRelease(server);
    const on = server.detail().agent.active_release_id;
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      ...previewSession(),
      [`PATCH /v1/agents/${AGENT_ID}`]: () =>
        unchangedAt(server, server.versions[0]?.id ?? "missing"),
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.click(
      await screen.findByRole("button", { name: "저장만 하고 미리 써 보기" }),
    );
    const preview = await screen.findByRole("dialog");
    await user.type(within(preview).getByLabelText("보낼 메시지"), "확인");
    await user.click(within(preview).getByRole("button", { name: "보내기" }));
    await within(preview).findByRole("link", { name: "세션 열기" });
    expect(
      (posted(api, "/v1/sessions") as { agent_release_id: string })
        .agent_release_id,
    ).toBe(on ?? "missing");
  });

  test("게시 전 에이전트의 거절된 저장을 다시 시도해도 게시하지 않는다", async () => {
    const server = agentServer();
    await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
      new Request("https://console.test/", {
        method: "PATCH",
        body: JSON.stringify({
          card: CARD,
          connection_id: "connection_gone",
          activate: false,
        }),
      }),
    );
    const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "PATCH")).toBe(true),
    );
    expect(api.calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
      activate: false,
    });
    expect(server.detail().agent.active_release_id).toBeNull();
  });

  test("게시한 에이전트의 실패한 저장을 다시 시도해도 켜지 않고, 미리 써 본 뒤 켜게 한다", async () => {
    const server = agentServer();
    await seedRelease(server);
    const active = server.detail().agent.active_release_id;
    // A card saved with no release made: the save failed, and a retry can
    // make it.
    await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
      new Request("https://console.test/", {
        method: "PATCH",
        body: JSON.stringify({ card: { ...CARD, language: "en" } }),
      }),
    );
    expect(server.detail().draft?.failure).toBe("release_refused");
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      ...previewSession(),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await screen.findByText("저장했습니다 — 버전 2. 아직 켜지 않았습니다.");
    expect(api.calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
      activate: false,
    });
    expect(server.detail().agent.active_release_id).toBe(active);
    const saved = server.releases.find((r) => r.id !== active);
    expect(saved?.activated_at).toBeNull();
    const card = screen.getByRole("tabpanel", { name: "상세 설정" });
    expect(within(card).getByText("켜지 않은 변경이 있습니다")).toBeDefined();
    expect(
      within(card).getByText(
        "저장만 한 설정은 아직 켜지 않았습니다. 미리 써 본 뒤 그 릴리스를 켜세요.",
      ),
    ).toBeDefined();
    expect(
      within(card).queryByRole("button", { name: "다시 시도" }),
    ).toBeNull();
    const tryIt = within(card).getByRole("button", { name: "미리 써 보기" });
    await waitFor(() => expect(document.activeElement === tryIt).toBe(true));
    await user.click(tryIt);
    const preview = await screen.findByRole("dialog");
    await user.type(within(preview).getByLabelText("보낼 메시지"), "확인");
    await user.click(within(preview).getByRole("button", { name: "보내기" }));
    await within(preview).findByRole("link", { name: "세션 열기" });
    expect(
      (posted(api, "/v1/sessions") as { agent_release_id: string })
        .agent_release_id,
    ).toBe(saved?.id ?? "missing");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === tryIt).toBe(true));

    // Only an explicit turn-on publishes it.
    await user.click(
      within(card).getAllByRole("button", {
        name: "릴리스 탭으로",
      })[0] as HTMLElement,
    );
    await user.click(
      await screen.findByRole("button", { name: /^릴리스 .+ 켜기$/ }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "켜기",
      }),
    );
    await waitFor(() =>
      expect(server.detail().agent.active_release_id).toBe(saved?.id ?? ""),
    );
  });

  test("다시 시도의 답을 기다리는 사이 다른 곳으로 옮긴 포커스는 그대로 둔다", async () => {
    const server = agentServer();
    await seedRelease(server);
    await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
      new Request("https://console.test/", {
        method: "PATCH",
        body: JSON.stringify({ card: { ...CARD, language: "en" } }),
      }),
    );
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        await answered;
        return server.routes[`PATCH /v1/agents/${AGENT_ID}`](request);
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    const edit = screen.getByRole("button", { name: "상세 설정 편집" });
    edit.focus();
    expect(document.activeElement === edit).toBe(true);
    answer();
    const card = screen.getByRole("tabpanel", { name: "상세 설정" });
    await within(card).findByRole("button", { name: "미리 써 보기" });
    expect(document.activeElement === edit).toBe(true);
  });

  test("저장만 하기가 더 새 저장에 밀리면 미리보기를 열지 않는다", async () => {
    const server = agentServer();
    await seedRelease(server);
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: () =>
        json(200, {
          ...server.detail(),
          release: {
            status: "superseded",
            reason: null,
            release_id: server.releases[0]?.id ?? null,
            version_id: server.versions[0]?.id ?? null,
          },
        }),
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.click(
      await screen.findByRole("button", { name: "저장만 하고 미리 써 보기" }),
    );
    expect(
      await screen.findByText(/더 나중의 저장이 먼저 적용되어/),
    ).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("저장소에 쓰지 못해도 게시한 뒤 채널 연결로 간다", async () => {
    const server = agentServer();
    renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      ...slackRoutes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");
    const write = sessionStorage.setItem;
    sessionStorage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    try {
      await user.click(screen.getByRole("button", { name: "게시" }));
      const confirm = await screen.findByRole("dialog");
      await user.click(within(confirm).getByRole("button", { name: "게시" }));
      await atStep("채널 연결");
    } finally {
      sessionStorage.setItem = write;
    }
  });

  test("저장만 하고 미리 써 보기도 폼 검사를 거친다", async () => {
    const server = agentServer();
    await seedRelease(server);
    const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    const name = await screen.findByLabelText("이름");
    await user.clear(name);
    await user.click(
      screen.getByRole("button", { name: "저장만 하고 미리 써 보기" }),
    );
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("상세는 게시 전이라고 알리고, 거기서 미리 써 보고 게시한다", async () => {
    const server = agentServer();
    await saveOnly(server, CARD);
    const { api } = renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      ...previewSession(),
    });
    const user = await setupUser();
    const notice = (
      await screen.findByText("아직 게시하지 않았습니다")
    ).closest("[data-status=unpublished]") as HTMLElement;
    expect(notice).not.toBeNull();

    await user.click(
      within(notice).getByRole("button", { name: "미리 써 보기" }),
    );
    const preview = await screen.findByRole("dialog");
    expect(
      within(preview).getByRole("heading", { name: /^미리 써 보기: / }),
    ).toBeDefined();
    const field = within(preview).getByLabelText("보낼 메시지");
    await user.type(field, "안녕");
    await user.click(within(preview).getByRole("button", { name: "보내기" }));
    await within(preview).findByRole("link", { name: "세션 열기" });
    // The send button is disabled while pending; focus comes back to the field.
    await waitFor(() => expect(document.activeElement === field).toBe(true));
    expect(posted(api, "/v1/sessions")).toEqual({
      agent_release_id: server.releases[0]?.id ?? "missing",
      message: "안녕",
      preview: true,
    });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(notice).getByRole("button", { name: "게시" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "게시" }));
    expect(
      await screen.findByText(
        "게시했습니다. 이제 담당 팀 재무이(가) 이 에이전트를 씁니다.",
      ),
    ).toBeDefined();
    expect(posted(api, `/v1/agents/${AGENT_ID}/activate`)).toEqual({
      release_id: server.releases[0]?.id ?? "missing",
      expected_revision: -1,
    });
    await waitFor(() =>
      expect(screen.queryByText("아직 게시하지 않았습니다")).toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("게시한 에이전트에 저장만 한 변경은 릴리스 탭에 알리고 그 릴리스를 미리 써 본다", async () => {
    const server = agentServer();
    await seedRelease(server);
    await saveOnly(server, { ...CARD, language: "en" });
    const { api } = renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      ...previewSession(),
    });
    const user = await setupUser();
    const tab = await screen.findByRole("tabpanel", { name: "릴리스" });
    expect(
      await within(tab).findByText("켜지 않은 변경이 있습니다"),
    ).toBeDefined();
    expect(screen.queryByText("아직 게시하지 않았습니다")).toBeNull();
    const tries = screen.getAllByRole("button", { name: /^미리 써 보기: / });
    // Only the release that is not on can be tried.
    expect(tries).toHaveLength(1);
    // A release newer than the active one is turned on, not rolled back to.
    expect(screen.queryByRole("button", { name: /되돌리기$/ })).toBeNull();
    const turnOn = screen.getByRole("button", { name: /^릴리스 .+ 켜기$/ });
    expect(turnOn.textContent).toBe("켜기");
    await user.click(turnOn);
    const confirm = await screen.findByRole("dialog");
    expect(
      within(confirm).getByRole("heading", { name: /을\(를\) 켤까요\?$/ }),
    ).toBeDefined();
    expect(within(confirm).getByRole("button", { name: "켜기" })).toBeDefined();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(tries[0] as HTMLElement);
    const preview = await screen.findByRole("dialog");
    await user.type(within(preview).getByLabelText("보낼 메시지"), "확인");
    await user.click(within(preview).getByRole("button", { name: "보내기" }));
    await within(preview).findByRole("link", { name: "세션 열기" });
    expect(
      (posted(api, "/v1/sessions") as { agent_release_id: string })
        .agent_release_id,
    ).toBe(server.releases.at(-1)?.id ?? "missing");
  });

  test("키보드로 연 미리보기를 닫으면 연 버튼으로 돌아간다", async () => {
    const server = agentServer();
    await seedRelease(server);
    await saveOnly(server, { ...CARD, language: "en" });
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const open = await screen.findByRole("button", {
      name: /^미리 써 보기: /,
    });
    open.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === open).toBe(true));
  });

  test("저장만 하고 미리 써 보기는 켜지 않고 저장해 그 릴리스로 미리보기를 연다", async () => {
    const server = agentServer();
    await seedRelease(server);
    const on = server.detail().agent.active_release_id;
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      ...previewSession(),
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    await user.click(
      screen.getByRole("button", { name: "저장만 하고 미리 써 보기" }),
    );
    const preview = await screen.findByRole("dialog");
    expect(
      within(preview).getByRole("heading", { name: /^미리 써 보기: / }),
    ).toBeDefined();
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({ activate: false });
    expect(server.detail().agent.active_release_id).toBe(on);
    await user.type(within(preview).getByLabelText("보낼 메시지"), "확인");
    await user.click(within(preview).getByRole("button", { name: "보내기" }));
    await within(preview).findByRole("link", { name: "세션 열기" });
    expect(
      (posted(api, "/v1/sessions") as { agent_release_id: string })
        .agent_release_id,
    ).toBe(server.releases.at(-1)?.id ?? "missing");
    expect(server.releases.at(-1)?.id).not.toBe(on);
    // The save closed the form and its button: focus goes to the edit button.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("상세 설정 편집"),
    );
  });
});

describe("에이전트 상세", () => {
  test("카드를 고치면 새 version으로 저장했다고 하고, 두 version의 차이를 보인다", async () => {
    const server = agentServer();
    const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        /저장했습니다 — 버전 2\. 새 세션에는 적용하지 못했습니다/,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
    // The save closes the form; the card it shows is the one just saved.
    expect(screen.queryByLabelText("답변 언어")).toBeNull();
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.headers.get("idempotency-key")).toBeNull();
    expect((patch?.body as { card: unknown }).card).toEqual({
      ...CARD,
      language: "en",
    });
    // Only the card changed: name and description stay off the request, and
    // a save never publishes an agent that is not yet published.
    expect(patch?.body).toEqual({
      card: { ...CARD, language: "en" },
      activate: false,
    });
    const diff = await screen.findByText("버전 1 → 버전 2");
    const figure = diff.closest("figure") as HTMLElement;
    expect(
      [...figure.querySelectorAll('[data-kind="added"]')]
        .map((line) => line.textContent)
        .join("\n"),
    ).toContain('"language": "en"');
  });

  test("이미 있는 version과 같은 카드로 저장하면 그 version을 저장 결과로 본다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다 — 버전 2/);
    await openCardEditor(user);
    // Set back, the card is version 1's card again.
    await user.selectOptions(screen.getByLabelText("답변 언어"), "ko");
    await user.click(screen.getByRole("button", { name: "저장" }));
    // Not yet published, so the save keeps the release without turning it on.
    expect(
      await screen.findByText("저장했습니다 — 버전 1. 아직 켜지 않았습니다."),
    ).toBeDefined();
    expect(server.detail().agent.active_release_id).toBeNull();
    expect(screen.queryByLabelText("답변 언어")).toBeNull();
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
    expect(server.releases).toHaveLength(1);
    expect(server.releases.at(-1)?.version_id).toBe(
      server.versions[0]?.id ?? "missing",
    );
  });

  test("저장 결과는 보낸 카드 전체(rules 포함)로 찾는다", async () => {
    const server = agentServer();
    const rule = (id: string) => ({
      id,
      text: `규칙 ${id}`,
      source: "user" as const,
    });
    const base = server.versions[0] as (typeof server.versions)[number];
    server.versions.splice(
      0,
      1,
      { ...base, card: { ...CARD, rules: [rule("x")] } },
      {
        ...base,
        id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
        version_no: 2,
        card: { ...CARD, rules: [rule("y")] },
        content_sha256: "2".repeat(64),
      },
      {
        ...base,
        id: "8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a",
        version_no: 3,
        card: { ...CARD, language: "en", rules: [rule("x")] },
        content_sha256: "3".repeat(64),
      },
    );
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    // The latest version (3) is English; setting Korean makes it version 1's
    // card again.
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "ko");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "저장했습니다. 같은 카드가 이미 있어(버전 1) 새 버전은 생기지 않았습니다.",
      ),
    ).toBeDefined();
  });

  test("이름·설명만 고치면 카드 없이 행만 저장하고, 새 버전이 없다고 말한다", async () => {
    const server = agentServer();
    const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    const identity = screen.getByRole("group", { name: "이름과 설명" });
    expect(
      within(identity).getByText(
        "새 버전이나 릴리스 없이 바로 바뀝니다. 이름과 설명은 사람이 보는 값이고 모델에게는 전해지지 않습니다. 맡을 일과 행동 방식은 저장소의 CLAUDE.md나 AGENTS.md에 적으세요.",
      ),
    ).toBeDefined();
    await user.type(within(identity).getByLabelText("설명"), ` ${DESCRIPTION}`);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "이름과 설명을 저장했습니다. 바로 반영되고 새 버전은 생기지 않았습니다.",
      ),
    ).toBeDefined();
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ description: DESCRIPTION });
    expect(server.versions).toHaveLength(1);
    const summary = screen.getByRole("region", { name: "에이전트 카드" });
    expect(within(summary).getByText(DESCRIPTION)).toBeDefined();
  });

  test("옛 카드의 역할·지시 사항은 화면에 없고, 저장해도 그대로 남는다", async () => {
    const server = agentServer();
    const first = server.versions[0] as (typeof server.versions)[number];
    server.versions.splice(0, 1, {
      ...first,
      card: { ...CARD, role: "결제 문의 담당", instructions: EARLIER },
    });
    const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const summary = await screen.findByRole("region", {
      name: "에이전트 카드",
    });
    // The raw card below still prints what the version stored; the summary
    // does not show it as a setting.
    expect(
      [...summary.querySelectorAll("dt")].map((term) => term.textContent),
    ).not.toContain("이전 지시 사항 (적용된 적 없음)");
    await openCardEditor(user);
    expect(screen.queryByLabelText("에이전트 지시문")).toBeNull();
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다 — 버전 2/);
    const card = (
      api.calls.find((c) => c.method === "PATCH")?.body as {
        card: Record<string, unknown>;
      }
    ).card;
    expect(card.instructions).toBe(EARLIER);
    expect(card.role).toBe("결제 문의 담당");
  });

  test("바뀐 것 없이 저장하면 새 version이 없다고 말한다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    await user.click(await screen.findByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "저장했습니다. 카드 내용이 같아 새 버전은 생기지 않았습니다.",
      ),
    ).toBeDefined();
  });

  test("릴리스 탭은 기록과 되돌리기만 둔다: 만드는 폼도 연결·저장소·메모 칸도 없다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["버전", "상태", "활성화 시각", "만든 사람", "동작"]);
    expect(screen.queryByRole("button", { name: "새 릴리스" })).toBeNull();
    for (const label of ["모델 연결", "저장소", "메모", "버전"])
      expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const [newer, older] = within(table).getAllByRole("row").slice(1) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(within(newer).getAllByText("활성").length).toBeGreaterThan(0);
    expect(within(older).getAllByText("이전").length).toBeGreaterThan(0);
    expect(
      within(newer).queryByRole("button", { name: /되돌리기$/ }),
    ).toBeNull();
    expect(
      within(older).getByRole("button", { name: /되돌리기$/ }),
    ).toBeDefined();
  });

  test("활성화된 적 없는 릴리스는 활성화 전으로, 시각 칸은 —로 둔다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    server.releases.push(releaseFixture(5, { id: "rel-never" }));
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const table = await screen.findByRole("table");
    const [never] = within(table).getAllByRole("row").slice(1) as [HTMLElement];
    expect(within(never).getAllByText("활성화 전").length).toBeGreaterThan(0);
    expect(within(never).getAllByText("—").length).toBeGreaterThan(0);
  });

  test("판단이 지침을 덜 읽는 릴리스에는 그 이유가 한 줄 보인다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    server.releases.push(
      {
        ...releaseFixture(5, { id: "rel-cut" }),
        instructions_snapshot: {
          kind: "text",
          repository_id: "sample-app",
          commit: "a".repeat(40),
          file: "AGENTS.md",
          text: "앞부분",
          bytes: 9000,
          truncated: true,
        },
      },
      {
        ...releaseFixture(6, { id: "rel-unread" }),
        instructions_snapshot: {
          kind: "read_failed",
          repository_id: "sample-app",
          reason: "github_failed",
        },
      },
    );
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const table = await screen.findByRole("table");
    const [unread, cut, ...rest] = within(table)
      .getAllByRole("row")
      .slice(1) as HTMLElement[];
    expect(
      within(unread as HTMLElement).getByText(
        "저장소의 지침 파일을 읽지 못해 대화 판단은 고정 기준만 씁니다. 새 릴리스를 만들면 다시 읽습니다.",
      ),
    ).toBeDefined();
    expect(
      within(cut as HTMLElement).getByText(
        "지침이 4KB를 넘어 앞부분만 대화 판단에 씁니다. 판단에 쓸 규칙은 파일 앞쪽에 두세요.",
      ),
    ).toBeDefined();
    for (const row of rest) {
      expect(within(row).queryByText(/대화 판단/)).toBeNull();
    }
  });

  test("접근 변경은 릴리스 사이에 줄로 보이고 되돌리기가 없다", async () => {
    const server = agentServer({
      activity: [
        {
          id: "00000000-0000-4000-8000-0000000000d2",
          operation: "set_agent_github",
          target_ref: {
            resource: { kind: "agent", id: AGENT_ID },
            workspace_id: null,
          },
          status: "succeeded",
          result: { change: "settings", enabled: true },
          error: null,
          created_at: "2026-10-11T01:00:30.000Z",
          updated_at: "2026-10-11T01:00:30.000Z",
        },
        {
          id: "00000000-0000-4000-8000-0000000000d3",
          operation: "set_agent_github",
          target_ref: {
            resource: { kind: "agent", id: AGENT_ID },
            workspace_id: null,
          },
          status: "failed",
          result: { change: "settings" },
          error: { code: "REVISION_CONFLICT", message: "not saved" },
          created_at: "2026-10-11T01:00:40.000Z",
          updated_at: "2026-10-11T01:00:40.000Z",
        },
      ],
    });
    await releasedTwice(server);
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1) as HTMLElement[];
    expect(rows).toHaveLength(3);
    const access = rows[1] as HTMLElement;
    expect(access.getAttribute("data-kind")).toBe("access");
    expect(access.textContent).toContain("접근 변경");
    expect(access.textContent).toContain("GitHub 설정 저장");
    expect(access.textContent).toContain(
      "저장소와 GitHub 설정 변경입니다. 새 릴리스를 만들지 않습니다.",
    );
    expect(within(access).queryByRole("button")).toBeNull();
  });

  test("MCP 설정 저장은 접근 변경 줄에 이전·이후 이름만 싣고, 저장하지 못한 것은 싣지 않는다", async () => {
    const receipt = (
      n: number,
      status: "succeeded" | "failed",
      result: unknown,
    ) => ({
      id: `00000000-0000-4000-8000-0000000000e${n}`,
      operation: "set_agent_mcp",
      target_ref: {
        resource: { kind: "agent", id: AGENT_ID },
        workspace_id: null,
      },
      status,
      result,
      error:
        status === "failed"
          ? { code: "REVISION_CONFLICT", message: "not saved" }
          : null,
      created_at: `2026-10-11T01:00:${10 + n}.000Z`,
      updated_at: `2026-10-11T01:00:${10 + n}.000Z`,
    });
    const server = agentServer({
      activity: [
        receipt(1, "succeeded", {
          before: null,
          after: {
            server: "docs",
            allowed_tools: ["mcp__docs__read"],
            credential_refs: ["docs-key"],
            token: "sk-LEAKED-VALUE",
          },
        }),
        receipt(2, "succeeded", {
          before: {
            server: "docs",
            allowed_tools: ["mcp__docs__read"],
            credential_refs: ["docs-key"],
          },
          after: { server: null, allowed_tools: [], credential_refs: [] },
        }),
        receipt(3, "failed", {}),
      ],
    });
    await releasedTwice(server);
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const table = await screen.findByRole("table");
    const rows = () =>
      [
        ...screen.getByRole("table").querySelectorAll('[data-kind="access"]'),
      ] as HTMLElement[];
    await waitFor(() => expect(rows()).toHaveLength(2));
    const [second, first] = rows();
    expect(first?.textContent).toContain("MCP 설정 저장");
    expect(first?.textContent).toContain("새 릴리스를 만들지 않습니다.");
    expect(first?.textContent).not.toContain("저장소와 GitHub");
    expect(first?.textContent).toContain("처음 저장");
    expect(first?.textContent).toContain(
      "이후: 서버 docs · 도구 mcp__docs__read · 자격 증명 docs-key",
    );
    expect(second?.textContent).toContain(
      "이전: 서버 docs · 도구 mcp__docs__read · 자격 증명 docs-key",
    );
    expect(second?.textContent).toContain(
      "이후: 서버 없음 · 도구 없음 · 자격 증명 없음",
    );
    expect(table.textContent).not.toContain("sk-LEAKED-VALUE");
    expect(within(first as HTMLElement).queryByRole("button")).toBeNull();
  });

  test("GitHub 기록을 못 읽어도 릴리스 기록은 그대로 보인다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}/github/activity`]: () =>
        apiError(403, "FORBIDDEN", "No access"),
    });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(table.querySelector('[data-kind="access"]')).toBeNull();
  });
  test("릴리스마다 직전 릴리스 대비 바뀐 것을 보이고, 자격 증명은 값 없이 변경됨으로만 보이며 카드의 이름은 싣지 않는다", async () => {
    const user = await setupUser();
    const server = agentServer();
    await seedRelease(server);
    const first = server.versions[0] as (typeof server.versions)[number];
    server.versions.push({
      ...first,
      id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      version_no: 2,
      content_sha256: "f".repeat(64),
      card: {
        ...first.card,
        capabilities: {
          ...first.card.capabilities,
          credential_refs: ["github-token"],
        },
      },
    });
    await seedRelease(server);
    const [older, newer] = server.releases as [
      (typeof server.releases)[number],
      (typeof server.releases)[number],
    ];
    const github = {
      push_approval: true,
      features: {
        workflows: false,
        actions: false,
        checks: false,
        issues: false,
        review: true,
      },
      actions_allow: [],
    };
    Object.assign(older, {
      runtime_config_snapshot: { env_ref: "env:OLD_SECRET_NAME" },
      policy_pins: { github: { ...github, repositories: ["sample-app"] } },
    });
    Object.assign(newer, {
      runtime_config_snapshot: { env_ref: "env:NEW_SECRET_NAME" },
      policy_pins: {
        github: { ...github, repositories: ["sample-app", "agent-skills"] },
      },
    });
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const table = await screen.findByRole("table");
    const [newRow, oldRow] = within(table).getAllByRole("row").slice(1) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(within(oldRow).getByText("첫 릴리스")).toBeTruthy();
    await user.click(
      within(newRow).getByRole("button", {
        name: "바뀐 것: 허용 저장소 · 자격 증명",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: `${newer.label}에서 바뀐 것`,
    });
    const repositories = within(dialog).getByRole("region", {
      name: "허용 저장소",
    });
    expect(within(repositories).getByText("+ agent-skills")).toBeTruthy();
    const secrets = within(dialog).getByRole("region", { name: "자격 증명" });
    expect(within(secrets).getAllByText("변경됨")).toHaveLength(1);
    for (const value of ["OLD_SECRET_NAME", "NEW_SECRET_NAME", "github-token"])
      expect(dialog.textContent).not.toContain(value);
    expect(within(dialog).queryByText("자격 증명 이름")).toBeNull();
    expect(dialog.textContent).toContain(`직전 릴리스 ${older.label}와 비교`);
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      document.activeElement ===
        within(newRow).getByRole("button", {
          name: "바뀐 것: 허용 저장소 · 자격 증명",
        }),
    ).toBe(true);
  });
  test("카드를 저장하면 릴리스 탭의 기록이 새 릴리스를 보인다", async () => {
    const server = agentServer();
    await seedRelease(server);
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(
      "저장하고 새 세션에 적용했습니다. 카드는 버전 2입니다.",
    );
    await showTab(user, "릴리스");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(server.releases).toHaveLength(2);
  });
});

describe("두 탭 동시 되돌리기", () => {
  const confirmRollback = async (user: User) =>
    user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "되돌리기",
      }),
    );

  test("늦은 탭은 덮어쓰지 않고(409) 재조회와 차이를 안내한 뒤에야 다시 되돌린다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const [first, second] = server.releases;
    // The fake server makes its releases a minute apart from 10:00 in Seoul.
    const label = (no: number) =>
      `릴리스 2026-10-11_10:0${no - 1}:00 · ${CONNECTION}`;
    const rollbackTo = (no: number) => ({
      name: `${label(no)}(으)로 되돌리기`,
    });

    const tabA = renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const tabB = renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const a = within(tabA.container);
    const b = within(tabB.container);
    const user = await setupUser();
    const rollbackB = await b.findByRole("button", rollbackTo(1));
    await user.click(await a.findByRole("button", rollbackTo(1)));
    await confirmRollback(user);
    expect(await a.findByText(/되돌렸습니다/)).toBeDefined();

    await user.click(rollbackB);
    await confirmRollback(user);
    const conflict = await b.findByText(
      "다른 곳에서 활성 릴리스를 먼저 바꿨습니다",
    );
    const panel = conflict.closest("section") as HTMLElement;
    expect(panel.textContent).toContain("덮어쓰지 않고 멈췄습니다");
    // The refusal shows by the button that caused it and takes focus.
    expect(
      b
        .getByRole("heading", { name: "릴리스", level: 2 })
        .closest("section")
        ?.contains(panel),
    ).toBe(true);
    expect(document.activeElement?.contains(panel)).toBe(true);
    expect(b.queryByText(/되돌렸습니다/)).toBeNull();
    const fromB = tabB.api.calls.filter((c) => c.path.endsWith("/activate"));
    expect(fromB).toHaveLength(1);
    expect(fromB[0]?.body).toEqual({
      release_id: first?.id,
      expected_revision: 1,
    });

    await user.click(
      within(panel).getByRole("button", { name: "최신 상태 불러오기" }),
    );
    expect(
      await b.findByText(
        `보던 화면의 활성 릴리스: ${label(2)}. 지금 활성 릴리스: ${label(1)}. 아래 차이를 확인하고 필요하면 다시 활성화하세요.`,
      ),
    ).toBeDefined();
    expect(b.getByText(`${label(2)} → ${label(1)}`)).toBeDefined();

    // Release 2 is now newer than the active one, so it is turned on.
    await user.click(
      await b.findByRole("button", { name: `${label(2)} 켜기` }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "켜기",
      }),
    );
    expect(
      await b.findByText(new RegExp(`${label(2)}을\\(를\\) 켰습니다`)),
    ).toBeDefined();
    const retry = tabB.api.calls.filter((c) => c.path.endsWith("/activate"));
    expect(retry.at(-1)?.body).toEqual({
      release_id: second?.id,
      expected_revision: 2,
    });
    expect(server.detail().agent.active_release_id).toBe(second?.id ?? "");
  });
});

describe("릴리스 되돌리기", () => {
  const rollbackButton = async () =>
    (
      await screen.findAllByRole("button", { name: /\(으\)로 되돌리기$/ })
    )[0] as HTMLElement;

  async function openConfirm(user: User) {
    await user.click(await rollbackButton());
    return within(await screen.findByRole("dialog"));
  }

  test("확인 창은 되돌릴 릴리스의 모델 연결을 보이고, 저장소 설정은 되돌리지 않는다고 알린다", async () => {
    const server = agentServer();
    await seedRelease(server);
    const first = server.versions[0] as (typeof server.versions)[number];
    server.versions.push({
      ...first,
      id: SECOND_VERSION,
      version_no: 2,
      content_sha256: "f".repeat(64),
      card: { ...CARD, model: "claude-haiku-5" },
    });
    await seedRelease(server, { connection: "anthropic-fast" });
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const dialog = await openConfirm(user);
    expect(dialog.getByText("모델 연결: anthropic-main")).toBeDefined();
    expect(
      dialog.getByText("저장소와 GitHub 설정은 지금 그대로입니다."),
    ).toBeDefined();
    expect(dialog.getByText(/연결이 꺼졌거나/)).toBeDefined();
  });

  test("결과 줄은 되돌린 뒤 서버에서 다시 읽고 저장소 설정은 그대로라고 알린다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const { api } = renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await user.click(await rollbackButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "되돌리기",
      }),
    );
    const line = await screen.findByText(/되돌렸습니다/);
    expect(line.textContent).toContain(
      "저장소와 GitHub 설정은 지금 그대로입니다.",
    );
    const order = api.calls.map((c) => `${c.method} ${c.path}`);
    const at = order.indexOf(`POST /v1/agents/${AGENT_ID}/activate`);
    expect(order.slice(at + 1)).toContain(`GET /v1/agents/${AGENT_ID}`);
  });

  const ACTIVATE = `POST /v1/agents/${AGENT_ID}/activate`;
  const DETAIL_READ = `GET /v1/agents/${AGENT_ID}`;
  type Answer = (request: Request) => Response | Promise<Response>;

  async function confirmRollback(user: User) {
    await user.click(await rollbackButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "되돌리기",
      }),
    );
  }

  test("진행 중이던 상세 읽기가 있어도 결과 줄은 되돌린 뒤 새로 읽은 값으로 만든다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const read = server.routes[DETAIL_READ] as Answer;
    let hold = false;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { services } = renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      // The held read answers with the state from before the rollback.
      [DETAIL_READ]: async (request) => {
        const answer = await read(request);
        if (hold) {
          hold = false;
          await gate;
        }
        return answer;
      },
    });
    const user = await setupUser();
    await rollbackButton();
    // The agent detail is the cached query whose answer lists releases.
    const detail = services.queryClient
      .getQueryCache()
      .findAll()
      .find((query) =>
        Array.isArray((query.state.data as AgentDetail)?.releases),
      );
    if (!detail) throw new Error("the agent detail is not cached");
    hold = true;
    void services.queryClient.refetchQueries({
      queryKey: detail.queryKey,
      exact: true,
    });
    await confirmRollback(user);
    const line = await screen.findByText(/되돌렸습니다/);
    expect(line.textContent).toContain("저장소와 GitHub 설정은");
    open();
  });

  test("응답이 사라져도 서버가 되돌렸으면 다시 읽어 되돌렸다고 말한다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const activate = server.routes[ACTIVATE] as Answer;
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [ACTIVATE]: async (request) => {
        await activate(request);
        throw new TypeError("Failed to fetch");
      },
    });
    await confirmRollback(await setupUser());
    const line = await screen.findByText(/되돌렸습니다/);
    expect(line.textContent).toContain("저장소와 GitHub 설정은");
    expect(screen.queryByText(/되돌리지 않았습니다/) === null).toBe(true);
  });

  test("응답이 사라지고 서버도 되돌리지 않았으면 되돌리지 않았다고 말한다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [ACTIVATE]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await confirmRollback(await setupUser());
    expect(await screen.findByText(/되돌리지 않았습니다/)).toBeDefined();
    expect(screen.queryByText(/되돌렸습니다/) === null).toBe(true);
  });

  test("응답이 사라진 사이 다른 릴리스로 또 바뀌었으면 유지됐다고 단정하지 않는다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const activate = server.routes[ACTIVATE] as Answer;
    const read = server.routes[DETAIL_READ] as Answer;
    const detailOf = async () =>
      (await (await read(new Request("https://console.test/"))).json()) as {
        agent: AgentDetail["agent"];
      };
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [ACTIVATE]: async (request) => {
        const was = (await detailOf()).agent;
        await activate(request);
        // Another admin re-activates the old release before the page re-reads.
        await activate(
          new Request("https://console.test/", {
            method: "POST",
            body: JSON.stringify({
              release_id: was.active_release_id,
              expected_revision: was.activation_revision + 1,
            }),
          }),
        );
        throw new TypeError("Failed to fetch");
      },
    });
    await confirmRollback(await setupUser());
    expect(await screen.findByText(/그 사이 활성 릴리스가/)).toBeDefined();
    expect(screen.queryByText(/되돌리지 않았습니다/) === null).toBe(true);
    expect(screen.queryByText(/되돌렸습니다/) === null).toBe(true);
  });

  test("응답이 사라진 뒤 상세 읽기가 계속 실패해도 확인하지 못했다는 안내는 화면에 남는다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const activate = server.routes[ACTIVATE] as Answer;
    const read = server.routes[DETAIL_READ] as Answer;
    let lost = false;
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [ACTIVATE]: async (request) => {
        await activate(request);
        lost = true;
        throw new TypeError("Failed to fetch");
      },
      [DETAIL_READ]: (request) => {
        if (!lost) return read(request);
        throw new TypeError("Failed to fetch");
      },
    });
    await confirmRollback(await setupUser());
    expect(
      await screen.findByText(/되돌렸는지 확인하지 못했습니다/),
    ).toBeDefined();
    expect(screen.queryByText(/되돌렸습니다/) === null).toBe(true);
  });

  test("응답이 사라지고 상태도 다시 읽지 못하면 되돌렸는지 확인하지 못했다고 말한다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const activate = server.routes[ACTIVATE] as Answer;
    const read = server.routes[DETAIL_READ] as Answer;
    let failNextRead = false;
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [ACTIVATE]: async (request) => {
        await activate(request);
        failNextRead = true;
        throw new TypeError("Failed to fetch");
      },
      [DETAIL_READ]: (request) => {
        if (!failNextRead) return read(request);
        failNextRead = false;
        throw new TypeError("Failed to fetch");
      },
    });
    await confirmRollback(await setupUser());
    expect(await screen.findByText(/확인하지 못했습니다/)).toBeDefined();
    expect(screen.queryByText(/되돌리지 않았습니다/) === null).toBe(true);
    expect(screen.queryByText(/되돌렸습니다/) === null).toBe(true);
  });

  test("되돌린 뒤 다시 읽지 못하면 확인하지 못했다고 하고 값을 지어내지 않는다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const read = server.routes[`GET /v1/agents/${AGENT_ID}`];
    let activated = false;
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [`POST /v1/agents/${AGENT_ID}/activate`]: async (request: Request) => {
        const answer =
          await server.routes[`POST /v1/agents/${AGENT_ID}/activate`](request);
        activated = true;
        return answer;
      },
      [`GET /v1/agents/${AGENT_ID}`]: () => {
        if (!activated) return read();
        activated = false;
        return apiError(503, "BACKEND_UNAVAILABLE", "unreachable");
      },
    });
    const user = await setupUser();
    await user.click(await rollbackButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "되돌리기",
      }),
    );
    const line = await screen.findByText(/되돌렸습니다/);
    expect(line.textContent).toContain("결과는 확인하지 못했습니다");
  });

  test("거절되면 이유와 함께 지금 설정이 유지된다고 알린다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    const { api } = renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [`POST /v1/agents/${AGENT_ID}/activate`]: () =>
        apiError(
          422,
          "UNSUPPORTED_CAPABILITY",
          "card.model: model claude-sonnet-5 is not a model of connection anthropic-fast",
        ),
    });
    const user = await setupUser();
    await user.click(await rollbackButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "되돌리기",
      }),
    );
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toContain(
      "카드 모델 claude-sonnet-5을(를) 연결 anthropic-fast이(가) 제공하지 않아",
    );
    expect(refusal.textContent).toContain(
      "되돌리지 않았습니다. 지금 설정이 유지됩니다.",
    );
    expect(document.body.textContent).not.toContain("is not a model of");
    expect(server.detail().agent.active_release_id).toBe(
      server.releases[1]?.id ?? "missing",
    );
    expect(api.calls.filter((c) => c.path.endsWith("/activate"))).toHaveLength(
      1,
    );
  });
});

describe("편집 중 다른 곳의 저장", () => {
  function otherTabSaves(
    server: ReturnType<typeof agentServer>,
    saved: Partial<AgentCard> = { role: "다른 탭이 고친 역할" },
  ) {
    server.versions.push({
      ...(server.versions[0] as (typeof server.versions)[number]),
      id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      version_no: 2,
      card: { ...CARD, ...saved },
      content_sha256: "e".repeat(64),
    });
  }

  test("고치던 내용은 재조회로 사라지지 않고, 최신이 생겼다고 알린 뒤 원할 때만 불러온다", async () => {
    const server = agentServer();
    const { services } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    otherTabSaves(server);
    await services.queryClient.invalidateQueries({
      queryKey: keys.agent(AGENT_ID),
    });
    expect(
      await screen.findByText(
        "다른 곳에서 카드를 저장해 최신이 버전 2입니다. 고치던 내용은 그대로 두었습니다. 이대로 저장하면 이 내용이 다음 버전이 됩니다.",
      ),
    ).toBeDefined();
    expect(
      (screen.getByLabelText("답변 언어") as HTMLSelectElement).value,
    ).toBe("en");
    await user.click(
      screen.getByRole("button", { name: "최신 카드 불러오기" }),
    );
    expect(
      (screen.getByLabelText("답변 언어") as HTMLSelectElement).value,
    ).toBe(CARD.language);
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });

  test("카드 편집에서 고른 연결로 저장하면 그 연결로 릴리스한다", async () => {
    const server = agentServer();
    await seedRelease(server);
    const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    const card = screen.getByRole("tabpanel", { name: "상세 설정" });
    const cardConnection = (await within(card).findByLabelText(
      "모델 연결",
    )) as HTMLSelectElement;
    expect(cardConnection.value).toBe(CONNECTION);
    await user.selectOptions(cardConnection, "anthropic-fast");
    await user.selectOptions(
      within(card).getByLabelText("모델"),
      "claude-haiku-5",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(
      "저장하고 새 세션에 적용했습니다. 카드는 버전 2입니다.",
    );
    expect(
      (api.calls.find((c) => c.method === "PATCH")?.body as object) ?? {},
    ).toMatchObject({ connection_id: "anthropic-fast" });
    expect(server.releases.at(-1)?.connection_id).toBe("anthropic-fast");
  });

  describe("연결을 고른 저장", () => {
    test("이름과 함께 연결만 바꿔도 연결이 요청에 실린다", async () => {
      const server = agentServer();
      const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
      const user = await setupUser();
      await openCardEditor(user);
      const card = screen.getByRole("tabpanel", { name: "상세 설정" });
      await user.selectOptions(
        await within(card).findByLabelText("모델 연결"),
        "anthropic-fast",
      );
      const name = within(card).getByLabelText("이름");
      await user.clear(name);
      await user.type(name, "새 이름");
      await user.click(screen.getByRole("button", { name: "저장" }));
      await waitFor(() =>
        expect(api.calls.some((c) => c.method === "PATCH")).toBe(true),
      );
      const body = api.calls.find((c) => c.method === "PATCH")?.body as {
        name?: string;
        connection_id?: string;
      };
      expect(body.name).toBe("새 이름");
      expect(body.connection_id).toBe("anthropic-fast");
    });

    test("적용하지 못한 저장을 고치면 그 저장의 연결로 보낸다", async () => {
      const server = agentServer();
      const waiting = () => {
        const body = server.detail();
        return {
          ...body,
          draft: {
            version_id: body.versions[0]?.id as string,
            connection_id: "anthropic-fast",
            failure: "release_refused",
          },
        };
      };
      const { api } = renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        [`GET /v1/agents/${AGENT_ID}`]: () => json(200, waiting()),
      });
      const user = await setupUser();
      await openCardEditor(user);
      await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
      await user.click(screen.getByRole("button", { name: "저장" }));
      await waitFor(() =>
        expect(api.calls.some((c) => c.method === "PATCH")).toBe(true),
      );
      const body = api.calls.find((c) => c.method === "PATCH")?.body as {
        connection_id?: string;
      };
      expect(body.connection_id).toBe("anthropic-fast");
    });

    test("버리기는 활성 릴리스의 연결로 지금 카드를 다시 저장한다", async () => {
      const server = agentServer();
      await seedRelease(server);
      const withDraft = () => {
        const body = server.detail();
        return {
          ...body,
          draft: {
            version_id: body.versions[0]?.id as string,
            connection_id: "anthropic-fast",
            failure: "release_refused",
          },
        };
      };
      const { api } = renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        [`GET /v1/agents/${AGENT_ID}`]: () => json(200, withDraft()),
      });
      const user = await setupUser();
      await user.click(await screen.findByRole("button", { name: "버리기" }));
      await waitFor(() =>
        expect(api.calls.some((c) => c.method === "PATCH")).toBe(true),
      );
      expect(
        (
          api.calls.find((c) => c.method === "PATCH")?.body as {
            connection_id?: string;
          }
        ).connection_id,
      ).toBe(CONNECTION);
    });

    test("서버가 모델을 바꿔 적은 카드로 적용되면 안내는 그 릴리스의 버전을 가리킨다", async () => {
      const server = agentServer();
      const first = server.versions[0] as (typeof server.versions)[number];
      renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        [`PATCH /v1/agents/${AGENT_ID}`]: async () => {
          server.versions.push({
            ...first,
            id: crypto.randomUUID(),
            version_no: 2,
            card: { ...first.card, model: "claude-haiku-5" },
          });
          await seedRelease(server);
          const body = server.detail();
          return json(200, {
            ...body,
            release: {
              status: "applied",
              reason: null,
              release_id: body.releases[0]?.id,
              version_id: body.versions.at(-1)?.id,
            },
          });
        },
      });
      const user = await setupUser();
      await openCardEditor(user);
      // Only the connection changes, so the card sent is the first version's.
      const card = screen.getByRole("tabpanel", { name: "상세 설정" });
      await user.selectOptions(
        await within(card).findByLabelText("모델 연결"),
        "anthropic-fast",
      );
      await user.click(screen.getByRole("button", { name: "저장" }));
      expect(
        await screen.findByText(
          /저장하고 새 세션에 적용했습니다\. 카드는 버전 2입니다/,
        ),
      ).toBeDefined();
    });
  });

  test("모델 안내는 고른 연결이 제공하는 모델만 고를 수 있다고 말하고 내부 파일 이름을 보이지 않는다", async () => {
    const server = agentServer();
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const user = await setupUser();
    await openCardEditor(user);
    const describedBy = (field: HTMLElement) =>
      (field.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(describedBy(await screen.findByLabelText("모델"))).toContain(
      "고른 연결이 제공하는 모델 중에서 고릅니다",
    );
    expect(describedBy(await screen.findByLabelText("모델"))).not.toContain(
      "릴리스",
    );
  });

  test("연결이 제공하지 않는 모델로 거부된 저장은 영어 원문 없이 한국어로 알린다", async () => {
    const server = agentServer();
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: () =>
        json(200, {
          ...server.detail(),
          release: {
            status: "failed",
            reason: "model_not_in_connection",
            release_id: null,
            version_id: null,
          },
        }),
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const refusal = await screen.findByText(/적용하지 못했습니다/);
    expect(refusal.textContent).toContain("연결이 제공하지 않는 모델입니다");
    expect(document.body.textContent).not.toContain("model_not_in_connection");
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  test("연결 목록을 못 읽으면 이유를 보이고 저장하지 못하게 한다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      "GET /v1/connections": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "The catalog cannot be read"),
    });
    const user = await setupUser();
    await openCardEditor(user);
    expect(
      (await screen.findAllByRole("alert")).map((a) => a.textContent),
    ).toContainEqual(
      expect.stringContaining("모델 목록을 불러오지 못해 저장할 수 없습니다"),
    );
    expect(
      (screen.getByRole("button", { name: "저장" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByLabelText("모델 연결")).toBeNull();
    expect(screen.queryByLabelText("모델")).toBeNull();
  });

  test("카탈로그에 없는 카드 모델은 '카탈로그에 없음'으로 남고, 손대지 않으면 그대로 저장한다", async () => {
    const server = agentServer();
    const legacy = (body: ReturnType<typeof server.detail>) => ({
      ...body,
      versions: body.versions.map((v) => ({
        ...v,
        card: { ...v.card, model: "claude-legacy-4" },
      })),
    });
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: () => json(200, legacy(server.detail())),
      [`PATCH /v1/agents/${AGENT_ID}`]: () =>
        json(200, {
          ...legacy(server.detail()),
          release: {
            status: "unchanged",
            reason: null,
            release_id: null,
            version_id: null,
          },
        }),
    });
    const user = await setupUser();
    await openCardEditor(user);
    const model = (await screen.findByLabelText("모델")) as HTMLSelectElement;
    expect(model.getAttribute("data-slot")).toBe("native-select");
    expect(model.value).toBe("claude-legacy-4");
    expect(model.selectedOptions[0]?.textContent).toBe(
      "claude-legacy-4 · 카탈로그에 없음",
    );
    const described = (model.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("카탈로그에 없어");
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { card: { model: string } }).card.model).toBe(
      "claude-legacy-4",
    );
  });

  test("저장 응답을 기다리는 동안 이어서 쓴 내용은 응답이 와도 남는다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        await gate;
        return patch ? patch(request) : json(500, {});
      },
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    // Changed again while the save is in flight.
    await user.selectOptions(screen.getByLabelText("답변 언어"), "ko");
    release();
    expect(await screen.findByText(/저장했습니다 — 버전 2/)).toBeDefined();
    expect(
      (screen.getByLabelText("답변 언어") as HTMLSelectElement).value,
    ).toBe("ko");
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });

  test("저장 중 다른 곳에서 바꾼 이름은 손대지 않은 칸에 들어오고, 다음 저장이 되돌리지 않는다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    if (!patch) throw new Error("no PATCH route");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        if (held) {
          held = false;
          await gate;
        }
        return patch(request);
      },
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.selectOptions(screen.getByLabelText("답변 언어"), "ko");
    // Another tab renames the agent while the save is in flight.
    await patch(
      new Request("http://test/", {
        method: "PATCH",
        body: JSON.stringify({ name: "다른 곳 이름" }),
      }),
    );
    release();
    await screen.findByText(/저장했습니다 — 버전 2/);
    expect((screen.getByLabelText("이름") as HTMLInputElement).value).toBe(
      "다른 곳 이름",
    );
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(2),
    );
    const last = api.calls.filter((c) => c.method === "PATCH").at(-1);
    expect(last?.body).not.toHaveProperty("name");
    // The language chosen while the first save was in flight is what goes.
    expect((last?.body as { card: { language: string } }).card.language).toBe(
      "ko",
    );
  });

  test("저장 중 원래 이름으로 되돌린 입력은 응답이 와도 남고, 다음 저장이 그 이름을 보낸다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    if (!patch) throw new Error("no PATCH route");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        if (held) {
          held = false;
          await gate;
        }
        return patch(request);
      },
    });
    const user = await setupUser();
    await openCardEditor(user);
    const name = screen.getByLabelText("이름") as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "새 이름");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.clear(name);
    await user.type(name, "결제 담당");
    release();
    await screen.findByText(
      "이름과 설명을 저장했습니다. 바로 반영되고 새 버전은 생기지 않았습니다.",
    );
    expect((screen.getByLabelText("이름") as HTMLInputElement).value).toBe(
      "결제 담당",
    );
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(2),
    );
    expect(api.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
      name: "결제 담당",
    });
  });

  test("모델 목록을 못 불러와도 이름·설명만 고친 저장은 막지 않는다", async () => {
    const server = agentServer();
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      "GET /v1/connections": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "The catalog cannot be read"),
    });
    const user = await setupUser();
    await openCardEditor(user);
    const save = screen.getByRole("button", {
      name: "저장",
    }) as HTMLButtonElement;
    await user.type(screen.getByLabelText("설명"), DESCRIPTION);
    expect(save.disabled).toBe(false);
    await user.click(save);
    await screen.findByText(
      "이름과 설명을 저장했습니다. 바로 반영되고 새 버전은 생기지 않았습니다.",
    );
    expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({
      description: DESCRIPTION,
    });
  });

  test("다른 에이전트로 옮기면 이전 에이전트의 편집을 들고 가지 않는다", async () => {
    const server = agentServer();
    const OTHER = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
    const other = server.detail();
    const otherDetail = {
      ...other,
      agent: { ...other.agent, id: OTHER, slug: "refund", name: "환불 담당" },
      versions: other.versions.map((v) => ({
        ...v,
        agent_id: OTHER,
        card: { ...CARD, role: "환불 문의 담당" },
      })),
    };
    const { api, history } = renderAt(`/agents/${OTHER}?tab=card`, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${OTHER}`]: () => json(200, otherDetail),
      [`PATCH /v1/agents/${OTHER}`]: () =>
        json(200, {
          ...otherDetail,
          release: {
            status: "unchanged",
            reason: null,
            release_id: null,
            version_id: null,
          },
        }),
    });
    // Visit the other agent first so it is cached when we come back to it.
    await screen.findByRole("heading", { name: "환불 담당" });
    history.push(CARD_TAB);
    await screen.findByRole("heading", { name: "결제 담당" });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    history.push(`/agents/${OTHER}?tab=card`);
    await screen.findByRole("heading", { name: "환불 담당" });
    await openCardEditor(user);
    expect(
      (screen.getByLabelText("답변 언어") as HTMLSelectElement).value,
    ).toBe("ko");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`/v1/agents/${OTHER}`);
    expect(JSON.stringify(patch?.body)).not.toContain('"language":"en"');
  });

  test("카드만 고쳤으면 다른 곳의 이름 변경을 되돌리지 않는다", async () => {
    const server = agentServer();
    let renamed = false;
    const get = () => {
      const detail = server.detail();
      return json(200, {
        ...detail,
        agent: { ...detail.agent, name: renamed ? "청구 담당" : "결제 담당" },
      });
    };
    const { api, services } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: get,
    });
    const user = await setupUser();
    await openCardEditor(user);
    await user.selectOptions(await screen.findByLabelText("답변 언어"), "en");
    renamed = true;
    await services.queryClient.invalidateQueries({
      queryKey: keys.agent(AGENT_ID),
    });
    await screen.findByRole("heading", { name: "청구 담당" });
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).not.toHaveProperty("name");
  });

  test("고친 것이 없으면 최신 카드를 그대로 받아들인다", async () => {
    const server = agentServer();
    const { services } = renderAt(DETAIL, { ...meOk, ...server.routes });
    await openCardEditor(await setupUser());
    await screen.findByLabelText("답변 언어");
    otherTabSaves(server, { language: "en" });
    await services.queryClient.invalidateQueries({
      queryKey: keys.agent(AGENT_ID),
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("답변 언어") as HTMLSelectElement).value,
      ).toBe("en"),
    );
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });
});

describe("식별자와 상태 문구", () => {
  test("slug는 이름을 따라 채워지다가 직접 고치면 멈춘다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const slug = (await screen.findByLabelText("식별자")) as HTMLInputElement;
    expect(
      document.getElementById(slug.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("워크스페이스에서 겹칠 수 없고");
    await user.type(screen.getByLabelText("이름"), "Billing Bot 2");
    expect(slug.value).toBe("billing-bot-2");
    // What the name gives stays in sight beside the label.
    expect(screen.getByText("이름에서: billing-bot-2")).toBeDefined();
    await user.clear(slug);
    await user.type(slug, "pay");
    await user.type(screen.getByLabelText("이름"), "!");
    expect(slug.value).toBe("pay");
  });

  const describedAs = (
    server: ReturnType<typeof agentServer>,
    description: string | null,
    role?: string,
  ) => {
    const detail = server.detail();
    return {
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: () =>
        json(200, {
          ...detail,
          agent: { ...detail.agent, description },
          versions: detail.versions.map((v) => ({
            ...v,
            card: role === undefined ? v.card : { ...v.card, role },
          })),
        }),
    };
  };

  test("상세 머리는 상태 배지와 설명만 두고 식별자는 상세 설정 탭에 둔다", async () => {
    renderAt(DETAIL, { ...meOk, ...describedAs(agentServer(), DESCRIPTION) });
    const heading = await screen.findByRole("heading", { level: 1 });
    const head = heading.closest("[data-slot=page-header]") as HTMLElement;
    expect(within(head).getByText("미게시")).toBeDefined();
    expect(within(head).getByText(DESCRIPTION)).toBeDefined();
    expect(within(head).queryByText(/billing/)).toBeNull();
    const card = screen.getByRole("region", {
      name: "에이전트 카드",
      hidden: true,
    });
    expect(within(card).getByText("billing")).toBeDefined();
    expect(screen.queryByText(/000000000001/)).toBeNull();
  });

  const pageHead = async () =>
    (await screen.findByRole("heading", { level: 1 })).closest(
      "[data-slot=page-header]",
    ) as HTMLElement;

  test("설명이 없으면 카드의 이전 역할이 대신한다", async () => {
    renderAt(DETAIL, {
      ...meOk,
      ...describedAs(agentServer(), null, "옛 역할"),
    });
    expect(within(await pageHead()).getByText("옛 역할")).toBeDefined();
  });

  test("비운 설명은 이전 역할도 보이지 않는다", async () => {
    renderAt(DETAIL, {
      ...meOk,
      ...describedAs(agentServer(), "", "옛 역할"),
    });
    expect(within(await pageHead()).queryByText("옛 역할")).toBeNull();
  });
});

describe("새 에이전트: 브라우저 history", () => {
  const LEAVE_TITLE = "저장하지 않고 나갈까요?";
  const back = async () => {
    act(() => window.history.back());
    // happy-dom delivers popstate on a timer.
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  test("초안 저장 뒤 뒤로 가면 하는 일 → 이름 → 목록이고, 새로고침 뒤에도 같은 길이다", async () => {
    const server = agentServer();
    const { api, reload } = openInBrowser("/agents", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "새 에이전트" }),
    );
    await toJobStep(user);
    await fillJob(user);
    await atStep("미리 써 보기");
    expect(stepsInState()).toEqual(["name", "job", "preview"]);

    reload();
    await atStep("미리 써 보기");
    expect(stepsInState()).toEqual(["name", "job", "preview"]);
    await back();
    await atStep("하는 일");
    expect(stepsInState()).toEqual(["name", "job"]);
    await back();
    await atStep("이름");
    expect(stepsInState()).toEqual(["name"]);
    await back();
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    await screen.findByRole("link", { name: "결제 담당" });
    expect(screen.queryByText(LEAVE_TITLE)).toBeNull();
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
  });

  test("하는 일 입력은 저장하지 않아도 새로고침 뒤에 남는다", async () => {
    const { reload } = openInBrowser("/agents/new", {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.selectOptions(await screen.findByLabelText("모델"), CARD.model);
    await waitFor(() =>
      expect(JSON.stringify(window.history.state)).toContain(CARD.model),
    );

    reload();
    await atStep("하는 일");
    expect(
      ((await screen.findByLabelText("모델")) as HTMLSelectElement).value,
    ).toBe(CARD.model);
  });

  test("담당 팀을 묻기 전에 남겨 둔 하는 일 단계는 새로고침 뒤 처음부터 연다", async () => {
    const { api, reload } = openInBrowser("/agents/new", {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await waitFor(() => expect(stepsInState()).toContain("job"));
    const state = window.history.state as Record<string, unknown>;
    const histories = state["new-agent.histories"] as {
      context: Record<string, unknown>;
    }[];
    window.history.replaceState(
      {
        ...state,
        "new-agent.histories": histories.map(
          ({ context: { managing_team_id: _, ...context }, ...entry }) => ({
            ...entry,
            context,
          }),
        ),
      },
      "",
    );

    reload();
    await atStep("이름");
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("저장하지 않은 입력이 있으면 흐름을 떠나기 전에 묻고, 단계 사이 이동은 묻지 않는다", async () => {
    openInBrowser("/agents", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "새 에이전트" }),
    );
    await toJobStep(user);
    await user.selectOptions(await screen.findByLabelText("모델"), CARD.model);
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(true);

    await back();
    await atStep("이름");
    expect(screen.queryByText(LEAVE_TITLE)).toBeNull();
    await back();
    const dialog = await screen.findByRole("dialog", { name: LEAVE_TITLE });
    await user.click(within(dialog).getByRole("button", { name: "계속 쓰기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.pathname).toBe("/agents/new");
    await atStep("이름");

    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    expect((screen.getByLabelText("모델") as HTMLSelectElement).value).toBe(
      CARD.model,
    );
    await user.click(
      within(screen.getByRole("navigation", { name: "주요 메뉴" })).getByRole(
        "link",
        { name: "에이전트" },
      ),
    );
    await user.click(
      within(
        await screen.findByRole("dialog", { name: LEAVE_TITLE }),
      ).getByRole("button", { name: "나가기" }),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  });

  const unloadBlocked = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  test("저장한 뒤에는 묻지 않고 나간다: 앞뒤 공백을 다듬은 이름도 저장한 것으로 본다", async () => {
    openInBrowser("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "  결제 담당 ");
    await user.type(screen.getByLabelText("식별자"), "billing");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    await fillJob(user);
    await atStep("미리 써 보기");
    expect(unloadBlocked()).toBe(false);
    await user.click(screen.getByRole("link", { name: "나중에 게시" }));
    await waitFor(() => expect(window.location.pathname).toBe(DETAIL));
    expect(screen.queryByText(LEAVE_TITLE)).toBeNull();
  });

  test("남겨 둔 입력을 고친 직후 저장해도 새로고침 뒤에는 저장한 입력이 남는다", async () => {
    const { api, reload } = openInBrowser("/agents/new", {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.selectOptions(await screen.findByLabelText("모델"), CARD.model);
    await waitFor(() =>
      expect(JSON.stringify(window.history.state)).toContain(CARD.model),
    );
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    const sent = (posted(api, "/v1/agents") as { card: { language: string } })
      .card.language;
    expect(sent).toBe("en");

    reload();
    await atStep("미리 써 보기");
    expect(unloadBlocked()).toBe(false);
    await back();
    await atStep("하는 일");
    expect(
      (screen.getByLabelText("답변 언어") as HTMLSelectElement).value,
    ).toBe(sent);
  });
});

describe("새 에이전트: 고른 연결", () => {
  test("저장한 연결은 새로고침 뒤 하는 일 단계로 돌아와도 그대로 골라져 있다", async () => {
    const server = agentServer();
    const { api, reload } = openInBrowser("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.selectOptions(await connectionSelect(), "anthropic-fast");
    await user.selectOptions(
      await screen.findByLabelText("모델"),
      "claude-haiku-5",
    );
    await user.click(
      screen.getByRole("button", { name: "저장하고 미리 써 보기" }),
    );
    await atStep("미리 써 보기");
    expect(
      (posted(api, "/v1/agents") as { connection_id: string }).connection_id,
    ).toBe("anthropic-fast");

    reload();
    await atStep("미리 써 보기");
    act(() => window.history.back());
    await atStep("하는 일");
    expect((await connectionSelect()).value).toBe("anthropic-fast");
  });
});

describe("에이전트 머리 경로", () => {
  const trail = async () => {
    const [header] = await screen.findAllByRole("banner");
    return within(header as HTMLElement);
  };

  test("상세는 에이전트 목록 링크 다음에 이름이 온다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const bar = await trail();
    expect(await bar.findByText("결제 담당")).toBeDefined();
    expect(
      bar.getByRole("link", { name: "에이전트" }).getAttribute("href"),
    ).toBe("/agents");
  });

  test("새 에이전트는 주소 끝에 /가 붙어도 화면 제목을 쓴다", async () => {
    renderAt("/agents/new/", { ...meOk, ...agentServer().routes });
    const bar = await trail();
    expect(await bar.findByText("새 에이전트")).toBeDefined();
  });
});
