import { describe, expect, test } from "bun:test";
import {
  SLACK_CHANNEL_MEMBER_LIMIT,
  SLACK_MEMBER_CACHE_TTL_MS,
} from "@werft-ai/contracts";
import type {
  ChannelMemberStore,
  SlackEventAgent,
  SurfaceInboundClaim,
} from "@werft-ai/platform";
import { createFakeSlackWebApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createSlackChannelMembers,
  createSlackMemberCacheInvalidator,
} from "./slack-channel-members.ts";
import { createSlackBotApi } from "./slack-config-api.ts";
import { fakeSlackValue } from "./testing/slack-fakes.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const INSTALL = "019a0000-0000-7000-8000-0000000000e1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a1";
const STRANGER = "019a0000-0000-7000-8000-0000000000a2";
const UNLINKED = "019a0000-0000-7000-8000-0000000000a3";
const APP_ID = "A0MEMBERS1";

// The table's rules, in memory: a list answers within the TTL unless a void
// came at or after its read began; a write older than a void is dropped.
function memoryStore(clock: () => number) {
  const rows = new Map<
    string,
    { memberIds: string[]; fetchedAt: number | null; voidedAt: number | null }
  >();
  const key = (installationId: string, channelId: string) =>
    `${installationId}/${channelId}`;
  const links = new Map([
    [MEMBER, "U0MEMBER"],
    [STRANGER, "U0STRANGER"],
  ]);
  const store: ChannelMemberStore = {
    async subject(input) {
      const slackUserId = links.get(input.userId);
      return input.agentId === AGENT && slackUserId
        ? { installationId: INSTALL, slackUserId }
        : null;
    },
    async cached(installationId, channelId) {
      const row = rows.get(key(installationId, channelId));
      const now = clock();
      const fresh =
        row?.fetchedAt != null &&
        row.fetchedAt > now - SLACK_MEMBER_CACHE_TTL_MS &&
        (row.voidedAt === null || row.voidedAt < row.fetchedAt);
      return {
        memberIds: fresh ? row.memberIds : null,
        checkedAt: new Date(now),
      };
    },
    async remember(installationId, channelId, memberIds, checkedAt) {
      const at = checkedAt.getTime();
      if (at <= clock() - SLACK_MEMBER_CACHE_TTL_MS) return false;
      const row = rows.get(key(installationId, channelId));
      if (row?.voidedAt != null && row.voidedAt >= at) return false;
      rows.set(key(installationId, channelId), {
        memberIds: [...memberIds],
        fetchedAt: at,
        voidedAt: row?.voidedAt ?? null,
      });
      return true;
    },
    async forget(installationId, channelId) {
      rows.set(key(installationId, channelId), {
        memberIds: [],
        fetchedAt: rows.get(key(installationId, channelId))?.fetchedAt ?? null,
        voidedAt: clock(),
      });
    },
  };
  return { store, rows };
}

function setup(options: { botToken?: boolean } = {}) {
  let now = Date.parse("2026-11-23T10:00:00.000Z");
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
  const [inside, outside] = slack.seedChannels([
    {
      name: "incident",
      isPrivate: true,
      members: [APP_ID],
      people: ["U0MEMBER"],
    },
    { name: "secret", isPrivate: true, people: ["U0MEMBER"] },
  ]);
  if (!inside || !outside) throw new Error("seed failed");
  const memory = memoryStore(() => now);
  const warnings: Record<string, unknown>[] = [];
  const members = createSlackChannelMembers({
    store: memory.store,
    slack: createSlackBotApi({
      apiUrl: "http://slack.test/api",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        (await slack.handle(new Request(input, init))) ??
        new Response("not found", { status: 404 })) as typeof fetch,
    }),
    botToken: async (workspaceId, agentId) =>
      options.botToken !== false &&
      workspaceId === WORKSPACE &&
      agentId === AGENT
        ? botToken
        : null,
    logger: { warn: (_message, fields) => warnings.push(fields ?? {}) },
  });
  const ask = (userId: string, channelId = inside.id) =>
    members.isMember({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      channelId,
      userId,
    });
  const memberCalls = () =>
    slack.calls.filter((call) => call.method === "conversations.members")
      .length;
  return {
    members,
    slack,
    inside,
    outside,
    memory,
    warnings,
    ask,
    memberCalls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Slack channel member check", () => {
  test("a member is one; a non-member, an unlinked user and a channel the bot is not in are not", async () => {
    const t = setup();

    expect(await t.ask(MEMBER)).toBe(true);
    expect(await t.ask(STRANGER)).toBe(false);
    expect(await t.ask(UNLINKED)).toBe(false);
    // The person is in it, but the bot is not: Slack hides the channel.
    expect(await t.ask(MEMBER, t.outside.id)).toBe(false);
    expect(t.warnings.at(-1)).toMatchObject({
      reason: "slack_error",
      slack_error: "channel_not_found",
    });
  });

  test("a Slack error, a 429, no answer and a missing bot token answer false without throwing", async () => {
    const failing = setup();
    failing.slack.failures.set("conversations.members", "internal_error");
    expect(await failing.ask(MEMBER)).toBe(false);

    const limited = setup();
    limited.slack.rateLimit("conversations.members", 30);
    expect(await limited.ask(MEMBER)).toBe(false);
    expect(limited.warnings).toEqual([
      expect.objectContaining({
        event: "slack.member_check.unconfirmed",
        reason: "rate_limited",
      }),
    ]);

    const tokenless = setup({ botToken: false });
    expect(await tokenless.ask(MEMBER)).toBe(false);
    expect(tokenless.warnings).toEqual([
      expect.objectContaining({ reason: "no_bot_token" }),
    ]);

    // Nothing failed was kept: once Slack answers, the member is one again.
    expect(await limited.ask(MEMBER)).toBe(true);
    expect(await failing.ask(MEMBER)).toBe(false);
    failing.slack.failures.delete("conversations.members");
    expect(await failing.ask(MEMBER)).toBe(true);
  });

  test("a store that throws answers false too", async () => {
    const t = setup();
    t.memory.store.cached = async () => {
      throw new Error("database down");
    };
    expect(await t.ask(MEMBER)).toBe(false);
    expect(t.warnings).toEqual([expect.objectContaining({ reason: "failed" })]);
  });

  test("the same channel asked twice within 5 minutes calls Slack once, and again after", async () => {
    const t = setup();

    expect(await t.ask(MEMBER)).toBe(true);
    expect(await t.ask(STRANGER)).toBe(false);
    t.advance(SLACK_MEMBER_CACHE_TTL_MS - 1);
    expect(await t.ask(MEMBER)).toBe(true);
    expect(t.memberCalls()).toBe(1);

    t.advance(1);
    expect(await t.ask(MEMBER)).toBe(true);
    expect(t.memberCalls()).toBe(2);
  });

  test("a member event voids the list: the next question reads Slack again", async () => {
    const t = setup();
    expect(await t.ask(MEMBER)).toBe(true);

    t.inside.people = [];
    const forwarded: string[] = [];
    const resolved: SlackEventAgent = {
      status: "resolved",
      workspaceId: WORKSPACE,
      agentId: AGENT,
      identity: { id: "019a0000-0000-7000-8000-0000000000b1", revision: 1 },
      installationId: INSTALL,
      botUserId: `U${APP_ID}BOT`,
      credentialRef: "ref",
      allowedBotUserIds: [],
      werftBotUserIds: [],
    };
    const redrawn: unknown[] = [];
    const invalidate = createSlackMemberCacheInvalidator({
      agents: { resolveSlackEvent: async () => resolved },
      members: t.memory.store,
      // Answer 15 (94S-2000): a push card's requester may be the one.
      cards: {
        markPushCardsDueIn: async (input) => {
          redrawn.push(input);
          return 1;
        },
      },
      next: async (claim) => {
        forwarded.push((claim.payload.event as { type: string }).type);
      },
    });
    const claim = (event: Record<string, unknown>) =>
      ({
        id: "019a0000-0000-7000-8000-0000000000b2",
        appId: APP_ID,
        teamId: "T0MOCK",
        agentId: AGENT,
        workspaceId: WORKSPACE,
        slackAppId: "019a0000-0000-7000-8000-0000000000d1",
        payload: { event },
      }) as unknown as SurfaceInboundClaim;

    // A message is not a member change: the list stays.
    await invalidate(claim({ type: "message", channel: t.inside.id }));
    expect(await t.ask(MEMBER)).toBe(true);
    expect(t.memberCalls()).toBe(1);

    await invalidate(
      claim({
        type: "member_left_channel",
        user: "U0MEMBER",
        channel: t.inside.id,
      }),
    );
    t.advance(1);
    expect(await t.ask(MEMBER)).toBe(false);
    expect(t.memberCalls()).toBe(2);

    t.inside.people = ["U0MEMBER"];
    await invalidate(
      claim({
        type: "member_joined_channel",
        user: "U0MEMBER",
        channel: t.inside.id,
      }),
    );
    t.advance(1);
    expect(await t.ask(MEMBER)).toBe(true);
    expect(t.memberCalls()).toBe(3);

    await invalidate(claim({ type: "group_left", channel: t.inside.id }));
    t.advance(1);
    expect(await t.ask(MEMBER)).toBe(true);
    expect(t.memberCalls()).toBe(4);
    expect(forwarded).toEqual([
      "message",
      "member_left_channel",
      "member_joined_channel",
      "group_left",
    ]);
    const here = {
      installationId: INSTALL,
      channelId: t.inside.id,
      windowMs: 5 * 60_000,
    };
    expect(redrawn).toEqual([here, here, here]);
  });

  test("a list read before a void is not written back after it", async () => {
    const t = setup();
    const before = await t.memory.store.cached(INSTALL, t.inside.id);
    await t.memory.store.forget(INSTALL, t.inside.id);
    await t.memory.store.remember(
      INSTALL,
      t.inside.id,
      ["U0MEMBER"],
      before.checkedAt,
    );
    expect(
      (await t.memory.store.cached(INSTALL, t.inside.id)).memberIds,
    ).toBeNull();
  });

  test("a large channel is read to the end through its cursor", async () => {
    const t = setup();
    const people = Array.from({ length: 450 }, (_, i) => `U0P${i}`);
    t.inside.people = [...people, "U0MEMBER"];

    expect(await t.ask(MEMBER)).toBe(true);
    // 452 with the bot, 200 a page.
    expect(t.memberCalls()).toBe(3);
  });

  test("a member event during the read leaves that read unused: false, and the next question reads again", async () => {
    const t = setup();
    const remember = t.memory.store.remember;
    t.memory.store.remember = async (installationId, channelId, ids, at) => {
      // The member left, and the void landed, while Slack was being read.
      await t.memory.store.forget(installationId, channelId);
      return remember(installationId, channelId, ids, at);
    };
    expect(await t.ask(MEMBER)).toBe(false);
    expect(t.warnings).toEqual([
      expect.objectContaining({ reason: "overtaken" }),
    ]);

    t.memory.store.remember = remember;
    t.advance(1);
    expect(await t.ask(MEMBER)).toBe(true);
    expect(t.memberCalls()).toBe(2);
  });

  test("a channel over the member limit is not checked and not kept", async () => {
    const t = setup();
    t.inside.people = [
      ...Array.from(
        { length: SLACK_CHANNEL_MEMBER_LIMIT },
        (_, i) => `U0P${i}`,
      ),
      "U0MEMBER",
    ];

    expect(await t.ask(MEMBER)).toBe(false);
    expect(t.memberCalls()).toBe(50);
    expect(t.warnings).toEqual([
      expect.objectContaining({ reason: "too_many_members" }),
    ]);
    expect(t.memory.rows.size).toBe(0);
  });
});
// Answer 15 (PR2): a session's direct message is checked against the account
// it is addressed to. MEMBER is linked to U0MEMBER now; a row queued for an
// account MEMBER linked before is asked about as that account.
describe("Slack channel member check for one account", () => {
  test("asks about the account itself, not whoever links it now", async () => {
    const t = setup();
    const of = (slackUserId: string) =>
      t.members.slackMembership({
        workspaceId: WORKSPACE,
        agentId: AGENT,
        channelId: t.inside.id,
        installationId: INSTALL,
        slackUserId,
      });
    expect(
      await t.members.membership({
        workspaceId: WORKSPACE,
        agentId: AGENT,
        channelId: t.inside.id,
        userId: MEMBER,
      }),
    ).toBe("member");
    expect(await of("U0MEMBER")).toBe("member");
    expect(await of("U0FORMER")).toBe("not_member");
    expect(await of("U0STRANGER")).toBe("not_member");
  });
});
