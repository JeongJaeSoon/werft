import { describe, expect, test } from "bun:test";
import { scopesForRole } from "@werft-ai/contracts";
import type { SurfaceBindingRecord } from "@werft-ai/platform";
import { callerFor } from "@werft-ai/platform";
import {
  signSlackRequest,
  slackEventEnvelope,
} from "@werft-ai/testkit/fake-slack-api";
import {
  createSlackEventsService,
  createSlackSigningSecrets,
  verifySlackSignature,
} from "./slack-events-service.ts";
import {
  createMemoryAgentIdentityStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
  createMemorySlackInboundEventStore,
  createMemorySlackInstallStore,
  createMemorySlackSourceMarkStore,
  fakeSlackValue,
} from "./testing/slack-fakes.ts";

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
  const marks = createMemorySlackSourceMarkStore();
  const signingSecrets = createSlackSigningSecrets({
    apps: counted,
    secrets: secrets.store,
    now: () => clock.getTime(),
  });
  const pendingChannels = new Set<string>();
  const leftChannels = new Set<string>();
  const goneChannels = new Set<string>();
  const readyChannels = new Map<string, "public_channel" | "private_channel">();
  const rejectedChannels = new Set<string>();
  const echoes: unknown[] = [];
  const service = createSlackEventsService({
    signingSecrets,
    inbox: inbox.store,
    apps: apps.store,
    identities: identities.store,
    installs: installs.store,
    sourceMarks: marks.store,
    mirrorEchoes: {
      matchMirrorEcho: async (echo) => {
        echoes.push(echo);
        return "no_candidate";
      },
    },
    bindings: {
      findLiveSlackChannel: async (_installationId, channelId) => {
        const kind = readyChannels.get(channelId);
        if (leftChannels.has(channelId)) {
          return {
            status: "left",
            channelKind: "private_channel",
          } as SurfaceBindingRecord;
        }
        if (goneChannels.has(channelId)) {
          return {
            status: "gone",
            channelKind: "public_channel",
          } as SurfaceBindingRecord;
        }
        if (pendingChannels.has(channelId)) {
          return {
            status: "pending_approval",
            channelKind: "private_channel",
          } as SurfaceBindingRecord;
        }
        return kind === undefined
          ? null
          : ({ status: "ready", channelKind: kind } as SurfaceBindingRecord);
      },
      wasRejected: async (_installationId, channelId) =>
        rejectedChannels.has(channelId),
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
    echoes,
    signingSecrets,
    inbox,
    marks,
    installs,
    identities,
    apps,
    secrets,
    lookups,
    pendingChannels,
    leftChannels,
    goneChannels,
    readyChannels,
    rejectedChannels,
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
    expect(row && "payload" in row ? row.payload?.token : "none").toBe(
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
    w.readyChannels.set("C0CHAN", "public_channel");
    const message = { type: "message", channel: "C0CHAN", ts: "1.1" };
    const cases = [
      [
        { ...message, user: "U0BOTX", bot_id: "B0OTHER" },
        "dropped",
        "bot_allowlist_empty",
      ],
      [{ ...message, user: BOT_USER }, "dropped", "own_bot_user"],
      [
        { ...message, user: "U0P", subtype: "file_share" },
        "dropped",
        "message_subtype",
      ],
      // A person's file or /me line in a thread is kept: it starts the
      // bots' count over.
      [
        { ...message, user: "U0P", subtype: "file_share", thread_ts: "1.0" },
        "received",
        undefined,
      ],
      [
        { ...message, user: "U0P", subtype: "me_message", thread_ts: "1.0" },
        "received",
        undefined,
      ],
      [
        { ...message, user: "U0P", subtype: "me_message" },
        "dropped",
        "message_subtype",
      ],
      [
        {
          ...message,
          user: "U0BOTX",
          bot_id: "B0OTHER",
          subtype: "file_share",
          thread_ts: "1.0",
        },
        "dropped",
        "bot_allowlist_empty",
      ],
      [
        { ...message, user: "U0P", subtype: "message_changed" },
        "dropped",
        "message_subtype",
      ],
      [{ ...MENTION, bot_id: "B0OTHER" }, "dropped", "bot_allowlist_empty"],
      // An instruction the outbox posted under its sender's name.
      [
        {
          ...message,
          subtype: "bot_message",
          bot_id: "B0OWN",
          app_id: APP_ID,
          username: "Mina Park (웹 콘솔)",
          text: "Mina Park (웹 콘솔)\nRun it",
        },
        "dropped",
        "own_bot_user",
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
      [
        { type: "member_left_channel", user: BOT_USER, channel: "G0CHAN" },
        "received",
        undefined,
      ],
      [{ type: "channel_left", channel: "C0CHAN" }, "received", undefined],
      [{ type: "group_left", channel: "G0CHAN" }, "received", undefined],
      [{ type: "reaction_added", user: "U0P" }, "dropped", "unsupported_event"],
    ] as const;
    for (const [fields, status, reason] of cases) {
      const result = await w.service.receive(w.signed(w.event(fields)));
      expect(result).toMatchObject({ kind: "ack", status });
      expect(result.kind === "ack" ? result.reason : null).toBe(reason);
    }
  });

  test("an allowed bot is kept only when it mentions the agent directly outside a DM", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    w.identities.allowedBots.set(AGENT, ["U0REVIEW", BOT_USER]);
    const bot = { user: "U0REVIEW", bot_id: "B0REVIEW" };
    const message = { type: "message", channel: "C0CHAN", ts: "1.1", ...bot };
    const cases = [
      [{ ...MENTION, ...bot }, "received", undefined],
      [
        { ...message, text: `<@${BOT_USER}> review this` },
        "received",
        undefined,
      ],
      [
        { ...message, text: `<@${BOT_USER}|notes> review this` },
        "received",
        undefined,
      ],
      // Talk in a thread without a direct mention, or a mention of another.
      [
        { ...message, text: "done", thread_ts: "1.0" },
        "dropped",
        "bot_message",
      ],
      [{ ...message, text: "<@U0OTHER> hi" }, "dropped", "bot_message"],
      [
        { ...message, text: `<@${BOT_USER}> hi`, channel_type: "im" },
        "dropped",
        "bot_message",
      ],
      // A bot not on the list, and the agent's own bot even when listed.
      [
        { ...MENTION, user: "U0STRANGER", bot_id: "B0STRANGER" },
        "dropped",
        "bot_not_allowed",
      ],
      [
        { ...MENTION, user: BOT_USER, bot_id: "B0OWN" },
        "dropped",
        "own_bot_user",
      ],
      // A legacy bot_message names no user to allow.
      [
        { ...message, user: undefined, subtype: "bot_message" },
        "dropped",
        "bot_message",
      ],
    ] as const;
    for (const [fields, status, reason] of cases) {
      const result = await w.service.receive(w.signed(w.event(fields)));
      expect(result).toMatchObject({ kind: "ack", status });
      expect(result.kind === "ack" ? result.reason : null).toBe(reason);
    }
  });

  // Slack's message event shapes for what this app posts: the outbox's
  // reply as the bot user, and an instruction under its sender's name.
  const OWN_REPLY = {
    type: "message",
    channel: "C0CHAN",
    ts: "1.2",
    thread_ts: "1.1",
    user: BOT_USER,
    bot_id: "B0OWN",
    app_id: APP_ID,
    text: "Confirmed.",
  };
  const OWN_MIRROR = {
    type: "message",
    subtype: "bot_message",
    channel: "C0CHAN",
    ts: "1.3",
    thread_ts: "1.1",
    bot_id: "B0OWN",
    app_id: APP_ID,
    username: "Mina Park (웹 콘솔)",
    text: "Run it",
  };
  const SLACKBOT_DM = {
    type: "message",
    channel: "D0SLACKBOT",
    channel_type: "im",
    user: "USLACK",
    ts: "1.4",
    text: "You were removed from #private by <@U0PERSON>.",
  };

  test("this app's echoes and Slackbot drop under their own reasons, whatever the allow list holds", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    const reasons = async () => {
      const out = [];
      for (const fields of [OWN_REPLY, OWN_MIRROR, SLACKBOT_DM]) {
        const result = await w.service.receive(w.signed(w.event(fields)));
        out.push(
          result.kind === "ack" ? (result.reason ?? result.status) : null,
        );
      }
      return out;
    };
    expect(await reasons()).toEqual([
      "own_bot_user",
      "own_bot_user",
      "slackbot",
    ]);
    w.identities.allowedBots.set(AGENT, ["U0REVIEW"]);
    w.inbox.rows.clear();
    expect(await reasons()).toEqual([
      "own_bot_user",
      "own_bot_user",
      "slackbot",
    ]);

    const cases = [
      // The event's own app_id wins over its bot profile.
      [
        {
          ...OWN_MIRROR,
          app_id: "A0OTHER",
          bot_profile: { app_id: APP_ID },
        },
        "dropped",
        "bot_message",
      ],
      // Slack may name the app only in the bot's profile.
      [
        { ...OWN_MIRROR, app_id: undefined, bot_profile: { app_id: APP_ID } },
        "dropped",
        "own_bot_user",
      ],
      [
        { ...SLACKBOT_DM, channel: "C0CHAN", channel_type: "channel" },
        "dropped",
        "slackbot",
      ],
      // Another app's post under a borrowed name is still a bot to allow.
      [{ ...OWN_MIRROR, app_id: "A0OTHER" }, "dropped", "bot_message"],
      [
        { ...MENTION, user: "U0REVIEW", bot_id: "B0REVIEW" },
        "received",
        undefined,
      ],
    ] as const;
    for (const [fields, status, reason] of cases) {
      const result = await w.service.receive(w.signed(w.event(fields)));
      expect(result).toMatchObject({ kind: "ack", status });
      expect(result.kind === "ack" ? result.reason : null).toBe(reason);
    }
  });

  test("a dropped row keeps who posted it and its subtypes, never text, blocks or files", async () => {
    const w = world();
    await w.install();
    const body = {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Run it" } }],
      attachments: [{ text: "Run it" }],
      files: [{ id: "F0FILE", name: "notes.txt" }],
    };
    const cases = [
      [
        { ...OWN_MIRROR, ...body },
        {
          bot_id: "B0OWN",
          app_id: APP_ID,
          subtype: "bot_message",
        },
      ],
      [{ ...SLACKBOT_DM, ...body }, { user: "USLACK" }],
      [
        {
          type: "message",
          subtype: "message_changed",
          channel: "C0CHAN",
          ts: "1.5",
          message: {
            subtype: "tombstone",
            text: "This message was deleted.",
            user: "U0P",
          },
          previous_message: { text: "secret plan", user: "U0P" },
        },
        { subtype: "message_changed", message: { subtype: "tombstone" } },
      ],
      [
        { type: "reaction_added", user: "U0P", reaction: "eyes" },
        { user: "U0P" },
      ],
    ] as const;
    for (const [fields] of cases) {
      await w.service.receive(w.signed(w.event(fields)));
    }
    const rows = [...w.inbox.rows.values()];
    expect(rows.map((row) => row.status)).toEqual([
      "dropped",
      "dropped",
      "dropped",
      "dropped",
    ]);
    expect(
      rows.map((row) => (row.status === "dropped" ? row.dropFields : null)),
    ).toEqual(cases.map(([, kept]) => kept));
    for (const row of rows) {
      expect("payload" in row).toBe(false);
      expect(JSON.stringify(row)).not.toContain("Run it");
      expect(JSON.stringify(row)).not.toContain("secret plan");
      expect(JSON.stringify(row)).not.toContain("notes.txt");
      expect(JSON.stringify(row)).not.toContain("웹 콘솔");
    }
  });

  test("a dropped row keeps a message's metadata type and a mirror's correlation id, never the rest of its payload", async () => {
    const w = world();
    await w.install();
    const correlation = "019a0000-0000-7000-8000-0000000000c1";
    const cases = [
      [
        {
          ...OWN_MIRROR,
          metadata: {
            event_type: "werft_input_mirror",
            event_payload: { correlation_id: correlation, note: "Run it" },
          },
        },
        { event_type: "werft_input_mirror", correlation_id: correlation },
      ],
      // Another type's payload is never read.
      [
        {
          ...OWN_MIRROR,
          ts: "1.4",
          metadata: {
            event_type: "task_created",
            event_payload: { correlation_id: correlation, title: "Run it" },
          },
        },
        { event_type: "task_created" },
      ],
      // Not an id: the type alone.
      [
        {
          ...OWN_MIRROR,
          ts: "1.5",
          metadata: {
            event_type: "werft_input_mirror",
            event_payload: { correlation_id: "Run it" },
          },
        },
        { event_type: "werft_input_mirror" },
      ],
      [{ ...OWN_MIRROR, ts: "1.6" }, undefined],
    ] as const;
    for (const [fields] of cases) {
      await w.service.receive(w.signed(w.event(fields)));
    }
    const rows = [...w.inbox.rows.values()];
    expect(
      rows.map((row) =>
        row.status === "dropped" ? row.dropFields.metadata : null,
      ),
    ).toEqual(cases.map(([, kept]) => kept));
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("Run it");
    }
    // Only the post that names a mirror's request is matched, by its id.
    expect(w.echoes).toEqual([
      {
        workspaceId: WORKSPACE,
        slackAppId: APP_ROW,
        correlationId: correlation,
        channelId: "C0CHAN",
        ts: "1.3",
      },
    ]);
  });

  test("a person's message carrying a mirror's metadata is never matched", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    await w.service.receive(
      w.signed(
        w.event({
          ...MENTION,
          metadata: {
            event_type: "werft_input_mirror",
            event_payload: {
              correlation_id: "019a0000-0000-7000-8000-0000000000c1",
            },
          },
        }),
      ),
    );
    expect(w.echoes).toEqual([]);
  });

  test("another agent's bot of this Werft install is dropped, even when the allow list still names it", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    // Another agent's app, in another workspace of the same install.
    await w.installs.store.recordInstallation({
      workspaceId: crypto.randomUUID(),
      appId: "A0WRITER",
      teamId: TEAM,
      botUserId: "U0WRITER",
    });
    w.identities.allowedBots.set(AGENT, ["U0WRITER", "U0REVIEW", BOT_USER]);
    const writer = { user: "U0WRITER", bot_id: "B0WRITER" };
    const cases = [
      [{ ...MENTION, ...writer }, "dropped", "werft_agent_bot"],
      // The agent's own bot is blocked too, under its own reason.
      [
        { ...MENTION, user: BOT_USER, bot_id: "B0OWN" },
        "dropped",
        "own_bot_user",
      ],
      [
        {
          type: "message",
          channel: "C0CHAN",
          ts: "1.1",
          text: `<@${BOT_USER}> hi`,
          ...writer,
        },
        "dropped",
        "werft_agent_bot",
      ],
      // A bot outside Werft on the list still goes on.
      [
        { ...MENTION, user: "U0REVIEW", bot_id: "B0REVIEW" },
        "received",
        undefined,
      ],
    ] as const;
    for (const [fields, status, reason] of cases) {
      const result = await w.service.receive(w.signed(w.event(fields)));
      expect(result).toMatchObject({ kind: "ack", status });
      expect(result.kind === "ack" ? result.reason : null).toBe(reason);
    }
  });

  test("with an empty allow list every bot stays dropped, under its own reason", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    const result = await w.service.receive(
      w.signed(w.event({ ...MENTION, user: "U0REVIEW", bot_id: "B0REVIEW" })),
    );
    expect(result).toMatchObject({
      status: "dropped",
      reason: "bot_allowlist_empty",
    });
  });

  test("a bot missing from a non-empty allow list is dropped as not allowed", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    w.identities.allowedBots.set(AGENT, ["U0REVIEW"]);
    const result = await w.service.receive(
      w.signed(w.event({ ...MENTION, user: "U0OTHERBOT", bot_id: "B0OTHER" })),
    );
    expect(result).toMatchObject({
      status: "dropped",
      reason: "bot_not_allowed",
    });
  });

  test("an allowed bot that does not mention the agent keeps the bot_message reason", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    w.identities.allowedBots.set(AGENT, ["U0REVIEW"]);
    const result = await w.service.receive(
      w.signed(
        w.event({
          type: "message",
          channel: "C0CHAN",
          ts: "1.1",
          user: "U0REVIEW",
          bot_id: "B0REVIEW",
          text: "no mention",
        }),
      ),
    );
    expect(result).toMatchObject({ status: "dropped", reason: "bot_message" });
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

  test("in a channel waiting for approval, an allowed bot's mention keeps its bot id", async () => {
    const w = world();
    await w.install();
    w.identities.allowedBots.set(AGENT, ["U0REVIEW"]);
    w.pendingChannels.add("G0WAIT");
    const mention = await w.service.receive(
      w.signed(
        w.event({
          type: "app_mention",
          user: "U0REVIEW",
          bot_id: "B0REVIEW",
          text: `<@${BOT_USER}> the launch code is 1234`,
          channel: "G0WAIT",
          channel_type: "group",
          ts: "1.2",
          thread_ts: "1.1",
        }),
      ),
    );
    expect(mention).toMatchObject({ status: "received" });
    const [row] = [...w.inbox.rows.values()].flatMap((item) =>
      item.status === "received" ? [item] : [],
    );
    const event = (row?.payload as { event: Record<string, unknown> }).event;
    expect(event.bot_id).toBe("B0REVIEW");
    expect(event.text).toBe(`<@${BOT_USER}>`);
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
    w.readyChannels.set("G0WAIT", "private_channel");
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

  test("a channel the bot left drops every message and mention, with no text kept, whatever channel_type says", async () => {
    const w = world();
    await w.install();
    w.leftChannels.add("G0GONE");
    for (const [type, channelType] of [
      ["message", "group"],
      ["message", "channel"],
      ["app_mention", undefined],
    ] as const) {
      const outcome = await w.service.receive(
        w.signed(
          w.event({
            type,
            user: "U0P",
            text: `<@${BOT_USER}> the launch code is 1234`,
            channel: "G0GONE",
            ...(channelType === undefined ? {} : { channel_type: channelType }),
            ts: "1.1",
          }),
        ),
      );
      expect(outcome).toMatchObject({
        status: "dropped",
        reason: "channel_left",
      });
    }
    expect(JSON.stringify([...w.inbox.rows.values()])).not.toContain("1234");
  });

  test("a private channel keeps no text unless a ready private binding holds it: rejected and unbound are dropped, bound as public is kept without text", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("G0PUBLIC", "public_channel");
    w.readyChannels.set("G0OK", "private_channel");
    const outcomes: Record<string, unknown> = {};
    for (const channel of ["G0REJECTED", "G0PUBLIC", "G0OK"]) {
      outcomes[channel] = await w.service.receive(
        w.signed(
          w.event({
            type: "message",
            user: "U0P",
            text: "the launch code is 1234",
            channel,
            channel_type: "group",
            ts: "1.1",
          }),
        ),
      );
    }
    expect(outcomes.G0REJECTED).toMatchObject({
      status: "dropped",
      reason: "channel_pending_approval",
    });
    // Kept without its text, so the handler can still demote the binding.
    expect(outcomes.G0PUBLIC).toMatchObject({ status: "received" });
    const stored = [...w.inbox.rows.values()].flatMap((row) =>
      row.status === "received" &&
      (row.payload as { event: { channel: string } }).event.channel ===
        "G0PUBLIC"
        ? [row.payload]
        : [],
    );
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0])).not.toContain("1234");
    expect(outcomes.G0OK).toMatchObject({ status: "received" });

    w.rejectedChannels.add("G0REJECTED");
    const mention = await w.service.receive(
      w.signed(
        w.event({
          type: "app_mention",
          user: "U0P",
          text: `<@${BOT_USER}> the launch code is 1234`,
          channel: "G0REJECTED",
          ts: "1.2",
        }),
      ),
    );
    expect(mention).toMatchObject({ status: "received" });
    // A channel the bot was just invited to has no binding yet: its first
    // mention keeps the text the invite handler's binding will need.
    await w.service.receive(
      w.signed(
        w.event({
          type: "app_mention",
          user: "U0P",
          text: `<@${BOT_USER}> summarize this incident`,
          channel: "C0NEW",
          ts: "1.3",
        }),
      ),
    );
    const texts = [...w.inbox.rows.values()].flatMap((row) =>
      row.status === "received" ? [JSON.stringify(row.payload)] : [],
    );
    expect(texts.some((text) => text.includes("summarize this incident"))).toBe(
      true,
    );
    const kept = [...w.inbox.rows.values()].flatMap((row) =>
      row.status === "received" &&
      (row.payload as { event: { channel: string } }).event.channel ===
        "G0REJECTED"
        ? [row.payload]
        : [],
    );
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0])).not.toContain("1234");
  });

  test("channel archive, rename and delete events are received for the handler, whatever the binding", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0LIFE", "public_channel");
    for (const fields of [
      { type: "channel_archive", channel: "C0LIFE", user: "U0P" },
      { type: "channel_unarchive", channel: "C0LIFE", user: "U0P" },
      { type: "group_archive", channel: "G0LIFE" },
      { type: "group_unarchive", channel: "G0LIFE" },
      {
        type: "channel_rename",
        channel: { id: "C0LIFE", name: "renamed", created: 1 },
      },
      {
        type: "group_rename",
        channel: { id: "G0LIFE", name: "renamed", created: 1 },
      },
      { type: "channel_deleted", channel: "C0LIFE" },
      { type: "group_deleted", channel: "G0LIFE" },
    ]) {
      expect(
        await w.service.receive(
          w.signed(
            w.event(fields, { eventId: `Ev${fields.type.replace("_", "")}` }),
          ),
        ),
      ).toMatchObject({ status: "received", result: "recorded" });
    }
    // A deleted channel's own lifecycle events still reach the handler.
    w.goneChannels.add("C0GONE");
    expect(
      await w.service.receive(
        w.signed(
          w.event(
            { type: "channel_unarchive", channel: "C0GONE" },
            { eventId: "EvUnarchiveGone" },
          ),
        ),
      ),
    ).toMatchObject({ status: "received" });
  });

  test("a channel Slack deleted drops every message and mention, with no text kept", async () => {
    const w = world();
    await w.install();
    w.goneChannels.add("C0GONE");
    for (const [type, channelType] of [
      ["message", "channel"],
      ["app_mention", undefined],
    ] as const) {
      const outcome = await w.service.receive(
        w.signed(
          w.event({
            type,
            user: "U0P",
            text: `<@${BOT_USER}> the launch code is 1234`,
            channel: "C0GONE",
            ...(channelType === undefined ? {} : { channel_type: channelType }),
            ts: "1.1",
          }),
        ),
      );
      expect(outcome).toMatchObject({
        status: "dropped",
        reason: "channel_gone",
      });
    }
    expect(JSON.stringify([...w.inbox.rows.values()])).not.toContain("1234");
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

// Slack's documented shapes: an edit, a delete, and the tombstone a parent
// with replies becomes when it is deleted.
const EDITED = {
  type: "message",
  subtype: "message_changed",
  hidden: true,
  channel: "C0CHAN",
  channel_type: "channel",
  ts: "1792800000.000900",
  event_ts: "1792800000.000900",
  message: {
    type: "message",
    user: "U0P",
    text: "the fixed plan",
    ts: "1792800000.000100",
    edited: { user: "U0P", ts: "1792800000.000900" },
  },
  previous_message: {
    type: "message",
    user: "U0P",
    text: "the secret plan",
    ts: "1792800000.000100",
  },
};
const DELETED = {
  type: "message",
  subtype: "message_deleted",
  hidden: true,
  channel: "C0CHAN",
  channel_type: "channel",
  ts: "1792800000.000800",
  deleted_ts: "1792800000.000100",
  event_ts: "1792800000.000800",
  previous_message: {
    type: "message",
    user: "U0P",
    text: "the secret plan",
    ts: "1792800000.000100",
  },
};
const TOMBSTONE = {
  type: "message",
  subtype: "message_changed",
  hidden: true,
  channel: "D0DM",
  channel_type: "im",
  ts: "1792800000.000700",
  event_ts: "1792800000.000700",
  message: {
    type: "message",
    subtype: "tombstone",
    user: "USLACKBOT",
    hidden: true,
    text: "This message was deleted.",
    ts: "1792800000.000200",
    thread_ts: "1792800000.000200",
    reply_count: 1,
  },
  previous_message: {
    type: "message",
    user: "U0P",
    text: "the secret plan",
    ts: "1792800000.000200",
    thread_ts: "1792800000.000200",
  },
};

describe("Slack edits and deletes", () => {
  const MARK = {
    workspaceId: WORKSPACE,
    teamId: TEAM,
    channelId: "C0CHAN",
    // Slack's own time of the change (event_ts, edited.ts), not the
    // envelope's, which the world sets to NOW.
    at: new Date(1792800000 * 1000),
  };

  test("a delete leaves one mark and an inbox row processed without its payload", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    const reply = {
      ...DELETED,
      deleted_ts: "1792800000.000300",
      previous_message: {
        ...DELETED.previous_message,
        ts: "1792800000.000300",
        thread_ts: "1792800000.000100",
      },
    };
    const bot = {
      ...DELETED,
      deleted_ts: "1792800000.000400",
      previous_message: {
        type: "message",
        subtype: "bot_message",
        bot_id: "B0OTHER",
        text: "the secret plan",
        ts: "1792800000.000400",
      },
    };
    for (const fields of [DELETED, reply, bot]) {
      expect(await w.service.receive(w.signed(w.event(fields)))).toMatchObject({
        kind: "ack",
        result: "recorded",
        status: "processed",
      });
    }
    // Slack's retry of one event, and another event for the same delete.
    const again = w.event(DELETED, { eventId: "Ev0AGAIN" });
    expect(await w.service.receive(w.signed(again))).toMatchObject({
      result: "recorded",
    });
    expect(await w.service.receive(w.signed(again))).toMatchObject({
      result: "duplicate",
    });
    expect([...w.marks.deleted.values()]).toEqual([
      { ...MARK, ts: "1792800000.000100" },
      { ...MARK, ts: "1792800000.000300" },
      { ...MARK, ts: "1792800000.000400" },
    ]);
    const rows = [...w.inbox.rows.values()];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "processed",
        eventSubtype: "message_deleted",
        payload: null,
        conversationKey: null,
      });
      expect(JSON.stringify(row)).not.toContain("plan");
    }
  });

  test("a parent's tombstone is a delete, in a channel and in a DM", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    const inChannel = {
      ...TOMBSTONE,
      channel: "C0CHAN",
      channel_type: "channel",
      message: { ...TOMBSTONE.message, ts: "1792800000.000500" },
    };
    for (const fields of [TOMBSTONE, inChannel]) {
      expect(await w.service.receive(w.signed(w.event(fields)))).toMatchObject({
        status: "processed",
      });
    }
    expect([...w.marks.deleted.values()]).toEqual([
      { ...MARK, channelId: "D0DM", ts: "1792800000.000200" },
      { ...MARK, ts: "1792800000.000500" },
    ]);
    expect(w.marks.edited.size).toBe(0);
    for (const row of w.inbox.rows.values()) {
      expect(row).toMatchObject({ status: "processed", payload: null });
    }
  });

  test("an edit leaves only its mark; a change no one made is dropped as before", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    expect(await w.service.receive(w.signed(w.event(EDITED)))).toMatchObject({
      status: "processed",
    });
    // A later edit whose event Slack sent at the same envelope time.
    const later = new Date((1792800000 + 60) * 1000);
    await w.service.receive(
      w.signed(
        w.event(
          {
            ...EDITED,
            message: {
              ...EDITED.message,
              edited: { user: "U0P", ts: "1792800060.000100" },
            },
          },
          { eventId: "Ev0EDIT2" },
        ),
      ),
    );
    // An unfurl or a reply count: no `edited` on the message.
    const { edited: _, ...unfurled } = EDITED.message;
    expect(
      await w.service.receive(
        w.signed(w.event({ ...EDITED, message: unfurled })),
      ),
    ).toMatchObject({ status: "dropped", reason: "message_subtype" });
    expect([...w.marks.edited.values()]).toEqual([
      { ...MARK, ts: "1792800000.000100", at: later },
    ]);
    expect(w.marks.deleted.size).toBe(0);
    for (const row of w.inbox.rows.values()) {
      expect("payload" in row ? row.payload : null).toBeNull();
    }
    expect(JSON.stringify([...w.inbox.rows.values()])).not.toContain("plan");
    expect(JSON.stringify([...w.marks.edited.values()])).not.toContain("plan");
  });

  test("an edit hands its new text to the mark store, for a buffered message only, and the inbox keeps none of it", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    await w.service.receive(w.signed(w.event(EDITED)));
    await w.service.receive(
      w.signed(w.event(DELETED, { eventId: "Ev0DELETE" })),
    );
    expect(w.marks.editedBodies).toEqual(["the fixed plan"]);
    for (const row of w.inbox.rows.values()) {
      expect(row).toMatchObject({ status: "processed", payload: null });
    }
  });

  test("an edit without its own time takes the envelope's", async () => {
    const w = world();
    await w.install();
    await w.service.receive(
      w.signed(
        w.event(
          {
            ...EDITED,
            message: { ...EDITED.message, edited: { user: "U0P" } },
          },
          { eventTime: NOW_SECONDS + 5 },
        ),
      ),
    );
    expect([...w.marks.edited.values()]).toEqual([
      {
        ...MARK,
        ts: "1792800000.000100",
        at: new Date((NOW_SECONDS + 5) * 1000),
      },
    ]);
  });

  test("a delete wins over an edit of the same message", async () => {
    const w = world();
    await w.install();
    w.readyChannels.set("C0CHAN", "public_channel");
    await w.service.receive(w.signed(w.event(EDITED)));
    expect(w.marks.edited.size).toBe(1);
    await w.service.receive(w.signed(w.event(DELETED)));
    expect(w.marks.edited.size).toBe(0);
    await w.service.receive(w.signed(w.event(EDITED, { eventId: "Ev0EDIT2" })));
    expect(w.marks.edited.size).toBe(0);
    expect(w.marks.deleted.size).toBe(1);
  });

  test("an edit or a delete for an app that is not this agent's is dropped and marks nothing", async () => {
    const w = world({ linkTo: OTHER_AGENT });
    await w.install();
    expect(await w.service.receive(w.signed(w.event(DELETED)))).toMatchObject({
      status: "dropped",
      reason: "agent_mismatch",
    });
    expect(w.marks.deleted.size).toBe(0);
  });
});
