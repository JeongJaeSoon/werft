import { describe, expect, setSystemTime, test } from "bun:test";
import {
  type Agent,
  type ApiKeyView,
  agentSchema,
  apiKeyViewSchema,
  createApiKeyResponseSchema,
  SESSION_SCOPE_VALUES,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiKeysEn, apiKeysKo } from "../i18n/api-keys.ts";
import {
  apiError,
  json,
  keys,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const AGENT_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER_AGENT_ID = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
const KEY_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
// An agent the caller's agent list does not include.
const GONE_ID = "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c";
const RECEIPT_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
// Shaped only to pass the contract's length check; it reaches nothing.
const SECRET = `placeholder-value-${"0".repeat(32)}`;
const DAY = 24 * 60 * 60 * 1000;

const PERSONAL = "/settings/api-keys";
const NEW_PERSONAL = "/settings/api-keys/new";
const AGENTS = "/settings/api-keys/agents";
const NEW_AGENT = "/settings/api-keys/agents/new";
const ORG = "/settings/workspace/api-keys";

function agent(id: string, name: string): Agent {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    slug: name.toLowerCase(),
    name,
    description: null,
    managing_team_id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
    managing_team_name: "Finance",
    status: "active",
    active_release_id: null,
    activation_revision: -1,
    auto_model_migration: true,
    created_by: USER_ID,
    created_at: "2026-10-11T00:00:00.000Z",
    updated_at: "2026-10-11T00:00:00.000Z",
  };
}
const mine = agent(AGENT_ID, "Billing");
const theirs = agent(OTHER_AGENT_ID, "Support");

function key(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: KEY_ID,
    kind: "agent",
    name: null,
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_ID,
    created_by: USER_ID,
    created_by_user: null,
    scopes: ["sessions:read"],
    created_at: "2026-10-11T00:00:00.000Z",
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    ...overrides,
  };
}

function issued(view: ApiKeyView) {
  return { key: view, secret: SECRET, receipt_id: RECEIPT_ID };
}

/** A stateful keys API: issuing adds to the list, revoking marks the row. */
function keysServer(initial: ApiKeyView[] = []) {
  let items = [...initial];
  return {
    "GET /v1/api-keys": () => json(200, { items, next_cursor: null }),
    "POST /v1/api-keys": async (request: Request) => {
      const body = (await request.json()) as {
        kind: ApiKeyView["kind"];
        name?: string;
        scopes: ApiKeyView["scopes"];
        agent_id?: string;
        expires_at?: string;
      };
      const view = key({
        id: crypto.randomUUID(),
        kind: body.kind,
        name: body.name ?? null,
        agent_id: body.agent_id ?? null,
        scopes: body.scopes,
        expires_at: body.expires_at ?? null,
      });
      items = [view, ...items];
      return json(201, issued(view));
    },
    [`DELETE /v1/api-keys/${KEY_ID}`]: () => {
      items = items.map((item) =>
        item.id === KEY_ID
          ? { ...item, revoked_at: "2026-10-11T01:00:00.000Z" }
          : item,
      );
      return json(200, {
        key: items.find((item) => item.id === KEY_ID),
        receipt_id: RECEIPT_ID,
      });
    },
  };
}

const memberOk = {
  "GET /v1/auth/me": () => json(200, memberMe()),
  "GET /v1/administered-agents": () => json(200, { items: [mine] }),
};
const ownerOk = {
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/agents": () =>
    json(200, { items: [mine, theirs], next_cursor: null }),
};

const rows = () =>
  screen.getAllByRole("listitem").filter((li) => li.dataset.revoked);

const agentOptions = () =>
  screen.queryAllByRole("option").map((option) => option.textContent);

/** Opens the agent picker and takes the agent by name, as a person does. */
async function chooseAgent(
  user: Awaited<ReturnType<typeof setupUser>>,
  name: string,
) {
  const picker = await screen.findByRole("combobox", { name: "에이전트" });
  await user.click(picker);
  await user.click(
    await screen.findByRole("option", { name: new RegExp(`^${name}`) }),
  );
}
const badgeOf = (row: HTMLElement) =>
  row.querySelector("[data-slot=badge]") as HTMLElement;

describe("API key", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(agentSchema.safeParse(mine).success).toBe(true);
    expect(apiKeyViewSchema.safeParse(key()).success).toBe(true);
    expect(createApiKeyResponseSchema.safeParse(issued(key())).success).toBe(
      true,
    );
  });

  test("개인 key 화면은 개인 key만 보이고, 목록 아래 안내 상자에서 개인 key를 설명한다", async () => {
    renderAt(PERSONAL, {
      ...ownerOk,
      ...keysServer([
        key(),
        key({
          id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
          kind: "personal",
          agent_id: null,
        }),
      ]),
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "API 키" }),
    ).toBeDefined();
    await screen.findByText("4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a");
    expect(rows().map((row) => badgeOf(row).textContent)).toEqual(["개인 키"]);
    const guide = screen.getByTestId("guide-personal");
    expect(
      within(guide)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      apiKeysKo["apiKeys.guide.personal.actsAs"],
      apiKeysKo["apiKeys.guide.personal.issuerLeaves"],
      apiKeysKo["apiKeys.guide.personal.sessions"],
      apiKeysKo["apiKeys.guide.personal.approve"],
    ]);
    expect(screen.queryByTestId("guide-agent")).toBeNull();
    const docs = within(screen.getByRole("region", { name: "키 종류" }))
      .getAllByRole("link")
      .find((link) =>
        link.textContent?.startsWith(apiKeysKo["apiKeys.docsLink"]),
      );
    if (!docs) throw new Error("no API reference link in the guide");
    expect(docs.textContent).toContain(apiKeysKo["apiKeys.docsNewTab"]);
    expect(docs.getAttribute("href")).toBe("/docs");
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toContain("noopener");
    // The list comes before the guide.
    const list = screen.getByRole("list", { name: "발급된 키" });
    expect(
      list.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("목록이 여러 페이지면 다음 페이지까지 이어 읽어 모두 보인다", async () => {
    const second = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
    const { api } = renderAt(PERSONAL, {
      ...ownerOk,
      "GET /v1/api-keys": (request: Request) =>
        new URL(request.url).searchParams.get("cursor") === "page-2"
          ? json(200, {
              items: [key({ id: second, kind: "personal", agent_id: null })],
              next_cursor: null,
            })
          : json(200, {
              items: [key({ kind: "personal", agent_id: null })],
              next_cursor: "page-2",
            }),
    });
    await screen.findByText(second);
    expect(screen.getByText(KEY_ID)).toBeDefined();
    expect(
      api.calls
        .filter((c) => c.method === "GET" && c.path === "/v1/api-keys")
        .map((c) => c.search),
    ).toEqual(["?limit=100", "?cursor=page-2&limit=100"]);
  });

  test("에이전트 key 화면은 에이전트와 이름으로 key를 보이고, 이름 없는 key는 그렇다고 하며 승인 배지는 범위에서 읽는다", async () => {
    const { api } = renderAt(AGENTS, {
      ...ownerOk,
      ...keysServer([
        key(),
        key({
          id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
          name: "ci-deploy",
          scopes: ["sessions:read", "sessions:approve"],
        }),
        key({
          id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
          kind: "personal",
          agent_id: null,
        }),
        key({ id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", agent_id: GONE_ID }),
      ]),
    });
    await screen.findByText("Billing · 이름 없음");
    const listed = rows();
    expect(listed.map((row) => badgeOf(row).textContent)).toEqual([
      "에이전트 키",
      "에이전트 키",
      "에이전트 키",
    ]);
    expect(
      within(listed[1] as HTMLElement).getByText("Billing · ci-deploy"),
    ).toBeDefined();
    // An agent this person cannot list still shows by its id.
    expect(
      within(listed[2] as HTMLElement).getByText(`${GONE_ID} · 이름 없음`),
    ).toBeDefined();
    // Names come from the keys' own agents, asked for once by id.
    expect(
      api.calls
        .filter((c) => c.path === "/v1/agents")
        .map((c) => new URLSearchParams(c.search).get("ids")?.split(",")),
    ).toEqual([[AGENT_ID, GONE_ID].sort()]);
    for (const row of listed) {
      expect(within(row).getByText(/^세션 보기/)).toBeDefined();
      expect(within(row).getByText("발급자가 떠나도 유효")).toBeDefined();
    }
    expect(
      listed.map(
        (row) =>
          (row.querySelector("[data-approve]") as HTMLElement).dataset.approve,
      ),
    ).toEqual(["false", "true", "false"]);
    expect(screen.getByTestId("guide-agent")).toBeDefined();
    expect(screen.queryByTestId("guide-personal")).toBeNull();
    expect(document.body.textContent).not.toContain("서비스 키");
  });

  test("탭은 개인 key · 에이전트 key 순서이고, 머리글은 같은 API key다", async () => {
    renderAt(PERSONAL, {
      ...ownerOk,
      ...keysServer([key({ kind: "personal", agent_id: null })]),
    });
    const nav = await screen.findByRole("navigation", { name: "키 목록" });
    // Counts wait for the list; the parent path is not current on its child.
    const personal = await within(nav).findByRole("link", {
      name: "개인 키 1개",
    });
    const agentTab = within(nav).getByRole("link", {
      name: "에이전트 키 0개",
    });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent?.replace(/ \d.*$/, "")),
    ).toEqual(["개인 키", "에이전트 키"]);
    expect(personal.getAttribute("aria-current")).toBe("page");
    expect(agentTab.getAttribute("aria-current")).toBeNull();
    const user = await setupUser();
    await user.click(agentTab);
    expect(
      await screen.findByText("아직 에이전트 키가 없습니다."),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { level: 1, name: "API 키" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "새 키" })).toBeDefined();
    // The personal list is the other lists' parent path; only the screen
    // being shown is current.
    expect(
      within(screen.getByRole("navigation", { name: "키 목록" }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-current")),
    ).toEqual([null, "page"]);
  });

  test("조직 관리 key는 워크스페이스 설정 아래에서 준비 중이라고만 하고 만들 길이 없다", async () => {
    const { history } = renderAt(PERSONAL, { ...ownerOk, ...keysServer() });
    const settings = await screen.findByRole("navigation", { name: "설정" });
    const user = await setupUser();
    await user.click(
      within(
        within(settings).getByRole("group", { name: "워크스페이스" }),
      ).getByRole("link", { name: "조직 관리 키" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "조직 관리 키" }),
    ).toBeDefined();
    expect(history.location.pathname).toBe(ORG);
    expect(screen.getByText(apiKeysKo["apiKeys.orgIntro"])).toBeDefined();
    expect(screen.getByText(apiKeysKo["apiKeys.orgPendingBody"])).toBeDefined();
    expect(screen.queryByRole("button", { name: "새 키" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "키 목록" })).toBeNull();
    expect(
      within(settings)
        .getByRole("link", { name: "조직 관리 키" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  test("조직 관리 key 자리는 서버가 api_key.manage를 준 사람에게만 보인다", async () => {
    renderAt(PERSONAL, { ...memberOk, ...keysServer() });
    const nav = await screen.findByRole("navigation", { name: "키 목록" });
    await within(nav).findByRole("link", { name: /^에이전트 키/ });
    expect(screen.queryByRole("link", { name: "조직 관리 키" })).toBeNull();
  });

  test("권한이 없는 사람이 조직 관리 key 주소로 오면 페이지 제목 아래에서 볼 권한이 없다고 한다", async () => {
    renderAt(ORG, { ...memberOk, ...keysServer() });
    expect(
      await screen.findByText("이 화면을 볼 권한이 없습니다"),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { level: 1, name: "조직 관리 키" }),
    ).toBeDefined();
    expect(screen.queryByText("준비 중입니다")).toBeNull();
  });

  test("key ID는 잘리지 않고 전체로 보이며 복사할 수 있다", async () => {
    renderAt(AGENTS, { ...ownerOk, ...keysServer([key()]) });
    expect(await screen.findByText(KEY_ID)).toBeDefined();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    try {
      // Named by what it shows (WCAG 2.5.3); the key ID describes it.
      const button = screen.getByRole("button", {
        name: "복사",
        description: `ID ${KEY_ID}`,
      });
      await act(async () => button.click());
      expect(written).toEqual([KEY_ID]);
      expect(button.textContent).toBe("복사");
      const status = within(rows()[0] as HTMLElement).getByRole("status");
      expect(status.textContent).toBe("복사했습니다");
      expect(status.className.split(" ")).toContain("sr-only");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("key ID 복사에 실패하면 행 안에서 직접 복사하라고 알린다", async () => {
    renderAt(AGENTS, { ...ownerOk, ...keysServer([key()]) });
    expect(await screen.findByText(KEY_ID)).toBeDefined();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    try {
      const button = screen.getByRole("button", {
        name: "복사",
        description: `ID ${KEY_ID}`,
      });
      await act(async () => button.click());
      const row = rows()[0] as HTMLElement;
      expect(within(row).getByRole("alert").textContent).toBe(
        "복사하지 못했습니다. ID를 직접 선택해 복사하세요.",
      );
      expect(button.textContent).toBe("복사");
      expect(within(row).getByRole("status").textContent).toBe("");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("두 행의 key ID 복사가 실패하면 두 행 모두 알리고, 다시 복사한 행만 알림을 지운다", async () => {
    const OTHER_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    renderAt(AGENTS, {
      ...ownerOk,
      ...keysServer([key(), key({ id: OTHER_ID })]),
    });
    expect(await screen.findByText(OTHER_ID)).toBeDefined();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let refuse = true;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          if (refuse) throw new Error("denied");
        },
      },
    });
    const copyIn = (id: string) =>
      screen.getByRole("button", { name: "복사", description: `ID ${id}` });
    const alerts = () =>
      rows().map((row) => within(row).queryAllByRole("alert").length);
    try {
      await act(async () => copyIn(KEY_ID).click());
      await act(async () => copyIn(OTHER_ID).click());
      expect(alerts()).toEqual([1, 1]);
      refuse = false;
      await act(async () => copyIn(OTHER_ID).click());
      const first = rows().findIndex((row) =>
        row.textContent?.includes(KEY_ID),
      );
      expect(alerts()).toEqual(first === 0 ? [1, 0] : [0, 1]);
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("만료 임박과 만료됨은 상태 색으로, 만료 없는 key는 그렇다고 보인다", async () => {
    const soon = new Date(Date.now() + 2 * DAY).toISOString();
    const past = new Date(Date.now() - DAY).toISOString();
    const later = new Date(Date.now() + 60 * DAY).toISOString();
    renderAt(PERSONAL, {
      ...ownerOk,
      ...keysServer(
        [soon, past, later, null].map((expires_at, index) =>
          key({
            id: `${index}a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`,
            kind: "personal",
            agent_id: null,
            expires_at,
          }),
        ),
      ),
    });
    await screen.findByText("만료 없음");
    const states = rows().map((row) => {
      const marked = row.querySelector("[data-expiry]") as HTMLElement | null;
      return marked
        ? `${marked.dataset.expiry}/${marked.dataset.tone}`
        : "plain";
    });
    expect(states).toEqual([
      "soon/caution",
      "expired/danger",
      "plain",
      "none/caution",
    ]);
    expect(rows()[0]?.textContent).toContain("곧 만료 · ");
    expect(rows()[1]?.textContent).toContain("만료됨 · ");
    // A key with no end must not wear the soon-to-expire clock.
    const icon = (row: number) =>
      rows()[row]?.querySelector("[data-expiry] svg") ?? null;
    expect(icon(0)?.classList.contains("lucide-clock")).toBe(true);
    expect(icon(1)?.classList.contains("lucide-circle-alert")).toBe(true);
    expect(icon(3)?.classList.contains("lucide-clock")).toBe(false);
    expect(icon(3)?.classList.contains("lucide-infinity")).toBe(true);
    expect(icon(3)?.getAttribute("aria-hidden")).toBe("true");
    expect(rows()[3]?.querySelector("[data-expiry]")?.textContent).toBe(
      "만료 없음",
    );
  });

  test("새 key 버튼은 만들기 화면으로 가고, 취소하면 목록으로 돌아온다", async () => {
    const { history } = renderAt(PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "새 키" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "새 개인 키" }),
    ).toBeDefined();
    expect(history.location.pathname).toBe(NEW_PERSONAL);
    await user.click(screen.getByRole("link", { name: "취소" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "API 키" }),
    ).toBeDefined();
    expect(history.location.pathname).toBe(PERSONAL);
  });

  test("the create form keeps cancel and submit together, with a breadcrumb back to its list", async () => {
    const { history } = renderAt(NEW_AGENT, {
      ...ownerOk,
      ...keysServer(),
    });
    await screen.findByRole("heading", { level: 1, name: "새 에이전트 키" });
    const foot = document.querySelector("[data-slot=card-footer]");
    expect(foot?.closest("form")).not.toBeNull();
    expect(
      [...(foot?.querySelectorAll("a, button") ?? [])].map(
        (el) => el.textContent,
      ),
    ).toEqual(["취소", "키 만들기"]);
    // A crumb above the title, not a button in the head's actions
    // (V4-PAGE-FRAME).
    const trail = screen.getByRole("navigation", { name: "위치" });
    const back = within(trail).getByRole("link", { name: "에이전트 키" });
    expect(trail.querySelector("[aria-current=page]")?.textContent).toBe(
      "새 에이전트 키",
    );
    const user = await setupUser();
    await user.click(back);
    expect(
      await screen.findByRole("heading", { level: 1, name: "API 키" }),
    ).toBeDefined();
    expect(history.location.pathname).toBe(AGENTS);
  });

  test("에이전트 key는 에이전트를 골라야 하고, 워크스페이스 전체라는 선택지는 없다", async () => {
    const { api } = renderAt(NEW_AGENT, { ...ownerOk, ...keysServer() });
    const picker = (await screen.findByRole("combobox", {
      name: "에이전트",
    })) as HTMLInputElement;
    expect(picker.value).toBe("");
    expect(picker.maxLength).toBe(200);
    const user = await setupUser();
    await user.click(picker);
    // One page of every agent, searched on the server: no list read whole.
    await waitFor(() =>
      expect(agentOptions()).toEqual(["Billingbilling", "Supportsupport"]),
    );
    await user.type(picker, "sup");
    await waitFor(
      () =>
        expect(
          api.calls.filter((c) => c.path === "/v1/agents").map((c) => c.search),
        ).toEqual(["?include=summary", "?include=summary&q=sup"]),
      { timeout: 3000 },
    );
    const button = screen.getByRole("button", { name: "키 만들기" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("에이전트를 고르세요");
  });

  test("에이전트 관리자인 구성원은 자기가 관리하는 에이전트만 고른다", async () => {
    const { api } = renderAt(NEW_AGENT, { ...memberOk, ...keysServer() });
    const user = await setupUser();
    await user.click(await screen.findByRole("combobox", { name: "에이전트" }));
    await waitFor(() => expect(agentOptions()).toEqual(["Billingbilling"]));
    expect(api.calls.some((c) => c.path === "/v1/agents")).toBe(false);
    expect(document.body.textContent).not.toContain("api_key.manage");
  });

  test("에이전트 관리자인 구성원은 자기 에이전트의 key를 받고, 값은 그 화면에서 한 번만 보인다", async () => {
    const { api, history, services } = renderAt(NEW_AGENT, {
      ...memberOk,
      ...keysServer(),
    });
    const cached = () =>
      services.queryClient
        .getMutationCache()
        .getAll()
        .some((m) => JSON.stringify(m.state.data ?? null).includes(SECRET));
    const user = await setupUser();
    await chooseAgent(user, "Billing");
    await user.type(screen.getByLabelText(/^이름/), "  ci-deploy ");
    await user.click(screen.getByRole("button", { name: "키 만들기" }));

    const secret = await screen.findByRole("region", { name: "새 키" });
    expect(
      (within(secret).getByLabelText("키 값") as HTMLInputElement).value,
    ).toBe(SECRET);
    expect(
      within(secret).getByText(apiKeysKo["apiKeys.secretOnce"]),
    ).toBeDefined();
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    const { expires_at, ...sent } = posts[0]?.body as Record<string, unknown>;
    expect(sent).toEqual({
      kind: "agent",
      name: "ci-deploy",
      scopes: ["sessions:read"],
      agent_id: AGENT_ID,
    });
    // Untouched, the date stays 90 days out and the key ends with that day.
    const end = new Date();
    end.setDate(end.getDate() + 90);
    end.setHours(23, 59, 59, 0);
    expect(expires_at).toBe(end.toISOString());
    expect(api.calls.some((c) => c.path === "/v1/agents")).toBe(false);
    // Nothing else is issued from here while the secret shows.
    expect(screen.queryByRole("button", { name: "키 만들기" })).toBeNull();
    // The whole id, not a prefix.
    expect(
      within(secret).getByText(
        /ID [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    ).toBeDefined();
    expect(history.location.href).not.toContain(SECRET);
    expect(JSON.stringify(history.location.state ?? null)).not.toContain(
      SECRET,
    );

    await user.click(screen.getByRole("link", { name: "목록으로" }));
    expect(await screen.findByText("Billing · ci-deploy")).toBeDefined();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    await waitFor(() => expect(cached()).toBe(false));

    // Coming back to the page shows a fresh form, not the secret.
    await act(async () => history.back());
    expect(
      await screen.findByRole("button", { name: "키 만들기" }),
    ).toBeDefined();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });

  test("권한은 이름과 설명으로 고르고, 목록도 이름으로 보인다", async () => {
    renderAt(AGENTS, {
      ...memberOk,
      ...keysServer([key({ scopes: ["sessions:read", "sessions:write"] })]),
    });
    expect(await screen.findByText("세션 보기, 세션 만들기")).toBeDefined();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "새 키" }));
    const read = await screen.findByRole("checkbox", {
      name: "세션 보기 sessions:read",
    });
    expect(describedBy(read)[0]).toContain("영수증·사용량·공유 설정");
  });

  test("개인 key의 승인 배지는 범위에서 읽는다", async () => {
    renderAt(PERSONAL, {
      ...ownerOk,
      ...keysServer([
        key({ kind: "personal", agent_id: null, name: "laptop" }),
        key({
          id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
          kind: "personal",
          agent_id: null,
          scopes: ["sessions:read", "sessions:approve"],
        }),
      ]),
    });
    await screen.findByText("laptop");
    expect(
      rows().map(
        (row) =>
          (row.querySelector("[data-approve]") as HTMLElement).dataset.approve,
      ),
    ).toEqual(["false", "true"]);
  });

  test("에이전트 key 폼은 개인 key와 같은 권한을 고르고 자기 승인 금지를 알리며, 권한을 다 빼면 버튼이 이유와 함께 닫힌다", async () => {
    renderAt(NEW_AGENT, { ...memberOk, ...keysServer() });
    const user = await setupUser();
    await screen.findByRole("combobox", { name: "에이전트" });
    expect(
      screen.getByRole("checkbox", { name: /sessions:approve/ }),
    ).toBeDefined();
    expect(screen.getByText(apiKeysKo["apiKeys.selfApproval"])).toBeDefined();
    await chooseAgent(user, "Billing");
    await user.click(screen.getByRole("checkbox", { name: /sessions:read/ }));
    const button = screen.getByRole("button", { name: "키 만들기" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("권한을 하나 이상 고르세요.");
  });

  test("에이전트 key도 요청에 답하기를 골라 받는다 (GA-8)", async () => {
    const { api } = renderAt(NEW_AGENT, { ...memberOk, ...keysServer() });
    const user = await setupUser();
    await chooseAgent(user, "Billing");
    await user.click(
      screen.getByRole("checkbox", { name: /sessions:approve/ }),
    );
    await user.click(screen.getByRole("button", { name: "키 만들기" }));
    await screen.findByRole("region", { name: "새 키" });
    const posts = api.calls.filter((c) => c.method === "POST");
    expect((posts[0]?.body as { scopes: unknown }).scopes).toEqual([
      "sessions:read",
      "sessions:approve",
    ]);
  });

  test("관리 에이전트 조회가 실패하면 없다고 하지 않고 실패를 이유로 보인다", async () => {
    renderAt(NEW_AGENT, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Backend unavailable"),
      ...keysServer(),
    });
    const button = await screen.findByRole("button", { name: "키 만들기" });
    await waitFor(() =>
      expect(
        document.getElementById(button.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBe("서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요."),
    );
    expect(screen.queryByText("관리하는 에이전트가 없습니다.")).toBeNull();
  });

  test("관리하는 에이전트가 없는 구성원에게는 에이전트 key와 조직 관리 key로 가는 길이 없다", async () => {
    const { services } = renderAt(PERSONAL, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...keysServer(),
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "API 키" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        services.queryClient.getQueryState(keys.administeredAgents)?.status,
      ).toBe("success"),
    );
    expect(screen.queryByRole("navigation", { name: "키 목록" })).toBeNull();
    expect(screen.queryByRole("link", { name: "에이전트 키" })).toBeNull();
    expect(screen.queryByRole("link", { name: "조직 관리 키" })).toBeNull();
    expect(document.body.textContent).not.toContain("api_key.manage");
  });

  test("개인 key는 고른 범위와 만료일로 만들고, 값 칸으로 포커스가 간다", async () => {
    const { api } = renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("checkbox", { name: /sessions:write/ }),
    );
    const name = screen.getByLabelText(/^이름/) as HTMLInputElement;
    expect(name.maxLength).toBe(64);
    await user.type(name, "laptop");
    await user.type(screen.getByLabelText(/^만료일/), "2026-12-31");
    await user.click(screen.getByRole("button", { name: "키 만들기" }));
    const secret = await screen.findByRole("region", { name: "새 키" });
    const field = within(secret).getByLabelText("키 값");
    await waitFor(() => expect(document.activeElement === field).toBe(true));
    const [body] = api.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.body as Record<string, unknown>);
    expect(body?.kind).toBe("personal");
    expect(body?.name).toBe("laptop");
    expect(body?.scopes).toEqual(["sessions:read", "sessions:write"]);
    expect(
      new Date(String(body?.expires_at)).getTime() >
        new Date("2026-12-31T00:00:00").getTime(),
    ).toBe(true);
    expect(badgeOf(secret).textContent).toBe("개인 키");
  });

  test("만료일은 오늘부터 고를 수 있다", async () => {
    renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    expect((await screen.findByLabelText(/^만료일/)).getAttribute("min")).toBe(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    );
  });

  test("새 에이전트 key는 90일 뒤 만료로 시작하고, 날짜를 비우면 만료 없이 만든다", async () => {
    const { api } = renderAt(NEW_AGENT, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await screen.findByRole("combobox", { name: "에이전트" });
    const date = screen.getByLabelText(/^만료일/) as HTMLInputElement;
    const day = new Date();
    day.setDate(day.getDate() + 90);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(date.value).toBe(
      `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
    );
    expect(
      screen.getByText(apiKeysKo["apiKeys.agentExpiresHint"]),
    ).toBeDefined();
    await chooseAgent(user, "Billing");
    await user.clear(date);
    await user.click(screen.getByRole("button", { name: "키 만들기" }));
    await screen.findByRole("region", { name: "새 키" });
    const [body] = api.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.body as Record<string, unknown>);
    expect(body?.kind).toBe("agent");
    expect(body && "expires_at" in body).toBe(false);
  });

  test("90일은 달력으로 센다: 1월 31일 밤에 열면 5월 1일", async () => {
    setSystemTime(new Date(2026, 0, 31, 23, 30));
    try {
      renderAt(NEW_AGENT, { ...ownerOk, ...keysServer() });
      expect(
        ((await screen.findByLabelText(/^만료일/)) as HTMLInputElement).value,
      ).toBe("2026-05-01");
    } finally {
      setSystemTime();
    }
  });

  test("key 탭을 오가도 목록은 한 번만 받는다", async () => {
    const { api } = renderAt(PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    // Each screen draws its own tabs, so look them up after every move.
    for (const name of ["에이전트 키", "개인 키", "조직 관리 키"]) {
      await user.click(
        await screen.findByRole("link", { name: new RegExp(`^${name}`) }),
      );
      await waitFor(() =>
        expect(
          screen
            .getByRole("link", { name: new RegExp(`^${name}`) })
            .getAttribute("aria-current"),
        ).toBe("page"),
      );
    }
    expect(
      await screen.findByText(apiKeysKo["apiKeys.orgPending"]),
    ).toBeDefined();
    expect(
      api.calls.filter((c) => c.method === "GET" && c.path === "/v1/api-keys"),
    ).toHaveLength(1);
  });

  test("새 개인 key의 만료일은 비어 있다", async () => {
    renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    expect(
      ((await screen.findByLabelText(/^만료일/)) as HTMLInputElement).value,
    ).toBe("");
  });

  test("에이전트 key도 지난 날짜를 만료일로 보내지 않는다", async () => {
    const { api } = renderAt(NEW_AGENT, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await chooseAgent(user, "Billing");
    await user.clear(screen.getByLabelText(/^만료일/));
    await user.type(screen.getByLabelText(/^만료일/), "2020-01-01");
    await user.click(screen.getByRole("button", { name: "키 만들기" }));
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.queryByRole("region", { name: "새 키" })).toBeNull();
  });

  test("이름을 비워 두면 이름 없이 보낸다", async () => {
    const { api } = renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.type(await screen.findByLabelText(/^이름/), "   ");
    await user.click(screen.getByRole("button", { name: "키 만들기" }));
    await screen.findByRole("region", { name: "새 키" });
    const [body] = api.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.body as Record<string, unknown>);
    expect(body && "name" in body).toBe(false);
  });

  test("값 복사에 실패하면 그렇다고 알리고 값 칸에 포커스를 둔다", async () => {
    renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "키 만들기" }));
    const secret = await screen.findByRole("region", { name: "새 키" });
    const field = within(secret).getByLabelText("키 값");

    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    try {
      const copyButton = within(secret).getByRole("button", { name: "복사" });
      // The refusal settles after the click returns; act flushes it.
      await act(async () => copyButton.click());
      expect((await within(secret).findByRole("alert")).textContent).toBe(
        "복사하지 못했습니다. 위 칸의 값을 직접 선택해 복사하세요.",
      );
      expect(document.activeElement === field).toBe(true);
      expect(within(secret).queryByText("복사했습니다")).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("값 복사에 성공하면 status 영역이 그렇다고 알린다", async () => {
    renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "키 만들기" }));
    const secret = await screen.findByRole("region", { name: "새 키" });

    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    try {
      const status = within(secret).getByRole("status");
      expect(status.textContent).toBe("");
      await act(async () =>
        within(secret).getByRole("button", { name: "복사" }).click(),
      );
      expect(status.textContent).toBe("복사했습니다");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("공백 없는 긴 에이전트 이름도 행 폭 안에서 줄을 바꾼다", async () => {
    const long = { ...mine, name: `billing_${"x".repeat(80)}` };
    renderAt(AGENTS, {
      ...ownerOk,
      "GET /v1/agents": () => json(200, { items: [long], next_cursor: null }),
      ...keysServer([key()]),
    });
    const title = await screen.findByText(`${long.name} · 이름 없음`);
    // Layout is not measured here; the live 390px check covers the width.
    expect(title.classList.contains("min-w-0")).toBe(true);
    expect(title.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
  });

  test("폐기는 확인 뒤에 하고 행이 폐기됨으로 바뀐다", async () => {
    renderAt(AGENTS, { ...ownerOk, ...keysServer([key()]) });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: `에이전트 키 · Billing · 이름 없음 (${KEY_ID}) 폐기`,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(`ID ${KEY_ID} 키를 폐기할까요?`),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "폐기" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").map((status) => status.textContent),
      ).toContain("키를 폐기했습니다."),
    );
    await waitFor(() => expect(screen.getByText(/^폐기됨/)).toBeDefined());
    expect(screen.queryByRole("button", { name: /폐기$/ })).toBeNull();
  });

  test("가진 것보다 넓은 범위(403)는 우리 문구만 보이고 서버의 영어 문구는 없다", async () => {
    renderAt(NEW_PERSONAL, {
      ...ownerOk,
      ...keysServer(),
      "POST /v1/api-keys": () =>
        apiError(
          403,
          "SCOPE_NOT_GRANTABLE",
          "An agent key cannot carry sessions:approve",
        ),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "키 만들기" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "내가 가진 것보다 많은 권한을 키에 줄 수 없습니다.",
    );
  });

  test("역할이 바뀌어 서버가 403이면 같은 이유 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt(NEW_AGENT, {
      ...ownerOk,
      ...keysServer(),
      "POST /v1/api-keys": () =>
        apiError(
          403,
          "FORBIDDEN",
          "This principal does not hold api_key.manage",
        ),
    });
    const user = await setupUser();
    await chooseAgent(user, "Billing");
    await user.click(screen.getByRole("button", { name: "키 만들기" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "에이전트 키 발급 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });

  for (const [locale, catalog, button] of [
    ["ko", apiKeysKo, "키 만들기"],
    ["en", apiKeysEn, "Generate key"],
  ] as const) {
    test(`권한마다 무엇을 허락하는지 한 줄 설명이 붙는다 (${locale})`, async () => {
      renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() }, locale);
      await screen.findByRole("button", { name: button });
      for (const scope of SESSION_SCOPE_VALUES) {
        const box = screen.getByRole("checkbox", {
          name: new RegExp(`${scope}$`),
        });
        const hint = `apiKeys.scopeHint.${scope.slice("sessions:".length)}`;
        expect(describedBy(box)).toEqual([
          catalog[hint as keyof typeof catalog],
        ]);
      }
    });
  }

  test("발급된 값은 query 캐시와 console에 남지 않는다", async () => {
    const logged: unknown[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        logged.push(...args);
      };
    }
    try {
      const { services } = renderAt(NEW_PERSONAL, {
        ...ownerOk,
        ...keysServer(),
      });
      const user = await setupUser();
      await user.click(
        await screen.findByRole("button", { name: "키 만들기" }),
      );
      await screen.findByRole("region", { name: "새 키" });
      const queries = services.queryClient.getQueryCache().getAll();
      expect(
        queries.some((q) =>
          JSON.stringify(q.state.data ?? null).includes(SECRET),
        ),
      ).toBe(false);
      expect(logged.some((arg) => String(arg).includes(SECRET))).toBe(false);
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index] as (typeof console)[typeof name];
      });
    }
  });
});

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `missing:${id}`);
}
