import { describe, expect, test } from "bun:test";
import type { SlackInboundClaim } from "@werft-ai/platform";
import {
  createSlackChannelLifecycleHandler,
  lifecycleChannelOf,
} from "./slack-channel-lifecycle.ts";
import { createSlackMemberCacheInvalidator } from "./slack-channel-members.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000c1";

const resolved = {
  resolveSlackEvent: async () => ({
    status: "resolved",
    workspaceId: WORKSPACE,
    agentId: AGENT,
    installationId: INSTALLATION,
    identityId: "identity-1",
    botUserId: "U0BOT",
  }),
} as never;

const claim = (event: Record<string, unknown>, eventTime: Date | null = null) =>
  ({
    id: "e1",
    workspaceId: WORKSPACE,
    agentId: AGENT,
    appId: "A1",
    teamId: "T1",
    eventType: String(event.type),
    eventTime,
    payload: { event },
  }) as unknown as SlackInboundClaim;

function handler(agents = resolved) {
  const calls: unknown[][] = [];
  const passed: string[] = [];
  const handle = createSlackChannelLifecycleHandler({
    agents,
    bindings: {
      channelDeleted: async (installation, channelId, at) => {
        calls.push(["binding gone", installation, channelId, at]);
        return true;
      },
    },
    conversations: {
      recordChannelState: async (key, state, at) => {
        calls.push(["state", key.teamId, key.channelId, state, at]);
        return true;
      },
      recordChannelName: async (key, name, at) => {
        calls.push(["name", key.teamId, key.channelId, name, at]);
        return true;
      },
    },
    next: async (claim) => {
      passed.push(claim.eventType);
    },
  });
  return { handle, calls, passed };
}

const TS = "1700000100.000001";
const US = 1_700_000_100_000_001;

describe("channel lifecycle handler", () => {
  test.each([
    ["channel_archive", "C1", "archived"],
    ["group_archive", "G1", "archived"],
    ["channel_unarchive", "C1", "unarchived"],
    ["group_unarchive", "G1", "unarchived"],
  ] as const)(
    "%s notes the conversation's state and leaves the binding",
    async (type, channel, state) => {
      const h = handler();
      await h.handle(claim({ type, channel, user: "U0P", event_ts: TS }));
      expect(h.calls).toEqual([["state", "T1", channel, state, US]]);
      expect(h.passed).toEqual([]);
    },
  );

  test.each([
    ["channel_deleted", "C1"],
    ["group_deleted", "G1"],
  ] as const)(
    "%s makes the binding gone and the conversation deleted",
    async (type, channel) => {
      const h = handler();
      await h.handle(claim({ type, channel, event_ts: TS }));
      expect(h.calls).toEqual([
        ["binding gone", INSTALLATION, channel, US],
        ["state", "T1", channel, "deleted", US],
      ]);
    },
  );

  test.each([
    ["channel_rename", "C1"],
    ["group_rename", "G1"],
  ] as const)("%s notes the new name", async (type, id) => {
    const h = handler();
    await h.handle(
      claim({
        type,
        channel: { id, name: "launch", created: 1 },
        event_ts: TS,
      }),
    );
    expect(h.calls).toEqual([["name", "T1", id, "launch", US]]);
  });

  test("without event_ts the envelope's time orders it; with neither it has no time", async () => {
    const h = handler();
    await h.handle(
      claim(
        { type: "channel_archive", channel: "C1" },
        new Date(1_700_000_200_000),
      ),
    );
    await h.handle(claim({ type: "channel_archive", channel: "C1" }));
    expect(h.calls).toEqual([
      ["state", "T1", "C1", "archived", 1_700_000_200_000_000],
      ["state", "T1", "C1", "archived", null],
    ]);
  });

  test("other events go on; a malformed lifecycle event or another agent's app changes nothing", async () => {
    const h = handler();
    await h.handle(claim({ type: "group_left", channel: "G1" }));
    await h.handle(claim({ type: "channel_deleted" }));
    await h.handle(claim({ type: "channel_rename", channel: "C1" }));
    expect(h.passed).toEqual(["group_left"]);
    const dropped = handler({
      resolveSlackEvent: async () => ({
        status: "dropped",
        reason: "agent_mismatch",
      }),
    } as never);
    await dropped.handle(claim({ type: "channel_deleted", channel: "C1" }));
    expect(dropped.calls).toEqual([]);
    expect(dropped.passed).toEqual([]);
  });
});

describe("member cache on lifecycle events", () => {
  test("every lifecycle event voids its channel's member list, then goes on", async () => {
    const forgotten: [string, string][] = [];
    const passed: string[] = [];
    const handle = createSlackMemberCacheInvalidator({
      agents: resolved,
      members: {
        forget: async (installation, channelId) => {
          forgotten.push([installation, channelId]);
        },
      },
      next: async (claim) => {
        passed.push(claim.eventType);
      },
    });
    const events = [
      { type: "channel_archive", channel: "C1" },
      { type: "group_unarchive", channel: "G2" },
      { type: "group_rename", channel: { id: "G3", name: "x" } },
      { type: "channel_deleted", channel: "C4" },
    ];
    for (const event of events) await handle(claim(event));
    expect(forgotten).toEqual([
      [INSTALLATION, "C1"],
      [INSTALLATION, "G2"],
      [INSTALLATION, "G3"],
      [INSTALLATION, "C4"],
    ]);
    expect(passed).toEqual(events.map((event) => event.type));
    expect(lifecycleChannelOf({ type: "message", channel: "C1" })).toBeNull();
  });
});
