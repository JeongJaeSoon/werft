import { describe, expect, test } from "bun:test";
import type { AuthMeResponse, SessionDetail } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const SESSION_ID = "0a000000-0000-4000-8000-000000000001";
const AT = "2026-11-02T00:00:00.000Z";

const detail = {
  id: SESSION_ID,
  revision: 3,
  admission_state: "active",
  status: "idle",
  runtime: null,
  repository_id: "demo",
  current_turn_id: "1",
  queued_turn_count: 1,
  model: null,
  last_event_at: AT,
  created_at: AT,
  updated_at: AT,
  execution: null,
  checkpoint_revision: null,
  pending_request_count: 0,
  attention: null,
  agent: {
    id: AGENT_ID,
    name: "결제 봇",
    release_version_no: 1,
    release_label: null,
    release_is_active: true,
  },
  durability: {
    last_transcript_persisted_at: AT,
    checkpoint_committed_at: AT,
    checkpoint_revision: null,
    last_completed_turn_id: "1",
    last_checkpointed_turn_id: null,
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetail;

const waiting = {
  session_id: SESSION_ID,
  agent_id: AGENT_ID,
  departed_user_id: "019a0000-0000-7000-8000-0000000000c1",
  status: "idle",
  created_at: AT,
  takeover_required_at: AT,
};

function routes(
  who: AuthMeResponse,
  options: { readable?: boolean; awaiting?: boolean } = {},
) {
  const { readable = true, awaiting = true } = options;
  let takenOver = false;
  const bodies: unknown[] = [];
  return {
    bodies,
    routes: {
      "GET /v1/auth/me": () => json(200, who),
      "GET /v1/connections": () => json(200, { items: [] }),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        readable || takenOver
          ? json(200, detail)
          : apiError(404, "NOT_FOUND", "Resource not found"),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/events`]: (request: Request) =>
        new Promise<Response>((_, reject) =>
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
      "GET /v1/takeovers": () =>
        json(200, { items: awaiting && !takenOver ? [waiting] : [] }),
      [`POST /v1/sessions/${SESSION_ID}/takeover`]: async (
        request: Request,
      ) => {
        bodies.push(await request.json());
        takenOver = true;
        return json(200, { receipt_id: crypto.randomUUID(), receipt_status: "succeeded" });
      },
    },
  };
}

const open = async () =>
  (await setupUser()).click(
    await screen.findByRole("button", { name: "세션 인계하기" }),
  );

describe("세션 상세: 인계", () => {
  test("볼 수 있는 인계 대기 세션은 사유 없이도 인계하고, 동작이 사라진다", async () => {
    const user = await setupUser();
    const { routes: fake, bodies } = routes(me());
    const { api } = renderAt(`/sessions/${SESSION_ID}`, fake);
    expect(
      await screen.findByText(/요청자가 비활성화되어 이 세션은 인계를/),
    ).toBeDefined();
    await open();
    expect(screen.getByLabelText("사유 (선택)")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "인계하기" }));
    await screen.findByText("세션을 인계했습니다. 이제 내가 요청자입니다.");
    expect(bodies).toEqual([{}]);
    expect(
      api.calls.some(
        (c) =>
          c.path === "/v1/takeovers" &&
          new URLSearchParams(c.search).get("agent_id") === AGENT_ID,
      ),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "세션 인계하기" }) === null,
    ).toBe(true);
  });

  test("볼 수 없는 세션은 찾을 수 없다는 안내 아래에서 사유를 받아 인계한다", async () => {
    const user = await setupUser();
    const { routes: fake, bodies } = routes(me(), { readable: false });
    renderAt(`/sessions/${SESSION_ID}`, fake);
    await open();
    await user.click(screen.getByRole("button", { name: "인계하기" }));
    expect(
      await screen.findByText("나에게 공유되지 않은 세션이라 사유가 필요합니다."),
    ).toBeDefined();
    expect(bodies).toEqual([]);
    await user.type(screen.getByLabelText("사유"), "퇴사자 세션 정리");
    await user.click(screen.getByRole("button", { name: "인계하기" }));
    await waitFor(() =>
      expect(bodies).toEqual([{ justification: "퇴사자 세션 정리" }]),
    );
  });

  test("인계 대기가 아닌 세션에는 동작이 없다", async () => {
    const { routes: fake } = routes(me(), { awaiting: false });
    const { api } = renderAt(`/sessions/${SESSION_ID}`, fake);
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/takeovers")).toBe(true),
    );
    expect(
      screen.queryByRole("button", { name: "세션 인계하기" }) === null,
    ).toBe(true);
  });

  test("인계 목록 권한이 없으면 묻지 않고 동작도 없다", async () => {
    const { routes: fake } = routes(memberMe());
    const { api } = renderAt(`/sessions/${SESSION_ID}`, fake);
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    expect(
      screen.queryByRole("button", { name: "세션 인계하기" }) === null,
    ).toBe(true);
    expect(api.calls.some((c) => c.path === "/v1/takeovers")).toBe(false);
  });

  test("상세 경고의 행 링크가 그 세션 상세에 도착하고 인계 동작이 보인다", async () => {
    const user = await setupUser();
    const server = agentServer({ ownerlessSince: AT });
    const { routes: fake } = routes(me());
    const { history } = renderAt(`/agents/${AGENT_ID}`, {
      ...server.routes,
      ...fake,
    });
    await user.click(
      await screen.findByRole("link", { name: SESSION_ID.slice(0, 8) }),
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
    expect(
      await screen.findByRole("button", { name: "세션 인계하기" }),
    ).toBeDefined();
  });
});
