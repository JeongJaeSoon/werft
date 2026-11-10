import { describe, expect, test } from "bun:test";
import {
  type SlackAppKind,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "@werft-ai/platform";
import { refusal } from "@werft-ai/platform/testing/refusal";
import { createSlackConfigTokens } from "./slack-config-token.ts";
import {
  createSlackSecretService,
  slackPublicUrlsOf,
} from "./slack-secret-service.ts";
import {
  createFakeSlackConfigApi,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
} from "./testing/slack-fakes.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000f2";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const KEY = "019a0000-0000-7000-8000-0000000000e1";
const APP = "019a0000-0000-7000-8000-00000000a991";
const UNREAD = async (): Promise<string> => {
  throw new Error("the body was read for a refused caller");
};

const agents: AgentAuthority = {
  agentOf: async () => null,
  isAdmin: async () => false,
};

function user(
  role: WorkspaceRole,
  surface: "web" | "api" = "web",
  workspace = WORKSPACE,
): Caller {
  return callerFor(
    {
      kind: "user",
      id: OWNER,
      workspace_id: workspace,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: surface },
    crypto.randomUUID(),
  );
}

const key = callerFor(
  {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "api" },
  crypto.randomUUID(),
  { creatorId: OWNER },
);

function serviceWith(
  options: { off?: boolean; appKind?: SlackAppKind | null } = {},
) {
  const secrets = createMemorySecretStore();
  const tokenStore = createMemoryConfigTokenStore(secrets);
  const slack = createFakeSlackConfigApi();
  const service = createSlackSecretService({
    authorization: createAuthorizationPolicy({ agents }),
    store: options.off ? null : secrets.store,
    tokens: options.off
      ? null
      : createSlackConfigTokens({ store: tokenStore.store, api: slack.api }),
    urls: slackPublicUrlsOf(
      "https://console.example.test",
      "https://events.example.test/prefix",
    ),
    appKind: async () => options.appKind ?? null,
  });
  return { service, secrets, slack, tokenStore };
}

describe("slackPublicUrlsOf", () => {
  test("the redirect is the console origin plus the link page's fixed path", () => {
    expect(slackPublicUrlsOf("https://console.example.test", null)).toEqual({
      redirect_url:
        "https://console.example.test/settings/linked-accounts/slack",
      events_url_template: null,
    });
  });

  test("the events address keeps a path prefix and leaves the agent id as a placeholder", () => {
    expect(
      slackPublicUrlsOf(null, "https://events.example.test/prefix/"),
    ).toEqual({
      redirect_url: null,
      events_url_template:
        "https://events.example.test/prefix/v1/slack/events/{agent_id}",
    });
  });
});

describe("Slack secret service", () => {
  test.each(["owner", "admin"] as const)(
    "an %s in a console session sets, reads back the summary and deletes",
    async (role) => {
      const { service, secrets, slack, tokenStore } = serviceWith();
      const caller = user(role);
      const pasted = slack.issueRefresh();
      const set = await service.setConfigToken(
        caller,
        WORKSPACE,
        async () => pasted,
      );
      const stored = tokenStore.pair(WORKSPACE);
      expect(set).toMatchObject({
        configured: true,
        state: "active",
        issuer: { user_id: "U0ISSUER", team_id: "T0FAKE" },
        warnings: [],
      });
      for (const value of [
        pasted,
        stored?.access_token,
        stored?.refresh_token,
      ]) {
        expect(JSON.stringify(set)).not.toContain(value ?? "-");
      }
      const read = await service.describeConfigToken(caller, WORKSPACE);
      expect(read).toEqual({
        configured: true,
        last4: set.last4,
        updated_at: "2026-10-23T00:00:00.000Z",
        updated_by: { user_id: OWNER, display_name: "Owner" },
        urls: {
          redirect_url:
            "https://console.example.test/settings/linked-accounts/slack",
          events_url_template:
            "https://events.example.test/prefix/v1/slack/events/{agent_id}",
        },
        state: "active",
        expires_at: set.expires_at,
        issuer: { user_id: "U0ISSUER", team_id: "T0FAKE" },
      });
      const deleted = await service.deleteConfigToken(caller, WORKSPACE);
      expect(secrets.receipts.map(({ id }) => id)).toEqual([
        set.receipt_id,
        deleted.receipt_id,
      ]);
      expect(await service.describeConfigToken(caller, WORKSPACE)).toEqual({
        configured: false,
        last4: null,
        updated_at: null,
        updated_by: null,
        urls: {
          redirect_url:
            "https://console.example.test/settings/linked-accounts/slack",
          events_url_template:
            "https://events.example.test/prefix/v1/slack/events/{agent_id}",
        },
        state: "unset",
        expires_at: null,
        issuer: null,
      });
    },
  );

  test("a token pasted by another Slack user is stored with a warning", async () => {
    const { service, slack } = serviceWith();
    await service.setConfigToken(user("owner"), WORKSPACE, async () =>
      slack.issueRefresh(),
    );
    slack.state.userId = "U0SECOND";
    const set = await service.setConfigToken(
      user("owner"),
      WORKSPACE,
      async () => slack.issueRefresh(),
    );
    expect(set.warnings).toEqual([
      {
        code: "config_token_issuer_changed",
        previous_user_id: "U0ISSUER",
        user_id: "U0SECOND",
      },
    ]);
  });

  test("a member is refused before anything is read or written", async () => {
    const { service, secrets, slack } = serviceWith();
    for (const attempt of [
      service.setConfigToken(user("member"), WORKSPACE, UNREAD),
      service.describeConfigToken(user("member"), WORKSPACE),
      service.deleteConfigToken(user("member"), WORKSPACE),
    ]) {
      expect((await refusal(attempt)).code).toBe("FORBIDDEN");
    }
    expect(secrets.values.size).toBe(0);
    expect(slack.state.calls).toEqual([]);
  });

  test("an API key, or an owner calling on a key's surface, is refused", async () => {
    const { service, secrets } = serviceWith();
    expect(
      (await refusal(service.setConfigToken(key, WORKSPACE, UNREAD))).code,
    ).toBe("FORBIDDEN");
    expect(
      await refusal(
        service.setConfigToken(user("owner", "api"), WORKSPACE, UNREAD),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(secrets.values.size).toBe(0);
  });

  test("an owner of another workspace finds nothing", async () => {
    const { service } = serviceWith();
    const caller = user("owner", "web", OTHER_WORKSPACE);
    expect(
      (await refusal(service.setConfigToken(caller, WORKSPACE, UNREAD))).code,
    ).toBe("NOT_FOUND");
  });

  test("without a master key the API answers unavailable", async () => {
    const { service } = serviceWith({ off: true });
    expect(
      (await refusal(service.describeConfigToken(user("owner"), WORKSPACE)))
        .code,
    ).toBe("BACKEND_UNAVAILABLE");
  });

  test("deleting what was never set is not found", async () => {
    const { service } = serviceWith();
    expect(
      (await refusal(service.deleteConfigToken(user("owner"), WORKSPACE))).code,
    ).toBe("NOT_FOUND");
  });

  test.each(["agent", "link"] as const)(
    "a person cannot write the secrets of an app the platform created (%s)",
    async (kind) => {
      const { service, secrets } = serviceWith({ appKind: kind });
      expect(
        await refusal(
          service.setAppSecret(
            user("owner"),
            WORKSPACE,
            APP,
            "slack_signing_secret",
            UNREAD,
          ),
        ),
      ).toEqual({
        code: "FORBIDDEN",
        details: { reason_code: "server_managed_secret" },
      });
      expect(secrets.values.size).toBe(0);
    },
  );

  test("a manual app's secret is set on that app alone", async () => {
    const { service, secrets, slack } = serviceWith({ appKind: "manual" });
    await service.setAppSecret(
      user("owner"),
      WORKSPACE,
      APP,
      "slack_signing_secret",
      async () => slack.issueRefresh(),
    );
    expect([...secrets.values.keys()]).toEqual([
      `${WORKSPACE}|slack_app:${APP}|slack_signing_secret`,
    ]);
  });

  test("an unknown app is not found", async () => {
    const { service } = serviceWith({ appKind: null });
    const attempt = service.setAppSecret(
      user("owner"),
      WORKSPACE,
      APP,
      "slack_bot_token",
      UNREAD,
    );
    expect((await refusal(attempt)).code).toBe("NOT_FOUND");
  });
});
