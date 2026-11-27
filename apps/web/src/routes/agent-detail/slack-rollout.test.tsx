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

// The notice and its approval are retired: the server answers this view.
const view = (over: Partial<Notice> = {}): Notice => ({
  notice: null,
  state: "no_notice",
  rollout: "off",
  can_approve: true,
  approvals: [],
  ...over,
});

const section = () => screen.findByRole("region", { name: "대화 스위치" });
const rolloutSwitch = (box: HTMLElement) =>
  within(box).getByRole("switch", { name: "조용히 듣기 (shadow)" });

describe("Slack conversation switch", () => {
  test("an owner turns the switch to shadow and back off with no approval asked", async () => {
    let current = view();
    const { api } = renderAt(DETAIL, {
      ...routes(() => json(200, current)),
      [`POST ${PATH}/slack/notice/rollout`]: async (request) => {
        const body = (await request.json()) as { rollout: Notice["rollout"] };
        current = { ...current, rollout: body.rollout };
        return json(200, current);
      },
    });
    const box = await section();
    const user = await setupUser();
    await waitFor(() =>
      expect(rolloutSwitch(box).getAttribute("aria-checked")).toBe("false"),
    );
    expect(rolloutSwitch(box).getAttribute("aria-disabled")).not.toBe("true");
    await user.click(rolloutSwitch(box));
    await waitFor(() =>
      expect(rolloutSwitch(box).getAttribute("aria-checked")).toBe("true"),
    );
    expect(await screen.findByText("조용히 듣기를 켰습니다.")).toBeDefined();
    await user.click(rolloutSwitch(box));
    await waitFor(() =>
      expect(rolloutSwitch(box).getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      api.calls
        .filter((call) => call.path.endsWith("/slack/notice/rollout"))
        .map((call) => call.body),
    ).toEqual([{ rollout: "shadow" }, { rollout: "off" }]);
    expect(
      api.calls.some((call) => /\/(approve|revoke)$/.test(call.path)),
    ).toBe(false);
  });

  test("the retired notice is drawn nowhere: no approval block, badge, lock or warning", async () => {
    renderAt(
      DETAIL,
      routes(() => json(200, view())),
    );
    const box = await section();
    await waitFor(() => expect(rolloutSwitch(box)).toBeDefined());
    expect(screen.queryByRole("region", { name: "고지 승인" })).toBeNull();
    expect(within(box).queryAllByRole("button")).toEqual([]);
    expect(within(box).queryAllByRole("alert")).toEqual([]);
    expect(box.textContent).not.toContain("고지");
    expect(box.textContent).not.toContain("승인");
  });

  test("whoever may not change the switch reads its state without one", async () => {
    renderAt(
      DETAIL,
      routes(() => json(200, view({ rollout: "shadow", can_approve: false }))),
    );
    const box = await section();
    await waitFor(() =>
      expect(box.textContent).toContain(
        "워크스페이스 owner·admin만 바꿀 수 있습니다.",
      ),
    );
    expect(within(box).queryByRole("switch")).toBeNull();
    expect(box.textContent).toContain("켜짐");
  });

  test("a refused change shows why and reads the switch again", async () => {
    let reads = 0;
    renderAt(DETAIL, {
      ...routes(() => {
        reads += 1;
        return json(200, view());
      }),
      [`POST ${PATH}/slack/notice/rollout`]: () =>
        apiError(403, "FORBIDDEN", "admin", false, {
          reason_code: "workspace_admin_required",
        }),
    });
    const box = await section();
    const user = await setupUser();
    await waitFor(() => expect(rolloutSwitch(box)).toBeDefined());
    await user.click(rolloutSwitch(box));
    await waitFor(() => expect(box.textContent).toContain("권한이 없습니다"));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
