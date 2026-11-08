import { describe, expect, test } from "bun:test";
import { scopesForRole, slackEventsResponseSchema } from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  callerFor,
  createSlackEventsService,
  createSlackSigningSecrets,
  type SlackEventsService,
} from "@werft-ai/platform";
import {
  createMemoryAgentIdentityStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
  createMemorySlackInboundEventStore,
  createMemorySlackInstallStore,
  fakeSlackValue,
} from "@werft-ai/platform/testing/slack";
import {
  signSlackRequest,
  slackEventEnvelope,
} from "@werft-ai/testkit/fake-slack-api";
import { createSlackEventsLimiter } from "../rate-limit.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSlackEventRoutes } from "./slack-events.ts";

const createApiApp = recordRouteErrors("routes/slack-events.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const NO_APP_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const NO_SECRET_AGENT = "019a0000-0000-7000-8000-0000000000c3";
const APP_ROW = "019a0000-0000-7000-8000-0000000000d1";
const NO_SECRET_ROW = "019a0000-0000-7000-8000-0000000000d3";
const APP_ID = "A0ROUTE1";
const TEAM = "T0ROUTE";
const TEXT = `secret plan ${crypto.randomUUID()}`;

const secrets = createMemorySecretStore();
const agentRow = (id: string) =>
  [
    id,
    {
      id,
      workspaceId: WORKSPACE,
      name: "Notes",
      slug: "notes",
      role: "Writes notes",
      active: true,
    },
  ] as const;
const apps = createMemorySlackAppStore({
  secrets,
  agents: new Map([agentRow(AGENT), agentRow(NO_APP_AGENT)]),
});
const stamp = new Date();
for (const [id, agentId, appId] of [
  [APP_ROW, AGENT, APP_ID],
  [NO_SECRET_ROW, NO_SECRET_AGENT, "A0NOSECRET"],
] as const) {
  apps.seed({
    id,
    workspaceId: WORKSPACE,
    kind: "agent",
    agentId,
    state: "created",
    appId,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
    createdByTokenUser: null,
    createdAt: stamp,
    updatedAt: stamp,
  });
}
const signingSecret = fakeSlackValue("signing");
secrets.write(
  {
    workspaceId: WORKSPACE,
    owner: { kind: "slack_app", id: APP_ROW },
    purpose: "slack_signing_secret",
  },
  signingSecret,
);
const installs = createMemorySlackInstallStore();
const identities = createMemoryAgentIdentityStore(installs.installations);
const inbox = createMemorySlackInboundEventStore();
const lookups = { count: 0 };
const signingSecrets = createSlackSigningSecrets({
  apps: {
    findAgentApp: (agentId) => {
      lookups.count += 1;
      return apps.store.findAgentApp(agentId);
    },
  },
  secrets: secrets.store,
});
const service = createSlackEventsService({
  signingSecrets,
  inbox: inbox.store,
  apps: apps.store,
  identities: identities.store,
  bindings: { findLiveSlackChannel: async () => null },
  installs: installs.store,
});
const receives = { count: 0 };
const counted: SlackEventsService = {
  receive(request) {
    receives.count += 1;
    return service.receive(request);
  },
};

const logs = new MemoryLogSink();
const responses: string[] = [];

function appWith(
  limiter = createSlackEventsLimiter(),
  events: SlackEventsService = counted,
) {
  const app = createApiApp({
    authMode: "api-key",
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerPublicRoutes: (router) =>
      registerSlackEventRoutes(router, {
        events,
        limiter,
        logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
      }),
  });
  return async (
    agentId: string,
    body: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.request(`/v1/slack/events/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    const text = await response.text();
    responses.push(text);
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  };
}

const post = appWith();
const signed = (body: string, at = Math.floor(Date.now() / 1000)) =>
  signSlackRequest(signingSecret, body, at);
const mention = (eventId?: string, text = TEXT) =>
  JSON.stringify(
    slackEventEnvelope({
      appId: APP_ID,
      teamId: TEAM,
      event: {
        type: "app_mention",
        user: "U0PERSON",
        text,
        channel: "C0CHAN",
        ts: "1761300000.000100",
      },
      ...(eventId ? { eventId } : {}),
    }),
  );

const setup = (async () => {
  await installs.store.recordInstallation({
    workspaceId: WORKSPACE,
    appId: APP_ID,
    teamId: TEAM,
    botUserId: "U0ROUTEBOT",
  });
  await identities.store.link({
    principal: callerFor(
      {
        kind: "user",
        id: crypto.randomUUID(),
        workspace_id: WORKSPACE,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      crypto.randomUUID(),
    ),
    workspaceId: WORKSPACE,
    agentId: AGENT,
    key: { appId: APP_ID, teamId: TEAM },
    credentialRef: `slack_app:${APP_ROW}/slack_bot_token`,
    managerRoles: ["owner"],
  });
})();

describe("POST /v1/slack/events/{agent_id}", () => {
  test("a signed url_verification answers its challenge; a wrong one 401", async () => {
    const body = JSON.stringify({
      token: "legacy",
      challenge: "the-challenge",
      type: "url_verification",
    });
    const ok = await post(AGENT, body, signed(body));
    expect(ok.status).toBe(200);
    expect(slackEventsResponseSchema.parse(ok.json)).toEqual({
      challenge: "the-challenge",
    });
    const wrong = await post(
      AGENT,
      body,
      signSlackRequest(fakeSlackValue("wrong"), body, Date.now() / 1000),
    );
    expect(wrong.status).toBe(401);
  });

  test("a signed url_verification marks a pending subscription verified at receipt", async () => {
    await apps.store.setEvents(WORKSPACE, APP_ROW, {
      state: "pending",
      checked_at: null,
    });
    const body = JSON.stringify({
      challenge: "verify-me",
      type: "url_verification",
    });
    const before = Date.now();
    const ok = await post(AGENT, body, signed(body));
    expect(ok.status).toBe(200);
    const events = (await apps.store.find(WORKSPACE, APP_ROW))?.events;
    expect(events?.state).toBe("verified");
    const at = Date.parse(events?.checked_at ?? "");
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  test("a wrongly signed url_verification is 401 and leaves the subscription pending", async () => {
    await apps.store.setEvents(WORKSPACE, APP_ROW, {
      state: "pending",
      checked_at: null,
    });
    const body = JSON.stringify({
      challenge: "verify-me",
      type: "url_verification",
    });
    const wrong = await post(
      AGENT,
      body,
      signSlackRequest(fakeSlackValue("wrong"), body, Date.now() / 1000),
    );
    expect(wrong.status).toBe(401);
    expect((await apps.store.find(WORKSPACE, APP_ROW))?.events).toEqual({
      state: "pending",
      checked_at: null,
      url: null,
    });
  });

  test("unknown agent, no app, no secret and a bad signature look the same", async () => {
    await setup;
    const body = mention();
    const answers = [
      await post(crypto.randomUUID(), body, signed(body)),
      await post(NO_APP_AGENT, body, signed(body)),
      await post(NO_SECRET_AGENT, body, signed(body)),
      await post("not-a-uuid", body, signed(body)),
      await post(AGENT, body, {
        ...signed(body),
        "X-Slack-Signature": `v0=${"0".repeat(64)}`,
      }),
      await post(AGENT, body),
    ];
    const shape = (answer: (typeof answers)[number]) => ({
      status: answer.status,
      error: { ...answer.json.error, request_id: "-" },
      headers: [...answer.headers.keys()].sort(),
    });
    const first = shape(answers[0] as (typeof answers)[number]);
    expect(first.status).toBe(401);
    for (const answer of answers) expect(shape(answer)).toEqual(first);
    expect(inbox.rows.size).toBe(0);
  });

  test("a body over 256 KiB is refused before the signature is checked; 70 KiB is stored", async () => {
    await setup;
    const before = receives.count;
    const huge = mention(undefined, "x".repeat(256 * 1024));
    const refused = await post(AGENT, huge, signed(huge));
    expect(refused.status).toBe(413);
    expect(receives.count).toBe(before);

    const large = mention("Ev0LARGE", "y".repeat(70 * 1024));
    const stored = await post(AGENT, large, signed(large));
    expect(stored.status).toBe(200);
    expect(inbox.rows.get(`${APP_ID}|Ev0LARGE`)?.status).toBe("received");
  });

  test("the limiter answers 429 before any lookup", async () => {
    const limited = appWith(
      createSlackEventsLimiter({ globalPerMinute: 1000, agentPerMinute: 1 }),
    );
    const body = mention();
    expect((await limited(AGENT, body, signed(body))).status).toBe(200);
    const lookupsBefore = lookups.count;
    const seenBefore = inbox.calls.seen;
    const receivesBefore = receives.count;
    const over = await limited(AGENT, body, signed(body));
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).not.toBeNull();
    expect([lookups.count, inbox.calls.seen, receives.count]).toEqual([
      lookupsBefore,
      seenBefore,
      receivesBefore,
    ]);
    const global = appWith(
      createSlackEventsLimiter({ globalPerMinute: 0, agentPerMinute: 100 }),
    );
    expect((await global(crypto.randomUUID(), body)).status).toBe(429);
  });

  test("Slack's retries of one event answer 200 and leave one row", async () => {
    await setup;
    const body = mention("Ev0RETRY");
    const statuses = [];
    for (const retry of [undefined, "1", "2"]) {
      statuses.push(
        (
          await post(AGENT, body, {
            ...signed(body),
            ...(retry
              ? { "X-Slack-Retry-Num": retry, "X-Slack-Retry-Reason": "x" }
              : {}),
          })
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200]);
    expect(
      [...inbox.rows.keys()].filter((key) => key.endsWith("|Ev0RETRY")),
    ).toHaveLength(1);
  });

  test("a signed body that is not JSON is 400", async () => {
    const body = "{not json";
    expect((await post(AGENT, body, signed(body))).status).toBe(400);
  });

  test("a storage failure answers 503 so Slack sends it again", async () => {
    const unavailable = appWith(createSlackEventsLimiter(), {
      async receive() {
        throw Object.assign(new Error("canceling statement"), {
          code: "57014",
        });
      },
    });
    const body = mention();
    expect((await unavailable(AGENT, body, signed(body))).status).toBe(503);
  });

  test("no secret, signature or message text reaches a log line or an answer", async () => {
    await setup;
    const body = mention("Ev0LEAK");
    const headers = signed(body);
    await post(AGENT, body, headers);
    const written = [
      ...logs.records.map((record) => JSON.stringify(record)),
      ...responses,
    ].join("\n");
    expect(logs.records.length).toBeGreaterThan(0);
    for (const value of [
      signingSecret,
      headers["X-Slack-Signature"] ?? "missing",
      TEXT,
    ]) {
      expect(written).not.toContain(value);
    }
  });
});
