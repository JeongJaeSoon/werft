import { describe, expect, test } from "bun:test";
import type {
  SurfaceChannelKind,
  SurfaceMembership,
} from "@werft-ai/contracts";
import type { SlackInboundClaim } from "../ports/slack-inbound-event-store.ts";
import type { SurfaceBindingRecord } from "../ports/surface-binding-store.ts";
import {
  createSlackChannelJoiner,
  createSlackMemberJoinedHandler,
  joinSlackChannel,
} from "./slack-channel-join.ts";
import {
  SlackApiError,
  type SlackBotApi,
  type SlackChannelMembership,
  SlackRateLimitedError,
} from "./slack-config-api.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000c1";
const BOT = "U0BOT";

function slackWith(
  seen: Partial<SlackChannelMembership> | Error,
  join?: Error,
) {
  const calls: string[] = [];
  const slack: Pick<SlackBotApi, "channelMembership" | "joinChannel"> = {
    async channelMembership(_token, channelId) {
      calls.push(`info:${channelId}`);
      if (seen instanceof Error) throw seen;
      return {
        kind: "public_channel",
        isMember: false,
        isArchived: false,
        ...seen,
      };
    },
    async joinChannel(_token, channelId) {
      calls.push(`join:${channelId}`);
      if (join) throw join;
    },
  };
  return { slack, calls };
}

const refusal = (method: string, code: string) =>
  new SlackApiError(method, code, true);

describe("joining a bound channel", () => {
  const cases: [
    string,
    Partial<SlackChannelMembership> | Error,
    Error | undefined,
    SurfaceMembership | null,
    string[],
  ][] = [
    [
      "already in",
      { isMember: true },
      undefined,
      { state: "joined", error: null },
      ["info:C1"],
    ],
    [
      "public: joins",
      {},
      undefined,
      { state: "joined", error: null },
      ["info:C1", "join:C1"],
    ],
    [
      "private: waits for the invite",
      { kind: "private_channel" },
      undefined,
      { state: "awaiting_invite", error: null },
      ["info:C1"],
    ],
    [
      "unseen private: waits for the invite",
      refusal("conversations.info", "channel_not_found"),
      undefined,
      { state: "awaiting_invite", error: "channel_not_found" },
      ["info:C1"],
    ],
    [
      "archived",
      { isArchived: true },
      undefined,
      { state: "join_failed", error: "is_archived" },
      ["info:C1"],
    ],
    [
      "archived while in it",
      { isMember: true, isArchived: true },
      undefined,
      { state: "join_failed", error: "is_archived" },
      ["info:C1"],
    ],
    [
      "join refused by policy",
      {},
      refusal("conversations.join", "restricted_action"),
      { state: "join_failed", error: "restricted_action" },
      ["info:C1", "join:C1"],
    ],
    [
      "join scope missing (app not reinstalled)",
      {},
      refusal("conversations.join", "missing_scope"),
      { state: "config_error", error: "missing_scope" },
      ["info:C1", "join:C1"],
    ],
    [
      "lookup scope missing",
      refusal("conversations.info", "missing_scope"),
      undefined,
      { state: "config_error", error: "missing_scope" },
      ["info:C1"],
    ],
    [
      "no answer: nothing known",
      new SlackApiError("conversations.info", "timeout", false),
      undefined,
      null,
      ["info:C1"],
    ],
    [
      "rate limited: nothing known",
      {},
      new SlackRateLimitedError("conversations.join", 30),
      null,
      ["info:C1", "join:C1"],
    ],
  ];
  for (const [name, seen, join, expected, calls] of cases) {
    test(name, async () => {
      const fake = slackWith(seen, join);
      expect(
        await joinSlackChannel(fake.slack, "bot-credential", "C1"),
      ).toEqual(expected);
      expect(fake.calls).toEqual(calls);
    });
  }

  test("the joiner records only a change, and skips the DM row, an off binding and a missing token", async () => {
    const recorded: [string, SurfaceMembership][] = [];
    const fake = slackWith({ isMember: true });
    let token: string | null = "bot-credential";
    const joiner = createSlackChannelJoiner({
      bindings: {
        setMembership: async (id, membership) => {
          recorded.push([id, membership]);
        },
      },
      slack: fake.slack,
      botToken: async () => token,
    });
    const base = {
      id: "b1",
      workspaceId: WORKSPACE,
      agentId: AGENT,
      channelId: "C1",
      mode: "on",
      membership: null,
    } as SurfaceBindingRecord;
    expect(await joiner(base)).toEqual({ state: "joined", error: null });
    expect(
      await joiner({ ...base, membership: { state: "joined", error: null } }),
    ).toEqual({ state: "joined", error: null });
    expect(await joiner({ ...base, channelId: null })).toBeNull();
    expect(await joiner({ ...base, mode: "off" })).toBeNull();
    token = null;
    expect(await joiner(base)).toBeNull();
    expect(recorded).toEqual([["b1", { state: "joined", error: null }]]);
    expect(fake.calls).toEqual(["info:C1", "info:C1"]);
  });
});

describe("the bot's invite", () => {
  function handler(
    bound: Partial<SurfaceBindingRecord> | null,
    // What Slack answers per channel; an Error is a read that failed.
    kinds: Record<string, SurfaceChannelKind | Error> = {
      G1: "private_channel",
      G2: "private_channel",
      C3: "public_channel",
    },
    botToken: string | null = "xoxb-test",
  ) {
    const asked: string[] = [];
    const demoted: string[] = [];
    const recorded: [string, SurfaceMembership][] = [];
    const welcomed: string[] = [];
    const passed: string[] = [];
    const invited: [string, string][] = [];
    const handle = createSlackMemberJoinedHandler({
      agents: {
        resolveSlackEvent: async () => ({
          status: "resolved",
          workspaceId: WORKSPACE,
          agentId: AGENT,
          installationId: INSTALLATION,
          identityId: "identity-1",
          botUserId: BOT,
        }),
      } as never,
      bindings: {
        // What the store holds for the channel, whatever its kind and
        // status; null stands for a channel nobody bound yet.
        ensureInvitedChannel: async (_installation, channelId, kind) => {
          invited.push([channelId, kind]);
          return {
            id: bound === null ? "b2" : "b1",
            workspaceId: WORKSPACE,
            agentId: AGENT,
            home: false,
            status: kind === "private_channel" ? "pending_approval" : "ready",
            channelKind: kind,
            ...bound,
          } as SurfaceBindingRecord;
        },
        requireApproval: async (id) => {
          demoted.push(id);
          return {
            id,
            workspaceId: WORKSPACE,
            agentId: AGENT,
            home: false,
            status: "pending_approval",
            channelKind: "private_channel",
          } as SurfaceBindingRecord;
        },
        setMembership: async (id, membership) => {
          recorded.push([id, membership]);
        },
      },
      slack: {
        channelKind: async (_token, channelId) => {
          asked.push(channelId);
          if (kinds[channelId] instanceof Error) throw kinds[channelId];
          return (kinds[channelId] as SurfaceChannelKind | undefined) ?? "dm";
        },
      },
      botToken: async () => botToken,
      welcome: {
        welcome: async (_workspace, agentId) => {
          welcomed.push(agentId);
          return { status: "enqueued", channelId: "G1" };
        },
      },
      next: async (claim) => {
        passed.push(claim.eventType);
      },
    });
    return { handle, recorded, welcomed, passed, invited, asked, demoted };
  }

  const claim = (event: Record<string, unknown>) =>
    ({
      id: "e1",
      workspaceId: WORKSPACE,
      agentId: AGENT,
      appId: "A1",
      teamId: "T1",
      eventType: String(event.type),
      payload: { event },
    }) as unknown as SlackInboundClaim;

  test("the bot invited to its approved home: joined, then the welcome", async () => {
    const h = handler({
      home: true,
      status: "ready",
      channelKind: "private_channel",
    });
    await h.handle(
      claim({ type: "member_joined_channel", user: BOT, channel: "G1" }),
    );
    expect(h.recorded).toEqual([["b1", { state: "joined", error: null }]]);
    expect(h.welcomed).toEqual([AGENT]);
  });

  test("a bound channel that is not home is marked joined, with no welcome", async () => {
    const h = handler({ home: false });
    await h.handle(
      claim({ type: "member_joined_channel", user: BOT, channel: "G1" }),
    );
    expect(h.recorded).toHaveLength(1);
    expect(h.welcomed).toEqual([]);
  });

  test("the bot invited to an unbound channel binds it with the kind Slack reports, joined, with no welcome", async () => {
    const h = handler(null);
    // `channel_type` says public; Slack says private, and Slack is believed.
    await h.handle(
      claim({
        type: "member_joined_channel",
        user: BOT,
        channel: "G2",
        channel_type: "C",
      }),
    );
    await h.handle(
      claim({ type: "member_joined_channel", user: BOT, channel: "C3" }),
    );
    expect(h.asked).toEqual(["G2", "C3"]);
    expect(h.invited).toEqual([
      ["G2", "private_channel"],
      ["C3", "public_channel"],
    ]);
    expect(h.recorded).toEqual([
      ["b2", { state: "joined", error: null }],
      ["b2", { state: "joined", error: null }],
    ]);
    expect(h.welcomed).toEqual([]);
    expect(h.demoted).toEqual([]);
  });

  test("a private channel waiting for approval is joined but never welcomed, even as the home", async () => {
    const h = handler({ status: "pending_approval", home: true });
    await h.handle(
      claim({ type: "member_joined_channel", user: BOT, channel: "G1" }),
    );
    expect(h.recorded).toEqual([["b1", { state: "joined", error: null }]]);
    expect(h.welcomed).toEqual([]);
  });

  test("a channel bound as public that Slack now calls private waits for approval", async () => {
    const h = handler({
      status: "ready",
      channelKind: "public_channel",
      home: true,
    });
    await h.handle(
      claim({ type: "member_joined_channel", user: BOT, channel: "G1" }),
    );
    expect(h.demoted).toEqual(["b1"]);
    expect(h.recorded).toEqual([["b1", { state: "joined", error: null }]]);
    expect(h.welcomed).toEqual([]);
  });

  test("a read of the kind that fails, or an app with no token, binds nothing and the event fails", async () => {
    const unread = handler(null, { G2: new Error("slack down") });
    await expect(
      unread.handle(
        claim({ type: "member_joined_channel", user: BOT, channel: "G2" }),
      ),
    ).rejects.toThrow("slack down");
    const tokenless = handler(null, undefined, null);
    await expect(
      tokenless.handle(
        claim({ type: "member_joined_channel", user: BOT, channel: "G2" }),
      ),
    ).rejects.toThrow("no bot token");
    expect([...unread.invited, ...tokenless.invited]).toEqual([]);
    expect([...unread.recorded, ...tokenless.recorded]).toEqual([]);
  });

  test("someone else joining binds nothing; a message goes on", async () => {
    const h = handler({ home: true });
    await h.handle(
      claim({
        type: "member_joined_channel",
        user: "U0PERSON",
        channel: "G1",
      }),
    );
    await h.handle(claim({ type: "app_mention", user: "U0PERSON" }));
    expect(h.asked).toEqual([]);
    expect(h.invited).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.welcomed).toEqual([]);
    expect(h.passed).toEqual(["app_mention"]);
  });
});
