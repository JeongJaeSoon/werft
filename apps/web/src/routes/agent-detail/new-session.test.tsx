import { describe, expect, test } from "bun:test";
import type { InvalidateQueryFilters } from "@tanstack/react-query";
import type { ApiClient } from "@werft-ai/client";
import type {
  AgentDetail,
  AuthMeResponse,
  ConnectionOption,
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
// After the harness: the module pulls in the UI, which needs the DOM.
const { optionalSkills } = await import("./new-session.tsx");

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

async function released() {
  const server = agentServer({ releaseRepository: "sample-app" });
  const routes = server.routes as Routes;
  await routes[`PATCH ${PATH}`]?.(
    new Request(`http://test${PATH}`, {
      method: "PATCH",
      body: JSON.stringify({ connection_id: "anthropic-main" }),
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

type ConnectionChange = (items: ConnectionOption[]) => ConnectionOption[];

function connectionsRoute(
  server: { routes: unknown },
  change: ConnectionChange,
) {
  return {
    "GET /v1/connections": async (request: Request) => {
      const listed = await (server.routes as Routes)["GET /v1/connections"]?.(
        request,
      );
      const { items } = (await listed?.json()) as {
        items: ConnectionOption[];
      };
      return json(200, { items: change(items) });
    },
  };
}

const main = "anthropic-main";
const withModels =
  (
    models: string[],
    model_successors: Record<string, string> = {},
  ): ConnectionChange =>
  (items) =>
    items.map((item) =>
      item.id === main ? { ...item, models, model_successors } : item,
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
    const server = await released();
    const { api, history } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": created,
    });
    const { user, dialog } = await openDialog();
    // Which repository the session starts on is the server's decision.
    expect(within(dialog).queryByText("sample-app")).toBeNull();
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

  test("선택 스킬만 켤 수 있고, 켠 스킬의 버전을 세션에 싣는다", async () => {
    const server = await released();
    const skillVersion = (name: string, n: number) => ({
      id: `9a8b7c6d-0000-4000-8000-00000000000${n}`,
      name,
      version: 1,
      digest: String(n).repeat(64),
      source: "upload" as const,
      git: null,
      size_bytes: 512,
      has_scripts: false,
      review: "approved" as const,
      registered_by: null,
      registered_at: "2026-11-21T03:00:00.000Z",
      reviewed_by: null,
      reviewed_at: null,
      archived_at: null,
      current: true,
    });
    const { api } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      [`GET ${PATH}/skills`]: () =>
        json(200, {
          items: [
            {
              name: "notes",
              scope: "workspace",
              mode: "optional",
              follows: false,
              version: skillVersion("notes", 1),
            },
            {
              name: "lint",
              scope: "workspace",
              mode: "required",
              follows: false,
              version: skillVersion("lint", 2),
            },
            // The agent narrows a workspace optional to forbidden.
            {
              name: "deploy",
              scope: "workspace",
              mode: "optional",
              follows: false,
              version: skillVersion("deploy", 3),
            },
            {
              name: "deploy",
              scope: "agent",
              mode: "forbidden",
              follows: false,
              version: skillVersion("deploy", 3),
            },
          ],
        }),
      "POST /v1/sessions": created,
    });
    const { user, dialog } = await openDialog();
    const toggle = await within(dialog).findByRole("switch", {
      name: "notes 켜기",
    });
    expect(within(dialog).queryByRole("switch", { name: "lint 켜기" })).toBe(
      null,
    );
    expect(within(dialog).queryByRole("switch", { name: "deploy 켜기" })).toBe(
      null,
    );
    await user.click(toggle);
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) => call.method === "POST" && call.path === "/v1/sessions",
        ),
      ).toHaveLength(1),
    );
    const sent = api.calls.find(
      (call) => call.method === "POST" && call.path === "/v1/sessions",
    );
    expect(sent?.body).toEqual({
      agent_release_id: server.detail().active_release?.id,
      message: "요약해 줘",
      extensions: { enable: ["9a8b7c6d-0000-4000-8000-000000000001"] },
    });
  });

  test("켠 뒤 스킬 목록을 다시 읽지 못해도 켠 스킬을 싣는다", async () => {
    const server = await released();
    let failing = false;
    const { api, services } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      [`GET ${PATH}/skills`]: () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, {
              items: [
                {
                  name: "notes",
                  scope: "workspace",
                  mode: "optional",
                  follows: false,
                  version: {
                    id: "9a8b7c6d-0000-4000-8000-000000000001",
                    name: "notes",
                    version: 1,
                    digest: "1".repeat(64),
                    source: "upload",
                    git: null,
                    size_bytes: 512,
                    has_scripts: false,
                    review: "approved",
                    registered_by: null,
                    registered_at: "2026-11-21T03:00:00.000Z",
                    reviewed_by: null,
                    reviewed_at: null,
                    archived_at: null,
                    current: true,
                  },
                },
              ],
            }),
      "POST /v1/sessions": created,
    });
    services.queryClient.setDefaultOptions({ queries: { retry: false } });
    const { user, dialog } = await openDialog();
    const toggle = await within(dialog).findByRole("switch", {
      name: "notes 켜기",
    });
    // The name is the switch's label: clicking it turns the skill on.
    await user.click(within(dialog).getByText("notes"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    failing = true;
    await services.queryClient.refetchQueries({ type: "active" });
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await waitFor(() =>
      expect(
        api.calls.find(
          (call) => call.method === "POST" && call.path === "/v1/sessions",
        )?.body,
      ).toEqual({
        agent_release_id: server.detail().active_release?.id,
        message: "요약해 줘",
        extensions: { enable: ["9a8b7c6d-0000-4000-8000-000000000001"] },
      }),
    );
    expect(
      api.calls.filter((call) => call.path === `${PATH}/skills`).length,
    ).toBeGreaterThan(1);
  });

  test("공백뿐인 메시지는 보내지 않고 이유를 보인다", async () => {
    const server = await released();
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

  test("UTF-8로 32KB를 넘는 메시지는 글자 수가 한도 안이어도 보내지 않고 이유를 보인다", async () => {
    const server = await released();
    const { api } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "POST /v1/sessions": created,
    });
    const { user, dialog } = await openDialog();
    const field = within(dialog).getByLabelText(MESSAGE);
    await user.click(field);
    // 10,923 three-byte characters: 32,769 bytes.
    await user.paste("가".repeat(10_923));
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    expect(
      await within(dialog).findByText(
        "메시지가 너무 깁니다. 32KB(UTF-8) 이하로 줄이세요. 한글은 한 글자가 3바이트입니다.",
      ),
    ).toBeDefined();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("서버가 거절하면 대화상자에 이유를 보이고 입력을 남긴다", async () => {
    const server = await released();
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

  test("저장소가 필요하다고 서버가 거절하면 화면이 미리 막지 않았어도 대화상자에 이유를 보인다", async () => {
    const server = await released();
    const detail = withRelease(server.detail(), { repository_id: null });
    renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      [`GET ${PATH}`]: () => json(200, detail),
      "POST /v1/sessions": () =>
        apiError(
          409,
          "UNSUPPORTED_CAPABILITY",
          "Release needs a repository: send repository_id",
        ),
    });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "연결",
    );
  });

  test("스킬 선택을 거절하면 그 스킬과 이유를 보이고 목록을 다시 읽는다", async () => {
    const server = await released();
    const { api } = renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      [`GET ${PATH}/skills`]: () => json(200, { items: [] }),
      "POST /v1/sessions": () =>
        apiError(409, "UNSUPPORTED_CAPABILITY", "not optional", false, {
          reason_code: "not_optional",
          bundle: "notes",
        }),
    });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "notes 스킬의 지정이 바뀌어",
    );
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path === `${PATH}/skills`).length,
      ).toBeGreaterThan(1),
    );
  });

  test("릴리스 도구에 Skill이 없어 거절하면 그 고치는 법을 보인다", async () => {
    const server = await released();
    renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      [`GET ${PATH}/skills`]: () => json(200, { items: [] }),
      "POST /v1/sessions": () =>
        apiError(409, "UNSUPPORTED_CAPABILITY", "no Skill tool", false, {
          reason_code: "skill_tool_not_allowed",
          bundle: "notes",
        }),
    });
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText(MESSAGE), "요약해 줘");
    await user.click(within(dialog).getByRole("button", { name: SUBMIT }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "notes 스킬을 쓰려면 릴리스의 도구에 Skill이 있어야 합니다.",
    );
  });

  test("대화상자를 닫았다 열어도 쓰던 메시지가 남는다", async () => {
    const server = await released();
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
    const server = await released();
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
    const server = await released();
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
    const server = await released();
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
    const server = await released();
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
        "게시하기 전에는 세션을 시작할 수 없습니다. 미리 써 본 뒤 게시하면 시작할 수 있습니다.",
      );
    });

    for (const [status, reason] of [
      ["archived", "보관된 에이전트라 세션을 시작할 수 없습니다."],
      ["paused", "일시 정지된 에이전트라 세션을 시작할 수 없습니다."],
    ] as const) {
      test(`에이전트가 ${status}다`, async () => {
        const server = await released();
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
      const server = await released();
      renderAt(DETAIL, {
        ...meAs(me(["sessions:read"], "member")),
        ...server.routes,
      });
      await expectBlocked("sessions:write 권한이 있어야 할 수 있습니다.");
    });

    const connectionReason =
      "활성 릴리스의 모델 연결이 꺼졌거나 그 모델이 연결에서 빠져 세션을 시작할 수 없습니다. 쓸 수 있는 연결과 모델로 다시 릴리스하세요.";

    test("연결이 목록에 없다", async () => {
      const server = await released();
      renderAt(DETAIL, {
        ...meAs(me()),
        ...server.routes,
        ...connectionsRoute(server, (items) =>
          items.filter((item) => item.id !== main),
        ),
      });
      await expectBlocked(connectionReason);
    });

    test("모델이 연결에서 빠졌고 옮겨 갈 모델이 없다", async () => {
      const server = await released();
      renderAt(
        DETAIL,
        {
          ...meAs(me()),
          ...server.routes,
          ...connectionsRoute(server, withModels(["claude-haiku-5"])),
        },
        "ko",
        "warn",
      );
      await expectBlocked(connectionReason);
    });

    test("릴리스에 저장소가 없어도 화면은 막지 않는다", async () => {
      const server = await released();
      const detail = withRelease(server.detail(), { repository_id: null });
      renderAt(DETAIL, {
        ...meAs(me()),
        ...server.routes,
        [`GET ${PATH}`]: () => json(200, detail),
      });
      await waitFor(async () =>
        expect((await button()).getAttribute("aria-disabled")).toBeNull(),
      );
    });

    // A session starts without a repository, or on its release's when the
    // agent has no settings row; only the server knows which, so it decides.
    test("릴리스의 저장소가 GitHub 설정 밖이어도 화면은 막지 않는다", async () => {
      const server = await released();
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
      await waitFor(async () =>
        expect((await button()).getAttribute("aria-disabled")).toBeNull(),
      );
      await openDialog();
    });
  });

  test("모델이 연결에서 빠졌어도 옮겨 갈 모델이 있으면 서버처럼 시작을 허용한다", async () => {
    const server = await released();
    renderAt(
      DETAIL,
      {
        ...meAs(me()),
        ...server.routes,
        ...connectionsRoute(
          server,
          withModels(["claude-haiku-5"], {
            "claude-sonnet-5": "claude-haiku-5",
          }),
        ),
      },
      "ko",
      "warn",
    );
    await openDialog();
  });

  test("연결 목록을 읽지 못하면 끄지 않고 서버의 판단에 맡긴다", async () => {
    const server = await released();
    renderAt(DETAIL, {
      ...meAs(me()),
      ...server.routes,
      "GET /v1/connections": () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    await openDialog();
  });

  test("담당 팀 밖 멤버에게는 에이전트가 없는 것으로 보이고, 새 세션 버튼도 없다", async () => {
    const server = await released();
    const { api } = renderAt(DETAIL, {
      ...meAs(memberMe()),
      ...server.routes,
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
      [`GET ${PATH}`]: () => apiError(404, "NOT_FOUND", "Agent not found"),
      "POST /v1/sessions": created,
    });
    await screen.findByRole("heading", { name: "에이전트를 찾을 수 없습니다" });
    expect(screen.queryByRole("button", { name: BUTTON }) === null).toBe(true);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("ko·en·ja에 대화상자와 이유 문구가 모두 있다", () => {
    const keys = Object.keys(agentsKo).filter((key) =>
      key.startsWith("agent.newSession."),
    ) as (keyof typeof agentsKo)[];
    expect(keys).toHaveLength(12);
    for (const key of keys) {
      expect(agentsEn[key]?.trim()).toBeTruthy();
      expect(agentsJa[key]?.trim()).toBeTruthy();
      expect(agentsEn[key] === agentsKo[key]).toBe(false);
      expect(agentsJa[key] === agentsKo[key]).toBe(false);
    }
  });
});

describe("optionalSkills", () => {
  const entry = (
    scope: "workspace" | "agent",
    mode: "required" | "optional" | "forbidden",
  ) => ({
    name: "deploy",
    scope,
    mode,
    follows: false,
    version: {
      id: `9a8b7c6d-0000-4000-8000-00000000000${scope === "agent" ? 1 : 2}`,
      name: "deploy",
      version: 1,
      digest: "1".repeat(64),
      source: "upload" as const,
      git: null,
      size_bytes: 512,
      has_scripts: false,
      review: "approved" as const,
      registered_by: null,
      registered_at: "2026-11-21T03:00:00.000Z",
      reviewed_by: null,
      reviewed_at: null,
      archived_at: null,
      current: true,
    },
  });

  test("워크스페이스의 required·forbidden은 목록 순서와 상관없이 에이전트의 optional보다 앞선다", () => {
    for (const mode of ["required", "forbidden"] as const) {
      const workspace = entry("workspace", mode);
      const agent = entry("agent", "optional");
      expect(optionalSkills([agent, workspace])).toEqual([]);
      expect(optionalSkills([workspace, agent])).toEqual([]);
    }
  });

  test("워크스페이스가 optional이면 목록 순서와 상관없이 에이전트의 지정이 정한다", () => {
    const workspace = entry("workspace", "optional");
    const agent = entry("agent", "optional");
    expect(optionalSkills([agent, workspace])).toEqual([agent]);
    expect(optionalSkills([workspace, agent])).toEqual([agent]);
    const forbidden = entry("agent", "forbidden");
    expect(optionalSkills([forbidden, workspace])).toEqual([]);
  });

  test("쓸 수 없는 에이전트 optional은 빠지고 워크스페이스의 승인 버전이 남는다", () => {
    const workspace = entry("workspace", "optional");
    const base = entry("agent", "optional");
    const rejected = {
      ...base,
      version: { ...base.version, review: "rejected" as const },
    };
    const missing = { ...entry("agent", "optional"), version: null };
    for (const agent of [rejected, missing]) {
      expect(optionalSkills([agent, workspace])).toEqual([workspace]);
      expect(optionalSkills([workspace, agent])).toEqual([workspace]);
    }
  });
});
