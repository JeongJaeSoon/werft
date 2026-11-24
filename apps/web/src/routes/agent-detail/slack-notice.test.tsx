import { describe, expect, test } from "bun:test";
import type { components } from "@werft-ai/client";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  WORKSPACE_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
const PATH = `/v1/agents/${AGENT_ID}`;
const DETAIL = `/agents/${AGENT_ID}?tab=slack`;
const ID = "00000000-0000-4000-8000-000000000001";
const AT = "2026-11-24T00:00:00.000Z";
const NOT_SET = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
};

type Notice = components["schemas"]["GetSlackNoticeResponse"];

const TEXT = (lang: string) => ({
  body: [
    `${lang}: Werft는 Slack에서 읽은 글로 어떤 모델도 학습하지 않습니다.`,
    `${lang}: ${"아주 긴 문단이 넘치지 않는다".repeat(20)}`,
  ],
  policy_link: {
    label: `${lang}: 데이터 처리와 저장`,
    href: `https://docs.example.test/${lang}/data`,
  },
});
const NOTICE: NonNullable<Notice["notice"]> = {
  version: 2,
  requires_reapproval: true,
  text: { ko: TEXT("ko"), ja: TEXT("ja") },
};
const APPROVAL: Notice["approvals"][number] = {
  id: "00000000-0000-4000-8000-0000000000a1",
  slack_team_id: "T123",
  notice_version: 2,
  counts: true,
  approved_by: {
    user_id: "00000000-0000-4000-8000-0000000000b1",
    display_name: "관리자 김",
    email: "admin@example.test",
  },
  approved_at: AT,
};
const view = (over: Partial<Notice> = {}): Notice => ({
  notice: NOTICE,
  state: "not_approved",
  can_approve: true,
  approvals: [],
  ...over,
});

function routes(notice: () => Response) {
  return {
    ...agentServer().routes,
    "GET /v1/auth/me": () => json(200, me()),
    [`GET ${PATH}/slack/app`]: () =>
      json(200, {
        slack_app: {
          id: ID,
          kind: "agent",
          agent_id: AGENT_ID,
          state: "created",
          app_id: "A123",
          client_id: "123",
          redirect_url: `https://console.test/agents/${AGENT_ID}/slack/callback`,
          created_by_token_user: "U123",
          created_at: AT,
          updated_at: AT,
          secrets: {
            slack_signing_secret: NOT_SET,
            slack_client_secret: NOT_SET,
            slack_bot_token: NOT_SET,
          },
        },
        event_url: `https://events.test/v1/slack/events/${AGENT_ID}`,
        events: { state: "pending", checked_at: null, url: null },
        warnings: [],
        config_token: "active",
      }),
    [`GET ${PATH}/identities`]: () =>
      json(200, {
        items: [
          {
            id: ID,
            agent_id: AGENT_ID,
            provider: "slack_bot",
            app_id: "A123",
            team_id: "T123",
            bot_user_id: "U123",
            credential_ref: "slack/bot",
            status: "active",
            revision: 0,
            created_by: null,
            created_at: AT,
            revoked_at: null,
          },
        ],
      }),
    [`GET ${PATH}/slack-bindings`]: () =>
      json(200, {
        items: [
          {
            id: ID,
            workspace_id: WORKSPACE_ID,
            owner_id: WORKSPACE_ID,
            surface: "slack",
            installation_id: ID,
            external_surface_id: "C123",
            surface_kind: "public_channel",
            agent_id: AGENT_ID,
            mode: "on",
            listen: "free",
            ceiling: { actions: ["session.read"], disclosure: "summary" },
            home: true,
            memory_write_policy: "deny",
            status: "ready",
            muted: false,
            revision: 0,
            created_at: AT,
            revoked_at: null,
          },
        ],
      }),
    [`GET ${PATH}/slack/app/settings`]: () => json(200, { mention_only: true }),
    [`GET ${PATH}/slack/app/bots`]: () =>
      json(200, { items: [], truncated: false }),
    [`GET ${PATH}/slack/channels`]: () =>
      json(200, {
        items: [],
        next_cursor: null,
        stale: false,
        truncated: false,
      }),
    [`GET ${PATH}/slack/notice`]: notice,
  };
}

const section = () => screen.findByRole("region", { name: "고지 승인" });

describe("Slack notice", () => {
  test("before approval an owner reads the version's words and approves in the language shown", async () => {
    let current = view();
    const { api } = renderAt(DETAIL, {
      ...routes(() => json(200, current)),
      [`POST ${PATH}/slack/notice/approve`]: () => {
        current = view({ state: "approved", approvals: [APPROVAL] });
        return json(200, current);
      },
    });
    const notice = await section();
    await waitFor(() =>
      expect(notice.textContent).toContain(
        "ko: Werft는 Slack에서 읽은 글로 어떤 모델도 학습하지 않습니다.",
      ),
    );
    expect(within(notice).getByText("승인 전").dataset.slot).toBe("badge");
    expect(notice.textContent).not.toContain("ja:");
    expect(notice.textContent).toContain("고지 2판");
    const link = within(notice).getByRole("link", {
      name: /ko: 데이터 처리와 저장/,
    });
    expect(link.getAttribute("href")).toBe("https://docs.example.test/ko/data");
    expect(link.getAttribute("target")).toBe("_blank");

    const user = await setupUser();
    await user.click(within(notice).getByRole("button", { name: "승인" }));
    await waitFor(() =>
      expect(within(notice).getByText("승인됨").dataset.slot).toBe("badge"),
    );
    expect(
      api.calls
        .filter((call) => call.path.endsWith("/slack/notice/approve"))
        .map((call) => call.body),
    ).toEqual([{ notice_version: 2, locale: "ko" }]);
    const approvals = within(notice).getByRole("list", { name: "승인 기록" });
    expect(approvals.textContent).toContain("관리자 김");
    expect(approvals.textContent).toContain("admin@example.test");
    expect(approvals.textContent).toContain("Slack 팀 T123");
    expect(
      within(notice).getByRole("button", { name: "승인 철회" }),
    ).toBeDefined();
  });

  test("a version that asks anew shows the earlier approval and 다시 승인", async () => {
    renderAt(
      DETAIL,
      routes(() =>
        json(
          200,
          view({
            state: "reapproval_required",
            approvals: [{ ...APPROVAL, notice_version: 1, counts: false }],
          }),
        ),
      ),
    );
    const notice = await section();
    await waitFor(() =>
      expect(within(notice).getByText("다시 승인 필요").dataset.slot).toBe(
        "badge",
      ),
    );
    expect(notice.textContent).toContain(
      "다시 승인할 때까지 이 에이전트는 채널의 글을 듣지 않습니다.",
    );
    expect(
      within(notice).getByRole("list", { name: "승인 기록" }).textContent,
    ).toContain("이전 판");
    expect(
      within(notice).getByRole("button", { name: "다시 승인" }),
    ).toBeDefined();
  });

  test("whoever may not approve reads the notice and who approved it, without buttons or email", async () => {
    renderAt(
      DETAIL,
      routes(() =>
        json(
          200,
          view({
            state: "approved",
            can_approve: false,
            approvals: [
              {
                ...APPROVAL,
                approved_by: { ...APPROVAL.approved_by, email: null },
              },
            ],
          }),
        ),
      ),
    );
    const notice = await section();
    await waitFor(() =>
      expect(notice.textContent).toContain(
        "워크스페이스 owner·admin만 승인할 수 있습니다.",
      ),
    );
    expect(notice.textContent).toContain("ko: Werft는");
    expect(
      within(notice).getByRole("list", { name: "승인 기록" }).textContent,
    ).toContain("관리자 김");
    expect(notice.textContent).not.toContain("@");
    expect(within(notice).queryAllByRole("button")).toEqual([]);
  });

  test("before any version is published the place is held and 승인 is locked", async () => {
    const { api } = renderAt(
      DETAIL,
      routes(() => json(200, view({ notice: null, state: "no_notice" }))),
    );
    const notice = await section();
    await waitFor(() =>
      expect(notice.textContent).toContain("아직 게시된 고지가 없습니다."),
    );
    const approve = within(notice).getByRole("button", { name: "승인" });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    const user = await setupUser();
    await user.click(approve);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("an English screen picks Japanese first, can switch to Korean, and approves in the one shown", async () => {
    const { api } = renderAt(
      DETAIL,
      {
        ...routes(() => json(200, view())),
        [`POST ${PATH}/slack/notice/approve`]: () =>
          json(200, view({ state: "approved", approvals: [APPROVAL] })),
      },
      "en",
    );
    const notice = await screen.findByRole("region", {
      name: "Notice approval",
    });
    await waitFor(() => expect(notice.textContent).toContain("ja: Werft는"));
    expect(notice.textContent).toContain(
      "This notice is available in Japanese and Korean.",
    );
    expect(notice.textContent).not.toContain("ko: Werft는");
    const user = await setupUser();
    await user.click(within(notice).getByRole("button", { name: "한국어" }));
    expect(notice.textContent).toContain("ko: Werft는");
    await user.click(within(notice).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        api.calls
          .filter((call) => call.path.endsWith("/slack/notice/approve"))
          .map((call) => call.body),
      ).toEqual([{ notice_version: 2, locale: "ko" }]),
    );
  });

  test("a revoke asks first and shows the notice unapproved", async () => {
    let current = view({ state: "approved", approvals: [APPROVAL] });
    const { api } = renderAt(DETAIL, {
      ...routes(() => json(200, current)),
      [`POST ${PATH}/slack/notice/revoke`]: () => {
        current = view();
        return json(200, current);
      },
    });
    const notice = await section();
    const user = await setupUser();
    await user.click(
      await within(notice).findByRole("button", { name: "승인 철회" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "다시 승인할 때까지 Slack 채널의 글을 듣지 않습니다.",
    );
    await user.click(within(dialog).getByRole("button", { name: "승인 철회" }));
    await waitFor(() =>
      expect(within(notice).getByText("승인 전").dataset.slot).toBe("badge"),
    );
    expect(
      api.calls.filter((call) => call.path.endsWith("/revoke")),
    ).toHaveLength(1);
  });

  test("a version that changed under the reader is refused with words, and the new one is read", async () => {
    let reads = 0;
    renderAt(DETAIL, {
      ...routes(() => {
        reads += 1;
        return json(200, view());
      }),
      [`POST ${PATH}/slack/notice/approve`]: () =>
        apiError(409, "REVISION_CONFLICT", "stale", false, {
          reason_code: "notice_version_stale",
        }),
    });
    const notice = await section();
    const user = await setupUser();
    await user.click(
      await within(notice).findByRole("button", { name: "승인" }),
    );
    await waitFor(() =>
      expect(notice.textContent).toContain("그사이 고지가 바뀌었습니다."),
    );
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
