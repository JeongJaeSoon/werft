import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import {
  agentEngineSettings,
  apiError,
  json,
  me,
  RECEIPT_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const PATH = `/v1/agents/${AGENT_ID}/engine-settings`;
const TAB = `/agents/${AGENT_ID}?tab=engine`;
const meOk = { "GET /v1/auth/me": () => json(200, me()) };

const panel = () => screen.findByRole("tabpanel");
const box = async (name: string) =>
  within(await panel()).findByRole("textbox", { name });
const saveButton = async () =>
  within(await panel()).getByRole("button", { name: "저장" });

describe("에이전트 실행 규칙 탭", () => {
  test("자기 규칙에 더해 워크스페이스 규칙, 물려받은 규칙 수, 닿지 않는 허용을 보인다", async () => {
    renderAt(TAB, {
      ...meOk,
      ...agentServer().routes,
      [`GET ${PATH}`]: () =>
        json(
          200,
          agentEngineSettings({
            settings: { permissions: { allow: ["Read"] }, auto_mode: {} },
            settings_revision: 2,
            workspace: {
              settings: {
                permissions: { deny: ["Bash(rm:*)"] },
                auto_mode: { environment: ["Staging only"] },
              },
              settings_revision: 5,
            },
            inherited: { entries: 2, rules: 7 },
            reach: {
              agent_allow_without_effect: {
                permissions: ["Read"],
                auto_mode_allow: [],
                auto_mode_environment: [],
              },
              workspace_allow_inactive: true,
            },
          }),
        ),
    });
    const own = (await box("허용")) as HTMLTextAreaElement;
    await waitFor(() => expect(own.value).toBe("Read"));
    const rules = within(await panel()).getByRole("region", {
      name: "워크스페이스 규칙",
    });
    expect(rules.textContent).toContain("Bash(rm:*)");
    expect(rules.textContent).toContain("Staging only");
    // The workspace's rules are read only: no box of theirs to type in.
    expect(within(rules).queryByRole("textbox")).toBeNull();
    await screen.findByText(
      "프로필에서 물려받은 막는 규칙: 항목 2개에 규칙 7개. 운영자가 관리하며 여기서 바꿀 수 없습니다.",
    );
    // The note names the list that does not reach, not a kind of list.
    await screen.findByText(
      "워크스페이스는 환경 문장을(를) 허용하지만 이 에이전트의 같은 목록이 비어 있어, 워크스페이스의 허용이 이 에이전트에 닿지 않습니다.",
    );
    await screen.findByText(
      "아래 허용 항목은 워크스페이스가 같은 목록에서 허용하지 않아 효과가 없습니다.",
    );
    const without = within(await panel()).getByText("Read", {
      selector: "[data-slot=code]",
    });
    expect(without.closest("dd")?.previousElementSibling?.textContent).toBe(
      "허용",
    );
  });

  test("워크스페이스가 같은 규칙을 두 번 적었어도 두 줄을 모두 보인다", async () => {
    renderAt(TAB, {
      ...meOk,
      ...agentServer().routes,
      [`GET ${PATH}`]: () =>
        json(
          200,
          agentEngineSettings({
            workspace: {
              settings: {
                permissions: { deny: ["WebFetch", "WebFetch"] },
                auto_mode: {},
              },
              settings_revision: 5,
            },
          }),
        ),
    });
    const rules = await within(await panel()).findByRole("region", {
      name: "워크스페이스 규칙",
    });
    expect(
      within(rules).getAllByText("WebFetch", { selector: "[data-slot=code]" }),
    ).toHaveLength(2);
  });

  test("저장은 이 에이전트의 규칙만 읽은 revision과 함께 보낸다", async () => {
    let saved = agentEngineSettings({
      settings: { permissions: { deny: ["WebFetch"] }, auto_mode: {} },
      settings_revision: 4,
    });
    const { api } = renderAt(TAB, {
      ...meOk,
      ...agentServer().routes,
      [`GET ${PATH}`]: () => json(200, saved),
      [`PUT ${PATH}`]: async (request: Request) => {
        const body = (await request.json()) as { settings: never };
        saved = agentEngineSettings({
          settings: body.settings,
          settings_revision: 5,
        });
        return json(200, { settings_revision: 5, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await waitFor(() => expect(deny.value).toBe("WebFetch"));
    await user.type(deny, "{Enter}Bash(rm:*)");
    await user.click(await saveButton());
    await screen.findByText("저장했습니다. 이후 시작하는 세션부터 적용됩니다.");
    expect(api.calls.filter((c) => c.method === "PUT")[0]?.body).toEqual({
      expected_revision: 4,
      settings: {
        permissions: { deny: ["WebFetch", "Bash(rm:*)"] },
        auto_mode: {},
      },
    });
    await waitFor(() => expect(deny.value).toBe("WebFetch\nBash(rm:*)"));
  });

  test("저장이 닫히는 순간 거절되면 닫혔다고 알리고 입력은 남는다", async () => {
    renderAt(TAB, {
      ...meOk,
      ...agentServer().routes,
      [`GET ${PATH}`]: () => json(200, agentEngineSettings()),
      [`PUT ${PATH}`]: () =>
        apiError(403, "FORBIDDEN", "closed", false, {
          reason_code: "engine_settings_writes_closed",
        }),
    });
    const user = await setupUser();
    const deny = (await box("거부")) as HTMLTextAreaElement;
    await user.type(deny, "Read");
    await user.click(await saveButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("지금은 저장이 닫혀 있습니다");
    expect(deny.value).toBe("Read");
  });

  // The server's limit is per list. Two lists of 20 are within it, so the page
  // must not add them up and show 40 of 24.
  test("한도는 목록마다 세어 보인다", async () => {
    const rules = (prefix: string) =>
      Array.from({ length: 20 }, (_, i) => `${prefix}${i}`);
    renderAt(TAB, {
      ...meOk,
      ...agentServer().routes,
      [`GET ${PATH}`]: () =>
        json(
          200,
          agentEngineSettings({
            settings: {
              permissions: { allow: rules("Read"), deny: rules("Bash") },
              auto_mode: {},
            },
            settings_revision: 1,
          }),
        ),
    });
    const allow = (await box("허용")) as HTMLTextAreaElement;
    await waitFor(() => expect(allow.value.split("\n")).toHaveLength(20));
    const body = (await panel()).textContent ?? "";
    expect(body.match(/20 \/ 24개/g)).toHaveLength(2);
    expect(body).not.toContain("40 / 24");
  });

  test("목록이 비어 있으면 워크스페이스 규칙이 없다고 말한다", async () => {
    renderAt(TAB, {
      ...meOk,
      ...agentServer().routes,
      [`GET ${PATH}`]: () => json(200, agentEngineSettings()),
    });
    await screen.findByText("워크스페이스 규칙이 없습니다.");
  });
});
