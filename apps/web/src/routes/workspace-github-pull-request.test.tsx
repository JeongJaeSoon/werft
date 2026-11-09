import { describe, expect, test } from "bun:test";
import type { GitHubSettingsResponse } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  GITHUB_SETTINGS,
  githubConnection,
  githubSettings,
  json,
  me,
  memberMe,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const PATH = "/settings/workspace/integrations/github";
const PUT_PATH = `${GITHUB_SETTINGS}/pull-request`;

const settings = (
  over: Partial<GitHubSettingsResponse> = {},
): GitHubSettingsResponse => ({
  ...githubSettings(),
  connections: [githubConnection()],
  ...over,
});

const refusal = (status: number, code: string, reason?: string) =>
  json(status, {
    error: {
      code,
      message: "refused",
      retryable: false,
      request_id: "req-1",
      details: reason ? { reason_code: reason } : null,
    },
  });

const routes = (put: () => Response, data = settings(), who = me()) => ({
  "GET /v1/auth/me": () => json(200, who),
  [`GET ${GITHUB_SETTINGS}`]: () => json(200, data),
  [`GET /v1/workspaces/${WORKSPACE_ID}/github-apps`]: () =>
    json(200, { github_apps: [] }),
  [`PUT ${PUT_PATH}`]: put,
});

const saved = (over: object = {}) => ({
  pull_request: {
    formatting: "on",
    default_template: "## Summary\n",
    template_mode: "override",
    session_link: "id",
    ...over,
  },
  pull_request_revision: 1,
  receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
});

describe("GitHub 연결 › Pull request 설정", () => {
  test("화면의 템플릿 최대치는 계약의 최대치와 같다", async () => {
    const { PULL_REQUEST_TEMPLATE_MAX_BYTES: contract } = await import(
      "@werft-ai/contracts"
    );
    const { PULL_REQUEST_TEMPLATE_MAX_BYTES } = await import(
      "./workspace-github-pull-request.tsx"
    );
    expect(PULL_REQUEST_TEMPLATE_MAX_BYTES).toBe(contract);
  });

  test("바꾼 값을 읽은 리비전과 함께 한 번 저장한다", async () => {
    const { api } = renderAt(
      PATH,
      routes(() => json(200, saved())),
    );
    const user = await setupUser();
    await user.selectOptions(
      await screen.findByLabelText("템플릿을 고르는 방식"),
      "override",
    );
    await user.selectOptions(screen.getByLabelText("세션 링크"), "id");
    await user.type(screen.getByLabelText("기본 템플릿"), "## Summary");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(1),
    );
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      pull_request: {
        formatting: "on",
        default_template: "## Summary",
        template_mode: "override",
        session_link: "id",
      },
      revision: 0,
    });
    expect(
      await screen.findByText("Pull request 설정을 저장했습니다."),
    ).toBeDefined();
  });

  test("서식을 끄면 방식과 템플릿 칸이 잠긴다", async () => {
    renderAt(
      PATH,
      routes(() => json(200, saved())),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("switch", {
        name: "저장소·워크스페이스 템플릿 사용",
      }),
    );
    expect(
      (screen.getByLabelText("템플릿을 고르는 방식") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("기본 템플릿") as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });

  test("바이트 한도를 넘으면 저장 버튼이 막히고 크기를 말한다", async () => {
    const { api } = renderAt(
      PATH,
      routes(() => json(200, saved())),
    );
    const user = await setupUser();
    const box = await screen.findByLabelText("기본 템플릿");
    // 한글은 글자당 3바이트라 5,500자만으로 한도를 넘는다.
    await user.click(box);
    await user.paste("가".repeat(5_500));
    expect(await screen.findByText(/16384 바이트/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("서버가 템플릿을 거절하면 그 이유를 보인다", async () => {
    renderAt(
      PATH,
      routes(() => refusal(400, "BAD_REQUEST", "template_unsupported")),
    );
    const user = await setupUser();
    await user.type(await screen.findByLabelText("기본 템플릿"), "x");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "템플릿에 지원하지 않는 마크업이 있거나 주석이 닫히지 않았습니다.",
      ),
    ).toBeDefined();
  });

  test("다른 곳에서 먼저 바꿨으면 다시 불러왔다고 알린다", async () => {
    renderAt(
      PATH,
      routes(() => refusal(409, "REVISION_CONFLICT")),
    );
    const user = await setupUser();
    await user.selectOptions(await screen.findByLabelText("세션 링크"), "id");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(/다른 곳에서 먼저 바꿨습니다\. 지금 저장된 값을/),
    ).toBeDefined();
  });

  test("구성원은 값을 보되 바꿀 수 없다", async () => {
    const { api } = renderAt(
      PATH,
      routes(() => json(200, saved()), settings(), memberMe()),
    );
    const user = await setupUser();
    const link = (await screen.findByLabelText(
      "세션 링크",
    )) as HTMLSelectElement;
    expect(link.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
