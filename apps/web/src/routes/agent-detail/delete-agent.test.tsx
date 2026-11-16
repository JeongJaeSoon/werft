import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  AGENT_ID,
  agentServer,
  TEAM,
  TEAM_ID,
} from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, waitFor, within } = await appHarness();

const SETTINGS = `/agents/${AGENT_ID}?tab=card`;
const DELETE = `DELETE /v1/agents/${AGENT_ID}`;

describe("에이전트 삭제", () => {
  test("확인을 받은 뒤에만 지우고, 지운 뒤에는 에이전트 목록으로 간다", async () => {
    const { api, history, container } = renderAt(SETTINGS, {
      "GET /v1/auth/me": () => json(200, me()),
      ...agentServer().routes,
      [DELETE]: () => json(200, { receipt_id: RECEIPT_ID }),
    });
    const page = within(container);
    const user = await setupUser();
    const zone = await page.findByRole("region", { name: "위험 구역" });
    const row = within(zone).getByRole("button", { name: "에이전트 삭제" });
    await user.click(row);
    const deleted = () => api.calls.filter((call) => call.method === "DELETE");
    expect(deleted()).toHaveLength(0);

    const dialog = await within(document.body).findByRole("dialog");
    expect(dialog.textContent).toContain("결제 담당");
    await user.click(
      within(dialog).getByRole("button", { name: "에이전트 삭제" }),
    );
    await waitFor(() => expect(history.location.pathname).toBe("/agents"));
    expect(deleted().map((call) => call.path)).toEqual([
      `/v1/agents/${AGENT_ID}`,
    ]);
  });

  test("거절되면 이 화면에 남아 이유를 말한다", async () => {
    const { history, container } = renderAt(SETTINGS, {
      "GET /v1/auth/me": () => json(200, me()),
      ...agentServer().routes,
      [DELETE]: () => apiError(403, "FORBIDDEN", "no"),
    });
    const page = within(container);
    const user = await setupUser();
    const zone = await page.findByRole("region", { name: "위험 구역" });
    await user.click(
      within(zone).getByRole("button", { name: "에이전트 삭제" }),
    );
    const dialog = await within(document.body).findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "에이전트 삭제" }),
    );
    await waitFor(() =>
      expect(within(document.body).queryByRole("dialog") === null).toBe(true),
    );
    expect(history.location.pathname).toBe(`/agents/${AGENT_ID}`);
    expect(page.getByRole("alert").textContent).not.toBe("");
  });

  test("이 에이전트를 관리하지 않는 구성원에게는 보이지 않는다", async () => {
    const { container } = renderAt(SETTINGS, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...agentServer().routes,
      // A plain member of the managing team, not its lead.
      "GET /v1/my-teams": () =>
        json(200, {
          items: [{ id: TEAM_ID, name: TEAM.name, role: "member" }],
          next_cursor: null,
        }),
    });
    const page = within(container);
    await page.findByText(/볼 수만 있습니다/);
    expect(page.queryByRole("region", { name: "위험 구역" }) === null).toBe(
      true,
    );
    expect(page.queryByRole("button", { name: "에이전트 삭제" }) === null).toBe(
      true,
    );
  });
});
