import { beforeEach, describe, expect, test } from "bun:test";
import { focusManager } from "@tanstack/react-query";
import type {
  ListPendingRequestsResponse,
  ListProfilesResponse,
  ProfileSummary,
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

const { renderAt, screen, waitFor, act, within, fireEvent } =
  await appHarness();

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

/** Switches the timeline from focus to every event. */
async function showAllEvents() {
  const view = await screen.findByRole("group", { name: "타임라인 보기" });
  await (await setupUser()).click(
    within(view).getByRole("button", { name: "전체" }),
  );
}
const EVENTS_ROUTE = `GET /v1/sessions/${SESSION_ID}/events`;

/** Opens the relation chip and picks one by its label. */
async function pickRelation(
  user: Awaited<ReturnType<typeof setupUser>>,
  label: string,
) {
  await user.click(screen.getByRole("button", { name: /^관계 / }));
  const menu = await screen.findByRole("dialog", { name: "관계" });
  await user.click(within(menu).getByRole("button", { name: label }));
}

function summary(id: string, overrides: Partial<SessionSummary> = {}) {
  return {
    id,
    revision: 3,
    admission_state: "active",
    status: "running",
    runtime: {
      kind: "claude_agent_sdk",
      version: "1.0.0",
      profile_id: "default",
      model: "model-default",
      permission_mode: "default",
    },
    repository_id: "demo",
    current_turn_id: "1",
    queued_turn_count: 0,
    model: "model-default",
    last_event_at: AT,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  } as SessionSummary;
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

function profile(id: string, overrides: Partial<ProfileSummary> = {}) {
  return {
    id,
    source: "operator",
    model: `model-${id}`,
    models: [overrides.model ?? `model-${id}`],
    tools: ["Read"],
    permission_mode: "default",
    runtime_kind: "claude_agent_sdk",
    runtime_version: "1.0.0",
    billing: "metered",
    repository_mode: "required",
    ...overrides,
  } satisfies ProfileSummary;
}

const profiles: ListProfilesResponse = {
  items: [
    profile("default"),
    profile("fast"),
    profile("other-runtime", { runtime_version: "2.0.0" }),
    profile("free", { billing: "none" }),
  ],
};

const detailRoutes = {
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/profiles": () => json(200, profiles),
  [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, detail),
  [`GET /v1/sessions/${SESSION_ID}/usage`]: () => json(200, usage),
  [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () => json(200, pending),
  [EVENTS_ROUTE]: (request: Request) => stream.route(request),
};

describe("approval inbox", () => {
  // A line names its session on its one button.
  const DETAIL = `${SESSION_ID.slice(0, 8)} 답하기`;
  // The line opens the session in the rail, where the request is answered.
  const allowInRail = async (user: Awaited<ReturnType<typeof setupUser>>) => {
    await user.click(await screen.findByRole("button", { name: DETAIL }));
    const rail = await screen.findByRole("complementary", {
      name: SESSION_ID.slice(0, 8),
    });
    // The form waits for the stream to say where the request was asked.
    await act(async () => stream.open());
    return within(rail).findByRole("button", { name: /^허용/ });
  };
  const waitingRoutes = (items: unknown[], next_cursor: string | null) => ({
    "GET /v1/auth/me": () => json(200, me()),
    [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, detail),
    [EVENTS_ROUTE]: (request: Request) => stream.route(request),
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
    expect(
      await within(inbox).findAllByRole("button", { name: DETAIL }),
    ).toHaveLength(1);
    // The line answers nothing itself.
    expect(within(inbox).queryByRole("button", { name: /^허용/ })).toBeNull();
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
    const allow = await allowInRail(user);
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

  test("an answer from the inbox reads the waiting tab again", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions?status=needs_input", {
      ...waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], null),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const list = await screen.findByRole("table");
    await within(list).findByRole("link", { name: opener(SESSION_ID) });
    const waitingReads = () =>
      api.calls.filter((call) => call.search === "?status=needs_input").length;
    await waitFor(() => expect(waitingReads()).toBe(2));
    await user.click(await allowInRail(user));
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    // The inbox's page and the tab's list are separate queries: both read again.
    await waitFor(() => expect(waitingReads()).toBeGreaterThanOrEqual(4));
  });

  test("a session answered in the rail leaves; closing the rail hands focus to the inbox heading", async () => {
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
    (await screen.findByRole("button", { name: DETAIL })).focus();
    await user.keyboard("{Enter}");
    const rail = await screen.findByRole("complementary", {
      name: SESSION_ID.slice(0, 8),
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(rail.querySelector("h2")),
    );
    await act(async () => stream.open());
    (await within(rail).findByRole("button", { name: /^허용/ })).focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("답을 기다리는 세션이 없습니다."),
    ).toBeTruthy();
    // The rail keeps the keyboard while the line leaves behind it.
    expect(rail.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "답변 대기" }),
      ),
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
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: "next-1",
            }),
    });

    const link = await screen.findByRole("link", { name: opener(SESSION_ID) });
    expect(link.getAttribute("href")).toBe(`/sessions/${SESSION_ID}`);
    const row = link.closest('[role="row"]') as HTMLElement;
    // Untitled: the row shows the id's head, the link keeps the whole id.
    expect(within(row).getByText(SESSION_ID.slice(0, 8))).toBeTruthy();
    expect(row.textContent).toContain("작업 상태: 쉬는 중");
    expect(within(row).getByText("model-default")).toBeTruthy();
    expect(within(row).getByText("demo")).toBeTruthy();
    expect(screen.getByText(/나에게 공유된 세션입니다/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
    expect(
      api.calls.filter(
        (call) =>
          call.path === "/v1/sessions" && call.search !== "?status=needs_input",
      ),
    ).toHaveLength(2);
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

    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.getByRole("link", { name: opener(SESSION_ID) })).toBeTruthy();
    expect(nextCalls).toBe(2);
  });

  test("a next page refused for access says so under the rows, with no retry", async () => {
    const user = await setupUser();
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("cursor") === "next-1"
          ? apiError(403, "FORBIDDEN", "not allowed")
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: "next-1",
            }),
    });

    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    await screen.findByText("이 화면을 볼 권한이 없습니다");
    expect(screen.getByRole("link", { name: opener(SESSION_ID) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  test("a failed next page keeps the rows, and retry pressed again while asking asks once", async () => {
    const user = await setupUser();
    let release = () => {};
    let nextCalls = 0;
    const { api } = renderAt("/sessions", {
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

    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    const alert = await screen.findByRole("alert");
    // The rows already read stay above the failure.
    expect(screen.getByRole("link", { name: opener(SESSION_ID) })).toBeTruthy();
    const retry = within(alert).getByRole("button", { name: "다시 시도" });
    await user.click(retry);
    await waitFor(() =>
      expect(retry.getAttribute("aria-disabled")).toBe("true"),
    );
    await user.click(retry);
    await user.click(retry);
    release();
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      api.calls.filter((call) => call.search === "?cursor=next-1"),
    ).toHaveLength(2);
  });

  test("from the keyboard 더 보기 keeps the focus, asks once, and hands it to the new row at the end", async () => {
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

    const more = await screen.findByRole("button", { name: "더 보기" });
    await act(async () => more.focus());
    await user.keyboard("{Enter}");
    await screen.findByRole("alert");
    // A failed page keeps 더 보기, and the keyboard on it.
    expect(screen.getByRole("button", { name: "더 보기" }) === more).toBe(true);
    expect(document.activeElement === more).toBe(true);

    failing = false;
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "불러오는 중…" });
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement === more).toBe(true);
    await user.keyboard("{Enter}");
    release();
    const added = await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
    await waitFor(() => expect(document.activeElement === added).toBe(true));
    expect(
      api.calls.filter((call) => call.search === "?cursor=next-1"),
    ).toHaveLength(2);
  });

  test("a refresh that failed under a shown list is retried as a refresh", async () => {
    const user = await setupUser();
    let firstPageCalls = 0;
    const { services } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        ++firstPageCalls === 2
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: null,
            }),
    });

    await screen.findByRole("link", { name: opener(SESSION_ID) });
    await services.queryClient.invalidateQueries({ queryKey: keys.sessions });
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull(),
    );
    expect(firstPageCalls).toBe(3);
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
    expect(screen.getByRole("searchbox", { name: "Find by title or ID" }));
    expect(screen.queryByText(/세션/)).toBeNull();
    // Focus opens the exact time in a Tooltip; no title attribute is left.
    const time = row.querySelector("time") as HTMLElement;
    expect(time.hasAttribute("title")).toBe(false);
    act(() => time.focus());
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toMatch(
        /^October 11, 2026/,
      ),
    );
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
    expect(within(bare).getByText("저장소 없음")).toBeTruthy();
    // No agent and no starter in the summary: placeholders, not guesses.
    expect(within(bare).getAllByText("—")).toHaveLength(2);
  });

  test("a row shows its agent over the model and who started it", async () => {
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
              },
              created_by: { user_id: OTHER_ID, display_name: "김하나" },
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
    ).toEqual([
      "세션",
      "상태",
      "에이전트 · 모델",
      "저장소",
      "시작한 사람",
      "최근",
    ]);
    const cells = within(
      link.closest('[role="row"]') as HTMLElement,
    ).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual([
      expect.stringContaining("배포 점검"),
      expect.any(String),
      "Release helpermodel-default",
      expect.stringContaining("demo"),
      "김하나",
      expect.any(String),
    ]);
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
    expect(reads.map((call) => call.search)).toContain("?q=readme");
    // Only the settled text goes out, not each keystroke.
    expect(
      reads
        .filter((call) => call.search.startsWith("?q="))
        .map((c) => c.search),
    ).toEqual(["?q=readme"]);
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
    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("link", { name: opener(THIRD_ID) });

    await user.click(screen.getByRole("button", { name: "실패" }));
    await waitFor(() => expect(answer).toBeDefined());
    expect(screen.getByRole("link", { name: opener(THIRD_ID) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
    act(() => answer?.());
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    const failedReads = api.calls.filter((call) =>
      call.search.includes("status=failed"),
    );
    expect(failedReads.map((call) => call.search)).toEqual(["?status=failed"]);
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
    await user.click(screen.getByRole("button", { name: "관계 모든 관계" }));
    const menu = await screen.findByRole("dialog", { name: "관계" });
    expect(
      within(menu)
        .getAllByRole("button")
        .map((option) => option.textContent),
    ).toEqual(["모든 관계", "내가 시작", "공유받음", "관리하는 에이전트"]);

    await user.click(within(menu).getByRole("button", { name: "공유받음" }));
    await screen.findByRole("link", { name: opener(OTHER_ID) });
    expect(
      screen.getByRole("button", { name: "관계 공유받음" }).dataset.filtered,
    ).toBe("");
    expect(history.location.search).toContain("relation=shared");
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/sessions" && call.search === "?relation=shared",
      ),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "실패" }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.path === "/v1/sessions" &&
            call.search === "?status=failed&relation=shared",
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
              },
              total: 15,
            })
          : apiError(400, "INVALID_REQUEST", "wrong relation"),
    });
    const tabs = await screen.findByRole("group", { name: "상태로 보기" });
    await waitFor(() =>
      expect(
        within(tabs)
          .getAllByRole("button")
          .map((tab) => tab.textContent),
      ).toEqual([
        "전체 15",
        "답변 대기 3",
        "작업 중 2",
        "쉬는 중 4",
        "멈춤 5",
        "실패 0",
      ]),
    );
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
    ).toEqual(["전체", "답변 대기", "작업 중", "쉬는 중", "멈춤", "실패"]);
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
      expect(table.textContent).toContain("작업 상태: 답변 대기 · 12분"),
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
      expect(table.textContent).toContain("작업 상태: 답변 대기 · 2시간"),
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
    ).toEqual(["전체", "답변 대기", "작업 중", "쉬는 중", "멈춤", "실패"]);
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
          call.path === "/v1/sessions" && call.search === "?status=failed",
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
      api.calls.filter((call) => call.search === "?status=failed").length;
    await waitFor(() => expect(failedReads()).toBe(1));
    for (const expected of [2, 3]) {
      await act(() =>
        services.queryClient.invalidateQueries({
          queryKey: keys.sessions,
          exact: true,
        }),
      );
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
    await pickRelation(user, "내가 시작");
    await waitFor(() => expect(counts()).toHaveLength(2));
    expect(counts()[1]?.search).toBe("?relation=started");
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
  test("shows status, cost, pending requests and streamed events", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);

    expect(await screen.findByText("답변 대기")).toBeTruthy();
    // Why no new turn starts sits above the composer it holds back.
    expect(
      await within(screen.getByRole("tabpanel")).findByText(
        "한도에 도달해 새 턴을 시작하지 않습니다.",
      ),
    ).toBeTruthy();
    await setupInfo();
    expect(screen.getByText("BUDGET_EXCEEDED")).toBeTruthy();
    const info = within(screen.getByRole("tabpanel"));
    expect(info.getByText("<$0.01")).toBeTruthy();
    expect(screen.getByText("$25.00")).toBeTruthy();
    expect(info.getByText("1234")).toBeTruthy();
    expect(
      info.getByText(/진행 중인 턴이 있어 아직 확정되지 않았습니다/),
    ).toBeTruthy();
    expect(
      info.getByText("한도에 도달해 새 턴을 시작하지 않습니다."),
    ).toBeTruthy();
    await (await setupUser()).click(screen.getByRole("tab", { name: "진행" }));
    expect(await screen.findByText("권한 요청: Bash")).toBeTruthy();

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
    // Focus folds the call under what it did; the reply stays open.
    expect(screen.queryByText("도구 호출")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^실행한 명령 1개/ }),
    ).toBeTruthy();
    expect(screen.queryByText("tool_use")).toBeNull();
    // Only the latest status is announced; the list itself is not live.
    const list = screen.getByText("Listing files").closest("ol");
    expect(list?.getAttribute("aria-live")).toBeNull();
    expect(
      screen.getByRole("tabpanel").querySelector("output.sr-only")?.textContent,
    ).toBe("작업 중");
    expect(
      screen.getByRole("complementary", { name: "세션 요약" }),
    ).toBeTruthy();

    act(() =>
      stream.emit("ev_5", "system", {
        type: "system",
        engine_event: { name: "command_lifecycle", category: "internal" },
      }),
    );
    expect(screen.queryByText("command_lifecycle")).toBeNull();
    await showAllEvents();
    expect(await screen.findByText("command_lifecycle")).toBeTruthy();
    expect(screen.getByText("도구 호출")).toBeTruthy();

    // The session reporting an error is an event, not a lost connection.
    act(() =>
      stream.emit("ev_4", "error", { message: "engine crashed", code: "X" }),
    );
    expect(await screen.findByText("engine crashed")).toBeTruthy();
    expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull();

    // A dropped connection resumes after the last event drawn, and what
    // arrives after it is drawn too.
    act(() => stream.drop());
    expect(await screen.findByText("이벤트에 연결하는 중…")).toBeTruthy();
    expect(stream.requests.at(-1)?.headers.get("last-event-id")).toBe("ev_4");
    await act(async () => stream.open());
    await waitFor(() =>
      expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull(),
    );
    act(() =>
      stream.emit("ev_6", "assistant", {
        type: "assistant",
        text: "Back again",
      }),
    );
    expect(await screen.findByText("Back again")).toBeTruthy();

    act(() => stream.fail());
    expect(
      await screen.findByText(
        "이벤트 연결이 끊겼습니다. 새로고침하면 다시 연결합니다.",
      ),
    ).toBeTruthy();
  });

  test("a tool result keeps its tool's name after the call leaves the window", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => {
      stream.emit("ev_call", "tool_use", {
        type: "assistant",
        tool_call: { id: "tu_1", name: "Bash", input: { command: "make" } },
      });
      stream.emit("ev_result", "tool_result", {
        tool_result: { tool_call_id: "tu_1", is_error: false, text: "built" },
      });
      for (let i = 0; i < 199; i += 1) {
        stream.emit(`ev_s${i}`, "status", { phase: "running" });
      }
    });
    await showAllEvents();
    expect(await screen.findByText("Bash 결과 · 성공 · built")).toBeTruthy();
    expect(screen.queryByText("Bash: make")).toBeNull();
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
    // Focus folds the call, and its line says it still runs.
    const fold = await screen.findByRole("button", {
      name: "실행한 명령 1개 · 실행 중",
    });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    await (await setupUser()).click(fold);
    const call = (await screen.findByText("Bash: make")).closest("li");
    expect(call?.textContent).toContain("실행 중");
    act(() =>
      stream.emit("ev_result", "tool_result", {
        tool_result: { tool_call_id: "tu_1", is_error: false, text: "built" },
      }),
    );
    expect(await screen.findByText("Bash 결과 · 성공 · built")).toBeTruthy();
    expect(fold.textContent).toBe("실행한 명령 1개");
    const list = screen.getByRole("list", { name: "이벤트" });
    // The fold's line and the call it opened, the result in the call's row.
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list.textContent).not.toContain("실행 중");
  });

  test("focus folds earlier status lines into one button and keeps the latest open", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => {
      stream.emit("ev_s1", "status", { phase: "running" });
      stream.emit("ev_s2", "status", { phase: "needs_input" });
      stream.emit("ev_s3", "status", { phase: "idle" });
    });
    const toggle = await screen.findByRole("button", { name: "이벤트 2개" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = screen.getByRole("list", { name: "이벤트" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    await (await setupUser()).click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list.querySelectorAll("li")).toHaveLength(4);
    // The view is remembered for the next session screen.
    await showAllEvents();
    expect(screen.queryByRole("button", { name: "이벤트 2개" })).toBeNull();
    expect(globalThis.localStorage.getItem("werft.session.timeline.view")).toBe(
      "all",
    );
  });

  test("each turn opens with the message it was asked, read again as turns start", async () => {
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
    let turns = [
      turn("1", "첫 지시", "slack", "김민아"),
      turn("3", "아직 줄 선 지시"),
    ];
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
    const asked = async (turnId: string) => {
      const head = await screen.findByText(`턴 ${turnId}`);
      const group = head.closest("[data-slot='timeline-turn']");
      return group?.querySelector("[data-slot='message']") ?? null;
    };
    const first = await asked("1");
    expect(first?.getAttribute("data-from")).toBe("user");
    expect(first?.textContent).toContain("김민아 · Slack");
    expect(first?.textContent).toContain("첫 지시");
    const fromSlack = within(first as HTMLElement).getByRole("link", {
      name: "Slack에서 보기 (새 탭에서 열림)",
    });
    expect(fromSlack.getAttribute("href")).toBe(SLACK_PERMALINK);
    expect(fromSlack.getAttribute("target")).toBe("_blank");
    // The message stands above the turn's lines, not as one of them.
    const list = screen.getByRole("list", { name: "이벤트" });
    expect(list.querySelectorAll("li")).toHaveLength(1);
    // An absolute box (the link's new-tab text) placed from outside the
    // scrolling timeline escapes its clip and stretches the page below the
    // app shell, so each one is positioned from within it.
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
    // A queued turn has no events yet, so no group of its own.
    expect(screen.queryByText("아직 줄 선 지시")).toBeNull();

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
    await waitFor(async () =>
      expect((await asked("2"))?.textContent).toContain("두 번째 지시"),
    );
    // An API key no person created has no name to show.
    expect((await asked("2"))?.textContent).toContain("지시 · API");
    expect((await asked("2"))?.querySelector("a")).toBeNull();
  });

  test("thinking ticks fold into one line and an empty message draws no card", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => {
      for (const id of ["ev_t1", "ev_t2", "ev_t3"]) {
        stream.emit(id, "system", {
          type: "system",
          engine_event: { name: "thinking_tokens", category: "thinking" },
        });
      }
      // The next turn's tick starts its own line.
      stream.emit(
        "ev_t4",
        "system",
        {
          type: "system",
          engine_event: { name: "thinking_tokens", category: "thinking" },
        },
        "2",
      );
      stream.emit("ev_empty", "assistant", { type: "assistant" });
    });
    await showAllEvents();
    expect(await screen.findByText("생각 중 (3)")).toBeTruthy();
    expect(screen.getByText("생각 중 (1)")).toBeTruthy();
    const list = screen.getByRole("list", { name: "이벤트" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
  });

  test("leaving the screen closes the stream", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await user.click(screen.getByRole("link", { name: "세션 목록" }));
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
    expect(
      screen.queryByText(
        "이벤트 연결이 끊겼습니다. 새로고침하면 다시 연결합니다.",
      ),
    ).toBeNull();
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

  describe("the agent in the header", () => {
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
    const headerOf = async () =>
      (await screen.findByRole("button", { name: "일시 정지" })).closest(
        "header",
      ) as HTMLElement;

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
      // The rail no longer repeats the header's agent.
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

  test("cost reads with two decimals in the header and the info tab", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/usage`]: () =>
        json(200, { ...usage, cost: { ...usage.cost, amount_usd: "1.5" } }),
    });
    const header = (
      await screen.findByRole("button", { name: "일시 정지" })
    ).closest("header") as HTMLElement;
    await waitFor(() => expect(header.textContent).toContain("$1.50"));
    await setupInfo();
    expect(
      within(screen.getByRole("tabpanel")).getByText("$1.50"),
    ).toBeTruthy();
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
    await setupInfo();
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

describe("session profile", () => {
  // The user's call (2026-10-24): a session picks its model only; the
  // profile belongs to the agent, so the screen offers no change mid-session.
  test("offers no profile change and shows the model the session runs instead", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const header = (
      await screen.findByRole("button", { name: "일시 정지" })
    ).closest("header") as HTMLElement;
    // The model is on the info tab only, not repeated in the header.
    expect(header.textContent).not.toContain("model-default");
    await setupInfo();
    expect(
      screen.getByRole("tabpanel", { name: "정보" }).textContent,
    ).toContain("model-default");
    expect(screen.queryByRole("button", { name: "프로필 바꾸기" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "다음 작업부터 쓸 프로필" }),
    ).toBeNull();
    expect(api.calls.some((call) => call.path === "/v1/profiles")).toBe(false);
  });

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
    const allow = await screen.findByRole("button", { name: "허용" });
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
    expect(
      await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다."),
    ).toBeTruthy();
    expect(
      screen.getAllByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다."),
    ).toHaveLength(1);
    expect(screen.getByText("답을 보냈습니다.").tagName).toBe("OUTPUT");
    expect(screen.getByText("답을 보냈습니다.").closest("aside")).toBeTruthy();
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
    const allow = await screen.findByRole("button", { name: "허용" });
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
    const [allow] = await screen.findAllByRole("button", { name: "허용" });
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
    const [allow] = await screen.findAllByRole("button", { name: "허용" });
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
    const allow = await screen.findByRole("button", { name: "허용" });
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
    await user.click(await screen.findByRole("button", { name: "거부" }));
    await user.keyboard("not now");
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
        screen.getByRole("tabpanel").querySelector("output.sr-only")
          ?.textContent,
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
      "작업 상태: 쉬는 중세션 상태: 일시정지됨",
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

  test("sends a message with Ctrl+Enter and names the turn it became", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/messages`]: () =>
        json(202, {
          turn_id: "2",
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        }),
    });
    await screen.findByText("권한 요청: Bash");
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step{Control>}{Enter}{/Control}");
    expect(await screen.findByText("메시지를 보냈습니다(턴 2).")).toBeTruthy();
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

  test("a message to a session whose profile the operator blocked says so", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/messages`]: () =>
        json(409, {
          error: {
            code: "PROFILE_BLOCKED",
            message: "Profile claude-coding-v1 is blocked by the operator",
            details: { reason_code: "blocked", profile_id: "claude-coding-v1" },
          },
        }),
    });
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step{Control>}{Enter}{/Control}");
    expect(
      await screen.findByText(
        "운영자가 이 세션의 프로필을 차단해 지시를 받지 않습니다. 차단이 풀리면 다시 보낼 수 있습니다.",
      ),
    ).toBeTruthy();
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
      expect(
        await screen.findByText("메시지를 보냈습니다(턴 2)."),
      ).toBeTruthy();
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

  test("a send in flight survives a trip to another tab and is not sent twice", async () => {
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
    await setupInfo();
    await user.click(screen.getByRole("tab", { name: "진행" }));
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
    expect(document.activeElement?.textContent).toBe(
      "메시지를 보냈습니다(턴 2).",
    );
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
    const allow = await screen.findByRole("button", { name: "허용" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    // Beside the buttons and in the answerers card, which says the same.
    expect(
      screen.getAllByText("sessions:approve 권한이 있어야 할 수 있습니다."),
    ).toHaveLength(2);
    expect(
      screen.queryByText("나는 이 세션의 요청에 답할 수 있습니다."),
    ).toBeNull();
    const stop = screen.getByRole("button", { name: "지금 턴 멈추기" });
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(stop.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("sessions:control 권한이 있어야 할 수 있습니다.");
    // The header's commands say it on hover or focus; only the operations
    // card spells it out.
    expect(
      screen
        .getAllByText("sessions:control 권한이 있어야 할 수 있습니다.")
        .filter((node) => node.closest("[hidden]") === null),
    ).toHaveLength(1);
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
    const allow = await screen.findByRole("button", { name: "허용" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "거부" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(
        "이 세션을 시작한 사람, 에이전트 관리자, 워크스페이스 소유자·관리자만 답할 수 있습니다.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("textbox", { name: "다음 지시" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});

async function setupInfo() {
  await (await setupUser()).click(
    await screen.findByRole("tab", { name: "정보" }),
  );
}

describe("세션 상세 레이아웃", () => {
  test("Radix 탭은 화살표로 선택하고 보기 전환은 진행 탭에만 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const user = await setupUser();
    const list = await screen.findByRole("tablist", { name: "세션 상세" });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("tab")
          .map((tab) => tab.textContent),
      ).toEqual(["진행", "성과물0", "정보"]),
    );
    await user.click(screen.getByRole("tab", { name: "진행" }));
    // The list wraps, so the last tab is one step left of the first.
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "정보" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    const viewGroup = () =>
      screen.queryByRole("group", { name: "타임라인 보기" });
    expect(viewGroup()).toBeNull();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(viewGroup()).toBeTruthy());
    expect(list.contains(viewGroup())).toBe(false);
    const focus = within(viewGroup() as HTMLElement).getByRole("button", {
      name: "집중",
    });
    expect(focus.getAttribute("aria-pressed")).toBe("true");
  });

  test.each(["error", "loading"] as const)(
    "pending %s keeps the composer under the timeline",
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
      expect(composer.closest('[role="tabpanel"]')).toBeTruthy();
      const aside = screen.getByRole("complementary", { name: "세션 요약" });
      if (state === "error")
        await within(aside).findByRole("button", { name: "다시 시도" });
      else expect(within(aside).getByText("불러오는 중…")).toBeTruthy();
      expect(
        screen.getAllByRole("textbox", { name: "다음 지시" }),
      ).toHaveLength(1);
      // Requests that could not be read are not reported as none.
      expect(aside.textContent).not.toContain("기다리는 요청 없음");
      expect(aside.textContent).not.toContain(
        "답변 대기 · 요청이 오면 여기에 먼저 나옵니다.",
      );
    },
  );

  test("헤더는 라벨 붙은 제어를 종료가 마지막인 순서로 두고 맨 끝에 세션 목록 버튼을, 메타 줄에 저장소·사용량을 둔다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    const header = pause.closest("header") as HTMLElement;
    expect(pause.textContent).toBe("일시 정지");
    expect(
      within(header).queryByRole("navigation", { name: "위치" }),
    ).toBeNull();
    const back = within(header).getByRole("link", { name: "세션 목록" });
    expect(back.getAttribute("href")).toBe("/sessions");
    const heading = screen.getByRole("heading", { level: 1 });
    const commands = within(header)
      .getAllByRole("button")
      .filter((button) => button.dataset.action !== undefined);
    expect(commands.map((button) => button.textContent)).toEqual([
      "지금 턴 멈추기",
      "일시 정지",
      "세션 종료",
    ]);
    // The keyboard reaches the title, the commands, then the way back.
    expect(
      heading.compareDocumentPosition(pause) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(header)
        .getByRole("button", { name: "세션 종료" })
        .compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(heading.textContent).toContain("답변 대기");
    expect(header.textContent).toContain("demo");
    expect(header.textContent).not.toContain("model-default");
    await waitFor(() => expect(header.textContent).toContain("<$0.01"));

    const panel = screen.getByRole("complementary", { name: "세션 요약" });
    expect(within(panel).getByText("답할 수 있는 사람")).toBeTruthy();
    expect(
      await within(panel).findByText("나는 이 세션의 요청에 답할 수 있습니다."),
    ).toBeTruthy();
    // The rail no longer repeats what the header and the info tab carry.
    expect(
      within(panel).queryByRole("region", { name: "세션 정보" }),
    ).toBeNull();
    await setupInfo();
    const tab = screen.getByRole("tabpanel", { name: "정보" });
    expect(tab.textContent).toContain("model-default");
    expect(tab.textContent).toContain("저장소 1개");
    expect(within(tab).getByText("demo")).toBeTruthy();
    expect(tab.textContent).not.toContain("아직 볼 수 없습니다");
  });

  test("머리·세션 정보·정보 탭은 에이전트와 시작한 사람·경로를 보인다", async () => {
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
    const header = (
      await screen.findByRole("button", { name: "일시 정지" })
    ).closest("header") as HTMLElement;
    expect(header.textContent).toContain("에이전트: 코드 리뷰");
    expect(header.textContent).toContain(
      "시작한 사람·경로: Demo Owner · Slack",
    );
    const opened = within(header).getByRole("link", {
      name: "Slack에서 보기 (새 탭에서 열림)",
    });
    expect(opened.getAttribute("href")).toBe(SLACK_PERMALINK);
    expect(opened.getAttribute("target")).toBe("_blank");
    expect(opened.getAttribute("rel")).toBe("noopener noreferrer");
    await setupInfo();
    const tab = screen.getByRole("tabpanel", { name: "정보" });
    expect(tab.textContent).toContain("에이전트코드 리뷰");
    expect(tab.textContent).toContain("시작한 사람·경로Demo Owner · Slack");
  });

  describe("정보 탭의 저장소 목록", () => {
    const pushRequest = (fields: Record<string, unknown>) => ({
      id: "019a0000-0000-7000-8000-0000000000a1",
      session_id: SESSION_ID,
      repository_id: "web",
      checkpoint_revision: 2,
      git_commit: "a".repeat(40),
      target_branch: "feature/x",
      state: "pushed",
      requested_by: {
        principal: { kind: "api_key", id: "key-1" },
        actor_user_id: null,
        agent_id: null,
      },
      requested_at: AT,
      resolved_by: null,
      resolved_at: null,
      resolution_reason: null,
      request_receipt_id: "019a0000-0000-7000-8000-0000000000b1",
      resolution_receipt_id: null,
      finished_at: AT,
      push_receipt_id: null,
      origin: "direct",
      flow: "actions",
      pr_state: null,
      pr_error: null,
      pr_number: null,
      pr_url: null,
      ...fields,
    });
    const attachedOnly = (requests: unknown[]) => ({
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          repository: null,
          repository_id: null,
          attached_repository_ids: ["web", "api"],
          attached_repositories: [
            { id: "api", full_name: "acme/api" },
            { id: "web", full_name: "acme/web" },
          ],
        }),
      [`GET /v1/sessions/${SESSION_ID}/push-requests`]: () =>
        json(200, { items: requests, intents: [] }),
    });

    test("자기 저장소 없이 추가만 있는 세션도 id 순으로 보이고 PR에만 링크를 건다", async () => {
      renderAt(
        `/sessions/${SESSION_ID}`,
        attachedOnly([
          pushRequest({
            pr_state: "opened",
            pr_number: 7,
            pr_url: "https://github.com/acme/web/pull/7",
          }),
        ]),
      );
      await screen.findByRole("button", { name: "일시 정지" });
      await setupInfo();
      const tab = screen.getByRole("tabpanel", { name: "정보" });
      expect(await within(tab).findByText("push 완료")).toBeTruthy();
      expect(tab.textContent).toContain("저장소 2개");
      const names = within(tab)
        .getAllByText(/^acme\//)
        .map((node) => node.textContent);
      expect(names).toEqual(["acme/api", "acme/web"]);
      expect(tab.textContent).toContain("push 브랜치 feature/x");
      expect(within(tab).getByText("아직 push 요청 없음")).toBeTruthy();
      const links = within(tab).getAllByRole("link");
      expect(links.map((link) => link.getAttribute("href"))).toEqual([
        "https://github.com/acme/web/pull/7",
      ]);
      expect(links[0]?.textContent).toContain("PR 생성됨 #7");
    });

    test("https가 아닌 PR 주소는 링크로 걸지 않고 단계만 보인다", async () => {
      renderAt(
        `/sessions/${SESSION_ID}`,
        attachedOnly([
          pushRequest({
            pr_state: "opened",
            pr_number: 9,
            pr_url: "javascript:alert(1)",
          }),
        ]),
      );
      await screen.findByRole("button", { name: "일시 정지" });
      await setupInfo();
      const tab = screen.getByRole("tabpanel", { name: "정보" });
      expect(await within(tab).findByText("PR 생성됨")).toBeTruthy();
      expect(within(tab).queryAllByRole("link")).toHaveLength(0);
    });

    test.each([
      ["deferred", "작업이 끝나기를 기다리는 중"],
      ["failed", "push 요청을 만들지 못함"],
    ])(
      "요청 없이 intent만 %s이면 '아직 push 요청 없음' 대신 그 상태를 보인다",
      async (status, label) => {
        renderAt(`/sessions/${SESSION_ID}`, {
          ...attachedOnly([]),
          [`GET /v1/sessions/${SESSION_ID}/push-requests`]: () =>
            json(200, {
              items: [],
              intents: [
                {
                  id: "019a0000-0000-7000-8000-0000000000c1",
                  session_id: SESSION_ID,
                  repository_id: "web",
                  target_branch: "feature/x",
                  status,
                  refusal_code: null,
                  push_request_id: null,
                  created_at: AT,
                },
              ],
            }),
        });
        await screen.findByRole("button", { name: "일시 정지" });
        await setupInfo();
        const tab = screen.getByRole("tabpanel", { name: "정보" });
        expect(await within(tab).findByText(label)).toBeTruthy();
        // The repository without an intent still says no request yet.
        expect(within(tab).getAllByText("아직 push 요청 없음")).toHaveLength(1);
      },
    );

    test.each([
      ["failed", "push 요청을 만들지 못함"],
      ["deferred", "작업이 끝나기를 기다리는 중"],
    ])(
      "예전 push가 끝난 뒤의 더 새로운 %s intent는 'push 완료'에 가려지지 않는다",
      async (status, label) => {
        renderAt(`/sessions/${SESSION_ID}`, {
          ...attachedOnly([pushRequest({})]),
          [`GET /v1/sessions/${SESSION_ID}/push-requests`]: () =>
            json(200, {
              items: [pushRequest({})],
              intents: [
                {
                  id: "019a0000-0000-7000-8000-0000000000c2",
                  session_id: SESSION_ID,
                  repository_id: "web",
                  target_branch: "feature/y",
                  status,
                  refusal_code: null,
                  push_request_id: null,
                  created_at: "2026-10-11T09:00:00.000Z",
                },
              ],
            }),
        });
        await screen.findByRole("button", { name: "일시 정지" });
        await setupInfo();
        const tab = screen.getByRole("tabpanel", { name: "정보" });
        expect(await within(tab).findByText(label)).toBeTruthy();
        expect(tab.textContent).toContain("push 브랜치 feature/y");
        expect(within(tab).queryByText("push 완료")).toBeNull();
      },
    );

    test("push 요청에 이어진 intent는 요청이 대신 보이고, 더 오래된 intent는 요청을 가리지 않는다", async () => {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...attachedOnly([
          pushRequest({ requested_at: "2026-10-11T09:00:00.000Z" }),
        ]),
        [`GET /v1/sessions/${SESSION_ID}/push-requests`]: () =>
          json(200, {
            items: [pushRequest({ requested_at: "2026-10-11T09:00:00.000Z" })],
            intents: [
              {
                id: "019a0000-0000-7000-8000-0000000000c3",
                session_id: SESSION_ID,
                repository_id: "web",
                target_branch: "feature/x",
                status: "failed",
                refusal_code: null,
                push_request_id: null,
                created_at: AT,
              },
            ],
          }),
      });
      await screen.findByRole("button", { name: "일시 정지" });
      await setupInfo();
      const tab = screen.getByRole("tabpanel", { name: "정보" });
      expect(await within(tab).findByText("push 완료")).toBeTruthy();
      expect(within(tab).queryByText("push 요청을 만들지 못함")).toBeNull();
    });

    test("push 요청을 읽지 못하면 이름은 두고 실패를 알리며 다시 불러올 수 있다", async () => {
      const user = await setupUser();
      let fail = true;
      renderAt(`/sessions/${SESSION_ID}`, {
        ...attachedOnly([pushRequest({})]),
        [`GET /v1/sessions/${SESSION_ID}/push-requests`]: () =>
          fail
            ? json(500, {
                error: {
                  code: "INTERNAL",
                  message: "boom",
                  retryable: false,
                  request_id: "r1",
                  details: null,
                },
              })
            : json(200, { items: [pushRequest({})], intents: [] }),
      });
      await screen.findByRole("button", { name: "일시 정지" });
      await user.click(await screen.findByRole("tab", { name: "정보" }));
      const tab = screen.getByRole("tabpanel", { name: "정보" });
      const alert = await within(tab).findByRole("alert");
      expect(alert.textContent).toContain(
        "push·PR 상태를 불러오지 못했습니다.",
      );
      expect(tab.textContent).toContain("acme/web");
      fail = false;
      await user.click(
        within(alert).getByRole("button", { name: "다시 불러오기" }),
      );
      expect(await within(tab).findByText("push 완료")).toBeTruthy();
      expect(within(tab).queryByRole("alert")).toBeNull();
    });

    test("저장소가 없는 세션은 없다고 말하고 push 요청을 묻지 않는다", async () => {
      const { api } = renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}`]: () =>
          json(200, { ...detail, repository: null, repository_id: null }),
      });
      await screen.findByRole("button", { name: "일시 정지" });
      await setupInfo();
      const tab = screen.getByRole("tabpanel", { name: "정보" });
      expect(within(tab).getByText("기록된 저장소가 없습니다.")).toBeTruthy();
      expect(
        api.calls.some((call) => call.path.endsWith("/push-requests")),
      ).toBe(false);
    });
  });

  test.each([
    [
      { agent: null, created_by: null, channel: "api" },
      "에이전트 없음",
      "기록 없음 · API",
    ],
    [
      {
        agent: null,
        created_by: { user_id: THIRD_ID, display_name: "" },
        channel: null,
      },
      "에이전트 없음",
      "기록 없음",
    ],
    [
      {
        agent: null,
        created_by: { user_id: THIRD_ID, display_name: "김하나" },
        channel: "web",
      },
      "에이전트 없음",
      "김하나 · 웹 콘솔",
    ],
  ])(
    "%p는 에이전트 %p, 시작한 사람·경로 %p로 쓴다",
    async (fields, agent, startedBy) => {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}`]: () =>
          json(200, { ...detail, ...fields }),
      });
      const header = (
        await screen.findByRole("button", { name: "일시 정지" })
      ).closest("header") as HTMLElement;
      expect(header.textContent).toContain(`에이전트: ${agent}`);
      expect(header.textContent).toContain(`시작한 사람·경로: ${startedBy}`);
      expect(header.textContent).not.toContain("정보 없음");
      // A session from before links were kept has none to offer.
      expect(within(header).queryByRole("link", { name: /Slack/ })).toBeNull();
    },
  );

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
    ["paused", "일시정지됨"],
    ["pausing", "일시정지 중"],
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

  test("ID 복사는 세션 ID 전체를 복사하고 그렇다고 알린다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const user = await setupUser();
    // After setupUser, which installs a clipboard of its own.
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    try {
      await user.click(
        await screen.findByRole("button", { name: "세션 ID 복사" }),
      );
      expect(copied).toEqual([SESSION_ID]);
      expect(await screen.findByText("세션 ID를 복사했습니다.")).toBeTruthy();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("운영 카드는 답할 수 있는 사람과 지금 할 수 있는 조치를 모으고 제어 버튼은 헤더에만 둔다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const ops = await screen.findByRole("region", { name: "운영" });
    const panel = screen.getByRole("complementary", { name: "세션 요약" });
    expect(
      within(panel)
        .getAllByRole("region")
        .filter((region) => region.dataset.slot === "detail-rail-section")
        .map((region) => region.querySelector("h2")?.textContent),
    ).toEqual(["답변 대기 요청", "운영"]);
    expect(
      within(ops)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["답할 수 있는 사람", "운영 조치"]);
    expect(
      await within(ops).findByText("나는 이 세션의 요청에 답할 수 있습니다."),
    ).toBeTruthy();
    expect(ops.textContent).toContain("지금 턴 멈추기 · 일시 정지 · 세션 종료");
    expect(within(ops).getByText("할 수 있음")).toBeTruthy();
    expect(within(ops).queryAllByRole("button")).toHaveLength(0);
  });

  test("운영 카드는 멈춘 세션에 다시 시작·종료를, 요청을 읽기 전에는 규칙만 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, admission_state: "paused" }),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        new Promise<Response>(() => {}),
    });
    const ops = await screen.findByRole("region", { name: "운영" });
    expect(ops.textContent).toContain("다시 시작 · 세션 종료");
    expect(
      within(ops).getByText(
        "세션을 시작한 사람, 에이전트 담당자, 워크스페이스 소유자·관리자",
      ),
    ).toBeTruthy();
    expect(ops.textContent).not.toContain("답할 수 있습니다.");
    expect(ops.textContent).not.toContain("답할 수 없습니다.");
  });

  test("공유받아 보기만 하는 사람에게는 답할 수 없다고 말한다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { ...pending, answerable: false }),
    });
    const panel = await screen.findByRole("complementary", {
      name: "세션 요약",
    });
    expect(
      await within(panel).findByText(
        "공유받아 볼 수만 있어 요청에 답할 수 없습니다.",
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
    await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.");
    await user.click(screen.getByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step draft");
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());

    open = pending.items.map((item) => ({ ...item, expires_at: LATER }));
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    const allow = await screen.findByRole("button", { name: "허용" });
    expect(draft()).toBe("next step draft");

    allow.focus();
    await user.keyboard("{Enter}");
    await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.");
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

  test("작성창은 늘 진행 탭의 타임라인 아래에 있고 넓은 화면은 본문부터 읽는다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await screen.findByRole("textbox", { name: "다음 지시" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("textbox", { name: "다음 지시" })
          .closest('[role="tabpanel"]'),
      ).toBeTruthy(),
    );
    const layout = document.querySelector('[data-slot="detail-layout"]');
    const body = layout?.firstElementChild?.firstElementChild;
    expect(body?.getAttribute("data-slot")).toBe("page-frame-body");
    expect(body?.querySelector('[data-slot="page-header"]')).toBeTruthy();
    expect(body?.lastElementChild?.getAttribute("data-slot")).toBe("tabs");
    expect(layout?.lastElementChild?.tagName).toBe("ASIDE");
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

  test("레일은 어느 폭에서나 본문 다음에 읽고, 요청이 없어도 작성창은 본문에 있다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
    });
    await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.");
    const composer = screen.getByRole("textbox", { name: "다음 지시" });
    expect(composer.closest("aside")).toBeNull();
    expect(composer.closest('[role="tabpanel"]')).toBeTruthy();
    expect(
      screen.getAllByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다."),
    ).toHaveLength(1);
    expect(
      screen
        .getByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.")
        .closest("section")?.textContent,
    ).toContain("기다리는 요청 없음");
    // One landmark, after the body in the DOM: below 1280px CSS stacks it
    // under the body instead of moving it ahead.
    const [aside, ...others] = screen.getAllByRole("complementary");
    expect(others).toHaveLength(0);
    expect(
      composer.compareDocumentPosition(aside as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

describe("session share", () => {
  const SHARE = `GET /v1/sessions/${SESSION_ID}/share`;
  const share = (over: Record<string, unknown>) => ({
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
  const shownFor = async (over: Record<string, unknown>) => {
    const view = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE]: () => json(200, share(over)),
    });
    const block = await screen.findByRole("region", { name: "공유 범위" });
    const text = block.textContent;
    view.container.remove();
    return text;
  };

  test("a workspace scope kept inside the agent says so; one that is not reads as the workspace", async () => {
    expect(await shownFor({ audience_limited: true })).toBe(
      "공유 범위워크스페이스(담당 팀 밖 사람은 보지 못함, 워크스페이스 설정)",
    );
    expect(await shownFor({ audience_limited: false })).toBe(
      "공유 범위워크스페이스",
    );
  });

  test("people and team scopes count whom they name, whatever the setting", async () => {
    expect(
      await shownFor({
        scope: "people",
        user_ids: [OTHER_ID, THIRD_ID],
        revision: 1,
        audience_limited: true,
      }),
    ).toBe("공유 범위지정한 사람 2명");
    expect(
      await shownFor({ scope: "team", team_ids: [OTHER_ID], revision: 1 }),
    ).toBe("공유 범위지정한 팀 1개");
    expect(await shownFor({ scope: "private", revision: 1 })).toBe(
      "공유 범위세션을 가진 사람만",
    );
  });

  test("someone who cannot read the share sees no block", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE]: () => apiError(404, "NOT_FOUND", "Resource not found"),
    });
    expect(await screen.findByText("답변 대기")).toBeTruthy();
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.path === `/v1/sessions/${SESSION_ID}/share`),
      ).toBe(true),
    );
    expect(screen.queryByRole("region", { name: "공유 범위" })).toBeNull();
  });

  test("a failed read says so and asks again on retry", async () => {
    let fail = true;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE]: () =>
        fail
          ? apiError(500, "INTERNAL", "boom")
          : json(200, share({ audience_limited: true })),
    });
    const block = await screen.findByRole("region", { name: "공유 범위" });
    expect(within(block).getByRole("alert").textContent).toBe(
      "공유 범위를 확인하지 못했습니다.",
    );
    fail = false;
    await (await setupUser()).click(
      within(block).getByRole("button", { name: "다시 시도" }),
    );
    await waitFor(() =>
      expect(block.textContent).toBe(
        "공유 범위워크스페이스(담당 팀 밖 사람은 보지 못함, 워크스페이스 설정)",
      ),
    );
  });

  test("a read that fails after one that worked says so instead of the old scope", async () => {
    let fail = false;
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [SHARE]: () =>
        fail
          ? apiError(500, "INTERNAL", "boom")
          : json(200, share({ audience_limited: true })),
    });
    const block = await screen.findByRole("region", { name: "공유 범위" });
    await waitFor(() =>
      expect(block.textContent).toBe(
        "공유 범위워크스페이스(담당 팀 밖 사람은 보지 못함, 워크스페이스 설정)",
      ),
    );
    const reads = () =>
      api.calls.filter((c) => c.path === `/v1/sessions/${SESSION_ID}/share`)
        .length;
    const before = reads();
    fail = true;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    focusManager.setFocused(undefined);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() =>
      expect(within(block).getByRole("alert").textContent).toBe(
        "공유 범위를 확인하지 못했습니다.",
      ),
    );
    expect(block.textContent).not.toContain("워크스페이스(");
  });
});

describe("session release", () => {
  const agent = (releaseIsActive: boolean | null) => ({
    id: OTHER_ID,
    name: "Release helper",
    release_version_no: 2,
    release_label: "2026-10-30_14:30:28",
    release_is_active: releaseIsActive,
  });
  const shownFor = async (over: Partial<SessionDetail>) => {
    const view = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, ...over }),
    });
    const block = await screen.findByRole("region", {
      name: "이 세션이 쓰는 릴리스",
    });
    const text = block.textContent;
    view.container.remove();
    return text;
  };

  test("a session pinned to a release the agent no longer runs says so", async () => {
    expect(await shownFor({ agent: agent(false) })).toBe(
      "이 세션이 쓰는 릴리스2026-10-30_14:30:28활성 릴리스 아님이 세션은 시작할 때의 릴리스를 계속 씁니다. 에이전트의 지금 설정은 새 세션부터 쓰입니다.",
    );
  });

  test("the active release is marked active, and an older server's null claims neither", async () => {
    expect(await shownFor({ agent: agent(true) })).toBe(
      "이 세션이 쓰는 릴리스2026-10-30_14:30:28활성 릴리스",
    );
    expect(await shownFor({ agent: agent(null) })).toBe(
      "이 세션이 쓰는 릴리스2026-10-30_14:30:28",
    );
  });

  test("a session without an agent shows no release block", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    expect(await screen.findByText("답변 대기")).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "이 세션이 쓰는 릴리스" }),
    ).toBeNull();
  });
});
