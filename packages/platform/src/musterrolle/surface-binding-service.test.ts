import { describe, expect, test } from "bun:test";
import type {
  AuthorizationDecision,
  SurfaceChannelKind,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import type {
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "../surface/ports/surface-binding-store.ts";
import { SessionServiceError } from "./service-errors.ts";
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
    listen: "free",
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
          listen: input.listen ?? "free",
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
    channelDeleted: async () => true,
    channelNotFound: async () => "unchanged",
    botRemovedFrom: async () => false,
    lastLeaveNoted: async () => null,
    recordJoin: async () => true,
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

describe("a refused binding names why in details.reason_code", () => {
  async function refusalOf(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof SessionServiceError) {
        return { code: error.code, details: error.details };
      }
      throw error;
    }
    return null;
  }
  const put = (bindings: ReturnType<typeof service>["bindings"]) =>
    bindings.putSlackBinding(caller, AGENT, {
      channel_id: "C0OPS",
      mode: "on",
      home: true,
    });

  test("each refusal a client words for itself carries its code", async () => {
    for (const [outcome, code, reason_code] of [
      ["not_installed", "SLACK_NOT_INSTALLED", "not_installed"],
      ["conflict", "REVISION_CONFLICT", "conflict"],
      ["pending_home", "BAD_REQUEST", "pending_home"],
    ] as const) {
      const { bindings } = service(async () => "public_channel", {
        set: async () => ({ outcome }),
      });
      expect(await refusalOf(put(bindings))).toEqual({
        code,
        details: { reason_code },
      });
    }
    const dm = service(async () => "dm");
    expect(await refusalOf(put(dm.bindings))).toEqual({
      code: "BAD_REQUEST",
      details: { reason_code: "dm_channel" },
    });
    const moved = service(async () => "public_channel", {
      approve: async () => ({ outcome: "conflict" }),
    });
    expect(
      await refusalOf(
        moved.bindings.approveSlackBinding(caller, AGENT, "binding-1", {
          revision: 1,
        }),
      ),
    ).toEqual({
      code: "REVISION_CONFLICT",
      details: { reason_code: "not_pending" },
    });
  });
});

describe("a Slack binding's listen setting (94S-2013)", () => {
  test("a save names the setting it changes, and one without it leaves the store's", async () => {
    const { bindings } = service(async () => "public_channel");
    const narrowed = await bindings.putSlackBinding(caller, AGENT, {
      channel_id: "C0OPS",
      mode: "on",
      listen: "mention",
      home: false,
    });
    const unnamed = await bindings.putSlackBinding(caller, AGENT, {
      channel_id: "C0OPS",
      mode: "on",
      home: false,
    });
    expect([
      narrowed.slack_binding.listen,
      unnamed.slack_binding.listen,
    ]).toEqual(["mention", "free"]);
  });
});

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

  test("a join Slack answers channel_not_found replies with the binding as stored, not the one it started from", async () => {
    const withJoin = createSurfaceBindingService({
      authorization: {
        authorize: async () =>
          ({ outcome: "allow", reason_code: "ok" }) as AuthorizationDecision,
      },
      store: {
        ...({} as SurfaceBindingStore),
        approve: async () => ({
          outcome: "resolved",
          receiptId: "receipt-2",
          binding: recordOf({ revision: 2, home: true }),
        }),
        findLiveSlackChannel: async () =>
          recordOf({ status: "gone", home: false, revision: 3 }),
      },
      channels: { kindOf: async () => "private_channel" },
      join: async () => ({
        state: "awaiting_invite",
        error: "channel_not_found",
      }),
    });
    const done = await withJoin.approveSlackBinding(
      caller,
      AGENT,
      "binding-1",
      { revision: 1 },
    );
    // Before: the reply merged Slack's answer into the binding it began
    // with, ready and home, while the store had made it gone.
    expect(done.slack_binding).toMatchObject({
      status: "gone",
      home: false,
      revision: 3,
    });
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
