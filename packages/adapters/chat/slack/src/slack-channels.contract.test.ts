import { afterAll, beforeAll, describe } from "bun:test";
import {
  DEFAULT_SURFACE_CEILING,
  type SurfaceChannelKind,
  type SurfaceMembership,
} from "@werft-ai/contracts";
import type { SlackAppRecord, SurfaceBindingRecord } from "@werft-ai/platform";
import type { ChannelJoinSubject } from "@werft-ai/platform/testing/channel-joinable";
import { describeChannelJoinableContract } from "@werft-ai/platform/testing/channel-joinable";
import type { ChannelKindSubject } from "@werft-ai/platform/testing/channel-kind-readable";
import { describeChannelKindReadableContract } from "@werft-ai/platform/testing/channel-kind-readable";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import { createSlackChannelKinds } from "./slack-bot-token.ts";
import { createSlackChannelJoiner } from "./slack-channel-join.ts";
import {
  createSlackBotApi,
  SlackApiError,
  type SlackBotApi,
} from "./slack-config-api.ts";

// `ChannelKindReadable` and `ChannelJoinable` against the Slack Web API client
// over HTTP (the testkit's fake Slack) and against a scripted in-memory
// `SlackBotApi`: the two ways the adapter hears what Slack says about a
// channel.
const WORKSPACE = "019a0000-0000-7000-8000-000000000001";
const AGENT = "019a0000-0000-7000-8000-000000000002";
const TOKEN = "xoxb-contract-token";
const APP_ID = "A0CONTRACT";

/** One way to make Slack answer about channels. */
type Slack = {
  api: SlackBotApi;
  channelOf(kind: SurfaceChannelKind): string;
  channelFor(condition: Parameters<ChannelJoinSubject["binding"]>[0]): string;
  script(answer: "hidden" | "refused" | "no_answer"): void;
  silent(): void;
  joins(): number;
};

const fakeServer = startFakeSlackApi();
beforeAll(() => {
  fakeServer.apps.set(APP_ID, {
    appId: APP_ID,
    clientId: "client",
    clientSecret: "secret",
    signingSecret: "signing",
    manifest: null,
    botTokens: [TOKEN],
  });
});
afterAll(() => fakeServer.stop());

function overFakeSlack(): Slack {
  fakeServer.failures.clear();
  let joins = 0;
  let mode: "live" | "dead" = "live";
  const live = createSlackBotApi({ apiUrl: fakeServer.url });
  const dead = createSlackBotApi({
    apiUrl: "http://127.0.0.1:9/api",
    timeoutMs: 1000,
  });
  const through = () => (mode === "live" ? live : dead);
  const api: SlackBotApi = {
    ...live,
    channelKind: (...args) => through().channelKind(...args),
    channelMembership: (...args) => through().channelMembership(...args),
    joinChannel: async (...args) => {
      joins += 1;
      return through().joinChannel(...args);
    },
  };
  const [publicOut, publicIn, privateOut, archived] = fakeServer.seedChannels([
    { name: "out" },
    { name: "in", members: [APP_ID] },
    { name: "secret", isPrivate: true },
    { name: "old", isArchived: true },
  ]);
  return {
    api,
    channelOf: (kind) =>
      kind === "dm"
        ? "D0CONTRACT"
        : kind === "private_channel"
          ? (privateOut?.id ?? "")
          : (publicIn?.id ?? ""),
    channelFor: (condition) =>
      ({
        public_bot_in: publicIn?.id,
        public_bot_out: publicOut?.id,
        private_bot_out: privateOut?.id,
        archived: archived?.id,
      })[condition] ?? "",
    script(answer) {
      if (answer === "hidden") {
        fakeServer.failures.set("conversations.info", "channel_not_found");
      }
      if (answer === "refused") {
        fakeServer.failures.set("conversations.info", "missing_scope");
      }
      if (answer === "no_answer") mode = "dead";
    },
    silent: () => {
      mode = "dead";
    },
    joins: () => joins,
  };
}

function overScriptedApi(): Slack {
  let answer: "live" | "hidden" | "refused" | "no_answer" = "live";
  let joins = 0;
  const joined = new Set<string>(["C0IN"]);
  const kinds: Record<string, SurfaceChannelKind> = {
    C0IN: "public_channel",
    C0OUT: "public_channel",
    G0SECRET: "private_channel",
    C0OLD: "public_channel",
    D0CONTRACT: "dm",
  };
  const fail = () => {
    if (answer === "hidden") {
      throw new SlackApiError("conversations.info", "channel_not_found", true);
    }
    if (answer === "refused") {
      throw new SlackApiError("conversations.info", "missing_scope", true);
    }
    if (answer === "no_answer") {
      throw new SlackApiError("conversations.info", "fetch_failed", false);
    }
  };
  const nothing = async (): Promise<never> => {
    throw new Error("not asked");
  };
  const api: SlackBotApi = {
    channelKind: async (_token, channelId) => {
      fail();
      return kinds[channelId] ?? "public_channel";
    },
    channelMembership: async (_token, channelId) => {
      fail();
      return {
        kind: kinds[channelId] ?? "public_channel",
        isMember: joined.has(channelId),
        isArchived: channelId === "C0OLD",
      };
    },
    joinChannel: async (_token, channelId) => {
      joins += 1;
      joined.add(channelId);
    },
    userInfo: nothing,
    setStatus: async () => {},
    permalink: nothing,
    listChannels: nothing,
  };
  return {
    api,
    channelOf: (kind) =>
      kind === "dm"
        ? "D0CONTRACT"
        : kind === "private_channel"
          ? "G0SECRET"
          : "C0IN",
    channelFor: (condition) =>
      ({
        public_bot_in: "C0IN",
        public_bot_out: "C0OUT",
        private_bot_out: "G0SECRET",
        archived: "C0OLD",
      })[condition],
    script(next) {
      answer = next;
    },
    silent() {
      answer = "no_answer";
    },
    joins: () => joins,
  };
}

function kindSubject(slack: Slack): ChannelKindSubject {
  let installed = true;
  return {
    channels: createSlackChannelKinds({
      apps: {
        findForAgent: async () =>
          installed ? ({ id: "slack-app-1" } as SlackAppRecord) : null,
      },
      secrets: { get: async () => TOKEN },
      slack: slack.api,
    }),
    workspaceId: WORKSPACE,
    agentId: AGENT,
    channelOf: slack.channelOf,
    script: slack.script,
    withoutInstall() {
      installed = false;
    },
  };
}

const binding = (
  channelId: string | null,
  extra: Partial<SurfaceBindingRecord> = {},
): SurfaceBindingRecord => ({
  id: `binding-${channelId ?? "dm"}`,
  workspaceId: WORKSPACE,
  agentId: AGENT,
  installationId: "installation-1",
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
});

function joinSubject(slack: Slack): ChannelJoinSubject {
  let token: string | null = TOKEN;
  const recorded: { bindingId: string; membership: SurfaceMembership }[] = [];
  return {
    join: createSlackChannelJoiner({
      bindings: {
        setMembership: async (bindingId, membership) => {
          recorded.push({ bindingId, membership });
        },
      },
      slack: slack.api,
      botToken: async () => token,
    }),
    binding: (condition) => binding(slack.channelFor(condition)),
    dmBinding: () => binding(null, { channelKind: "dm" }),
    offBinding: () =>
      binding(slack.channelFor("public_bot_out"), { mode: "off" }),
    withoutToken() {
      token = null;
    },
    goSilent: slack.silent,
    joinsMade: slack.joins,
    recorded: () => recorded,
  };
}

describe("over the fake Slack Web API", () => {
  describeChannelKindReadableContract(async () => kindSubject(overFakeSlack()));
  describeChannelJoinableContract(async () => joinSubject(overFakeSlack()));
});

describe("over a scripted in-memory Slack", () => {
  describeChannelKindReadableContract(async () =>
    kindSubject(overScriptedApi()),
  );
  describeChannelJoinableContract(async () => joinSubject(overScriptedApi()));
});
