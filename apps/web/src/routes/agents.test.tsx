import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { focusManager, onlineManager } from "@tanstack/react-query";
import type { ApiError } from "@werft-ai/client";
import {
  type AgentCard,
  type AgentDetail,
  agentDetailSchema,
  CREDENTIAL_REVOKE_NOTICE,
  type ProfileSummary,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import type { Locale } from "../i18n/i18n.tsx";
import {
  AGENT_ID,
  agentServer,
  CARD,
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
  USER_ID,
} from "../test-support/fake-api.ts";
import { fakeIntersection } from "../test-support/intersection.ts";
import { denyFor, imported } from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, cleanup, render, renderAt, screen, waitFor, within } =
  await appHarness();
// Over happy-dom's, which setupDom put in place.
const viewport = fakeIntersection();
afterEach(() => viewport.show(() => true));
afterAll(() => viewport.restore());
// After the DOM exists: Radix picks a no-op layout effect when loaded before
// it, and its dialogs then never reach the page.
const { agentRefusal } = await import("./agents.tsx");
const { avatarTone } = await import("@werft-ai/ui");
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
  "채널 연결": 3,
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
  await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
}

const profileSelect = async () =>
  (await screen.findByLabelText("프로필")) as HTMLSelectElement;

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
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

const PROFILE = "claude-coding-local";
/** A profile the new-agent flow can release: it needs no repository. */
const catalogProfile = (
  id: string,
  model: string,
  tools: string[],
): ProfileSummary => ({
  id,
  source: "operator",
  model,
  models: [model],
  tools,
  deny: denyFor(tools),
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  billing: "metered",
  repository_mode: "optional",
  repository_ids: ["sample-app"],
});
const showTab = async (user: User, name: string) =>
  user.click(await screen.findByRole("tab", { name }));
const showList = async (user: User, name: string) =>
  user.click(await screen.findByRole("button", { name }));
// The state badge of the card or row an agent's name links from.
const stateOf = (link: HTMLElement) =>
  link
    .closest("[role=row], [data-slot=card]")
    ?.querySelector("[data-slot=badge][data-state]");
const showTable = async (user: User) =>
  user.click(await screen.findByRole("button", { name: "표" }));

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
  options: { card?: typeof CARD; profile?: string } = {},
) {
  await server.routes[`PATCH /v1/agents/${AGENT_ID}`](
    new Request("https://console.test/", {
      method: "PATCH",
      body: JSON.stringify({
        card: options.card ?? server.versions.at(-1)?.card,
        runtime_profile_id: options.profile ?? PROFILE,
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
      "card.model: model custom model is not the model of runtime profile claude-coding-local";
    expect(refusal("ko", "UNSUPPORTED_CAPABILITY", message)).toBe(
      "카드 모델 custom model이(가) 프로필 claude-coding-local에서 실행되지 않아 릴리스를 만들지 못했습니다. 카드 모델을 실행하는 프로필을 고르세요.",
    );
    expect(refusal("en", "UNSUPPORTED_CAPABILITY", message)).toBe(
      "Profile claude-coding-local does not run the card's model custom model, so no release was created. Choose a profile that runs the card's model.",
    );
  });

  test("프로필 이름을 줄 수 있으면 거부 문구의 id가 이름으로 바뀐다", () => {
    const named = (id: string) =>
      id === "claude-coding-local" ? "readonly-review v1" : id;
    const message =
      "card.model: model custom model is not the model of runtime profile claude-coding-local";
    expect(
      agentRefusal(
        (key, vars) => translate("en", key, vars),
        { code: "UNSUPPORTED_CAPABILITY", message, status: 422 } as ApiError,
        "owner",
        named,
      ),
    ).toBe(
      "Profile readonly-review v1 does not run the card's model custom model, so no release was created. Choose a profile that runs the card's model.",
    );
  });

  test("다른 거부는 지금처럼 이유 뒤에 서버 설명을 붙인다", () => {
    const tools =
      "card.capabilities.tools: runtime profile claude-coding-local does not allow WebFetch";
    expect(refusal("ko", "UNSUPPORTED_CAPABILITY", tools)).toBe(
      `${translate("ko", "error.UNSUPPORTED_CAPABILITY")} ${tools}`,
    );
    expect(refusal("ko", "BAD_REQUEST", "card.model: required")).toBe(
      `${translate("ko", "error.BAD_REQUEST")} card.model: required`,
    );
  });

  test("운영자 차단은 막힌 프로필을 이름으로 말한다", () => {
    const blocked = (locale: Locale, details: unknown) =>
      agentRefusal(
        (key, vars) => translate(locale, key, vars),
        {
          code: "PROFILE_BLOCKED",
          message: "Profile coding-v1 is blocked by the operator",
          status: 409,
          details,
        } as unknown as ApiError,
        "owner",
      );
    const ceiling = { reason_code: "blocked", profile_id: "coding-v1" };
    const over = { reason_code: "base_blocked", profile_id: "ws_acme_v1" };
    expect(blocked("ko", ceiling)).toBe(
      "운영자가 프로필 coding-v1을(를) 차단했습니다. 차단이 풀릴 때까지 이 프로필로는 릴리스를 만들거나 활성화할 수 없습니다.",
    );
    expect(blocked("en", over)).toBe(
      "The operator blocked the profile that profile ws_acme_v1 narrows. Until it is unblocked, no release on it can be created or activated.",
    );
    expect(blocked("ja", ceiling)).toContain("coding-v1");
    expect(blocked("ko", null)).toBe(translate("ko", "error.PROFILE_BLOCKED"));
  });
});

describe("에이전트 목록", () => {
  beforeEach(() => localStorage.clear());

  test("표는 좁으면 수정 열을 숨기고, 그 시각을 이름 칸에 상대 시각으로 보인다", async () => {
    const server = agentServer();
    renderAt("/agents", { ...meOk, ...server.routes });
    await showTable(await setupUser());
    const table = await screen.findByRole("table", { name: "에이전트" });
    expect(table.dataset.narrowAt).toBe("480");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((head) => [head.textContent, head.dataset.hideNarrow ?? null]),
    ).toEqual([
      ["에이전트", null],
      ["담당 팀", "true"],
      ["상태", null],
      ["수정", "true"],
    ]);
    const row = (
      await within(table).findByRole("link", { name: "결제 담당" })
    ).closest("[role=row]") as HTMLElement;
    const [agentCell, teamCell, , updatedCell] =
      within(row).getAllByRole("cell");
    expect(teamCell?.dataset.hideNarrow).toBe("true");
    expect(teamCell?.textContent).toBe("재무");
    const updatedAt = server.detail().agent.updated_at;
    expect(updatedCell?.dataset.hideNarrow).toBe("true");
    expect(updatedCell?.querySelector("time")?.getAttribute("datetime")).toBe(
      updatedAt,
    );
    // Only below the table's narrow width; the time in it is the same one.
    const narrow = [...(agentCell?.querySelectorAll("span") ?? [])].find(
      (line) => line.className.includes("[@container(width<480px)]:block"),
    );
    expect(narrow?.className).toContain("hidden");
    expect(narrow?.textContent).toMatch(/ 수정$/);
    expect(narrow?.querySelector("time")?.getAttribute("datetime")).toBe(
      updatedAt,
    );
  });

  test("목록과 상태를 카드로 보이고, 표로 바꿔도 상세로 잇는다", async () => {
    const server = agentServer();
    renderAt("/agents", { ...meOk, ...server.routes });
    const card = (
      await screen.findByRole("link", { name: "결제 담당" })
    ).closest("[data-slot=card]") as HTMLElement;
    expect(within(card).getByText("초안")).toBeDefined();
    expect(card.textContent).toContain("식별자 billing");
    // The whole card is its name link: one link, the footer only says so.
    expect(
      within(card)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([DETAIL]);
    expect(card.className).toContain("cursor-pointer");

    await showTable(await setupUser());
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(link.getAttribute("href")).toBe(DETAIL);
    const row = link.closest("[role=row]") as HTMLElement;
    expect(within(row).getAllByRole("link")).toHaveLength(1);
    expect(row.className).toContain("cursor-pointer");
    expect(link.className).toContain("after:inset-0");
    expect(within(row).getByText("초안")).toBeDefined();
    expect(row.textContent).toContain("식별자 billing");
  });

  test("배지는 초안·릴리스·일시정지·보관됨을 이름만으로 서로 다르게 보인다", async () => {
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
    const badges = () =>
      ["draft", "live", "held", "old"].map((name) => {
        const badge = stateOf(screen.getByRole("link", { name }));
        return [badge?.textContent, badge?.getAttribute("data-state")];
      });
    const expected = [
      ["초안", "draft"],
      ["릴리스", "active"],
      ["일시정지", "paused"],
      ["보관됨", "archived"],
    ];
    await screen.findByRole("link", { name: "draft" });
    await waitFor(() => expect(badges()).toEqual(expected));
    const tones = ["draft", "live", "held", "old"].map(
      (name) => stateOf(screen.getByRole("link", { name }))?.className,
    );
    expect(new Set(tones).size).toBe(4);
    await showTable(await setupUser());
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "draft" }).closest("[role=row]"),
      ).not.toBeNull(),
    );
    expect(badges()).toEqual(expected);
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

  test("구성원은 전체 목록 대신 안내를 보고, 새 에이전트는 만들 수 있다", async () => {
    const { history } = renderAt("/agents", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/agents": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText(/전체 에이전트 목록은 소유자와 관리자만 봅니다/),
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
    ).toBe("에이전트 만들기 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.");
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
});

describe("에이전트 카드", () => {
  beforeEach(() => localStorage.clear());

  /** One released agent whose card asks for two credentials, one bound. */
  function releasedServer(mcp: readonly string[] = ["linear"]) {
    const server = agentServer();
    const base = server.detail();
    const version = base.versions[0];
    if (!version) throw new Error("agentServer has a first version");
    const card = {
      ...version.card,
      capabilities: {
        ...version.card.capabilities,
        mcp: mcp.map((server) => ({ server })),
        credential_refs: ["github", "linear"],
      },
    };
    const release = {
      id: crypto.randomUUID(),
      agent_id: AGENT_ID,
      version_id: version.id,
      card_sha256: "0".repeat(64),
      runtime_profile_id: PROFILE,
      repository_id: null,
      profile_digest: "digest-1",
      runtime_config_snapshot: {},
      effective_tools: { tools: ["Read"], mcp: [] },
      policy_pins: {},
      created_by: USER_ID,
      created_at: "2026-10-11T01:00:00.000Z",
      approved_by: null,
      approved_at: null,
      note: null,
      label: "2026-10-11_10:00:00",
      activated_at: "2026-10-11T02:00:00.000Z",
      deactivated_at: null,
    };
    const agent = {
      ...base.agent,
      description: DESCRIPTION,
      active_release_id: release.id,
    };
    const detail = agentDetailSchema.parse({
      ...base,
      agent,
      versions: [{ ...version, card }],
      releases: [release],
      active_release: release,
    });
    return {
      ...server.routes,
      "GET /v1/agents": () => json(200, { items: [agent], next_cursor: null }),
      [`GET /v1/agents/${AGENT_ID}`]: () => json(200, detail),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(200, {
          users: [
            {
              user_id: USER_ID,
              email: "owner@example.com",
              display_name: "Owner",
              created_by: null,
              created_at: "2026-10-11T00:00:00.000Z",
            },
          ],
          teams: [],
        }),
      [`GET /v1/agents/${AGENT_ID}/credential-bindings`]: () =>
        json(200, {
          items: [
            {
              id: crypto.randomUUID(),
              agent_id: AGENT_ID,
              credential_ref: "github",
              bound_by: USER_ID,
              bound_at: "2026-10-11T00:00:00.000Z",
              revoked_at: null,
              running_sessions: 0,
            },
          ],
          revoke_notice: CREDENTIAL_REVOKE_NOTICE,
        }),
    };
  }

  async function openAdministered(routes: Parameters<typeof renderAt>[1]) {
    const list = routes["GET /v1/agents"];
    if (!list) throw new Error("routes list agents");
    const rendered = renderAt("/agents", {
      ...meOk,
      ...routes,
      "GET /v1/administered-agents": async (request) => {
        const { items } = (await (await list(request)).json()) as {
          items: unknown[];
        };
        return json(200, { items });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: /^관리하는 에이전트/ }),
    );
    return rendered;
  }

  const cardFor = async (name: string) =>
    (await screen.findByRole("link", { name })).closest(
      "[data-slot=card]",
    ) as HTMLElement;
  const fact = (card: HTMLElement, term: string) =>
    [...card.querySelectorAll("dt")].find((dt) => dt.textContent === term)
      ?.nextElementSibling?.textContent;

  test("배포 판·설명·프로필·MCP·자격 증명·담당을 카드에 모은다", async () => {
    await openAdministered(releasedServer());
    const card = await cardFor("결제 담당");
    await waitFor(() =>
      expect(fact(card, "릴리스")).toBe("2026. 10. 11. 10:00"),
    );
    // The badge names the state; the label lives in the release row.
    expect(
      stateOf(screen.getByRole("link", { name: "결제 담당" }))?.textContent,
    ).toBe("릴리스");
    expect(card.textContent).not.toContain("2026-10-11_10:00:00");
    expect(card.textContent).toContain(DESCRIPTION);
    expect(card.textContent).not.toContain("지시문");
    expect(fact(card, "프로필")).toBe(PROFILE);
    expect(fact(card, "MCP")).toBe("linear");
    expect(fact(card, "자격 증명")).toBe("연결 필요 1개");
    // The colour beside the words is decoration; the words carry the state.
    const dot = card.querySelector("[data-slot=status-dot]");
    expect(dot?.getAttribute("data-status")).toBe("failed");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(card.textContent).toContain("관리자: Owner");
  });

  test("프로필 줄은 표시 이름이 있으면 이름과 버전으로 보이고, id는 title로 남는다", async () => {
    const named = imported(PROFILE);
    await openAdministered({
      ...releasedServer(),
      "GET /v1/profiles": () =>
        json(200, {
          items: [
            {
              ...named,
              installation: {
                ...(named.installation as NonNullable<
                  typeof named.installation
                >),
                name: "readonly-review",
                version: 3,
              },
            },
          ],
        }),
    });
    const card = await cardFor("결제 담당");
    await waitFor(() =>
      expect(fact(card, "프로필")).toBe("readonly-review v3"),
    );
    expect(card.querySelector(`[title="${PROFILE}"]`)).not.toBeNull();
  });

  test("API에 없는 답변 대기·스킬 줄은 두지 않고, 카드는 이름 하나로 열린다", async () => {
    await openAdministered(releasedServer());
    const card = await cardFor("결제 담당");
    await waitFor(() =>
      expect(fact(card, "릴리스")).toBe("2026. 10. 11. 10:00"),
    );
    expect(
      [...card.querySelectorAll("dt")].map((dt) => dt.textContent),
    ).toEqual(["담당 팀", "릴리스", "프로필", "MCP", "자격 증명"]);
    expect(card.textContent).not.toContain("미계측");
    expect(
      within(card)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["결제 담당"]);
  });

  test("긴 MCP 이름은 칩 안에서 잘리고 전체 이름은 title로 남는다", async () => {
    const long = `mcp-${"x".repeat(28)}`;
    await openAdministered(releasedServer([long]));
    const card = await cardFor("결제 담당");
    await waitFor(() =>
      expect(fact(card, "릴리스")).toBe("2026. 10. 11. 10:00"),
    );
    const chip = [...card.querySelectorAll("dt")]
      .find((dt) => dt.textContent === "MCP")
      ?.nextElementSibling?.querySelector("[data-slot=badge]");
    expect(chip?.textContent).toBe(long);
    expect(chip?.getAttribute("title")).toBe(long);
    expect(chip?.firstElementChild?.className).toContain("truncate");
    // Under the card's stretched link the hover would never reach the title.
    expect(chip?.className).toContain("relative z-1");
  });

  test("식별자는 한 줄로 잘리고 전체 값은 링크 위의 title로 남는다", async () => {
    renderAt("/agents", { ...meOk, ...releasedServer() });
    const card = await cardFor("결제 담당");
    const slug = card.getAttribute("data-agent") ?? "";
    const line = [...card.querySelectorAll("[data-slot=text]")].find(
      (el) => el.getAttribute("title") === slug,
    );
    expect(slug).not.toBe("");
    expect(line?.textContent).toBe(`식별자 ${slug}`);
    expect(line?.className).toContain("truncate");
    expect(line?.className).toContain("relative z-1");
  });
  test("아바타 색은 이름으로 정해져 목록과 상세에서 같다", async () => {
    const tone = `--werft-avatar-${avatarTone("결제 담당")}-bg`;
    renderAt("/agents", { ...meOk, ...releasedServer() });
    const card = await cardFor("결제 담당");
    const avatar = card.querySelector("[data-slot=avatar]");
    expect(avatar?.className).toContain(tone);
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatarTone("결제 담당")).toBe(avatarTone("결제 담당"));
    expect(
      new Set(["a", "b", "c", "d"].map((name) => avatarTone(name))).size,
    ).toBe(4);
  });

  test("추가 정보를 못 불러와도 카드는 이름·상태와 상세 링크를 지킨다", async () => {
    const server = agentServer();
    const refuse = () => apiError(503, "UNAVAILABLE", "down");
    await openAdministered({
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: refuse,
      [`GET /v1/agents/${AGENT_ID}/admins`]: refuse,
      [`GET /v1/agents/${AGENT_ID}/credential-bindings`]: refuse,
    });
    const card = await cardFor("결제 담당");
    await waitFor(() => expect(fact(card, "프로필")).toBe("—불러오지 못함"));
    expect(stateOf(card.querySelector("a") as HTMLElement)?.textContent).toBe(
      "초안",
    );
    expect(
      within(card)
        .getByRole("link", { name: "결제 담당" })
        .getAttribute("href"),
    ).toBe(DETAIL);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("카드 내용을 못 불러와도 설명은 에이전트 행에서 보이고, 자격 증명 칸은 그렇다고 적는다", async () => {
    const routes = releasedServer();
    await openAdministered({
      ...routes,
      [`GET /v1/agents/${AGENT_ID}`]: () =>
        apiError(503, "UNAVAILABLE", "down"),
    });
    const card = await cardFor("결제 담당");
    await waitFor(() => expect(fact(card, "자격 증명")).toBe("—불러오지 못함"));
    expect(card.textContent).toContain(DESCRIPTION);
  });

  test("카드 내용이 늦으면 자격 증명 칸은 연결 목록이 먼저 와도 기다린다", async () => {
    await openAdministered({
      ...releasedServer(),
      [`GET /v1/agents/${AGENT_ID}`]: () => new Promise<Response>(() => {}),
    });
    const card = await cardFor("결제 담당");
    await waitFor(() =>
      expect(fact(card, "관리자") ?? card.textContent).toContain("Owner"),
    );
    const cell = [...card.querySelectorAll("dt")].find(
      (dt) => dt.textContent === "자격 증명",
    )?.nextElementSibling;
    expect(cell?.querySelector("[aria-busy=true]")).not.toBeNull();
  });

  describe("보이는 카드만", () => {
    const items = (count: number) => {
      const base = agentServer().detail().agent;
      return Array.from({ length: count }, (_, n) => ({
        ...base,
        id: crypto.randomUUID(),
        slug: `agent-${n}`,
        name: `에이전트 ${n}`,
      }));
    };
    const slugOf = (element: Element) =>
      element.querySelector("[data-agent]")?.getAttribute("data-agent");
    const detailCalls = (api: { calls: readonly { path: string }[] }) =>
      api.calls
        .map((c) => c.path)
        .filter((path) => /^\/v1\/agents\/(?!counts$)[^/]+/.test(path));

    test("화면에 들어온 카드만 추가 정보를 부르고, 스크롤로 들어오면 그때 부른다", async () => {
      const agents = items(14);
      const first = new Set(agents.slice(0, 6).map((agent) => agent.slug));
      viewport.show((element) => first.has(slugOf(element) ?? ""));
      const { api } = await openAdministered({
        "GET /v1/agents": () => json(200, { items: agents, next_cursor: null }),
      });
      const late = await cardFor("에이전트 13");
      await waitFor(() => expect(detailCalls(api).length).toBe(18));
      const asked = new Set(
        detailCalls(api).map(
          (path) => /^\/v1\/agents\/([^/]+)/.exec(path)?.[1],
        ),
      );
      expect(asked.has(agents[5]?.id)).toBe(true);
      expect(asked.has(agents[6]?.id)).toBe(false);
      // Not yet read is a placeholder, never the dash of a failed read.
      const profile = [...late.querySelectorAll("dt")].find(
        (dt) => dt.textContent === "프로필",
      )?.nextElementSibling;
      expect(profile?.querySelector("[aria-busy=true]")).not.toBeNull();
      expect(screen.queryByText(/자세한 정보를 불러옵니다/)).toBeNull();

      act(() => viewport.show(() => true));
      await waitFor(() => expect(detailCalls(api).length).toBe(42));
      // Each card's three reads go out once, however often it is reported.
      expect(new Set(detailCalls(api)).size).toBe(42);
      act(() => viewport.show(() => true));
      await waitFor(() =>
        expect(profile?.querySelector("[aria-busy=true]")).toBeNull(),
      );
      expect(detailCalls(api).length).toBe(42);
    });

    test("목록이 요약을 함께 주면 카드는 에이전트마다 따로 부르지 않는다", async () => {
      const agents = items(14).map((agent, index) => ({
        ...agent,
        // The first has no description yet: its card's earlier role stands in.
        description: index === 0 ? null : `설명 ${index}`,
        summary: {
          version: {
            version_no: 3,
            role: "옛 역할",
            instructions: "적용된 적 없는 지시",
            mcp_servers: ["linear"],
            credential_refs: ["github", "slack"],
          },
          runtime_profile_id: index === 0 ? null : PROFILE,
          release_label: index === 0 ? null : "2026-10-11_10:00:00-2",
          bound_credential_refs: ["github"],
          admins: ["Owner", "재무팀"],
          needs_input_count: 0,
          running_count: 0,
          slack_action: null,
        },
      }));
      viewport.show(() => false);
      const { api } = renderAt("/agents", {
        ...meOk,
        "GET /v1/agents": () => json(200, { items: agents, next_cursor: null }),
      });
      const card = await cardFor("에이전트 13");
      expect(fact(card, "릴리스")).toBe("2026. 10. 11. 10:00");
      // The dash is drawn; a screen reader hears the words.
      const draft = await cardFor("에이전트 0");
      expect(fact(draft, "릴리스")).toBe("—릴리스 전");
      // Said once: the profile row of an unreleased card is only a dash.
      expect(fact(draft, "프로필")).toBe("—없음");
      expect(fact(card, "프로필")).toBe(PROFILE);
      expect(fact(card, "MCP")).toBe("linear");
      expect(fact(card, "자격 증명")).toBe("연결 필요 1개");
      expect(card.textContent).toContain("설명 13");
      expect(card.textContent).not.toContain("옛 역할");
      expect(card.textContent).not.toContain("적용된 적 없는 지시");
      expect(draft.textContent).toContain("옛 역할");
      expect(card.textContent).toContain("관리자: Owner, 재무팀");
      expect(api.calls.find((c) => c.path === "/v1/agents")?.search).toContain(
        "include=summary",
      );
      act(() => viewport.show(() => true));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(detailCalls(api)).toEqual([]);
    });

    test("창이나 네트워크로 돌아와도 이미 불러온 카드를 다시 부르지 않는다", async () => {
      const { api } = await openAdministered(releasedServer());
      const card = await cardFor("결제 담당");
      await waitFor(() => expect(card.textContent).toContain("관리자: Owner"));
      await waitFor(() => expect(detailCalls(api).length).toBe(3));
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      // Let a refetch, if any, go out before counting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(detailCalls(api).length).toBe(3);
      focusManager.setFocused(undefined);
    });
  });
});

describe("에이전트 목록 탭과 보기", () => {
  beforeEach(() => localStorage.clear());

  test("에이전트가 없어도 탭과 보기 전환은 남고 전체 탭이 비었다고 알린다", async () => {
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(await screen.findByRole("button", { name: "전체 0" })).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "관리하는 에이전트 0" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "카드" })).toBeDefined();
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
    const cards = screen.getByRole("button", { name: "카드" });
    // Categories, then view, then search: the toolbar's reading order.
    expect(
      all.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      cards.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
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

  test("관리하는 에이전트가 서버 상한만큼 오면 일부만 보인다고 알리고, 개수는 서버가 센 값이다", async () => {
    const base = agentServer().detail().agent;
    const items = Array.from({ length: 200 }, (_, n) => ({
      ...base,
      id: crypto.randomUUID(),
      slug: `agent-${n}`,
      name: `에이전트 ${n}`,
    }));
    // Only the tab and its notice matter here, not 200 cards' details.
    viewport.show(() => false);
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
          },
        }),
    });
    await showList(await setupUser(), "관리하는 에이전트 250");
    expect(await screen.findByText("처음 200개만 보입니다.")).toBeDefined();
  });

  test("보기 선택은 사용자마다 브라우저에 남고 처음은 카드다", async () => {
    const server = agentServer();
    // Another person's choice in the same browser is not this one's.
    localStorage.setItem("ap.agents.view.someone-else", "table");
    renderAt("/agents", { ...meOk, ...server.routes });
    const cards = await screen.findByRole("button", { name: "카드" });
    expect(cards.getAttribute("aria-pressed")).toBe("true");
    await showTable(await setupUser());
    expect(localStorage.getItem(`ap.agents.view.${USER_ID}`)).toBe("table");
    cleanup();

    renderAt("/agents", { ...meOk, ...server.routes });
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(link.closest("[role=row]")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "표" }).getAttribute("aria-pressed"),
    ).toBe("true");
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
        runtime_profile_id: null,
        release_label: null,
        bound_credential_refs: [],
        admins: [],
        needs_input_count: 0,
        running_count: 0,
        slack_action: action,
      },
    }));
  }

  // The link in the card or row the agent's name opens, if any.
  const slackLinkOf = (name: string) =>
    screen
      .getByRole("link", { name })
      .closest("[role=row], [data-slot=card]")
      ?.querySelector<HTMLAnchorElement>("a[href*='tab=slack']") ?? null;

  test("조치가 필요한 카드와 행에만 그 에이전트의 Slack 탭 링크를 이유와 함께 단다", async () => {
    const user = await setupUser();
    const agents = listed();
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: agents, next_cursor: null }),
    });
    await screen.findByRole("link", { name: "에이전트 0" });
    const check = () =>
      ACTIONS.forEach(([, reason], n) => {
        const link = slackLinkOf(`에이전트 ${n}`);
        if (reason === null) {
          expect(link).toBeNull();
          return;
        }
        expect(link?.textContent).toBe(`Slack 조치 필요: ${reason}`);
        expect(link?.getAttribute("href")).toBe(
          `/agents/${agents[n]?.id}?tab=slack`,
        );
      });
    check();
    await showTable(user);
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "에이전트 0" }).closest("[role=row]"),
      ).not.toBeNull(),
    );
    check();
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
      screen.getByText(/전체 에이전트 목록은 소유자와 관리자만 봅니다/),
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
    const server = agentServer({ repositoryMode: "optional" });
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: [
            catalogProfile("claude-coding-fast", "claude-haiku-5", ["Read"]),
            catalogProfile(PROFILE, CARD.model, ["Read", "Edit", "Bash"]),
            catalogProfile("claude-coding-narrow", CARD.model, [
              "Read",
              "Edit",
            ]),
          ],
        }),
      [`GET /v1/agents/${AGENT_ID}/slack/app`]: () =>
        json(200, {
          slack_app: null,
          event_url: null,
          events: { state: "pending", checked_at: null, url: null },
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
        "목록과 상세 화면에 보입니다. 설치에서 플랫폼 안내를 켜 두었다면 이름과 함께 모델에게도 그대로 전해지고, 바꾼 값은 새 세션부터 적용됩니다.",
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
    expect((screen.getByLabelText("프로필") as HTMLSelectElement).value).toBe(
      PROFILE,
    );
    const blocked = screen.getByRole("group", { name: "프로필이 막은 도구" });
    // The profile runs Read, Edit and Bash, so it blocks the rest of the catalog.
    expect(within(blocked).getByText("Write")).toBeDefined();
    expect(within(blocked).getByText("WebFetch")).toBeDefined();
    expect(within(blocked).queryByText("Bash")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "릴리스 만들기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "에이전트 켜기" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));

    await atStep("채널 연결");
    expect(posted(api, "/v1/agents")).toEqual({
      slug: "billing",
      name: "결제 담당",
      description: DESCRIPTION,
      managing_team_id: TEAM_ID,
      card: {
        ...CARD,
        capabilities: { mcp: null, forbidden: [] },
      },
      runtime_profile_id: PROFILE,
      model_source: "profile",
    });
    expect(server.releases).toHaveLength(1);
    expect(server.detail().agent.active_release_id).toBe(
      server.releases[0]?.id ?? "missing",
    );
    expect(
      api.calls.some(
        (c) => c.path.endsWith("/releases") || c.path.endsWith("/activate"),
      ),
    ).toBe(false);
    expect(await screen.findByText(/결제 담당을\(를\) 켰습니다/)).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Slack 앱 만들고 설치" }),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "나중에 하기" }).getAttribute("href"),
    ).toBe(DETAIL);
  });

  test("하는 일 단계에서 고른 워크스페이스 판이 그사이 은퇴하면 쓸 수 있는 프로필로 바꿔 보낸다", async () => {
    const server = agentServer({ repositoryMode: "optional" });
    const operator = (
      (await (
        server.routes["GET /v1/profiles"] as () => Response
      )().json()) as { items: ProfileSummary[] }
    ).items;
    let state: "usable" | "retired" = "usable";
    const version = (): ProfileSummary => ({
      ...(operator[1] as ProfileSummary),
      id: "ws_acme_strict_v1",
      source: "workspace",
      workspace: {
        name: "strict",
        version: 1,
        base_profile_id: PROFILE,
        state,
        created_at: "2026-10-27T00:00:00.000Z",
        retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
      },
    });
    const { api, services } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () => json(200, { items: [...operator, version()] }),
    });
    const user = await setupUser();
    await atStep("이름");
    await user.type(await screen.findByLabelText("이름"), "결제 담당");
    await user.type(screen.getByLabelText("식별자"), "billing");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    await user.selectOptions(screen.getByLabelText("모델"), CARD.model);
    const profile = (await screen.findByLabelText(
      "프로필",
    )) as HTMLSelectElement;
    await user.selectOptions(profile, "ws_acme_strict_v1");
    expect(document.body.textContent).not.toContain("ws_acme_strict_v1");
    state = "retired";
    await services.queryClient.invalidateQueries();
    await waitFor(() => expect(profile.value).toBe(PROFILE));
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    expect(
      (posted(api, "/v1/agents") as { runtime_profile_id: string })
        .runtime_profile_id,
    ).toBe(PROFILE);
  });

  test("저장소가 꼭 필요한 프로필은 고를 수 없다", async () => {
    const server = agentServer({ repositoryMode: "optional" });
    const needs: ProfileSummary = {
      id: "claude-coding-repo",
      source: "operator",
      model: CARD.model,
      models: [CARD.model],
      tools: ["Read"],
      permission_mode: "default",
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      billing: "metered",
      repository_mode: "required",
      repository_ids: ["sample-app"],
    };
    const listed = (await (
      (server.routes["GET /v1/profiles"] as () => Response)() as Response
    ).json()) as { items: ProfileSummary[] };
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      // Listed first and on the card's model: still not the default.
      "GET /v1/profiles": () => json(200, { items: [needs, ...listed.items] }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    const profile = await profileSelect();
    expect(profile.value).toBe(PROFILE);
    expect(
      [...profile.options].some((o) => o.value === "claude-coding-repo"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    expect(
      (posted(api, "/v1/agents") as { runtime_profile_id: string })
        .runtime_profile_id,
    ).toBe(PROFILE);
  });

  test("고른 프로필이 그사이 저장소가 꼭 필요해지면 다른 프로필로 바꾸고, 남은 것이 없으면 안내만 남긴다", async () => {
    const server = agentServer({ repositoryMode: "optional" });
    const listed = (await (
      (server.routes["GET /v1/profiles"] as () => Response)() as Response
    ).json()) as { items: ProfileSummary[] };
    const required = new Set<string>();
    const { api, services } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: listed.items.map((p) => ({
            ...p,
            // The fallback has to run the card's model to be offered at all.
            ...(p.id === "claude-coding-fast"
              ? { models: [...p.models, "claude-sonnet-5"] }
              : {}),
            ...(required.has(p.id) ? { repository_mode: "required" } : {}),
          })),
        }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    const profile = await profileSelect();
    // Both run the card's model here, so the list's first one is picked.
    expect(profile.value).toBe("claude-coding-fast");

    required.add("claude-coding-fast");
    await services.queryClient.invalidateQueries();
    await waitFor(() => expect(profile.value).toBe(PROFILE));

    required.add(PROFILE);
    await services.queryClient.invalidateQueries();
    expect(
      await screen.findByText("쓸 수 있는 프로필이 없습니다"),
    ).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: "저장하고 다음",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("고른 프로필이 그사이 카드 모델을 잃거나 목록에서 빠지면 다른 프로필로 바꾼다", async () => {
    const server = agentServer({ repositoryMode: "optional" });
    const listed = (await (
      (server.routes["GET /v1/profiles"] as () => Response)() as Response
    ).json()) as { items: ProfileSummary[] };
    let fastRunsCard = true;
    let localListed = true;
    const { services } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: listed.items
            .filter((p) => localListed || p.id !== PROFILE)
            .map((p) =>
              p.id === "claude-coding-fast" && fastRunsCard
                ? { ...p, models: [...p.models, "claude-sonnet-5"] }
                : p,
            ),
        }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    const profile = await profileSelect();
    expect(profile.value).toBe("claude-coding-fast");

    fastRunsCard = false;
    await services.queryClient.invalidateQueries();
    await waitFor(() => expect(profile.value).toBe(PROFILE));

    fastRunsCard = true;
    localListed = false;
    await services.queryClient.invalidateQueries();
    await waitFor(() => expect(profile.value).toBe("claude-coding-fast"));
  });

  test("모든 프로필에 저장소가 꼭 필요하면 저장하지 못하게 하고 이유를 알린다", async () => {
    const server = agentServer({ repositoryMode: "required" });
    const { api } = renderAt("/agents/new", { ...meOk, ...server.routes });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    expect(
      await screen.findByText("쓸 수 있는 프로필이 없습니다"),
    ).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: "저장하고 다음",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
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
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await waitFor(() =>
      expect(screen.getByLabelText("모델").getAttribute("aria-invalid")).toBe(
        "true",
      ),
    );
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    expect(currentStep()).toBe("2하는 일");
  });

  test("하는 일까지 마치고 나가도 에이전트는 목록에 릴리스된 채로 남는다", async () => {
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
    await atStep("채널 연결");

    await user.click(screen.getByRole("link", { name: "나중에 하기" }));
    await waitFor(() => expect(history.location.pathname).toBe(DETAIL));
    act(() => history.push("/agents"));
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(stateOf(link)?.textContent).toBe("릴리스");
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
    await atStep("채널 연결");
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
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    const patch = api.calls.find((c) => c.method === "PATCH");
    const card = (patch?.body as { card: { rules?: unknown } }).card;
    expect(card.rules).toEqual(rules);
  });

  test("초안을 저장한 뒤 뒤로 가서 고치면 새로 만들지 않고 그 초안을 고친다", async () => {
    const server = agentServer({ repositoryMode: "optional" });
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("채널 연결");
    // Past the save the stepper does not lead back.
    expect(
      (
        screen.getByRole("button", {
          name: /^하는 일\s*, 완료$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    act(() => history.back());
    await atStep("하는 일");
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { card: { language: string } }).card.language).toBe(
      "en",
    );
    expect(patch?.body).toMatchObject({ runtime_profile_id: PROFILE });
    expect(server.detail().agent.active_release_id).toBe(
      server.releases.at(-1)?.id ?? "missing",
    );
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
    const server = agentServer({ repositoryMode: "optional" });
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("채널 연결");

    // Leaving unmounts the flow; coming back mounts a new one.
    await user.click(screen.getByRole("link", { name: "나중에 하기" }));
    await waitFor(() => expect(history.location.pathname).toBe(DETAIL));
    act(() => history.back());
    await atStep("채널 연결");
    act(() => history.back());
    await atStep("하는 일");
    expect((screen.getByLabelText("모델") as HTMLSelectElement).value).toBe(
      CARD.model,
    );
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(true);
    // The release goes to the version that save made, not the first one.
    expect(server.releases.at(-1)?.version_id).toBe(
      server.versions[1]?.id ?? "missing",
    );
  });

  test("고른 프로필은 단계를 오가도 남고, 저장은 그 프로필로 릴리스한다", async () => {
    const server = agentServer({ repositoryMode: "optional" });
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: [
            catalogProfile(PROFILE, CARD.model, ["Read", "Edit", "Bash"]),
            catalogProfile("claude-coding-narrow", CARD.model, ["Read"]),
          ],
        }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.selectOptions(await screen.findByLabelText("모델"), CARD.model);
    const preview = () =>
      (screen.getByLabelText("프로필") as HTMLSelectElement).value;
    expect(preview()).toBe(PROFILE);
    await user.selectOptions(
      screen.getByLabelText("프로필"),
      "claude-coding-narrow",
    );
    act(() => history.back());
    await atStep("이름");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    expect(preview()).toBe("claude-coding-narrow");
    expect(screen.queryByRole("checkbox", { name: /^Bash/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    expect(
      (posted(api, "/v1/agents") as { runtime_profile_id: string })
        .runtime_profile_id,
    ).toBe("claude-coding-narrow");
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
    await atStep("채널 연결");

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
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
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
    await atStep("채널 연결");
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
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
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
      "GET /v1/profiles": async () => {
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
        name: "저장하고 다음",
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
              runtime_profile_id: "profile_gone",
            }),
          }),
        );
      },
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "에이전트는 저장했지만 첫 릴리스를 만들지 못했습니다: 프로필을 찾을 수 없습니다. 저장을 다시 누르면 같은 에이전트를 고쳐 다시 시도합니다.",
    );
    expect(currentStep()).toBe("2하는 일");
    expect(server.detail().agent.active_release_id).toBeNull();
    expect(
      screen.getByRole("link", { name: "나중에 하기" }).getAttribute("href"),
    ).toBe(DETAIL);

    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    const patches = api.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toMatchObject({
      runtime_profile_id: PROFILE,
      model_source: "profile",
    });
    expect(server.releases).toHaveLength(1);
    expect(server.detail().agent.active_release_id).toBe(
      server.releases[0]?.id ?? "missing",
    );
  });

  test("직접 고른 모델로 저장하면 모델 방식은 직접 고르기로 보낸다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: [
            {
              ...catalogProfile(PROFILE, "claude-haiku-5", ["Read"]),
              models: ["claude-haiku-5", CARD.model],
            },
          ],
        }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("채널 연결");
    expect(posted(api, "/v1/agents")).toMatchObject({
      runtime_profile_id: PROFILE,
      model_source: "fixed",
    });
  });

  test("단계에 프로필 id는 보이지 않고 프로필 칸은 하나다", async () => {
    const server = agentServer();
    renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: [
            {
              ...catalogProfile("ws_acme_strict_v2", CARD.model, ["Read"]),
              source: "workspace",
              workspace: {
                name: "strict",
                version: 2,
                base_profile_id: PROFILE,
                state: "usable",
                created_at: "2026-10-27T00:00:00.000Z",
                retired_at: null,
              },
            },
          ],
        }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    await profileSelect();
    expect(screen.getAllByLabelText("프로필")).toHaveLength(1);
    expect(document.body.textContent).toContain("strict");
    expect(document.body.textContent).not.toContain("ws_acme_strict_v2");
    expect(screen.queryByLabelText("저장소")).toBeNull();
  });

  test("이름 없는 설치 프로필도 id 대신 종류와 모델로 보인다", async () => {
    const server = agentServer();
    renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: [catalogProfile("imported-ceiling-7", CARD.model, ["Read"])],
        }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    await profileSelect();
    expect(document.body.textContent).toContain(`프로필 · ${CARD.model}`);
    expect(document.body.textContent).not.toContain("imported-ceiling-7");
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
    // Only the card changed: name and description stay off the request.
    expect(Object.keys(patch?.body as object)).toEqual(["card"]);
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
    expect(
      await screen.findByText(
        "저장하고 새 세션에 적용했습니다. 카드는 버전 1입니다.",
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText("답변 언어")).toBeNull();
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
    expect(server.releases).toHaveLength(1);
    expect(server.releases.at(-1)?.version_id).toBe(
      server.versions[0]?.id ?? "missing",
    );
  });

  test("저장 결과는 보낸 카드 전체(정규화, rules 포함)로 찾는다", async () => {
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
        "새 버전이나 릴리스 없이 바로 바뀝니다. 설치에서 플랫폼 안내를 켜 두었다면 새 세션부터 모델도 이 값을 에이전트의 이름과 설명으로 읽습니다. 맡을 일과 행동 방식은 저장소의 CLAUDE.md나 AGENTS.md에 적으세요.",
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

  test("릴리스 탭은 기록과 되돌리기만 둔다: 만드는 폼도 프로필·저장소·메모 칸도 없다", async () => {
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
    for (const label of ["프로필", "저장소", "메모", "버전"])
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
      `릴리스 2026-10-11_10:0${no - 1}:00 · ${PROFILE}`;
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

    await user.click(await b.findByRole("button", rollbackTo(2)));
    await confirmRollback(user);
    expect(await b.findByText(/되돌렸습니다/)).toBeDefined();
    const retry = tabB.api.calls.filter((c) => c.path.endsWith("/activate"));
    expect(retry.at(-1)?.body).toEqual({
      release_id: second?.id,
      expected_revision: 2,
    });
    expect(server.detail().agent.active_release_id).toBe(second?.id ?? "");
  });
});

describe("릴리스 되돌리기", () => {
  const strict = (version: number): ProfileSummary => ({
    ...catalogProfile(`ws_strict_v${version}`, CARD.model, ["Read"]),
    source: "workspace",
    workspace: {
      name: "strict",
      version,
      base_profile_id: PROFILE,
      state: "usable",
      created_at: "2026-10-27T00:00:00.000Z",
      retired_at: null,
    },
  });
  const catalog = (...items: ProfileSummary[]) => ({
    "GET /v1/profiles": () => json(200, { items }),
  });

  async function onProfiles(
    server: ReturnType<typeof agentServer>,
    older: string,
    newer: string,
  ) {
    await seedRelease(server, { profile: older });
    const first = server.versions[0] as (typeof server.versions)[number];
    server.versions.push({
      ...first,
      id: SECOND_VERSION,
      version_no: 2,
      content_sha256: "f".repeat(64),
      card: { ...CARD, instructions: "환불도 맡는다." },
    });
    await seedRelease(server, { profile: newer });
  }

  const rollbackButton = async () =>
    (
      await screen.findAllByRole("button", { name: /\(으\)로 되돌리기$/ })
    )[0] as HTMLElement;

  async function openConfirm(user: User) {
    await user.click(await rollbackButton());
    return within(await screen.findByRole("dialog"));
  }

  test("확인 창은 따라가기 값을 켜짐 유지로 확정해 보이고, 저장소 설정은 되돌리지 않는다고 알린다", async () => {
    const server = agentServer();
    // The rollback target runs on the newest version of a named lineage.
    await onProfiles(server, "ws_strict_v2", "ws_strict_v2");
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      ...catalog(strict(1), strict(2)),
    });
    const user = await setupUser();
    const dialog = await openConfirm(user);
    expect(dialog.getByText(/켜짐 유지/)).toBeDefined();
    expect(
      dialog.getByText("저장소와 GitHub 설정은 지금 그대로입니다."),
    ).toBeDefined();
    expect(dialog.getByText(/차단된 프로필이거나/)).toBeDefined();
    expect(dialog.queryByText(/직접 고르기/)).toBeNull();
  });

  test("고정된 에이전트는 꺼짐 유지로 확정한다", async () => {
    const server = agentServer({ tracking: "pinned" });
    await releasedTwice(server);
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const dialog = await openConfirm(await setupUser());
    expect(dialog.getByText(/꺼짐 유지/)).toBeDefined();
  });

  test("옛 프로필 판으로 돌아가면 실행 방식이 같은지는 서버만 알아서 확정하지 않는다", async () => {
    const server = agentServer();
    await onProfiles(server, "ws_strict_v1", "ws_strict_v2");
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      ...catalog(strict(1), strict(2)),
    });
    const dialog = await openConfirm(await setupUser());
    expect(
      dialog.getByText(
        /이 릴리스의 프로필이 최신 판과 실행 방식이 다르면 꺼질 수 있습니다/,
      ),
    ).toBeDefined();
    expect(dialog.queryByText(/켜짐 유지/)).toBeNull();
    expect(dialog.queryByText(/꺼짐 유지/)).toBeNull();
  });

  test("프로필 기본 모델을 따르던 에이전트가 다른 모델의 릴리스로 가면 직접 고르기로 바뀐다고 알린다", async () => {
    const server = agentServer({ modelSource: "profile" });
    await releasedTwice(server);
    Object.assign(server.releases[0] ?? {}, {
      runtime_config_snapshot: { model: "claude-haiku-5" },
    });
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const dialog = await openConfirm(await setupUser());
    expect(dialog.getByText("실행 모델: 직접 고르기로 바뀜.")).toBeDefined();
  });

  const unreadable = {
    "GET /v1/profiles": () =>
      apiError(503, "BACKEND_UNAVAILABLE", "The catalog cannot be read"),
  };

  test("프로필 목록을 못 읽어도 상세로 정해지는 안내는 남고 되돌리기는 막지 않는다", async () => {
    const server = agentServer({ tracking: "pinned", modelSource: "profile" });
    await releasedTwice(server);
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes, ...unreadable });
    const dialog = await openConfirm(await setupUser());
    expect(dialog.getByText(/꺼짐 유지/)).toBeDefined();
    expect(dialog.getByText(/알 수 없음/)).toBeDefined();
    expect(
      dialog.getByText("저장소와 GitHub 설정은 지금 그대로입니다."),
    ).toBeDefined();
    expect(
      (dialog.getByRole("button", { name: "되돌리기" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("프로필 목록을 못 읽으면 따르는 에이전트의 값은 확정하지 않는다", async () => {
    const server = agentServer();
    await releasedTwice(server);
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes, ...unreadable });
    const dialog = await openConfirm(await setupUser());
    expect(dialog.queryByText(/켜짐 유지/)).toBeNull();
    expect(dialog.queryByText(/꺼짐 유지/)).toBeNull();
    expect(dialog.queryByText(/알 수 없음/)).toBeNull();
  });

  test("결과 줄은 되돌린 뒤 서버에서 다시 읽은 값을 보인다: 꺼짐으로 바뀐 경우", async () => {
    const server = agentServer({
      afterActivate: () => ({ tracking: "pinned" }),
    });
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
    expect(line.textContent).toContain("꺼짐으로 바뀜");
    expect(line.textContent).toContain(
      "저장소와 GitHub 설정은 지금 그대로입니다.",
    );
    expect(line.textContent).toContain("최신으로 올리기");
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
    const server = agentServer({
      afterActivate: () => ({ tracking: "pinned" }),
    });
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
    expect(line.textContent).toContain("꺼짐으로 바뀜");
    open();
  });

  test("응답이 사라져도 서버가 되돌렸으면 다시 읽어 되돌렸다고 말한다", async () => {
    const server = agentServer({
      afterActivate: () => ({ tracking: "pinned" }),
    });
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
    expect(line.textContent).toContain("꺼짐으로 바뀜");
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
    expect(line.textContent).toContain("따라가기 값은 확인하지 못했습니다");
    expect(line.textContent).not.toContain("켜짐 유지");
    expect(line.textContent).not.toContain("꺼짐");
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
          "card.model: model claude-sonnet-5 is not the model of runtime profile claude-coding-fast",
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
      "카드 모델 claude-sonnet-5이(가) 프로필 claude-coding-fast에서 실행되지 않아",
    );
    expect(refusal.textContent).toContain(
      "되돌리지 않았습니다. 지금 설정이 유지됩니다.",
    );
    expect(document.body.textContent).not.toContain("is not the model of");
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

  test("카드 편집에서 고른 프로필로 저장하면 그 프로필로 릴리스한다", async () => {
    const server = agentServer();
    await seedRelease(server);
    const listed = server.routes["GET /v1/profiles"] as () => Response;
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": async () => {
        const body = (await listed().json()) as { items: ProfileSummary[] };
        return json(200, {
          items: [
            ...body.items,
            {
              ...body.items[0],
              id: "claude-coding-wide",
              model: CARD.model,
              models: [CARD.model],
              tools: ["Read", "Bash"],
              deny: denyFor(["Read", "Bash"]),
            } as ProfileSummary,
          ],
        });
      },
    });
    const user = await setupUser();
    await openCardEditor(user);
    const card = screen.getByRole("tabpanel", { name: "상세 설정" });
    const cardProfile = (await within(card).findByLabelText(
      "프로필",
    )) as HTMLSelectElement;
    expect(cardProfile.value).toBe(PROFILE);
    await user.selectOptions(cardProfile, "claude-coding-wide");
    // Edit is run by the first profile and blocked by this one; Bash is the other way.
    const wide = within(
      await within(card).findByRole("group", { name: "프로필이 막은 도구" }),
    );
    expect(wide.getByText("Edit")).toBeDefined();
    expect(wide.queryByText("Bash")).toBeNull();
    await user.selectOptions(screen.getByLabelText("답변 언어"), "en");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(
      "저장하고 새 세션에 적용했습니다. 카드는 버전 2입니다.",
    );
    expect(
      (api.calls.find((c) => c.method === "PATCH")?.body as object) ?? {},
    ).toMatchObject({ runtime_profile_id: "claude-coding-wide" });
    expect(server.releases.at(-1)?.runtime_profile_id).toBe(
      "claude-coding-wide",
    );
  });

  describe("프로필을 고른 저장", () => {
    const bothProfiles = (server: ReturnType<typeof agentServer>) => {
      const listed = server.routes["GET /v1/profiles"] as () => Response;
      return async () => {
        const body = (await listed().json()) as { items: ProfileSummary[] };
        const local = body.items.find(
          (item) => item.id === PROFILE,
        ) as ProfileSummary;
        return json(200, {
          items: [
            local,
            {
              ...local,
              id: "claude-coding-both",
              model: "claude-haiku-5",
              models: ["claude-haiku-5", CARD.model],
            },
          ],
        });
      };
    };

    test("이름과 함께 프로필만 바꿔도 프로필이 요청에 실린다", async () => {
      const server = agentServer();
      const { api } = renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        "GET /v1/profiles": bothProfiles(server),
      });
      const user = await setupUser();
      await openCardEditor(user);
      const card = screen.getByRole("tabpanel", { name: "상세 설정" });
      await user.selectOptions(
        await within(card).findByLabelText("프로필"),
        "claude-coding-both",
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
        runtime_profile_id?: string;
      };
      expect(body.name).toBe("새 이름");
      expect(body.runtime_profile_id).toBe("claude-coding-both");
    });

    test("적용하지 못한 저장을 고치면 그 저장의 프로필로 보낸다", async () => {
      const server = agentServer();
      const waiting = () => {
        const body = server.detail();
        return {
          ...body,
          draft: {
            version_id: body.versions[0]?.id as string,
            runtime_profile_id: "claude-coding-both",
            model_source: "profile",
            failure: "release_refused",
          },
        };
      };
      const { api } = renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        "GET /v1/profiles": bothProfiles(server),
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
        runtime_profile_id?: string;
        model_source?: string;
      };
      expect(body.runtime_profile_id).toBe("claude-coding-both");
      expect(body.model_source).toBe("profile");
    });

    // The profile's default model moved on from the one that runs, so saving
    // the running card again as followed would swap its model.
    const discardSource = async (defaultModel: string) => {
      const server = agentServer();
      await seedRelease(server);
      await server.routes[`POST /v1/agents/${AGENT_ID}/activate`]?.(
        new Request("https://console.test/", {
          method: "POST",
          body: JSON.stringify({
            release_id: server.detail().releases[0]?.id,
            expected_revision: -1,
          }),
        }),
      );
      const listed = server.routes["GET /v1/profiles"] as () => Response;
      const withDraft = () => {
        const body = server.detail();
        return {
          ...body,
          model_source: "profile",
          draft: {
            version_id: body.versions[0]?.id as string,
            runtime_profile_id: PROFILE,
            model_source: "profile",
            failure: "release_refused",
          },
        };
      };
      const { api } = renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        "GET /v1/profiles": async () => {
          const body = (await listed().json()) as { items: ProfileSummary[] };
          return json(200, {
            items: body.items.map((item) =>
              item.id === PROFILE ? { ...item, model: defaultModel } : item,
            ),
          });
        },
        [`GET /v1/agents/${AGENT_ID}`]: () => json(200, withDraft()),
      });
      const user = await setupUser();
      const discard = await screen.findByRole("button", { name: "버리기" });
      await waitFor(() => expect(discard.hasAttribute("disabled")).toBe(false));
      await user.click(discard);
      await waitFor(() =>
        expect(api.calls.some((c) => c.method === "PATCH")).toBe(true),
      );
      return (
        api.calls.find((c) => c.method === "PATCH")?.body as {
          model_source?: string;
        }
      ).model_source;
    };

    test("버리기는 프로필 기본 모델이 그대로면 따르는 상태를 지키고", async () => {
      expect(await discardSource(CARD.model)).toBe("profile");
    });

    test("서버가 모델을 바꿔 적은 카드로 적용되면 안내는 그 릴리스의 버전을 가리킨다", async () => {
      const server = agentServer();
      const first = server.versions[0] as (typeof server.versions)[number];
      renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        "GET /v1/profiles": bothProfiles(server),
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
      // Only the profile changes, so the card sent is the first version's.
      const card = screen.getByRole("tabpanel", { name: "상세 설정" });
      await user.selectOptions(
        await within(card).findByLabelText("프로필"),
        "claude-coding-both",
      );
      await user.click(screen.getByRole("button", { name: "저장" }));
      expect(
        await screen.findByText(
          /저장하고 새 세션에 적용했습니다\. 카드는 버전 2입니다/,
        ),
      ).toBeDefined();
    });

    test("프로필 목록을 읽기 전에는 버리기를 누를 수 없다", async () => {
      const server = agentServer();
      await seedRelease(server);
      await server.routes[`POST /v1/agents/${AGENT_ID}/activate`]?.(
        new Request("https://console.test/", {
          method: "POST",
          body: JSON.stringify({
            release_id: server.detail().releases[0]?.id,
            expected_revision: -1,
          }),
        }),
      );
      const body = server.detail();
      renderAt(CARD_TAB, {
        ...meOk,
        ...server.routes,
        "GET /v1/profiles": () => new Promise<Response>(() => {}),
        [`GET /v1/agents/${AGENT_ID}`]: () =>
          json(200, {
            ...body,
            model_source: "profile",
            draft: {
              version_id: body.versions[0]?.id as string,
              runtime_profile_id: PROFILE,
              model_source: "profile",
              failure: "release_refused",
            },
          }),
      });
      const discard = await screen.findByRole("button", { name: "버리기" });
      expect(discard.hasAttribute("disabled")).toBe(true);
    });

    test("프로필 기본 모델이 옮겨 갔으면 돌던 모델을 고른 것으로 남긴다", async () => {
      expect(await discardSource("claude-haiku-5")).toBe("fixed");
    });
  });

  test("모델을 바꾼 뒤 재조회로 고른 프로필이 빠지면 카드 편집이 대체 프로필로 간다", async () => {
    const server = agentServer();
    const listed = server.routes["GET /v1/profiles"] as () => Response;
    let bothListed = true;
    const { services } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": async () => {
        const body = (await listed().json()) as { items: ProfileSummary[] };
        const local = body.items.find(
          (item) => item.id === PROFILE,
        ) as ProfileSummary;
        const runsBoth = (id: string): ProfileSummary => ({
          ...local,
          id,
          model: "claude-haiku-5",
          models: ["claude-haiku-5", CARD.model],
        });
        return json(200, {
          items: [
            local,
            ...(bothListed ? [runsBoth("claude-coding-both")] : []),
            runsBoth("claude-coding-backup"),
          ],
        });
      },
    });
    const user = await setupUser();
    await openCardEditor(user);
    const card = screen.getByRole("tabpanel", { name: "상세 설정" });
    const cardProfile = (await within(card).findByLabelText(
      "프로필",
    )) as HTMLSelectElement;
    await user.selectOptions(
      within(card).getByLabelText("모델"),
      "claude-haiku-5",
    );
    await waitFor(() => expect(cardProfile.value).toBe("claude-coding-both"));

    bothListed = false;
    await services.queryClient.invalidateQueries();
    await waitFor(() => expect(cardProfile.value).toBe("claude-coding-backup"));
  });

  test("모델 안내는 모델을 돌리는 프로필만 고를 수 있다고 말하고 내부 파일 이름을 보이지 않는다", async () => {
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
      "고른 모델을 돌리는 프로필만 아래에서 고를 수 있습니다",
    );
    expect(describedBy(await screen.findByLabelText("모델"))).not.toContain(
      "릴리스",
    );
    expect(document.body.textContent).not.toContain("profiles.yaml");
  });

  test("카드 모델과 다른 profile로 거부된 저장은 영어 원문 없이 한국어로 알린다", async () => {
    const server = agentServer();
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: () =>
        json(200, {
          ...server.detail(),
          release: {
            status: "failed",
            reason: "model_not_in_profile",
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
    expect(refusal.textContent).toContain("프로필이 허용하지 않는 모델입니다");
    expect(document.body.textContent).not.toContain("model_not_in_profile");
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  test("profile 목록을 못 읽으면 이유를 보이고 저장하지 못하게 한다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
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
    expect(screen.queryByLabelText("프로필")).toBeNull();
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
      "GET /v1/profiles": () =>
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
    ).toContain("다른 에이전트와 겹칠 수 없습니다");
    await user.type(screen.getByLabelText("이름"), "Billing Bot 2");
    expect(slug.value).toBe("billing-bot-2");
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
    expect(within(head).getByText("초안")).toBeDefined();
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
    await atStep("채널 연결");
    expect(stepsInState()).toEqual(["name", "job", "channels"]);

    reload();
    await atStep("채널 연결");
    expect(stepsInState()).toEqual(["name", "job", "channels"]);
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
    await atStep("채널 연결");
    expect(unloadBlocked()).toBe(false);
    await user.click(screen.getByRole("link", { name: "나중에 하기" }));
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
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    const sent = (posted(api, "/v1/agents") as { card: { language: string } })
      .card.language;
    expect(sent).toBe("en");

    reload();
    await atStep("채널 연결");
    expect(unloadBlocked()).toBe(false);
    await back();
    await atStep("하는 일");
    expect(
      (screen.getByLabelText("답변 언어") as HTMLSelectElement).value,
    ).toBe(sent);
  });
});

describe("새 에이전트: 고른 프로필", () => {
  test("저장한 프로필은 새로고침 뒤 하는 일 단계로 돌아와도 그대로 골라져 있다", async () => {
    const server = agentServer();
    const { api, reload } = openInBrowser("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        json(200, {
          items: [
            catalogProfile(PROFILE, CARD.model, ["Read", "Edit"]),
            catalogProfile("claude-coding-narrow", CARD.model, ["Read"]),
          ],
        }),
    });
    const user = await setupUser();
    await toJobStep(user);
    await pickModel(user);
    await user.selectOptions(await profileSelect(), "claude-coding-narrow");
    await user.click(screen.getByRole("button", { name: "저장하고 다음" }));
    await atStep("채널 연결");
    expect(
      (posted(api, "/v1/agents") as { runtime_profile_id: string })
        .runtime_profile_id,
    ).toBe("claude-coding-narrow");

    reload();
    await atStep("채널 연결");
    act(() => window.history.back());
    await atStep("하는 일");
    expect((await profileSelect()).value).toBe("claude-coding-narrow");
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
