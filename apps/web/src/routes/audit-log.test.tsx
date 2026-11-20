import { describe, expect, test } from "bun:test";
import {
  type AuditEvent,
  AUDIT_EXPORT_MAX_ROWS as CONTRACT_MAX_ROWS,
  AUDIT_EXPORT_MEDIA_TYPE as CONTRACT_MEDIA_TYPE,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, USER_ID } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import {
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_EXPORT_MEDIA_TYPE,
  AUDIT_PAGE_SIZE,
  continuesRequest,
  exportEnd,
  queryOf,
} from "./audit-log.tsx";

const { renderAt, screen, within } = await appHarness();

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
    for (const name of [
      "기간 보존 기간 전체",
      "종류 모든 종류",
      "사람 모든 사람",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
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

      await user.click(screen.getByRole("button", { name: "이어서 내보내기" }));
      expect(await screen.findByText("1행을 내보냈습니다.")).toBeTruthy();
      expect(saved.length).toBe(2);
      const resumed = api.calls
        .filter((call) => call.headers.get("accept") === CONTRACT_MEDIA_TYPE)
        .map((call) => new URLSearchParams(call.search).get("cursor"));
      expect(resumed).toEqual([null, null, "c-next"]);
      expect(
        screen.queryByRole("button", { name: "이어서 내보내기" }),
      ).toBeNull();
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
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
