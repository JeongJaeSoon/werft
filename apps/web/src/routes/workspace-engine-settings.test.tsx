import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
  WORKSPACE_ID,
  workspaceEngineSettings,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const harness = await appHarness();
const { screen, waitFor, within } = harness;

const PATH = `/v1/workspaces/${WORKSPACE_ID}/engine-settings`;
const renderAt: typeof harness.renderAt = (path, routes, locale) =>
  harness.renderAt(
    path,
    { "GET /v1/connections": () => json(200, { items: [] }), ...routes },
    locale,
  );

const card = () => screen.getByRole("region", { name: "실행 규칙" });
// A loading card is swapped for the editor's, so ask the page again on each
// try rather than holding the first region.
const saveButton = () =>
  waitFor(() => within(card()).getByRole("button", { name: "저장" }));
const box = (name: string) =>
  waitFor(() => within(card()).getByRole("textbox", { name }));

describe("워크스페이스 실행 규칙", () => {
  test("소유자는 규칙을 적어 저장하고, 읽은 revision을 expected_revision으로 보낸다", async () => {
    let saved = workspaceEngineSettings();
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () => json(200, saved),
      [`PUT ${PATH}`]: async (request: Request) => {
        const body = (await request.json()) as { settings: never };
        saved = workspaceEngineSettings({
          settings: body.settings,
          settings_revision: 1,
        });
        return json(200, { settings_revision: 1, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    const save = await saveButton();
    // Nothing changed yet, so there is nothing to save.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.type(await box("거부"), "Bash(rm:*){Enter}  WebFetch ");
    await user.type(await box("환경 문장"), "Staging only");
    await user.click(save);
    await screen.findByText("저장했습니다. 이후 시작하는 세션부터 적용됩니다.");
    expect(api.calls.filter((c) => c.method === "PUT")[0]?.body).toEqual({
      expected_revision: null,
      settings: {
        permissions: { deny: ["Bash(rm:*)", "WebFetch"] },
        auto_mode: { environment: ["Staging only"] },
      },
    });
    // Read again: the saved rules are what the boxes hold now.
    await waitFor(async () =>
      expect(((await box("거부")) as HTMLTextAreaElement).value).toBe(
        "Bash(rm:*)\nWebFetch",
      ),
    );
  });

  test("다른 곳에서 먼저 저장했으면 충돌을 알리고, 최신 규칙을 불러오면 입력을 버린다", async () => {
    let live = workspaceEngineSettings({
      settings: { permissions: { deny: ["Read"] }, auto_mode: {} },
      settings_revision: 3,
    });
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () => json(200, live),
      [`PUT ${PATH}`]: () => apiError(409, "REVISION_CONFLICT", "changed"),
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await waitFor(() => expect(deny.value).toBe("Read"));
    await user.type(deny, "{Enter}Edit");
    live = workspaceEngineSettings({
      settings: { permissions: { deny: ["Read", "Grep"] }, auto_mode: {} },
      settings_revision: 4,
    });
    await user.click(await saveButton());
    expect(
      api.calls
        .filter((c) => c.method === "PUT")
        .map(
          (c) => (c.body as { expected_revision: number }).expected_revision,
        ),
    ).toEqual([3]);
    await screen.findByText(
      "다른 곳에서 먼저 저장했습니다. 최신 규칙을 불러온 뒤 다시 고쳐 주세요.",
    );
    await user.click(
      screen.getByRole("button", { name: "최신 규칙 불러오기" }),
    );
    await waitFor(() => expect(deny.value).toBe("Read\nGrep"));
    expect(
      screen.queryByRole("button", { name: "최신 규칙 불러오기" }),
    ).toBeNull();
  });

  test("서버가 규칙을 거절하면 이유와 그 규칙을 보이고 입력은 남는다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () => json(200, workspaceEngineSettings()),
      [`PUT ${PATH}`]: () =>
        apiError(400, "BAD_REQUEST", "unknown tool", false, {
          field: "settings",
          reason_code: "rule_no_effect",
          rule: "Skill(x)",
        }),
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await user.type(deny, "Skill(x)");
    await user.click(await saveButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "저장하지 못했습니다: 엔진이 무시하는 규칙입니다. 규칙: Skill(x)",
    );
    expect(deny.value).toBe("Skill(x)");
  });

  test("저장이 닫혀 있으면 입력이 읽기 전용이고 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () =>
        json(200, workspaceEngineSettings({ writes_open: false })),
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    expect(deny.readOnly).toBe(true);
    const closed = await screen.findByText(/지금은 저장이 닫혀 있습니다/);
    // A banner, not grey help text, and every box is read with it.
    const banner = closed.closest("[data-slot=alert]");
    expect(banner === null).toBe(false);
    expect(deny.getAttribute("aria-describedby")?.split(" ")).toContain(
      banner?.id ?? "no banner",
    );
    // The read-only mark and the list's count are read with the box as well.
    const described = (deny.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described.length).toBe(3);
    expect(
      described.some(
        (id) => document.getElementById(id)?.textContent === "0 / 48개",
      ),
    ).toBe(true);
    await user.click(await saveButton());
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("구성원은 규칙을 읽지만 저장은 이유와 함께 막혀 있다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET ${PATH}`]: () =>
        json(
          200,
          workspaceEngineSettings({
            settings: { permissions: { deny: ["Read"] }, auto_mode: {} },
            settings_revision: 2,
          }),
        ),
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await waitFor(() => expect(deny.value).toBe("Read"));
    expect(deny.readOnly).toBe(true);
    const save = await saveButton();
    await user.click(save);
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  // A refetch may bring a revision the draft never saw. The save must still
  // carry the revision the draft started from, so the server says conflict
  // instead of replacing rules the person did not read.
  test("재조회로 revision이 올라가도 초안은 처음 읽은 revision으로 저장한다", async () => {
    let reads = 0;
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () => {
        reads += 1;
        return json(
          200,
          workspaceEngineSettings({
            settings: {
              permissions: { deny: reads === 1 ? ["Read"] : ["Read", "Grep"] },
              auto_mode: {},
            },
            settings_revision: reads === 1 ? 3 : 4,
          }),
        );
      },
      [`PUT ${PATH}`]: () =>
        apiError(403, "FORBIDDEN", "closed", false, {
          reason_code: "engine_settings_writes_closed",
        }),
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await waitFor(() => expect(deny.value).toBe("Read"));
    await user.type(deny, "{Enter}Edit");
    await user.click(await saveButton());
    // The refusal made the page read again: revision 4 is on screen now.
    await waitFor(() => expect(reads).toBe(2));
    await user.click(await saveButton());
    const sent = api.calls
      .filter((c) => c.method === "PUT")
      .map((c) => (c.body as { expected_revision: number }).expected_revision);
    expect(sent).toEqual([3, 3]);
    expect(deny.value).toBe("Read\nEdit");
  });

  test("재조회가 실패해도 편집기와 입력은 남고 저장이 닫혔으면 읽기 전용이 된다", async () => {
    let reads = 0;
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () => {
        reads += 1;
        return reads === 1
          ? json(200, workspaceEngineSettings())
          : apiError(500, "INTERNAL", "boom");
      },
      [`PUT ${PATH}`]: () =>
        apiError(403, "FORBIDDEN", "closed", false, {
          reason_code: "engine_settings_writes_closed",
        }),
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await user.type(deny, "Read");
    await user.click(await saveButton());
    await waitFor(() => expect(reads).toBe(2));
    expect(deny.value).toBe("Read");
    expect(document.body.contains(deny)).toBe(true);
  });

  test("저장이 닫힌 뒤 다시 읽은 값이 닫혀 있으면 입력은 읽기 전용이 되고 쓴 것은 남는다", async () => {
    let closed = false;
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () =>
        json(200, workspaceEngineSettings({ writes_open: !closed })),
      [`PUT ${PATH}`]: () => {
        closed = true;
        return apiError(403, "FORBIDDEN", "closed", false, {
          reason_code: "engine_settings_writes_closed",
        });
      },
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await user.type(deny, "Read");
    await user.click(await saveButton());
    await waitFor(() => expect(deny.readOnly).toBe(true));
    expect(deny.value).toBe("Read");
  });

  test("여러 줄 문장이 든 목록은 잠겨 있고, 다른 목록을 저장해도 그대로 보낸다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () =>
        json(
          200,
          workspaceEngineSettings({
            settings: {
              permissions: {},
              auto_mode: { environment: ["First\nSecond", "Third"] },
            },
            settings_revision: 2,
          }),
        ),
      [`PUT ${PATH}`]: () =>
        json(200, { settings_revision: 3, receipt_id: RECEIPT_ID }),
    });
    const user = await setupUser();
    const environment = (await box("환경 문장")) as HTMLTextAreaElement;
    await waitFor(() => expect(environment.value).toBe("First\nSecond\nThird"));
    expect(environment.readOnly).toBe(true);
    await screen.findByText(/여러 줄로 된 항목이 있어 여기서 바꿀 수 없습니다/);
    // Two entries, though the box shows three lines.
    expect(within(card()).getAllByText("2 / 16개")).toHaveLength(1);
    // Opening the screen is not a change.
    expect((await saveButton()).getAttribute("aria-disabled")).toBe("true");
    await user.type(await box("거부"), "Bash(rm:*)");
    await user.click(await saveButton());
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "PUT")).toBe(true),
    );
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      expected_revision: 2,
      settings: {
        permissions: { deny: ["Bash(rm:*)"] },
        auto_mode: { environment: ["First\nSecond", "Third"] },
      },
    });
  });

  // What was typed while a save was in flight is based on that save, so the
  // next save carries the revision the first one returned.
  test("저장하는 동안 이어 쓴 초안은 성공한 revision을 기준으로 다시 저장한다", async () => {
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    let puts = 0;
    let deny = ["Read"];
    let revision = 3;
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${PATH}`]: () =>
        json(
          200,
          workspaceEngineSettings({
            settings: { permissions: { deny }, auto_mode: {} },
            settings_revision: revision,
          }),
        ),
      [`PUT ${PATH}`]: async (request: Request) => {
        puts += 1;
        const body = (await request.json()) as {
          settings: { permissions: { deny: string[] } };
        };
        if (puts === 1) await held;
        deny = body.settings.permissions.deny;
        revision += 1;
        return json(200, {
          settings_revision: revision,
          receipt_id: RECEIPT_ID,
        });
      },
    });
    const user = await setupUser();
    const box1 = (await box("거부")) as HTMLTextAreaElement;
    await waitFor(() => expect(box1.value).toBe("Read"));
    await user.type(box1, "{Enter}Edit");
    await user.click(await saveButton());
    await waitFor(() => expect(puts).toBe(1));
    await user.type(box1, "{Enter}Grep");
    open();
    await screen.findByText("저장했습니다. 이후 시작하는 세션부터 적용됩니다.");
    // The extra line is still there, and still unsaved.
    expect(box1.value).toBe("Read\nEdit\nGrep");
    await user.click(await saveButton());
    await waitFor(() => expect(puts).toBe(2));
    const sent = api.calls
      .filter((c) => c.method === "PUT")
      .map((c) => (c.body as { expected_revision: number }).expected_revision);
    expect(sent).toEqual([3, 4]);
  });

  test("목록 한도는 계약의 한도와 같다", async () => {
    const { ENGINE_SETTINGS_LIMITS } = await import("@werft-ai/contracts");
    const { ENGINE_RULE_LIMITS } = await import(
      "../components/engine-settings-editor.tsx"
    );
    for (const source of ["workspace", "agent"] as const) {
      expect(ENGINE_RULE_LIMITS[source]).toEqual({
        permissions: ENGINE_SETTINGS_LIMITS[source].permissionRules,
        auto_mode: ENGINE_SETTINGS_LIMITS[source].autoModeRules,
      });
    }
  });
});
