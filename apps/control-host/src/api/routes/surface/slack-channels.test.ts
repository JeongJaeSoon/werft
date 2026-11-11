import { describe, expect, test } from "bun:test";
import {
  createSlackBotApi,
  createSlackChannelSearchService,
  type SlackChannelSearchService,
} from "@werft-ai/chat-slack";
import {
  createMemorySecretStore,
  createMemorySlackAppStore,
  fakeSlackValue,
} from "@werft-ai/chat-slack/testing/slack";
import {
  apiErrorResponseSchema,
  lookupSlackChannelsResponseSchema,
  searchSlackChannelsResponseSchema,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  type AuthorizationPolicy,
  SessionServiceError,
} from "@werft-ai/platform";
import { createFakeSlackWebApi } from "@werft-ai/testkit/fake-slack-api";
import { errorOf } from "../../../test-support/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerSlackChannelRoutes } from "./slack-channels.ts";

const createApiApp = recordRouteErrors("routes/surface/slack-channels.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000b1";
const APP_ROW = "019a0000-0000-7000-8000-0000000000d1";
const APP_ID = "A0ROUTE1";
const owner = { "X-Owner-Id": WORKSPACE };
const path = `/v1/agents/${AGENT}/slack/channels`;

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

function app(
  service: Partial<SlackChannelSearchService>,
  logs?: MemoryLogSink,
) {
  const logger = logs
    ? new StructuredLogger({ sinks: [logs], level: "debug" })
    : undefined;
  return createApiApp({
    authMode: "none",
    ...(logger ? { logger } : {}),
    registerRoutes: (router) =>
      registerSlackChannelRoutes(router, {
        service: service as SlackChannelSearchService,
        ...(logger ? { logger } : {}),
      }),
  });
}

// The real service behind the route, on the fake Slack, with every caller
// allowed: the policy itself is the platform test's and the integration's.
function world(options: { offline?: boolean } = {}) {
  const slack = createFakeSlackWebApi();
  const botToken = fakeSlackValue("xoxb");
  slack.apps.set(APP_ID, {
    appId: APP_ID,
    clientId: "1.1",
    clientSecret: fakeSlackValue("client"),
    signingSecret: fakeSlackValue("signing"),
    manifest: {},
    botTokens: [botToken],
  });
  const channels = slack.seedChannels([
    ...Array.from({ length: 12 }, (_, i) => ({
      name: `dev-${String(i).padStart(2, "0")}`,
    })),
    { name: "general" },
    { name: "dev-hidden", isPrivate: true },
  ]);
  const secrets = createMemorySecretStore();
  const apps = createMemorySlackAppStore({ secrets, agents: new Map() });
  const now = new Date();
  apps.seed({
    id: APP_ROW,
    workspaceId: WORKSPACE,
    kind: "agent",
    agentId: AGENT,
    state: "created",
    appId: APP_ID,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
    createdByTokenUser: "U0ISSUER",
    createdAt: now,
    updatedAt: now,
  });
  secrets.write(
    {
      workspaceId: WORKSPACE,
      owner: { kind: "slack_app", id: APP_ROW },
      purpose: "slack_bot_token",
    },
    botToken,
  );
  const service = createSlackChannelSearchService({
    authorization: {
      authorize: async () => ({ outcome: "allow" }),
    } as unknown as AuthorizationPolicy,
    agents: { agentOf: async () => AGENT },
    apps: apps.store,
    secrets: secrets.store,
    api: createSlackBotApi({
      apiUrl: "http://slack.test/api",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (options.offline) return outage();
        return (
          (await slack.handle(new Request(input, init))) ??
          new Response("not found", { status: 404 })
        );
      }) as typeof fetch,
    }),
  });
  return { slack, botToken, service, channels };
}

describe("GET /v1/agents/{id}/slack-channels", () => {
  const lookupPath = `/v1/agents/${AGENT}/slack-channels`;
  test("resolves IDs beyond the first page without scanning and coalesces reads", async () => {
    const { slack, service, channels, botToken } = world();
    const id = channels[12]?.id ?? "C0MISSINGFIXTURE";
    const api = app(service);
    const url = `${lookupPath}?ids=${id}`;
    const responses = await Promise.all([
      api.request(url, { headers: owner }),
      api.request(url, { headers: owner }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(botToken);
      expect(lookupSlackChannelsResponseSchema.parse(JSON.parse(text))).toEqual(
        {
          items: [{ id, name: "general", state: "known" }],
        },
      );
    }
    expect((await api.request(url, { headers: owner })).status).toBe(200);
    expect(
      slack.calls.filter((call) => call.method === "conversations.info"),
    ).toHaveLength(1);
    expect(
      slack.calls.filter((call) => call.method === "conversations.list"),
    ).toHaveLength(0);
  });
  test("rejects more than 50 IDs, cursor and missing IDs before Slack", async () => {
    const { slack, service } = world();
    const api = app(service);
    for (const query of [
      "",
      "ids=",
      `ids=${Array.from({ length: 51 }, (_, i) => `C0${i}`).join(",")}`,
      "ids=C01&cursor=abc",
      "ids=bad",
    ]) {
      expect(
        (await api.request(`${lookupPath}?${query}`, { headers: owner }))
          .status,
      ).toBe(400);
    }
    expect(slack.calls).toHaveLength(0);
  });
  test("only inaccessible channels are cached as unknown", async () => {
    const { slack, service } = world();
    slack.failures.set("conversations.info", "channel_not_found");
    const api = app(service);
    for (let i = 0; i < 2; i++) {
      const response = await api.request(`${lookupPath}?ids=C01`, {
        headers: owner,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        items: [{ id: "C01", name: "unknown", state: "unknown" }],
      });
    }
    expect(
      slack.calls.filter((call) => call.method === "conversations.info"),
    ).toHaveLength(1);
  });
  test("transport failures, upstream errors and revoked tokens are not cached as unknown", async () => {
    const options = { offline: true };
    const { slack, service, channels } = world(options);
    const api = app(service);
    const url = `${lookupPath}?ids=${channels[0]?.id}`;
    expect((await api.request(url, { headers: owner })).status).toBe(503);
    options.offline = false;
    slack.failures.set("conversations.info", "internal_error");
    expect((await api.request(url, { headers: owner })).status).toBe(503);
    slack.failures.set("conversations.info", "token_revoked");
    expect((await api.request(url, { headers: owner })).status).toBe(409);
    slack.failures.delete("conversations.info");
    expect((await api.request(url, { headers: owner })).status).toBe(200);
    expect(
      slack.calls.filter((call) => call.method === "conversations.info"),
    ).toHaveLength(3);
  });
  test("Slack 429 returns 503 and Retry-After without repeated calls", async () => {
    const { slack, service } = world();
    slack.rateLimit("conversations.info", 7);
    const api = app(service);
    for (let i = 0; i < 2; i++) {
      const response = await api.request(`${lookupPath}?ids=C01`, {
        headers: owner,
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("7");
    }
    expect(
      slack.calls.filter((call) => call.method === "conversations.info"),
    ).toHaveLength(1);
  });
  test("preserves permission, missing agent and installation refusals", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["SLACK_NOT_INSTALLED", 409],
    ] as const) {
      const response = await app({
        lookupSlackChannels: async () => {
          throw new SessionServiceError(code, "refused");
        },
      }).request(`${lookupPath}?ids=C01`, { headers: owner });
      expect(response.status).toBe(status);
    }
  });
});

describe("GET /v1/agents/{id}/slack/channels", () => {
  test("searches, pages to the end and logs the cache without the token", async () => {
    const { slack, botToken, service } = world();
    const logs = new MemoryLogSink();
    const api = app(service, logs);
    const bodies: string[] = [];
    const get = async (query: string) => {
      const response = await api.request(`${path}?${query}`, {
        headers: owner,
      });
      const text = await response.text();
      bodies.push(text);
      return { status: response.status, text };
    };

    const first = await get("q=%23DEV&limit=5");
    expect(first.status).toBe(200);
    const page = searchSlackChannelsResponseSchema.parse(
      JSON.parse(first.text),
    );
    expect(page.items.map((item) => item.name)).toEqual([
      "dev-00",
      "dev-01",
      "dev-02",
      "dev-03",
      "dev-04",
    ]);
    expect(page.items[0]).toEqual({
      id: expect.stringMatching(/^C0/),
      name: "dev-00",
      is_private: false,
      is_member: false,
    });
    expect(page).toMatchObject({ truncated: false, stale: false });

    const more = await get(
      `q=dev&limit=10&cursor=${encodeURIComponent(page.next_cursor ?? "")}`,
    );
    const next = searchSlackChannelsResponseSchema.parse(JSON.parse(more.text));
    expect(next.items.map((item) => item.name)).toEqual([
      "dev-05",
      "dev-06",
      "dev-07",
      "dev-08",
      "dev-09",
      "dev-10",
      "dev-11",
    ]);
    expect(next.next_cursor).toBeNull();

    // A cursor of another `q` limits nothing on its own: refused.
    expect(
      (await get(`q=gen&cursor=${encodeURIComponent(page.next_cursor ?? "")}`))
        .status,
    ).toBe(400);
    expect((await get("")).status).toBe(200);

    const searched = logs.records.filter(
      (record) => record.message === "Slack channels searched",
    );
    expect(
      searched.map((record) => [record.fields?.cache, record.fields?.count]),
    ).toEqual([
      ["miss", 5],
      ["hit", 7],
      ["hit", 13],
    ]);
    expect(searched[0]?.fields).toMatchObject({
      agent_id: AGENT,
      slack_app_id: APP_ROW,
    });
    expect(
      slack.calls.filter((call) => call.method === "conversations.list"),
    ).toHaveLength(1);
    const seen = JSON.stringify([bodies, logs.records]);
    expect(seen).not.toContain(botToken);
  });

  test("429 with nothing cached answers 503 with Slack's Retry-After", async () => {
    const { slack, botToken, service } = world();
    slack.rateLimit("conversations.list", 7);
    const response = await app(service).request(path, { headers: owner });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("7");
    const text = await response.text();
    expect(text).not.toContain(botToken);
    expect(apiErrorResponseSchema.parse(JSON.parse(text)).error).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
  });

  test("a bad query or agent id never reaches the service", async () => {
    let asked: unknown = null;
    const api = app({
      searchSlackChannels: async (_caller, _agent, query) => {
        asked = query;
        return {
          page: {
            items: [],
            next_cursor: null,
            truncated: false,
            stale: false,
          },
          slackAppId: APP_ROW,
          cache: "hit",
        };
      },
    });
    expect((await api.request(path, { headers: owner })).status).toBe(200);
    expect(asked).toEqual({ q: "", limit: 20 });
    for (const query of [
      "limit=51",
      "limit=0",
      "limit=x",
      `q=${"a".repeat(81)}`,
      "cursor=",
      "extra=1",
    ]) {
      asked = null;
      const response = await api.request(`${path}?${query}`, {
        headers: owner,
      });
      expect(response.status).toBe(400);
      expect(asked).toBeNull();
    }
    expect(
      (
        await api.request("/v1/agents/not-an-agent/slack/channels", {
          headers: owner,
        })
      ).status,
    ).toBe(404);
  });

  test("each refusal keeps its code and status", async () => {
    const cases: [SessionServiceError, number][] = [
      [new SessionServiceError("BAD_REQUEST", "Invalid cursor"), 400],
      [new SessionServiceError("CURSOR_EXPIRED", "다시 검색하세요"), 400],
      [
        new SessionServiceError("FORBIDDEN", "no", undefined, {
          reason_code: "role",
        }),
        403,
      ],
      [new SessionServiceError("NOT_FOUND", "Resource not found"), 404],
      [new SessionServiceError("SLACK_NOT_INSTALLED", "연결"), 409],
      [
        new SessionServiceError("BACKEND_UNAVAILABLE", "막힘", {
          afterSeconds: 7,
        }),
        503,
      ],
    ];
    for (const [error, status] of cases) {
      const response = await app({
        searchSlackChannels: async () => {
          throw error;
        },
      }).request(path, { headers: owner });
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toMatchObject({
        code: error.code,
        message: error.message,
      });
    }
    expect(
      (
        await app({ searchSlackChannels: outage }).request(path, {
          headers: owner,
        })
      ).status,
    ).toBe(503);
  });
});
