import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ListPendingRequestsResponse,
  SessionDetail,
  SessionSummary,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  keys,
  me,
  memberMe,
  RECEIPT_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import type { SessionsSearch } from "./sessions.tsx";

const { renderAt, screen, waitFor, act, within, fireEvent } =
  await appHarness();
// After the harness: the screen's kit has to see the DOM when it loads.
const { withSessionsFilter } = await import("./sessions.tsx");

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const OTHER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const THIRD_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const AT = "2026-10-11T08:14:02.000Z";
const SLACK_PERMALINK =
  "https://acme.slack.com/archives/C0OPS/p1793000000000100";
// Far enough ahead that a request still takes answers.
const LATER = "2099-01-01T00:00:00.000Z";
/** A session list row's opener, named as the screen names it. */
const opener = (name: string) => `세션 열기: ${name}`;
const TERMINATE_ACCEPTED = {
  receipt_id: RECEIPT_ID,
  receipt_status: "accepted",
  external_effects_reverted: false,
};

interface Connection {
  readonly request: Request;
  push(text: string): void;
  end(): void;
}

/**
 * The server's side of the session's event stream. Each connection the
 * screen asks for waits until the test calls open(), so the screen's
 * "connecting" state can be seen; frames go to the newest open one.
 */
class FakeEventStream {
  readonly requests: Request[] = [];
  private waiting: (() => void)[] = [];
  private live: Connection | null = null;
  private refusal: (() => Response) | null = null;

  readonly route = (request: Request): Promise<Response> => {
    this.requests.push(request);
    if (this.refusal) return Promise.resolve(this.refusal());
    return new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
      this.waiting.push(() => resolve(this.connect(request)));
    });
  };

  private connect(request: Request): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    request.signal.addEventListener("abort", () =>
      controller.error(new DOMException("aborted", "AbortError")),
    );
    this.live = {
      request,
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  }

  open() {
    for (const release of this.waiting.splice(0)) release();
  }
  emit(id: string, event: string, data: unknown, turnId: string | null = "1") {
    const envelope = {
      schema_version: 1,
      session_id: SESSION_ID,
      turn_id: turnId,
      attempt_id: null,
      occurred_at: AT,
      data,
    };
    this.live?.push(
      `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`,
    );
  }
  /** The connection ends; the screen reconnects with Last-Event-ID. */
  drop() {
    this.live?.end();
    this.live = null;
  }
  /** The server refuses every connection from now on (the share is gone). */
  fail() {
    this.refusal = () => apiError(404, "NOT_FOUND", "Resource not found");
    this.drop();
  }
  /**
   * Every connection from now on meets a policy that cannot decide, as while
   * storage is unreachable, until recover().
   */
  undecided() {
    this.refusal = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "This principal does not hold session.read",
            details: { reason_code: "error" },
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    this.drop();
  }
  recover() {
    this.refusal = null;
  }
  /** Whether the screen has let go of the newest connection. */
  get closed() {
    return this.requests.at(-1)?.signal.aborted ?? false;
  }
}

let stream: FakeEventStream;
beforeEach(() => {
  stream = new FakeEventStream();
  // The timeline view is remembered; each test starts in focus.
  globalThis.localStorage?.clear();
});

/** The head's one line under the title: id, agent, channel, cost and tokens. */
async function sessionMeta() {
  return waitFor(() => {
    const meta = document.querySelector<HTMLElement>(
      "[data-slot='session-meta']",
    );
    if (!meta) throw new Error("no session meta line yet");
    return meta;
  });
}
/** The head's progress line: step, tool calls, time, cost and tokens. */
async function sessionProgress() {
  return waitFor(() => {
    const line = document.querySelector<HTMLElement>(
      "[data-slot='session-progress']",
    );
    if (!line) throw new Error("no session progress line yet");
    return line;
  });
}
const EVENTS_ROUTE = `GET /v1/sessions/${SESSION_ID}/events`;

/** The filter panel's relation section, unfolded. */
async function relationChoices(user: Awaited<ReturnType<typeof setupUser>>) {
  await user.click(screen.getByRole("button", { name: /^필터/ }));
  const panel = await screen.findByRole("dialog", { name: "필터" });
  const header = within(panel).getByRole("button", { name: /^관계/ });
  if (header.getAttribute("aria-expanded") !== "true") await user.click(header);
  return within(panel).getByRole("list", { name: "관계" });
}

/** Opens the filters, picks a relation by its label and closes them. */
async function pickRelation(
  user: Awaited<ReturnType<typeof setupUser>>,
  label: string,
) {
  const list = await relationChoices(user);
  await user.click(
    within(list).getByRole("button", { name: new RegExp(`^${label}`) }),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

/** A choice's label without its count. */
const choiceLabel = (choice: HTMLElement) =>
  choice.querySelector("span")?.textContent;

function summary(id: string, overrides: Partial<SessionSummary> = {}) {
  return {
    id,
    revision: 3,
    admission_state: "active",
    status: "running",
    runtime: {
      kind: "claude_agent_sdk",
      version: "1.0.0",
      connection_id: "default",
      model: "model-default",
      permission_mode: "default",
    },
    repository_id: "demo",
    current_turn_id: "1",
    queued_turn_count: 0,
    turn_time_ms: 0,
    model: "model-default",
    last_event_at: AT,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  } as SessionSummary;
}

/**
 * The list API over `count` running sessions titled "세션 1" on, read
 * `limit` at a time with the offset as its cursor; `q` keeps the titles that
 * contain it, and any status but running gives none.
 */
function sessionPages(count: number) {
  const all = Array.from({ length: count }, (_, index) =>
    summary(`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, {
      title: `세션 ${index + 1}`,
    }),
  );
  return (request: Request) => {
    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    const q = params.get("q");
    const matching = all.filter(
      (item) =>
        (status === null || status === "running") &&
        (q === null || (item.title ?? "").includes(q)),
    );
    const limit = Number(params.get("limit") ?? 50);
    const from = Number(params.get("cursor")?.slice(1) ?? 0);
    const to = from + limit;
    return json(200, {
      items: matching.slice(from, to),
      next_cursor: to < matching.length ? `c${to}` : null,
    });
  };
}

function sessionCounts(running: number) {
  return {
    counts: {
      queued: 0,
      running,
      needs_input: 0,
      idle: 0,
      failed: 0,
      stopped: 0,
      cut_off: 0,
    },
    total: running,
  };
}

/** The titles of the session rows shown, in order. */
function listedTitles() {
  return screen
    .queryAllByRole("link", { name: /^세션 열기: 세션 \d+$/ })
    .map((link) => link.getAttribute("title"));
}

/** The list's reads, leaving out the inbox's waiting page. */
function listReads(calls: readonly { path: string; search: string }[]) {
  return calls
    .filter(
      (call) =>
        call.path === "/v1/sessions" && call.search !== "?status=needs_input",
    )
    .map((call) => call.search);
}

const detail = {
  ...summary(SESSION_ID, { status: "needs_input" }),
  execution: null,
  checkpoint_revision: null,
  pending_request_count: 1,
  attention: { code: "BUDGET_EXCEEDED", reason: "cost limit reached" },
  durability: {
    last_transcript_persisted_at: null,
    checkpoint_committed_at: null,
    checkpoint_revision: null,
    last_completed_turn_id: null,
    last_checkpointed_turn_id: null,
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetail;

const usage: SessionUsageResponse = {
  session_id: SESSION_ID,
  period: "session_lifetime",
  refreshed_at: AT,
  cost: {
    amount_usd: "0.000042",
    kind: "estimated",
    source: "provider_usage",
    completeness_scope: "turn_reports",
    complete: false,
    reported_turn_count: 1,
    unreported_turn_count: 0,
    open_turn_count: 1,
  },
  cost_limit_usd: "25",
  token_count: 1234,
  token_limit: null,
  budget_exceeded: true,
  queued_input_count: 0,
  queued_input_limit: 10,
};

const pending: ListPendingRequestsResponse = {
  answerable: true,
  items: [
    {
      kind: "permission",
      request_id: "req_1",
      turn_id: "1",
      attempt_id: "att_1",
      created_at: AT,
      expires_at: AT,
      tool: "Bash",
      input: { command: "ls" },
    },
  ],
};

const detailRoutes = {
  "GET /v1/auth/me": () => json(200, me()),
  [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, detail),
  [`GET /v1/sessions/${SESSION_ID}/usage`]: () => json(200, usage),
  [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () => json(200, pending),
  [EVENTS_ROUTE]: (request: Request) => stream.route(request),
};

describe("approval inbox", () => {
  // A request is answered on its own line.
  const allowOnLine = async () =>
    within(await screen.findByRole("region", { name: "답변 대기" })).findByRole(
      "button",
      { name: /^승인/ },
    );
  const waitingRoutes = (items: unknown[], next_cursor: string | null) => ({
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    "GET /v1/sessions?status=needs_input": () =>
      json(200, { items, next_cursor }),
    [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
      json(200, {
        answerable: true,
        items: [{ ...pending.items[0], expires_at: LATER }],
      }),
    [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
      json(200, { answerable: true, items: [] }),
  });

  test("lists the waiting sessions as framed lines, leaving out one whose list came back empty", async () => {
    const { api } = renderAt(
      "/sessions",
      waitingRoutes(
        [
          summary(SESSION_ID, { status: "needs_input" }),
          summary(OTHER_ID, { status: "needs_input" }),
        ],
        null,
      ),
    );
    const inbox = await screen.findByRole("region", { name: "답변 대기" });
    // The line answers its request in place.
    expect(
      await within(inbox).findAllByRole("button", { name: /^승인/ }),
    ).toHaveLength(1);
    expect(screen.queryByRole("complementary") === null).toBe(true);
    // OTHER_ID was answered or lapsed since the waiting list was read: no
    // line of its own saying nothing waits, and not counted.
    expect(within(inbox).queryByText(/요청이 없습니다/)).toBeNull();
    expect(
      within(inbox).queryByRole("link", { name: `세션 열기 ${OTHER_ID}` }),
    ).toBeNull();
    const badge = (await within(inbox).findByText("답을 기다리는 세션 1개"))
      .parentElement as HTMLElement;
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.textContent).toBe("1답을 기다리는 세션 1개");
    expect(
      badge.parentElement?.contains(
        screen.getByRole("heading", { name: "답변 대기" }),
      ),
    ).toBe(true);
    // ...and the waiting list is read again so the sidebar catches up.
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.search === "?status=needs_input")
          .length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(
      within(inbox)
        .getByRole("link", { name: `세션 열기 ${SESSION_ID}` })
        .getAttribute("href"),
    ).toBe(`/sessions/${SESSION_ID}`);
    // One framed list as wide as the session table below.
    const list = within(inbox).getAllByRole("list")[0] as HTMLElement;
    expect(list.className).toContain("rounded-card");
    expect(list.className).toContain("divide-y");
    expect(inbox.parentElement?.className).toContain(
      "gap-[var(--werft-space-block)]",
    );
  });

  test("a longer first page reads as more, as the badge does", async () => {
    renderAt(
      "/sessions",
      waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], "next"),
    );
    const count = await screen.findByText("답을 기다리는 세션 1개 이상");
    expect(count.parentElement?.textContent).toBe(
      "1+답을 기다리는 세션 1개 이상",
    );
    expect(await screen.findByText("답변 대기 1개 이상")).toBeTruthy();
  });

  test("answers from the inbox and reads the waiting sessions again", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      ...waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], null),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const waitingReads = () =>
      api.calls.filter((call) => call.search === "?status=needs_input").length;
    const allow = await allowOnLine();
    const before = waitingReads();
    await user.click(allow);
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      action: "allow",
    });
    await waitFor(() => expect(waitingReads()).toBeGreaterThan(before));
  });

  test("denies from the inbox without a reason; the body leaves the reason out", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      ...waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], null),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const inbox = await screen.findByRole("region", { name: "답변 대기" });
    await user.click(
      await within(inbox).findByRole("button", { name: /^거부/ }),
    );
    await user.click(
      within(inbox).getByRole("button", { name: "거부 보내기" }),
    );
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      action: "deny",
    });
  });

  test("an answer from the inbox reads the waiting tab again", async () => {
    const user = await setupUser();
    const waiting = waitingRoutes(
      [summary(SESSION_ID, { status: "needs_input" })],
      null,
    );
    const { api } = renderAt("/sessions?status=needs_input", {
      ...waiting,
      "GET /v1/sessions?status=needs_input&limit=15":
        waiting["GET /v1/sessions?status=needs_input"],
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const list = await screen.findByRole("table");
    await within(list).findByRole("link", { name: opener(SESSION_ID) });
    // The inbox reads the API's default page, the tab its own page size.
    const waitingReads = () =>
      api.calls.filter((call) =>
        ["?status=needs_input", "?status=needs_input&limit=15"].includes(
          call.search,
        ),
      ).length;
    await waitFor(() => expect(waitingReads()).toBe(2));
    await user.click(await allowOnLine());
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    // The inbox's page and the tab's list are separate queries: both read again.
    await waitFor(() => expect(waitingReads()).toBeGreaterThanOrEqual(4));
  });

  test("a session answered on its line leaves, and the keyboard goes to the inbox heading", async () => {
    const user = await setupUser();
    let waiting = [summary(SESSION_ID, { status: "needs_input" })];
    renderAt("/sessions", {
      ...waitingRoutes([], null),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: waiting, next_cursor: null }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        waiting = [];
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    await screen.findByRole("region", { name: "답변 대기" });
    (await allowOnLine()).focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("답을 기다리는 세션이 없습니다."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("heading", { name: "답변 대기" }),
      ).toBe(true),
    );
  });

  test("says so when nothing is waiting", async () => {
    renderAt("/sessions", waitingRoutes([], null));
    expect(
      await screen.findByText("답을 기다리는 세션이 없습니다."),
    ).toBeTruthy();
  });
});

describe("sessions list", () => {
  test("shows the caller's sessions and pages on with the cursor", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("cursor") === "next-1"
          ? json(200, { items: [summary(OTHER_ID)], next_cursor: null })
          : json(200, {
              items: [
                summary(SESSION_ID, { status: "idle", turn_time_ms: 30_000 }),
              ],
              next_cursor: "next-1",
            }),
    });

    const link = await screen.findByRole("link", { name: opener(SESSION_ID) });
    expect(link.getAttribute("href")).toBe(`/sessions/${SESSION_ID}`);
    const row = link.closest('[role="row"]') as HTMLElement;
    // Untitled: the row shows the id's head, the link keeps the whole id.
    expect(within(row).getByText(SESSION_ID.slice(0, 8))).toBeTruthy();
    expect(row.textContent).toContain("작업 상태: 쉬는 중");
    // Idle after a 30-second turn: its run time, not "in progress".
    expect(within(row).getByText("1분 미만")).toBeTruthy();
    expect(screen.getByText(/나에게 공유된 세션입니다/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("link", { name: opener(SESSION_ID) })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "다음 페이지" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      api.calls
        .filter(
          (call) =>
            call.path === "/v1/sessions" &&
            call.search !== "?status=needs_input",
        )
        .map((call) => call.search),
    ).toEqual(["?limit=15", "?cursor=next-1&limit=15"]);
  });

  test("shows 15 sessions a page, steps through the pages and keeps the page in the address", async () => {
    const user = await setupUser();
    const { api, history } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(20),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(20)),
    });
    await screen.findByRole("link", { name: opener("세션 1") });
    expect(listedTitles()).toHaveLength(15);
    expect(listedTitles().at(-1)).toBe("세션 15");
    const nav = screen.getByRole("navigation", { name: "페이지 이동" });
    expect(screen.getByText("1–15 / 20")).toBeTruthy();
    expect(
      within(nav)
        .getByRole("button", { name: "1페이지" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav)
        .getByRole("button", { name: "이전 페이지" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    await user.click(within(nav).getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: opener("세션 16") });
    expect(listedTitles()).toEqual([
      "세션 16",
      "세션 17",
      "세션 18",
      "세션 19",
      "세션 20",
    ]);
    expect(history.location.search).toBe("?page=2");
    expect(screen.getByText("16–20 / 20")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "2페이지" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: "다음 페이지" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(listReads(api.calls)).toEqual(["?limit=15", "?cursor=c15&limit=15"]);

    await user.click(screen.getByRole("button", { name: "이전 페이지" }));
    await screen.findByRole("link", { name: opener("세션 1") });
    expect(history.location.search).toBe("");
    // Each page is its own entry: back returns to the second.
    act(() => history.back());
    await screen.findByRole("link", { name: opener("세션 16") });
    expect(history.location.search).toBe("?page=2");
    expect(listReads(api.calls)).toHaveLength(2);
  });

  test("a list that fits on one page shows no page links", async () => {
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(15),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(15)),
    });
    await screen.findByRole("link", { name: opener("세션 15") });
    expect(listedTitles()).toHaveLength(15);
    expect(
      screen.queryByRole("navigation", { name: "페이지 이동" }),
    ).toBeNull();
    expect(screen.getByText("15개 표시")).toBeTruthy();
    // Read at the page size: fifteen rows, and nothing past them.
    expect(listReads(api.calls)).toEqual(["?limit=15"]);
  });

  // 94S-2270: the server leaves out private channels it is still
  // confirming and says so; the screen says it is checking, with no count.
  test("a list that left out private channels still being confirmed says it is checking", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(3),
      "GET /v1/sessions/counts": () =>
        json(200, { ...sessionCounts(3), private_channels_pending: true }),
    });
    await screen.findByRole("link", { name: opener("세션 3") });
    expect((await screen.findByText("비공개 채널 확인 중…")).tagName).toBe(
      "OUTPUT",
    );
  });

  test("a list with every channel confirmed says nothing of checking", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(3),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(3)),
    });
    await screen.findByRole("link", { name: opener("세션 3") });
    await screen.findByText("3개 표시");
    expect(screen.queryByText("비공개 채널 확인 중…")).toBeNull();
  });

  test("an address with a page opens on it, reading the pages before it in turn", async () => {
    const { api } = renderAt("/sessions?page=3", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(40),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(40)),
    });
    await screen.findByRole("link", { name: opener("세션 31") });
    expect(listedTitles()).toHaveLength(10);
    expect(screen.getByText("31–40 / 40")).toBeTruthy();
    expect(listReads(api.calls)).toEqual([
      "?limit=15",
      "?cursor=c15&limit=15",
      "?cursor=c30&limit=15",
    ]);
  });

  test("a page past the count moves to the last page without reading past it", async () => {
    const { api, history } = renderAt("/sessions?page=9", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(20),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(20)),
    });
    await screen.findByRole("link", { name: opener("세션 16") });
    expect(history.location.search).toBe("?page=2");
    expect(listReads(api.calls)).toEqual(["?limit=15", "?cursor=c15&limit=15"]);
  });

  test("a count that lags behind the list never stops the address short of a page the list has", async () => {
    const { history } = renderAt("/sessions?page=3", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(40),
      // Counted before twenty more sessions started.
      "GET /v1/sessions/counts": () => json(200, sessionCounts(20)),
    });
    await screen.findByRole("link", { name: opener("세션 31") });
    expect(listedTitles()).toHaveLength(10);
    expect(history.location.search).toBe("?page=3");
    // The list's own end, not the count, says how many there are.
    expect(screen.getByText("31–40 / 40")).toBeTruthy();
  });

  test("rows that left between reads leave no empty last page behind", async () => {
    // The cursor promised a second page, but its rows were gone by then.
    const firstPage = sessionPages(16);
    const { history } = renderAt("/sessions?page=2", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.has("cursor")
          ? json(200, { items: [], next_cursor: null })
          : firstPage(request),
    });
    await waitFor(() => expect(history.location.search).toBe(""));
    await screen.findByRole("link", { name: opener("세션 15") });
    expect(listedTitles()).toHaveLength(15);
    expect(
      screen.queryByRole("navigation", { name: "페이지 이동" }),
    ).toBeNull();
  });

  test("with no count, the list's last page says where a page past the end lands", async () => {
    const { history } = renderAt("/sessions?page=5", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(20),
    });
    await screen.findByRole("link", { name: opener("세션 16") });
    await waitFor(() => expect(history.location.search).toBe("?page=2"));
    expect(screen.getByText("16–20 / 20")).toBeTruthy();
  });

  test("a new status, relation or search opens on the first page", async () => {
    const user = await setupUser();
    const { history } = renderAt("/sessions?page=2", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": sessionPages(20),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(20)),
    });
    await screen.findByRole("link", { name: opener("세션 16") });
    await user.click(
      within(screen.getByRole("group", { name: "상태로 보기" })).getByRole(
        "button",
        { name: /^작업 중/ },
      ),
    );
    await screen.findByRole("link", { name: opener("세션 1") });
    expect(history.location.search).toBe("?status=running");

    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: opener("세션 16") });
    expect(history.location.search).toBe("?status=running&page=2");
    await pickRelation(user, "내가 시작");
    await waitFor(() =>
      expect(history.location.search).toBe("?status=running&relation=started"),
    );
    await screen.findByRole("link", { name: opener("세션 1") });

    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: opener("세션 16") });
    await user.type(
      screen.getByRole("searchbox", { name: "제목이나 ID로 찾기" }),
      "세션 2",
    );
    await waitFor(() =>
      expect(history.location.search).toBe("?status=running&relation=started"),
    );
    // "세션 2" and "세션 20": one page, so no page links.
    await waitFor(() => expect(listedTitles()).toEqual(["세션 2", "세션 20"]));
    expect(
      screen.queryByRole("navigation", { name: "페이지 이동" }),
    ).toBeNull();
  });

  test("a next page that failed is asked for again by the retry button", async () => {
    const user = await setupUser();
    let nextCalls = 0;
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("cursor") === "next-1"
          ? ++nextCalls === 1
            ? apiError(503, "BACKEND_UNAVAILABLE", "down")
            : json(200, { items: [summary(OTHER_ID)], next_cursor: null })
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: "next-1",
            }),
    });

    await user.click(
      await screen.findByRole("button", { name: "다음 페이지" }),
    );
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("link", { name: opener(SESSION_ID) })).toBeNull();
    expect(nextCalls).toBe(2);
  });

  test("a next page refused for access says so under the rows, with no retry", async () => {
    const user = await setupUser();
    const renderedAt = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("cursor") === "next-1"
          ? apiError(403, "FORBIDDEN", "not allowed")
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: "next-1",
            }),
    });

    const { history } = renderedAt;
    await user.click(
      await screen.findByRole("button", { name: "다음 페이지" }),
    );
    await screen.findByText("이 화면을 볼 권한이 없습니다");
    // The rows read stay, on the page they belong to.
    expect(screen.getByRole("link", { name: opener(SESSION_ID) })).toBeTruthy();
    await waitFor(() => expect(history.location.search).toBe(""));
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  test("the retry asks for the page that failed, even after moving back from it", async () => {
    const user = await setupUser();
    const pages = sessionPages(40);
    let failing = true;
    const { history } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        failing && new URL(request.url).searchParams.get("cursor") === "c30"
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : pages(request),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(40)),
    });
    await screen.findByRole("link", { name: opener("세션 1") });
    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: opener("세션 16") });
    await user.click(screen.getByRole("button", { name: "3페이지" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(history.location.search).toBe("?page=2"));
    await user.click(screen.getByRole("button", { name: "1페이지" }));
    await screen.findByRole("link", { name: opener("세션 1") });
    failing = false;
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("link", { name: opener("세션 31") });
    expect(history.location.search).toBe("?page=3");
  });

  test("a failed next page keeps the rows, and retry pressed again while asking asks once", async () => {
    const user = await setupUser();
    let release = () => {};
    let nextCalls = 0;
    const { api, history } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": async (request) => {
        if (new URL(request.url).searchParams.get("cursor") !== "next-1") {
          return json(200, {
            items: [summary(SESSION_ID, { status: "idle" })],
            next_cursor: "next-1",
          });
        }
        if (++nextCalls === 1) {
          return apiError(503, "BACKEND_UNAVAILABLE", "down");
        }
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return json(200, { items: [summary(OTHER_ID)], next_cursor: null });
      },
    });

    await user.click(
      await screen.findByRole("button", { name: "다음 페이지" }),
    );
    const alert = await screen.findByRole("alert");
    // The rows already read stay above the failure, on their own page.
    expect(screen.getByRole("link", { name: opener(SESSION_ID) })).toBeTruthy();
    await waitFor(() => expect(history.location.search).toBe(""));
    const retry = within(alert).getByRole("button", { name: "다시 시도" });
    await user.click(retry);
    await waitFor(() =>
      expect(retry.getAttribute("aria-disabled")).toBe("true"),
    );
    await user.click(retry);
    await user.click(retry);
    release();
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    // The retry goes on to the page that failed.
    expect(history.location.search).toBe("?page=2");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      api.calls.filter((call) => call.search === "?cursor=next-1&limit=15"),
    ).toHaveLength(2);
  });

  test("from the keyboard 다음 페이지 keeps the focus, asks once, and stays at the last page", async () => {
    const user = await setupUser();
    let release = () => {};
    let failing = true;
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": async (request) => {
        if (new URL(request.url).searchParams.get("cursor") !== "next-1") {
          return json(200, {
            items: [summary(SESSION_ID, { status: "idle" })],
            next_cursor: "next-1",
          });
        }
        if (failing) return apiError(503, "BACKEND_UNAVAILABLE", "down");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return json(200, { items: [summary(OTHER_ID)], next_cursor: null });
      },
    });

    const next = await screen.findByRole("button", { name: "다음 페이지" });
    await act(async () => next.focus());
    await user.keyboard("{Enter}");
    await screen.findByRole("alert");
    // A failed page keeps 다음 페이지, and the keyboard on it.
    expect(screen.getByRole("button", { name: "다음 페이지" }) === next).toBe(
      true,
    );
    expect(document.activeElement === next).toBe(true);

    // Pressed again, it asks for the page that failed.
    failing = false;
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: opener(SESSION_ID) })
          .closest("[aria-busy=true]"),
      ).not.toBeNull(),
    );
    expect(document.activeElement === next).toBe(true);
    await user.keyboard("{Enter}");
    release();
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    // The list ends on the second page: the third pressed meanwhile lands there.
    await waitFor(() =>
      expect(next.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(document.activeElement === next).toBe(true);
    expect(
      api.calls.filter((call) => call.search === "?cursor=next-1&limit=15"),
    ).toHaveLength(2);
  });

  test("a refresh that failed under a shown list is retried as a refresh", async () => {
    const user = await setupUser();
    let down = false;
    const { api, services } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        down
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: null,
            }),
    });
    const listReads = () =>
      api.calls.filter((call) => call.search === "?limit=15").length;

    await screen.findByRole("link", { name: opener(SESSION_ID) });
    down = true;
    await services.queryClient.invalidateQueries({ queryKey: keys.sessions });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    // The rows read before stay under the failure.
    expect(screen.getByRole("link", { name: opener(SESSION_ID) })).toBeTruthy();
    down = false;
    const before = listReads();
    await user.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull(),
    );
    // The first page again, never a cursor past it.
    expect(listReads()).toBe(before + 1);
    expect(api.calls.some((call) => call.search.includes("cursor"))).toBe(
      false,
    );
  });

  test("in en the list speaks English", async () => {
    renderAt(
      "/sessions",
      {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/sessions": () =>
          json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      },
      "en",
    );
    const link = await screen.findByRole("link", {
      name: `Open session: ${SESSION_ID}`,
    });
    const row = link.closest('[role="row"]') as HTMLElement;
    expect(screen.getByRole("table", { name: "Sessions table" })).toBeTruthy();
    expect(within(row).getByText("Working")).toBeTruthy();
    expect(within(row).getByText("In progress")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Find by title or ID" }));
    expect(screen.queryByText(/세션/)).toBeNull();
    expect(
      screen.getAllByRole("columnheader").map((head) => head.textContent),
    ).toEqual(["Title", "Agent", "Channel", "Status", "Started", "Duration"]);
    // The start reads without its year; hovering it says how long ago.
    const time = row.querySelector("time") as HTMLElement;
    expect(time.textContent).toMatch(/^Oct \d+, \d+:\d\d [AP]M$/);
    expect(
      document.getElementById(time.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBeTruthy();
  });

  test("a row's link opens the session inside the app", async () => {
    const user = await setupUser();
    const { history } = renderAt("/sessions", {
      ...detailRoutes,
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    await user.click(
      await screen.findByRole("link", { name: opener(SESSION_ID) }),
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
    expect(await screen.findByText("권한 요청: Bash")).toBeTruthy();
  });

  test("a titled session shows its title over the id's head", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, {
          items: [
            summary(SESSION_ID, { title: "hello.txt 만들고 commit" }),
            summary(OTHER_ID, { repository_id: null, runtime: null }),
          ],
          next_cursor: null,
        }),
    });
    const titled = await screen.findByRole("link", {
      name: opener("hello.txt 만들고 commit"),
    });
    const row = titled.closest('[role="row"]') as HTMLElement;
    expect(within(row).getByText(SESSION_ID.slice(0, 8))).toBeTruthy();
    const untitled = screen.getByRole("link", { name: opener(OTHER_ID) });
    const bare = untitled.closest('[role="row"]') as HTMLElement;
    // No agent and no channel in the summary: what is known, not guesses.
    expect(within(bare).getByText("에이전트 없음")).toBeTruthy();
    expect(within(bare).getAllByText("—")).toHaveLength(1);
  });

  test("a row shows its agent and its channel, not who started it", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, {
          items: [
            summary(SESSION_ID, {
              title: "배포 점검",
              agent: {
                id: OTHER_ID,
                name: "Release helper",
                release_version_no: 2,
                release_label: "2026-10-30_14:30:28",
                release_is_active: true,
                archived: false,
              },
              created_by: { user_id: OTHER_ID, display_name: "김하나" },
              channel: "slack",
            }),
          ],
          next_cursor: null,
        }),
    });
    const link = await screen.findByRole("link", {
      name: "세션 열기: 배포 점검",
    });
    const table = screen.getByRole("table", { name: "세션 표" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["제목", "에이전트", "채널", "상태", "시작 시각", "소요 시간"]);
    const row = link.closest('[role="row"]') as HTMLElement;
    const cells = within(row).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual([
      expect.stringContaining("배포 점검"),
      "Release helper",
      "",
      "작업 상태: 작업 중",
      // The absolute time, then its relative hover text.
      expect.stringMatching(/^\d+월 \d+일 오[전후] \d\d:\d\d./),
      "진행 중",
    ]);
    expect(
      within(cells[2] as HTMLElement).getByRole("img", { name: "Slack" }),
    ).toBeTruthy();
    expect(row.textContent).not.toContain("김하나");
  });

  test("the search box asks the API with the trimmed text, and an empty box sends none", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) => {
        const q = new URL(request.url).searchParams.get("q");
        const items = [
          summary(SESSION_ID, { title: "README 정리" }),
          summary(OTHER_ID, { title: "api6.txt 쓰고 push" }),
        ].filter(
          (item) => q === null || (item.title ?? "").toLowerCase().includes(q),
        );
        return json(200, { items, next_cursor: null });
      },
    });
    const search = await screen.findByRole("searchbox", {
      name: "제목이나 ID로 찾기",
    });
    await screen.findByRole("link", { name: "세션 열기: README 정리" });
    expect(screen.getByText("2개 표시")).toBeTruthy();
    expect((search as HTMLInputElement).maxLength).toBe(200);

    await user.type(search, "  readme ");
    expect(await screen.findByText("1개 표시")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "세션 열기: api6.txt 쓰고 push" }),
    ).toBeNull();
    const reads = api.calls.filter((call) => call.path === "/v1/sessions");
    expect(reads.map((call) => call.search)).toContain("?q=readme&limit=15");
    // Only the settled text goes out, not each keystroke.
    expect(
      reads
        .filter((call) => call.search.startsWith("?q="))
        .map((c) => c.search),
    ).toEqual(["?q=readme&limit=15"]);
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/sessions/counts" && call.search === "?q=readme",
      ),
    ).toBe(true);

    await user.clear(search);
    await user.type(search, "   ");
    await screen.findByRole("link", { name: "세션 열기: api6.txt 쓰고 push" });
    // Spaces alone are no search: the API would refuse an empty q.
    expect(api.calls.some((call) => /[?&]q=(&|$)/.test(call.search))).toBe(
      false,
    );

    await user.clear(search);
    await user.type(search, "없는 세션");
    expect(await screen.findByText("조건에 맞는 세션이 없습니다")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "필터 지우기" }));
    expect((search as HTMLInputElement).value).toBe("");
    expect(document.activeElement === search).toBe(true);
    expect(
      await screen.findByRole("link", { name: "세션 열기: README 정리" }),
    ).toBeTruthy();
  });

  test("a search emptied and typed again within the pause never reads the old term", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    const search = await screen.findByRole("searchbox", {
      name: "제목이나 ID로 찾기",
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    await user.type(search, "alpha");
    await waitFor(() =>
      expect(api.calls.some((call) => call.search === "?q=alpha")).toBe(true),
    );
    const before = api.calls.length;
    await user.clear(search);
    await user.type(search, "beta");
    await waitFor(() =>
      expect(api.calls.some((call) => call.search === "?q=beta")).toBe(true),
    );
    expect(
      api.calls.slice(before).filter((call) => call.search.includes("alpha")),
    ).toEqual([]);
  });

  test("a new relation keeps the last rows, marked busy, until its own answer replaces them", async () => {
    const user = await setupUser();
    let answer: (() => void) | undefined;
    renderAt("/sessions?relation=shared", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("relation") === "administered"
          ? new Promise<Response>((resolve) => {
              answer = () =>
                resolve(
                  json(200, {
                    items: [summary(SESSION_ID)],
                    next_cursor: null,
                  }),
                );
            })
          : json(200, { items: [summary(OTHER_ID)], next_cursor: null }),
    });
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    await pickRelation(user, "관리하는 에이전트");
    await waitFor(() => expect(answer).toBeDefined());
    const kept = screen.getByRole("link", { name: opener(OTHER_ID) });
    expect(kept.closest("[aria-busy=true]")).not.toBeNull();
    expect(screen.queryByText(/불러오는 중/)).toBeNull();
    act(() => answer?.());
    const fresh = await screen.findByRole("link", {
      name: opener(SESSION_ID),
    });
    expect(screen.queryByRole("link", { name: opener(OTHER_ID) })).toBeNull();
    expect(fresh.closest("[aria-busy=true]")).toBeNull();
  });

  test("a new status tab keeps the last rows on screen while it reads, with no loading in between", async () => {
    const user = await setupUser();
    let answer: (() => void) | undefined;
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("status") === "failed"
          ? new Promise<Response>((resolve) => {
              answer = () =>
                resolve(
                  json(200, {
                    items: [summary(OTHER_ID, { status: "failed" })],
                    next_cursor: null,
                  }),
                );
            })
          : json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    await user.click(screen.getByRole("button", { name: "실패" }));
    await waitFor(() => expect(answer).toBeDefined());
    expect(
      screen
        .getByRole("link", { name: opener(SESSION_ID) })
        .closest("[aria-busy=true]"),
    ).not.toBeNull();
    expect(screen.queryByText(/불러오는 중/)).toBeNull();
    act(() => answer?.());
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("link", { name: opener(SESSION_ID) })).toBeNull();
  });

  test("a new tab after more pages reads its own first page, never the last tab's cursor, and offers no more meanwhile", async () => {
    const user = await setupUser();
    let answer: (() => void) | undefined;
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) => {
        const params = new URL(request.url).searchParams;
        if (params.get("status") === "failed") {
          return new Promise<Response>((resolve) => {
            answer = () =>
              resolve(
                json(200, {
                  items: [summary(OTHER_ID, { status: "failed" })],
                  next_cursor: null,
                }),
              );
          });
        }
        return params.get("cursor") === "next-1"
          ? json(200, { items: [summary(THIRD_ID)], next_cursor: "next-2" })
          : json(200, { items: [summary(SESSION_ID)], next_cursor: "next-1" });
      },
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    await user.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("link", { name: opener(THIRD_ID) });

    await user.click(screen.getByRole("button", { name: "실패" }));
    await waitFor(() => expect(answer).toBeDefined());
    // The new tab opens on page 1: meanwhile the last tab's first page shows.
    expect(screen.getByRole("link", { name: opener(SESSION_ID) })).toBeTruthy();
    expect(
      screen.queryByRole("navigation", { name: "페이지 이동" }),
    ).toBeNull();
    act(() => answer?.());
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    const failedReads = api.calls.filter((call) =>
      call.search.includes("status=failed"),
    );
    expect(failedReads.map((call) => call.search)).toEqual([
      "?status=failed&limit=15",
    ]);
    expect(api.calls.filter((call) => call.search.includes("next-2"))).toEqual(
      [],
    );
  });

  test("a new tab that fails says so instead of leaving the last tab's rows as its answer", async () => {
    const user = await setupUser();
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("status") === "failed"
          ? apiError(503, "UNAVAILABLE", "down")
          : json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    await user.click(screen.getByRole("button", { name: "실패" }));
    await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.queryByRole("link", { name: opener(SESSION_ID) })).toBeNull();
  });

  test("the relation filter reads that relation, keeps it in the address and with the status tab", async () => {
    const user = await setupUser();
    const { api, history } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) => {
        const params = new URL(request.url).searchParams;
        if (params.get("relation") !== "shared") {
          return json(200, { items: [summary(SESSION_ID)], next_cursor: null });
        }
        // The one shared session is running, so none of them failed.
        const items = params.get("status") ? [] : [summary(OTHER_ID)];
        return json(200, { items, next_cursor: null });
      },
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    const menu = await relationChoices(user);
    expect(within(menu).getAllByRole("button").map(choiceLabel)).toEqual([
      "모든 관계",
      "내가 시작",
      "공유받음",
      "관리하는 에이전트",
    ]);

    await user.click(within(menu).getByRole("button", { name: /^공유받음/ }));
    await user.keyboard("{Escape}");
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(
      screen.getByRole("button", { name: "필터 1개 적용" }).dataset.filtered,
    ).toBe("");
    const chips = screen.getByRole("group", { name: "적용한 필터" });
    expect(within(chips).getByRole("listitem").textContent).toBe(
      "관계 공유받음",
    );
    expect(history.location.search).toContain("relation=shared");
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/sessions" &&
          call.search === "?relation=shared&limit=15",
      ),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "실패" }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.path === "/v1/sessions" &&
            call.search === "?status=failed&relation=shared&limit=15",
        ),
      ).toBe(true),
    );
    expect(history.location.search).toContain("relation=shared");
    expect(history.location.search).toContain("status=failed");
    // Nothing failed among the shared ones: a filter emptied the list.
    expect(await screen.findByText("조건에 맞는 세션이 없습니다")).toBeTruthy();
  });

  test("the status tabs carry the counts the API reads for the same relation and search", async () => {
    renderAt("/sessions?relation=started", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      "GET /v1/sessions/counts": (request) =>
        new URL(request.url).searchParams.get("relation") === "started"
          ? json(200, {
              counts: {
                queued: 1,
                running: 2,
                needs_input: 3,
                idle: 4,
                failed: 0,
                stopped: 5,
                cut_off: 1,
              },
              total: 15,
            })
          : apiError(400, "INVALID_REQUEST", "wrong relation"),
    });
    const tabs = await screen.findByRole("group", { name: "상태로 보기" });
    // Seven counted tabs do not fit a phone: one line that scrolls sideways.
    expect((tabs.parentElement as HTMLElement).dataset.slot).toBe(
      "segmented-control-scroll",
    );
    await waitFor(() =>
      expect(
        within(tabs)
          .getAllByRole("button")
          .map((tab) => tab.textContent),
      ).toEqual([
        "전체 15",
        "답변 대기 3",
        "작업 중 2",
        "쉬는 중 3",
        "중단됨 1",
        "멈춤 5",
        "실패 0",
      ]),
    );
    // Only the states someone has to act on turn into a badge, and only
    // above 0: three waiting answers and one cut-off session do, no failures
    // and the rest do not.
    expect(
      within(tabs)
        .getAllByRole("button")
        .map(
          (tab) =>
            tab.querySelector<HTMLElement>('[data-slot="item-count"]')?.dataset
              .tone ?? null,
        ),
    ).toEqual([null, "attention", null, null, "danger", null, null]);
  });

  test("counts that failed leave the tabs without numbers", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      "GET /v1/sessions/counts": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "down"),
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    const tabs = screen.getByRole("group", { name: "상태로 보기" });
    expect(
      within(tabs)
        .getAllByRole("button")
        .map((tab) => tab.textContent),
    ).toEqual([
      "전체",
      "답변 대기",
      "작업 중",
      "쉬는 중",
      "중단됨",
      "멈춤",
      "실패",
    ]);
  });

  test("a waiting row says how long its oldest request has waited", async () => {
    const asked = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString();
    const later = new Date(Date.now() - 3 * 60_000).toISOString();
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, {
          items: [summary(SESSION_ID, { status: "needs_input" })],
          next_cursor: null,
        }),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          // Newest first, so taking the first item would read 3분.
          items: [
            {
              kind: "question",
              request_id: "req-2",
              turn_id: "1",
              attempt_id: "1",
              created_at: later,
              expires_at: LATER,
              questions: [
                {
                  question_id: "q1",
                  prompt: "어느 쪽?",
                  options: [],
                  multi_select: false,
                  allow_free_text: true,
                },
              ],
            },
            {
              kind: "question",
              request_id: "req-1",
              turn_id: "1",
              attempt_id: "1",
              created_at: asked,
              expires_at: LATER,
              questions: [
                {
                  question_id: "q1",
                  prompt: "어느 쪽?",
                  options: [],
                  multi_select: false,
                  allow_free_text: true,
                },
              ],
            },
          ],
          answerable: true,
        } satisfies ListPendingRequestsResponse),
    });
    const table = await screen.findByRole("table", { name: "세션 표" });
    await waitFor(() =>
      expect(table.textContent).toContain("작업 상태: 답변 대기12분"),
    );
  });

  test("a wait of an hour or more reads in hours, as on home", async () => {
    const asked = new Date(Date.now() - 120 * 60_000 - 5_000).toISOString();
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, {
          items: [summary(SESSION_ID, { status: "needs_input" })],
          next_cursor: null,
        }),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          items: [
            {
              kind: "question",
              request_id: "req-1",
              turn_id: "1",
              attempt_id: "1",
              created_at: asked,
              expires_at: LATER,
              questions: [
                {
                  question_id: "q1",
                  prompt: "어느 쪽?",
                  options: [],
                  multi_select: false,
                  allow_free_text: true,
                },
              ],
            },
          ],
          answerable: true,
        } satisfies ListPendingRequestsResponse),
    });
    const table = await screen.findByRole("table", { name: "세션 표" });
    await waitFor(() =>
      expect(table.textContent).toContain("작업 상태: 답변 대기2시간"),
    );
  });

  test("says so when there are none", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    expect(await screen.findByText("아직 세션이 없습니다.")).toBeTruthy();
  });

  test("a status tab reads only that status and keeps it in the address", async () => {
    const user = await setupUser();
    const { api, history } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) => {
        const status = new URL(request.url).searchParams.get("status");
        if (status === "failed") {
          return json(200, {
            items: [summary(OTHER_ID, { status: "failed" })],
            next_cursor: null,
          });
        }
        if (status === null) {
          return json(200, { items: [summary(SESSION_ID)], next_cursor: null });
        }
        return json(200, { items: [], next_cursor: null });
      },
    });

    const tabs = await screen.findByRole("group", { name: "상태로 보기" });
    expect(
      within(tabs)
        .getAllByRole("button")
        .map((tab) => tab.textContent),
    ).toEqual([
      "전체",
      "답변 대기",
      "작업 중",
      "쉬는 중",
      "중단됨",
      "멈춤",
      "실패",
    ]);
    expect(
      within(tabs)
        .getByRole("button", { name: "전체" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await screen.findByRole("link", { name: opener(SESSION_ID) });

    await user.click(within(tabs).getByRole("button", { name: "실패" }));
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("link", { name: opener(SESSION_ID) })).toBeNull();
    expect(history.location.search).toContain("status=failed");
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/sessions" &&
          call.search === "?status=failed&limit=15",
      ),
    ).toBe(true);

    await user.click(within(tabs).getByRole("button", { name: "멈춤" }));
    expect(await screen.findByText("이 상태의 세션이 없습니다.")).toBeTruthy();

    await user.click(within(tabs).getByRole("button", { name: "전체" }));
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    expect(history.location.search).not.toContain("status=");
  });

  test("every refresh of the full list reaches the status tab, not just the first", async () => {
    const user = await setupUser();
    const { api, services } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("status") === "failed"
          ? json(200, {
              items: [summary(OTHER_ID, { status: "failed" })],
              next_cursor: null,
            })
          : json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    // The full list stays cached, unmounted, behind the status tab.
    await user.click(screen.getByRole("button", { name: "실패" }));
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    const failedReads = () =>
      api.calls.filter((call) => call.search === "?status=failed&limit=15")
        .length;
    await waitFor(() => expect(failedReads()).toBe(1));
    // As the session hooks refresh: the full list and the waiting page, each
    // by its exact key. The screen never reads the full list's own key.
    for (const expected of [2, 3]) {
      await act(async () => {
        await services.queryClient.invalidateQueries({
          queryKey: keys.sessions,
          exact: true,
        });
        await services.queryClient.invalidateQueries({
          queryKey: keys.waitingSessions,
          exact: true,
        });
      });
      await waitFor(() => expect(failedReads()).toBe(expected));
    }
  });

  test("an address with a status opens on that tab", async () => {
    renderAt("/sessions?status=idle", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("status") === "idle"
          ? json(200, {
              items: [summary(OTHER_ID, { status: "idle" })],
              next_cursor: null,
            })
          : json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    const tab = await screen.findByRole("button", { name: "쉬는 중" });
    expect(tab.getAttribute("aria-pressed")).toBe("true");
    await screen.findByRole("link", { name: opener(OTHER_ID) });
  });

  test("the cut-off tab lists the idle sessions a lost lease cut off, the idle tab the rest, each with its count", async () => {
    const user = await setupUser();
    const { api, history } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) => {
        const query = new URL(request.url).searchParams;
        const cutOff = summary(OTHER_ID, {
          status: "idle",
          last_turn_cut_off: true,
        });
        const rested = summary(SESSION_ID, { status: "idle" });
        const items =
          query.get("last_turn_cut_off") === "true"
            ? [cutOff]
            : query.get("last_turn_cut_off") === "false"
              ? [rested]
              : [cutOff, rested];
        return json(200, { items, next_cursor: null });
      },
      "GET /v1/sessions/counts": () =>
        json(200, {
          counts: {
            queued: 0,
            running: 0,
            needs_input: 0,
            idle: 2,
            failed: 0,
            stopped: 0,
            cut_off: 1,
          },
          total: 2,
        }),
    });
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    const count = (name: string) =>
      screen
        .getByRole("button", { name: new RegExp(`^${name}`) })
        .querySelector("[data-slot=item-count]")?.textContent;
    await waitFor(() => expect(count("중단됨")).toBe("1"));
    // counts.idle holds the cut-off one too; the idle tab shows the rest.
    expect(count("쉬는 중")).toBe("1");

    await user.click(screen.getByRole("button", { name: /^중단됨/ }));
    await waitFor(() =>
      expect(history.location.search).toBe("?status=cut_off"),
    );
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("link", { name: opener(SESSION_ID) })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^쉬는 중/ }));
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    expect(screen.queryByRole("link", { name: opener(OTHER_ID) })).toBeNull();
    const reads = api.calls
      .filter((call) => call.path === "/v1/sessions")
      .map((call) => call.search);
    expect(reads).toContain("?status=idle&last_turn_cut_off=true&limit=15");
    expect(reads).toContain("?status=idle&last_turn_cut_off=false&limit=15");
  });

  test("a server older than cut_off gets no cut-off tab, and its idle tab counts every idle session", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      "GET /v1/sessions/counts": () =>
        json(200, {
          counts: {
            queued: 0,
            running: 1,
            needs_input: 0,
            idle: 2,
            failed: 0,
            stopped: 0,
          },
          total: 3,
        }),
    });
    const tabs = await screen.findByRole("group", { name: "상태로 보기" });
    await waitFor(() =>
      expect(
        within(tabs)
          .getAllByRole("button")
          .map((tab) => tab.textContent),
      ).toEqual([
        "전체 3",
        "답변 대기 0",
        "작업 중 1",
        "쉬는 중 2",
        "멈춤 0",
        "실패 0",
      ]),
    );
  });

  test("a row whose idle session a lost lease cut off reads 중단됨, and only while idle", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, {
          items: [
            summary(OTHER_ID, { status: "idle", last_turn_cut_off: true }),
            // Running again on its next input: the flag no longer shows.
            summary(SESSION_ID, { status: "running", last_turn_cut_off: true }),
          ],
          next_cursor: null,
        }),
    });
    const cutOff = await screen.findByRole("link", { name: opener(OTHER_ID) });
    const row = (link: HTMLElement) =>
      link.closest<HTMLElement>("[data-slot=session-overview-row]");
    expect(row(cutOff)?.textContent).toContain("중단됨");
    const running = screen.getByRole("link", { name: opener(SESSION_ID) });
    expect(row(running)?.textContent).not.toContain("중단됨");
    expect(row(running)?.textContent).toContain("작업 중");
  });

  test("an unknown status in the address opens every session", async () => {
    renderAt("/sessions?status=bogus", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    const tab = await screen.findByRole("button", { name: "전체" });
    expect(tab.getAttribute("aria-pressed")).toBe("true");
    await screen.findByRole("link", { name: opener(SESSION_ID) });
  });

  test("offers no new session button, which the web cannot start yet", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    await screen.findByText("아직 세션이 없습니다.");
    expect(screen.queryByRole("button", { name: "새 세션" })).toBeNull();
    expect(
      screen.queryByText(
        "웹에서는 아직 세션을 시작할 수 없습니다. API로 시작하세요.",
      ),
    ).toBeNull();
  });

  test("the counts are read once per relation and search, not per tab", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    const counts = () =>
      api.calls.filter((call) => call.path === "/v1/sessions/counts");
    await waitFor(() => expect(counts()).toHaveLength(1));
    for (const tab of ["실패", "쉬는 중", "전체"]) {
      await user.click(screen.getByRole("button", { name: tab }));
    }
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    expect(counts()).toHaveLength(1);
    // The other relations are counted once each, and only once the filters
    // open; the relation picked is the tabs' own read.
    await relationChoices(user);
    await waitFor(() => expect(counts()).toHaveLength(4));
    expect(counts().map((call) => call.search)).toEqual([
      "",
      "?relation=started",
      "?relation=shared",
      "?relation=administered",
    ]);
    await user.keyboard("{Escape}");
    for (const tab of ["실패", "전체"]) {
      await user.click(screen.getByRole("button", { name: tab }));
    }
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    expect(counts()).toHaveLength(4);
  });

  test("each filter value carries the count the API reads for it, with the tab and search kept", async () => {
    const user = await setupUser();
    const byRelation: Record<string, number> = {
      "": 9,
      started: 4,
      shared: 2,
      administered: 0,
    };
    const { api } = renderAt("/sessions?status=failed", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      "GET /v1/sessions/counts": (request) => {
        const relation =
          new URL(request.url).searchParams.get("relation") ?? "";
        const failed = byRelation[relation] ?? 0;
        return json(200, {
          counts: {
            queued: 0,
            running: 1,
            needs_input: 0,
            idle: 0,
            failed,
            stopped: 0,
            cut_off: 0,
          },
          total: failed + 1,
        });
      },
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    await user.type(
      screen.getByRole("searchbox", { name: "제목이나 ID로 찾기" }),
      "deploy",
    );
    const list = await relationChoices(user);
    // The failed tab is picked, so each relation counts its failed sessions.
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("button")
          .map(
            (choice) => choice.getAttribute("aria-label") ?? choice.textContent,
          ),
      ).toEqual([
        "모든 관계 99개",
        "내가 시작 44개",
        "공유받음 22개",
        "관리하는 에이전트 00개",
      ]),
    );
    // Every count was read with the search: the server counts only what the
    // caller can read, under the list's own rules.
    const searched = () =>
      new Set(
        api.calls
          .filter((call) => call.path === "/v1/sessions/counts")
          .map((call) => new URLSearchParams(call.search))
          .filter((params) => params.get("q") === "deploy")
          .map((params) => params.get("relation")),
      );
    await waitFor(() =>
      expect(searched()).toEqual(
        new Set([null, "started", "shared", "administered"]),
      ),
    );
    const panel = screen.getByRole("dialog", { name: "필터" });
    const status = within(panel).getByRole("list", { name: "상태" });
    expect(
      within(status)
        .getByRole("button", { name: "실패 9개" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("a new search keeps each relation's last count until its own arrives", async () => {
    const user = await setupUser();
    let release: (() => void) | undefined;
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      "GET /v1/sessions/counts": (request) => {
        const answer = json(200, sessionCounts(3));
        // Counts for the search wait until the test lets them go.
        if (!new URL(request.url).searchParams.has("q")) return answer;
        return new Promise<Response>((resolve) => {
          release = () => resolve(json(200, sessionCounts(1)));
        });
      },
    });
    await screen.findByRole("link", { name: opener(SESSION_ID) });
    const list = await relationChoices(user);
    const shown = () =>
      within(list)
        .getAllByRole("button")
        .map((choice) => choice.textContent);
    await waitFor(() =>
      expect(shown()).toEqual([
        "모든 관계 33개",
        "내가 시작 33개",
        "공유받음 33개",
        "관리하는 에이전트 33개",
      ]),
    );
    const search = screen.getByRole("searchbox", {
      name: "제목이나 ID로 찾기",
    });
    await user.type(search, "x");
    await waitFor(() => expect(release).toBeDefined());
    expect(shown()).toEqual([
      "모든 관계 33개",
      "내가 시작 33개",
      "공유받음 33개",
      "관리하는 에이전트 33개",
    ]);
    act(() => release?.());
  });

  test("a chip's × clears that filter alone, and remove all clears them all", async () => {
    const user = await setupUser();
    const { history } = renderAt("/sessions?status=failed&relation=shared", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    const chips = await screen.findByRole("group", { name: "적용한 필터" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["상태 실패", "관계 공유받음"]);
    await user.click(
      within(chips).getByRole("button", {
        name: "관계 필터 빼기: 공유받음",
      }),
    );
    await waitFor(() => expect(history.location.search).toBe("?status=failed"));
    // Focus moves to the chip left, not to the page.
    const left = screen.getByRole("button", { name: "상태 필터 빼기: 실패" });
    await waitFor(() => expect(document.activeElement === left).toBe(true));
    expect(
      screen
        .getByRole("group", { name: "상태로 보기" })
        .querySelector("[aria-pressed=true]")?.textContent,
    ).toMatch(/^실패/);

    await user.click(screen.getByRole("button", { name: "모두 지우기" }));
    await waitFor(() => expect(history.location.search).toBe(""));
    expect(screen.queryByRole("group", { name: "적용한 필터" })).toBeNull();
    const button = screen.getByRole("button", { name: "필터" });
    await waitFor(() => expect(document.activeElement === button).toBe(true));
  });

  test("the summary line shows the total and cost alone, and follows the relation picked", async () => {
    const user = await setupUser();
    const all = { ...sessionCounts(2), total: 9, cost_usd: "12.5" };
    // Started by me: fewer of each, so the line follows the relation picked.
    const started = { ...sessionCounts(1), total: 4, cost_usd: "0.004" };
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      "GET /v1/sessions/counts": (request) =>
        json(
          200,
          new URL(request.url).searchParams.get("relation") === "started"
            ? started
            : all,
        ),
    });
    const line = await screen.findByRole("list", { name: "세션 요약" });
    await waitFor(() =>
      expect(
        within(line)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(["세션 9", "예상 비용 $12.50"]),
    );
    // Running and failed are the status tabs' job: nothing here presses.
    expect(within(line).queryByRole("button")).toBeNull();
    expect(within(line).queryByRole("link")).toBeNull();

    // The relation changes the figures, as it does the tabs.
    await pickRelation(user, "내가 시작");
    await waitFor(() =>
      expect(
        within(line)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(["세션 4", "예상 비용 <$0.01"]),
    );
  });

  test("a server older than the cost leaves the cost out instead of showing $0", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      "GET /v1/sessions/counts": () => json(200, sessionCounts(1)),
    });
    const line = await screen.findByRole("list", { name: "세션 요약" });
    expect(
      within(line)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["세션 1"]);
  });

  test("withSessionsFilter keeps the other filter, clears with null and drops the page", () => {
    expect(
      withSessionsFilter(
        { status: "failed", relation: "shared" },
        {
          relation: null,
        },
      ),
    ).toEqual({ status: "failed" });
    expect(
      withSessionsFilter({ relation: "started" }, { status: "running" }),
    ).toEqual({
      status: "running",
      relation: "started",
    });
    const paged: SessionsSearch = { status: "idle", page: 3 };
    expect(withSessionsFilter(paged, {})).toEqual({ status: "idle" });
  });

  test("the menu links to it", async () => {
    renderAt(
      "/",
      {
        "GET /v1/auth/me": () => json(200, memberMe()),
        "GET /v1/agents/administered": () =>
          json(200, { items: [], next_cursor: null }),
      },
      "en",
    );
    const nav = await screen.findByRole("navigation", { name: "Main menu" });
    const link = await waitFor(() => {
      const found = Array.from(nav.querySelectorAll("a")).find(
        (anchor) => anchor.textContent === "Sessions",
      );
      if (!found) throw new Error("no Sessions link");
      return found;
    });
    expect(link.getAttribute("href")).toBe("/sessions");
  });
});

describe("session detail", () => {
  test("a preview session says so beside its status", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, preview: true }),
    });
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() =>
      expect(
        heading.querySelector('[data-slot="badge"]')?.textContent ??
          heading.parentElement?.querySelector('[data-slot="badge"]')
            ?.textContent,
      ).toBe("미리보기"),
    );
  });

  test("a budget account's refusal says whose limit it is", async () => {
    const refused = {
      ...detail,
      attention: {
        code: "BUDGET_EXCEEDED",
        reason: "The requester's monthly budget account refused a model call",
        budget_owner: "user",
      },
    };
    const account =
      "요청한 사람의 이번 달 예산 한도에 닿아 모델을 부르지 못했습니다. 다음 달 1일(UTC)에 풀리며, 그 전에는 워크스페이스 관리자가 한도를 올리면 풀립니다.";
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, refused),
      [`GET /v1/sessions/${SESSION_ID}/usage`]: () =>
        json(200, { ...usage, budget_exceeded: false }),
    });
    expect(await screen.findByText(account)).toBeTruthy();
    expect(
      screen.queryByText("한도에 도달해 새 턴을 시작하지 않습니다."),
    ).toBeNull();
  });

  test("a session over its own limit keeps its words over an account's refusal", async () => {
    const refused = {
      ...detail,
      attention: {
        code: "BUDGET_EXCEEDED",
        reason: "The requester's monthly budget account refused a model call",
        budget_owner: "user",
      },
    };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, refused),
    });
    expect(
      await screen.findByText("한도에 도달해 새 턴을 시작하지 않습니다."),
    ).toBeTruthy();
    expect(screen.queryByText(/이번 달 예산 한도/)).toBeNull();
  });

  test("a session that is not a preview has no preview mark", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("미리보기")).toBeNull();
  });

  test("shows status, cost, pending requests and streamed events", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);

    expect(await screen.findByText("답변 대기")).toBeTruthy();
    // Why no new turn starts sits above the composer it holds back.
    expect(
      await screen.findByText("한도에 도달해 새 턴을 시작하지 않습니다."),
    ).toBeTruthy();
    const progress = await sessionProgress();
    await waitFor(() => expect(progress.textContent).toContain("<$0.01"));
    expect(progress.textContent).toContain("토큰 1,234");
    expect(
      await screen.findByRole("article", { name: "권한 요청: Bash" }),
    ).toBeTruthy();

    await waitFor(() => expect(stream.requests).toHaveLength(1));
    expect(stream.requests[0]?.headers.get("last-event-id")).toBeNull();
    expect(stream.requests[0]?.headers.get("x-requested-with")).toBe(
      "werft-web",
    );

    await act(async () => stream.open());
    act(() => {
      stream.emit("ev_1", "status", { phase: "running" });
      stream.emit("ev_2", "assistant", {
        type: "assistant",
        text: "Listing files",
      });
      stream.emit("ev_3", "tool_use", {
        type: "assistant",
        tool_call: { id: "tu_0", name: "Bash", input: {} },
      });
      // A resumed stream replays from Last-Event-ID; a frame seen once is
      // not drawn twice.
      stream.emit("ev_2", "assistant", {
        type: "assistant",
        text: "Listing files",
      });
    });
    expect(await screen.findByText("Listing files")).toBeTruthy();
    expect(screen.getAllByText("Listing files")).toHaveLength(1);
    // The agent's reply is its message; the call is one folded line.
    const reply = screen
      .getByText("Listing files")
      .closest("[data-slot='chat-message']");
    expect(reply?.getAttribute("data-side")).toBe("other");
    // The run of calls folds to one plain line; the list holds the names.
    const calls = screen
      .getByText("도구 호출 1개")
      .closest("[data-slot='chat-tool-group']");
    expect(calls?.textContent).toContain("Bash");
    expect(screen.queryByText("tool_use")).toBeNull();
    // The list itself is not live.
    const list = screen.getByRole("list", { name: "이벤트" });
    expect(list.getAttribute("aria-live")).toBeNull();

    // Engine bookkeeping is not part of the conversation.
    act(() =>
      stream.emit("ev_5", "system", {
        type: "system",
        engine_event: { name: "command_lifecycle", category: "internal" },
      }),
    );
    expect(screen.queryByText("command_lifecycle")).toBeNull();

    // The session reporting an error is an event, not a lost connection.
    act(() =>
      stream.emit("ev_4", "error", { message: "engine crashed", code: "X" }),
    );
    expect(await screen.findByText("engine crashed")).toBeTruthy();
    expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull();

    // A dropped connection resumes after the last event drawn, and what
    // arrives after it is drawn too.
    // A single drop says nothing: the stream is back before it would matter.
    act(() => stream.drop());
    await waitFor(() => expect(stream.requests).toHaveLength(2));
    expect(stream.requests.at(-1)?.headers.get("last-event-id")).toBe("ev_4");
    expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull();
    await act(async () => stream.open());
    act(() =>
      stream.emit("ev_6", "assistant", {
        type: "assistant",
        text: "Back again",
      }),
    );
    expect(await screen.findByText("Back again")).toBeTruthy();

    // Attempts that keep failing are announced from the third on, and the
    // notice goes once the stream opens again.
    act(() => stream.undecided());
    expect(
      await screen.findByText("이벤트 연결이 끊겼습니다. 다시 연결하는 중…"),
    ).toBeTruthy();
    expect(stream.requests.length).toBeGreaterThanOrEqual(6);
    const before = stream.requests.length;
    act(() => stream.recover());
    await waitFor(() => expect(stream.requests.length).toBeGreaterThan(before));
    await act(async () => stream.open());
    await waitFor(() =>
      expect(
        screen.queryByText("이벤트 연결이 끊겼습니다. 다시 연결하는 중…"),
      ).toBeNull(),
    );
    expect(stream.requests.at(-1)?.headers.get("last-event-id")).toBe("ev_6");

    // A refusal ends it; reconnecting by hand resumes after the last event
    // shown and keeps what is on screen.
    act(() => stream.fail());
    expect(await screen.findByText("이벤트 연결이 끊겼습니다.")).toBeTruthy();
    act(() => stream.recover());
    const ended = stream.requests.length;
    act(() => screen.getByRole("button", { name: "다시 연결" }).click());
    await waitFor(() => expect(stream.requests.length).toBe(ended + 1));
    expect(stream.requests.at(-1)?.headers.get("last-event-id")).toBe("ev_6");
    await act(async () => stream.open());
    act(() => {
      stream.emit("ev_6", "assistant", {
        type: "assistant",
        text: "Back again",
      });
      stream.emit("ev_7", "assistant", {
        type: "assistant",
        text: "Once more",
      });
    });
    expect(await screen.findByText("Once more")).toBeTruthy();
    expect(screen.getAllByText("Back again")).toHaveLength(1);
    expect(screen.queryByText("이벤트 연결이 끊겼습니다.")).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  });

  describe("a read that failed under the chat", () => {
    const PENDING_ROUTE = `GET /v1/sessions/${SESSION_ID}/pending-requests`;
    const failingPending = () => {
      const read = { down: true, count: 0 };
      const route = () => {
        read.count += 1;
        return read.down
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, pending);
      };
      return { read, route };
    };
    // Compared with null: bun serialises a DOM node a failing matcher holds.
    const hasRetry = () =>
      screen.queryByRole("button", { name: "다시 시도" }) !== null;

    test("is read again when the event stream reconnects, and its card goes", async () => {
      const { read, route } = failingPending();
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [PENDING_ROUTE]: route,
      });
      await screen.findByRole("button", { name: "다시 시도" });
      await waitFor(() => expect(stream.requests).toHaveLength(1));
      const before = read.count;
      await act(async () => stream.open());
      await waitFor(() => expect(read.count).toBe(before + 1));

      // The server answers again; the stream drops and opens again.
      read.down = false;
      act(() => stream.drop());
      await waitFor(() => expect(stream.requests).toHaveLength(2));
      await act(async () => stream.open());
      await screen.findByText("권한 요청: Bash");
      expect(hasRetry()).toBe(false);
      expect(read.count).toBe(before + 2);
    });

    test("keeps its card while it keeps failing, read once per reconnect", async () => {
      const { read, route } = failingPending();
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [PENDING_ROUTE]: route,
      });
      await screen.findByRole("button", { name: "다시 시도" });
      await waitFor(() => expect(stream.requests).toHaveLength(1));
      const before = read.count;
      await act(async () => stream.open());
      await waitFor(() => expect(read.count).toBe(before + 1));

      act(() => stream.drop());
      await waitFor(() => expect(stream.requests).toHaveLength(2));
      await act(async () => stream.open());
      await waitFor(() => expect(read.count).toBe(before + 2));
      // Nothing asks again on its own past the one read per reconnect.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(read.count).toBe(before + 2);
      expect(hasRetry()).toBe(true);
    });

    test("is read again when the session's status changes", async () => {
      const { read, route } = failingPending();
      let status = "needs_input";
      const { services } = renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}`]: () =>
          json(200, { ...detail, status }),
        [PENDING_ROUTE]: route,
      });
      await screen.findByRole("button", { name: "다시 시도" });

      read.down = false;
      status = "idle";
      const before = read.count;
      // Only the detail is read: no event says what else went stale.
      await act(() =>
        services.queryClient.refetchQueries({
          queryKey: keys.session(SESSION_ID),
          exact: true,
        }),
      );
      await screen.findByText("권한 요청: Bash");
      expect(hasRetry()).toBe(false);
      expect(read.count).toBe(before + 1);
    });
  });

  test("a tool call runs until its result arrives, then holds it in the same row", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() =>
      stream.emit("ev_call", "tool_use", {
        type: "assistant",
        tool_call: { id: "tu_1", name: "Bash", input: { command: "make" } },
      }),
    );
    // Folded to one line that says it still runs.
    const group = (await screen.findByText("도구 호출 1개")).closest(
      "[data-slot='chat-tool-group']",
    ) as HTMLDetailsElement;
    expect(group.querySelector("summary")?.textContent).toContain("실행 중");
    expect(group.open).toBe(false);
    const user = await setupUser();
    await user.click(within(group).getByText("도구 호출 1개"));
    expect(group.open).toBe(true);
    // Each call opens on its own to what it did.
    const row = group.querySelector(
      "[data-slot='chat-tool-item']",
    ) as HTMLElement;
    await user.click(within(row).getByText("Bash"));
    expect(row.textContent).toContain('"command": "make"');
    act(() =>
      stream.emit("ev_result", "tool_result", {
        tool_result: { tool_call_id: "tu_1", is_error: false, text: "built" },
      }),
    );
    expect(await within(row).findByText("built")).toBeTruthy();
    expect(row.textContent).not.toContain("실행 중");
    // The result joins its call's row instead of drawing one of its own.
    expect(
      document.querySelectorAll("[data-slot='chat-tool-item']"),
    ).toHaveLength(1);
  });

  test("in en a lone tool call reads in the singular", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes, "en");
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() =>
      stream.emit("ev_call", "tool_use", {
        type: "assistant",
        tool_call: { id: "tu_1", name: "Bash", input: {} },
      }),
    );
    expect(await screen.findByText("1 tool call")).toBeTruthy();
    act(() =>
      stream.emit("ev_call_2", "tool_use", {
        type: "assistant",
        tool_call: { id: "tu_2", name: "Read", input: {} },
      }),
    );
    expect(await screen.findByText("2 tool calls")).toBeTruthy();
  });

  test("each instruction is the person's message on the right, read again as turns start", async () => {
    const turn = (
      turn_id: string,
      message: string,
      channel: string | null = null,
      creator: string | null = null,
    ) => ({
      turn_id,
      session_id: SESSION_ID,
      status: "completed",
      message,
      channel,
      created_by: creator && { user_id: THIRD_ID, display_name: creator },
      slack_permalink: channel === "slack" ? SLACK_PERMALINK : null,
      terminal_reason: null,
      checkpoint_revision: null,
      created_at: AT,
      started_at: AT,
      ended_at: AT,
    });
    let turns = [turn("1", "첫 지시", "slack", "김민아")];
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, { items: turns, next_cursor: null }),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => {
      stream.emit("ev_a1", "assistant", {
        type: "assistant",
        text: "첫 답",
      });
    });
    // The step list names each instruction too; these are the chat's.
    const asked = async (text: string) =>
      (
        await within(screen.getByRole("list", { name: "이벤트" })).findByText(
          text,
        )
      ).closest("[data-slot='chat-message']");
    const first = await asked("첫 지시");
    expect(first?.getAttribute("data-side")).toBe("self");
    expect(first?.textContent).toContain("김민아");
    const fromSlack = within(first as HTMLElement).getByRole("link", {
      name: "Slack에서 보기 (새 탭에서 열림)",
    });
    expect(fromSlack.getAttribute("href")).toBe(SLACK_PERMALINK);
    expect(fromSlack.getAttribute("target")).toBe("_blank");
    // The instruction comes before the reply it asked for.
    const reply = await asked("첫 답");
    expect(
      (first as Node).compareDocumentPosition(reply as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // An absolute box (the link's new-tab text) placed from outside the
    // scrolling chat escapes its clip and stretches the page below the app
    // shell, so each one is positioned from within it.
    const list = screen.getByRole("list", { name: "이벤트" });
    const scroller = list.closest(".overflow-y-auto") as HTMLElement;
    const boxes = scroller.querySelectorAll(".sr-only, .absolute");
    expect(boxes.length).toBeGreaterThan(0);
    // Exact tokens: a breakpoint variant such as md:relative leaves 390px open.
    const positioned = (el: Element) =>
      ["relative", "absolute", "sticky", "fixed"].some((token) =>
        el.classList.contains(token),
      );
    for (const box of boxes) {
      let holder = box.parentElement;
      while (holder !== null && !positioned(holder))
        holder = holder.parentElement;
      expect(holder !== null && scroller.contains(holder)).toBe(true);
    }

    turns = [
      turn("1", "첫 지시", "slack", "김민아"),
      turn("2", "두 번째 지시", "api"),
    ];
    act(() => {
      stream.emit("ev_s2", "status", { phase: "running" }, "2");
      stream.emit(
        "ev_a2",
        "assistant",
        {
          type: "assistant",
          text: "두 번째 답",
        },
        "2",
      );
    });
    // An API key no person created has no name to show.
    const second = await asked("두 번째 지시");
    expect(second?.textContent).toContain("지시");
    expect(second?.querySelector("a")).toBeNull();
  });

  test("an empty message draws no bubble", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => {
      stream.emit("ev_empty", "assistant", { type: "assistant" });
      stream.emit("ev_said", "assistant", { type: "assistant", text: "hi" });
    });
    expect(await screen.findByText("hi")).toBeTruthy();
    expect(
      document.querySelectorAll("[data-slot='chat-message']"),
    ).toHaveLength(1);
  });

  test("leaving the screen closes the stream", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await user.click(
      within(screen.getByRole("navigation", { name: "메뉴 위치" })).getByRole(
        "link",
        { name: "세션" },
      ),
    );
    await screen.findByText("아직 세션이 없습니다.");
    expect(stream.closed).toBe(true);
  });

  test("moving to another session shows its stream connecting, not the old one closed", async () => {
    const next = new FakeEventStream();
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        json(200, { ...detail, id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/usage`]: () =>
        json(200, { ...usage, session_id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${OTHER_ID}/events`]: (request: Request) =>
        next.route(request),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await waitFor(() =>
      expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull(),
    );

    act(() => history.push(`/sessions/${OTHER_ID}`));
    await waitFor(() => expect(next.requests).toHaveLength(1));
    await act(async () => next.open());
    // Back to a session whose detail is cached: the new stream starts in the
    // same render that stops the old one, and the old one's close lands
    // while the new one is still connecting.
    act(() => history.push(`/sessions/${SESSION_ID}`));
    await waitFor(() => expect(stream.requests).toHaveLength(2));
    expect(next.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("이벤트에 연결하는 중…")).toBeTruthy();
    expect(screen.queryByText("이벤트 연결이 끊겼습니다.")).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  });

  test("a share taken back while open drops the detail and the stream", async () => {
    let visible = true;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        visible
          ? json(200, detail)
          : apiError(404, "NOT_FOUND", "Resource not found"),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await screen.findByText("권한 요청: Bash");

    visible = false;
    await act(() =>
      services.queryClient.refetchQueries({
        queryKey: keys.session(SESSION_ID),
        exact: true,
      }),
    );
    expect(
      await screen.findByText(
        "이 세션을 찾을 수 없습니다. 지워졌거나 볼 권한이 없는 세션입니다.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("권한 요청: Bash")).toBeNull();
    expect(stream.closed).toBe(true);
  });

  test("a stream refused for a lost login sends the reader to log in", async () => {
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [EVENTS_ROUTE]: () =>
        apiError(401, "UNAUTHORIZED", "Authentication required"),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/login"));
  });

  describe("the agent in the head's meta line", () => {
    const withAgent = (
      agentRoute: (request: Request) => Response | Promise<Response>,
    ) => ({
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          agent: {
            id: AGENT_ID,
            name: "Release helper",
            release_version_no: 2,
            release_label: null,
            release_is_active: true,
          },
        }),
      [`GET /v1/agents/${AGENT_ID}`]: agentRoute,
    });
    const headerOf = sessionMeta;

    test("opens the agent's page, reachable from the keyboard", async () => {
      // The agents API's own answer, which the client checks against its schema.
      renderAt(
        `/sessions/${SESSION_ID}`,
        withAgent(agentServer().routes[`GET /v1/agents/${AGENT_ID}`]),
      );
      const header = await headerOf();
      const link = await within(header).findByRole("link", {
        name: "Release helper",
      });
      expect(link.getAttribute("href")).toBe(`/agents/${AGENT_ID}`);
      expect(link.getAttribute("aria-current")).toBeNull();
      link.focus();
      expect(document.activeElement).toBe(link);
      // Nothing else on the screen repeats the agent.
      expect(
        screen.getAllByRole("link", { name: "Release helper" }),
      ).toHaveLength(1);
    });

    // Plain text is what a read still in flight shows too, so wait for the
    // refusal to have been given and taken in before looking.
    const refused = async (response: () => Response) => {
      let asked = 0;
      renderAt(
        `/sessions/${SESSION_ID}`,
        withAgent(() => {
          asked += 1;
          return response();
        }),
      );
      const header = await headerOf();
      await waitFor(() => expect(asked).toBe(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(header.textContent).toContain("Release helper");
      expect(
        within(header).queryByRole("link", { name: "Release helper" }),
      ).toBeNull();
    };

    test("a deleted agent stays plain text", () =>
      refused(() => apiError(404, "NOT_FOUND", "no such agent")));

    test("an agent the viewer may not read stays plain text", () =>
      refused(() => apiError(403, "FORBIDDEN", "may not read")));
  });

  test("cost reads with two decimals in the head's progress line", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/usage`]: () =>
        json(200, { ...usage, cost: { ...usage.cost, amount_usd: "1.5" } }),
    });
    const progress = await sessionProgress();
    await waitFor(() => expect(progress.textContent).toContain("$1.50"));
  });

  test("a turn that ended without a cost report is not called running", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/usage`]: () =>
        json(200, {
          ...usage,
          cost: { ...usage.cost, open_turn_count: 0, unreported_turn_count: 1 },
        }),
    });
    await sessionMeta();
    expect(
      await screen.findByText(/비용을 보고하지 않고 끝난 턴이 있어/),
    ).toBeTruthy();
    expect(screen.queryByText(/진행 중인 턴이 있어/)).toBeNull();
  });

  test("someone else's private session reads as not found and asks nothing more", async () => {
    const { api } = renderAt(`/sessions/${OTHER_ID}`, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        apiError(404, "NOT_FOUND", "Resource not found"),
    });
    expect(
      await screen.findByText(
        "이 세션을 찾을 수 없습니다. 지워졌거나 볼 권한이 없는 세션입니다.",
      ),
    ).toBeTruthy();
    expect(
      api.calls.filter((call) => call.path.startsWith("/v1/sessions/")),
    ).toHaveLength(1);
    expect(stream.requests).toHaveLength(0);
  });
});

describe("a turn its worker's lost lease cut off", () => {
  const lost = {
    turn_id: "1",
    session_id: SESSION_ID,
    status: "failed",
    message: "열 단계를 돌려 줘",
    channel: "web",
    created_by: null,
    slack_permalink: null,
    terminal_reason: "worker_ownership_lost",
    checkpoint_revision: null,
    created_at: AT,
    started_at: AT,
    ended_at: AT,
  };
  const resting = {
    ...detail,
    status: "idle",
    current_turn_id: null,
    pending_request_count: 0,
    attention: null,
  } as SessionDetail;
  const CUT =
    "작업이 중간에 끊겼습니다. 서버 연결이 잠시 끊겼습니다. 마지막 저장 지점 뒤에 한 일은 확인이 필요합니다.";
  const CONTINUE = { name: "이어서 하기" };
  const continuePath = `/v1/sessions/${SESSION_ID}/turns/1/continue`;

  function render(
    turns: () => unknown[],
    continued?: () => Response,
    session: SessionDetail = resting,
  ) {
    return renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, session),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, { items: turns(), next_cursor: null }),
      ...(continued ? { [`POST ${continuePath}`]: continued } : {}),
    });
  }
  const head = async () => screen.findByRole("heading", { level: 1 });

  test("reads 중단됨 in the head and says why where the turn ended, with the way on", async () => {
    render(() => [lost]);
    const notice = (await screen.findByText(CUT)).closest(
      "[data-slot='chat-message']",
    ) as HTMLElement;
    expect(notice.getAttribute("data-side")).toBe("other");
    expect(within(notice).getByRole("button", CONTINUE)).toBeTruthy();
    await waitFor(async () =>
      expect((await head()).textContent).toContain("중단됨"),
    );
    expect((await head()).textContent).not.toContain("쉬는 중");
  });

  test("a press queues one turn, and the button goes with the turn it went on from", async () => {
    const user = await setupUser();
    let turns: unknown[] = [lost];
    const { api } = render(
      () => turns,
      () => {
        turns = [
          lost,
          { ...lost, turn_id: "2", status: "queued", terminal_reason: null },
        ];
        return json(202, {
          turn_id: "2",
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    );
    const button = await screen.findByRole("button", CONTINUE);
    await user.click(button);
    await user.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("button", CONTINUE)).toBeNull(),
    );
    const posts = api.calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.path)).toEqual([continuePath]);
    // What happened stays where it happened; the head rests again.
    expect(screen.getByText(CUT)).toBeTruthy();
    await waitFor(async () =>
      expect((await head()).textContent).not.toContain("중단됨"),
    );
  });

  test("a message after the lost turn goes on in its place: no button", async () => {
    render(() => [
      lost,
      {
        ...lost,
        turn_id: "2",
        status: "completed",
        message: "다시 해 줘",
        terminal_reason: "completed",
      },
    ]);
    expect(await screen.findByText(CUT)).toBeTruthy();
    expect(screen.queryByRole("button", CONTINUE)).toBeNull();
    expect((await head()).textContent).not.toContain("중단됨");
  });

  test("a session already running again, though its turns lag behind, has no button", async () => {
    render(() => [lost], undefined, {
      ...resting,
      status: "running",
      current_turn_id: "2",
    } as SessionDetail);
    expect(await screen.findByText(CUT)).toBeTruthy();
    expect(screen.queryByRole("button", CONTINUE)).toBeNull();
    expect((await head()).textContent).not.toContain("중단됨");
  });

  test("a credential that may not send to sessions has no button to press", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/auth/me": () => json(200, me(["sessions:read"])),
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, resting),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, { items: [lost], next_cursor: null }),
    });
    expect(await screen.findByText(CUT)).toBeTruthy();
    expect(screen.queryByRole("button", CONTINUE)).toBeNull();
  });

  test("a refused press says why under the button", async () => {
    const user = await setupUser();
    render(
      () => [lost],
      () => apiError(403, "FORBIDDEN", "Forbidden"),
    );
    await user.click(await screen.findByRole("button", CONTINUE));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", CONTINUE)).toBeTruthy();
  });
});

describe("a session waiting on a recovery decision", () => {
  const unknown = {
    turn_id: "2",
    session_id: SESSION_ID,
    status: "outcome_unknown",
    message: "배포 스크립트를 돌려 줘",
    channel: "web",
    created_by: null,
    slack_permalink: null,
    terminal_reason: null,
    checkpoint_revision: null,
    created_at: AT,
    started_at: AT,
    ended_at: null,
  };
  const ran = {
    ...unknown,
    turn_id: "1",
    status: "completed",
    terminal_reason: "completed",
    ended_at: AT,
  };
  const waiting = {
    ...detail,
    status: "failed",
    admission_state: "recovery_required",
    revision: 5,
    current_turn_id: null,
    pending_request_count: 0,
    attention: null,
  } as SessionDetail;
  const gap = {
    ...waiting,
    attention: {
      code: "CONTEXT_GAP",
      last_ran_turn_id: "1",
      checkpointed_turn_id: null,
    },
  } as SessionDetail;
  const ABANDON = { name: "이 턴을 버리고 이어 가기" };
  const FRESH = { name: "새 문맥으로 계속" };
  const ABANDON_HINT = "마지막 저장 지점 뒤에 한 일은 확인이 필요합니다.";
  const FRESH_HINT = "이전 대화 문맥이 빠집니다.";
  const SENT = "요청을 보냈습니다. 바뀐 상태는 제목 옆 배지에 보입니다.";
  const decisionPath = `/v1/sessions/${SESSION_ID}/recovery-decisions`;
  const resumePath = `/v1/sessions/${SESSION_ID}/resume`;
  const accepted = () =>
    json(202, { receipt_id: RECEIPT_ID, receipt_status: "succeeded" });

  function render(options: {
    session: () => SessionDetail;
    turns?: unknown[];
    decided?: (request: Request) => Response;
    resumed?: (request: Request) => Response;
    scopes?: Parameters<typeof me>[0];
    turnsDown?: boolean;
  }) {
    return renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...(options.scopes
        ? { "GET /v1/auth/me": () => json(200, me(options.scopes)) }
        : {}),
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, options.session()),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        options.turnsDown
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, {
              items: options.turns ?? [ran, unknown],
              next_cursor: null,
            }),
      ...(options.decided ? { [`POST ${decisionPath}`]: options.decided } : {}),
      ...(options.resumed ? { [`POST ${resumePath}`]: options.resumed } : {}),
    });
  }
  const posts = (api: {
    calls: readonly {
      method: string;
      path: string;
      body: unknown;
      headers: Headers;
    }[];
  }) => api.calls.filter((call) => call.method === "POST");

  test("a turn whose outcome is unknown offers to give it up, and says what that leaves to check", async () => {
    render({ session: () => waiting });
    const button = await screen.findByRole("button", ABANDON);
    expect(screen.getByText(ABANDON_HINT)).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBe(
      screen.getByText(ABANDON_HINT).id,
    );
    expect(screen.queryByRole("button", FRESH)).toBeNull();
    // Terminate stays where it was.
    expect(screen.getByRole("button", { name: "세션 종료" })).toBeTruthy();
  });

  test("a context no checkpoint covers offers to go on without it, and says it is left out", async () => {
    render({ session: () => gap, turns: [ran] });
    expect(await screen.findByRole("button", FRESH)).toBeTruthy();
    expect(screen.getByText(FRESH_HINT)).toBeTruthy();
    expect(screen.queryByRole("button", ABANDON)).toBeNull();
  });

  test("over an unknown turn, a context gap offers abandon alone: the server would refuse start_fresh", async () => {
    render({ session: () => gap });
    expect(await screen.findByRole("button", ABANDON)).toBeTruthy();
    expect(screen.queryByRole("button", FRESH)).toBeNull();
  });

  const undecidable: [string, SessionDetail, unknown[]][] = [
    [
      "a restore that failed",
      {
        ...waiting,
        attention: {
          code: "RESTORE_FAILED",
          reason: "incompatible_checkpoint",
          failures: 1,
          retry_at: null,
        },
      } as SessionDetail,
      [ran],
    ],
    [
      "a stopped session with a context gap",
      {
        ...gap,
        admission_state: "stopped",
        status: "stopped",
      } as SessionDetail,
      [ran],
    ],
    [
      "an active session whose turns still read unknown",
      {
        ...waiting,
        admission_state: "active",
        status: "idle",
      } as SessionDetail,
      [ran, unknown],
    ],
  ];
  for (const [name, session, turns] of undecidable) {
    test(`no decision is offered for ${name}`, async () => {
      render({ session: () => session, turns });
      await screen.findByRole("heading", { level: 1 });
      expect((await screen.findAllByText(ran.message)).length).toBeGreaterThan(
        0,
      );
      expect(screen.queryByRole("button", ABANDON)).toBeNull();
      expect(screen.queryByRole("button", FRESH)).toBeNull();
    });
  }

  test("a context gap offers nothing while its turns cannot be read: one of them may be unknown", async () => {
    const { api } = render({ session: () => gap, turnsDown: true });
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() =>
      expect(
        api.calls.some((call) =>
          call.path.endsWith(`/sessions/${SESSION_ID}/turns`),
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("button", FRESH)).toBeNull();
    expect(screen.queryByRole("button", ABANDON)).toBeNull();
  });

  test("a decision on one session leaves another on the same revision its buttons", async () => {
    const user = await setupUser();
    const other = { ...gap, id: OTHER_ID } as SessionDetail;
    const { history } = renderAt(`/sessions/${OTHER_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, gap),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, { items: [ran], next_cursor: null }),
      [`POST ${decisionPath}`]: accepted,
      [`GET /v1/sessions/${OTHER_ID}`]: () => json(200, other),
      [`GET /v1/sessions/${OTHER_ID}/usage`]: () =>
        json(200, { ...usage, session_id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${OTHER_ID}/events`]: () =>
        new Promise<Response>(() => {}),
      [`GET /v1/sessions/${OTHER_ID}/turns`]: () =>
        json(200, {
          items: [{ ...ran, session_id: OTHER_ID }],
          next_cursor: null,
        }),
    });
    // The other session is read first, so its turns are already held.
    await screen.findByRole("button", FRESH);
    act(() => history.push(`/sessions/${SESSION_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    await user.click(await screen.findByRole("button", FRESH));
    await waitFor(() => expect(screen.queryByRole("button", FRESH)).toBeNull());
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    expect(await screen.findByRole("button", FRESH)).toBeTruthy();
  });

  test("a session with nothing to decide leaves the keyboard where the page put it", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, { items: [ran], next_cursor: null }),
    });
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() =>
      expect(screen.getAllByText(ran.message).length).toBeGreaterThan(0),
    );
    expect(document.activeElement?.tagName).toBe("BODY");
  });

  test("a credential that may not send to sessions has no decision to press", async () => {
    render({ session: () => gap, turns: [ran], scopes: ["sessions:read"] });
    await screen.findByRole("heading", { level: 1 });
    // The turn shows in the chat and in the header's step list.
    await waitFor(() =>
      expect(screen.getAllByText(ran.message).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("button", FRESH)).toBeNull();
    expect(screen.queryByRole("button", ABANDON)).toBeNull();
  });

  test("abandon, then resume on the revision the abandon made; the buttons go with the recovery", async () => {
    const user = await setupUser();
    let session = waiting;
    const { api } = render({
      session: () => session,
      decided: () => {
        session = {
          ...waiting,
          admission_state: "stopped",
          status: "stopped",
          revision: 6,
        } as SessionDetail;
        return accepted();
      },
      resumed: () => {
        session = {
          ...waiting,
          admission_state: "active",
          status: "idle",
          revision: 7,
        } as SessionDetail;
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    await user.click(await screen.findByRole("button", ABANDON));
    await waitFor(() =>
      expect(screen.queryByRole("button", ABANDON)).toBeNull(),
    );
    expect(posts(api).map((call) => [call.path, call.body])).toEqual([
      [
        decisionPath,
        {
          decision: "abandon",
          expected_revision: 5,
          target_turn_id: "2",
          reason: "Decided from the web console",
        },
      ],
      [resumePath, { expected_revision: 6 }],
    ]);
    // Two commands, two keys.
    const keys = new Set(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.headers.get("idempotency-key")),
    );
    expect(keys.size).toBe(2);
    expect(await screen.findByText(SENT)).toBeTruthy();
  });

  test("an abandon that took effect with its resume refused shows the stopped session and why", async () => {
    const user = await setupUser();
    let session = waiting;
    render({
      session: () => session,
      decided: () => {
        session = {
          ...waiting,
          admission_state: "stopped",
          status: "stopped",
          revision: 6,
        } as SessionDetail;
        return accepted();
      },
      resumed: () =>
        apiError(409, "CHECKPOINT_UNAVAILABLE", "No committed checkpoint"),
    });
    await user.click(await screen.findByRole("button", ABANDON));
    expect(
      await screen.findByText(
        "이어갈 저장 지점이 없거나 저장이 멈춰 처리하지 못했습니다 — 세션 상세의 안내를 확인하세요.",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", ABANDON)).toBeNull(),
    );
    // The head reads the stopped session and takes a resume again.
    const head = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(head.textContent).toContain("종료됨"));
    expect(screen.getByRole("button", { name: "다시 시작" })).toBeTruthy();
  });

  test("a session someone else moved after the abandon is not resumed", async () => {
    const user = await setupUser();
    let session = waiting;
    const { api } = render({
      session: () => session,
      decided: () => {
        // The abandon made revision 6; a terminate landed before the read.
        session = {
          ...waiting,
          admission_state: "stopped",
          status: "stopped",
          revision: 7,
        } as SessionDetail;
        return accepted();
      },
      resumed: () => accepted(),
    });
    await user.click(await screen.findByRole("button", ABANDON));
    expect(
      await screen.findByText(
        "그새 세션 상태가 바뀌었습니다. 바뀐 상태를 보고 다시 시도하세요.",
      ),
    ).toBeTruthy();
    expect(posts(api).map((call) => call.path)).toEqual([decisionPath]);
  });

  test("start_fresh is one decision, and the session goes on", async () => {
    const user = await setupUser();
    let session = gap;
    const { api } = render({
      session: () => session,
      turns: [ran],
      decided: () => {
        session = {
          ...gap,
          admission_state: "active",
          status: "idle",
          revision: 6,
          attention: null,
        } as SessionDetail;
        return accepted();
      },
    });
    await user.click(await screen.findByRole("button", FRESH));
    await waitFor(() => expect(screen.queryByRole("button", FRESH)).toBeNull());
    expect(posts(api).map((call) => [call.path, call.body])).toEqual([
      [
        decisionPath,
        {
          decision: "start_fresh",
          expected_revision: 5,
          reason: "Decided from the web console",
        },
      ],
    ]);
    expect(await screen.findByText(SENT)).toBeTruthy();
  });

  test("a double press makes one decision", async () => {
    const user = await setupUser();
    let session = gap;
    const { api } = render({
      session: () => session,
      turns: [ran],
      decided: () => {
        session = {
          ...gap,
          admission_state: "active",
          status: "idle",
          revision: 6,
          attention: null,
        } as SessionDetail;
        return accepted();
      },
    });
    const button = await screen.findByRole("button", FRESH);
    await user.dblClick(button);
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole("button", FRESH)).toBeNull());
    expect(posts(api).map((call) => call.path)).toEqual([decisionPath]);
  });

  test("a refused decision says why and leaves the choice", async () => {
    const user = await setupUser();
    render({
      session: () => waiting,
      decided: () => apiError(403, "FORBIDDEN", "Forbidden"),
    });
    await user.click(await screen.findByRole("button", ABANDON));
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot='recovery-decisions'] ~ output")
          ?.textContent,
      ).not.toBe(""),
    );
    expect(screen.getByRole("button", ABANDON)).toBeTruthy();
  });
});

describe("session runtime", () => {
  test("allows a permission request from the keyboard; the answered request leaves", async () => {
    const user = await setupUser();
    let open = [{ ...pending.items[0], expires_at: LATER }];
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        open = [];
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const allow = await screen.findByRole("button", { name: "승인" });
    allow.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/answers`);
    expect(post?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      action: "allow",
    });
    expect(post?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "권한 요청: Bash" }),
      ).toBeNull(),
    );
    expect(screen.getByText("답을 보냈습니다.").tagName).toBe("OUTPUT");
    // The notice stays in the chat where the card was, not in the info card.
    expect(screen.getByText("답을 보냈습니다.").closest("aside")).toBeNull();
    // The answered card took focus with it; the visible notice holds it now.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("답을 보냈습니다."),
    );
  });

  async function answerTheOnlyRequest(
    next: () => {
      readonly session: SessionDetail;
      readonly items: ListPendingRequestsResponse["items"];
    },
  ) {
    const user = await setupUser();
    let session: SessionDetail = detail;
    let open: ListPendingRequestsResponse["items"] = [
      { ...pending.items[0], expires_at: LATER },
    ] as ListPendingRequestsResponse["items"];
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, session),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        open = [];
        session = { ...detail, status: "running" };
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const allow = await screen.findByRole("button", { name: "승인" });
    allow.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("답을 보냈습니다."),
    );
    // Still running on the answer: the notice holds.
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
        "작업 중",
      ),
    );
    expect(screen.getByText("답을 보냈습니다.")).toBeTruthy();
    ({ session, items: open } = next());
    act(() => stream.emit("ev_2", "status", { phase: "idle" }));
    // The stream batches its refetches; let the reads land.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    await waitFor(() =>
      expect(screen.queryByText("답을 보냈습니다.")).toBeNull(),
    );
  }

  test("the sent notice leaves once the run it started ends, handing the keyboard to the list's title", async () => {
    await answerTheOnlyRequest(() => ({
      session: { ...detail, status: "idle", current_turn_id: null },
      items: [],
    }));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe("답변 대기 요청");
  });

  test("the sent notice leaves when a new request arrives, which takes the keyboard", async () => {
    const second = {
      ...pending.items[0],
      request_id: "req_2",
      tool: "Write",
      expires_at: LATER,
    } as ListPendingRequestsResponse["items"][number];
    await answerTheOnlyRequest(() => ({
      session: { ...detail, status: "needs_input" },
      items: [second],
    }));
    await waitFor(() =>
      expect(document.activeElement?.closest("article")?.textContent).toContain(
        "권한 요청: Write",
      ),
    );
  });

  test("after an answer the keyboard moves on to the next request", async () => {
    const user = await setupUser();
    const second = {
      ...pending.items[0],
      request_id: "req_2",
      tool: "Write",
      expires_at: LATER,
    };
    let open = [{ ...pending.items[0], expires_at: LATER }, second];
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        open = [second];
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const [allow] = await screen.findAllByRole("button", { name: "승인" });
    allow?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByText("권한 요청: Bash")).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement?.closest("article")?.textContent).toContain(
        "권한 요청: Write",
      ),
    );
  });

  test("focus moves on too when an event takes the card before the answer's receipt", async () => {
    const user = await setupUser();
    const second = {
      ...pending.items[0],
      request_id: "req_2",
      tool: "Write",
      expires_at: LATER,
    };
    let open = [{ ...pending.items[0], expires_at: LATER }, second];
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let posted = false;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        posted = true;
        return held;
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const [allow] = await screen.findAllByRole("button", { name: "승인" });
    allow?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(true));
    open = [second];
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    // waitFor's polling starves the refetch while the answer is held, so the
    // test waits on the clock instead.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByText("권한 요청: Bash")).toBeNull();
    expect(document.activeElement?.closest("article")?.textContent).toContain(
      "권한 요청: Write",
    );
    await act(async () =>
      release(
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
      ),
    );
  });

  test("an answer refused after an event took its card still says why", async () => {
    const user = await setupUser();
    let open = [{ ...pending.items[0], expires_at: LATER }];
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let posted = false;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        posted = true;
        return held;
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const allow = await screen.findByRole("button", { name: "승인" });
    allow.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(true));
    open = [];
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    // As above, the clock instead of waitFor while the answer is held.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByText("권한 요청: Bash")).toBeNull();
    await act(async () =>
      release(apiError(409, "REQUEST_EXPIRED", "request expired")),
    );
    expect(
      await screen.findByText("이미 답했거나 만료되었거나 닫힌 요청입니다."),
    ).toBeTruthy();
  });

  test("a denial carries its reason, and an expired request says why it was refused", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          answerable: true,
          items: [{ ...pending.items[0], expires_at: LATER }],
        }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        apiError(409, "REQUEST_EXPIRED", "request expired"),
    });
    // Deny opens its form; the reason is optional and typed there.
    await user.click(await screen.findByRole("button", { name: "거부" }));
    await user.type(
      screen.getByRole("textbox", { name: "거부하는 이유 (선택)" }),
      "not now",
    );
    await user.click(screen.getByRole("button", { name: "거부 보내기" }));
    expect(
      await screen.findByText("이미 답했거나 만료되었거나 닫힌 요청입니다."),
    ).toBeTruthy();
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      action: "deny",
      reason: "not now",
    });
  });

  test("answers a question with the picked option", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          answerable: true,
          items: [
            {
              kind: "question",
              request_id: "req_q",
              turn_id: "1",
              attempt_id: "att_1",
              created_at: AT,
              expires_at: LATER,
              questions: [
                {
                  question_id: "q1",
                  prompt: "Which branch?",
                  options: [
                    { option_id: "main", label: "main" },
                    { option_id: "dev", label: "dev" },
                  ],
                  multi_select: false,
                  allow_free_text: false,
                },
              ],
            },
          ],
        }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    await user.click(await screen.findByRole("radio", { name: "dev" }));
    await user.click(screen.getByRole("button", { name: "답 보내기" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        request_id: "req_q",
        kind: "question",
        answers: [{ question_id: "q1", selected_option_ids: ["dev"] }],
      }),
    );
  });

  test("interrupts the running turn and shows the stop the stream reports", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/interrupt`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const stop = await screen.findByRole("button", {
      name: "지금 턴 멈추기",
    });
    stop.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText(
        "요청을 보냈습니다. 바뀐 상태는 제목 옆 배지에 보입니다.",
      ),
    ).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/interrupt`);
    expect(post?.body).toEqual({ target_turn_id: "1" });

    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => stream.emit("ev_1", "status", { phase: "interrupting" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("list", { name: "이벤트" })
          .parentElement?.querySelector("output.sr-only")?.textContent,
      ).toBe("멈추는 중"),
    );
  });

  test("after a pause the keyboard lands on resume", async () => {
    const user = await setupUser();
    let state = { ...detail };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/pause`]: () => {
        state = {
          ...detail,
          admission_state: "paused",
          status: "idle",
          current_turn_id: null,
        };
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    pause.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "일시 정지" })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("다시 시작"),
    );
    // The notice points at the badge that actually changed.
    expect(
      screen.getByText(
        "요청을 보냈습니다. 바뀐 상태는 제목 옆 배지에 보입니다.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "작업 상태: 쉬는 중세션 상태: 일시 정지됨",
    );
  });

  test("after resume the keyboard waits out resuming on the outcome and lands on pause, never on terminate", async () => {
    const user = await setupUser();
    let state = {
      ...detail,
      admission_state: "paused",
      status: "idle",
      current_turn_id: null,
    };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/resume`]: () => {
        state = { ...state, admission_state: "resuming" };
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const resume = await screen.findByRole("button", { name: "다시 시작" });
    resume.focus();
    await user.keyboard("{Enter}");
    // While resuming terminate is the only button; Enter there would open
    // its dialog.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "다시 시작" })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "요청을 보냈습니다. 바뀐 상태는 제목 옆 배지에 보입니다.",
      ),
    );
    state = { ...detail, current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "idle" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("일시 정지"),
    );
  });

  test("a running command keeps its button focused and takes no second press", async () => {
    const user = await setupUser();
    let posts = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/pause`]: () => {
        posts += 1;
        return held;
      },
    });
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    pause.focus();
    await user.keyboard("{Enter}");
    // The clock instead of waitFor while the command is held, as above.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pause.getAttribute("aria-disabled")).toBe("true");
    expect(pause.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(pause);
    await user.keyboard("{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(posts).toBe(1);
    await act(async () =>
      release(
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
      ),
    );
  });

  test("a refused command does not take the keyboard back on a later change", async () => {
    const user = await setupUser();
    let state = { ...detail };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/pause`]: () =>
        apiError(409, "PAUSE_COMMITTING", "pause committing"),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    pause.focus();
    await user.keyboard("{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The reader moves on; the turn ending later changes the controls.
    (document.activeElement as HTMLElement | null)?.blur();
    state = { ...detail, current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "idle" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByRole("button", { name: "지금 턴 멈추기" })).toBeNull();
    expect(document.activeElement?.tagName).toBe("BODY");
  });

  test("terminating asks first and sends the session's revision", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/terminate`]: () =>
        json(202, TERMINATE_ACCEPTED),
    });
    await user.click(await screen.findByRole("button", { name: "세션 종료" }));
    // It stops a running session, so it is announced as an alert.
    const dialog = await screen.findByRole("alertdialog", {
      name: "세션을 종료할까요?",
    });
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "종료" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        expected_revision: 3,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("a terminate whose button left before the receipt hands the keyboard to its outcome", async () => {
    const user = await setupUser();
    let state = { ...detail };
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let posted = false;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/terminate`]: () => {
        posted = true;
        return held;
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const terminate = await screen.findByRole("button", { name: "세션 종료" });
    terminate.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("alertdialog", {
      name: "세션을 종료할까요?",
    });
    within(dialog).getByRole("button", { name: "종료" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(true));
    state = { ...detail, admission_state: "stopping", current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    // The clock instead of waitFor while the command is held, as above.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByRole("button", { name: "세션 종료" })).toBeNull();
    await act(async () => release(json(202, TERMINATE_ACCEPTED)));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "요청을 보냈습니다. 바뀐 상태는 제목 옆 배지에 보입니다.",
      ),
    );
  });

  test("a message sent with Ctrl+Enter shows in the chat before any event, its notice only announced", async () => {
    const user = await setupUser();
    const queued = {
      turn_id: "2",
      session_id: SESSION_ID,
      status: "queued",
      message: "next step",
      channel: "web",
      created_by: null,
      slack_permalink: null,
      terminal_reason: null,
      checkpoint_revision: null,
      created_at: AT,
      started_at: null,
      ended_at: null,
    };
    let turns: (typeof queued)[] = [];
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, { items: turns, next_cursor: null }),
      [`POST /v1/sessions/${SESSION_ID}/messages`]: () => {
        turns = [queued];
        return json(202, {
          turn_id: "2",
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await screen.findByText("권한 요청: Bash");
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step{Control>}{Enter}{/Control}");
    // No worker has started the turn, so no event names it.
    const bubble = (
      await within(screen.getByRole("list", { name: "이벤트" })).findByText(
        "next step",
      )
    ).closest("[data-slot='chat-message']");
    expect(bubble?.getAttribute("data-side")).toBe("self");
    const notice = await screen.findByText("메시지를 보냈습니다.");
    expect(notice.tagName).toBe("OUTPUT");
    expect(notice.classList.contains("sr-only")).toBe(true);
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/messages`);
    expect(post?.body).toEqual({ message: "next step", mode: "enqueue" });
    expect(
      (
        screen.getByRole("textbox", {
          name: "다음 지시",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  /** Sends by mouse and holds the receipt; focus has left the send button. */
  async function sendHeldByMouse(routes: Parameters<typeof renderAt>[1] = {}) {
    const user = await setupUser();
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...routes,
      [`POST /v1/sessions/${SESSION_ID}/messages`]: () => held,
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await screen.findByText("권한 요청: Bash");
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step");
    const send = screen.getByRole("button", { name: "보내기" });
    await user.click(send);
    // The clock instead of waitFor while the command is held, as above.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((send as HTMLButtonElement).disabled).toBe(true);
    // Chrome drops focus from a button that turns disabled. The DOM here
    // neither does that nor blurs a disabled button, but it does fall back
    // to the page when the focused element is removed.
    const stand = send.parentElement?.appendChild(
      document.createElement("input"),
    );
    stand?.focus();
    stand?.remove();
    expect(document.activeElement?.tagName).toBe("BODY");
    const answer = (response: Response) => act(async () => release(response));
    const accept = async () => {
      await answer(
        json(202, {
          turn_id: "2",
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        }),
      );
      expect(await screen.findByText("메시지를 보냈습니다.")).toBeTruthy();
    };
    return { accept, answer };
  }

  test("a message sent by mouse gives the keyboard back to the field", async () => {
    const { accept } = await sendHeldByMouse();
    await accept();
    expect(
      document.activeElement ===
        screen.getByRole("textbox", { name: "다음 지시" }),
    ).toBe(true);
  });

  test("a send in flight is not sent twice, by button or by Enter", async () => {
    const user = await setupUser();
    let posts = 0;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/messages`]: () => {
        posts += 1;
        return new Promise<Response>(() => {});
      },
    });
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(posts).toBe(1));
    await user.click(screen.getByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("{Enter}");
    const send = screen.getByRole("button", { name: "보내기" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await user.click(send);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toBe(1);
  });

  test("a reader who clicked elsewhere while sending keeps their place", async () => {
    const { accept } = await sendHeldByMouse();
    fireEvent.pointerDown(document.body);
    await accept();
    expect(document.activeElement?.tagName).toBe("BODY");
  });

  /** Sends, then the session pauses before the receipt comes back. */
  async function sendThenPause() {
    let state = { ...detail };
    const held = await sendHeldByMouse({
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
    });
    state = { ...detail, admission_state: "paused", current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "idle" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "다음 지시",
          }) as HTMLTextAreaElement
        ).disabled,
      ).toBe(true),
    );
    return held;
  }

  test("a message accepted after the session paused hands the keyboard to its notice", async () => {
    const { accept } = await sendThenPause();
    await accept();
    const notice = document.activeElement as HTMLElement;
    expect(notice.textContent).toBe("메시지를 보냈습니다.");
    // Focus lands on it, so it is drawn.
    expect(notice.classList.contains("sr-only")).toBe(false);
  });

  test("a message refused after the session paused says why on the notice it focuses", async () => {
    const { answer } = await sendThenPause();
    await answer(apiError(409, "SESSION_PAUSED", "session paused"));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "일시 정지된 세션입니다.",
      ),
    );
    // Said once, on the notice, not again under the field.
    expect(screen.getAllByText("일시 정지된 세션입니다.")).toHaveLength(1);
  });

  test("a stopped session offers resume and takes no message", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          admission_state: "stopped",
          status: "stopped",
          current_turn_id: null,
        }),
    });
    expect(
      await screen.findByRole("button", { name: "다시 시작" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "지금 턴 멈추기" })).toBeNull();
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "다음 지시",
        })) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText("진행 중인 세션만 메시지를 받습니다."),
    ).toBeTruthy();
  });

  test("a key without the scopes sees each action disabled and why", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/auth/me": () => json(200, me(["sessions:read"], "member")),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          answerable: true,
          items: [{ ...pending.items[0], expires_at: LATER }],
        }),
    });
    const allow = await screen.findByRole("button", { name: "승인" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    // A key that may not answer is not told its input is needed.
    expect(
      screen.queryByRole("region", { name: "내 입력이 필요합니다" }),
    ).toBeNull();
    // Beside the buttons, once.
    expect(
      screen.getAllByText("sessions:approve 권한이 있어야 할 수 있습니다."),
    ).toHaveLength(1);
    expect(
      screen.queryByText("나는 이 세션의 요청에 답할 수 있습니다."),
    ).toBeNull();
    const stop = screen.getByRole("button", { name: "지금 턴 멈추기" });
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(stop.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("sessions:control 권한이 있어야 할 수 있습니다.");
    expect(screen.queryByText("할 수 있음")).toBeNull();
    expect(
      screen
        .getByRole("textbox", { name: "다음 지시" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText("sessions:write 권한이 있어야 할 수 있습니다."),
    ).toBeTruthy();
  });

  test("someone who only sees the session through its share sees allow and deny disabled and why (94S-798)", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          answerable: false,
          items: [{ ...pending.items[0], expires_at: LATER }],
        }),
    });
    const allow = await screen.findByRole("button", { name: "승인" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "거부" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(
        "이 세션을 시작한 사람, 에이전트 관리자, 워크스페이스 오너·어드민만 답할 수 있습니다.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("textbox", { name: "다음 지시" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("a member answers the request whose requester left a private channel, and only that one (94S-2219)", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          answerable: false,
          items: [
            {
              ...pending.items[0],
              request_id: "req_left",
              expires_at: LATER,
              answerable: true,
            },
            {
              ...pending.items[0],
              request_id: "req_kept",
              expires_at: LATER,
              answerable: false,
            },
          ],
        }),
    });
    await screen.findAllByRole("button", { name: "승인" });
    const disabled = (name: string) =>
      screen
        .getAllByRole("button", { name })
        .map((button) => button.hasAttribute("disabled"));
    expect(disabled("승인")).toEqual([false, true]);
    expect(disabled("거부")).toEqual([false, true]);
    // Said at the request it holds for, not over the list.
    expect(
      screen.getAllByText(
        "이 세션을 시작한 사람, 에이전트 관리자, 워크스페이스 오너·어드민만 답할 수 있습니다.",
      ),
    ).toHaveLength(1);
  });
});

describe("세션 상세 레이아웃", () => {
  test.each(["error", "loading"] as const)(
    "pending %s keeps the composer under the chat",
    async (state) => {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
          state === "loading"
            ? new Promise<Response>(() => {})
            : json(500, {
                error: { code: "INTERNAL_ERROR", message: "pending failed" },
              }),
      });
      const composer = await screen.findByRole("textbox", {
        name: "다음 지시",
      });
      expect(composer.closest("aside")).toBeNull();
      if (state === "error")
        expect(
          await screen.findByRole("button", { name: "다시 시도" }),
        ).toBeTruthy();
      expect(
        screen.getAllByRole("textbox", { name: "다음 지시" }),
      ).toHaveLength(1);
      // Requests that could not be read are not reported as none.
      expect(document.body.textContent).not.toContain("기다리는 요청 없음");
    },
  );

  test("넓은 화면의 머리는 제목·상태 옆에 세션 조작 묶음을 두고, 레일은 없다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const heading = await screen.findByRole("heading", { level: 1 });
    const header = heading.closest("header") as HTMLElement;
    // The way back is the top bar's trail; the head has no trail of its own.
    expect(within(header).queryByRole("navigation")).toBeNull();
    const trail = screen.getByRole("navigation", { name: "메뉴 위치" });
    expect(
      within(trail).getByRole("link", { name: "세션" }).getAttribute("href"),
    ).toBe("/sessions");
    expect(heading.textContent).toContain("답변 대기");
    // The head holds only the commands and the id's copy button.
    const controls = within(header).getByRole("group", { name: "세션 조작" });
    expect(
      within(controls)
        .getAllByRole("button")
        .map((button) => [button.dataset.action, button.textContent]),
    ).toEqual([
      ["interrupt", "지금 턴 멈추기"],
      ["pause", "일시 정지"],
      ["terminate", "세션 종료"],
    ]);
    expect(
      within(header)
        .getAllByRole("button")
        .filter((button) => !controls.contains(button))
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["세션 ID 복사"]);
    expect(header.textContent).not.toContain("model-default");

    // Nothing sits beside the body: the session's info is its outputs tab.
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(
      screen.getAllByRole("group", { name: "세션 조작", hidden: true }),
    ).toEqual([controls]);
    const progress = await sessionProgress();
    await waitFor(() => expect(progress.textContent).toContain("<$0.01"));
  });

  // happy-dom lays nothing out, so this pins what keeps the boxes still; the
  // PR measured the positions in a browser at 390 to 1920px.
  test.each([
    ["1280 이상", true],
    ["390", false],
  ] as const)(
    "%s: 명령 결과 문장이 나와도 버튼과 제목이 움직이지 않는다",
    async (_, wide) => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query === "(min-width: 80rem)" ? wide : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      try {
        const user = await setupUser();
        renderAt(`/sessions/${SESSION_ID}`, {
          ...detailRoutes,
          [`POST /v1/sessions/${SESSION_ID}/pause`]: () =>
            apiError(409, "PAUSE_COMMITTING", "pause committing"),
        });
        const heading = await screen.findByRole("heading", { level: 1 });
        const header = heading.closest("header") as HTMLElement;
        const controls = within(header).getByRole("group", {
          name: "세션 조작",
        });
        const buttons = within(controls).getAllByRole("button");
        // Below 1280px the labels hide but still name the buttons.
        expect(buttons.map((button) => button.textContent)).toEqual([
          "지금 턴 멈추기",
          "일시 정지",
          "세션 종료",
        ]);

        await user.click(
          within(controls).getByRole("button", { name: "일시 정지" }),
        );
        const outcome = header.querySelector("output") as HTMLOutputElement;
        await waitFor(() => expect(outcome.textContent).not.toBe(""));
        expect(within(controls).getAllByRole("button")).toEqual(buttons);
        // The outcome takes the buttons' width instead of setting it, and the
        // row is top-aligned, so its height leaves the title where it was.
        expect(outcome.classList.contains("w-0")).toBe(true);
        expect(outcome.classList.contains("min-w-full")).toBe(true);
        expect(heading.parentElement?.classList.contains("items-start")).toBe(
          true,
        );
        // A button tall, so a one-line title stays level with the buttons.
        expect(
          heading.classList.contains("min-h-[var(--werft-control-height-sm)]"),
        ).toBe(true);
      } finally {
        window.matchMedia = original;
      }
    },
  );

  test("머리의 메타 줄은 에이전트, 호출한 사람과 채널, Slack 링크를 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          agent: { id: OTHER_ID, name: "코드 리뷰", release_version_no: 1 },
          created_by: { user_id: THIRD_ID, display_name: "Demo Owner" },
          channel: "slack",
          slack_permalink: SLACK_PERMALINK,
        }),
    });
    const meta = await sessionMeta();
    await waitFor(() =>
      expect(meta.textContent).toContain("에이전트: 코드 리뷰"),
    );
    expect(meta.textContent).toContain("채널: Demo Owner · Slack");
    expect(within(meta).getByRole("link", { name: /Slack/ })).toBeTruthy();
    // The start time is read out and shown on hover, not drawn.
    expect(meta.textContent).toContain("시작 시각");
  });

  test.each([
    [{ agent: null, channel: "api" }, "에이전트 없음", "API"],
    [{ agent: null, channel: null }, "에이전트 없음", "—"],
    [{ agent: null, channel: "web" }, "에이전트 없음", "웹 콘솔"],
  ])("%p는 에이전트 %p, 채널 %p로 쓴다", async (fields, agent, channel) => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, ...fields }),
    });
    const meta = await sessionMeta();
    await waitFor(() =>
      expect(meta.textContent).toContain(`에이전트: ${agent}`),
    );
    expect(meta.textContent).toContain(`채널: ${channel}`);
    expect(within(meta).queryByRole("link", { name: /Slack/ })).toBeNull();
  });

  test("닫힌 세션의 머리에는 조작 묶음도, 할 수 있는 조작이 없다는 문장도 없다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          status: "stopped",
          admission_state: "closed",
          current_turn_id: null,
        }),
    });
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(heading.textContent).toContain("세션 상태"));
    const header = heading.closest("header") as HTMLElement;
    expect(
      within(header).queryByRole("group", { name: "세션 조작" }),
    ).toBeNull();
    expect(document.querySelector("[data-action]")).toBeNull();
    expect(document.body.textContent).not.toContain(
      "지금 할 수 있는 제어가 없습니다.",
    );
  });

  test.each([
    ["hello.txt 만들고 commit", "hello.txt 만들고 commit"],
    [null, SESSION_ID.slice(0, 8)],
  ])("제목 %p는 머리에 %p로 쓴다", async (title, shown) => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, { ...detail, title }),
    });
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent?.startsWith(`${shown}작업 상태: `)).toBe(true);
  });

  test.each([
    ["paused", "일시 정지됨"],
    ["pausing", "일시 정지 중"],
    ["resuming", "복원 중"],
    ["stopping", "종료 중"],
    ["stopped", "종료됨"],
  ] as const)(
    "세션 상태 %p는 머리 작업 상태 옆에 %p로 보인다",
    async (admission_state, shown) => {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}`]: () =>
          json(200, { ...detail, admission_state }),
      });
      const heading = await screen.findByRole("heading", { level: 1 });
      expect(heading.textContent).toContain(
        `작업 상태: 답변 대기세션 상태: ${shown}`,
      );
    },
  );

  test("열린 세션의 머리에는 세션 상태 배지가 없다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent?.endsWith("작업 상태: 답변 대기")).toBe(true);
    expect(heading.querySelectorAll("[data-axis]")).toHaveLength(1);
  });

  test("공유받아 보기만 하는 사람에게는 답할 수 없다고 말한다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { ...pending, answerable: false }),
    });
    expect(
      await screen.findByText(
        "이 세션을 시작한 사람, 에이전트 관리자, 워크스페이스 오너·어드민만 답할 수 있습니다.",
      ),
    ).toBeTruthy();
  });
  test("작성 중인 다음 지시는 요청이 생기고 사라져도 남는다", async () => {
    const user = await setupUser();
    let open: ListPendingRequestsResponse["items"] = [];
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        open = [];
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const draft = () =>
      (
        screen.getByRole("textbox", {
          name: "다음 지시",
        }) as HTMLTextAreaElement
      ).value;
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step draft");
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());

    open = pending.items.map((item) => ({ ...item, expires_at: LATER }));
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    const allow = await screen.findByRole("button", { name: "승인" });
    expect(draft()).toBe("next step draft");

    allow.focus();
    await user.keyboard("{Enter}");
    await screen.findByText("답을 보냈습니다.");
    expect(draft()).toBe("next step draft");
  });

  test("다른 세션으로 옮기면 앞 세션의 초안을 가져가지 않는다", async () => {
    const user = await setupUser();
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        json(200, { ...detail, id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/usage`]: () =>
        json(200, { ...usage, session_id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${OTHER_ID}/events`]: () =>
        new Promise<Response>(() => {}),
    });
    await screen.findByText("권한 요청: Bash");
    await user.click(screen.getByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("for the first session");
    expect(
      (
        screen.getByRole("textbox", {
          name: "다음 지시",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("for the first session");
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "다음 지시",
        })) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  test("작성창은 늘 채팅 아래 본문에 있고 넓은 화면은 본문부터 읽는다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const composer = await screen.findByRole("textbox", { name: "다음 지시" });
    const chat = screen.getByRole("list", { name: "이벤트" });
    expect(
      chat.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const panel = composer.closest('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(
      screen.getByRole("tab", { name: "대화" }).id,
    );
    expect(panel?.contains(chat)).toBe(true);
    expect(
      panel?.closest('[data-slot="page-frame-body"]')?.contains(composer),
    ).toBe(true);
    expect(document.querySelector("aside")).toBeNull();
  });
  test.each([
    ["loading", () => new Promise<Response>(() => {})],
    [
      "error",
      () =>
        json(500, {
          error: { code: "INTERNAL_ERROR", message: "detail failed" },
        }),
    ],
  ] as const)(
    "세션을 읽는 중·실패(%s)도 상세 레이아웃의 여백 안에 둔다",
    async (state, read) => {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}`]: read,
      });
      const shown =
        state === "loading"
          ? await screen.findByText("불러오는 중입니다")
          : await screen.findByRole("button", { name: "다시 시도" });
      expect(shown.closest('[data-slot="page-frame-body"]')).toBeTruthy();
      expect(screen.queryByRole("complementary")).toBeNull();
    },
  );

  test("본문은 대화·성과물 탭이고, 주소의 ?tab=outputs가 성과물을 열며 탭을 바꾸면 주소를 바꿔 쓴다", async () => {
    const user = await setupUser();
    const { history } = renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const tabs = await screen.findByRole("tablist", { name: "세션 상세" });
    expect(
      within(tabs)
        .getByRole("tab", { name: "대화" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(tabs)
        .getByRole("tab", { name: /^성과물/ })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(within(tabs).getAllByRole("tab")).toHaveLength(2);
    const before = history.length;
    await user.click(within(tabs).getByRole("tab", { name: /^성과물/ }));
    await waitFor(() => expect(history.location.search).toBe("?tab=outputs"));
    await user.click(within(tabs).getByRole("tab", { name: "대화" }));
    await waitFor(() => expect(history.location.search).toBe(""));
    // Replaced, so Back leaves the session instead of walking the tabs.
    expect(history.length).toBe(before);
  });

  test("?tab=outputs로 열면 성과물 탭이 열려 있다", async () => {
    renderAt(`/sessions/${SESSION_ID}?tab=outputs`, detailRoutes);
    const tab = await screen.findByRole("tab", { name: /^성과물/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("tabpanel", { name: /^성과물/ }),
    ).toBeTruthy();
  });

  test("대화 탭을 보는 동안에도 성과물 패널은 마운트되어 읽기를 이어 간다", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await screen.findByRole("textbox", { name: "다음 지시" });
    // The detail has a repository, so the panel asks for its pull requests.
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.path === `/v1/sessions/${SESSION_ID}/outcomes`,
        ),
      ).toBe(true),
    );
    const panel = document.getElementById(
      screen
        .getByRole("tab", { name: /^성과물/ })
        .getAttribute("aria-controls") ?? "",
    );
    expect(panel?.hidden).toBe(true);
    expect(panel?.getAttribute("tabindex")).toBe("-1");
    // A host without Tailwind's preflight lets `flex` win over `hidden`;
    // the class hides the inactive panel there too.
    const chat = screen.getByRole("tabpanel", { name: "대화" });
    for (const [each, state] of [
      [panel, "inactive"],
      [chat, "active"],
    ] as const) {
      expect(each?.getAttribute("data-state")).toBe(state);
      expect(each?.className.split(" ")).toContain(
        "data-[state=inactive]:hidden",
      );
    }
  });

  const pull = (n: number) => ({
    id: `019a0000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`,
    type: "github_pull_request",
    url: `https://github.com/acme/demo/pull/${n}`,
    repository_id: "demo",
    external_id: String(n),
    state: "open",
    state_changed_at: AT,
    merged_at: null,
    closed_at: null,
    state_checked_at: AT,
    check_error: null,
    metadata: {
      title: `Change ${n}`,
      head: `agent/${SESSION_ID}`,
      base: "main",
      adopted: false,
      merge_commit_sha: null,
      additions: null,
      deletions: null,
      changed_files: null,
      commits: null,
    },
    created_at: AT,
  });
  const refusal = (n: number) => ({
    receipt_id: `019a0000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
    operation: "mint_github_token",
    purpose: "push",
    reason_code: "github_disabled",
    created_at: AT,
  });
  /** Every list the outputs tab counts, answered for one session. */
  const outputsRoutes = (id: string, pulls: number, refusals: number) => ({
    [`GET /v1/sessions/${id}/outcomes`]: () =>
      json(200, { items: Array.from({ length: pulls }, (_, n) => pull(n)) }),
    [`GET /v1/sessions/${id}/achievements`]: () =>
      json(200, {
        items: [],
        judgment: null,
        judgment_count: 0,
        judge_cost_usd: 0,
      }),
    [`GET /v1/sessions/${id}/github/refusals`]: () =>
      json(200, {
        items: Array.from({ length: refusals }, (_, n) => refusal(n)),
      }),
  });
  const outputsTab = () => screen.getByRole("tab", { name: /^성과물/ });
  const toneOf = (tab: HTMLElement) =>
    tab.querySelector("[data-tone]")?.getAttribute("data-tone") ?? null;

  test("성과물 탭의 개수는 탭에 보이는 PR·성과·out/ 파일·GitHub 거절을 모두 세고, 거절이 있으면 위험 색과 이름으로 알린다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 1, 1),
    });
    const tab = await screen.findByRole("tab", {
      name: "성과물 2개, GitHub 거절 있음",
    });
    expect(tab.querySelector("[data-slot=item-count]")?.textContent).toBe("2");
    expect(toneOf(tab)).toBe("danger");
  });

  test("거절만 있고 다른 성과물이 없어도 탭은 위험 색으로 알린다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 0, 1),
    });
    const tab = await screen.findByRole("tab", {
      name: "성과물 1개, GitHub 거절 있음",
    });
    expect(toneOf(tab)).toBe("danger");
  });

  test.each(["loading", "failed"] as const)(
    "%s: 아직 답하지 않은 목록이 있으면 개수를 0으로 그리지 않는다",
    async (state) => {
      const { api } = renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        ...outputsRoutes(SESSION_ID, 0, 0),
        [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
          state === "loading"
            ? new Promise<Response>(() => {})
            : apiError(503, "BACKEND_UNAVAILABLE", "down"),
      });
      await waitFor(() =>
        expect(
          ["outcomes", "achievements", "github/refusals"].every((list) =>
            api.calls.some(
              (call) => call.path === `/v1/sessions/${SESSION_ID}/${list}`,
            ),
          ),
        ).toBe(true),
      );
      // The other lists answered empty; one unknown still leaves no number.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const tab = outputsTab();
      expect(
        tab.querySelector("[data-slot=item-count]")?.textContent ?? null,
      ).toBe(null);
      expect(screen.getByRole("tab", { name: "성과물" }) === tab).toBe(true);
    },
  );

  test("다른 목록 하나를 읽지 못해도 GitHub 거절이 있으면 탭은 개수 없이 위험 표시와 이름으로 알린다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 0, 1),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "down"),
    });
    const tab = await screen.findByRole("tab", {
      name: "성과물 GitHub 거절 있음",
    });
    // The count stays unknown; only the refusal is certain, so the badge
    // holds its icon and no number.
    const badge = tab.querySelector("[data-slot=item-count]");
    expect(badge?.textContent).toBe("");
    expect(toneOf(tab)).toBe("danger");
    expect(badge?.querySelector("svg.lucide-circle-x") === null).toBe(false);
    expect(tab.querySelector("[data-slot=status-dot]") === null).toBe(true);
  });

  test("GitHub 거절 목록 자체를 읽지 못하면 탭은 거절을 말하지 않는다", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 1, 0),
      [`GET /v1/sessions/${SESSION_ID}/github/refusals`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "down"),
    });
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.path === `/v1/sessions/${SESSION_ID}/github/refusals`,
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not known to be refused, so neither a dot nor a count.
    const tab = outputsTab();
    expect(tab.querySelector("[data-slot=status-dot]") === null).toBe(true);
    expect(tab.querySelector("[data-slot=item-count]") === null).toBe(true);
    expect(screen.getByRole("tab", { name: "성과물" }) === tab).toBe(true);
  });

  test("늦던 목록이 답해 개수가 돌아오면 거절 아이콘 배지에 개수가 붙고 배지는 하나다", async () => {
    let answer: (response: Response) => void = () => {};
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 0, 1),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const waiting = await screen.findByRole("tab", {
      name: "성과물 GitHub 거절 있음",
    });
    const before = waiting.querySelectorAll("[data-slot=item-count]");
    expect(before.length).toBe(1);
    expect(before[0]?.textContent).toBe("");
    expect(before[0]?.querySelector("svg.lucide-circle-x") === null).toBe(
      false,
    );
    act(() => answer(json(200, { items: [] })));
    const counted = await screen.findByRole("tab", {
      name: "성과물 1개, GitHub 거절 있음",
    });
    expect(toneOf(counted)).toBe("danger");
    const after = counted.querySelectorAll("[data-slot=item-count]");
    expect(after.length).toBe(1);
    expect(after[0]?.textContent).toBe("1");
    expect(after[0]?.querySelector("svg.lucide-circle-x") === null).toBe(false);
    expect(counted.querySelector("[data-slot=status-dot]") === null).toBe(true);
  });

  test("세션을 옮겼다 돌아와도 탭의 개수와 거절 표시는 그 세션의 것이다", async () => {
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 0, 1),
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        json(200, { ...detail, id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/usage`]: () =>
        json(200, { ...usage, session_id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${OTHER_ID}/events`]: () =>
        new Promise<Response>(() => {}),
      // The same count as the first, so nothing about it changes on the way back.
      ...outputsRoutes(OTHER_ID, 0, 1),
    });
    const NAME = "성과물 1개, GitHub 거절 있음";
    await screen.findByRole("tab", { name: NAME });
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    expect(toneOf(await screen.findByRole("tab", { name: NAME }))).toBe(
      "danger",
    );
    act(() => history.push(`/sessions/${SESSION_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    expect(toneOf(await screen.findByRole("tab", { name: NAME }))).toBe(
      "danger",
    );
  });

  test("GitHub 거절 목록을 읽지 못하면 그 절에 실패와 다시 시도를 보이고, 다시 읽으면 거절이 보인다", async () => {
    const user = await setupUser();
    let reads = 0;
    renderAt(`/sessions/${SESSION_ID}?tab=outputs`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 0, 0),
      [`GET /v1/sessions/${SESSION_ID}/github/refusals`]: () =>
        ++reads === 1
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, { items: [refusal(0)] }),
    });
    const section = await screen.findByRole("region", {
      name: "최근 GitHub 거절",
    });
    // Not the same as an empty list: the reader is told it was not read.
    const retry = await within(section).findByRole("button", {
      name: "다시 시도",
    });
    await user.click(retry);
    expect(await within(section).findByText("GitHub 사용 꺼짐")).toBeTruthy();
    expect(
      within(section).queryByRole("button", { name: "다시 시도" }) === null,
    ).toBe(true);
  });

  test("거절 목록을 다시 읽는 동안에도 절과 실패 표시가 남고 초점은 다시 시도에 있으며, 두 번 눌러도 한 번 읽는다", async () => {
    const user = await setupUser();
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    renderAt(`/sessions/${SESSION_ID}?tab=outputs`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 0, 0),
      [`GET /v1/sessions/${SESSION_ID}/github/refusals`]: () =>
        ++reads === 1
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : new Promise<Response>((resolve) => {
              answer = resolve;
            }),
    });
    const section = await screen.findByRole("region", {
      name: "최근 GitHub 거절",
    });
    const retry = await within(section).findByRole("button", {
      name: "다시 시도",
    });
    await user.click(retry);
    await user.click(retry);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(2);
    expect(section.isConnected).toBe(true);
    expect(within(section).getByText("불러오지 못했습니다")).toBeTruthy();
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
    act(() => answer(apiError(503, "BACKEND_UNAVAILABLE", "down")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
  });

  test("세션을 찾지 못한 404는 거절 절에 그리지 않는다", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}?tab=outputs`, {
      ...detailRoutes,
      ...outputsRoutes(SESSION_ID, 1, 0),
      [`GET /v1/sessions/${SESSION_ID}/github/refusals`]: () =>
        apiError(404, "NOT_FOUND", "gone"),
    });
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.path === `/v1/sessions/${SESSION_ID}/github/refusals`,
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      screen.queryByRole("region", { name: "최근 GitHub 거절" }) === null,
    ).toBe(true);
  });

  test("성과물이 하나도 없는 세션은 성과물 탭에 개수 0과 빈 상태 문장을 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}?tab=outputs`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, repository_id: null, repository: null }),
      [`GET /v1/sessions/${SESSION_ID}/achievements`]: () =>
        json(200, {
          items: [],
          judgment: null,
          judgment_count: 0,
          judge_cost_usd: 0,
        }),
    });
    const panel = await screen.findByRole("tabpanel", { name: /^성과물/ });
    expect(
      await within(panel).findByText("아직 성과물이 없습니다."),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "성과물 0개" })).toBeTruthy();
  });
});

describe("sessionSearch", () => {
  test("keeps only the outputs tab; the chat and anything else read as no tab", async () => {
    const { sessionSearch } = await import("./sessions.tsx");
    expect(sessionSearch({ tab: "outputs" })).toEqual({ tab: "outputs" });
    expect(sessionSearch({ tab: "chat" })).toEqual({});
    expect(sessionSearch({ tab: "nope", other: "x" })).toEqual({});
    expect(sessionSearch({})).toEqual({});
  });
});

describe("세션 상세 머리 경로", () => {
  const trail = async () => {
    const [header] = await screen.findAllByRole("banner");
    return within(header as HTMLElement);
  };

  test("세션 목록으로 가는 링크 다음에 세션 제목이 온다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, title: "결제 오류 고치기" }),
    });
    const bar = await trail();
    expect(await bar.findByText("결제 오류 고치기")).toBeTruthy();
    expect(bar.getByRole("link", { name: "세션" }).getAttribute("href")).toBe(
      "/sessions",
    );
  });

  test("주소 끝에 /가 붙어도 세션 제목을 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}/`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, title: "결제 오류 고치기" }),
    });
    const bar = await trail();
    expect(await bar.findByText("결제 오류 고치기")).toBeTruthy();
  });

  test("제목이 없으면 머리글처럼 짧은 id를 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const bar = await trail();
    expect(await bar.findByText(SESSION_ID.slice(0, 8))).toBeTruthy();
  });

  test("열어 둔 세션을 다시 불러오다 실패하면 예전 제목을 지운다", async () => {
    let visible = true;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        visible
          ? json(200, { ...detail, title: "결제 오류 고치기" })
          : apiError(404, "NOT_FOUND", "Resource not found"),
    });
    const bar = await trail();
    expect(await bar.findByText("결제 오류 고치기")).toBeTruthy();

    visible = false;
    await act(() =>
      services.queryClient.refetchQueries({
        queryKey: keys.session(SESSION_ID),
        exact: true,
      }),
    );
    expect(await screen.findByText(/이 세션을 찾을 수 없습니다/)).toBeTruthy();
    expect(bar.queryByText("결제 오류 고치기")).toBeNull();
    expect(bar.queryByRole("link")).toBeNull();
  });

  test("세션을 불러오지 못하면 빈 이름 앞에 구분선을 남기지 않고 항목 이름만 둔다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        apiError(404, "NOT_FOUND", "no such session"),
    });
    expect(await screen.findByText(/이 세션을 찾을 수 없습니다/)).toBeTruthy();
    const bar = await trail();
    expect(bar.queryByRole("link")).toBeNull();
    expect(bar.getByText("세션")).toBeTruthy();
    expect(bar.queryByText("/")).toBeNull();
  });
});

describe("세션 공유 범위", () => {
  const SHARE_ROUTE = `GET /v1/sessions/${SESSION_ID}/share`;
  const share = (over: Record<string, unknown> = {}) => ({
    session_id: SESSION_ID,
    scope: "workspace",
    user_ids: [],
    team_ids: [],
    revision: 0,
    updated_by: null,
    updated_at: null,
    audience_limited: false,
    ...over,
  });
  const USER = (n: number) =>
    `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
  const TEAM = (n: number) =>
    `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
  const shareReads = (api: { calls: { path: string }[] }) =>
    api.calls.filter((call) => call.path === `/v1/sessions/${SESSION_ID}/share`)
      .length;
  const FAILED = "공유 범위를 확인하지 못했습니다.";

  test.each([
    [share(), "워크스페이스"],
    [
      share({ audience_limited: true }),
      "워크스페이스(담당 팀 밖 사람은 보지 못함)",
    ],
    [share({ scope: "private" }), "세션을 가진 사람만"],
    [share({ scope: "private_channel" }), "비공개 채널의 지금 멤버"],
    [
      share({ scope: "people", user_ids: [USER(1), USER(2), USER(3)] }),
      "지정한 사람 3명",
    ],
    [share({ scope: "team", team_ids: [TEAM(1), TEAM(2)] }), "지정한 팀 2개"],
  ])(
    "머리의 메타 줄 끝에 공유 범위를 읽기 전용으로 보인다: %o → %s",
    async (body, text) => {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [SHARE_ROUTE]: () => json(200, body),
      });
      const meta = await sessionMeta();
      const shown = await within(meta).findByText(text, { exact: false });
      // Named for assistive technology; the icon says nothing.
      expect(shown.textContent).toBe(`공유 범위: ${text}`);
      expect(shown.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
      expect(
        within(meta).queryByRole("button", { name: "다시 시도" }) === null,
      ).toBe(true);
    },
  );

  test.each([
    [404, "NOT_FOUND"],
    [403, "FORBIDDEN"],
  ] as const)("%i이면 공유 범위를 그리지 않는다", async (status, code) => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () => apiError(status, code, "no"),
    });
    const meta = await sessionMeta();
    await waitFor(() => expect(shareReads(api)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((meta.textContent ?? "").includes("공유 범위")).toBe(false);
    expect(within(meta).queryByRole("alert") === null).toBe(true);
  });

  test("이 화면이 모르는 범위는 워크스페이스로 보이지 않고 그리지 않는다", async () => {
    // A newer server's scope. The contract names four, and production only
    // warns about the rest, so it reaches the screen.
    const { api } = renderAt(
      `/sessions/${SESSION_ID}`,
      {
        ...detailRoutes,
        [SHARE_ROUTE]: () => json(200, share({ scope: "agent_only" })),
      },
      "ko",
      "warn",
    );
    const meta = await sessionMeta();
    await waitFor(() => expect(shareReads(api)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((meta.textContent ?? "").includes("공유 범위")).toBe(false);
    expect((meta.textContent ?? "").includes("워크스페이스")).toBe(false);
    expect(within(meta).queryByRole("alert") === null).toBe(true);
  });

  test("읽지 못하면 그 자리에 실패와 다시 시도를 보이고, 다시 읽으면 공유 범위가 보인다", async () => {
    const user = await setupUser();
    let reads = 0;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () =>
        ++reads === 1
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, share({ scope: "private" })),
    });
    const meta = await sessionMeta();
    expect((await within(meta).findByRole("alert")).textContent).toBe(FAILED);
    const retry = within(meta).getByRole("button", { name: "다시 시도" });
    // Another "다시 시도" can sit in the head; this one says what it reads.
    expect(
      document.getElementById(retry.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(FAILED);
    await user.click(retry);
    const shown = await within(meta).findByText(/세션을 가진 사람만/);
    // The pressed retry is gone; focus lands on what it brought.
    expect(document.activeElement === shown).toBe(true);
    expect(shown.textContent).toBe("공유 범위: 세션을 가진 사람만");
    expect(shown.getAttribute("tabindex")).toBe("-1");
    expect(within(meta).queryByRole("alert") === null).toBe(true);
    expect(
      within(meta).queryByRole("button", { name: "다시 시도" }) === null,
    ).toBe(true);
  });

  test("저절로 다시 읽어 공유 범위가 나타나면 초점을 옮기지 않는다", async () => {
    let reads = 0;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () =>
        ++reads === 1
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, share({ scope: "private" })),
    });
    const meta = await sessionMeta();
    await within(meta).findByRole("alert");
    // The window coming back into view reads again; no one pressed retry.
    window.dispatchEvent(new Event("visibilitychange"));
    const shown = await within(meta).findByText(/세션을 가진 사람만/);
    expect(reads).toBe(2);
    expect(document.activeElement === shown).toBe(false);
  });

  test("받은 값이 없을 때 다시 읽는 동안에도 실패 표시가 남고 초점은 다시 시도에 있으며, 두 번 눌러도 한 번 읽는다", async () => {
    const user = await setupUser();
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () =>
        ++reads === 1
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : new Promise<Response>((resolve) => {
              answer = resolve;
            }),
    });
    const meta = await sessionMeta();
    const retry = await within(meta).findByRole("button", {
      name: "다시 시도",
    });
    await user.click(retry);
    await user.click(retry);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(2);
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
    expect(within(meta).getByRole("alert").textContent).toBe(FAILED);
    act(() => answer(apiError(503, "BACKEND_UNAVAILABLE", "down")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement === retry).toBe(true);
  });

  /** The other session's routes, so the screen can move there and back. */
  const otherRoutes = (shareRoute: () => Response | Promise<Response>) => ({
    [`GET /v1/sessions/${OTHER_ID}`]: () =>
      json(200, { ...detail, id: OTHER_ID }),
    [`GET /v1/sessions/${OTHER_ID}/usage`]: () =>
      json(200, { ...usage, session_id: OTHER_ID }),
    [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
      json(200, { answerable: true, items: [] }),
    [`GET /v1/sessions/${OTHER_ID}/events`]: () =>
      new Promise<Response>(() => {}),
    [`GET /v1/sessions/${OTHER_ID}/share`]: shareRoute,
  });

  test("돌아와 다시 읽은 것이 실패하면 받은 값이 있어도 낡은 값 대신 실패를 보인다(staleTime이 없어 돌아올 때 다시 읽는다)", async () => {
    let reads = 0;
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () =>
        ++reads === 1
          ? json(200, share({ scope: "private" }))
          : apiError(503, "BACKEND_UNAVAILABLE", "down"),
      ...otherRoutes(() => json(200, share({ session_id: OTHER_ID }))),
    });
    await within(await sessionMeta()).findByText(/세션을 가진 사람만/);
    // Coming back reads the share again; that read fails.
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    act(() => history.push(`/sessions/${SESSION_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    const meta = await sessionMeta();
    expect((await within(meta).findByRole("alert")).textContent).toBe(FAILED);
    expect(reads).toBe(2);
    expect((meta.textContent ?? "").includes("세션을 가진 사람만")).toBe(false);
  });

  test("다른 세션으로 옮기면 앞 세션의 공유 범위가 보이지 않는다", async () => {
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () =>
        json(200, share({ scope: "people", user_ids: [USER(1)] })),
      // The other session's share never answers.
      ...otherRoutes(() => new Promise<Response>(() => {})),
    });
    await within(await sessionMeta()).findByText(/지정한 사람 1명/);
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const meta = await sessionMeta();
    expect((meta.textContent ?? "").includes("공유 범위")).toBe(false);
  });

  test("받은 값이 있는 채 실패했을 때도 다시 시도를 두 번 누르면 한 번 읽는다", async () => {
    const user = await setupUser();
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () => {
        reads += 1;
        if (reads === 1) return json(200, share({ scope: "private" }));
        if (reads === 2) return apiError(503, "BACKEND_UNAVAILABLE", "down");
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      },
      ...otherRoutes(() => json(200, share({ session_id: OTHER_ID }))),
    });
    await within(await sessionMeta()).findByText(/세션을 가진 사람만/);
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    act(() => history.push(`/sessions/${SESSION_ID}`));
    const meta = await sessionMeta();
    const retry = await within(meta).findByRole("button", {
      name: "다시 시도",
    });
    await user.click(retry);
    await user.click(retry);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(3);
    expect(document.activeElement === retry).toBe(true);
    act(() => answer(json(200, share({ scope: "private" }))));
    expect(await within(meta).findByText(/세션을 가진 사람만/)).toBeTruthy();
  });

  test("돌아와 다시 읽는 동안 다른 세션의 실패를 이 세션의 자리에 보이지 않는다", async () => {
    // This session's own failure draws nothing (404); the other session's
    // draws the alert, so whose failure shows can be told apart.
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () =>
        ++reads === 1
          ? apiError(404, "NOT_FOUND", "no")
          : new Promise<Response>((resolve) => {
              answer = resolve;
            }),
      ...otherRoutes(() => apiError(503, "BACKEND_UNAVAILABLE", "down")),
    });
    await sessionMeta();
    await waitFor(() => expect(reads).toBe(1));
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    await within(await sessionMeta()).findByRole("alert");
    act(() => history.push(`/sessions/${SESSION_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    await waitFor(() => expect(reads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The kept failure is the other session's, which never shows here.
    expect(within(await sessionMeta()).queryByRole("alert") === null).toBe(
      true,
    );
    act(() => answer(json(200, share({ scope: "private" }))));
    expect(
      await within(await sessionMeta()).findByText(/세션을 가진 사람만/),
    ).toBeTruthy();
  });

  test("다른 세션의 실패가 옮긴 세션에 남지 않는다", async () => {
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE_ROUTE]: () => apiError(503, "BACKEND_UNAVAILABLE", "down"),
      ...otherRoutes(() => new Promise<Response>(() => {})),
    });
    await within(await sessionMeta()).findByRole("alert");
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(await sessionMeta()).queryByRole("alert") === null).toBe(
      true,
    );
  });
});

describe("세션의 릴리스", () => {
  const AGENT = {
    id: AGENT_ID,
    name: "Release helper",
    release_version_no: 3,
    release_label: "2026-10-30_14:30:28-2",
    release_is_active: true,
    archived: false,
  };
  const withSession = (body: Record<string, unknown>) => ({
    ...detailRoutes,
    [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, { ...detail, ...body }),
    [`GET /v1/agents/${AGENT_ID}`]:
      agentServer().routes[`GET /v1/agents/${AGENT_ID}`],
  });
  /** The agent piece of the meta line: its link (or name) and the release. */
  const agentPiece = async () => {
    const meta = await sessionMeta();
    const link = await within(meta).findByRole("link", {
      name: "Release helper",
    });
    return { meta, link, piece: link.parentElement as HTMLElement };
  };
  /** What assistive technology is left with: the text minus hidden parts. */
  const spoken = (element: HTMLElement) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll("[aria-hidden=true]"))
      hidden.remove();
    return copy.textContent;
  };
  /** Every part on the meta line's size, line and grey, not the body's. */
  const expectMetaParts = (piece: HTMLElement) => {
    const parts = [...piece.querySelectorAll("[data-slot=text]")];
    expect(parts.length > 0).toBe(true);
    expect(parts.map((part) => part.getAttribute("data-variant"))).toEqual(
      parts.map(() => "meta"),
    );
    const shown = parts.filter((part) => !part.matches(".sr-only"));
    expect(
      shown.map((part) => part.classList.contains("text-muted-foreground")),
    ).toEqual(shown.map(() => true));
  };

  test.each([
    [{}, "2026-10-30_14:30:28-2", "2026-10-30_14:30:28-2"],
    [{ release_label: null }, "버전 3", "버전 3"],
    [
      { release_is_active: false },
      "2026-10-30_14:30:28-2 · 활성 릴리스 아님",
      "2026-10-30_14:30:28-2 활성 릴리스 아님",
    ],
    [
      { release_is_active: null },
      "2026-10-30_14:30:28-2",
      "2026-10-30_14:30:28-2",
    ],
  ])(
    "에이전트 이름 뒤에 그 세션이 쓰는 릴리스를 보이고, 활성이 아니라고 할 때만 그렇게 적는다: %o",
    async (over, text, said) => {
      renderAt(
        `/sessions/${SESSION_ID}`,
        withSession({ agent: { ...AGENT, ...over } }),
      );
      const { piece, link } = await agentPiece();
      expect(piece.textContent).toBe(
        `에이전트: Release helper· 이 세션이 쓰는 릴리스: ${text}`,
      );
      // Hiding the dots keeps the spaces between the words they part.
      expect(spoken(piece)).toBe(
        `에이전트: Release helper 이 세션이 쓰는 릴리스: ${said}`,
      );
      // The release sits outside the link, whose name stays the agent's.
      expect(link.textContent).toBe("Release helper");
      expectMetaParts(piece);
    },
  );

  test("에이전트를 열 수 없는 사람에게도 이름 글 뒤에 릴리스를 보인다", async () => {
    let asked = 0;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...withSession({ agent: { ...AGENT, release_is_active: false } }),
      [`GET /v1/agents/${AGENT_ID}`]: () => {
        asked += 1;
        return apiError(403, "FORBIDDEN", "may not read");
      },
    });
    const meta = await sessionMeta();
    await waitFor(() => expect(asked).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      within(meta).queryByRole("link", { name: /Release helper/ }) === null,
    ).toBe(true);
    // The name is plain text, so its own element is the agent piece.
    const piece = within(meta).getByText("Release helper");
    expect(piece.textContent).toBe(
      "에이전트: Release helper· 이 세션이 쓰는 릴리스: 2026-10-30_14:30:28-2 · 활성 릴리스 아님",
    );
    expect(spoken(piece)).toBe(
      "에이전트: Release helper 이 세션이 쓰는 릴리스: 2026-10-30_14:30:28-2 활성 릴리스 아님",
    );
    expectMetaParts(piece);
  });

  test.each([
    ["ko", "보관됨"],
    ["en", "Archived"],
    ["ja", "アーカイブ済み"],
  ] as const)(
    "보관된 에이전트는 이름 뒤, 릴리스 앞에 '보관됨' 배지를 붙이고 이름 링크는 그대로다: %s",
    async (locale, word) => {
      renderAt(
        `/sessions/${SESSION_ID}`,
        withSession({ agent: { ...AGENT, archived: true } }),
        locale,
      );
      const meta = await sessionMeta();
      const link = await within(meta).findByRole("link", {
        name: "Release helper",
      });
      const piece = link.parentElement as HTMLElement;
      const badge = within(piece).getByText(word);
      expect(badge.getAttribute("data-slot")).toBe("badge");
      expect(link.textContent).toBe("Release helper");
      // Name, then the badge, then the release.
      const order = [...piece.children].map(
        (child) => child.getAttribute("data-slot") ?? child.tagName,
      );
      expect(order.indexOf("badge")).toBe(order.indexOf("A") + 1);
      expect(
        (piece.textContent ?? "").indexOf(word) <
          (piece.textContent ?? "").indexOf("2026-10-30_14:30:28-2"),
      ).toBe(true);
    },
  );

  test.each([false, null])(
    "보관되지 않은 에이전트에는 배지가 없다: archived=%p",
    async (archived) => {
      renderAt(
        `/sessions/${SESSION_ID}`,
        withSession({ agent: { ...AGENT, archived } }),
      );
      const { piece } = await agentPiece();
      expect(piece.querySelector("[data-slot=badge]") === null).toBe(true);
      expect((piece.textContent ?? "").includes("보관됨")).toBe(false);
    },
  );

  test("라벨도 버전도 없으면 릴리스를 그리지 않는다", async () => {
    // A server answering outside the contract; production only warns.
    renderAt(
      `/sessions/${SESSION_ID}`,
      withSession({
        agent: { ...AGENT, release_label: null, release_version_no: null },
      }),
      "ko",
      "warn",
    );
    const { piece } = await agentPiece();
    expect(piece.textContent).toBe("에이전트: Release helper");
    expect((piece.textContent ?? "").includes("null")).toBe(false);
  });

  test.each([
    ["에이전트 없이 만든 세션", { agent: null }, "에이전트 없음"],
    [
      "볼 수 없는 에이전트의 세션",
      { agent: null, agent_hidden: true },
      "볼 수 없는 에이전트",
    ],
  ])(
    "%s의 에이전트 조각은 '%s'뿐이고 릴리스를 그리지 않는다",
    async (_, body, words) => {
      renderAt(`/sessions/${SESSION_ID}`, withSession(body));
      const meta = await sessionMeta();
      // The words stand alone, so their own element is the agent piece.
      const piece = await within(meta).findByText(words);
      expect(piece.textContent).toBe(`에이전트: ${words}`);
      expect(spoken(piece)).toBe(`에이전트: ${words}`);
      expect(within(piece).queryByRole("link") === null).toBe(true);
      expect(piece.querySelectorAll("[data-slot=text]")).toHaveLength(0);
      // Nor anywhere else on the line, outside the piece.
      expect((meta.textContent ?? "").includes("릴리스")).toBe(false);
    },
  );
});

describe("session steps", () => {
  const turn = (
    turn_id: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    turn_id,
    session_id: SESSION_ID,
    status,
    message: `지시 ${turn_id}`,
    channel: "web",
    created_by: null,
    slack_permalink: null,
    terminal_reason: null,
    checkpoint_revision: null,
    created_at: AT,
    started_at: AT,
    ended_at: status === "running" || status === "needs_input" ? null : AT,
    ...extra,
  });
  const waitingOnTwo = {
    ...detailRoutes,
    [`GET /v1/sessions/${SESSION_ID}`]: () =>
      json(200, { ...detail, current_turn_id: "2", attention: null }),
    [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
      json(200, {
        // As the API projects it: the turn with an open request reads needs_input.
        items: [turn("1", "completed"), turn("2", "needs_input")],
        next_cursor: null,
      }),
    [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
      json(200, {
        ...pending,
        items: pending.items.map((item) => ({
          ...item,
          turn_id: "2",
          expires_at: LATER,
        })),
      }),
  };

  /** The step list starts closed: opens it by the head's step count. */
  const openSteps = async (name = /^단계 /, region = "단계") => {
    const user = await setupUser();
    await user.click(
      await within(await sessionProgress()).findByRole("button", { name }),
    );
    return screen.getByRole("region", { name: region });
  };

  /** The badges the head's progress line draws. */
  const headStates = (progress: HTMLElement) =>
    [...progress.querySelectorAll("[data-slot='badge']")].map(
      (badge) => badge.textContent,
    );

  test("starts closed, saying in the head what waits, and opens and closes by keyboard", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, waitingOnTwo);
    const progress = await sessionProgress();
    const toggle = await within(progress).findByRole("button", {
      name: /^단계 2\/2/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "단계" })).toBeNull();
    await waitFor(() => expect(headStates(progress)).toEqual(["승인 대기"]));

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "단계" }).id).toBe(
      toggle.getAttribute("aria-controls") ?? "",
    );
    // Open, the rows say it themselves.
    expect(headStates(progress)).toEqual([]);
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "단계" })).toBeNull();
    expect(headStates(progress)).toEqual(["승인 대기"]);
  });

  test.each([
    ["a running step", ["completed", "running"], ["진행 중"]],
    ["finished steps only", ["completed", "failed"], []],
  ] as const)("the closed head over %s", async (_, statuses, said) => {
    const current = statuses[1] === "running" ? "2" : null;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          status: current ? "running" : "idle",
          current_turn_id: current,
          pending_request_count: 0,
          attention: null,
        }),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, {
          items: statuses.map((status, index) =>
            turn(String(index + 1), status),
          ),
          next_cursor: null,
        }),
    });
    const progress = await sessionProgress();
    const toggle = await within(progress).findByRole("button", {
      name: /^단계 /,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(headStates(progress)).toEqual([...said]);
  });

  test("another session's step list starts closed", async () => {
    const other = Object.fromEntries(
      Object.entries(waitingOnTwo).map(([route, answer]) => [
        route.replace(SESSION_ID, OTHER_ID),
        answer,
      ]),
    );
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...other,
      ...waitingOnTwo,
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        json(200, {
          ...detail,
          session_id: OTHER_ID,
          title: "다른 세션",
          current_turn_id: "2",
          attention: null,
        }),
    });
    await openSteps();
    await act(async () => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", { level: 1, name: /다른 세션/ });
    const toggle = await within(await sessionProgress()).findByRole("button", {
      name: /^단계 /,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Nor does the first one come back open.
    await act(async () => history.push(`/sessions/${SESSION_ID}`));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /다른 세션/ })).toBeNull(),
    );
    const back = await within(await sessionProgress()).findByRole("button", {
      name: /^단계 /,
    });
    expect(back.getAttribute("aria-expanded")).toBe("false");
  });

  test("reads the turns again when they show a turn running that the session no longer runs", async () => {
    let turnReads = 0;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          status: "idle",
          current_turn_id: null,
          attention: null,
        }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () => {
        turnReads += 1;
        return json(200, {
          // The second read still lags; only the third has caught up.
          items: [turn("1", turnReads <= 2 ? "running" : "completed")],
          next_cursor: null,
        });
      },
    });
    const list = await openSteps();
    await waitFor(
      () =>
        expect(within(list).getByRole("listitem").textContent).toContain(
          "마침",
        ),
      { timeout: 4_000 },
    );
    expect(turnReads).toBeGreaterThanOrEqual(3);
    expect(
      within(list).getByRole("listitem").getAttribute("aria-current"),
    ).toBeNull();
    const reads = turnReads;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // Once the reads agree, the rechecks stop.
    expect(turnReads).toBe(reads);
  });

  test("reads the turns again when the session counts a queued turn they lack", async () => {
    let turnReads = 0;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          status: "running",
          current_turn_id: "1",
          queued_turn_count: 1,
          attention: null,
        }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () => {
        turnReads += 1;
        return json(200, {
          // Another client queued turn 2; the first read missed it.
          items:
            turnReads === 1
              ? [turn("1", "running")]
              : [
                  turn("1", "running"),
                  turn("2", "queued", { started_at: null }),
                ],
          next_cursor: null,
        });
      },
    });
    const progress = await sessionProgress();
    await within(progress).findByRole(
      "button",
      { name: /^단계 1\/2/ },
      { timeout: 4_000 },
    );
  });

  test("counts the turns as steps, opens only the current one and marks its approval wait", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, waitingOnTwo);
    const progress = await sessionProgress();
    const toggle = await within(progress).findByRole("button", {
      name: /^단계 2\/2/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("region", { name: "단계" });
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);
    const [first, second] = within(list).getAllByRole("listitem");
    expect(second?.getAttribute("aria-current")).toBe("step");
    expect(first?.getAttribute("aria-current")).toBeNull();
    const open = within(second as HTMLElement).getByRole("button", {
      name: /2단계: 지시 2/,
    });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(open.textContent).toContain("승인 대기, 지금 단계");
    expect(
      within(second as HTMLElement).getByText("승인을 기다리는 도구: Bash"),
    ).toBeTruthy();
    // The open turn's time runs from its start.
    expect(second?.textContent).toMatch(/시작한 지 /);
    const closed = within(first as HTMLElement).getByRole("button", {
      name: /1단계: 지시 1/,
    });
    expect(closed.textContent).toContain("마침");
    expect(closed.textContent).not.toContain("지금 단계");
    expect(closed.getAttribute("aria-expanded")).toBe("false");

    // Any step opens by its row; the count folds the whole list.
    await user.click(closed);
    expect(closed.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(list.hidden).toBe(true);
  });

  test("says the viewer's input is needed and takes the keyboard to the requests", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, waitingOnTwo);
    const needed = await screen.findByRole("region", {
      name: "내 입력이 필요합니다",
    });
    expect(needed.textContent).toContain("승인 1건");
    await screen.findByRole("article", { name: "권한 요청: Bash" });
    await user.click(within(needed).getByRole("button", { name: "요청 보기" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("답변 대기 요청"),
    );
  });

  test("a viewer who may not answer is not told their input is needed", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...waitingOnTwo,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          ...pending,
          answerable: false,
          items: pending.items.map((item) => ({
            ...item,
            turn_id: "2",
            expires_at: LATER,
          })),
        }),
    });
    const list = await openSteps();
    // The step still waits on approval; it is only not this viewer's to give.
    await within(list).findByText("승인 대기");
    expect(
      screen.queryByRole("region", { name: "내 입력이 필요합니다" }),
    ).toBeNull();
  });

  test("an answer read before the turn is read again leaves no wait behind", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...waitingOnTwo,
      // The session read after the answer: running, nothing open.
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          status: "running",
          current_turn_id: "2",
          pending_request_count: 0,
          attention: null,
        }),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
    });
    const list = await openSteps();
    await within(list).findByText("진행 중");
    expect(within(list).queryByText("승인 대기")).toBeNull();
    expect(within(list).queryByText("답변 대기")).toBeNull();
  });

  test("a request past its expiry neither asks for input nor holds its step", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...waitingOnTwo,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          ...pending,
          // AT is long past.
          items: pending.items.map((item) => ({ ...item, turn_id: "2" })),
        }),
    });
    const list = await openSteps();
    await within(list).findByText("진행 중");
    expect(within(list).queryByText("승인 대기")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "내 입력이 필요합니다" }),
    ).toBeNull();
  });

  test("a request that lapses while the screen is open leaves the input line and its step", async () => {
    const soon = new Date(Date.now() + 1_000).toISOString();
    renderAt(`/sessions/${SESSION_ID}`, {
      ...waitingOnTwo,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          ...pending,
          items: pending.items.map((item) => ({
            ...item,
            turn_id: "2",
            expires_at: soon,
          })),
        }),
    });
    const needed = await screen.findByRole("region", {
      name: "내 입력이 필요합니다",
    });
    const list = await openSteps();
    expect(within(list).getByText("승인 대기")).toBeTruthy();
    await waitFor(() => expect(needed.isConnected).toBe(false), {
      timeout: 3_000,
    });
    expect(within(list).queryByText("승인 대기")).toBeNull();
  });

  test("a session nothing waits on has no input-needed line", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...waitingOnTwo,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
    });
    expect(within(await openSteps()).queryByText("승인 대기")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "내 입력이 필요합니다" }),
    ).toBeNull();
  });

  test("a blocked session says why under its steps, with the fix where it is", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/agents/${AGENT_ID}`]:
        agentServer().routes[`GET /v1/agents/${AGENT_ID}`],
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          status: "idle",
          current_turn_id: null,
          pending_request_count: 0,
          agent: {
            id: AGENT_ID,
            name: "Release helper",
            release_version_no: 3,
            release_label: "2026-10-30_14:30:28-2",
            release_is_active: true,
            archived: false,
          },
          attention: {
            code: "CATALOG_MISMATCH",
            reason: "connection_disabled",
          },
        }),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, { items: [turn("1", "completed")], next_cursor: null }),
    });
    const toggle = await within(await sessionProgress()).findByRole("button", {
      name: /^단계 1개/,
    });
    const reason =
      "다음 단계를 시작하지 못합니다. 모델 연결이나 저장소 설정이 바뀌어 실행할 수 없습니다.";
    const fix = { name: "에이전트 설정 열기" };
    // Closed, the reason and its fix stand outside the hidden list.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const shown = () =>
      screen.getAllByText(reason).filter((el) => !el.closest("[hidden]"));
    expect(shown()).toHaveLength(1);
    await screen.findByRole("link", fix);
    const list = await openSteps(/^단계 1개/);
    // Open, they show once, under the steps.
    expect(within(list).getByText(reason)).toBeTruthy();
    expect(screen.getAllByText(reason)).toHaveLength(1);
    expect(screen.getAllByRole("link", fix)).toHaveLength(1);
    // Nothing runs, so no step is current or open.
    const [only] = within(list).getAllByRole("listitem");
    expect(only?.getAttribute("aria-current")).toBeNull();
  });

  test("a blocked step's reason shows closed, and only in its step once open", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...waitingOnTwo,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          current_turn_id: "2",
          attention: {
            code: "CATALOG_MISMATCH",
            reason: "connection_disabled",
          },
        }),
    });
    const reason = "모델 연결이나 저장소 설정이 바뀌어 실행할 수 없습니다.";
    const progress = await sessionProgress();
    // The head's own copy: the hidden list holds another, outside this line.
    expect(await within(progress).findByText(reason)).toBeTruthy();
    const list = await openSteps();
    const [, second] = within(list).getAllByRole("listitem");
    expect(within(second as HTMLElement).getByText(reason)).toBeTruthy();
    expect(screen.getAllByText(reason)).toHaveLength(1);
  });

  test("a step a lost worker cut off offers to continue in its place", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          status: "idle",
          current_turn_id: null,
          pending_request_count: 0,
          attention: null,
        }),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${SESSION_ID}/turns`]: () =>
        json(200, {
          items: [
            turn("1", "failed", { terminal_reason: "worker_ownership_lost" }),
          ],
          next_cursor: null,
        }),
    });
    const list = await openSteps();
    const [only] = within(list).getAllByRole("listitem");
    expect(
      await within(only as HTMLElement).findByText(
        "작업자가 세션을 놓쳐 이 단계가 중간에 끊겼습니다.",
      ),
    ).toBeTruthy();
    expect(
      within(only as HTMLElement).getByRole("button", {
        name: "이 단계 이어서 하기",
      }),
    ).toBeTruthy();
  });

  test.each([
    [
      "en",
      /^Step 2\/2/,
      "Awaiting approval",
      "Your input is needed",
      "View requests",
    ],
    [
      "ja",
      /^ステップ 2\/2/,
      "承認待ち",
      "あなたの入力が必要です",
      "リクエストを見る",
    ],
  ] as const)(
    "in %s the steps and the input line speak it",
    async (locale, count, waiting, needed, show) => {
      renderAt(`/sessions/${SESSION_ID}`, waitingOnTwo, locale);
      const progress = await sessionProgress();
      await within(progress).findByRole("button", { name: count });
      // Closed, the head already says what the step waits on.
      expect(await within(progress).findByText(waiting)).toBeTruthy();
      const [, second] = within(
        await openSteps(count, locale === "en" ? "Steps" : "ステップ"),
      ).getAllByRole("listitem");
      expect(within(second as HTMLElement).getByText(waiting)).toBeTruthy();
      const line = await screen.findByRole("region", { name: needed });
      expect(within(line).getByRole("button", { name: show })).toBeTruthy();
    },
  );
});
