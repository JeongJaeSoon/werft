import { describe, expect, test } from "bun:test";
import type { components } from "@werft-ai/client";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import { apiError, json, me } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();
const CALLBACK = `/agents/${AGENT_ID}/slack/callback?state=state1&error=access_denied`;

function completed(): components["schemas"]["CompleteSlackInstallResponse"] {
  const id = "00000000-0000-4000-8000-000000000001";
  const at = "2026-10-24T00:00:00.000Z";
  const summary = {
    configured: false,
    last4: null,
    updated_at: null,
    updated_by: null,
  };
  return {
    slack_app: {
      id,
      kind: "agent",
      agent_id: AGENT_ID,
      state: "created",
      app_id: "A123",
      client_id: "123",
      redirect_url: `https://console.test/agents/${AGENT_ID}/slack/callback`,
      created_by_token_user: "U123",
      created_at: at,
      updated_at: at,
      secrets: {
        slack_signing_secret: summary,
        slack_client_secret: summary,
        slack_bot_token: summary,
      },
    },
    installation: {
      id,
      app_id: "A123",
      team_id: "T123",
      bot_user_id: "U123",
      status: "verified",
    },
    agent_identity: {
      id,
      agent_id: AGENT_ID,
      provider: "slack_bot",
      app_id: "A123",
      team_id: "T123",
      bot_user_id: "U123",
      credential_ref: "slack/bot",
      status: "active",
      revision: 0,
      created_by: null,
      created_at: at,
      revoked_at: null,
    },
    receipt_id: null,
    finalized: true,
    warnings: [],
  };
}

describe("Slack install callback", () => {
  test("keeps reinstall warnings visible even when event finalization succeeded", async () => {
    const result = completed();
    result.warnings = [{ code: "reinstall_required" }];
    const { history } = renderAt(CALLBACK, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      "POST /v1/slack/install/complete": () => json(200, result),
    });
    await screen.findByText("재설치 필요");
    expect(history.location.pathname.endsWith("/slack/callback")).toBe(true);
    await waitFor(() =>
      expect(document.querySelector("[data-slot=toast]")?.textContent).toBe(
        "재설치 필요",
      ),
    );
  });

  test("returns a successful installation to the Slack section of the settings tab", async () => {
    const { history } = renderAt(CALLBACK, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      "POST /v1/slack/install/complete": () => json(200, completed()),
      [`GET /v1/agents/${AGENT_ID}/slack/app`]: () =>
        json(200, {
          slack_app: null,
          event_url: null,
          events: { state: "pending", checked_at: null, url: null },
          warnings: [],
          config_token: "active",
        }),
      [`GET /v1/agents/${AGENT_ID}/identities`]: () => json(200, { items: [] }),
    });
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/agents/${AGENT_ID}`),
    );
    const search = new URLSearchParams(history.location.search);
    expect([search.get("tab"), search.get("section")]).toEqual([
      "settings",
      "slack",
    ]);
    // The install lands on the Slack section of the settings tab.
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("agent-settings-slack"),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-slot=toast]")?.textContent).toBe(
        "Slack에 앱을 설치했습니다.",
      ),
    );
    // Said once: the history entry no longer carries it.
    await waitFor(() =>
      expect(history.location.state.slackInstalled).toBeUndefined(),
    );
  });

  test("shows verification guidance when finalization is incomplete", async () => {
    const result = completed();
    result.finalized = false;
    result.warnings = [{ code: "events_url_unset" }];
    renderAt(CALLBACK, {
      "GET /v1/auth/me": () => json(200, me()),
      "POST /v1/slack/install/complete": () => json(200, result),
    });
    expect(
      await screen.findByText(/이벤트 등록 확인이 필요합니다/),
    ).toBeDefined();
    // Not a plain success, and said once: the page's own output reads it.
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot=toast]")?.textContent,
      ).toContain("이벤트 등록 확인이 필요합니다"),
    );
    const toast = document.querySelector("[data-slot=toast]");
    expect(toast?.getAttribute("aria-hidden")).toBe("true");
    expect(toast?.hasAttribute("aria-live")).toBe(false);
  });
  for (const [code, message] of [
    ["SLACK_INSTALL_DENIED", "Slack에서 설치를 허용하지 않았습니다."],
    [
      "SLACK_INSTALL_STATE_INVALID",
      "설치 링크가 만료됐거나 이미 사용됐습니다.",
    ],
    [
      "SLACK_INSTALL_REJECTED",
      "Slack 앱이나 워크스페이스가 일치하지 않아 설치하지 못했습니다.",
    ],
  ] as const) {
    test(`shows ${code} once without retrying a spent state`, async () => {
      const { api } = renderAt(CALLBACK, {
        ...agentServer().routes,
        "GET /v1/auth/me": () => json(200, me()),
        "POST /v1/slack/install/complete": () =>
          apiError(409, code, "internal message"),
      });
      await screen.findByText((text) => text.startsWith(message));
      await waitFor(() =>
        expect(
          document
            .querySelector("[data-slot=toast]")
            ?.textContent?.startsWith(message),
        ).toBe(true),
      );
      expect(
        screen.getByRole("link", { name: "Slack 앱" }).getAttribute("href"),
      ).toBe(`/agents/${AGENT_ID}?tab=settings&section=slack`);
      await waitFor(() =>
        expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(
          1,
        ),
      );
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        agent_id: AGENT_ID,
        state: "state1",
        error: "access_denied",
      });
      expect(document.body.textContent).not.toContain("internal message");
    });
  }
  test("shows a processing state until the single completion request answers", async () => {
    let finish = () => {};
    const response = new Promise<Response>((resolve) => {
      finish = () => resolve(apiError(409, "SLACK_INSTALL_DENIED", "denied"));
    });
    const { api } = renderAt(CALLBACK, {
      "GET /v1/auth/me": () => json(200, me()),
      "POST /v1/slack/install/complete": () => response,
    });
    await screen.findByText("준비 중…");
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(
        1,
      ),
    );
    finish();
    await screen.findByText(/Slack에서 설치를 허용하지 않았습니다/);
  });
});
