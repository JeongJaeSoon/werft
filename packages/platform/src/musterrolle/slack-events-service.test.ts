import { describe, expect, test } from "bun:test";
import { scopesForRole } from "@werft-ai/contracts";
import {
  signSlackRequest,
  slackEventEnvelope,
} from "@werft-ai/testkit/fake-slack-api";
import {
  createMemoryAgentIdentityStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
  createMemorySlackInboundEventStore,
  createMemorySlackInstallStore,
  fakeSlackValue,
} from "../testing/slack-fakes.ts";
import { callerFor } from "./policy.ts";
import {
  createSlackEventsService,
  createSlackSigningSecrets,
  verifySlackSignature,
} from "./slack-events-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const BARE_AGENT = "019a0000-0000-7000-8000-0000000000c3";
const APP_ROW = "019a0000-0000-7000-8000-0000000000d1";
const APP_ID = "A0EVENTS1";
const TEAM = "T0EVENTS";
const BOT_USER = "U0EVENTSBOT";
const NOW = new Date("2026-10-24T10:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function world(options: { linkTo?: string; withSecret?: boolean } = {}) {
  const secrets = createMemorySecretStore();
  const agents = new Map(
    [AGENT, OTHER_AGENT, BARE_AGENT].map((id) => [
      id,
      {
        id,
        workspaceId: WORKSPACE,
        name: "Notes",
        slug: "notes",
        role: "Writes notes",
        active: true,
      },
    ]),
  );
  const apps = createMemorySlackAppStore({ secrets, agents });
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
    createdAt: NOW,
    updatedAt: NOW,
  });
  const signingSecret = fakeSlackValue("signing");
  if (options.withSecret !== false) {
    secrets.write(
      {
        workspaceId: WORKSPACE,
        owner: { kind: "slack_app", id: APP_ROW },
        purpose: "slack_signing_secret",
      },
      signingSecret,
    );
  }
  const lookups = { findAgentApp: 0 };
  const counted = {
    findAgentApp: (agentId: string) => {
      lookups.findAgentApp += 1;
      return apps.store.findAgentApp(agentId);
    },
  };
  let clock = NOW;
  const installs = createMemorySlackInstallStore({ now: () => clock });
  const identities = createMemoryAgentIdentityStore(installs.installations);
  const inbox = createMemorySlackInboundEventStore();
  const signingSecrets = createSlackSigningSecrets({
    apps: counted,
    secrets: secrets.store,
    now: () => clock.getTime(),
  });
  const pendingChannels = new Set<string>();
  const service = createSlackEventsService({
    signingSecrets,
    inbox: inbox.store,
    apps: apps.store,
    identities: identities.store,
    installs: installs.store,
    bindings: {
      findPendingApproval: async (_installationId, channelId) =>
        pendingChannels.has(channelId)
          ? { id: "binding-1", revision: 2 }
          : null,
    },
    now: () => clock,
  });

  async function install() {
    await installs.store.recordInstallation({
      workspaceId: WORKSPACE,
      appId: APP_ID,
      teamId: TEAM,
      botUserId: BOT_USER,
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
      agentId: options.linkTo ?? AGENT,
      key: { appId: APP_ID, teamId: TEAM },
      credentialRef: `slack_app:${APP_ROW}/slack_bot_token`,
      managerRoles: ["owner"],
    });
  }

  function signed(
    body: string,
    options: { at?: number; secret?: string; agentId?: string } = {},
  ) {
    const headers = signSlackRequest(
      options.secret ?? signingSecret,
      body,
      options.at ?? NOW_SECONDS,
    );
    return {
      agentId: options.agentId ?? AGENT,
      rawBody: new TextEncoder().encode(body),
      timestamp: headers["X-Slack-Request-Timestamp"] ?? null,
      signature: headers["X-Slack-Signature"] ?? null,
    };
  }

  const event = (
    fields: Record<string, unknown>,
    envelope: Partial<{
      appId: string;
      teamId: string;
      eventId: string;
      eventTime: number;
    }> = {},
  ) =>
    JSON.stringify(
      slackEventEnvelope({
        appId: envelope.appId ?? APP_ID,
        teamId: envelope.teamId ?? TEAM,
        event: fields,
        eventTime: envelope.eventTime ?? NOW_SECONDS,
        ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
      }),
    );

  return {
    service,
    signingSecrets,
    inbox,
    installs,
    apps,
    secrets,
    lookups,
    pendingChannels,
    install,
    signed,
    event,
    signingSecret,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const MENTION = {
  type: "app_mention",
  user: "U0PERSON",
  text: "hello",
  channel: "C0CHAN",
  ts: "1761300000.000100",
};

describe("verifySlackSignature", () => {
  test("checks the HMAC before the clock", () => {
    const body = new TextEncoder().encode("{}");
    const secret = fakeSlackValue("signing");
    const old = signSlackRequest(secret, "{}", NOW_SECONDS - 301);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: old["X-Slack-Request-Timestamp"] ?? null,
        signature: old["X-Slack-Signature"] ?? null,
        rawBody: body,
        nowSeconds: NOW_SECONDS,
      }),
    ).toBe("stale");
    expect(
      verifySlackSignature({
        signingSecret: fakeSlackValue("other"),
        timestamp: old["X-Slack-Request-Timestamp"] ?? null,
        signature: old["X-Slack-Signature"] ?? null,
        rawBody: body,
        nowSeconds: NOW_SECONDS,
      }),
    ).toBe("bad_signature");
  });
});

describe("Slack events service", () => {
  test("a bad, old, future or missing signature is refused and stores nothing", async () => {
    const w = world();
    await w.install();
    const body = w.event(MENTION);
    const refused = [
      w.signed(body, { secret: fakeSlackValue("wrong") }),
      w.signed(body, { at: NOW_SECONDS - 301 }),
      w.signed(body, { at: NOW_SECONDS + 301 }),
      { ...w.signed(body), signature: null },
      { ...w.signed(body), timestamp: null },
    ];
    for (const request of refused) {
      expect(await w.service.receive(request)).toEqual({
        kind: "unauthorized",
      });
    }
    expect(w.inbox.rows.size).toBe(0);
    expect(w.inbox.calls.record).toBe(0);
    expect(
      (await w.service.receive(w.signed(body, { at: NOW_SECONDS - 300 }))).kind,
    ).toBe("ack");
  });

  test("url_verification answers the challenge only when signed", async () => {
    const w = world();
    const body = JSON.stringify({
      token: "legacy",
      challenge: "challenge-value",
      type: "url_verification",
    });
    expect(
      await w.service.receive(
        w.signed(body, { secret: fakeSlackValue("wrong") }),
      ),
    ).toEqual({ kind: "unauthorized" });
    expect(await w.service.receive(w.signed(body))).toEqual({
      kind: "challenge",
      challenge: "challenge-value",
    });
  });

  test("the first signed callback verifies a pending or failed subscription once", async () => {
    const w = world();
    await w.install();
    const events = async () =>
      (await w.apps.store.find(WORKSPACE, APP_ROW))?.events;
    await w.apps.store.setEvents(WORKSPACE, APP_ROW, {
      state: "failed",
      checked_at: null,
      error: "events_registration_failed",
    });
    expect(
      (
        await w.service.receive(
          w.signed(w.event(MENTION), { secret: fakeSlackValue("wrong") }),
        )
      ).kind,
    ).toBe("unauthorized");
    expect((await events())?.state).toBe("failed");

    await w.service.receive(w.signed(w.event(MENTION, { eventId: "Ev0A" })));
    expect(await events()).toEqual({
      state: "verified",
      checked_at: NOW.toISOString(),
      url: null,
    });
    w.advance(60_000);
    await w.service.receive(w.signed(w.event(MENTION, { eventId: "Ev0B" })));
    expect((await events())?.checked_at).toBe(NOW.toISOString());
  });

  test("no app, no secret or an unknown agent answer as a bad signature; misses are not cached", async () => {
    const w = world({ withSecret: false });
    const body = w.event(MENTION);
    const uuids = [AGENT, BARE_AGENT, crypto.randomUUID()];
    for (const agentId of [...uuids, "not-a-uuid"]) {
      expect(await w.service.receive(w.signed(body, { agentId }))).toEqual({
        kind: "unauthorized",
      });
    }
    expect(w.lookups.findAgentApp).toBe(uuids.length);
    await w.service.receive(w.signed(body));
    expect(w.lookups.findAgentApp).toBe(4);
  });

  test("a found secret is cached until the app changes or the TTL passes", async () => {
    const w = world();
    await w.install();
    await w.service.receive(w.signed(w.event(MENTION)));
    await w.service.receive(w.signed(w.event(MENTION)));
    expect(w.lookups.findAgentApp).toBe(1);
    w.signingSecrets.invalidate(AGENT);
    await w.service.receive(w.signed(w.event(MENTION)));
    expect(w.lookups.findAgentApp).toBe(2);
    w.advance(61_000);
    await w.service.receive(
      w.signed(w.event(MENTION), { at: NOW_SECONDS + 61 }),
    );
    expect(w.lookups.findAgentApp).toBe(3);
  });

  test("the same event_id three times is one row", async () => {
    const w = world();
    await w.install();
    const body = w.event(MENTION, { eventId: "Ev0SAME" });
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await w.service.receive(w.signed(body)));
    }
    expect(
      results.map((result) => (result.kind === "ack" ? result.result : null)),
    ).toEqual(["recorded", "duplicate", "duplicate"]);
    expect(w.inbox.rows.size).toBe(1);
    const row = [...w.inbox.rows.values()][0];
    expect(row?.status).toBe("received");
    expect(row && "conversationKey" in row ? row.conversationKey : null).toBe(
      `${APP_ROW}:C0CHAN:1761300000.000100`,
    );
    expect(row && "payload" in row ? row.payload.token : "none").toBe(
      undefined,
    );
  });

  test("a 70 KiB event is stored", async () => {
    const w = world();
    await w.install();
    const body = w.event({ ...MENTION, text: "x".repeat(70 * 1024) });
    expect(body.length).toBeGreaterThan(70 * 1024);
    const result = await w.service.receive(w.signed(body));
    expect(result).toMatchObject({ kind: "ack", result: "recorded" });
    expect(w.inbox.rows.size).toBe(1);
  });

  test("another app, another team or another agent is dropped with its reason", async () => {
    const w = world({ linkTo: OTHER_AGENT });
    await w.install();
    const cases = [
      [w.event(MENTION, { appId: "A0OTHER" }), "app_mismatch"],
      [w.event(MENTION, { teamId: "T0OTHER" }), "not_installed"],
      [w.event(MENTION), "agent_mismatch"],
    ] as const;
    for (const [body, reason] of cases) {
      expect(await w.service.receive(w.signed(body))).toMatchObject({
        kind: "ack",
        result: "recorded",
        status: "dropped",
        reason,
      });
    }
    expect(w.inbox.rows.size).toBe(3);
    for (const row of w.inbox.rows.values()) {
      expect(row.status).toBe("dropped");
      expect("payload" in row).toBe(false);
    }
    const [body] = cases[0];
    expect(await w.service.receive(w.signed(body))).toMatchObject({
      result: "duplicate",
    });
    expect(w.inbox.rows.size).toBe(3);
  });

  test("the app's own events with a matching team are received", async () => {
    const w = world();
    await w.install();
    expect(await w.service.receive(w.signed(w.event(MENTION)))).toMatchObject({
      status: "received",
    });
  });

  test("bots and other subtypes are dropped; plain, thread_broadcast and mentions are kept", async () => {
    const w = world();
    await w.install();
    const message = { type: "message", channel: "C0CHAN", ts: "1.1" };
    const cases = [
      [
        { ...message, user: "U0BOTX", bot_id: "B0OTHER" },
        "dropped",
        "bot_message",
      ],
      [{ ...message, user: BOT_USER }, "dropped", "own_bot_user"],
      [
        { ...message, user: "U0P", subtype: "file_share" },
        "dropped",
        "message_subtype",
      ],
      [
        { ...message, user: "U0P", subtype: "message_changed" },
        "dropped",
        "message_subtype",
      ],
      [{ ...MENTION, bot_id: "B0OTHER" }, "dropped", "bot_message"],
      // An instruction the outbox posted under its sender's name.
      [
        {
          ...message,
          subtype: "bot_message",
          bot_id: "B0OWN",
          username: "Mina Park (웹 콘솔)",
          text: "Mina Park (웹 콘솔)\nRun it",
        },
        "dropped",
        "bot_message",
      ],
      [{ ...message, user: "U0P" }, "received", undefined],
      [
        { ...message, user: "U0P", subtype: "thread_broadcast" },
        "received",
        undefined,
      ],
      [{ ...MENTION, subtype: "thread_broadcast" }, "received", undefined],
      [MENTION, "received", undefined],
      [
        { type: "member_joined_channel", user: BOT_USER, channel: "C0CHAN" },
        "received",
        undefined,
      ],
      [{ type: "reaction_added", user: "U0P" }, "dropped", "unsupported_event"],
    ] as const;
    for (const [fields, status, reason] of cases) {
      const result = await w.service.receive(w.signed(w.event(fields)));
      expect(result).toMatchObject({ kind: "ack", status });
      expect(result.kind === "ack" ? result.reason : null).toBe(reason);
    }
  });

  test("in a channel waiting for approval, talk is dropped unread and a mention is kept without its text, files or blocks", async () => {
    const w = world();
    await w.install();
    w.pendingChannels.add("G0WAIT");
    const talk = await w.service.receive(
      w.signed(
        w.event({
          type: "message",
          user: "U0P",
          text: "the launch code is 1234",
          channel: "G0WAIT",
          channel_type: "group",
          ts: "1.1",
        }),
      ),
    );
    expect(talk).toMatchObject({
      status: "dropped",
      reason: "channel_pending_approval",
    });
    for (const [type, text] of [
      ["app_mention", `<@${BOT_USER}> the launch code is 1234`],
      ["message", `hey <@${BOT_USER}> the launch code is 1234`],
    ] as const) {
      const mention = await w.service.receive(
        w.signed(
          w.event({
            type,
            user: "U0P",
            text,
            channel: "G0WAIT",
            channel_type: "group",
            ts: "1.2",
            thread_ts: "1.1",
            files: [{ id: "F1", name: "secret.txt" }],
            blocks: [{ type: "rich_text" }],
            attachments: [{ text: "secret" }],
          }),
        ),
      );
      expect(mention).toMatchObject({ status: "received" });
    }
    const kept = [...w.inbox.rows.values()].flatMap((row) =>
      row.status === "received" ? [row] : [],
    );
    expect(kept).toHaveLength(2);
    for (const row of kept) {
      const event = (row.payload as { event: Record<string, unknown> }).event;
      expect(Object.keys(event).sort()).toEqual([
        "channel",
        "channel_type",
        "text",
        "thread_ts",
        "ts",
        "type",
        "user",
      ]);
      expect(event.text).toBe(`<@${BOT_USER}>`);
      expect(JSON.stringify(row.payload)).not.toContain("1234");
      expect(JSON.stringify(row.payload)).not.toContain("secret");
    }
  });

  test("a pending channel changes nothing for a DM, another channel, or once it is approved", async () => {
    const w = world();
    await w.install();
    w.pendingChannels.add("G0WAIT");
    for (const fields of [
      { type: "message", user: "U0P", channel: "D0DM", channel_type: "im" },
      {
        type: "message",
        user: "U0P",
        channel: "C0OTHER",
        channel_type: "channel",
      },
    ]) {
      expect(
        await w.service.receive(
          w.signed(w.event({ ...fields, text: "hi", ts: "1.1" })),
        ),
      ).toMatchObject({ status: "received" });
    }
    w.pendingChannels.delete("G0WAIT");
    const result = await w.service.receive(
      w.signed(
        w.event({
          type: "message",
          user: "U0P",
          text: "hi",
          channel: "G0WAIT",
          ts: "1.3",
        }),
      ),
    );
    expect(result).toMatchObject({ status: "received" });
  });

  test("app_uninstalled and tokens_revoked revoke the install", async () => {
    for (const fields of [
      { type: "app_uninstalled" },
      { type: "tokens_revoked", tokens: { bot: [BOT_USER] } },
    ]) {
      const w = world();
      await w.install();
      const result = await w.service.receive(w.signed(w.event(fields)));
      expect(result).toMatchObject({ status: "processed" });
      expect(w.installs.installations.get(`${APP_ID}|${TEAM}`)?.status).toBe(
        "revoked",
      );
      expect(await w.service.receive(w.signed(w.event(MENTION)))).toMatchObject(
        { status: "dropped", reason: "installation_revoked" },
      );
    }
  });

  test("an uninstall sent before the last install verified leaves that install", async () => {
    const w = world();
    await w.install();
    const late = await w.service.receive(
      w.signed(
        w.event({ type: "app_uninstalled" }, { eventTime: NOW_SECONDS - 60 }),
      ),
    );
    expect(late).toMatchObject({ status: "processed" });
    expect(w.installs.installations.get(`${APP_ID}|${TEAM}`)?.status).toBe(
      "verified",
    );
  });

  test("tokens_revoked for user tokens only leaves the install", async () => {
    const w = world();
    await w.install();
    const result = await w.service.receive(
      w.signed(
        w.event({ type: "tokens_revoked", tokens: { oauth: ["U0PERSON"] } }),
      ),
    );
    expect(result).toMatchObject({ reason: "user_tokens_only" });
    expect(w.installs.installations.get(`${APP_ID}|${TEAM}`)?.status).toBe(
      "verified",
    );
  });

  test("a failed inbox write throws, so Slack sends the event again", async () => {
    const w = world();
    await w.install();
    w.inbox.faults.record = 1;
    const body = w.event(MENTION);
    await expect(w.service.receive(w.signed(body))).rejects.toThrow();
    expect(await w.service.receive(w.signed(body))).toMatchObject({
      result: "recorded",
    });
  });

  test("a signed body that is not an envelope is a bad request", async () => {
    const w = world();
    const callback = JSON.parse(w.event(MENTION));
    const { team_id: _, ...noTeam } = callback;
    for (const body of [
      "not json",
      "[]",
      JSON.stringify({ type: 3 }),
      JSON.stringify(noTeam),
      JSON.stringify({ ...callback, event_id: "E".repeat(65) }),
      JSON.stringify({ ...callback, event: undefined }),
      JSON.stringify({ ...callback, event: { ...callback.event, user: 7 } }),
    ]) {
      expect(await w.service.receive(w.signed(body))).toEqual({
        kind: "bad_request",
      });
    }
    expect(
      await w.service.receive(
        w.signed(JSON.stringify({ type: "app_rate_limited" })),
      ),
    ).toEqual({ kind: "ack", result: "ignored" });
  });
});
