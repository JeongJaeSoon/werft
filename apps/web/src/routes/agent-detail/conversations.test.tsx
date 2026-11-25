import { describe, expect, test } from "bun:test";
import type { ConversationTurnItem, MemberView } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberPage,
  USER_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const TAB = `/agents/${AGENT_ID}?tab=conversations`;
const TURNS = `/v1/agents/${AGENT_ID}/conversation-turns`;
const SESSION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const id = (n: number) => `4c5d6e7f-0000-4000-8000-00000000000${n}`;

const owner: MemberView = {
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
  disabled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
};

function turn(
  n: number,
  over: Partial<ConversationTurnItem> = {},
): ConversationTurnItem {
  return {
    id: id(n) as ConversationTurnItem["id"],
    started_at: "2026-11-25T10:00:00.000Z",
    ended_at: "2026-11-25T10:00:09.000Z",
    state: "decided",
    limit: null,
    requester: { kind: "slack_user" },
    decision: "reply",
    models: ["claude-sonnet-5"],
    input_tokens: 1200,
    output_tokens: 300,
    cost_usd: "0.0123",
    unpriced_calls: 0,
    slack_thread: null,
    thread_task_session_id: null,
    ...over,
  };
}

const reads = (api: {
  calls: { method: string; path: string; search: string }[];
}) => api.calls.filter((c) => c.method === "GET" && c.path === TURNS);

const table = () =>
  screen.findByRole("table", { name: "대화" }) as Promise<HTMLElement>;

describe("에이전트 상세의 대화 목록", () => {
  test("rows say who asked, how each ended, what it cost and where it is", async () => {
    renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      [`GET ${TURNS}`]: () =>
        json(200, {
          items: [
            turn(1, {
              requester: { kind: "user", user_id: USER_ID },
              decision: "route_to_task",
              slack_thread: {
                team_id: "T01",
                channel_id: "C01",
                thread_ts: "1700000000.000100",
                url: "https://example.slack.com/archives/C01/p1700000000000100",
              },
              thread_task_session_id: SESSION,
            }),
            turn(2, {
              state: "no_decision",
              decision: null,
              ended_at: null,
              limit: { reached: "model_call_limit", by: "server" },
              requester: { kind: "slack_bot" },
              models: [],
              unpriced_calls: 2,
            }),
          ],
          next_cursor: null,
        }),
    });
    const list = await table();
    const rows = await waitFor(() => {
      const found = within(list).getAllByRole("row").slice(1);
      expect(found.length).toBe(2);
      expect(found[0]?.textContent).toContain("Owner");
      return found;
    });
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain("작업 세션으로 넘김");
    expect(first.textContent).toContain("claude-sonnet-5");
    expect(
      within(first)
        .getByRole("link", { name: "Slack 스레드" })
        .getAttribute("href"),
    ).toBe("https://example.slack.com/archives/C01/p1700000000000100");
    expect(
      within(first)
        .getByRole("link", { name: "스레드의 작업 세션" })
        .getAttribute("href"),
    ).toBe(`/sessions/${SESSION}`);
    expect(second.textContent).toContain("Slack 봇");
    expect(second.textContent).toContain("결정 없이 끝남");
    expect(second.textContent).toContain("모델 호출 한도에 닿음 (서버)");
    expect(second.textContent).toContain("아직 끝나지 않음");
    expect(second.textContent).toContain("집계 전 호출 2건");
    expect(within(second).queryAllByRole("link")).toEqual([]);
  });

  test("the initiator filter asks the server for one side", async () => {
    const { api } = renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TURNS}`]: () =>
        json(200, { items: [turn(1)], next_cursor: null }),
    });
    const user = await setupUser();
    await table();
    await user.click(screen.getByRole("button", { name: /시작한 쪽/ }));
    await user.click(await screen.findByRole("button", { name: "사람" }));
    await waitFor(() =>
      expect(
        reads(api).map((c) => new URLSearchParams(c.search).get("initiator")),
      ).toEqual([null, "person"]),
    );
  });

  test("the next page reads on with the cursor", async () => {
    const { api } = renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TURNS}`]: (request) =>
        new URL(request.url).searchParams.get("cursor") === "next"
          ? json(200, {
              items: [turn(2, { decision: "no_reply" })],
              next_cursor: null,
            })
          : json(200, {
              items: Array.from({ length: 50 }, (_, n) => ({
                ...turn(1),
                id: `4c5d6e7f-0000-4000-8000-${String(n).padStart(12, "0")}` as ConversationTurnItem["id"],
              })),
              next_cursor: "next",
            }),
    });
    const user = await setupUser();
    await table();
    await user.click(
      await screen.findByRole("button", { name: "다음 페이지" }),
    );
    expect(await screen.findByText("답하지 않음")).toBeDefined();
    expect(
      reads(api).map((c) => new URLSearchParams(c.search).get("cursor")),
    ).toEqual([null, "next"]);
  });

  test("an empty list says so", async () => {
    renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TURNS}`]: () => json(200, { items: [], next_cursor: null }),
    });
    expect(await screen.findByText("아직 대화가 없습니다")).toBeDefined();
  });

  test("a refused read says who may see it", async () => {
    renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TURNS}`]: () => apiError(403, "FORBIDDEN", "forbidden"),
    });
    expect(
      await screen.findByText(
        "대화 기록은 워크스페이스 owner·admin과 이 에이전트의 관리자만 봅니다.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("table", { name: "대화" })).toBeNull();
  });

  test("a new filter starts again from the first page, without the cursor", async () => {
    const { api } = renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TURNS}`]: (request) => {
        const params = new URL(request.url).searchParams;
        if (params.get("initiator") === "person")
          return json(200, {
            items: [turn(3, { decision: "spawn_task" })],
            next_cursor: null,
          });
        return params.get("cursor") === "next"
          ? json(200, {
              items: [turn(2, { decision: "no_reply" })],
              next_cursor: null,
            })
          : json(200, {
              items: Array.from({ length: 50 }, (_, n) => ({
                ...turn(1),
                id: `4c5d6e7f-0000-4000-8000-${String(n).padStart(12, "0")}` as ConversationTurnItem["id"],
              })),
              next_cursor: "next",
            });
      },
    });
    const user = await setupUser();
    await table();
    await user.click(
      await screen.findByRole("button", { name: "다음 페이지" }),
    );
    expect(await screen.findByText("답하지 않음")).toBeDefined();
    await user.click(screen.getByRole("button", { name: /시작한 쪽/ }));
    await user.click(await screen.findByRole("button", { name: "사람" }));
    expect(await screen.findByText("새 작업 세션 시작")).toBeDefined();
    const last = new URLSearchParams(reads(api).at(-1)?.search);
    expect([last.get("initiator"), last.get("cursor")]).toEqual([
      "person",
      null,
    ]);
    expect(screen.queryByRole("navigation", { name: /페이지/ })).toBeNull();
  });

  test("an agent gone since the page read it says so instead of a retry", async () => {
    renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TURNS}`]: () => apiError(404, "NOT_FOUND", "not found"),
    });
    expect(
      await screen.findByText("에이전트를 찾을 수 없습니다"),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  test("a failed read offers a retry", async () => {
    renderAt(TAB, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TURNS}`]: () => apiError(500, "INTERNAL", "boom", true),
    });
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeDefined();
  });
});
