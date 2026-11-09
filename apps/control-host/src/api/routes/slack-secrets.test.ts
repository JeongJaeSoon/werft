import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  deleteSlackSecretResponseSchema,
  putSlackConfigTokenResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  slackConfigTokenSummarySchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSlackConfigTokens,
  createSlackSecretService,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
  slackPublicUrlsOf,
} from "@werft-ai/platform";
import {
  createFakeSlackConfigApi,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
} from "@werft-ai/platform/testing/slack";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSlackSecretRoutes } from "./slack-secrets.ts";

const createApiApp = recordRouteErrors("routes/slack-secrets.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

const KEYS = (["agent", "personal"] as const).map((kind) => ({
  kind,
  plaintext: `csp_${crypto.randomUUID()}`,
}));
const keyStore = {
  async find(candidate: Uint8Array) {
    const key = KEYS.find(({ plaintext }) =>
      Buffer.from(hashApiKey(plaintext)).equals(Buffer.from(candidate)),
    );
    if (!key) return null;
    return {
      id: crypto.randomUUID(),
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: key.kind,
      agentId: key.kind === "agent" ? crypto.randomUUID() : null,
      createdByUserId: key.kind === "personal" ? crypto.randomUUID() : null,
      creatorRole: key.kind === "personal" ? ("owner" as const) : null,
      scopes: [
        "sessions:read" as const,
        "sessions:write" as const,
        "sessions:control" as const,
      ],
    };
  },
};

const secrets = createMemorySecretStore();
const tokenStore = createMemoryConfigTokenStore(secrets);
const slack = createFakeSlackConfigApi();
const pastedTokens: string[] = [];
const paste = () => {
  const value = slack.issueRefresh();
  pastedTokens.push(value);
  return value;
};

const logs = new MemoryLogSink();
const responses: string[] = [];

function appWith(enabled: boolean) {
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerRoutes: (router) =>
      registerSlackSecretRoutes(
        router,
        createSlackSecretService({
          authorization: createAuthorizationPolicy({}),
          store: enabled ? secrets.store : null,
          tokens: enabled
            ? createSlackConfigTokens({
                store: tokenStore.store,
                api: slack.api,
              })
            : null,
          urls: slackPublicUrlsOf("https://console.example.test", null),
          appKind: async () => null,
        }),
      ),
  });
  return async (
    method: "GET" | "PUT" | "DELETE",
    options: {
      cookie?: string;
      key?: (typeof KEYS)[number];
      csrf?: boolean;
      body?: string;
      workspaceId?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${options.workspaceId ?? WORKSPACE}/slack/config-token`,
      {
        method,
        headers: {
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.key
            ? { Authorization: `Bearer ${options.key.plaintext}` }
            : {}),
          ...(options.csrf === false
            ? {}
            : { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }),
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
      },
    );
    const text = await response.text();
    responses.push(text);
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

const call = appWith(true);
const put = (value: unknown) => JSON.stringify({ value });
const unknownToken = () => {
  const value = `xoxe-1-${randomBytes(24).toString("hex")}`;
  pastedTokens.push(value);
  return value;
};

function code(json: unknown) {
  return apiErrorResponseSchema.parse(json).error;
}

describe("the Slack config token API", () => {
  test("an owner sets it, sees its state and last four, replaces and deletes it", async () => {
    const owner = cookieFor("owner");
    const first = paste();
    const set = await call("PUT", { cookie: owner, body: put(first) });
    expect(set.status).toBe(200);
    const stored = tokenStore.pair(WORKSPACE);
    expect(stored?.refresh_token).not.toBe(first);
    expect(putSlackConfigTokenResponseSchema.parse(set.json)).toMatchObject({
      configured: true,
      last4: stored?.refresh_token.slice(-4),
      state: "active",
      issuer: { user_id: "U0ISSUER", team_id: "T0FAKE" },
      warnings: [],
    });
    const read = await call("GET", { cookie: owner });
    expect(slackConfigTokenSummarySchema.parse(read.json)).toMatchObject({
      configured: true,
      urls: {
        redirect_url:
          "https://console.example.test/settings/linked-accounts/slack",
        events_url_template: null,
      },
      state: "active",
      issuer: { user_id: "U0ISSUER", team_id: "T0FAKE" },
    });

    slack.state.userId = "U0OTHER";
    const replaced = await call("PUT", {
      cookie: cookieFor("admin"),
      body: put(paste()),
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json.warnings).toEqual([
      {
        code: "config_token_issuer_changed",
        previous_user_id: "U0ISSUER",
        user_id: "U0OTHER",
      },
    ]);
    expect(secrets.receipts.map(({ purpose }) => purpose)).toEqual([
      "slack_config_token",
      "slack_config_token",
    ]);

    const deleted = await call("DELETE", { cookie: owner });
    expect(deleted.status).toBe(200);
    deleteSlackSecretResponseSchema.parse(deleted.json);
    expect((await call("GET", { cookie: owner })).json).toMatchObject({
      configured: false,
      last4: null,
      state: "unset",
    });
    expect((await call("DELETE", { cookie: owner })).status).toBe(404);
  });

  test("a token Slack refuses answers 409 and changes nothing stored", async () => {
    const owner = cookieFor("owner");
    expect(
      (await call("PUT", { cookie: owner, body: put(paste()) })).status,
    ).toBe(200);
    const before = (await call("GET", { cookie: owner })).json;
    const refused = await call("PUT", {
      cookie: owner,
      body: put(unknownToken()),
    });
    expect(refused.status).toBe(409);
    expect(code(refused.json)).toMatchObject({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "rejected" },
    });
    expect((await call("GET", { cookie: owner })).json).toEqual(before);
    await call("DELETE", { cookie: owner });
  });

  test("a member is refused on every method and the value is not stored", async () => {
    secrets.values.clear();
    const member = cookieFor("member");
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", put(paste())],
      ["DELETE", undefined],
    ] as const) {
      const response = await call(method, {
        cookie: member,
        ...(body ? { body } : {}),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(secrets.values.size).toBe(0);
  });

  test.each(KEYS)("an API key is refused ($kind)", async (key) => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        key,
        ...(method === "PUT" ? { body: put(paste()) } : {}),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(secrets.values.size).toBe(0);
  });

  test("a cookie write without the CSRF header, or from another site, is refused", async () => {
    const owner = cookieFor("owner");
    for (const method of ["PUT", "DELETE"] as const) {
      const response = await call(method, {
        cookie: owner,
        csrf: false,
        ...(method === "PUT" ? { body: put(paste()) } : {}),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).message).toContain(CSRF_HEADER_NAME);
    }
    const foreign = [
      { "Sec-Fetch-Site": "cross-site" },
      { Origin: "https://attacker.example" },
    ];
    for (const headers of foreign) {
      const response = await call("PUT", {
        cookie: owner,
        headers,
        body: put(paste()),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(secrets.values.size).toBe(0);
  });

  test("another workspace's path is not found", async () => {
    const response = await call("GET", {
      cookie: cookieFor("owner", OTHER_WORKSPACE),
    });
    expect(response.status).toBe(404);
    expect(
      (
        await call("PUT", {
          cookie: cookieFor("owner", OTHER_WORKSPACE),
          body: put(paste()),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("DELETE", {
          cookie: cookieFor("owner", OTHER_WORKSPACE),
        })
      ).status,
    ).toBe(404);
  });

  test("a malformed or oversized value is refused without echoing it", async () => {
    const owner = cookieFor("owner");
    const value = unknownToken();
    for (const body of [
      put(`${value} with spaces`),
      put(value.slice(0, 5)),
      JSON.stringify({ value, extra: value }),
      `{"value": "${value}"`,
    ]) {
      const response = await call("PUT", { cookie: owner, body });
      expect(response.status).toBe(400);
    }
    const huge = await call("PUT", {
      cookie: owner,
      body: put(`${value}${"a".repeat(REQUEST_BODY_MAX_BYTES)}`),
    });
    expect(huge.status).toBe(413);
    expect(secrets.values.size).toBe(0);
  });

  test("without a master key every method answers 503", async () => {
    const off = appWith(false);
    const owner = cookieFor("owner");
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await off(method, {
        cookie: owner,
        ...(method === "PUT" ? { body: put(paste()) } : {}),
      });
      expect(response.status).toBe(503);
      expect(code(response.json).message).toContain("PLATFORM_SECRET_KEY");
    }
  });

  test("unauthenticated calls are 401", async () => {
    expect((await call("GET")).status).toBe(401);
  });
});

afterAll(() => {
  const seen = [...responses, ...logs.records.map((r) => JSON.stringify(r))];
  const tokens = [
    ...pastedTokens,
    ...slack.state.accessTokens,
    ...slack.state.refreshTokens,
  ];
  for (const text of seen) {
    for (const token of tokens) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(token.slice(7, 40));
    }
  }
  expect(logs.records.length).toBeGreaterThan(0);
});
