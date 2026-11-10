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
    { "GET /v1/profiles": () => json(200, { items: [] }), ...routes },
    locale,
  );

const card = () => screen.findByRole("region", { name: "실행 규칙" });
// The card is there while the rules load, so wait for its button too.
const saveButton = async () =>
  within(await card()).findByRole("button", { name: "저장" });
const box = async (name: string) =>
  within(await card()).findByRole("textbox", { name });

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
    await screen.findByText(/지금은 저장이 닫혀 있습니다/);
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
