import { describe, expect, test } from "bun:test";
import { focusManager } from "@tanstack/react-query";
import {
  type AuditEvent,
  AUDIT_EXPORT_MAX_ROWS as CONTRACT_MAX_ROWS,
  AUDIT_EXPORT_MEDIA_TYPE as CONTRACT_MEDIA_TYPE,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, USER_ID } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, within, waitFor } = await appHarness();
// After the harness: Radix Popover portals only when it found a DOM at import.
const {
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_EXPORT_MEDIA_TYPE,
  AUDIT_PAGE_SIZE,
  continuesRequest,
  exportEnd,
  queryOf,
} = await import("./audit-log.tsx");

const PAGE = "/settings/workspace/audit-log";
const API = "GET /v1/audit/events";
const RETENTION = "2026-08-22T00:00:00.000Z";
const MEMBER_ID = "0b1d0c7e-1f27-4a3e-8a8e-9c1b2d3e4f51";
const REQUEST = "req-0123456789abcdef";

const row = (over: Partial<AuditEvent>): AuditEvent => ({
  kind: "decision",
  id: crypto.randomUUID(),
  at: "2026-11-20T06:51:25.123Z",
  request_id: null,
  actor: {
    principal_kind: "user",
    principal_id: USER_ID,
    user_id: USER_ID,
    agent_id: null,
  },
  action: "audit_log.read",
  target: { kind: "workspace", id: "6d4c1f5e-4c39-4d7a-9a51-0f4f3c7a2b10" },
  outcome: "allow",
  reason_code: null,
  surface: "web",
  ...over,
});

const page = (items: AuditEvent[], next: string | null = null) =>
  json(200, { items, next_cursor: next, retention_start: RETENTION });

const member = (user_id: string, display_name: string) => ({
  user_id,
  email: `${display_name.toLowerCase()}@example.com`,
  display_name,
  role: "member",
  disabled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
  actions: {
    change_role: {
      owner: { allowed: true },
      admin: { allowed: true },
      member: { allowed: true },
    },
    disable: { allowed: true },
    enable: { allowed: true },
  },
  administered_agents: [],
  last_active_at: null,
});

const members = () =>
  json(200, {
    items: [member(USER_ID, "Owner"), member(MEMBER_ID, "Mina")],
    next_cursor: null,
    assignable_roles: ["owner", "admin", "member"],
  });

const routes = (
  events: (request?: Request) => Response,
  role: "owner" | "admin" | "member" = "owner",
) => ({
  "GET /v1/auth/me": () => json(200, me(undefined, role)),
  "GET /v1/members": members,
  [API]: events,
});

const table = () => screen.findByRole("table", { name: "감사 기록" });
const COUNTS_PATH = "/v1/audit/events/counts";
const COUNTS = `GET ${COUNTS_PATH}`;

describe("설정 › 감사 기록", () => {
  test("거절 행은 거절과 이유를, 긴 값은 줄여 보이되 전체를 title에 둔다", async () => {
    const long = `agent.${"x".repeat(200)}`;
    renderAt(
      PAGE,
      routes(() =>
        page([
          row({
            outcome: "deny",
            reason_code: "role",
            action: "member.manage",
            actor: {
              principal_kind: "user",
              principal_id: MEMBER_ID,
              user_id: MEMBER_ID,
              agent_id: null,
            },
          }),
          row({
            kind: "receipt",
            action: long,
            outcome: "succeeded",
            surface: null,
          }),
        ]),
      ),
    );
    const grid = await table();
    const [, denied, receipt] = within(grid).getAllByRole("row");
    expect(denied?.textContent).toContain("Mina");
    expect(denied?.textContent).toContain("거절");
    expect(denied?.textContent).toContain("role");
    expect(denied?.textContent).toContain("member.manage");
    expect(within(receipt as HTMLElement).getByTitle(long).textContent).toBe(
      long,
    );
    expect(receipt?.textContent).toContain("성공");
    expect(screen.getByText(/보존 기간 안의 기록만 보입니다/)).toBeTruthy();
  });

  test("같은 요청의 행은 이어 붙고 요청 id는 첫 행에만 있다", async () => {
    renderAt(
      PAGE,
      routes(() =>
        page([
          row({
            request_id: REQUEST,
            outcome: "allow",
            action: "member.manage",
          }),
          row({
            kind: "receipt",
            request_id: REQUEST,
            action: "change_role",
            outcome: "succeeded",
          }),
          row({ request_id: "req-other" }),
        ]),
      ),
    );
    const grid = await table();
    const [, first, second, third] = within(grid).getAllByRole("row");
    expect(within(first as HTMLElement).getByTitle(REQUEST).textContent).toBe(
      REQUEST.slice(0, 8),
    );
    expect(second?.getAttribute("data-same-request")).toBe("true");
    expect(second?.textContent).toContain("같은 요청");
    expect(within(second as HTMLElement).queryByTitle(REQUEST)).toBeNull();
    expect(third?.getAttribute("data-same-request")).toBeNull();
  });

  test("맞는 기록이 없으면 빈 상태를 보인다", async () => {
    renderAt(
      PAGE,
      routes(() => page([])),
    );
    expect(
      await screen.findByText("이 조건에 맞는 기록이 없습니다."),
    ).toBeTruthy();
  });

  test("처음에는 거름 없이 보존 기간 전체를 읽고, 거름 칩은 지금 값을 말한다", async () => {
    const { api } = renderAt(
      PAGE,
      routes(() => page([row({})])),
    );
    await table();
    const first = api.calls.find((call) => call.path === "/v1/audit/events");
    expect(first?.search).toBe(`?limit=${AUDIT_PAGE_SIZE}`);
    expect(screen.getByRole("button", { name: "필터" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "적용한 필터" })).toBeNull();
    // Counts wait for the filters to open.
    expect(api.calls.some((call) => call.path === COUNTS_PATH)).toBe(false);
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "필터" }));
    const panel = await screen.findByRole("dialog", { name: "필터" });
    for (const name of [/^기간 /, /^종류 /, /^사람 /]) {
      expect(within(panel).queryByRole("button", { name })).toBeNull();
    }
    expect(
      within(panel)
        .getAllByRole("button", { expanded: false })
        .map((header) => header.textContent),
    ).toEqual(["종류", "사람"]);
  });

  test("기간·종류 값마다 개수 API가 같은 조건으로 센 수가 붙고, 고른 기간은 목록과 같은 창을 센다", async () => {
    const asked: URLSearchParams[] = [];
    const count = (n: number) => ({ count: Math.min(n, 1000), more: n > 1000 });
    const { api } = renderAt(PAGE, {
      ...routes(() => page([row({})])),
      [COUNTS]: (request?: Request) => {
        const params = new URL(request?.url ?? "http://x").searchParams;
        asked.push(params);
        // Ten decisions a day over a 90-day window, and 7 receipts.
        const days = params.get("from")
          ? (Date.now() - Date.parse(params.get("from") ?? "")) / 86_400_000
          : 90;
        const decision =
          params.get("kind") === "receipt" ? 0 : Math.round(days * 10);
        const receipt = params.get("kind") === "decision" ? 0 : 7;
        return json(200, {
          counts: { decision: count(decision), receipt: count(receipt) },
          total: count(decision + receipt),
        });
      },
    });
    await table();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "필터" }));
    const panel = await screen.findByRole("dialog", { name: "필터" });
    const period = within(panel).getByRole("list", { name: "기간" });
    await waitFor(() =>
      expect(
        within(period)
          .getAllByRole("button")
          .map((choice) => choice.textContent),
      ).toEqual([
        "보존 기간 전체 907907개",
        "지난 24시간 1717개",
        "지난 7일 7777개",
        "지난 30일 307307개",
      ]),
    );
    await user.click(within(panel).getByRole("button", { name: "종류" }));
    const kinds = within(panel).getByRole("list", { name: "종류" });
    await waitFor(() =>
      expect(
        within(kinds).getByRole("button", { name: /^모든 종류/ }).textContent,
      ).toBe("모든 종류 907907개"),
    );

    await user.click(
      within(period).getByRole("button", { name: /^지난 30일/ }),
    );
    const listed = api.calls.filter((call) => call.path === "/v1/audit/events");
    const from = new URLSearchParams(listed.at(-1)?.search).get("from");
    // The list reads the very window its count counted.
    expect(asked.some((params) => params.get("from") === from)).toBe(true);
    expect(
      asked.every((params) => !params.has("limit") && !params.has("cursor")),
    ).toBe(true);
  });

  test("개수는 짧은 기간부터 하나씩 읽어, 읽기마다 남는 기록 때문에 긴 기간이 더 작아지지 않는다", async () => {
    let open = 0;
    let most = 0;
    const order: (string | null)[] = [];
    const zero = { count: 0, more: false };
    renderAt(PAGE, {
      ...routes(() => page([row({})])),
      [COUNTS]: (request?: Request) => {
        const params = new URL(request?.url ?? "http://x").searchParams;
        order.push(params.get("from"));
        open += 1;
        most = Math.max(most, open);
        return new Promise<Response>((resolve) =>
          setTimeout(() => {
            open -= 1;
            resolve(
              json(200, {
                counts: { decision: zero, receipt: zero },
                total: zero,
              }),
            );
          }, 5),
        );
      },
    });
    await table();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "필터" }));
    await waitFor(() => expect(order).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toHaveLength(4);
    expect(most).toBe(1);
    // 24 hours, 7 days, 30 days, then the whole window (no `from`).
    const starts = order.map((from) => (from ? Date.parse(from) : 0));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    expect(order.at(-1)).toBeNull();
    // Reopening and coming back to the window read them again, still in turn.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "필터" }));
    await waitFor(() => expect(order).toHaveLength(8));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(order).toHaveLength(12));
    focusManager.setFocused(undefined);
    expect(most).toBe(1);
  });

  test("개수를 읽는 중에 패널을 닫으면 남은 개수는 읽지 않는다", async () => {
    let asked = 0;
    let answer = () => {};
    const zero = { count: 0, more: false };
    renderAt(PAGE, {
      ...routes(() => page([row({})])),
      [COUNTS]: (request?: Request) => {
        asked += 1;
        return new Promise<Response>((resolve, reject) => {
          // As fetch does: an aborted request fails instead of answering.
          request?.signal.addEventListener("abort", () =>
            reject(request.signal.reason),
          );
          answer = () =>
            resolve(
              json(200, {
                counts: { decision: zero, receipt: zero },
                total: zero,
              }),
            );
        });
      },
    });
    await table();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "필터" }));
    await waitFor(() => expect(asked).toBe(1));
    await user.keyboard("{Escape}");
    answer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(1);
  });

  test("1000을 넘는 개수는 1000+로 읽힌다", async () => {
    renderAt(PAGE, {
      ...routes(() => page([row({})])),
      [COUNTS]: () =>
        json(200, {
          counts: {
            decision: { count: 1000, more: true },
            receipt: { count: 1000, more: false },
          },
          total: { count: 1000, more: true },
        }),
    });
    await table();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "필터" }));
    const panel = await screen.findByRole("dialog", { name: "필터" });
    await user.click(within(panel).getByRole("button", { name: "종류" }));
    const kinds = within(panel).getByRole("list", { name: "종류" });
    expect(
      await within(kinds).findByRole("button", { name: "권한 판정 1000+개" }),
    ).toBeTruthy();
    expect(
      within(kinds).getByRole("button", { name: /^명령 기록 1000개/ }),
    ).toBeTruthy();
  });

  test("칩의 ×는 그 거름만 풀고 모두 지우기는 처음 조건으로 되돌린다", async () => {
    const { api } = renderAt(
      PAGE,
      routes(() => page([row({})])),
    );
    await table();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "필터" }));
    const panel = await screen.findByRole("dialog", { name: "필터" });
    await user.click(within(panel).getByRole("button", { name: /^지난 7일/ }));
    await user.click(within(panel).getByRole("button", { name: "종류" }));
    await user.click(within(panel).getByRole("button", { name: /^권한 판정/ }));
    await user.keyboard("{Escape}");
    const chips = await screen.findByRole("group", { name: "적용한 필터" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["기간 지난 7일", "종류 권한 판정"]);
    const last = () =>
      new URLSearchParams(
        api.calls.filter((call) => call.path === "/v1/audit/events").at(-1)
          ?.search,
      );
    await waitFor(() => expect(last().get("kind")).toBe("decision"));
    expect(last().has("from")).toBe(true);

    await user.click(
      within(chips).getByRole("button", { name: "기간 필터 빼기: 지난 7일" }),
    );
    await waitFor(() => expect(last().has("from")).toBe(false));
    expect(last().get("kind")).toBe("decision");

    await user.click(screen.getByRole("button", { name: "모두 지우기" }));
    await waitFor(() =>
      expect(last().toString()).toBe(`limit=${AUDIT_PAGE_SIZE}`),
    );
    expect(screen.queryByRole("group", { name: "적용한 필터" })).toBeNull();
  });

  test("owner가 아니면 메뉴에도 없고 주소로 열어도 없는 화면이며 기록을 읽지 않는다", async () => {
    const { api } = renderAt(
      PAGE,
      routes(() => page([row({})]), "admin"),
    );
    expect(await screen.findByText(/찾을 수 없/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "감사 기록" })).toBeNull();
    expect(api.calls.some((call) => call.path === "/v1/audit/events")).toBe(
      false,
    );
  });

  test("owner의 설정 메뉴에 감사 기록이 있다", async () => {
    renderAt(
      PAGE,
      routes(() => page([row({})])),
    );
    await table();
    expect(
      screen.getAllByRole("link", { name: "감사 기록" }).length,
    ).toBeGreaterThan(0);
  });

  test("내보내기는 끝 줄이 온 파일만 저장하고, 상한에서 멈추면 이어서 받게 한다", async () => {
    const user = await setupUser();
    const line = JSON.stringify({ ...row({}), cursor: "c-row" });
    const exports = [
      // Cut: no end line.
      `${line}\n`,
      `${line}\n{"kind":"end","rows":${AUDIT_EXPORT_MAX_ROWS},"truncated":true,"next_cursor":"c-next"}\n`,
      // The rest, cut once, then whole.
      `${line}\n`,
      `${line}\n{"kind":"end","rows":1,"truncated":false,"next_cursor":null}\n`,
    ];
    const saved: Blob[] = [];
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (file: Blob) => {
      saved.push(file);
      return "blob:test";
    };
    URL.revokeObjectURL = () => {};
    try {
      const { api } = renderAt(
        PAGE,
        routes((request?: Request) =>
          request?.headers.get("accept") === CONTRACT_MEDIA_TYPE
            ? new Response(exports.shift(), {
                headers: { "content-type": CONTRACT_MEDIA_TYPE },
              })
            : page([row({})]),
        ),
      );
      await table();
      const button = () =>
        screen.getByRole("button", { name: "내보내기 (NDJSON)" });

      await user.click(button());
      expect(
        await screen.findByText(
          /내보내기가 끝까지 오지 않아 파일을 저장하지 않았습니다/,
        ),
      ).toBeTruthy();
      expect(saved.length).toBe(0);

      await user.click(button());
      expect(await screen.findByText(/100,000행에서 멈췄습니다/)).toBeTruthy();
      expect(saved.length).toBe(1);

      const resume = () =>
        screen.getByRole("button", { name: "이어서 내보내기" });
      await user.click(resume());
      expect(
        await screen.findByText(
          /내보내기가 끝까지 오지 않아 파일을 저장하지 않았습니다/,
        ),
      ).toBeTruthy();
      expect(saved.length).toBe(1);

      // The failure kept where to continue from.
      await user.click(resume());
      expect(await screen.findByText("1행을 내보냈습니다.")).toBeTruthy();
      expect(saved.length).toBe(2);
      const resumed = api.calls
        .filter((call) => call.headers.get("accept") === CONTRACT_MEDIA_TYPE)
        .map((call) => new URLSearchParams(call.search).get("cursor"));
      expect(resumed).toEqual([null, null, "c-next", "c-next"]);
      expect(
        screen.queryByRole("button", { name: "이어서 내보내기" }),
      ).toBeNull();
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });

  test("화면을 떠나면 진행 중인 내보내기를 끊고 그 파일을 저장하지 않는다", async () => {
    const user = await setupUser();
    let answer: (response: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    const saved: Blob[] = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = (file: Blob) => {
      saved.push(file);
      return "blob:test";
    };
    try {
      const { history } = renderAt(
        PAGE,
        routes((request?: Request) => {
          if (request?.headers.get("accept") !== CONTRACT_MEDIA_TYPE) {
            return page([row({})]);
          }
          signal = request.signal;
          return new Promise<Response>((resolve) => {
            answer = resolve;
          }) as unknown as Response;
        }),
      );
      await table();
      await user.click(
        screen.getByRole("button", { name: "내보내기 (NDJSON)" }),
      );
      await screen.findByRole("button", { name: "내보내는 중…" });
      history.push("/settings/workspace/achievement-rules");
      await screen.findByRole("heading", { level: 1, name: "성과 규칙" });
      expect(signal?.aborted).toBe(true);
      answer(
        new Response(
          `{"kind":"end","rows":0,"truncated":false,"next_cursor":null}\n`,
          { headers: { "content-type": CONTRACT_MEDIA_TYPE } },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(saved.length).toBe(0);
    } finally {
      URL.createObjectURL = create;
    }
  });

  test("구성원 목록을 끝까지 읽어 두 번째 페이지의 사람도 이름으로 보인다", async () => {
    const LATE = "0b1d0c7e-1f27-4a3e-8a8e-9c1b2d3e4f52";
    const { api } = renderAt(PAGE, {
      ...routes(() =>
        page([
          row({
            actor: {
              principal_kind: "user",
              principal_id: LATE,
              user_id: LATE,
              agent_id: null,
            },
          }),
        ]),
      ),
      "GET /v1/members": (request: Request) =>
        new URL(request.url).searchParams.get("cursor") === "m2"
          ? json(200, {
              items: [member(LATE, "Late")],
              next_cursor: null,
              assignable_roles: ["owner", "admin", "member"],
            })
          : json(200, {
              items: [member(USER_ID, "Owner")],
              next_cursor: "m2",
              assignable_roles: ["owner", "admin", "member"],
            }),
    });
    const grid = await table();
    await within(grid).findByText("Late");
    expect(
      api.calls
        .filter((call) => call.path === "/v1/members")
        .map((call) => new URLSearchParams(call.search).get("cursor")),
    ).toEqual([null, "m2"]);
  });

  test("다른 내보내기가 진행 중이면 그렇다고 말한다", async () => {
    const user = await setupUser();
    renderAt(
      PAGE,
      routes((request?: Request) =>
        request?.headers.get("accept") === CONTRACT_MEDIA_TYPE
          ? apiError(429, "RATE_LIMITED", "busy", true)
          : page([row({})]),
      ),
    );
    await table();
    await user.click(screen.getByRole("button", { name: "내보내기 (NDJSON)" }));
    expect(
      await screen.findByText(/다른 내보내기가 진행 중입니다/),
    ).toBeTruthy();
  });
});

describe("exportEnd", () => {
  const file = (text: string) => new Blob([text]);

  test("reads the end line", async () => {
    expect(
      await exportEnd(
        file(
          `{"kind":"decision"}\n{"kind":"end","rows":1,"truncated":true,"next_cursor":"c1"}\n`,
        ),
      ),
    ).toEqual({ kind: "end", rows: 1, truncated: true, next_cursor: "c1" });
  });

  test("a stream cut before its end line, or cut mid-line, has none", async () => {
    expect(await exportEnd(file(`{"kind":"decision"}\n`))).toBeNull();
    expect(
      await exportEnd(file(`{"kind":"decision"}\n{"kind":"en`)),
    ).toBeNull();
    expect(await exportEnd(file(""))).toBeNull();
  });

  test("the filters become the query, each only when picked", () => {
    expect(
      queryOf({
        period: "all",
        from: undefined,
        kind: undefined,
        actor: undefined,
      }),
    ).toEqual({});
    expect(
      queryOf({
        period: "week",
        from: "2026-11-13T00:00:00.000Z",
        kind: "decision",
        actor: MEMBER_ID,
      }),
    ).toEqual({
      from: "2026-11-13T00:00:00.000Z",
      kind: "decision",
      actor_user_id: MEMBER_ID,
    });
  });

  test("the copies are the contract's", () => {
    expect(AUDIT_EXPORT_MEDIA_TYPE).toBe(CONTRACT_MEDIA_TYPE);
    expect(AUDIT_EXPORT_MAX_ROWS).toBe(CONTRACT_MAX_ROWS);
  });

  test("a row continues the request of the row above only with the same id", () => {
    const rows = [
      row({ request_id: "a" }),
      row({ request_id: "a" }),
      row({ request_id: null }),
      row({ request_id: null }),
    ];
    expect(rows.map((_, index) => continuesRequest(rows, index))).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });
});
