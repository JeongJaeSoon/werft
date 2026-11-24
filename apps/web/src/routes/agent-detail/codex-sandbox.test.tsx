import { describe, expect, test } from "bun:test";
import type { AgentDetail, AuthMeResponse } from "@werft-ai/contracts";
import {
  AGENT_ID,
  agentServer,
  CONNECTIONS,
  TEAM_ID,
} from "../../test-support/fake-agents.ts";
import { json, me, memberMe } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const DETAIL = `/agents/${AGENT_ID}`;
const WARNING =
  "이 설치는 Codex sandbox가 꺼져 있어 이 에이전트의 작업이 실패합니다.";
const CODEX = {
  id: "openai-main",
  kind: "openai_responses",
  billing: "metered",
  models: ["gpt-5.5"],
  model_successors: {},
};

function routesFor({
  provider,
  behavior,
  who = me(),
}: {
  provider?: AuthMeResponse["codex_sandbox_provider"];
  behavior: AgentDetail["effective_behavior"];
  who?: AuthMeResponse;
}) {
  const server = agentServer();
  return {
    "GET /v1/auth/me": () =>
      json(
        200,
        provider === undefined
          ? who
          : { ...who, codex_sandbox_provider: provider },
      ),
    ...server.routes,
    [`GET /v1/agents/${AGENT_ID}`]: () =>
      json(200, { ...server.detail(), effective_behavior: behavior }),
    "GET /v1/connections": () => json(200, { items: [...CONNECTIONS, CODEX] }),
    "GET /v1/my-teams": () =>
      json(200, {
        items: [{ id: TEAM_ID, name: "Billing", role: "member" }],
        next_cursor: null,
      }),
  };
}

const on = (connection_id: string) => ({ connection_id, model: "m" });

/** Lets the connection list land before a warning is said to be absent. */
async function settled(api: { calls: readonly { path: string }[] }) {
  await screen.findByRole("heading", { name: /결제 담당/ });
  await waitFor(() =>
    expect(api.calls.some((call) => call.path === "/v1/connections")).toBe(
      true,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("Codex sandbox가 꺼진 설치의 에이전트 경고", () => {
  test("활성 릴리스가 Codex 연결이면 관리자에게 한 줄로 알린다", async () => {
    renderAt(
      DETAIL,
      routesFor({
        provider: "disabled",
        behavior: { applied: on(CODEX.id), draft: null },
      }),
    );
    expect(await screen.findByText(WARNING)).toBeDefined();
  });

  test("게시 전 저장한 카드가 Codex 연결이어도 알린다", async () => {
    renderAt(
      DETAIL,
      routesFor({
        provider: "disabled",
        behavior: { applied: null, draft: on(CODEX.id) },
      }),
    );
    expect(await screen.findByText(WARNING)).toBeDefined();
  });

  for (const provider of ["installer", undefined] as const) {
    test(`provider가 ${provider ?? "없는"} 설치에서는 알리지 않는다`, async () => {
      const { api } = renderAt(
        DETAIL,
        routesFor({
          provider,
          behavior: { applied: on(CODEX.id), draft: null },
        }),
      );
      await settled(api);
      expect(screen.queryByText(WARNING) === null).toBe(true);
    });
  }

  test("Claude 연결의 에이전트에는 알리지 않는다", async () => {
    const { api } = renderAt(
      DETAIL,
      routesFor({
        provider: "disabled",
        behavior: { applied: on("anthropic-main"), draft: null },
      }),
    );
    await settled(api);
    expect(screen.queryByText(WARNING) === null).toBe(true);
  });

  test("관리하지 않는 구성원에게는 보이지 않는다", async () => {
    renderAt(
      DETAIL,
      routesFor({
        provider: "disabled",
        behavior: { applied: on(CODEX.id), draft: null },
        who: memberMe(),
      }),
    );
    expect(await screen.findByText(/볼 수만 있습니다/)).toBeDefined();
    expect(screen.queryByText(WARNING) === null).toBe(true);
  });
});
