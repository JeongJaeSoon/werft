import { describe, expect, test } from "bun:test";
import type { InvalidateQueryFilters } from "@tanstack/react-query";
import type { ApiClient } from "@werft-ai/client";
import type {
  AgentDetail,
  AuthMeResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import {
  agentSessionListsFilter,
  sessionsQuery,
  waitingSessionsQuery,
  withQueryScope,
} from "@werft-ai/core";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { agentsEn, agentsJa, agentsKo } from "../../i18n/agents.ts";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
  SCOPE,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const DETAIL = `/agents/${AGENT_ID}`;
const PATH = `/v1/agents/${AGENT_ID}`;
const SESSION_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const NEWER_RELEASE =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const BUTTON = "이 에이전트로 새 세션";
const SUBMIT = "세션 시작";
const MESSAGE = "첫 메시지";

const created = () =>
  json(201, {
    session_id: SESSION_ID,
    turn_id: "1",
    receipt_id: RECEIPT_ID,
    receipt_status: "accepted",
    status: "queued",
  });
const meAs = (who: AuthMeResponse) => ({
  "GET /v1/auth/me": () => json(200, who),
});

type Routes = Record<
  string,
  (request: Request) => Response | Promise<Response>
>;

async function released(repositoryMode: ProfileSummary["repository_mode"]) {
  const server = agentServer({
    repositoryMode,
    releaseRepository: repositoryMode === "none" ? null : "sample-app",
  });
  const routes = server.routes as Routes;
  await routes[`PATCH ${PATH}`]?.(
    new Request(`http://test${PATH}`, {
      method: "PATCH",
      body: JSON.stringify({ runtime_profile_id: "claude-coding-local" }),
    }),
  );
  return server;
}

function withRelease(
  detail: AgentDetail,
  over: Partial<NonNullable<AgentDetail["active_release"]>>,
): AgentDetail {
  const release = detail.active_release;
  if (!release) throw new Error("no active release to change");
  return { ...detail, active_release: { ...release, ...over } };
}

type ProfileChange = (items: ProfileSummary[]) => ProfileSummary[];

function profilesRoute(server: { routes: unknown }, change: ProfileChange) {
  return {
    "GET /v1/profiles": async (request: Request) => {
      const listed = await (server.routes as Routes)["GET /v1/profiles"]?.(
        request,
      );
      const { items } = (await listed?.json()) as { items: ProfileSummary[] };
      return json(200, { items: change(items) });
    },
  };
}

const local = "claude-coding-local";
const installationState =
  (state: string): ProfileChange =>
  (items) =>
    items.map((item) =>
      item.id === local
        ? ({
            ...item,
            installation: { ...item.installation, state },
          } as ProfileSummary)
        : item,
    );

async function button() {
  return screen.findByRole("button", { name: BUTTON });
}

async function openDialog() {
  const user = await setupUser();
  await waitFor(async () =>
    expect((await button()).getAttribute("aria-disabled")).toBeNull(),
  );
  await user.click(await button());
  return { user, dialog: await screen.findByRole("dialog") };
}

async function expectBlocked(reason: string) {
  const lines = await screen.findAllByText(reason);
  expect(
    lines.some((line) => line.closest("[hidden], [role=tooltip]") === null),
  ).toBe(true);
  expect(document.querySelector("[role=tooltip]") === null).toBe(true);
  const start = await button();
  expect(start.getAttribute("aria-disabled")).toBe("true");
  await (await setupUser()).click(start);
  expect(screen.queryByRole("dialog") === null).toBe(true);
}

describe("이 에이전트로 새 세션", () => {
  test("버튼에서 대화상자를 열어 보내면 활성 릴리스로 세션을 만들고 세션 화면으로 간다", async () => {
    const server = await released("optional");
    const { api, history } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": created,
    });
    const { user, dialog } = await openDialog();
    expect(within(dialog).getByText("sample-app")).toBeDefined();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
    const sent = api.calls.filter(
      (call) => call.method === "POST" && call.path === "/v1/sessions",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      agent_release_id: server.detail().active_release?.id,
      message: "요약해 줘",
    });
    expect(sent[0]?.headers.get("Idempotency-Key")).toBeTruthy();
  });

  test("공백뿐인 메시지는 보내지 않고 이유를 보인다", async () => {
    const server = await released("optional");
    const { api } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": created,
    });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "   ");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    expect(
      await within(dialog).findByText("메시지를 입력하세요."),
    ).toBeDefined();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("서버가 거절하면 대화상자에 이유를 보이고 입력을 남긴다", async () => {
    const server = await released("optional");
    const { history } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": () =>
        apiError(409, "CREDENTIAL_UNBOUND", "Release lost a binding"),
    });
    const { user, dialog } = await openDialog();
    const field = within(dialog).getByLabelText(MESSAGE) as HTMLTextAreaElement;
    await user.type(field, "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "에이전트 관리자에게 문의하세요",
    );
    expect(field.value).toBe("요약해 줘");
    expect(history.location.pathname).toBe(DETAIL);
  });

  test("대화상자를 닫았다 열어도 쓰던 메시지가 남는다", async () => {
    const server = await released("optional");
    renderAt(DETAIL, { ...meAs(me()), ...server.routes });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    const start = await button();
    await waitFor(() => expect(document.activeElement === start).toBe(true));
    await user.click(start);
    const reopened = await screen.findByRole("dialog");
    expect(
      (within(reopened).getByLabelText(MESSAGE) as HTMLTextAreaElement).value,
    ).toBe("요약해 줘");
  });

  test("응답을 못 받으면 같은 키와 같은 본문으로 다시 보내고, 거절 뒤에는 새 키로 보낸다", async () => {
    const server = await released("optional");
    const answers = [
      () => {
        throw new TypeError("connection lost");
      },
      () => apiError(500, "INTERNAL_ERROR", "boom"),
      () => apiError(429, "RATE_LIMITED", "slow down"),
      created,
    ];
    const first = server.detail();
    let served = first;
    const { api, history, services } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      [`GET ${PATH}`]: () => json(200, served),
      "POST /v1/sessions": () => (answers.shift() as () => Response)(),
    });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    const send = async () =>
      user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await send();
    await within(dialog).findByRole("alert");
    served = withRelease(first, { id: NEWER_RELEASE });
    await services.queryClient.invalidateQueries();
    await send();
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        "서버에서 처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
      ),
    );
    await send();
    await within(dialog).findByText(/시도가 너무 많습니다/);
    await send();
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
    const sent = api.calls.filter(
      (call) => call.method === "POST" && call.path === "/v1/sessions",
    );
    const keys = sent.map((call) => call.headers.get("Idempotency-Key"));
    expect(sent).toHaveLength(4);
    expect(keys[1]).toBe(keys[0] as string);
    expect(keys[2]).toBe(keys[0] as string);
    expect(keys[3] === keys[0]).toBe(false);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[2]?.body).toEqual(sent[0]?.body);
    expect(sent[3]?.body).toEqual({
      agent_release_id: NEWER_RELEASE,
      message: "요약해 줘",
    });
  });

  test("응답을 못 받은 뒤 메시지를 고치면 새 키로 고친 본문을 보낸다", async () => {
    const server = await released("optional");
    const answers = [
      () => {
        throw new TypeError("connection lost");
      },
      created,
    ];
    const { api, history } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": () => (answers.shift() as () => Response)(),
    });
    const { user, dialog } = await openDialog();
    const field = within(dialog).getByLabelText(MESSAGE);
    await user.type(field, "요약해 줘");
    const send = async () =>
      user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await send();
    await within(dialog).findByRole("alert");
    await user.type(field, " 짧게");
    await send();
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
    const sent = api.calls.filter(
      (call) => call.method === "POST" && call.path === "/v1/sessions",
    );
    expect(sent).toHaveLength(2);
    expect(
      sent[1]?.headers.get("Idempotency-Key") ===
        sent[0]?.headers.get("Idempotency-Key"),
    ).toBe(false);
    expect(sent[1]?.body).toEqual({
      agent_release_id: server.detail().active_release?.id,
      message: "요약해 줘 짧게",
    });
  });

  test("보낸 뒤 답이 오기 전에는 Esc로도 취소로도 닫히지 않고, 답이 오면 이동한다", async () => {
    const server = await released("optional");
    let answer: (response: Response) => void = () => undefined;
    const { history } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await within(dialog).findByRole("button", { name: "시작하는 중…" });
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog") === null).toBe(false);
    answer(created());
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
  });

  test("세션을 만들면 세션 목록과 답변 대기, 에이전트의 세션 목록을 새로 읽게 한다", async () => {
    const server = await released("optional");
    const { history, services } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": created,
    });
    const { queryClient } = services;
    const client = withQueryScope({} as ApiClient, SCOPE);
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    const invalidated: (InvalidateQueryFilters | undefined)[] = [];
    queryClient.invalidateQueries = ((filters) => {
      invalidated.push(filters);
      return invalidate(filters);
    }) as typeof queryClient.invalidateQueries;
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
    const sent = (key: unknown) =>
      invalidated.filter(
        (filters) => JSON.stringify(filters?.queryKey) === JSON.stringify(key),
      );
    expect(sent(sessionsQuery(client).queryKey)[0]?.exact).toBe(true);
    expect(sent(waitingSessionsQuery(client).queryKey)[0]?.exact).toBe(true);
    // Every agent's list sits under this key, so it must match as a prefix.
    const lists = agentSessionListsFilter(client);
    expect(sent(lists.queryKey)).toEqual([lists]);
  });

  describe("시작할 수 없는 상태마다 이유가 보인다", () => {
    test("릴리스가 없다", async () => {
      renderAt(DETAIL, { ...meAs(me()), ...agentServer().routes });
      await expectBlocked(
        "활성 릴리스가 없어 세션을 시작할 수 없습니다. 상세 설정에서 프로필을 골라 저장하면 시작할 수 있습니다.",
      );
    });

    for (const [status, reason] of [
      ["archived", "보관된 에이전트라 세션을 시작할 수 없습니다."],
      ["paused", "일시정지된 에이전트라 세션을 시작할 수 없습니다."],
    ] as const) {
      test(`에이전트가 ${status}다`, async () => {
        const server = await released("optional");
        const detail = server.detail();
        renderAt(DETAIL, {
          ...meAs(me()),
          ...server.routes,
          [`GET ${PATH}`]: () =>
            json(200, { ...detail, agent: { ...detail.agent, status } }),
        });
        await expectBlocked(reason);
      });
    }

    test("sessions:write가 없다", async () => {
      const server = await released("optional");
      renderAt(DETAIL, {
        ...meAs(me(["sessions:read"], "member")),
        ...server.routes,
      });
      await expectBlocked("sessions:write 권한이 있어야 할 수 있습니다.");
    });

    const profileReason =
      "활성 릴리스의 프로필을 쓸 수 없어 세션을 시작할 수 없습니다. 쓸 수 있는 프로필로 다시 릴리스하세요.";
    const repositoryReason =
      "활성 릴리스가 쓸 수 있는 저장소가 없어 세션을 시작할 수 없습니다. 저장소를 골라 다시 릴리스하세요.";

    test("프로필이 카탈로그에 없다", async () => {
      const server = await released("optional");
      renderAt(DETAIL, {
        ...meAs(me()),
        ...server.routes,
        ...profilesRoute(server, (items) =>
          items.filter((item) => item.id !== local),
        ),
      });
      await expectBlocked(profileReason);
    });

    test("프로필이 막혔다", async () => {
      const server = await released("optional");
      renderAt(
        DETAIL,
        {
          ...meAs(me()),
          ...server.routes,
          ...profilesRoute(server, installationState("blocked")),
        },
        "ko",
        "warn",
      );
      await expectBlocked(profileReason);
    });

    test("릴리스에 저장소가 없으면 프로필이 저장소를 요구해도 막지 않는다", async () => {
      const server = await released("required");
      const detail = withRelease(server.detail(), { repository_id: null });
      renderAt(DETAIL, {
        ...meAs(me()),
        ...server.routes,
        [`GET ${PATH}`]: () => json(200, detail),
      });
      await waitFor(async () =>
        expect((await button()).getAttribute("aria-disabled")).toBeNull(),
      );
      expect(screen.queryByText(repositoryReason) === null).toBe(true);
    });

    test("릴리스의 저장소가 프로필이 허용하는 목록 밖이다", async () => {
      const server = await released("optional");
      renderAt(DETAIL, {
        ...meAs(me()),
        ...server.routes,
        ...profilesRoute(server, (items) =>
          items.map((item) =>
            item.id === local ? { ...item, repository_ids: ["other"] } : item,
          ),
        ),
      });
      await expectBlocked(repositoryReason);
    });

    test("릴리스의 저장소가 GitHub 설정 밖이다", async () => {
      const server = await released("optional");
      const detail = withRelease(server.detail(), {
        policy_pins: { github: { repositories: ["other"] } },
      } as never);
      renderAt(
        DETAIL,
        {
          ...meAs(me()),
          ...server.routes,
          [`GET ${PATH}`]: () => json(200, detail),
        },
        "ko",
        "warn",
      );
      await expectBlocked(repositoryReason);
    });
  });

  for (const [name, change] of [
    ["retired", installationState("retired")],
    [
      "base_retired",
      (items: ProfileSummary[]) =>
        items.map((item) =>
          item.id === local
            ? ({
                ...item,
                source: "workspace",
                workspace: { state: "base_retired" },
              } as ProfileSummary)
            : item,
        ),
    ],
  ] as const) {
    test(`릴리스가 고정한 프로필이 ${name}여도 서버처럼 시작을 허용한다`, async () => {
      const server = await released("optional");
      renderAt(
        DETAIL,
        {
          ...meAs(me()),
          ...server.routes,
          ...profilesRoute(server, change),
        },
        "ko",
        "warn",
      );
      await openDialog();
    });
  }

  test("프로필을 읽지 못하면 끄지 않고 서버의 판단에 맡긴다", async () => {
    const server = await released("optional");
    renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "GET /v1/profiles": () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    await openDialog();
  });

  describe("설정을 읽지 못하는 바깥 멤버", () => {
    const outsider = async (access: "use" | "view") => {
      const server = await released("optional");
      const who = memberMe();
      const workspace = who.workspace as NonNullable<typeof who.workspace>;
      return {
        server,
        routes: {
          ...meAs({
            ...who,
            workspace: {
              ...workspace,
              settings: {
                ...workspace.settings,
                agent_outsider_access: access,
              },
            },
          }),
          ...server.routes,
          "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
          [`GET ${PATH}`]: () =>
            apiError(403, "FORBIDDEN", "This principal may not read the agent"),
          "GET /v1/agents": () =>
            json(200, { items: [server.detail().agent], next_cursor: null }),
          "POST /v1/sessions": created,
        },
      };
    };

    test("`use`면 요약의 릴리스로 세션을 시작한다", async () => {
      const { server, routes } = await outsider("use");
      const { api, history } = renderAt(DETAIL, routes);
      const { user, dialog } = await openDialog();
      expect(within(dialog).queryByText(/저장소/)).toBeNull();
      await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
      await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
      await waitFor(() =>
        expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
      );
      expect(
        api.calls.find(
          (call) => call.method === "POST" && call.path === "/v1/sessions",
        )?.body,
      ).toEqual({
        agent_release_id: server.detail().agent.active_release_id,
        message: "요약해 줘",
      });
    });

    test("`view`면 이유를 보이고 시작하지 못한다", async () => {
      const { routes } = await outsider("view");
      renderAt(DETAIL, routes);
      await expectBlocked(
        "담당 팀 구성원과 관리자만 이 에이전트로 세션을 시작할 수 있습니다.",
      );
    });
  });

  test("ko·en·ja에 대화상자와 이유 문구가 모두 있다", () => {
    const keys = Object.keys(agentsKo).filter((key) =>
      key.startsWith("agent.newSession."),
    ) as (keyof typeof agentsKo)[];
    expect(keys).toHaveLength(14);
    for (const key of keys) {
      expect(agentsEn[key]?.trim()).toBeTruthy();
      expect(agentsJa[key]?.trim()).toBeTruthy();
      expect(agentsEn[key] === agentsKo[key]).toBe(false);
      expect(agentsJa[key] === agentsKo[key]).toBe(false);
    }
  });
});
