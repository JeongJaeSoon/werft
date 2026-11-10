import { describe, expect, jest, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import type {
  MemberView,
  SettingsConnection,
} from "@werft-ai/contracts";
import { waitingSessionsQuery, withQueryScope } from "@werft-ai/core";
import { useMinute } from "@werft-ai/react/components";
import { formatElapsed } from "@werft-ai/ui";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  keys,
  me,
  memberMe,
  memberPage,
  SCOPE,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import { statusPageQuery } from "./home.tsx";

// Text a sighted user reads: a Tooltip keeps a hidden copy of its note.
function shownText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll("[hidden]")) hidden.remove();
  return copy.textContent ?? "";
}

const harness = await appHarness();
const { act, renderHook, screen, waitFor, within } = harness;

const CONNECTION: SettingsConnection = {
  id: "anthropic-main",
  origin: "console",
  state: "active",
  kind: "anthropic",
  endpoint: "https://api.anthropic.com",
  billing: "per_token",
  auth_kind: "api_key",
  auto_mode: "unknown",
  credential: { source: "stored", last4: "abcd" },
  models: ["claude-sonnet-5"],
  model_families: null,
  created_at: "2026-10-01T00:00:00.000Z",
  disabled_at: null,
};

const settingsReads = (connections: readonly SettingsConnection[]) => ({
  "GET /v1/installation/settings/connections": () =>
    json(200, {
      items: connections,
      credential_hosts: null,
      endpoint_defaults: {},
    }),
});

// An installation with a connection that lists a model, unless a test says not.
const renderAt: typeof harness.renderAt = (path, routes) =>
  harness.renderAt(path, {
    ...settingsReads([CONNECTION]),
    ...routes,
  });

const owner: MemberView = {
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
  disabled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
};

const noSessions = {
  "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
};

const oneSession = {
  id: "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
  revision: 1,
  admission_state: "active",
  status: "idle",
  runtime: {
    kind: "claude_agent_sdk",
    version: "1.0.0",
    connection_id: "default",
    model: "model-default",
    permission_mode: "default",
  },
  repository_id: "demo",
  current_turn_id: null,
  queued_turn_count: 0,
  model: "model-default",
  last_event_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

async function states() {
  await screen.findByRole("heading", { name: "홈" });
  // Home has other lists; the checklist is the region named for it.
  return () =>
    checklistSteps().map((step) => {
      const state = step.getAttribute("data-state");
      return state === "todo" ? "pending" : state;
    });
}

function checklistSteps() {
  return within(screen.getByRole("region", { name: "시작하기" })).getAllByRole(
    "listitem",
  );
}

/** Each step's action link: its text and where it goes, done or not. */
function stepLinks() {
  return checklistSteps().map((step) => {
    const link = within(step).queryByRole("link");
    return link
      ? [link.textContent, link.getAttribute("href"), link.className]
      : null;
  });
}

describe("bootstrap checklist", () => {
  test("처음에는 소유자만 완료이고, 초대·에이전트·세션 단계는 각 화면으로 잇는다", async () => {
    const server = agentServer();
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/sessions")).toBe(true),
    );
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "done",
        "done",
        "pending",
        "pending",
        "pending",
      ]),
    );
    const order = [...document.querySelectorAll("main section > div h2")].map(
      (heading) => heading.textContent,
    );
    expect(order[0]).toBe("시작하기");
    // The owner step has nothing to open; the next step to do gets the
    // primary button, the rest the outline one.
    const links = stepLinks();
    expect(links.map((link) => link?.slice(0, 2) ?? null)).toEqual([
      null,
      ["모델 연결", "/settings/workspace/model-connections"],
      ["모델 연결", "/settings/workspace/model-connections"],
      ["구성원 목록", "/members"],
      ["에이전트 목록", "/agents"],
      ["세션 목록", "/sessions"],
    ]);
    expect(
      links.map((link) => (link?.[2] ?? "").includes("bg-primary")),
    ).toEqual([false, false, false, true, false, false]);
  });

  test("초대를 보냈고 활성 release가 있는 에이전트가 있으면 두 단계가 완료다", async () => {
    const server = agentServer();
    const agent = { ...server.detail().agent, active_release_id: "rel-1" };
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () =>
        json(200, {
          items: [
            {
              id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
              workspace_id: me().workspace?.id,
              email: "late@example.com",
              role: "member",
              invited_by: USER_ID,
              status: "pending",
              expires_at: "2026-10-18T00:00:00.000Z",
              accepted_at: null,
              revoked_at: null,
              created_at: "2026-10-11T00:00:00.000Z",
            },
          ],
        }),
      "GET /v1/agents": () => json(200, { items: [agent], next_cursor: null }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "done",
        "done",
        "done",
        "done",
        "pending",
      ]),
    );
    expect(agent.id).toBe(AGENT_ID);
  });

  test("만들기만 하고 활성화하지 않은 에이전트는 아직이다", async () => {
    const server = agentServer();
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [owner, { ...owner, user_id: AGENT_ID }],
            next_cursor: null,
          }),
        ),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "done",
        "done",
        "done",
        "pending",
        "pending",
      ]),
    );
  });

  test("구성원은 혼자인데 초대 조회가 실패하면 초대 단계는 모른다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => apiError(500, "INTERNAL", "boom"),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "done",
        "done",
        "unknown",
        "pending",
        "pending",
      ]),
    );
  });

  test("관리 권한이 없으면 시작하기를 보이지 않고 구성원·초대·에이전트 목록을 묻지 않는다", async () => {
    // What the server answers a member; the record shows it was never asked.
    const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...noSessions,
    });
    await screen.findByRole("heading", { name: "홈" });
    // The member's own cards load after the session list: home has settled.
    await screen.findAllByText("내 사용량");
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/sessions")).toBe(true),
    );
    expect(
      api.calls
        .filter((c) =>
          ["/v1/members", "/v1/invites", "/v1/agents"].includes(c.path),
        )
        .map((c) => `${c.method} ${c.path}`),
    ).toEqual([]);
    expect(screen.queryByRole("region", { name: "시작하기" }) === null).toBe(
      true,
    );
  });

  test("내 세션이 있어도 관리 권한이 없으면 시작하기는 없다", async () => {
    // What the server answers a member; the record shows it was never asked.
    const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions": () =>
        json(200, { items: [oneSession], next_cursor: null }),
    });
    await screen.findByRole("heading", { name: "홈" });
    await screen.findByRole("table", { name: "최근 세션" });
    expect(
      api.calls
        .filter((c) =>
          ["/v1/members", "/v1/invites", "/v1/agents"].includes(c.path),
        )
        .map((c) => `${c.method} ${c.path}`),
    ).toEqual([]);
    expect(screen.queryByRole("region", { name: "시작하기" }) === null).toBe(
      true,
    );
  });

  test("소유자에게는 내 세션이 하나라도 있으면 세션 단계가 완료다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/sessions": () =>
        json(200, { items: [oneSession], next_cursor: null }),
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "done",
        "done",
        "pending",
        "pending",
        "done",
      ]),
    );
  });

  test("세션 목록을 읽지 못하면 세션 단계는 모른다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/sessions": () => apiError(500, "INTERNAL", "boom"),
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "done",
        "done",
        "pending",
        "pending",
        "unknown",
      ]),
    );
  });

  test("빈 설치의 소유자에게는 모델 연결과 모델 단계가 아직이고, 다음 할 일은 연결이다", async () => {
    const { api } = renderAt("/", {
      ...settingsReads([]),
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
      ]),
    );
    expect(checklistSteps()[1]?.textContent).toContain("모델 연결 추가하기");
    expect(checklistSteps()[2]?.textContent).toContain("모델 연결에 모델 정하기");
    const links = stepLinks();
    expect(
      links.map((link) => (link?.[2] ?? "").includes("bg-primary")),
    ).toEqual([false, true, false, false, false, false]);
    expect(
      api.calls.some((c) => c.path === "/v1/installation/settings/connections"),
    ).toBe(true);
  });

  test("사용 중지되거나 값이 없는 연결만 있으면 연결 단계는 아직이다", async () => {
    renderAt("/", {
      ...settingsReads(
        [
          { ...CONNECTION, state: "disabled" },
          { ...CONNECTION, id: "empty", state: "needs_value" },
        ],
      ),
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read().slice(0, 3)).toEqual(["done", "pending", "pending"]),
    );
  });

  test("관리자에게는 설치 단계가 없고 연결 목록도 묻지 않는다", async () => {
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() => expect(read()).toHaveLength(4));
    expect(
      api.calls.some((c) => c.path === "/v1/installation/settings/connections"),
    ).toBe(false);
  });
});

describe("최근 세션 표", () => {
  test("에이전트 칸은 세션이 붙은 에이전트의 이름을, 에이전트 없는 세션은 —를 보인다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/sessions": () =>
        json(200, {
          items: [
            {
              ...oneSession,
              agent: {
                id: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
                name: "배포 도우미",
                release_version_no: 2,
              },
            },
            { ...oneSession, id: USER_ID },
          ],
          next_cursor: null,
        }),
    });
    const table = await screen.findByRole("table", { name: "최근 세션" });
    const at = within(table)
      .getAllByRole("columnheader")
      .findIndex((header) => header.textContent === "에이전트 · 모델");
    const agents = within(table)
      .getAllByRole("row")
      .slice(1)
      .map(
        (row) =>
          within(row).getAllByRole("cell")[at]?.querySelector("span")
            ?.textContent,
      );
    expect(agents).toEqual(["배포 도우미", "—"]);
  });
  test("좁은 표(820px 이하)에서는 저장소 열이 머리와 칸이 함께 빠지고 남는 네 열이 좁은 열 틀과 맞는다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/sessions": () =>
        json(200, {
          items: [oneSession, { ...oneSession, id: USER_ID }],
          next_cursor: null,
        }),
    });
    const table = await screen.findByRole("table", { name: "최근 세션" });
    // GridTable hides by a container query on the table's own width.
    expect(table.getAttribute("data-narrow-at")).toBe("820");
    const narrowTracks = (table as HTMLElement).style
      .getPropertyValue("--grid-table-narrow-columns")
      .trim()
      .split(/\s+(?![^(]*\))/);
    expect(narrowTracks).toHaveLength(4);
    const hidden = (cell: Element) =>
      cell.getAttribute("data-hide-narrow") === "true" &&
      cell.className
        .split(/\s+/)
        .includes("[@container(max-width:820px)]:hidden");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map(hidden)).toEqual([false, false, false, true, false]);
    expect(headers.filter(hidden).map((header) => header.textContent)).toEqual([
      "저장소",
    ]);
    const kept = headers.filter((header) => !hidden(header));
    expect(kept).toHaveLength(narrowTracks.length);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = within(row).getAllByRole("cell");
      expect(cells.map(hidden)).toEqual(headers.map(hidden));
      expect(cells.filter((cell) => !hidden(cell))).toHaveLength(kept.length);
    }
  });
});

describe("홈 요약", () => {
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000 + 60_000).toISOString();
  const limits = {
    scope: "installation",
    refreshed_at: "2026-10-23T09:00:00.000Z",
    limits: {
      execution_slot_limit: 8,
      queued_input_limit_per_session: 20,
      storage_limit_bytes: 1073741824,
      max_turn_seconds: 3600,
      session_cost_limit_usd: "20",
      session_token_limit: null,
      provider_max_retries: 2,
    },
    usage: {
      execution_slots_used: 3,
      queued_input_count: 0,
      storage: {
        used_bytes: 0,
        accounted_content: ["input_messages"],
        updated_at: null,
      },
      outputs: {
        used_bytes: 314572800,
        updated_at: "2026-10-24T12:35:00Z",
        complete: true,
      },
      archived_events: { used_bytes: 0, updated_at: null },
    },
  };
  const since = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const summary = (
    scope: "me" | "installation",
    sessions: number,
    complete = true,
  ) => ({
    scope,
    period: {
      since: `${since}T00:00:00.000Z`,
      until: "2026-10-23T09:00:00.000Z",
    },
    refreshed_at: "2026-10-23T09:00:00.000Z",
    session_count: sessions,
    cost_usd: scope === "me" ? "1.250000" : "69.461386",
    cost_complete: complete,
    token_count: sessions * 1200,
    run_seconds: sessions * 600,
    basis: {
      sessions: "created_in_period",
      cost: "provider_usage_estimate",
      run_time: "turn_wall_clock",
    },
  });
  const summaryRoute = (scope: "me" | "installation") =>
    `GET /v1/usage/summary?scope=${scope}&since=${since}`;
  const expiringKey = {
    id: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    kind: "agent",
    name: null,
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_ID,
    created_by: USER_ID,
    created_by_user: null,
    scopes: ["sessions:read"],
    created_at: "2026-10-01T00:00:00.000Z",
    expires_at: inDays(3),
    revoked_at: null,
    last_used_at: null,
  };
  /** Each card as title, headline and its label/value rows. */
  const cards = (overview: HTMLElement) =>
    within(overview)
      .getAllByRole("listitem")
      .filter((item) => item.querySelector("h3"))
      .map((card) => ({
        title: card.querySelector("h3")?.textContent,
        badge:
          card.querySelector("h3")?.parentElement?.nextElementSibling
            ?.textContent,
        value: card.querySelector("p.text-number")?.textContent,
        rows: [...card.querySelectorAll("dl > div")].map((row) => [
          row.querySelector("dt")?.textContent,
          row.querySelector("dd")?.textContent,
        ]),
      }));
  const waitingSession = {
    ...oneSession,
    id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    title: "hello.txt 만들고 commit",
    status: "needs_input",
  };
  const request = (created_at: string) => ({
    kind: "permission",
    request_id: `req-${created_at}`,
    turn_id: "turn-1",
    attempt_id: "attempt-1",
    created_at,
    expires_at: "2026-10-23T09:30:00.000Z",
    tool: "Bash",
    input: { command: "ls" },
  });
  const pending = (id: string, created_at: string) => ({
    [`GET /v1/sessions/${id}/pending-requests`]: () =>
      json(200, { answerable: true, items: [request(created_at)] }),
  });
  const homeRoutes = () => {
    const server = agentServer();
    const released = {
      ...server.detail().agent,
      active_release_id: "rel-1",
    };
    return {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () =>
        json(200, {
          items: [released, server.detail().agent],
          next_cursor: null,
        }),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [waitingSession], next_cursor: null }),
      "GET /v1/sessions": () =>
        json(200, {
          items: [waitingSession, oneSession],
          next_cursor: "next",
        }),
      "GET /v1/sessions?status=running": () =>
        json(200, { items: [], next_cursor: null }),
      "GET /v1/sessions?status=idle": () =>
        json(200, { items: [oneSession], next_cursor: null }),
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "GET /v1/limits": () => json(200, limits),
      [summaryRoute("me")]: () => json(200, summary("me", 3)),
      [summaryRoute("installation")]: () =>
        json(200, summary("installation", 12, false)),
      "GET /v1/api-keys": () =>
        json(200, { items: [expiringKey], next_cursor: null }),
      ...pending(waitingSession.id, "2026-10-23T09:00:00.000Z"),
    };
  };

  describe("지금 할 일", () => {
    const listed = (
      actions: readonly (
        | "events_failed"
        | "events_unverified"
        | "install"
        | "reinstall"
        | "home_unset"
        | null
      )[],
      next_cursor: string | null = null,
    ) => {
      const base = agentServer().detail().agent;
      return () =>
        json(200, {
          items: actions.map((slack_action, n) => ({
            ...base,
            id: `5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8${n}`,
            slug: `agent-${n}`,
            name: `에이전트 ${n}`,
            summary: {
              version: {
                version_no: 1,
                role: "reviewer",
                instructions: "Review.",
                mcp_servers: [],
                credential_refs: [],
              },
              connection_id: null,
              release_label: null,
              release_model: null,
              bound_credential_refs: [],
              admins: ["Owner"],
              needs_input_count: 0,
              running_count: 0,
              slack_action,
            },
          })),
          next_cursor,
        });
    };
    const todoRows = (todo: HTMLElement) =>
      within(todo)
        .getAllByRole("listitem")
        .map((row) => ({
          title: row.querySelector("h3")?.textContent,
          note: row.querySelector("p")?.textContent,
          fix: row.querySelector("a")?.getAttribute("href"),
        }));

    test("Slack 조치가 필요한 에이전트를 세 개까지 시작하기 위에 보이고, 각 행의 버튼은 그 Slack 탭으로 간다", async () => {
      renderAt("/", {
        ...homeRoutes(),
        "GET /v1/agents": listed([
          null,
          "events_failed",
          "home_unset",
          "events_unverified",
          "install",
          "reinstall",
        ]),
      });
      const todo = await screen.findByRole("region", { name: "지금 할 일" });
      expect(todoRows(todo)).toEqual([
        {
          title: "Slack 이벤트 주소 등록 실패",
          note: "에이전트 1 · 멘션을 받지 못하고 있습니다",
          fix: "/agents/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c81?tab=slack",
        },
        {
          title: "Slack 홈 채널 지정 필요",
          note: "에이전트 2 · 홈 채널을 고르면 채널을 연결할 수 있습니다",
          fix: "/agents/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c82?tab=slack",
        },
        {
          title: "Slack 이벤트 주소 확인 대기",
          note: "에이전트 3 · Slack이 주소를 확인할 때까지 멘션을 받지 못합니다",
          fix: "/agents/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c83?tab=slack",
        },
      ]);
      const all = within(todo).getByRole("link", { name: "전체 보기 5건" });
      expect(all.getAttribute("href")).toBe("/agents");
      expect(
        within(todo).getByRole("link", {
          name: "이벤트 주소 다시 확인: 에이전트 1",
        }).textContent,
      ).toBe("이벤트 주소 다시 확인");
      const order = [...document.querySelectorAll("main section > div h2")].map(
        (heading) => heading.textContent,
      );
      expect(order.indexOf("지금 할 일")).toBeLessThan(
        order.indexOf("한눈에 보기"),
      );
    });

    test.each([
      ["events_failed", "이벤트 주소 다시 확인"],
      ["events_unverified", "이벤트 주소 확인"],
      ["install", "앱 설치"],
      ["reinstall", "앱 다시 설치"],
      ["home_unset", "홈 채널 고르기"],
    ] as const)(
      "%s 행의 버튼은 Slack 탭에서 할 일을 %s(으)로 말한다",
      async (action, label) => {
        renderAt("/", {
          ...homeRoutes(),
          "GET /v1/agents": listed([action]),
        });
        const todo = await screen.findByRole("region", { name: "지금 할 일" });
        const button = within(todo).getByRole("link", {
          name: `${label}: 에이전트 0`,
        });
        expect(button.textContent).toBe(label);
        expect(button.getAttribute("href")).toBe(
          "/agents/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c80?tab=slack",
        );
      },
    );

    test("목록 뒤에 더 있으면 건수는 읽은 만큼 이상이라고 한다", async () => {
      renderAt("/", {
        ...homeRoutes(),
        "GET /v1/agents": listed(["install"], "next"),
      });
      const todo = await screen.findByRole("region", { name: "지금 할 일" });
      expect(
        within(todo).getByRole("link", { name: "전체 보기 1건 이상" }),
      ).toBeTruthy();
    });

    test("조치가 필요한 에이전트가 없으면 지금 할 일을 보이지 않는다", async () => {
      renderAt("/", {
        ...homeRoutes(),
        "GET /v1/agents": listed([null, null]),
      });
      await screen.findByRole("region", { name: "한눈에 보기" });
      expect(screen.queryByRole("region", { name: "지금 할 일" })).toBeNull();
    });

    test("에이전트 목록을 볼 수 없는 구성원은 그 목록을 부르지 않는다", async () => {
      const { api } = renderAt("/", {
        ...homeRoutes(),
        "GET /v1/auth/me": () => json(200, memberMe()),
        "GET /v1/administered-agents": () => json(200, { items: [] }),
      });
      await screen.findByRole("region", { name: "한눈에 보기" });
      expect(screen.queryByRole("region", { name: "지금 할 일" })).toBeNull();
      expect(
        api.calls.some(
          (call) => call.path === "/v1/agents" && !call.search.includes("ids="),
        ),
      ).toBe(false);
    });
  });

  // Each read that changes which sections show or how tall they are: the
  // inbox row grows once its requests arrive, a card gains its footer once
  // its usage does.
  for (const [what, route, body] of [
    [
      "대기 세션의 요청",
      `GET /v1/sessions/${waitingSession.id}/pending-requests`,
      () => ({
        answerable: true,
        items: [request("2026-10-23T09:00:00.000Z")],
      }),
    ],
    ["내 사용량", summaryRoute("me"), () => summary("me", 3)],
    ["설치 한도 값", "GET /v1/limits", () => limits],
    [
      "작업 중 세션",
      "GET /v1/sessions?status=running",
      () => ({ items: [], next_cursor: null }),
    ],
    [
      "쉬는 세션",
      "GET /v1/sessions?status=idle",
      () => ({ items: [], next_cursor: null }),
    ],
    ["연동 계정", "GET /v1/linked-accounts", () => ({ items: [] })],
  ] as const) {
    test(`${what}이 올 때까지 본문은 자리표시 하나이고, 오면 한 번에 보인다`, async () => {
      let answer: () => void = () => {};
      const asked = new Promise<void>((resolve) => {
        answer = resolve;
      });
      let held = false;
      renderAt("/", {
        ...homeRoutes(),
        [route]: async () => {
          held = true;
          await asked;
          return json(200, body());
        },
      });
      await screen.findByRole("heading", { name: "홈" });
      await waitFor(() => expect(held).toBe(true));
      // Every other read answers at once; give them time to land.
      await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
      await waitFor(() =>
        expect(
          screen
            .getAllByRole("status")
            .some((s) => s.getAttribute("aria-busy") === "true"),
        ).toBe(true),
      );
      expect(screen.queryByRole("region", { name: "한눈에 보기" })).toBeNull();
      expect(
        screen.queryByRole("region", { name: /^답이 필요한 요청/ }),
      ).toBeNull();
      act(() => answer());
      expect(
        await screen.findByRole("region", { name: "한눈에 보기" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("region", { name: /^답이 필요한 요청/ }),
      ).toBeTruthy();
      expect(
        screen
          .queryAllByRole("status")
          .some((s) => s.getAttribute("aria-busy") === "true"),
      ).toBe(false);
    });
  }

  // At 390px a member's line wraps to two; the header holds both candidates
  // from the first render, so telling the reader apart moves nothing.
  test("구성원 설명 칸은 관리하는 에이전트를 알기 전부터 두 문장의 자리를 잡는다", async () => {
    let answer: () => void = () => {};
    const asked = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let held = false;
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": async () => {
        held = true;
        await asked;
        return json(200, { items: [] });
      },
    });
    await screen.findByRole("heading", { name: "홈" });
    await waitFor(() => expect(held).toBe(true));
    const manager = await screen.findByText(/님이 관리하는 에이전트와 내 세션/);
    const requester = screen.getByText(/님이 시작했거나 공유받은 세션/);
    for (const line of [manager, requester]) {
      expect(line.getAttribute("aria-hidden")).toBe("true");
      expect(line.classList.contains("invisible")).toBe(true);
      expect(line.classList.contains("[grid-area:1/1]")).toBe(true);
    }
    expect(manager.parentElement).toBe(requester.parentElement);
    act(() => answer());
    await waitFor(() =>
      expect(requester.getAttribute("aria-hidden")).toBeNull(),
    );
    expect(requester.classList.contains("invisible")).toBe(false);
    expect(manager.getAttribute("aria-hidden")).toBe("true");
    expect(manager.classList.contains("invisible")).toBe(true);
  });

  test("소유자 홈은 구성원 카드 세 장 뒤에 전체 사용량과 확인할 항목을 두고, 답변 대기 수는 진행 상황에만 센다", async () => {
    renderAt("/", homeRoutes());
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview)).toEqual([
        {
          title: "내가 시작한 세션 기준",
          badge: undefined,
          value: "$1.25",
          rows: [
            ["세션", "3"],
            ["실행 시간", "30분"],
            ["토큰", "3,600"],
          ],
        },
        {
          title: "진행 상황",
          badge: "지금",
          value: "2",
          rows: [
            ["답변 대기", "1"],
            ["작업 중", "0"],
            ["쉬는 중", "1"],
          ],
        },
        {
          title: "연결 상태",
          badge: "내 계정",
          value: "0 / 3",
          rows: [
            ["GitHub", "연결 안 됨"],
            ["Slack", "연결 안 됨"],
            ["Google Workspace", "준비 중"],
          ],
        },
        {
          title: "전체 사용량",
          badge: undefined,
          value: "$69.46",
          rows: [
            ["세션", "12"],
            ["동시 실행", "3 / 8 슬롯"],
            ["성과물 저장", "300 MB"],
          ],
        },
        {
          title: "확인할 항목",
          badge: "워크스페이스",
          value: "2",
          rows: [
            ["30분 넘게 대기", "1개 세션"],
            ["가장 오래된 요청", expect.stringContaining("1a2b3c4d · ")],
            // Past tomorrow an expiry reads as its calendar date.
            [
              "결제 담당",
              expect.stringMatching(/^(\d{4}\/)?\d{1,2}\/\d{1,2} 만료$/),
            ],
            ["에이전트", "릴리스 1 · 초안 1"],
          ],
        },
      ]),
    );
    // The waiting request is answerable from home, above the cards.
    const inbox = screen.getByRole("region", { name: /^답이 필요한 요청/ });
    expect(
      inbox.compareDocumentPosition(overview) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const oldest = await within(overview).findByRole("link", {
      name: waitingSession.id.slice(0, 8),
    });
    expect(oldest.getAttribute("href")).toBe(`/sessions/${waitingSession.id}`);
    expect(
      within(overview)
        .getByRole("link", { name: "결제 담당" })
        .getAttribute("href"),
    ).toBe("/settings/api-keys/agents");

    expect(screen.getByText("최근 30일 · UTC 기준")).toBeTruthy();
    // The install's sum is partial; the viewer's own is whole.
    expect(
      within(overview).getByText(
        "추정 비용 · 진행 중이거나 비용을 보고하지 않은 턴은 빠짐",
      ),
    ).toBeTruthy();
    expect(within(overview).getByText("추정 비용")).toBeTruthy();
    const recent = screen.getByRole("table", { name: "최근 세션" });
    // The design's dot, not a pill: amber for waiting, the text says which.
    expect(
      [...recent.querySelectorAll("[data-slot=status-dot]")].map((dot) =>
        dot.getAttribute("data-status"),
      ),
    ).toEqual(["wait", "idle"]);
    expect(
      within(recent)
        .getAllByRole("row")
        .map((row) => [...row.children].map((cell) => shownText(cell))),
    ).toEqual([
      // The session list's own columns, home without the starter.
      ["세션", "상태", "에이전트 · 모델", "저장소", "최근"],
      [
        `${waitingSession.title}${waitingSession.id.slice(0, 8)}`,
        expect.stringMatching(/^작업 상태: 답변 대기 · \d+(분|시간|일)$/),
        expect.stringMatching(/^—/),
        "demo",
        expect.stringMatching(/^최근 /),
      ],
      [
        oneSession.id.slice(0, 8),
        "작업 상태: 쉬는 중",
        expect.stringMatching(/^—/),
        "demo",
        expect.stringMatching(/^최근 /),
      ],
    ]);
    expect(
      within(recent)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual([`/sessions/${waitingSession.id}`, `/sessions/${oneSession.id}`]);
    // Focus opens the exact time the short wait count stands for.
    const waited = within(recent).getAllByRole("row")[1]?.querySelector("time");
    expect(waited?.tabIndex).toBe(0);
    act(() => waited?.focus());
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toMatch(
        /^2026년 10월 23일 \d{2}:\d{2}:\d{2}/,
      ),
    );
    // Each row opens from one link named for the session: a titled one by
    // its title, one without a title by its whole id.
    expect(
      within(recent)
        .getAllByRole("link")
        .map((l) => l.getAttribute("aria-label")),
    ).toEqual([
      `세션 열기: ${waitingSession.title}`,
      `세션 열기: ${oneSession.id}`,
    ]);
  });

  test("설치 전체 사용량 권한이 없으면 전체 카드를 숨기고 한도·전체 합계를 묻지 않는다", async () => {
    const owner = me();
    const { api } = renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () =>
        json(200, {
          ...owner,
          permissions: owner.permissions.filter(
            (action) => action !== "usage.installation_read",
          ),
        }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview).map((card) => card.title)).toEqual([
        "내가 시작한 세션 기준",
        "진행 상황",
        "연결 상태",
        "확인할 항목",
      ]),
    );
    expect(api.calls.some((call) => call.path === "/v1/limits")).toBe(false);
    expect(
      api.calls
        .filter((call) => call.path === "/v1/usage/summary")
        .map((call) => new URLSearchParams(call.search).get("scope")),
    ).not.toContain("installation");
  });

  test("사용량을 읽지 못하면 값을 지어내지 않고 —로 둔다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      [summaryRoute("me")]: () => apiError(500, "INTERNAL", "boom"),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview)[0]).toMatchObject({
        title: "내가 시작한 세션 기준",
        value: "—",
        rows: [
          ["세션", "—"],
          ["실행 시간", "—"],
          ["토큰", "—"],
        ],
      }),
    );
  });

  test("막 들어온 요청과 만료가 먼 key는 확인할 항목이 아니다", async () => {
    const recentRequest = new Date(Date.now() - 60_000).toISOString();
    renderAt("/", {
      ...homeRoutes(),
      ...pending(waitingSession.id, recentRequest),
      "GET /v1/api-keys": () =>
        json(200, {
          items: [
            { ...expiringKey, expires_at: inDays(30) },
            {
              ...expiringKey,
              id: "8b7a6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e",
              revoked_at: inDays(-1),
            },
          ],
          next_cursor: null,
        }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() => {
      const check = cards(overview)[4];
      expect(check?.value).toBe("0");
      expect(check?.rows.map(([label]) => label)).toEqual([
        "30분 넘게 대기",
        "가장 오래된 요청",
        "에이전트",
      ]);
      expect(check?.rows[0]).toEqual(["30분 넘게 대기", "0개 세션"]);
    });
  });

  test("성과물을 다 세지 못한 응답이면 전체 사용량의 성과물 저장은 하한으로 보인다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/limits": () =>
        json(200, {
          ...limits,
          usage: {
            ...limits.usage,
            outputs: { ...limits.usage.outputs, complete: false },
          },
        }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(
        cards(overview).find((card) => card.title === "전체 사용량")?.rows,
      ).toContainEqual(["성과물 저장", "300 MB 이상"]),
    );
  });

  test("가장 오래된 요청은 세션의 갱신 시각이 아니라 요청 시각으로 고른다", async () => {
    // Updated first, asked last: updated_at would pick it.
    const askedLate = {
      ...waitingSession,
      id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      updated_at: "2026-10-23T08:00:00.000Z",
    };
    const askedEarly = {
      ...waitingSession,
      updated_at: "2026-10-23T08:30:00.000Z",
    };
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [askedLate, askedEarly], next_cursor: null }),
      ...pending(askedLate.id, "2026-10-23T09:10:00.000Z"),
      ...pending(askedEarly.id, "2026-10-23T09:00:00.000Z"),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    const oldest = await within(overview).findByRole("link", {
      name: askedEarly.id.slice(0, 8),
    });
    expect(oldest.getAttribute("href")).toBe(`/sessions/${askedEarly.id}`);
    const time = oldest.parentElement?.querySelector("time");
    act(() => time?.focus());
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toMatch(
        /^2026년 10월 23일 18:00/,
      ),
    );
  });

  test("답이 필요한 요청은 세션 이름 줄로 보이고, 전체 보기는 답변 대기 목록으로 간다", async () => {
    renderAt("/", homeRoutes());
    const inbox = await screen.findByRole("region", {
      name: /^답이 필요한 요청/,
    });
    const name = await within(inbox).findByRole("link", {
      name: `세션 열기 ${waitingSession.title}`,
    });
    expect(name.getAttribute("href")).toBe(`/sessions/${waitingSession.id}`);
    expect(inbox.textContent).toMatch(
      /내게 온 이유: 내가 시작한 세션 · \d+분째 대기/,
    );
    expect(
      within(inbox)
        .getByRole("link", { name: "전체 보기" })
        .getAttribute("href"),
    ).toBe("/sessions?status=needs_input");
  });

  test("답할 요청이 없으면 빈 상태가 무엇이 언제 나오는지 알린다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [], next_cursor: null }),
    });
    const inbox = await screen.findByRole("region", {
      name: /^답이 필요한 요청/,
    });
    await within(inbox).findByText("지금 답할 요청이 없습니다");
    expect(
      within(inbox).getByText(
        "세션이 권한이나 답을 기다리면 여기에 먼저 나옵니다.",
      ),
    ).toBeTruthy();
  });

  test("대기 세션 목록을 다시 읽다 실패하면 전에 고른 가장 오래된 요청을 내린다", async () => {
    let fail = false;
    const { services } = renderAt("/", {
      ...homeRoutes(),
      "GET /v1/sessions?status=needs_input": () =>
        fail
          ? json(500, { error: { code: "INTERNAL" } })
          : json(200, { items: [waitingSession], next_cursor: null }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    const name = waitingSession.id.slice(0, 8);
    await within(overview).findByRole("link", { name });
    fail = true;
    await act(async () => {
      await services.queryClient.refetchQueries({
        queryKey: keys.waitingSessions,
      });
      // The query batches its notification on a timer; let it land in act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(within(overview).queryByRole("link", { name })).toBeNull(),
    );
  });

  test("대기 세션이 한 페이지를 넘으면 가장 오래된 요청도, 오래 기다린 수도 짐작하지 않는다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [waitingSession], next_cursor: "more" }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview)[1]?.rows[0]).toEqual(["답변 대기", "1+"]),
    );
    // The keys answered; the waiting count is what stays unknown.
    await waitFor(() =>
      expect(
        within(overview).getByRole("link", { name: "결제 담당" }),
      ).toBeDefined(),
    );
    expect(cards(overview)[4]?.value).toBe("—");
    expect(cards(overview)[4]?.rows[0]).toEqual(["30분 넘게 대기", "—"]);
    expect(
      within(overview).queryByRole("link", {
        name: waitingSession.id.slice(0, 8),
      }),
    ).toBeNull();
  });

  test("시작하기를 다 마치면 블록째 숨긴다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/members": () =>
        json(
          200,
          memberPage({
            items: [
              owner,
              {
                ...owner,
                user_id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
                email: "member@example.com",
                role: "member",
              },
            ],
            next_cursor: null,
          }),
        ),
    });
    // The recent table reads the same session list the last step does.
    await screen.findByRole("table", { name: "최근 세션" });
    await waitFor(() =>
      expect(document.querySelector("[data-slot=home-checklist]")).toBeNull(),
    );
  });

  test("목록 하나라도 읽는 중이면 시작하기를 그리지 않는다", async () => {
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => new Promise<Response>(() => {}),
      ...noSessions,
    });
    await screen.findByRole("heading", { name: "홈" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/sessions")).toBe(true),
    );
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/invites")).toBe(true),
    );
    expect(document.querySelector("[data-slot=home-checklist]")).toBeNull();
  });

  test.each([
    ["owner", [], "설치 전체 현황과 워크스페이스 점검 항목입니다."],
    ["admin", [], "내 세션과 관리하는 에이전트, 워크스페이스 점검 항목입니다."],
    [
      "member",
      [agentServer().detail().agent],
      "Owner 님이 관리하는 에이전트와 내 세션을 기준으로 구성했습니다.",
    ],
    [
      "member",
      [],
      "Owner 님이 시작했거나 공유받은 세션을 기준으로 구성했습니다.",
    ],
  ] as const)(
    "설명은 역할로 고른다: %s, 관리하는 에이전트 %p",
    async (role, administered, intro) => {
      renderAt("/", {
        ...homeRoutes(),
        "GET /v1/auth/me": () => json(200, me(undefined, role)),
        "GET /v1/administered-agents": () => json(200, { items: administered }),
      });
      const line = await screen.findByText(intro);
      // The other member line stays laid under it, hidden.
      await waitFor(() => expect(line.getAttribute("aria-hidden")).toBeNull());
      expect(line.classList.contains("invisible")).toBe(false);
    },
  );

  test("다시 읽기에 실패한 목록은 진행 상황 합계에 옛 값으로 남지 않는다", async () => {
    const running = {
      ...oneSession,
      id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      status: "running",
    };
    let runningFails = false;
    const { services } = renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions?status=running": () =>
        runningFails
          ? json(500, { error: { code: "INTERNAL", message: "boom" } })
          : json(200, { items: [running], next_cursor: null }),
      "GET /v1/sessions?status=idle": () =>
        json(200, { items: [], next_cursor: null }),
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    const progress = () => cards(overview)[1];
    await waitFor(() =>
      expect(progress()).toMatchObject({
        value: "2",
        rows: [
          ["답변 대기", "1"],
          ["작업 중", "1"],
          ["쉬는 중", "0"],
        ],
      }),
    );
    runningFails = true;
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() =>
      expect(progress()).toMatchObject({
        value: "—",
        rows: [
          ["답변 대기", "1"],
          ["작업 중", "—"],
          ["쉬는 중", "0"],
        ],
      }),
    );
  });

  test("비활성으로 알려 온 Slack 계정은 연결로 세지 않고 다시 연결을 보인다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions?status=running": () =>
        json(200, { items: [], next_cursor: null }),
      "GET /v1/sessions?status=idle": () =>
        json(200, { items: [], next_cursor: null }),
      "GET /v1/linked-accounts": () =>
        json(200, {
          items: [
            {
              id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
              user_id: "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c",
              provider: "slack",
              external_tenant: "T0001",
              external_user_id: "U0001",
              external_tenant_name: null,
              external_user_name: null,
              status: "stale",
              verified_at: "2026-10-01T00:00:00Z",
              revision: 1,
              expires_at: null,
            },
          ],
        }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview)[2]).toMatchObject({
        value: "0 / 3",
        rows: [
          ["GitHub", "연결 안 됨"],
          ["Slack", "다시 연결"],
          ["Google Workspace", "준비 중"],
        ],
      }),
    );
  });

  test("관리하는 에이전트를 읽지 못하면 카드를 짐작하지 않고 다시 시도를 보인다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () =>
        json(500, { error: { code: "INTERNAL", message: "boom" } }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    expect(
      await within(overview).findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(within(overview).queryAllByRole("listitem")).toEqual([]);
  });

  test("구성원 홈은 내 사용량, 진행 상황, 연동 계정 카드다", async () => {
    const running = {
      ...oneSession,
      id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      status: "running",
    };
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions?status=running": () =>
        json(200, { items: [running], next_cursor: null }),
      "GET /v1/sessions?status=idle": () =>
        json(200, { items: [oneSession], next_cursor: "next" }),
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview).slice(1)).toEqual([
        {
          title: "진행 상황",
          badge: "지금",
          value: "3+",
          rows: [
            ["답변 대기", "1"],
            ["작업 중", "1"],
            ["쉬는 중", "1+"],
          ],
        },
        {
          title: "연결 상태",
          badge: "내 계정",
          value: "0 / 3",
          rows: [
            ["GitHub", "연결 안 됨"],
            ["Slack", "연결 안 됨"],
            ["Google Workspace", "준비 중"],
          ],
        },
      ]),
    );
    expect(cards(overview)[0]?.title).toBe("내가 시작한 세션 기준");
    expect(
      [...overview.querySelectorAll("[data-slot=status-dot]")].map((dot) =>
        dot.getAttribute("data-status"),
      ),
    ).toEqual(["wait", "run", "idle", "idle", "idle", "idle"]);
    // The "last 30 days" basis waits for a usage period; only the owner's shows.
    expect(
      screen.queryByText("설치 전체 수치는 설치 운영자에게만 보입니다"),
    ).toBeNull();
    expect(
      within(overview)
        .getByRole("link", { name: /연동 계정 보기/ })
        .getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test.each([
    [
      "member",
      ["내가 시작한 세션 기준", "진행 상황", "연결 상태", "AGENT", "AGENT"],
    ],
    [
      "admin",
      [
        "내가 시작한 세션 기준",
        "진행 상황",
        "연결 상태",
        "AGENT",
        "확인할 항목",
      ],
    ],
  ] as const)(
    "%s가 관리하는 에이전트는 카드로 보인다",
    async (role, titles) => {
      const agent = agentServer().detail().agent;
      const other = {
        ...agent,
        id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
        name: "Second",
      };
      renderAt("/", {
        ...homeRoutes(),
        "GET /v1/auth/me": () => json(200, me(undefined, role)),
        "GET /v1/administered-agents": () =>
          json(200, {
            items: [
              agent,
              other,
              { ...other, id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a" },
            ],
          }),
      });
      const overview = await screen.findByRole("region", {
        name: "한눈에 보기",
      });
      const expected = titles.map((title, index) =>
        title === "AGENT"
          ? [agent.name, other.name][index - titles.indexOf("AGENT")]
          : title,
      );
      await waitFor(() =>
        expect(cards(overview).map((card) => card.title)).toEqual(expected),
      );
      // Read for this reader too, not left as unknown.
      await waitFor(() => expect(cards(overview)[1]?.value).toBe("2"));
      expect(cards(overview)[2]?.value).toBe("0 / 3");
      expect(
        within(overview)
          .getAllByRole("link", { name: /에이전트 보기/ })[0]
          ?.getAttribute("href"),
      ).toBe(`/agents/${agent.id}`);
    },
  );

  describe("관리하는 에이전트 카드", () => {
    const agent = agentServer().detail().agent;
    const summary = (refs: string[], bound: string[]) => ({
      version: {
        version_no: 1,
        role: "reviewer",
        instructions: "Review.",
        mcp_servers: [],
        credential_refs: refs,
      },
      connection_id: null,
      release_label: null,
      release_model: null,
      bound_credential_refs: bound,
      admins: ["Owner"],
      needs_input_count: 2,
      running_count: 1,
      slack_action: null,
    });
    const agentCardOf = async (
      role: "admin" | "member",
      agents: () => Response,
    ) => {
      const harness = renderAt("/", {
        ...homeRoutes(),
        "GET /v1/auth/me": () => json(200, me(undefined, role)),
        "GET /v1/administered-agents": () => json(200, { items: [agent] }),
        "GET /v1/agents": agents,
      });
      const overview = await screen.findByRole("region", {
        name: "한눈에 보기",
      });
      await waitFor(() =>
        expect(cards(overview).some((card) => card.title === agent.name)).toBe(
          true,
        ),
      );
      return {
        ...harness,
        card: () => cards(overview).find((card) => card.title === agent.name),
      };
    };

    test.each([
      [[], [], "필요 없음"],
      [["github", "slack"], ["github", "slack"], "연결됨 2개"],
      [["github", "slack"], ["github"], "연결 필요 1개"],
    ])(
      "admin 카드는 summary의 답 대기·작업 중·자격 증명을 보인다 (%p, %p)",
      async (refs, bound, credentials) => {
        const { card } = await agentCardOf("admin", () =>
          json(200, {
            items: [{ ...agent, summary: summary(refs, bound) }],
            next_cursor: null,
          }),
        );
        await waitFor(() => expect(card()?.value).toBe("2"));
        expect(card()?.rows).toEqual([
          ["작업 중", "1"],
          ["최근 7일 세션", "—미계측"],
          ["자격 증명", credentials],
        ]);
      },
    );

    test.each([
      ["읽기가 실패하면", () => apiError(500, "INTERNAL", "boom")],
      [
        "summary가 없으면",
        () => json(200, { items: [agent], next_cursor: null }),
      ],
      ["항목이 없으면", () => json(200, { items: [], next_cursor: null })],
    ])(
      "admin 카드는 %s 미계측 그대로이고 0을 만들지 않는다",
      async (_, agents) => {
        const { card, services } = await agentCardOf("admin", agents);
        await waitFor(() =>
          expect(
            services.queryClient.getQueryState(keys.agents)?.status,
          ).not.toBe("pending"),
        );
        expect(card()?.value).toBe("—미계측");
        expect(card()?.rows).toEqual([
          ["작업 중", "—미계측"],
          ["최근 7일 세션", "—미계측"],
          ["자격 증명", "—미계측"],
        ]);
      },
    );

    test("다시 읽기가 실패하면 앞서 읽은 summary를 보이지 않는다", async () => {
      let fails = false;
      const { card, services } = await agentCardOf("admin", () =>
        fails
          ? apiError(500, "INTERNAL", "boom")
          : json(200, {
              items: [{ ...agent, summary: summary([], []) }],
              next_cursor: null,
            }),
      );
      await waitFor(() => expect(card()?.value).toBe("2"));
      fails = true;
      await act(() =>
        services.queryClient.refetchQueries({ queryKey: keys.agents }),
      );
      await waitFor(() => expect(card()?.value).toBe("—미계측"));
      expect(card()?.rows).toEqual([
        ["작업 중", "—미계측"],
        ["최근 7일 세션", "—미계측"],
        ["자격 증명", "—미계측"],
      ]);
    });

    test("목록을 읽을 수 없는 구성원 관리자 카드는 미계측이고 목록을 부르지 않는다", async () => {
      const { card, api } = await agentCardOf("member", () =>
        apiError(403, "FORBIDDEN", "not allowed"),
      );
      await Bun.sleep(50);
      expect(card()?.value).toBe("—미계측");
      expect(card()?.rows).toEqual([
        ["작업 중", "—미계측"],
        ["최근 7일 세션", "—미계측"],
        ["자격 증명", "—미계측"],
      ]);
      expect(api.calls.some((c) => c.path === "/v1/agents")).toBe(false);
    });
  });

  test("홈에는 새 세션 버튼과 그 사유 문구가 없다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    await screen.findByRole("table", { name: "최근 세션" });
    expect(screen.queryByRole("button", { name: "새 세션" })).toBeNull();
    expect(
      screen.queryByText(
        "웹에서는 아직 세션을 시작할 수 없습니다. API로 시작하세요.",
      ),
    ).toBeNull();
  });
});

describe("statusPageQuery", () => {
  test("작업 중·쉬는 중 목록은 답변 대기 목록과 같은 주기로 다시 읽는다", () => {
    // The open total adds the three lists; read at different paces it would
    // count a session that moved between them twice or not at all.
    const client = withQueryScope({} as ApiClient, SCOPE);
    for (const status of ["running", "idle"] as const)
      expect<unknown>(
        statusPageQuery(client, status, true).refetchInterval,
      ).toBe(waitingSessionsQuery(client).refetchInterval);
  });
});

describe("홈의 대기 시간", () => {
  test("응답이 그대로여도 분마다 움직인다", () => {
    const at = "2026-10-23T09:00:00.000Z";
    jest.useFakeTimers({ now: new Date(at) });
    try {
      const { result, unmount } = renderHook(() => useMinute(true));
      expect(formatElapsed(at, "ko", result.current)).toBe("0분");
      act(() => jest.advanceTimersByTime(12 * 60_000));
      expect(formatElapsed(at, "ko", result.current)).toBe("12분");
      unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("내가 속한 팀", () => {
  const TEAM = {
    id: "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
    name: "결제팀",
    role: "member",
  };
  const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");

  test("구성원도 홈에서 속한 팀 이름으로 팀 화면을 연다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/my-teams": () => json(200, { items: [TEAM], next_cursor: null }),
    });
    const section = await screen.findByRole("region", {
      name: "내가 속한 팀",
    });
    const link = within(section).getByRole("link", { name: "결제팀" });
    expect(link.getAttribute("href")).toBe(`/members/teams/${TEAM.id}`);
    // A member has no 구성원 item in the sidebar; this is their way to the list.
    expect(
      within(section)
        .getByRole("link", { name: "모든 팀" })
        .getAttribute("href"),
    ).toBe("/members/teams");
  });

  test("팀을 관리하는 사람에게도 팀 화면 링크다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/my-teams": () => json(200, { items: [TEAM], next_cursor: null }),
    });
    const link = await screen.findByRole("link", { name: "결제팀" });
    expect(link.getAttribute("href")).toBe(`/members/teams/${TEAM.id}`);
  });

  test("팀이 없는 구성원에게도 홈에서 팀 목록으로 가는 길이 남는다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
    });
    const section = await screen.findByRole("region", {
      name: "내가 속한 팀",
    });
    expect(within(section).getByText("아직 속한 팀이 없습니다.")).toBeDefined();
    expect(
      within(section)
        .getByRole("link", { name: "모든 팀" })
        .getAttribute("href"),
    ).toBe("/members/teams");
  });

  test("구성원 메뉴가 있는 관리자에게 팀이 없으면 홈에 섹션을 두지 않는다", async () => {
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/my-teams": () => json(200, { items: [], next_cursor: null }),
    });
    await screen.findByRole("heading", { name: "홈" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/my-teams")).toBe(true),
    );
    // Let the empty answer render before checking that nothing did.
    await Bun.sleep(50);
    expect(screen.queryByRole("heading", { name: "내가 속한 팀" })).toBeNull();
  });
});

describe("내가 관리하는 에이전트", () => {
  const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");
  const memberRoutes = {
    "GET /v1/auth/me": () => json(200, memberMe()),
    "GET /v1/members": forbidden,
    "GET /v1/invites": forbidden,
    "GET /v1/agents": forbidden,
  };

  test("관리자로 지정된 에이전트를 상세 링크로 보인다", async () => {
    const agent = agentServer().detail().agent;
    renderAt("/", {
      ...memberRoutes,
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
    });
    await screen.findByRole("heading", { name: "내가 관리하는 에이전트" });
    expect(
      screen.getByRole("link", { name: agent.name }).getAttribute("href"),
    ).toBe(`/agents/${AGENT_ID}`);
  });

  test("관리하는 에이전트가 없으면 섹션을 보이지 않는다", async () => {
    const { api } = renderAt("/", {
      ...memberRoutes,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    await screen.findByRole("heading", { name: "홈" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/administered-agents")).toBe(
        true,
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "내가 관리하는 에이전트" }),
    ).toBeNull();
  });

  test("모든 에이전트를 관리하는 소유자에게는 묻지도 보이지도 않는다", async () => {
    const server = agentServer();
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual([
        "done",
        "done",
        "done",
        "pending",
        "pending",
        "pending",
      ]),
    );
    expect(api.calls.some((c) => c.path === "/v1/administered-agents")).toBe(
      false,
    );
    expect(
      screen.queryByRole("heading", { name: "내가 관리하는 에이전트" }),
    ).toBeNull();
  });
});
