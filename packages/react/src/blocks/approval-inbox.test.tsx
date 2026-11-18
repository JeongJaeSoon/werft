import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ApiClientOptions, createApiClient } from "@werft-ai/client";
import type { PendingRequest } from "@werft-ai/contracts";
import { queryKeysOf, withQueryScope } from "@werft-ai/core";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type { ReactNode } from "react";
import type { ApprovalLayout } from "./session-actions.tsx";

const { render, waitFor, act } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { WerftProvider } = await import("../provider.tsx");
const { ApprovalInbox } = await import("./approval-inbox.tsx");
const { PendingAnswers } = await import("./session-actions.tsx");
type ApprovalInboxProps = import("./approval-inbox.tsx").ApprovalInboxProps;

const SESSION_ID = "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const SHORT = SESSION_ID.slice(0, 8);
const STALE_ID = "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b02";
const NEWER_ID = "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b03";
const LATER = "2099-01-01T00:00:00.000Z";

const permission = (request_id: string, tool: string): PendingRequest => ({
  request_id,
  turn_id: "1",
  attempt_id: "att_1",
  kind: "permission",
  tool,
  input: { command: "ls" },
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: LATER,
});

const QUESTION: PendingRequest = {
  request_id: "req_q",
  turn_id: "1",
  attempt_id: "att_1",
  kind: "question",
  questions: [
    {
      question_id: "q1",
      prompt: "Which branch?",
      options: [{ option_id: "dev", label: "dev" }],
      allow_free_text: false,
      multi_select: false,
    },
  ],
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: LATER,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Posted {
  readonly path: string;
  readonly body: unknown;
}

/**
 * One waiting session whose open requests are `open`; an answer removes the
 * request it answers, as the server does.
 */
function renderInbox({
  open,
  layout,
  unavailable,
  answerable = true,
  title = null,
  extra,
  body,
  stale = false,
  hold = false,
  agent,
  agentHidden = false,
  startedBy,
  relations: related = [],
}: {
  open: PendingRequest[];
  layout?: ApprovalLayout;
  unavailable?: { answer?: string };
  answerable?: boolean;
  title?: string | null;
  extra?: Partial<ApprovalInboxProps>;
  /** Drawn in place of the inbox, inside the same providers. */
  body?: ReactNode;
  /** The waiting list also names STALE_ID, whose own list is empty. */
  stale?: boolean;
  /** Answers never come back, as a slow server's. */
  hold?: boolean;
  /** SESSION_ID's agent name. */
  agent?: string;
  /** SESSION_ID has an agent the reader may not use. */
  agentHidden?: boolean;
  /** SESSION_ID's starter name. */
  startedBy?: string;
  /** The relation filters whose waiting list names SESSION_ID. */
  relations?: string[];
}) {
  const posted: Posted[] = [];
  let waitingReads = 0;
  let items = open;
  let relations = related;
  // Set by `addNewer`: a session that starts waiting ahead of SESSION_ID.
  let newer = false;
  const waitingSession = {
    id: SESSION_ID,
    title,
    status: "needs_input",
    ...(agent
      ? { agent: { id: "agt_1", name: agent, release_version_no: 1 } }
      : {}),
    agent_hidden: agentHidden,
    ...(startedBy
      ? { created_by: { user_id: "usr_1", display_name: startedBy } }
      : {}),
  };
  const fakeFetch = async (request: Request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}${url.search}`;
    const relation =
      /^GET \/v1\/sessions\?status=needs_input&relation=(\w+)$/.exec(
        route,
      )?.[1];
    if (relation !== undefined) {
      return json(200, {
        items:
          items.length && relations.includes(relation) ? [waitingSession] : [],
        next_cursor: null,
      });
    }
    if (route === "GET /v1/sessions?status=needs_input") {
      waitingReads += 1;
      return json(200, {
        items: [
          ...(newer
            ? [{ id: NEWER_ID, title: "Newer", status: "needs_input" }]
            : []),
          ...(items.length ? [waitingSession] : []),
          ...(stale
            ? [{ id: STALE_ID, title: null, status: "needs_input" }]
            : []),
        ],
        next_cursor: null,
      });
    }
    if (route === `GET /v1/sessions/${NEWER_ID}/pending-requests`) {
      return json(200, { answerable, items: [permission("req_n", "Read")] });
    }
    if (route === `GET /v1/sessions/${STALE_ID}/pending-requests`) {
      return json(200, { answerable: true, items: [] });
    }
    if (route === `GET /v1/sessions/${SESSION_ID}/pending-requests`) {
      return json(200, { answerable, items });
    }
    if (route === `POST /v1/sessions/${SESSION_ID}/answers`) {
      const body = JSON.parse(await request.text()) as {
        request_id: string;
      };
      posted.push({ path: url.pathname, body });
      if (hold) return new Promise<Response>(() => {});
      items = items.filter((item) => item.request_id !== body.request_id);
      return json(202, { receipt_id: "rcpt_1", receipt_status: "accepted" });
    }
    return json(404, { error: { code: "NOT_FOUND", message: route } });
  };
  const client = withQueryScope(
    createApiClient({
      baseUrl: "https://console.test",
      fetch: fakeFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
    }),
    { actor: "user:u-1", workspace: "w-1" },
  );
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WerftProvider
        client={client}
        locale="en"
        renderLink={({ id, children, className, ...rest }) => (
          <a href={`/sessions/${id}`} className={className} {...rest}>
            {children}
          </a>
        )}
      >
        {body ?? (
          <ApprovalInbox
            loading={<p>loading</p>}
            renderError={() => <p>failed</p>}
            layout={layout}
            unavailable={unavailable}
            {...extra}
          />
        )}
      </WerftProvider>
    </QueryClientProvider>,
  );
  return {
    ...view,
    posted,
    waitingReads: () => waitingReads,
    /**
     * Names SESSION_ID in `next` relation lists and reads the waiting list
     * again, as an answer elsewhere does, leaving the rest of the cache.
     */
    relate: async (next: string[]) => {
      relations = next;
      await act(() =>
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).waitingSessions,
          exact: true,
        }),
      );
    },
    addNewer: async () => {
      newer = true;
      await act(() => queryClient.invalidateQueries());
    },
  };
}

describe("ApprovalInbox", () => {
  test("기본은 지금처럼 카드로 그린다", async () => {
    const view = renderInbox({ open: [permission("req_1", "Bash")] });
    const { container } = view;
    await view.findByText("Permission request: Bash");
    expect(container.querySelector("[data-slot='approval-card']")).toBeTruthy();
    expect(container.querySelector("[data-slot='approval-row']")).toBeNull();
    // The card keeps its plain button names.
    expect(view.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  test("행 배치는 권한 요청을 한 줄로, 질문은 카드 그대로 그린다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash"), QUESTION],
      layout: "row",
    });
    const { container } = view;
    await view.findByText("Permission request: Bash");
    expect(container.querySelector("[data-slot='approval-card']")).toBeNull();
    const row = container.querySelector("[data-slot='approval-row']");
    expect(row?.closest("li")).toBeTruthy();
    expect(row?.tagName).toBe("ARTICLE");
    expect(container.querySelector("[data-slot='question-card']")).toBeTruthy();
    // The session link rides on the row's line.
    expect(
      row?.querySelector(`a[aria-label="Open session ${SESSION_ID}"]`),
    ).toBeTruthy();
  });

  test("행에서 허용하면 카드와 같은 답을 보내고, 키보드는 다음 행으로 간다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash"), permission("req_2", "Write")],
      layout: "row",
    });
    const { posted } = view;
    const allow = await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    });
    allow.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(view.queryByText("Permission request: Bash")).toBeNull(),
    );
    expect(posted).toEqual([
      {
        path: `/v1/sessions/${SESSION_ID}/answers`,
        body: { request_id: "req_1", kind: "permission", action: "allow" },
      },
    ]);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        `Allow: Write · ${SHORT}`,
      ),
    );
  });

  test("답할 때마다 제목 줄의 알림을 새로 써서 두 번째 답도 읽힌다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash"), permission("req_2", "Write")],
      layout: "summary",
    });
    await user.click(
      await view.findByRole("button", { name: `Allow: Bash · ${SHORT}` }),
    );
    const first = await view.findByText("Answer sent.");
    await user.click(
      await view.findByRole("button", { name: `Allow: Write · ${SHORT}` }),
    );
    await waitFor(() => expect(view.posted).toHaveLength(2));
    await waitFor(() => expect(view.getByText("Answer sent.")).not.toBe(first));
  });

  test("새 세션이 앞에 들어와 포커스를 쥔 줄이 한도 밖으로 밀리면 키보드는 제목으로 간다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "row",
      extra: { limit: 1 },
    });
    (
      await view.findByRole("button", { name: `Allow: Bash · ${SHORT}` })
    ).focus();
    await view.addNewer();
    await view.findByRole("button", {
      name: `Allow: Read · ${NEWER_ID.slice(0, 8)}`,
    });
    expect(
      view.queryByRole("button", { name: `Allow: Bash · ${SHORT}` }),
    ).toBeNull();
    expect(document.activeElement?.tagName).toBe("H2");
  });

  test("행에서 거부하면 적은 이유를 함께 보낸다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "row",
    });
    const { posted } = view;
    await user.click(
      await view.findByRole("button", { name: `Deny: Bash · ${SHORT}` }),
    );
    await user.keyboard("not now");
    await user.click(view.getByRole("button", { name: "Send denial" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      action: "deny",
      reason: "not now",
    });
  });

  test("답할 수 없는 사람에게는 행의 버튼이 막히고 이유가 보인다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "row",
      unavailable: { answer: "needs sessions:approve" },
    });
    const allow = (await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    })) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    expect(view.getByText("needs sessions:approve")).toBeTruthy();
  });
  test("요약 배치는 세션 이름 아래 요청을 한 줄로 두고, 답은 그 자리에서 보낸다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash"), QUESTION],
      layout: "summary",
      title: "Fix README",
      extra: {
        title: "Requests waiting on you",
        action: <a href="/sessions?status=needs_input">View all</a>,
        now: Date.parse("2026-10-21T01:02:30.000Z"),
      },
    });
    const { container, posted } = view;
    await view.findByText("Permission request: Bash");
    expect(view.getByRole("heading", { level: 2 }).textContent).toBe(
      "Requests waiting on you",
    );
    expect(view.getByRole("link", { name: "View all" })).toBeTruthy();
    const row = container.querySelector("[data-slot='approval-row']");
    // One frame for the list; the line itself carries no card of its own.
    expect(row?.className).not.toContain("rounded-card");
    expect(
      row?.closest("ul")?.parentElement?.closest("ul")?.className,
    ).toContain("rounded-card");
    const name = view.getAllByRole("link", {
      name: "Open session Fix README",
    });
    expect(name[0]?.textContent).toBe("Fix README");
    expect(row?.textContent).toContain(`${SHORT} · Waiting 3 min`);
    // The question keeps its card, under a line of the same shape.
    expect(container.querySelector("[data-slot='question-card']")).toBeTruthy();
    expect(name).toHaveLength(2);
    await user.click(
      view.getByRole("button", { name: `Allow: Bash · ${SHORT}` }),
    );
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      action: "allow",
    });
  });

  test("요청이 이미 닫힌 세션은 줄도 수도 없이 빠지고, 대기 목록을 다시 읽는다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      stale: true,
    });
    await view.findByText("Permission request: Bash");
    await waitFor(() => expect(view.waitingReads()).toBeGreaterThanOrEqual(2));
    expect(view.queryByText("Nothing is waiting for an answer.")).toBeNull();
    expect(
      view.queryByRole("link", { name: `Open session ${STALE_ID}` }),
    ).toBeNull();
    expect(view.container.querySelectorAll("section > ul > li")).toHaveLength(
      1,
    );
    expect(view.getByText("1 sessions waiting for an answer")).toBeTruthy();
  });

  test("요약 배치의 질문은 한 줄로 접혀 있고, 답하기로 펼치면 첫 선택지로 간다", async () => {
    const user = await setupUser();
    const view = renderInbox({ open: [QUESTION], layout: "summary" });
    const open = await view.findByRole("button", { name: "Answer" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    // The line says what it asks; the folded form asks it again in full.
    expect(view.getAllByText("Which branch?")[0]?.className).toContain(
      "truncate",
    );
    const form = document.getElementById(
      open.getAttribute("aria-controls") ?? "",
    );
    expect(form?.hidden).toBe(true);
    await user.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(form?.hidden).toBe(false);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("role")).toBe("radio"),
    );
    await user.keyboard(" ");
    await user.click(view.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]?.body).toEqual({
      request_id: "req_q",
      kind: "question",
      answers: [{ question_id: "q1", selected_option_ids: ["dev"] }],
    });
  });

  test("요약 배치에서 펼친 질문이 만료되면 키보드는 보이는 만료 안내로 간다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [
        { ...QUESTION, expires_at: new Date(Date.now() + 1500).toISOString() },
      ],
      layout: "summary",
    });
    await user.click(await view.findByRole("button", { name: "Answer" }));
    view.getByRole("button", { name: "Send answer" }).focus();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("P"), {
      timeout: 4000,
    });
    expect(document.activeElement?.textContent).toBe(
      "This request has expired and can no longer be answered.",
    );
    expect(document.activeElement?.closest("[hidden]")).toBeNull();
  });

  test("요약 배치에서 접힌 질문의 답하기에 둔 채 만료되면 키보드는 줄의 만료 안내로 간다", async () => {
    const view = renderInbox({
      open: [
        { ...QUESTION, expires_at: new Date(Date.now() + 1500).toISOString() },
      ],
      layout: "summary",
    });
    (await view.findByRole("button", { name: "Answer" })).focus();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("P"), {
      timeout: 4000,
    });
    expect(document.activeElement?.textContent).toContain(
      "This request has expired and can no longer be answered.",
    );
    expect(document.activeElement?.closest("[hidden]")).toBeNull();
  });

  test("요약 배치에서 남은 요청이 만료된 질문뿐이면 답한 뒤 키보드는 그 만료 안내로 간다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [
        permission("req_1", "Bash"),
        { ...QUESTION, expires_at: "2020-01-01T00:00:00.000Z" },
      ],
      layout: "summary",
    });
    await user.click(
      await view.findByRole("button", { name: `Allow: Bash · ${SHORT}` }),
    );
    await waitFor(() =>
      expect(view.queryByText("Permission request: Bash")).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        "This request has expired and can no longer be answered.",
      ),
    );
    expect(document.activeElement?.closest("[hidden]")).toBeNull();
  });

  test("답이 가는 동안 누른 버튼이 돌고 줄은 aria-busy, 두 번 눌러도 한 번만 보낸다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      hold: true,
    });
    const allow = await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    });
    await user.click(allow);
    // Off but not `disabled`, which would take the keyboard's focus away.
    await waitFor(() =>
      expect(allow.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(allow.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement === allow).toBe(true);
    expect(allow.querySelector("[data-slot='busy']")).not.toBeNull();
    expect(allow.closest("[aria-busy='true']")).not.toBeNull();
    await user.click(allow);
    expect(view.posted).toHaveLength(1);
  });

  test("요약 배치에서 제목이 없는 세션은 짧은 ID로 부른다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
    });
    await view.findByText("Permission request: Bash");
    const link = view.getByRole("link", {
      name: `Open session ${SESSION_ID}`,
    });
    expect(link.textContent).toBe(SHORT);
    const row = view.container.querySelector("[data-slot='approval-row']");
    expect(row?.textContent?.split(SHORT)).toHaveLength(2);
  });

  test("요약 배치에서 답할 수 없으면 이유가 줄 안에 한 번 붙고 버튼은 막힌다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      answerable: false,
    });
    const allow = (await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    })) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    const row = view.container.querySelector("[data-slot='approval-row']");
    const reason = view.getAllByText(/can answer\./);
    expect(reason).toHaveLength(1);
    expect(row?.contains(reason[0] ?? null)).toBe(true);
  });

  test("기다리는 세션이 없으면 넘겨받은 빈 상태를, 없으면 기본 한 줄을 보인다", async () => {
    const given = renderInbox({
      open: [],
      layout: "summary",
      extra: { empty: <p>nothing to answer</p> },
    });
    await given.findByText("nothing to answer");
    given.unmount();
    const plain = renderInbox({ open: [], layout: "summary" });
    await plain.findByText("No session is waiting for an answer.");
  });
  test("요약 배치를 heading 없이 써도 줄은 세션을 짧은 ID로 부르고 이유를 붙인다", async () => {
    const view = renderInbox({
      open: [],
      body: (
        <PendingAnswers
          sessionId={SESSION_ID}
          items={[permission("req_1", "Bash")]}
          answerable={false}
          layout="summary"
          meta={() => "waited"}
        />
      ),
    });
    const row = await view.findByRole("article");
    expect(row.textContent).toContain(SHORT);
    expect(row.textContent).toContain("waited");
    expect(row.textContent).toContain("can answer.");
  });

  test("now를 넘기지 않은 요약 배치는 분마다 대기 시간을 다시 센다", async () => {
    const start = Date.parse("2026-10-21T01:02:30.000Z");
    setSystemTime(new Date(start));
    const ticks: (() => void)[] = [];
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((
      tick: () => void,
    ) => {
      ticks.push(tick);
      return 0;
    }) as unknown as typeof setInterval);
    try {
      const view = renderInbox({
        open: [permission("req_1", "Bash")],
        layout: "summary",
        title: "Fix README",
      });
      const row = await view.findByRole("article");
      expect(row.textContent).toContain("Waiting 3 min");
      setSystemTime(new Date(start + 2 * 60_000));
      await act(async () => {
        for (const tick of ticks) tick();
      });
      expect(row.textContent).toContain("Waiting 5 min");
    } finally {
      interval.mockRestore();
      setSystemTime();
    }
  });

  test("요약 줄은 에이전트·짧은 ID·대기 시간 뒤에 내게 온 이유를 붙이고, 이유는 줄을 바꿀 수 있다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      title: "hello.txt",
      agent: "Repo Helper",
      relations: ["administered", "shared", "started"],
      extra: { now: Date.parse("2026-10-21T01:11:00.000Z") },
    });
    await view.findByText("Permission request: Bash");
    const row = view.container.querySelector(
      "[data-slot='approval-row']",
    ) as HTMLElement;
    // The first of the reasons, in the design's order, without a label.
    await waitFor(() =>
      expect(row.textContent).toContain(
        `Repo Helper · ${SHORT} · Waiting 12 min · Session you started`,
      ),
    );
    expect(row.textContent).not.toContain("Why you");
    // A long reason wraps; the id and the wait stay whole.
    const parts = [...row.querySelectorAll("span")].map((part) => [
      part.textContent,
      part.className,
    ]);
    expect(parts).toContainEqual([" · Session you started", ""]);
    expect(parts).toContainEqual([" · Waiting 12 min", "whitespace-nowrap"]);
  });

  for (const [relations, reason] of [
    [["administered", "shared"], "Shared with you"],
    [["administered"], "An agent you manage"],
  ] as const) {
    test(`요약 줄의 내게 온 이유: ${relations.join("+")} → ${reason}`, async () => {
      const view = renderInbox({
        open: [QUESTION],
        layout: "summary",
        title: "README",
        agent: "Repo Helper",
        relations: [...relations],
      });
      const open = await view.findByRole("button", { name: "Answer" });
      const line = open.parentElement as HTMLElement;
      await waitFor(() =>
        expect(line.textContent).toMatch(
          new RegExp(`Repo Helper · ${SHORT} · Waiting \\d+ min · ${reason}`),
        ),
      );
    });
  }

  test("대기 목록을 다시 읽으면 내게 온 이유도 다시 읽는다", async () => {
    const view = renderInbox({
      open: [QUESTION],
      layout: "summary",
      title: "README",
    });
    const open = await view.findByRole("button", { name: "Answer" });
    const line = open.parentElement as HTMLElement;
    await waitFor(() => expect(line.textContent).toContain("Waiting"));
    expect(line.textContent).not.toContain("Shared with you");
    await view.relate(["shared"]);
    await waitFor(() =>
      expect(line.textContent).toMatch(/Waiting \d+ min · Shared with you/),
    );
  });

  for (const agentHidden of [false, true]) {
    test(`요약 줄은 관계를 모르면 이유를 빼고, 에이전트가 ${agentHidden ? "숨겨진" : "없는"} 세션은 시작한 사람이 아니라 '에이전트 없음'을 쓴다`, async () => {
      const view = renderInbox({
        open: [QUESTION],
        layout: "summary",
        title: "README",
        startedBy: "Jaesoon Jeong",
        agentHidden,
      });
      const open = await view.findByRole("button", { name: "Answer" });
      const line = open.parentElement as HTMLElement;
      await waitFor(() =>
        expect(line.textContent).toMatch(
          new RegExp(`\\?No agent · ${SHORT} · Waiting \\d+ min · Expires `),
        ),
      );
      expect(line.textContent).not.toContain("Jaesoon Jeong");
    });
  }

  test("요약 배치에서 마지막 요청에 답해 세션이 빠지면 키보드는 받은편지함 제목으로 간다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
    });
    await user.click(
      await view.findByRole("button", { name: `Allow: Bash · ${SHORT}` }),
    );
    await waitFor(() =>
      expect(view.queryByText("Permission request: Bash")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    expect(document.activeElement?.textContent).toBe("Waiting for an answer");
  });
});
