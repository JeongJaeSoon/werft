import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
  STORE_OFF,
  WORKSPACE_ID,
  workspaceEngineSettings,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const harness = await appHarness();
const { screen, waitFor, within } = harness;

const CONNECTIONS = {
  items: [
    connection("anthropic-fast", ["claude-haiku-5"]),
    connection("anthropic-main", ["claude-haiku-5", "claude-sonnet-5"]),
  ],
};
// Every settings page reads the connections for its model card; the
// Slack page also reads the token and the apps it made.
const renderAt: typeof harness.renderAt = (path, routes, locale) =>
  harness.renderAt(
    path,
    {
      "GET /v1/connections": () => json(200, CONNECTIONS),
      [`GET /v1/workspaces/${WORKSPACE_ID}/engine-settings`]: () =>
        json(200, workspaceEngineSettings()),
      [`GET ${TOKEN}`]: () => json(200, REGISTERED_TOKEN),
      [`GET ${APPS}`]: () => json(200, { items: [] }),
      ...routes,
    },
    locale,
  );

function connection(id: string, models: string[]) {
  return {
    id,
    kind: "anthropic",
    billing: "metered",
    models,
    model_successors: {},
  } as const;
}

const RETENTION = `/v1/workspaces/${WORKSPACE_ID}/audit-retention`;
const GUEST = `/v1/workspaces/${WORKSPACE_ID}/slack-guest`;
const ACCESS = `/v1/workspaces/${WORKSPACE_ID}/agent-access`;
const textOfIds = (ids: string | null) =>
  (ids ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
const descriptionOf = (element: HTMLElement) =>
  textOfIds(element.getAttribute("aria-describedby"));
// The retention and agent access cards each have a 저장.
const retentionSave = () =>
  within(screen.getByRole("region", { name: "감사 기록 보존 기간" })).getByRole(
    "button",
    { name: "저장" },
  );
const findRetentionSave = async () =>
  within(
    await screen.findByRole("region", { name: "감사 기록 보존 기간" }),
  ).getByRole("button", { name: "저장" });
const APPS = `/v1/workspaces/${WORKSPACE_ID}/slack/apps`;
const TOKEN = `/v1/workspaces/${WORKSPACE_ID}/slack/config-token`;
const NO_SECRET = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
};
const ADDRESSES = {
  redirect_url: "https://werft.example/settings/linked-accounts/slack",
  events_url_template: "https://werft.example/v1/slack/events/{agent_id}",
};
const UNSET_TOKEN = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
  urls: ADDRESSES,
  state: "unset",
  expires_at: null,
  issuer: null,
};
const REGISTERED_TOKEN = {
  ...UNSET_TOKEN,
  configured: true,
  last4: "wxyz",
  state: "active",
  updated_at: "2026-10-20T05:00:00.000Z",
};
const LINK_APP = {
  slack_app: {
    id: "019a0000-0000-7000-8000-0000000000a1",
    kind: "link",
    agent_id: null,
    state: "created",
    app_id: "A0LINK0001",
    client_id: "1000.1",
    redirect_url: "https://console.example.test/callback",
    created_by_token_user: "U0ISSUER",
    created_at: "2026-10-01T00:20:00.000Z",
    updated_at: "2026-10-23T12:48:00.000Z",
    secrets: {
      slack_signing_secret: NO_SECRET,
      slack_client_secret: { ...NO_SECRET, configured: true },
      slack_bot_token: NO_SECRET,
    },
  },
  agent: null,
};
const adminMe = () => me(undefined, "admin");
const withGuest = (body: ReturnType<typeof me>, enabled: boolean) => ({
  ...body,
  workspace: body.workspace && {
    ...body.workspace,
    settings: { ...body.workspace.settings, slack_guest_enabled: enabled },
  },
});
const GUEST_SWITCH = { name: "Slack 게스트도 에이전트를 쓸 수 있게 하기" };
// The Slack card with no token and no app yet.
const START = "아직 등록된 토큰이 없습니다";
const TOKEN_MENU = { name: "App Configuration Token 메뉴" };

/** The token row's ⋯ menu, then one of its items. */
async function tokenMenu(
  user: Awaited<ReturnType<typeof setupUser>>,
  item: string,
) {
  await user.click(await screen.findByRole("button", TOKEN_MENU));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

// Deleting the token lives in the page's danger zone.
const DELETE_TOKEN = { name: "App Configuration Token 삭제" };
async function deleteToken(user: Awaited<ReturnType<typeof setupUser>>) {
  const zone = await screen.findByRole("region", { name: "위험 구역" });
  await user.click(within(zone).getByRole("button", DELETE_TOKEN));
}

describe("워크스페이스 설정", () => {
  test("소유자는 보존 기간을 바꾸고, 저장한 값으로 다시 읽는다", async () => {
    let days = 90;
    const ownerMe = () => {
      const body = me();
      return {
        ...body,
        workspace: body.workspace && {
          ...body.workspace,
          settings: { ...body.workspace.settings, audit_retention_days: days },
        },
      };
    };
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, ownerMe()),
      [`POST ${RETENTION}`]: async (request: Request) => {
        days = ((await request.json()) as { audit_retention_days: number })
          .audit_retention_days;
        return json(200, { audit_retention_days: days });
      },
    });
    const input = (await screen.findByLabelText(
      "보존 기간(일)",
    )) as HTMLInputElement;
    expect(input.value).toBe("90");
    const unit = input.nextElementSibling;
    expect(unit?.textContent).toBe("일");
    expect(unit?.getAttribute("aria-hidden")).toBe("true");
    expect(
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent),
    ).toEqual([
      "허용·거절한 요청 기록을 이 기간 동안 보관합니다.",
      "30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.",
    ]);
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "180");
    await user.click(retentionSave());
    expect((await screen.findByRole("status")).textContent).toBe(
      "감사 기록을 180일 보존합니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "POST").map((c) => c.body),
    ).toEqual([{ audit_retention_days: 180 }]);
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.path === "/v1/auth/me").length,
      ).toBeGreaterThan(1),
    );
  });

  test("고치지 않은 입력은 다시 읽은 보존 기간을 따른다", async () => {
    let days = 90;
    const ownerMe = () => {
      const body = me();
      return {
        ...body,
        workspace: body.workspace && {
          ...body.workspace,
          settings: { ...body.workspace.settings, audit_retention_days: days },
        },
      };
    };
    const { services } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, ownerMe()),
    });
    const input = (await screen.findByLabelText(
      "보존 기간(일)",
    )) as HTMLInputElement;
    expect(input.value).toBe("90");
    // Another owner raised it; the next read brings the new value.
    days = 365;
    await services.queryClient.invalidateQueries({ queryKey: ["me"] });
    await waitFor(() => expect(input.value).toBe("365"));
  });

  test("저장하는 동안 고친 입력은 저장이 끝나도 남는다", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: async () => {
        await held;
        return json(200, { audit_retention_days: 180 });
      },
    });
    const input = (await screen.findByLabelText(
      "보존 기간(일)",
    )) as HTMLInputElement;
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "180");
    await user.click(retentionSave());
    await user.clear(input);
    await user.type(input, "200");
    release();
    expect((await screen.findByRole("status")).textContent).toBe(
      "감사 기록을 180일 보존합니다.",
    );
    expect(input.value).toBe("200");
  });

  test("30일보다 짧으면 서버가 거절하고 그 이유를 보인다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: () =>
        apiError(400, "BAD_REQUEST", "Invalid request body"),
    });
    const input = await screen.findByLabelText("보존 기간(일)");
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "29");
    await user.click(retentionSave());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요.",
    );
    expect(
      api.calls.filter((c) => c.method === "POST").map((c) => c.body),
    ).toEqual([{ audit_retention_days: 29 }]);
  });

  test("화면의 최대치는 계약의 최대치와 같다", async () => {
    const { AUDIT_RETENTION_MAX_DAYS: contract } = await import(
      "@werft-ai/contracts"
    );
    const { AUDIT_RETENTION_MAX_DAYS } = await import(
      "./workspace-settings.tsx"
    );
    expect(AUDIT_RETENTION_MAX_DAYS).toBe(contract);
  });

  test("에이전트 접근의 고르는 값은 계약의 값과 같다", async () => {
    const contracts = await import("@werft-ai/contracts");
    const { AGENT_ACCESS_CHOICES } = await import("./workspace-settings.tsx");
    expect(AGENT_ACCESS_CHOICES).toEqual({
      agent_outsider_access: [...contracts.AGENT_OUTSIDER_ACCESS_VALUES],
      agent_outsider_session_visibility: [
        ...contracts.AGENT_OUTSIDER_SESSION_VISIBILITY_VALUES,
      ],
    });
  });

  test("최대치를 넘기면 최대치를 넘겼다고 알린다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: () =>
        apiError(400, "BAD_REQUEST", "Invalid request body"),
    });
    const input = await screen.findByLabelText("보존 기간(일)");
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "99999");
    await user.click(retentionSave());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "감사 기록은 최대 3650일까지 보존할 수 있습니다. 3650일 이하로 정하세요.",
    );
  });

  test("관리자는 화면을 보지만 저장은 이유와 함께 닫혀 있고, 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, adminMe()),
    });
    const user = await setupUser();
    const save = await findRetentionSave();
    expect(save.getAttribute("aria-disabled")).toBe("true");
    // Still a submit button, and pressing it submits nothing.
    await user.click(save);
    expect(
      document.getElementById(save.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      "감사 기록 보존 기간 변경 권한이 있어야 할 수 있습니다. 지금 역할: 관리자.",
    );
    expect(
      (screen.getByLabelText("보존 기간(일)") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(api.calls.some((c) => c.path === RETENTION)).toBe(false);
  });

  test("서버가 403이면 같은 이유 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: () =>
        apiError(403, "FORBIDDEN", "Only an owner can change audit retention"),
    });
    const user = await setupUser();
    await user.click(await findRetentionSave());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "감사 기록 보존 기간 변경 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });

  test("관리자가 게스트 사용을 켜면 서버에 저장하고 다시 읽은 값으로 켜짐이다", async () => {
    let enabled = false;
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(adminMe(), enabled)),
      [`POST ${GUEST}`]: async (request: Request) => {
        enabled = ((await request.json()) as { slack_guest_enabled: boolean })
          .slack_guest_enabled;
        return json(200, { slack_guest_enabled: enabled });
      },
    });
    const region = await screen.findByRole("region", { name: "Slack 게스트" });
    const toggle = within(region).getByRole("switch", GUEST_SWITCH);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("꺼짐")).toBeDefined();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("자기 Slack 계정을 연결해야");
    const user = await setupUser();
    await user.click(toggle);
    expect((await screen.findByRole("status")).textContent).toBe(
      "이제 Slack 게스트도 에이전트를 쓸 수 있습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }]);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByText("켜짐")).toBeDefined();
  });

  test("게스트 스위치는 설정 행 컨트롤 칸의 마지막이고, 읽지 않는 켜짐·꺼짐 글자가 바로 앞에 있다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(adminMe(), false)),
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const row = toggle.closest('[data-slot="setting-row"]');
    expect(row?.closest("section")?.getAttribute("aria-labelledby")).toBe(
      screen.getByRole("heading", { name: "Slack 게스트" }).id,
    );
    // bun's toBe passes on unrelated DOM nodes; compare elements with ===.
    const slot = toggle.parentElement;
    expect(slot?.lastElementChild === toggle).toBe(true);
    expect(slot?.parentElement?.parentElement === row).toBe(true);
    const status = toggle.previousElementSibling;
    expect(status?.textContent).toBe("꺼짐");
    expect(status?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "꺼짐",
    );
    expect(row?.querySelector(`label[for="${toggle.id}"]`)?.textContent).toBe(
      GUEST_SWITCH.name,
    );
  });

  test("키보드로 스위치에 가서 Space로 켜고 Enter로 끈다", async () => {
    let enabled = false;
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), enabled)),
      [`POST ${GUEST}`]: async (request: Request) => {
        enabled = ((await request.json()) as { slack_guest_enabled: boolean })
          .slack_guest_enabled;
        return json(200, { slack_guest_enabled: enabled });
      },
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const user = await setupUser();
    const copies = within(
      await screen.findByRole("region", { name: "Slack 앱에 넣을 주소" }),
    ).getAllByRole("button", { name: "복사" });
    (copies[copies.length - 1] as HTMLElement).focus();
    await user.tab();
    expect(document.activeElement === toggle).toBe(true);
    await user.keyboard(" ");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }, { slack_guest_enabled: false }]);
  });

  test("저장 중에도 포커스가 스위치에 남고, 그동안 다시 누른 Space는 보내지 않는다", async () => {
    let enabled = false;
    let release = () => {};
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), enabled)),
      [`POST ${GUEST}`]: async (request: Request) => {
        const sent = (await request.json()) as { slack_guest_enabled: boolean };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        enabled = sent.slack_guest_enabled;
        return json(200, { slack_guest_enabled: enabled });
      },
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const user = await setupUser();
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(document.activeElement === toggle).toBe(true);
    await user.keyboard(" ");
    release();
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(() =>
      expect(toggle.hasAttribute("aria-disabled")).toBe(false),
    );
    expect(document.activeElement === toggle).toBe(true);
    await user.keyboard(" ");
    release();
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }, { slack_guest_enabled: false }]);
  });

  test("라벨 글자를 눌러도 게스트 사용이 바뀐다", async () => {
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), false)),
      [`POST ${GUEST}`]: () => json(200, { slack_guest_enabled: true }),
    });
    await screen.findByRole("switch", GUEST_SWITCH);
    const user = await setupUser();
    await user.click(screen.getByText(GUEST_SWITCH.name));
    expect((await screen.findByRole("status")).textContent).toBe(
      "이제 Slack 게스트도 에이전트를 쓸 수 있습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }]);
  });

  test("보존 기간 저장 중에도 포커스가 저장 버튼에 남고, 다시 눌러도 한 번만 보낸다", async () => {
    let release = () => {};
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return json(200, { audit_retention_days: 90 });
      },
    });
    const button = await findRetentionSave();
    const user = await setupUser();
    await user.click(button);
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(document.activeElement === button).toBe(true);
    await user.keyboard("{Enter}");
    release();
    expect((await screen.findByRole("status")).textContent).toContain("90");
    expect(document.activeElement === button).toBe(true);
    expect(api.calls.filter((c) => c.path === RETENTION)).toHaveLength(1);
  });

  test("워크스페이스 설정 권한이 없으면 스위치가 이유와 함께 닫혀 있고, 서버에 묻지 않는다", async () => {
    const body = me();
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () =>
        json(200, {
          ...body,
          permissions: body.permissions.filter((p) => p !== "workspace.manage"),
        }),
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      "워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
    const user = await setupUser();
    await user.click(toggle);
    expect(api.calls.some((c) => c.path === GUEST)).toBe(false);
  });

  test("켜져 있으면 끄는 값을 보낸다", async () => {
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), true)),
      [`POST ${GUEST}`]: () => json(200, { slack_guest_enabled: false }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("switch", GUEST_SWITCH));
    expect((await screen.findByRole("status")).textContent).toBe(
      "이제 Slack 게스트는 에이전트를 쓸 수 없습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: false }]);
  });

  test("구성원은 입력 칸 없이 지금 설정만 읽고, 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    expect(
      await screen.findByText("감사 기록을 90일 보존합니다."),
    ).toBeDefined();
    expect(
      screen.getByText("Slack 게스트는 에이전트를 쓸 수 없습니다."),
    ).toBeDefined();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(document.body.textContent).not.toContain(".manage");
    expect(
      api.calls.some((c) => c.path === GUEST || c.path === RETENTION),
    ).toBe(false);
  });

  test("게스트 설정을 서버가 403으로 거절하면 같은 이유 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, adminMe()),
      [`POST ${GUEST}`]: () =>
        apiError(
          403,
          "FORBIDDEN",
          "Only an owner or admin can change the Slack guest setting",
        ),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("switch", GUEST_SWITCH));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: 관리자.",
    );
  });

  test("이름과 ID는 읽기만 하고, 모델 허용 목록은 연결의 모델을 한 번씩 보인다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const name = (await screen.findByRole("textbox", {
      name: "워크스페이스 이름",
    })) as HTMLInputElement;
    expect(name.value).toBe("Acme");
    expect(name.readOnly).toBe(true);
    expect(screen.getByText(WORKSPACE_ID).className).toContain("font-mono");
    const models = screen.getByRole("region", { name: "모델 허용 목록" });
    await waitFor(() =>
      expect(
        [...models.querySelectorAll("li")].map((li) => li.textContent),
      ).toEqual(["claude-haiku-5", "claude-sonnet-5"]),
    );
    // Only the run rules, retention and agent access cards save; the name and
    // models have no API to.
    expect(screen.getAllByRole("button", { name: "저장" })).toHaveLength(3);
    expect(screen.getAllByText("읽기 전용")).toHaveLength(2);
  });

  test("ID를 복사하면 복사했다고 알린다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const user = await setupUser();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    await user.click(await screen.findByRole("button", { name: "복사" }));
    const message = await screen.findByText("워크스페이스 ID를 복사했습니다.");
    expect(message.closest("[aria-live=polite]")).not.toBeNull();
    expect(written).toEqual([WORKSPACE_ID]);
  });

  test("복사가 거절되면 직접 복사하라고 알리고 ID를 선택해 둔다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const user = await setupUser();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: "복사" }));
    const message = await screen.findByText(
      "복사하지 못했습니다. ID를 직접 선택해 복사하세요.",
    );
    expect(message.closest("[aria-live=polite]")).not.toBeNull();
    expect(globalThis.getSelection?.()?.toString()).toBe(WORKSPACE_ID);
  });

  test("연결을 읽지 못하면 모델 카드에 다시 시도를 둔다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/connections": () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    const models = await screen.findByRole("region", {
      name: "모델 허용 목록",
    });
    await waitFor(() =>
      expect(models.querySelector("[role=alert]")).not.toBeNull(),
    );
    expect(models.textContent).toContain("다시 시도");
  });

  test("등록된 모델이 없으면 없다고 말한다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/connections": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText("이 설치에 등록된 모델이 없습니다."),
    ).toBeDefined();
  });

  test("소유자·관리자의 설정 메뉴는 워크스페이스 일반으로 연다", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, adminMe()) });
    expect(
      (await screen.findByRole("link", { name: "설정" })).getAttribute("href"),
    ).toBe("/settings/workspace");
  });

  test("구성원의 사이드바에는 설정이 없다(내 설정은 계정 메뉴: layout.test)", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    await within(nav).findByRole("link", { name: "에이전트" });
    expect(within(nav).queryByRole("link", { name: "설정" })).toBeNull();
  });

  test("App Configuration Token을 넣으면 다시 읽은 상태와 지우는 칸이 보인다", async () => {
    let saved = false;
    const active = {
      ...UNSET_TOKEN,
      configured: true,
      last4: "abcd",
      state: "active",
      updated_at: "2026-10-25T05:00:00.000Z",
    };
    const { api, services } = renderAt(
      "/settings/workspace/integrations/slack",
      {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${TOKEN}`]: () => json(200, saved ? active : UNSET_TOKEN),
        [`PUT ${TOKEN}`]: () => {
          saved = true;
          return json(200, {
            ...active,
            receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
            warnings: [],
          });
        },
      },
    );
    expect(await screen.findByText(START)).toBeDefined();
    expect(screen.queryByRole("heading", { name: "위험 구역" })).toBeNull();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "토큰 등록" }));
    const input = screen.getByLabelText("Refresh Token");
    expect(document.activeElement === input).toBe(true);
    await user.type(input, "fake-config-value");
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "App Configuration Token을 등록했습니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ value: "fake-config-value" }]);
    expect(await screen.findByText("토큰 확인됨")).toBeDefined();
    expect(screen.getByRole("button", TOKEN_MENU)).toBeDefined();
    expect(screen.getByRole("region", { name: "Slack 게스트" })).toBeDefined();
    // The start card is gone; focus is on the token's heading, before its menu.
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("heading", { name: "Slack 앱 생성" }),
      ).toBe(true),
    );
    // The value went to the server and nowhere else.
    await waitFor(() =>
      expect(
        JSON.stringify(
          services.queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.variables),
        ),
      ).not.toContain("fake-config-value"),
    );
  });

  test("저장 뒤 다시 읽기가 끝나지 않아도 token 값은 캐시에 남지 않는다", async () => {
    let saved = false;
    const { services } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      // The read after the save never answers.
      [`GET ${TOKEN}`]: () =>
        saved ? new Promise<Response>(() => {}) : json(200, UNSET_TOKEN),
      [`PUT ${TOKEN}`]: () => {
        saved = true;
        return json(200, {
          ...UNSET_TOKEN,
          configured: true,
          last4: "abcd",
          state: "active",
          updated_at: "2026-10-25T05:00:00.000Z",
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          warnings: [],
        });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 등록" }));
    await user.type(
      screen.getByLabelText("Refresh Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "등록" }));
    await screen.findByRole("status");
    await waitFor(() =>
      expect(
        JSON.stringify(
          services.queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.variables),
        ),
      ).not.toContain("fake-config-value"),
    );
  });

  test("token 칸을 취소하면 포커스가 칸을 연 버튼으로 돌아간다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 등록" }));
    expect(
      document.activeElement === screen.getByLabelText("Refresh Token"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByLabelText("Refresh Token")).toBeNull();
    expect(document.activeElement?.textContent).toBe("토큰 등록");
  });

  test("메뉴의 토큰 교체로 연 칸을 취소하면 포커스가 그 메뉴 버튼으로 돌아간다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, REGISTERED_TOKEN),
    });
    const user = await setupUser();
    await tokenMenu(user, "토큰 교체");
    await waitFor(() =>
      expect(
        document.activeElement === screen.getByLabelText("Refresh Token"),
      ).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByLabelText("Refresh Token")).toBeNull();
    expect(
      document.activeElement === screen.getByRole("button", TOKEN_MENU),
    ).toBe(true);
  });

  test("위험 구역의 토큰 삭제 확인을 취소하면 포커스가 그 삭제 버튼으로 돌아간다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, REGISTERED_TOKEN),
    });
    const user = await setupUser();
    await deleteToken(user);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog") === null).toBe(true),
    );
    await waitFor(() =>
      expect(
        document.activeElement === screen.getByRole("button", DELETE_TOKEN),
      ).toBe(true),
    );
    // The row's menu only replaces; deleting is not in it.
    await user.click(screen.getByRole("button", TOKEN_MENU));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["토큰 교체"]);
  });

  test("등록된 토큰을 다시 읽다 실패해도 실패와 함께 위험 구역의 토큰 삭제를 남긴다", async () => {
    let fail = false;
    const { services } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        fail
          ? apiError(
              503,
              "BACKEND_UNAVAILABLE",
              "The secret store is off",
              false,
              STORE_OFF,
            )
          : json(200, REGISTERED_TOKEN),
    });
    await screen.findByRole("button", TOKEN_MENU);
    fail = true;
    await services.queryClient.refetchQueries();
    expect(
      await screen.findByText(
        "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
      ),
    ).toBeDefined();
    const zone = screen.getByRole("region", { name: "위험 구역" });
    expect(within(zone).getByRole("button", DELETE_TOKEN)).toBeDefined();
  });

  test("다시 등록해야 하는 토큰은 행 아래에 이유를 말하고, 등록 버튼만 두며 삭제는 위험 구역에 있다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, { ...REGISTERED_TOKEN, state: "needs_reentry" }),
      [`GET ${APPS}`]: () => json(200, { items: [LINK_APP] }),
    });
    const section = await screen.findByRole("region", {
      name: "Slack 앱 생성",
    });
    expect(
      await within(section).findByText(/^저장된 토큰을 사용할 수 없습니다\./),
    ).toBeDefined();
    expect(
      within(section).getByRole("button", { name: "토큰 재등록" }),
    ).toBeDefined();
    expect(within(section).queryByRole("button", TOKEN_MENU)).toBeNull();
    const zone = screen.getByRole("region", { name: "위험 구역" });
    expect(within(zone).getByRole("button", DELETE_TOKEN)).toBeDefined();
  });

  const ACTIVE_TOKEN = {
    ...UNSET_TOKEN,
    configured: true,
    last4: "abcd",
    state: "active",
    updated_at: "2026-10-25T05:00:00.000Z",
    updated_by: {
      user_id: "11111111-1111-4111-8111-111111111111",
      display_name: "Kim",
    },
    issuer: { user_id: "U0ISSUER1", team_id: "T0TEAM001" },
  };

  test("설정된 token은 끝 네 글자, 팀, 발급자, 마지막 확인 시각, 마지막 등록자만 보인다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, ACTIVE_TOKEN),
    });
    expect(
      await screen.findByText(
        /^••••abcd · 팀 T0TEAM001 · 발급자 U0ISSUER1 · 마지막 토큰 확인 .+ · 마지막 등록자 Kim$/,
      ),
    ).toBeDefined();
  });

  test("팀·발급자·등록자를 모르는 token은 끝 네 글자와 마지막 확인 시각만 보인다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, { ...ACTIVE_TOKEN, issuer: null, updated_by: null }),
    });
    expect(
      await screen.findByText(/^••••abcd · 마지막 토큰 확인 [^·]+$/),
    ).toBeDefined();
  });

  test("등록에 성공하면 Slack이 확인한 팀과 발급자를 알린다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, ACTIVE_TOKEN),
      [`PUT ${TOKEN}`]: () =>
        json(200, {
          ...ACTIVE_TOKEN,
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          warnings: [],
        }),
    });
    const user = await setupUser();
    await tokenMenu(user, "토큰 교체");
    await user.type(
      screen.getByLabelText("Refresh Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Slack이 토큰을 확인했습니다. 팀 T0TEAM001, 발급자 U0ISSUER1.",
    );
  });

  test("발급자가 바뀐 저장은 Slack이 확인한 팀·발급자와 함께 앞으로 만드는 앱의 협업자가 바뀐다고 알린다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`PUT ${TOKEN}`]: () =>
        json(200, {
          ...ACTIVE_TOKEN,
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          warnings: [
            {
              code: "config_token_issuer_changed",
              previous_user_id: "U0PREVIOUS",
              user_id: "U0ISSUER1",
            },
          ],
        }),
    });
    const user = await setupUser();
    await tokenMenu(user, "토큰 교체");
    await user.type(
      screen.getByLabelText("Refresh Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Slack이 토큰을 확인했습니다. 팀 T0TEAM001, 발급자 U0ISSUER1. 발급자가 바뀌어 앞으로 만드는 앱의 협업자도 바뀝니다.",
    );
  });

  test("token 저장을 서버가 403으로 거절하면 권한 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, adminMe()),
      [`PUT ${TOKEN}`]: () =>
        apiError(403, "FORBIDDEN", "Only an owner or admin can set it"),
    });
    const user = await setupUser();
    await tokenMenu(user, "토큰 교체");
    await user.type(
      screen.getByLabelText("Refresh Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: 관리자.",
    );
  });

  test("비밀 저장소가 꺼져 있으면 저장 실패를 관리자에게 확인할 일로 알린다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`PUT ${TOKEN}`]: () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "The secret store is off",
          false,
          STORE_OFF,
        ),
    });
    const user = await setupUser();
    await tokenMenu(user, "토큰 교체");
    await user.type(
      screen.getByLabelText("Refresh Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
    );
  });

  test("잠깐 쓸 수 없는 서버는 저장소 문구가 아니라 다시 시도할 일로 알린다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`PUT ${TOKEN}`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Try again", true),
    });
    const user = await setupUser();
    await tokenMenu(user, "토큰 교체");
    await user.type(
      screen.getByLabelText("Refresh Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "등록" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("비밀 저장소");
    expect(alert.textContent).not.toContain("Try again");
  });

  test("비밀 저장소가 꺼져 있으면 token 상태 대신 관리자에게 확인할 일을 보이고, 다시 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "The secret store is off",
          false,
          STORE_OFF,
        ),
    });
    expect(
      await screen.findByText(
        "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(
      api.calls.filter(
        (c) => c.method === "GET" && c.path.endsWith("/slack/config-token"),
      ),
    ).toHaveLength(1);
  });

  test("삭제를 비밀 저장소가 꺼져 거절하면 관리자에게 확인할 일로 알린다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, { ...UNSET_TOKEN, configured: true, state: "active" }),
      [`DELETE ${TOKEN}`]: () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "The secret store is off",
          false,
          STORE_OFF,
        ),
    });
    const user = await setupUser();
    await deleteToken(user);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
    );
  });

  test("계산된 Slack 주소 두 개를 읽기 전용 칸에 보이고 각각 복사한다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const redirect = await screen.findByLabelText(
      "Sign in with Slack 리디렉션 URL",
    );
    const events = await screen.findByLabelText("이벤트 요청 URL");
    for (const [field, address] of [
      [redirect, ADDRESSES.redirect_url],
      [events, ADDRESSES.events_url_template],
    ] as const) {
      expect((field as HTMLInputElement).value === address).toBe(true);
      expect(field.hasAttribute("readonly")).toBe(true);
    }
    const user = await setupUser();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    const region = screen.getByRole("region", { name: "Slack 앱에 넣을 주소" });
    const copy = within(region).getAllByRole("button", { name: "복사" });
    expect(copy).toHaveLength(2);
    await user.click(copy[0] as HTMLElement);
    await user.click(copy[1] as HTMLElement);
    expect(written).toEqual([
      ADDRESSES.redirect_url,
      ADDRESSES.events_url_template,
    ]);
    expect(await screen.findByText("주소를 복사했습니다.")).toBeDefined();
  });

  test("콘솔 공개 주소가 없으면 두 주소 대신 이유를 보인다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, {
          ...REGISTERED_TOKEN,
          urls: { redirect_url: null, events_url_template: null },
        }),
    });
    const region = await screen.findByRole("region", {
      name: "Slack 앱에 넣을 주소",
    });
    expect(
      within(region).getAllByText(/CONSOLE_ORIGIN\)가 설정되지 않아/),
    ).toHaveLength(2);
    expect(within(region).queryByRole("button", { name: "복사" })).toBeNull();
  });

  test("콘솔 주소가 https가 아니면 redirect만 보이고 이벤트 주소는 이유를 보인다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, {
          ...REGISTERED_TOKEN,
          urls: {
            redirect_url: "http://werft.example/settings/linked-accounts/slack",
            events_url_template: null,
          },
        }),
    });
    const region = await screen.findByRole("region", {
      name: "Slack 앱에 넣을 주소",
    });
    expect(
      within(region).getAllByRole("button", { name: "복사" }),
    ).toHaveLength(1);
    expect(
      within(region).getByText(/Slack은 https 주소만 부릅니다/),
    ).toBeDefined();
  });

  test("영어 화면에서도 같은 주소를 복사 칸에 보인다", async () => {
    renderAt(
      "/settings/workspace/integrations/slack",
      { "GET /v1/auth/me": () => json(200, me()) },
      "en",
    );
    const events = await screen.findByLabelText("Events Request URL");
    expect((events as HTMLInputElement).value).toBe(
      ADDRESSES.events_url_template,
    );
    expect(await screen.findByText(/Put the agent's ID where/)).toBeDefined();
  });

  test("이미 지워진 token을 삭제하면 다시 읽어 지워졌다고 알린다", async () => {
    let deleted = false;
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, deleted ? UNSET_TOKEN : ACTIVE_TOKEN),
      [`DELETE ${TOKEN}`]: () => {
        deleted = true;
        return apiError(404, "NOT_FOUND", "Not found");
      },
    });
    const user = await setupUser();
    await deleteToken(user);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "App Configuration Token을 삭제했습니다.",
    );
    // No token and no app: back to the start card, focus on its button.
    expect(await screen.findByText(START)).toBeDefined();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("토큰 등록"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("토큰도 앱도 없으면 Slack 연결하기 카드 하나만 있고, 연 칸은 Slack에서 값을 찾는 순서를 보인다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
    });
    const start = await screen.findByRole("region", { name: "Slack" });
    expect(await within(start).findByText(START)).toBeDefined();
    expect(screen.queryByRole("region", { name: "Slack 게스트" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "자동으로 만든 Slack 앱" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "위험 구역" })).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Slack"]);
    const user = await setupUser();
    await user.click(within(start).getByRole("button", { name: "토큰 등록" }));
    const link = within(start).getByRole("link", {
      name: /api\.slack\.com\/apps를 엽니다/,
    });
    expect(link.getAttribute("href")).toBe("https://api.slack.com/apps");
    expect(link.getAttribute("target")).toBe("_blank");
    const list = start.querySelector("[data-slot=steps]");
    if (!(list instanceof HTMLElement)) throw new Error("no steps");
    const steps = within(list).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[2]?.textContent).toContain("Refresh Token(xoxe-1-로 시작)");
    expect(steps[2]?.textContent).toContain("Access Token이 아닙니다");
    expect(
      within(start).getByLabelText("Refresh Token").getAttribute("type"),
    ).toBe("password");
  });

  test("토큰을 지웠어도 만든 앱이 있으면 등록 안 됨 행 아래에 게스트와 앱 목록이 남는다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
      [`GET ${APPS}`]: () => json(200, { items: [LINK_APP] }),
    });
    const section = await screen.findByRole("region", {
      name: "Slack 앱 생성",
    });
    expect(await within(section).findByText("등록 안 됨")).toBeDefined();
    expect(section.textContent).toContain("이미 만든 앱은 계속 동작합니다.");
    expect(
      within(section).getByRole("button", { name: "토큰 등록" }),
    ).toBeDefined();
    expect(screen.queryByText(START)).toBeNull();
    expect(screen.getByRole("region", { name: "Slack 게스트" })).toBeDefined();
    expect(
      await screen.findByRole("region", { name: "자동으로 만든 Slack 앱" }),
    ).toBeDefined();
  });

  test("저장된 토큰을 사용할 수 없고 앱도 없으면 시작 상자 대신 재등록 버튼과 위험 구역의 삭제를 둔다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, { ...REGISTERED_TOKEN, state: "needs_reentry" }),
    });
    const section = await screen.findByRole("region", {
      name: "Slack 앱 생성",
    });
    expect(await within(section).findByText("재등록 필요")).toBeDefined();
    expect(
      within(section).getByRole("button", { name: "토큰 재등록" }),
    ).toBeDefined();
    expect(screen.queryByRole("region", { name: "Slack 게스트" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "자동으로 만든 Slack 앱" }),
    ).toBeNull();
    expect(screen.queryByText(START)).toBeNull();
    const zone = screen.getByRole("region", { name: "위험 구역" });
    expect(within(zone).getByRole("button", DELETE_TOKEN)).toBeDefined();
  });

  test("앱 목록을 읽는 동안에는 토큰 칸만 기다리고 게스트·앱 목록을 먼저 그리지 않는다", async () => {
    let release: (() => void) | undefined;
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
      [`GET ${APPS}`]: () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(200, { items: [] }));
        }),
    });
    await waitFor(() => {
      expect(release).toBeDefined();
      expect(
        api.calls.some(
          (c) => c.method === "GET" && c.path.endsWith("/slack/config-token"),
        ),
      ).toBe(true);
    });
    // The token has answered "unset"; the page still waits for the apps.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("region", { name: "Slack 앱 생성" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "토큰 등록" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Slack 게스트" })).toBeNull();
    expect(screen.queryByText(START)).toBeNull();
    release?.();
    expect(await screen.findByText(START)).toBeDefined();
  });

  test("시작 카드 뒤 토큰 다시 읽기가 실패하면 등록 버튼 대신 실패를 보인다", async () => {
    let fail = false;
    const { services } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        fail
          ? apiError(
              503,
              "BACKEND_UNAVAILABLE",
              "The secret store is off",
              false,
              STORE_OFF,
            )
          : json(200, UNSET_TOKEN),
    });
    await screen.findByText(START);
    fail = true;
    await services.queryClient.refetchQueries();
    expect(
      await screen.findByText(
        "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(START)).toBeNull();
  });

  test("등록 응답만으로 등록된 화면이 되고, 다시 읽기를 기다리지 않는다", async () => {
    let saved = false;
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        saved ? new Promise<Response>(() => {}) : json(200, UNSET_TOKEN),
      [`PUT ${TOKEN}`]: () => {
        saved = true;
        return json(200, {
          ...REGISTERED_TOKEN,
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          warnings: [],
        });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 등록" }));
    await user.type(
      screen.getByLabelText("Refresh Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect(await screen.findByText("토큰 확인됨")).toBeDefined();
    expect(screen.getByRole("region", { name: "Slack 게스트" })).toBeDefined();
    expect(screen.queryByText(START)).toBeNull();
  });

  test("토큰을 지우면 다시 등록하는 버튼이 포커스를 받는다", async () => {
    let deleted = false;
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, deleted ? UNSET_TOKEN : REGISTERED_TOKEN),
      [`GET ${APPS}`]: () => json(200, { items: [LINK_APP] }),
      [`DELETE ${TOKEN}`]: () => {
        deleted = true;
        return json(200, {
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        });
      },
    });
    const user = await setupUser();
    await deleteToken(user);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("토큰 등록"),
    );
    expect(screen.queryByRole("heading", { name: "위험 구역" })).toBeNull();
  });

  test("등록 요청이 도는 동안 다시 붙여 넣은 값은 보내지도 지우지도 않는다", async () => {
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
      [`PUT ${TOKEN}`]: () => new Promise<Response>(() => {}),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 등록" }));
    const input = screen.getByLabelText("Refresh Token") as HTMLInputElement;
    await user.type(input, "fake-config-first");
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect(input.value).toBe("");
    await user.type(input, "fake-config-second");
    await user.click(screen.getByRole("button", { name: "등록" }));
    expect(input.value).toBe("fake-config-second");
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  test("앱 목록을 읽지 못하면 처음이라고 단정하지 않는다", async () => {
    renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
      [`GET ${APPS}`]: () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    expect(
      await screen.findByRole("region", { name: "Slack 앱 생성" }),
    ).toBeDefined();
    expect(screen.queryByText(START)).toBeNull();
    expect(screen.getByRole("region", { name: "Slack 게스트" })).toBeDefined();
  });

  test("구성원은 토큰을 읽지 않고 게스트 설정을 읽기 전용으로 본다", async () => {
    const { api } = renderAt("/settings/workspace/integrations/slack", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    expect(
      await screen.findByRole("region", { name: "Slack 게스트" }),
    ).toBeDefined();
    expect(screen.queryByText(START)).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)[0],
    ).toBe("Slack 게스트");
    expect(
      api.calls.filter((c) => c.path.endsWith("/slack/config-token")),
    ).toHaveLength(0);
  });

  test("Slack이 거절한 토큰은 칸 아래에 알리고, 값을 다 쓴 경우를 대비해 상태를 다시 읽는다", async () => {
    const { api, services } = renderAt(
      "/settings/workspace/integrations/slack",
      {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
        [`PUT ${TOKEN}`]: () =>
          apiError(409, "CONFIG_TOKEN_INVALID", "Slack refused it"),
      },
    );
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 등록" }));
    const input = screen.getByLabelText("Refresh Token");
    await user.type(input, "fake-config-value");
    await user.click(screen.getByRole("button", { name: "등록" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Slack이 이 토큰을 받지 않았습니다. 방금 만든 Refresh Token인지, Access Token을 넣지 않았는지 확인하세요.",
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
    expect((input as HTMLInputElement).value).toBe("");
    await waitFor(() =>
      expect(
        JSON.stringify(
          services.queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.variables),
        ),
      ).not.toContain("fake-config-value"),
    );
    await waitFor(() =>
      expect(
        api.calls.filter(
          (c) => c.method === "GET" && c.path.endsWith("/slack/config-token"),
        ).length,
      ).toBe(2),
    );
  });

  test("관리자는 에이전트 접근 두 설정을 골라 한 번에 저장하고, 바뀐 것만 보내며 다시 읽은 값을 보인다", async () => {
    let settings = {
      agent_outsider_access: "use",
      agent_outsider_session_visibility: "managing_team",
    };
    const accessMe = () => {
      const body = adminMe();
      return {
        ...body,
        workspace: body.workspace && {
          ...body.workspace,
          settings: { ...body.workspace.settings, ...settings },
        },
      };
    };
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, accessMe()),
      [`PATCH ${ACCESS}`]: async (request: Request) => {
        settings = { ...settings, ...((await request.json()) as object) };
        return json(200, { ...settings, receipt_id: RECEIPT_ID });
      },
    });
    const card = await screen.findByRole("region", { name: "에이전트 접근" });
    const agent = within(card).getByRole("radiogroup", {
      name: "담당 팀 밖 구성원의 에이전트 접근",
    });
    const sessions = within(card).getByRole("radiogroup", {
      name: "워크스페이스 공개 세션",
    });
    const checked = (group: HTMLElement) =>
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-checked"));
    await waitFor(() =>
      expect(checked(agent)).toEqual(["true", "false", "false"]),
    );
    expect(checked(sessions)).toEqual(["true", "false"]);
    expect(
      within(sessions).getByRole("radio", { name: "담당 팀 안에만" }),
    ).toBeDefined();
    expect(
      within(agent)
        .getAllByRole("radio")
        .map((radio) => descriptionOf(radio)),
    ).toEqual([
      "에이전트 정보(이름·설명·담당 팀)를 보고 세션을 시작합니다. 설정은 보지 못합니다.",
      "에이전트 정보를 보지만 세션을 시작하지 못합니다.",
      "에이전트 목록에 보이지 않고 세션도 시작하지 못합니다.",
    ]);
    const user = await setupUser();
    // Arrow keys move the choice; nothing is sent until 저장.
    within(agent).getByRole("radio", { name: "보고 실행" }).focus();
    await user.keyboard("{ArrowDown>}");
    await waitFor(() =>
      expect(
        within(agent)
          .getByRole("radio", { name: "보기만" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await user.keyboard("{/ArrowDown}");
    expect(api.calls.some((c) => c.path === ACCESS)).toBe(false);
    await user.click(
      within(sessions).getByRole("radio", { name: "모든 구성원" }),
    );
    await user.click(within(card).getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "에이전트 접근 설정을 저장했습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === ACCESS).map((c) => c.body),
    ).toEqual([
      {
        agent_outsider_access: "view",
        agent_outsider_session_visibility: "workspace",
      },
    ]);

    // Only the key changed since the last save goes out.
    await user.click(within(agent).getByRole("radio", { name: "숨김" }));
    await user.click(within(card).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.path === ACCESS).map((c) => c.body),
      ).toEqual([
        {
          agent_outsider_access: "view",
          agent_outsider_session_visibility: "workspace",
        },
        { agent_outsider_access: "none" },
      ]),
    );
    // Read again from /me: the screen follows the server's values.
    await waitFor(() =>
      expect(
        within(sessions)
          .getByRole("radio", { name: "모든 구성원" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      api.calls.filter((c) => c.path === "/v1/auth/me").length,
    ).toBeGreaterThan(2);
    expect(
      within(agent)
        .getByRole("radio", { name: "숨김" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("에이전트 접근을 저장한 뒤 /me 다시 읽기가 실패해도 저장한 값을 보인다", async () => {
    let saved = false;
    let failedMe = 0;
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => {
        if (!saved) return json(200, adminMe());
        failedMe += 1;
        return apiError(500, "INTERNAL_ERROR", "me failed");
      },
      [`PATCH ${ACCESS}`]: () => {
        saved = true;
        return json(200, {
          agent_outsider_access: "none",
          agent_outsider_session_visibility: "managing_team",
          receipt_id: RECEIPT_ID,
        });
      },
    });
    const card = await screen.findByRole("region", { name: "에이전트 접근" });
    const user = await setupUser();
    await user.click(within(card).getByRole("radio", { name: "숨김" }));
    await user.click(within(card).getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "에이전트 접근 설정을 저장했습니다.",
    );
    await waitFor(() => expect(failedMe).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.queryByRole("status")?.textContent).toBe(
        "에이전트 접근 설정을 저장했습니다.",
      ),
    );
    expect(
      within(card)
        .getByRole("radio", { name: "숨김" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (within(card).getByRole("button", { name: "저장" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("에이전트 접근을 바꾸지 않았으면 저장이 꺼져 있다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const card = await screen.findByRole("region", { name: "에이전트 접근" });
    const save = within(card).getByRole("button", {
      name: "저장",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  test("에이전트 접근 저장을 서버가 403으로 거절하면 이유 문구를 보인다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`PATCH ${ACCESS}`]: () =>
        apiError(403, "FORBIDDEN", "Only an owner or admin can change it"),
    });
    const card = await screen.findByRole("region", { name: "에이전트 접근" });
    const user = await setupUser();
    await user.click(within(card).getByRole("radio", { name: "숨김" }));
    await user.click(within(card).getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });

  test("구성원은 에이전트 접근을 글로만 읽고, 고르는 칸이 없다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    const card = await screen.findByRole("region", { name: "에이전트 접근" });
    expect(card.textContent).toContain(
      "담당 팀 밖 구성원의 에이전트 접근: 보고 실행",
    );
    expect(card.textContent).toContain(
      "워크스페이스 공개 세션: 담당 팀 안에만",
    );
    expect(within(card).queryByRole("radio")).toBeNull();
    expect(api.calls.some((c) => c.path === ACCESS)).toBe(false);
  });

  test("끝에 /가 붙은 주소에서도 설정 내비가 지금 페이지를 가리킨다", async () => {
    renderAt("/settings/workspace/", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const nav = await screen.findByRole("navigation", { name: "설정" });
    expect(
      within(nav)
        .getByRole("link", { name: "일반" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav).getByRole("button", { name: /^설정 · 일반/ }),
    ).toBeDefined();
  });
});
