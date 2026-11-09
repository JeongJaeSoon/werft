import { describe, expect, test } from "bun:test";
import {
  AGENT_ID,
  agentServer,
  seedRelease,
} from "../../test-support/fake-agents.ts";
import { apiError, json, me } from "../../test-support/fake-api.ts";
import { version } from "../../test-support/profiles.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const DETAIL = `/agents/${AGENT_ID}`;
// `version()` offers claude-sonnet-5 only.
const PROFILE = version(1, "usable");

/** An agent whose active release runs `model` on the profile above. */
function agentRunning(
  model: string,
  listed: () => Response = () => json(200, { items: [PROFILE] }),
) {
  const server = agentServer();
  const release = seedRelease(1, { profile: PROFILE.id, model });
  const detail = () => {
    const base = server.detail();
    return {
      ...base,
      agent: { ...base.agent, active_release_id: release.id },
      releases: [release],
      active_release: release,
    };
  };
  return {
    "GET /v1/auth/me": () => json(200, me()),
    ...server.routes,
    [`GET /v1/agents/${AGENT_ID}`]: () => json(200, detail()),
    "GET /v1/profiles": listed,
  };
}

const TITLE =
  "claude-opus-5-5이(가) 프로필 strict v1의 허용 목록에서 빠졌습니다";

describe("에이전트 상세의 빠진 모델 경고", () => {
  test("활성 릴리스의 모델이 프로필 허용 목록에서 빠졌으면 어느 모델인지와 할 일을 보인다", async () => {
    renderAt(DETAIL, agentRunning("claude-opus-5-5"));
    const title = await screen.findByText(`모델 ${TITLE}`);
    expect(title.parentElement?.textContent).toContain(
      "상세 설정 탭에서 모델을 허용된 모델로 바꿔 저장하세요",
    );
  });

  test("같은 시리즈의 후속 모델이 있으면 막힌다고 하지 않고 옮겨 실행된다고 알린다", async () => {
    const moved = {
      ...PROFILE,
      model_successors: { "claude-opus-5-5": "claude-sonnet-5" },
    };
    renderAt(
      DETAIL,
      agentRunning("claude-opus-5-5", () => json(200, { items: [moved] })),
    );
    const title = await screen.findByText(
      "모델 claude-opus-5-5이(가) 프로필 strict v1의 허용 목록에서 빠져 claude-sonnet-5(으)로 옮겨 실행됩니다",
    );
    expect(title.parentElement?.textContent).toContain(
      "새 세션은 claude-sonnet-5(으)로 시작하고",
    );
    expect(screen.queryByText(`모델 ${TITLE}`)).toBeNull();
  });

  test("영어 화면도 같은 모델 이름을 보인다", async () => {
    renderAt(DETAIL, agentRunning("claude-opus-5-5"), "en");
    await screen.findByText(
      "Model claude-opus-5-5 was taken off the allowed list of profile strict v1",
    );
  });

  test("허용 목록에 아직 있는 모델이면 경고가 없다", async () => {
    let answered = 0;
    renderAt(
      DETAIL,
      agentRunning("claude-sonnet-5", () => {
        answered += 1;
        return json(200, { items: [PROFILE] });
      }),
    );
    await waitFor(() => expect(answered).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/허용 목록에서 빠졌습니다/)).toBeNull();
  });

  test("프로필 목록을 읽을 수 없는 역할에게는 경고를 만들어 내지 않는다", async () => {
    let refused = 0;
    renderAt(
      DETAIL,
      agentRunning("claude-opus-5-5", () => {
        refused += 1;
        return apiError(403, "FORBIDDEN", "profile.read is required");
      }),
    );
    await waitFor(() => expect(refused).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/허용 목록에서 빠졌습니다/)).toBeNull();
  });
});
