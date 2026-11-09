import { describe, expect, test } from "bun:test";
import type {
  AuthorizationDecision,
  SurfaceChannelKind,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import type { SlackAppRecord } from "../ports/slack-app-store.ts";
import type {
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "../ports/surface-binding-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createSlackChannelKinds } from "./slack-bot-token.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import { createSurfaceBindingService } from "./surface-binding-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-000000000001";
const AGENT = "019a0000-0000-7000-8000-000000000002";
const caller = testCaller(WORKSPACE);

function recordOf(
  overrides: Partial<SurfaceBindingRecord> = {},
): SurfaceBindingRecord {
  return {
    id: "binding-1",
    workspaceId: WORKSPACE,
    agentId: AGENT,
    installationId: "installation-1",
    channelId: "G0PRIVATE",
    channelKind: "private_channel",
    mode: "on",
    ceiling: { actions: [], disclosure: "full" },
    home: false,
    memoryWritePolicy: "deny",
    status: "ready",
    approvedAt: null,
    membership: null,
    muted: false,
    revision: 1,
    createdAt: new Date(0),
    revokedAt: null,
    ...overrides,
  };
}

function service(
  kindOf: (channelId: string) => Promise<SurfaceChannelKind>,
  overrides: Partial<SurfaceBindingStore> = {},
) {
  const asked: string[] = [];
  const actions: string[] = [];
  const stored: SurfaceChannelKind[] = [];
  const store: SurfaceBindingStore = {
    async set(input) {
      stored.push(input.channelKind);
      return {
        outcome: "set",
        receiptId: "receipt-1",
        binding: {
          id: "binding-1",
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          installationId: "installation-1",
          channelId: input.channelId,
          channelKind: input.channelKind,
          mode: input.mode,
          ceiling: input.ceiling,
          home: input.home,
          memoryWritePolicy: "deny",
          status: "ready",
          approvedAt: null,
          membership: null,
          muted: false,
          revision: 1,
          createdAt: new Date(0),
          revokedAt: null,
        },
      };
    },
    findLiveSlackChannel: async () => null,
    findPendingApproval: async () => null,
    wasRejected: async () => false,
    requireApproval: async () => null,
    approve: async () => ({ outcome: "not_found" }),
    reject: async () => ({ outcome: "not_found" }),
    observeLifecycle: async () => true,
    botLeft: async () => true,
    recordJoin: async () => "recorded",
    ...overrides,
    list: async () => [],
    resolveSlackChannel: async () => null,
    ensureDmBinding: async () => null,
    ensureInvitedChannel: async () => null,
    setMembership: async () => {},
  };
  const bindings = createSurfaceBindingService({
    authorization: {
      authorize: async (request) => {
        actions.push(request.action);
        return { outcome: "allow", reason_code: "ok" } as AuthorizationDecision;
      },
    },
    store,
    channels: {
      async kindOf(_workspaceId, _agentId, channelId) {
        asked.push(channelId);
        return kindOf(channelId);
      },
    },
  });
  return { bindings, asked, stored, actions };
}

async function codeOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  return "ok";
}

describe("a Slack binding's channel kind is Slack's answer (94S-177)", () => {
  test("the kind Slack reports is stored, whatever the request said", async () => {
    const { bindings, asked, stored } = service(async () => "private_channel");
    const put = await bindings.putSlackBinding(caller, AGENT, {
      channel_id: "C0OPS",
      channel_kind: "public_channel",
      mode: "on",
      home: false,
    });
    expect(put.slack_binding.surface_kind).toBe("private_channel");
    expect(asked).toEqual(["C0OPS"]);
    expect(stored).toEqual(["private_channel"]);
  });

  test("the DM row asks Slack nothing; a channel Slack calls a DM is refused", async () => {
    const { bindings, asked, stored } = service(async () => "dm");
    await bindings.putSlackBinding(caller, AGENT, {
      channel_id: null,
      mode: "on",
      home: false,
    });
    expect(asked).toEqual([]);
    expect(
      await codeOf(
        bindings.putSlackBinding(caller, AGENT, {
          channel_id: "D0SOMEONE",
          mode: "on",
          home: false,
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(stored).toEqual(["dm"]);
  });
});

describe("channel kinds through the agent's own app", () => {
  const slackApp = { id: "slack-app-1" };
  const api = (channelKind: SlackBotApi["channelKind"]): SlackBotApi => ({
    channelKind,
    channelMembership: async () => {
      throw new Error("not asked");
    },
    joinChannel: async () => {
      throw new Error("not asked");
    },
    userInfo: async () => {
      throw new Error("not asked");
    },
    setStatus: async () => {},
    permalink: async () => {
      throw new Error("not asked");
    },
    listChannels: async () => {
      throw new Error("not asked");
    },
  });
  const kinds = (
    slack: SlackBotApi,
    token: string | null = "bot-credential",
    apps = true,
  ) =>
    createSlackChannelKinds({
      apps: apps
        ? { findForAgent: async () => slackApp as SlackAppRecord }
        : null,
      secrets: { get: async () => token },
      slack,
    });

  test("asks conversations.info with the app's bot token", async () => {
    const seen: string[] = [];
    const answer = await kinds(
      api(async (token, channelId) => {
        seen.push(`${token}:${channelId}`);
        return "public_channel";
      }),
    ).kindOf(WORKSPACE, AGENT, "C0OPS");
    expect(answer).toBe("public_channel");
    expect(seen).toEqual(["bot-credential:C0OPS"]);
  });

  test("no master key, app or token is not installed; Slack's refusal or absence has its own code", async () => {
    const fine = api(async () => "public_channel");
    for (const [slack, token, apps, code] of [
      [fine, "bot-credential", false, "SLACK_NOT_INSTALLED"],
      [fine, null, true, "SLACK_NOT_INSTALLED"],
      [
        api(async () => {
          throw new SlackApiError("conversations.info", "missing_scope", true);
        }),
        "bot-credential",
        true,
        "BAD_REQUEST",
      ],
      [
        api(async () => {
          throw new SlackApiError("conversations.info", "fetch_failed", false);
        }),
        "bot-credential",
        true,
        "BACKEND_UNAVAILABLE",
      ],
    ] as const) {
      expect(
        await codeOf(kinds(slack, token, apps).kindOf(WORKSPACE, AGENT, "C0")),
      ).toBe(code);
    }
  });

  test("a channel hidden from the bot is a private one waiting for the invite; a hidden DM is refused", async () => {
    const hidden = api(async () => {
      throw new SlackApiError("conversations.info", "channel_not_found", true);
    });
    const channelKinds = kinds(hidden, "bot-credential", true);
    expect(await channelKinds.kindOf(WORKSPACE, AGENT, "G0SECRET")).toBe(
      "private_channel",
    );
    expect(
      await codeOf(channelKinds.kindOf(WORKSPACE, AGENT, "D0SOMEONE")),
    ).toBe("BAD_REQUEST");
  });
});

describe("a private channel waits for an owner or admin", () => {
  test("a refused home on a channel that waits is a 400, and the save is not retried as one", async () => {
    const { bindings } = service(async () => "private_channel", {
      set: async () => ({ outcome: "pending_home" }),
    });
    expect(
      await codeOf(
        bindings.putSlackBinding(caller, AGENT, {
          channel_id: "G0PRIVATE",
          mode: "on",
          home: true,
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  test("a binding that waits reads as pending_approval with no approval time", async () => {
    const { bindings } = service(async () => "private_channel", {
      set: async () => ({
        outcome: "set",
        receiptId: "receipt-1",
        binding: recordOf({ status: "pending_approval" }),
      }),
    });
    const put = await bindings.putSlackBinding(caller, AGENT, {
      channel_id: "G0PRIVATE",
      mode: "on",
      home: false,
    });
    expect(put.slack_binding.status).toBe("pending_approval");
    expect(put.slack_binding.approved_at).toBeUndefined();
  });

  function approver(
    resolved: Awaited<ReturnType<SurfaceBindingStore["approve"]>>,
  ) {
    const seen: unknown[] = [];
    const joined: string[] = [];
    const welcomed: string[] = [];
    const actions: string[] = [];
    const withJoin = createSurfaceBindingService({
      authorization: {
        authorize: async (request) => {
          actions.push(request.action);
          return {
            outcome: "allow",
            reason_code: "ok",
          } as AuthorizationDecision;
        },
      },
      store: {
        ...({} as SurfaceBindingStore),
        approve: async (input) => {
          seen.push(input);
          return resolved;
        },
        reject: async (input) => {
          seen.push(input);
          return resolved;
        },
      },
      channels: { kindOf: async () => "private_channel" },
      join: async (binding) => {
        joined.push(binding.id);
        return { state: "joined", error: null };
      },
      welcome: {
        welcome: async (_workspace, agentId) => {
          welcomed.push(agentId);
          return { status: "enqueued", channelId: "G0PRIVATE" };
        },
      },
    });
    return { bindings: withJoin, seen, joined, welcomed, actions };
  }

  test("approving asks binding.approve, passes only owner and admin as approvers, and joins the channel", async () => {
    const t = approver({
      outcome: "resolved",
      receiptId: "receipt-2",
      binding: recordOf({
        revision: 2,
        approvedAt: new Date("2026-11-09T00:00:00Z"),
      }),
    });
    const done = await t.bindings.approveSlackBinding(
      caller,
      AGENT,
      "binding-1",
      { revision: 1 },
    );
    expect(t.actions).toEqual(["binding.approve"]);
    expect(t.seen).toMatchObject([
      {
        bindingId: "binding-1",
        revision: 1,
        approverRoles: ["owner", "admin"],
      },
    ]);
    expect(done.receipt_id).toBe("receipt-2");
    expect(done.slack_binding.status).toBe("ready");
    expect(done.slack_binding.approved_at).toBe("2026-11-09T00:00:00.000Z");
    expect(t.joined).toEqual(["binding-1"]);
  });

  test("rejecting does not join; the same decision again replays with no receipt", async () => {
    const rejected = approver({
      outcome: "resolved",
      receiptId: "receipt-3",
      binding: recordOf({ status: "revoked", revision: 2 }),
    });
    await rejected.bindings.rejectSlackBinding(caller, AGENT, "binding-1", {
      revision: 1,
    });
    expect(rejected.joined).toEqual([]);

    const replay = approver({
      outcome: "replayed",
      binding: recordOf({ status: "revoked", revision: 2 }),
    });
    const again = await replay.bindings.rejectSlackBinding(
      caller,
      AGENT,
      "binding-1",
      { revision: 1 },
    );
    expect(again.receipt_id).toBeNull();
    expect(replay.joined).toEqual([]);
  });

  test("a binding that moved on, a missing one and a demoted caller answer 409, 404 and 403", async () => {
    for (const [outcome, code] of [
      ["conflict", "REVISION_CONFLICT"],
      ["not_found", "NOT_FOUND"],
      ["outranked", "FORBIDDEN"],
      ["actor_inactive", "FORBIDDEN"],
    ] as const) {
      const t = approver({ outcome });
      expect(
        await codeOf(
          t.bindings.approveSlackBinding(caller, AGENT, "binding-1", {
            revision: 1,
          }),
        ),
      ).toBe(code);
    }
  });
});
