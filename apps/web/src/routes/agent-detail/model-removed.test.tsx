import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  AGENT_ID,
  agentServer,
  seedRelease,
} from "../../test-support/fake-agents.ts";
import { apiError, json, me } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const DETAIL = `/agents/${AGENT_ID}`;
/** Offers claude-sonnet-5 only. */
const CONNECTION = {
  id: "anthropic-main",
  kind: "anthropic",
  billing: "metered",
  models: ["claude-sonnet-5"],
  model_successors: {},
};

/** An agent whose active release runs `model` on the connection above. */
function agentRunning(
  model: string,
  listed: () => Response = () => json(200, { items: [CONNECTION] }),
  autoMove = true,
) {
  const server = agentServer();
  const release = seedRelease(1, { connection: CONNECTION.id, model });
  const detail = () => {
    const base = server.detail();
    return {
      ...base,
      agent: {
        ...base.agent,
        active_release_id: release.id,
        auto_model_migration: autoMove,
      },
      releases: [release],
      active_release: release,
    };
  };
  return {
    "GET /v1/auth/me": () => json(200, me()),
    ...server.routes,
    [`GET /v1/agents/${AGENT_ID}`]: () => json(200, detail()),
    "GET /v1/connections": listed,
  };
}

const TITLE =
  "claude-opus-5-5이(가) 연결 anthropic-main의 모델 목록에서 빠졌습니다";

describe("에이전트 상세의 빠진 모델 경고", () => {
  test("활성 릴리스의 모델이 연결의 모델 목록에서 빠졌으면 어느 모델인지와 할 일을 보인다", async () => {
    renderAt(DETAIL, agentRunning("claude-opus-5-5"));
    const title = await screen.findByText(`모델 ${TITLE}`);
    expect(title.parentElement?.textContent).toContain(
      "상세 설정 탭에서 모델을 연결이 제공하는 모델로 바꿔 저장하세요",
    );
  });

  test("같은 시리즈의 후속 모델이 있으면 막힌다고 하지 않고 옮겨 실행된다고 알린다", async () => {
    const moved = {
      ...CONNECTION,
      model_successors: { "claude-opus-5-5": "claude-sonnet-5" },
    };
    renderAt(
      DETAIL,
      agentRunning("claude-opus-5-5", () => json(200, { items: [moved] })),
    );
    const title = await screen.findByText(
      "모델 claude-opus-5-5이(가) 연결 anthropic-main의 모델 목록에서 빠져 claude-sonnet-5(으)로 옮겨 실행됩니다",
    );
    expect(title.parentElement?.textContent).toContain(
      "새 세션은 claude-sonnet-5(으)로 시작하고",
    );
    expect(screen.queryByText(`모델 ${TITLE}`)).toBeNull();
  });

  test("자동 이동을 끈 에이전트는 막혔다고 알리고 켜는 버튼을 준다", async () => {
    const moved = {
      ...CONNECTION,
      model_successors: { "claude-opus-5-5": "claude-sonnet-5" },
    };
    const patches: unknown[] = [];
    const routes = agentRunning(
      "claude-opus-5-5",
      () => json(200, { items: [moved] }),
      false,
    );
    renderAt(DETAIL, {
      ...routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async () => {
        patches.push(true);
        return json(200, {});
      },
    });
    const user = await setupUser();
    await screen.findByText(/자동 이동이 꺼져 있어 멈춰 있습니다/);
    await user.click(screen.getByRole("button", { name: "자동 이동 켜기" }));
    await waitFor(() => expect(patches.length).toBe(1));
  });

  test("영어 화면도 같은 모델 이름을 보인다", async () => {
    renderAt(DETAIL, agentRunning("claude-opus-5-5"), "en");
    await screen.findByText(
      "Model claude-opus-5-5 was taken off the model list of connection anthropic-main",
    );
  });

  test("연결의 모델 목록에 아직 있는 모델이면 경고가 없다", async () => {
    let answered = 0;
    renderAt(
      DETAIL,
      agentRunning("claude-sonnet-5", () => {
        answered += 1;
        return json(200, { items: [CONNECTION] });
      }),
    );
    await waitFor(() => expect(answered).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/모델 목록에서 빠졌습니다/)).toBeNull();
  });

  test("연결 목록을 읽지 못하면 경고를 만들어 내지 않는다", async () => {
    let refused = 0;
    renderAt(
      DETAIL,
      agentRunning("claude-opus-5-5", () => {
        refused += 1;
        return apiError(403, "FORBIDDEN", "agent.read is required");
      }),
    );
    await waitFor(() => expect(refused).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/모델 목록에서 빠졌습니다/)).toBeNull();
  });
});
