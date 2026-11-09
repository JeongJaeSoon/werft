import { describe, expect, test } from "bun:test";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { refusal } from "../testing/refusal.ts";
import {
  createFakeSlackConfigApi,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
} from "../testing/slack-fakes.ts";
import { type Caller, callerFor, createAuthorizationPolicy } from "./policy.ts";
import { SLACK_APP_CREATE_STALE_MS } from "./slack-app-service.ts";
import { SlackApiError } from "./slack-config-api.ts";
import { createSlackConfigTokens } from "./slack-config-token.ts";
import {
  createSlackLinkAppService,
  SLACK_LINK_APP_WAIT_MS,
} from "./slack-link-app-service.ts";
import { LINK_APP_COPY } from "./slack-manifest.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000f2";
const ORIGIN = "https://console.example.ts.net";
const LINK_REDIRECT = `${ORIGIN}/settings/linked-accounts/slack`;

function user(
  role: WorkspaceRole,
  options: { surface?: "web" | "api"; workspace?: string } = {},
): Caller {
  return callerFor(
    {
      kind: "user",
      id: crypto.randomUUID(),
      workspace_id: options.workspace ?? WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: options.surface ?? "web" },
    crypto.randomUUID(),
  );
}

async function setup(
  options: {
    register?: boolean;
    consoleOrigin?: string | null;
    storeOff?: boolean;
  } = {},
) {
  let clock = new Date("2026-10-24T00:00:00.000Z");
  const secrets = createMemorySecretStore();
  const tokenStore = createMemoryConfigTokenStore(secrets);
  const slack = createFakeSlackConfigApi({ now: () => clock });
  const apps = createMemorySlackAppStore({
    secrets,
    now: () => clock,
    agents: new Map(),
    workspaces: new Map([
      [WORKSPACE, "Acme"],
      [OTHER_WORKSPACE, "Globex"],
    ]),
  });
  const tokens = createSlackConfigTokens({
    store: tokenStore.store,
    api: slack.api,
    now: () => clock,
  });
  const service = createSlackLinkAppService({
    authorization: createAuthorizationPolicy({}),
    apps: options.storeOff ? null : apps.store,
    tokens: options.storeOff ? null : tokens,
    api: slack.api,
    consoleOrigin:
      options.consoleOrigin === undefined ? ORIGIN : options.consoleOrigin,
    now: () => clock,
    sleep: async (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
  });
  if (options.register !== false) {
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
      await tokens.register(workspace, slack.issueRefresh(), {
        principal: user("owner", { workspace }),
        receiptId: crypto.randomUUID(),
        roles: ["owner", "admin"],
      });
    }
  }
  const creates = () =>
    slack.state.calls.filter((call) => call.method === "apps.manifest.create")
      .length;
  return {
    service,
    slack,
    apps,
    secrets,
    tokenStore,
    creates,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe("a start with no link app", () => {
  test("a member's first start makes the link app and links with it", async () => {
    const { service, slack, apps, secrets, creates } = await setup();
    const client = await service.clientForStart(user("member"));
    expect(creates()).toBe(1);
    const [row] = [...apps.rows.values()];
    expect(row).toMatchObject({
      kind: "link",
      agentId: null,
      state: "created",
      redirectUrl: LINK_REDIRECT,
    });
    expect(client).toEqual({
      clientId: row?.clientId ?? "",
      clientSecret: expect.any(String),
      redirectUri: LINK_REDIRECT,
      slackAppId: row?.id ?? "",
    });
    const [made] = [...slack.state.apps.values()];
    expect(made?.manifest).toMatchObject({
      display_information: { name: `Acme${LINK_APP_COPY.nameSuffix}` },
      oauth_config: {
        redirect_urls: [LINK_REDIRECT],
        scopes: { user: ["openid", "profile"] },
      },
    });
    // The client secret is sealed under the app; the start hands it only
    // to the server's own exchange.
    const sealed = [...secrets.values.entries()].find(([key]) =>
      key.includes(`slack_app:${row?.id}|slack_client_secret`),
    );
    expect(sealed?.[1].value).toBe(client.clientSecret);
  });

  test("a second start, sequential or concurrent, uses the same app", async () => {
    const { service, creates } = await setup();
    const [first, second] = await Promise.all([
      service.clientForStart(user("member")),
      service.clientForStart(user("admin")),
    ]);
    const third = await service.clientForStart(user("member"));
    expect(creates()).toBe(1);
    expect(second.clientId).toBe(first.clientId);
    expect(third.clientId).toBe(first.clientId);
  });

  test("each workspace gets its own link app", async () => {
    const { service, creates } = await setup();
    const acme = await service.clientForStart(user("member"));
    const globex = await service.clientForStart(
      user("member", { workspace: OTHER_WORKSPACE }),
    );
    expect(creates()).toBe(2);
    expect(globex.clientId).not.toBe(acme.clientId);
  });

  test("an unset config token is a typed refusal, not 503, and writes no row", async () => {
    const { service, apps, creates } = await setup({ register: false });
    expect(await refusal(service.clientForStart(user("member")))).toEqual({
      code: "SLACK_LINK_NOT_CONFIGURED",
      details: { reason_code: "config_token" },
    });
    expect(creates()).toBe(0);
    expect(apps.rows.size).toBe(0);
  });

  test("a config token that needs re-entry is the same typed refusal", async () => {
    const { service, tokenStore, creates } = await setup();
    const meta = tokenStore.meta.get(WORKSPACE);
    if (meta) meta.state = "needs_reentry";
    expect((await refusal(service.clientForStart(user("member")))).code).toBe(
      "SLACK_LINK_NOT_CONFIGURED",
    );
    expect(creates()).toBe(0);
  });

  test("Slack refusing the token mid-call is the same typed refusal", async () => {
    const { service, slack, apps } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "invalid_auth", true);
    };
    expect((await refusal(service.clientForStart(user("member")))).code).toBe(
      "SLACK_LINK_NOT_CONFIGURED",
    );
    expect([...apps.rows.values()][0]?.state).toBe("failed");
  });

  test("Slack refusing the manifest fails the row; the next start tries again", async () => {
    const { service, slack, apps, creates } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "invalid_manifest", true);
    };
    expect(await refusal(service.clientForStart(user("member")))).toMatchObject(
      {
        code: "BACKEND_UNAVAILABLE",
        details: { slack_error: "invalid_manifest" },
      },
    );
    await service.clientForStart(user("member"));
    expect([...apps.rows.values()].map((row) => row.state).sort()).toEqual([
      "created",
      "failed",
    ]);
    expect(creates()).toBe(2);
  });

  test("without the secret store it is the typed refusal", async () => {
    const { service } = await setup({ storeOff: true });
    expect(await refusal(service.clientForStart(user("member")))).toEqual({
      code: "SLACK_LINK_NOT_CONFIGURED",
      details: { reason_code: "store_off" },
    });
  });

  test("a lost answer leaves the app creating: later starts say so", async () => {
    const { service, slack, creates, advance } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "timeout", false);
    };
    expect((await refusal(service.clientForStart(user("member")))).code).toBe(
      "BACKEND_UNAVAILABLE",
    );
    // Within the wait it is waited out, then reported; past the stale
    // mark it is uncertain at once.
    expect(await refusal(service.clientForStart(user("member")))).toMatchObject(
      { code: "SLACK_APP_CREATING", details: { uncertain: false } },
    );
    advance(SLACK_APP_CREATE_STALE_MS + SLACK_LINK_APP_WAIT_MS);
    expect(await refusal(service.clientForStart(user("member")))).toMatchObject(
      { code: "SLACK_APP_CREATING", details: { uncertain: true } },
    );
    expect(creates()).toBe(1);
  });
});

describe("which client a workspace links with", () => {
  test("a created link app is the client for the start and the callback", async () => {
    const { service, creates } = await setup();
    await service.createLinkAppAsOperator(WORKSPACE, {
      replace_uncertain: false,
    });
    const start = await service.clientForStart(user("member"));
    const callback = await service.clientFor(WORKSPACE);
    expect(callback).toEqual(start);
    expect(start.slackAppId).not.toBeNull();
    expect(creates()).toBe(1);
  });

  test("a callback never makes an app", async () => {
    const { service, creates } = await setup();
    expect(await service.clientFor(WORKSPACE)).toBeNull();
    expect(creates()).toBe(0);
  });
});

describe("making the link app on purpose", () => {
  test("an admin makes it once; asking again returns it", async () => {
    const { service, creates } = await setup();
    const first = await service.createLinkApp(user("admin"), {
      replace_uncertain: false,
    });
    const again = await service.createLinkApp(user("owner"), {
      replace_uncertain: false,
    });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false });
    expect(again.slack_app.id).toBe(first.slack_app.id);
    expect(first.slack_app).toMatchObject({
      kind: "link",
      agent_id: null,
      secrets: {
        slack_client_secret: { configured: true },
        slack_signing_secret: { configured: true },
        slack_bot_token: { configured: false },
      },
    });
    expect(creates()).toBe(1);
    // The view carries summaries only.
    expect(JSON.stringify(first)).not.toContain(
      (await service.clientFor(WORKSPACE))?.clientSecret ?? "missing",
    );
  });

  test("a member may not, nor may an API key", async () => {
    const { service, creates } = await setup();
    expect(
      (
        await refusal(
          service.createLinkApp(user("member"), { replace_uncertain: false }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      await refusal(
        service.createLinkApp(user("owner", { surface: "api" }), {
          replace_uncertain: false,
        }),
      ),
    ).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(creates()).toBe(0);
  });

  test("the operator's request keeps CONFIG_TOKEN_INVALID for its exit code", async () => {
    const { service } = await setup({ register: false });
    expect(
      (
        await refusal(
          service.createLinkAppAsOperator(WORKSPACE, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("CONFIG_TOKEN_INVALID");
  });

  test("an unknown workspace is not found", async () => {
    const { service } = await setup();
    expect(
      (
        await refusal(
          service.createLinkAppAsOperator(crypto.randomUUID(), {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  test("an uncertain creation is replaced only when asked", async () => {
    const { service, slack, apps, advance, creates } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "timeout", false);
    };
    await refusal(
      service.createLinkAppAsOperator(WORKSPACE, { replace_uncertain: false }),
    );
    advance(SLACK_APP_CREATE_STALE_MS + 1);
    const replaced = await service.createLinkAppAsOperator(WORKSPACE, {
      replace_uncertain: true,
    });
    expect(replaced.created).toBe(true);
    expect([...apps.rows.values()].map((row) => row.state).sort()).toEqual([
      "abandoned",
      "created",
    ]);
    expect(creates()).toBe(2);
  });
});
