import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentRelease,
  DEFAULT_SURFACE_CEILING,
} from "@werft-ai/contracts";
import type {
  AgentStore,
  SlackInstalled,
  SlackOutboxEntry,
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "@werft-ai/platform";
import {
  SlackApiError,
  type SlackBotApi,
  type SlackChannelMembership,
} from "@werft-ai/platform";
import { createSlackChannelJoiner } from "./slack-channel-join.ts";
import { slackOutboxText } from "./slack-outbox.ts";
import {
  createSlackWelcome,
  deploymentWelcomeKey,
  slackWelcomeText,
} from "./slack-welcome.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000c1";
const SLACK_APP = "019a0000-0000-7000-8000-0000000000d1";
const HOME = "019a0000-0000-7000-8000-00000000b001";
const OTHER = "019a0000-0000-7000-8000-00000000b002";

const releaseAt = (id: string, created_at: string) =>
  ({ id, created_at }) as AgentRelease;
const R1 = releaseAt("rel_1", "2026-10-20T00:00:00.000Z");
const R2 = releaseAt("rel_2", "2026-10-21T00:00:00.000Z");

function binding(
  id: string,
  channelId: string,
  extra: Partial<SurfaceBindingRecord> = {},
): SurfaceBindingRecord {
  return {
    id,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    installationId: INSTALLATION,
    channelId,
    channelKind: "public_channel",
    mode: "on",
    ceiling: DEFAULT_SURFACE_CEILING as SurfaceBindingRecord["ceiling"],
    home: false,
    memoryWritePolicy: "deny",
    status: "ready",
    approvedAt: null,
    membership: null,
    muted: false,
    revision: 1,
    createdAt: new Date(0),
    revokedAt: null,
    ...extra,
  };
}

/** A Slack whose channels say whether the bot is in them. */
function fakeSlack(channels: Record<string, Partial<SlackChannelMembership>>) {
  const calls: string[] = [];
  const failures = new Map<string, string>();
  const hooks = { onInfo: () => {}, onJoin: () => {} };
  const slack: Pick<SlackBotApi, "channelMembership" | "joinChannel"> = {
    async channelMembership(_token, channelId) {
      calls.push(`info:${channelId}`);
      const failure = failures.get("conversations.info");
      if (failure) throw new SlackApiError("conversations.info", failure, true);
      const answer = {
        kind: "public_channel" as const,
        isMember: false,
        isArchived: false,
        ...channels[channelId],
      };
      hooks.onInfo();
      return answer;
    },
    async joinChannel(_token, channelId) {
      calls.push(`join:${channelId}`);
      hooks.onJoin();
      const failure = failures.get("conversations.join");
      if (failure) throw new SlackApiError("conversations.join", failure, true);
      channels[channelId] = { ...channels[channelId], isMember: true };
    },
  };
  return { slack, calls, failures, hooks };
}

function world(
  rows: SurfaceBindingRecord[],
  channels: Record<string, Partial<SlackChannelMembership>>,
) {
  const outbox = new Map<string, SlackOutboxEntry>();
  const releases = new Map([R1, R2].map((release) => [release.id, release]));
  let active = R1.id;
  const bindings: Pick<SurfaceBindingStore, "list" | "setMembership"> = {
    list: async () => [...rows].sort((a, b) => Number(b.home) - Number(a.home)),
    async setMembership(id, membership, expected) {
      const row = rows.find((candidate) => candidate.id === id);
      const held = row?.membership ?? null;
      if (
        expected !== undefined &&
        (held?.state !== expected?.state || held?.error !== expected?.error)
      ) {
        return;
      }
      if (row) row.membership = membership;
    },
  };
  const approved = new Set<string>();
  const createdAt = (id: string) =>
    Date.parse(releases.get(id)?.created_at ?? "");
  const agents: Pick<AgentStore, "get" | "releaseSuperseded"> = {
    get: async () =>
      ({
        agent: { name: "재무 분석가 <!here>", active_release_id: active },
      }) as AgentDetail,
    releaseSuperseded: async (_workspace, _agent, id) =>
      [...approved].some((other) => createdAt(other) > createdAt(id)),
  };
  const fake = fakeSlack(channels);
  const logged: unknown[] = [];
  let onApp = () => {};
  const welcome = createSlackWelcome({
    agents,
    bindings,
    apps: {
      findForAgent: async () => {
        onApp();
        return { id: SLACK_APP } as never;
      },
    },
    outbox: {
      async enqueue(entry, whileHome) {
        const home = rows.find((row) => row.id === whileHome?.bindingId);
        if (whileHome && (!home?.home || active !== whileHome.releaseId)) {
          return "not_home";
        }
        if (outbox.has(entry.dedupeKey)) return "duplicate";
        outbox.set(entry.dedupeKey, entry);
        return "enqueued";
      },
    },
    join: createSlackChannelJoiner({
      bindings,
      slack: fake.slack,
      botToken: async () => "bot-credential",
    }),
    logger: {
      info: (message, fields) => logged.push({ message, ...fields }),
      warn: (message, fields) => logged.push({ message, ...fields }),
    },
  });
  return {
    welcome,
    outbox,
    rows,
    fake,
    logged,
    /** Runs while the welcome looks up the app, past every re-read. */
    beforeEnqueue: (hook: () => void) => {
      onApp = hook;
    },
    /** What the store's activation does, then the welcome it triggers. */
    activate: (id: string) => {
      active = id;
      approved.add(id);
      return welcome.activated(WORKSPACE, AGENT, id);
    },
  };
}

const installed = {
  workspaceId: WORKSPACE,
  agentId: AGENT,
} as SlackInstalled;

async function settled(until: () => boolean) {
  for (let tick = 0; tick < 50 && !until(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("deployment welcome", () => {
  test("one row per home: same release, a new release, rollback and home moved back add none", async () => {
    const home = binding(HOME, "C0HOME", {
      home: true,
      membership: { state: "joined", error: null },
    });
    const other = binding(OTHER, "C0OTHER", {
      membership: { state: "joined", error: null },
    });
    const w = world([home, other], {});

    expect(await w.activate(R1.id)).toEqual({
      status: "enqueued",
      channelId: "C0HOME",
    });
    expect(w.outbox.size).toBe(1);
    // The same definition again is the same release.
    expect(await w.activate(R1.id)).toEqual({
      status: "duplicate",
      channelId: "C0HOME",
    });
    expect(w.outbox.size).toBe(1);
    // A changed definition is a new release; the channel heard it already.
    expect(await w.activate(R2.id)).toEqual({
      status: "duplicate",
      channelId: "C0HOME",
    });
    expect(w.outbox.size).toBe(1);
    expect(await w.activate(R1.id)).toEqual({ status: "rollback" });
    expect(w.outbox.size).toBe(1);

    // The home moves: the new channel hears once.
    await w.activate(R2.id);
    home.home = false;
    other.home = true;
    await w.welcome.welcome(WORKSPACE, AGENT, { ask: false });
    await w.welcome.welcome(WORKSPACE, AGENT, { ask: false });
    expect(w.outbox.size).toBe(2);
    // And moving it back finds the first channel welcomed already.
    other.home = false;
    home.home = true;
    expect(await w.welcome.welcome(WORKSPACE, AGENT, { ask: false })).toEqual({
      status: "duplicate",
      channelId: "C0HOME",
    });

    expect([...w.outbox.keys()]).toEqual([
      deploymentWelcomeKey(AGENT, HOME),
      deploymentWelcomeKey(AGENT, OTHER),
    ]);
    const [first] = w.outbox.values();
    expect(first).toMatchObject({
      kind: "welcome",
      channelId: "C0HOME",
      threadTs: "",
      slackUserId: null,
      sessionId: null,
      slackAppId: SLACK_APP,
      installationId: INSTALLATION,
    });
    // The name goes out escaped: it notifies no one.
    expect(slackOutboxText(first?.body ?? { text: "" })).toBe(
      slackWelcomeText("재무 분석가 &lt;!here&gt;"),
    );
    expect(slackOutboxText(first?.body ?? { text: "" })).not.toContain("<!");
  });

  test("a home not checked yet is asked after the activation returns: joined, then welcomed", async () => {
    const w = world([binding(HOME, "C0HOME", { home: true })], {});
    expect(await w.activate(R1.id)).toEqual({
      status: "unknown_membership",
      channelId: "C0HOME",
    });
    expect(w.outbox.size).toBe(0);
    await settled(() => w.outbox.size > 0);
    expect(w.fake.calls).toEqual(["info:C0HOME", "join:C0HOME"]);
    expect(w.rows[0]?.membership).toEqual({ state: "joined", error: null });
    expect(w.outbox.size).toBe(1);
  });

  test("a rollback stays silent on later paths: the invite and Finalize after it add none", async () => {
    const channels: Record<string, Partial<SlackChannelMembership>> = {
      G0HOME: { kind: "private_channel" },
    };
    const w = world([binding(HOME, "G0HOME", { home: true })], channels);
    await w.activate(R1.id);
    await w.activate(R2.id);
    expect(await w.activate(R1.id)).toEqual({ status: "rollback" });

    channels.G0HOME = { kind: "private_channel", isMember: true };
    await w.welcome.finalize(installed);
    expect(await w.welcome.welcome(WORKSPACE, AGENT, { ask: true })).toEqual({
      status: "rollback",
    });
    await settled(() => false);
    expect(w.outbox.size).toBe(0);
  });

  test("a home moved while Slack answered is not the one welcomed", async () => {
    const home = binding(HOME, "C0HOME", { home: true });
    const other = binding(OTHER, "C0OTHER");
    const w = world([home, other], {});
    w.fake.hooks.onJoin = () => {
      home.home = false;
      other.home = true;
    };
    expect(await w.welcome.welcome(WORKSPACE, AGENT, { ask: true })).toEqual({
      status: "no_home",
    });
    expect(w.fake.calls).toEqual(["info:C0HOME", "join:C0HOME"]);
    expect(w.outbox.size).toBe(0);
  });

  test("a home moved just before the insert is not welcomed: the insert checks it", async () => {
    const joined = { state: "joined", error: null } as const;
    const home = binding(HOME, "C0HOME", { home: true, membership: joined });
    const other = binding(OTHER, "C0OTHER", { membership: joined });
    const w = world([home, other], {});
    w.beforeEnqueue(() => {
      home.home = false;
      other.home = true;
    });
    expect(await w.welcome.welcome(WORKSPACE, AGENT, { ask: false })).toEqual({
      status: "no_home",
    });
    expect(w.outbox.size).toBe(0);
  });

  test("an answer from before the invite does not undo it: the home is welcomed", async () => {
    const home = binding(HOME, "G0HOME", { home: true });
    const w = world([home], { G0HOME: { kind: "private_channel" } });
    // The invite is recorded while Slack's older answer is on its way.
    w.fake.hooks.onInfo = () => {
      home.membership = { state: "joined", error: null };
    };
    await w.activate(R1.id);
    await settled(() => w.outbox.size > 0);
    expect(home.membership).toEqual({ state: "joined", error: null });
    expect(w.outbox.size).toBe(1);
  });

  test("a private home waits for the invite with no row; Finalize after it sends once, then duplicate", async () => {
    const channels: Record<string, Partial<SlackChannelMembership>> = {
      G0HOME: { kind: "private_channel" },
    };
    const w = world([binding(HOME, "G0HOME", { home: true })], channels);

    expect(await w.welcome.finalize(installed)).toEqual({
      finalized: true,
      warnings: [{ code: "awaiting_invite", channel_id: "G0HOME" }],
    });
    expect(w.outbox.size).toBe(0);
    expect(w.fake.calls).toEqual(["info:G0HOME"]);

    channels.G0HOME = { kind: "private_channel", isMember: true };
    expect(await w.welcome.finalize(installed)).toEqual({
      finalized: true,
      warnings: [],
    });
    expect(w.outbox.size).toBe(1);
    expect(await w.welcome.welcome(WORKSPACE, AGENT, { ask: true })).toEqual({
      status: "duplicate",
      channelId: "G0HOME",
    });
    expect(w.outbox.size).toBe(1);
  });

  test("a membership lookup refused for scope is config_error with Slack's code, not a missing invite", async () => {
    const w = world([binding(HOME, "C0HOME", { home: true })], {});
    w.fake.failures.set("conversations.info", "missing_scope");
    expect(await w.welcome.welcome(WORKSPACE, AGENT, { ask: true })).toEqual({
      status: "config_error",
      channelId: "C0HOME",
      error: "missing_scope",
    });
    expect(await w.welcome.finalize(installed)).toEqual({
      finalized: true,
      warnings: [
        { code: "config_error", channel_id: "C0HOME", error: "missing_scope" },
      ],
    });
    expect(w.outbox.size).toBe(0);
  });

  test("a home waiting for approval hears nothing, and nothing is queued for it", async () => {
    const waiting = world(
      [
        binding(HOME, "G0HOME", {
          home: true,
          channelKind: "private_channel",
          status: "pending_approval",
          membership: { state: "joined", error: null },
        }),
      ],
      {},
    );
    expect(
      await waiting.welcome.welcome(WORKSPACE, AGENT, { ask: true }),
    ).toEqual({ status: "no_home" });
    expect(waiting.outbox.size).toBe(0);
  });

  test("a home that is off, the DM row or no home at all is not welcomed", async () => {
    const off = world(
      [
        binding(HOME, "C0HOME", {
          home: true,
          mode: "off",
          membership: { state: "joined", error: null },
        }),
      ],
      {},
    );
    expect(await off.welcome.welcome(WORKSPACE, AGENT, { ask: true })).toEqual({
      status: "no_home",
    });
    const none = world([binding(OTHER, "C0OTHER")], {});
    expect(await none.activate(R1.id)).toEqual({
      status: "no_home",
    });
    expect(none.fake.calls).toEqual([]);
  });

  test("an outbox that throws fails nothing: the activation hears null and the log says why", async () => {
    const w = world(
      [
        binding(HOME, "C0HOME", {
          home: true,
          membership: { state: "joined", error: null },
        }),
      ],
      {},
    );
    const broken = createSlackWelcome({
      agents: {
        get: async () => {
          throw new Error("database gone");
        },
        releaseSuperseded: async () => false,
      },
      bindings: { list: async () => w.rows },
      apps: { findForAgent: async () => null },
      outbox: { enqueue: async () => "enqueued" },
      join: null,
      logger: {
        info: () => {},
        warn: (message, fields) => w.logged.push({ message, ...fields }),
      },
    });
    expect(await broken.activated(WORKSPACE, AGENT, R1.id)).toBeNull();
    expect(w.logged).toEqual([
      {
        message: "Deployment welcome failed",
        agent_id: AGENT,
        release_id: R1.id,
        error: "database gone",
      },
    ]);
  });
});
