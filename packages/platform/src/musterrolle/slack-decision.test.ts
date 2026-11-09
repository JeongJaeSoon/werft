import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AuthorizationReason,
  authorizationDecisionSchema,
  type SlackNoticeMessage,
  type SlackSurfaceAction,
  type SlackUser,
  type SurfaceCeiling,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { DecisionLog } from "../ports/decision-log.ts";
import type { LinkedSubject } from "../ports/linked-account-store.ts";
import type { SurfaceBindingRecord } from "../ports/surface-binding-store.ts";
import { createAuthorizationPolicy, type IdentityReader } from "./policy.ts";
import { authorizeSlackInput, type SlackInput } from "./slack-decision.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000a2";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000a3";
const BINDING = "019a0000-0000-7000-8000-0000000000a4";
const SESSION = "019a0000-0000-7000-8000-0000000000a5";
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000a6";
const OTHER_SESSION = "019a0000-0000-7000-8000-0000000000a7";
// Shared with its creator, userId(1), alone.
const PRIVATE_SESSION = "019a0000-0000-7000-8000-0000000000a8";
const CHANNEL = "C0OPS";
const APP = "A0RESEARCH";
const TEAM = "T0OPS";
const CONNECT_URL = "https://app.example/settings/accounts";

type Account = {
  id: string;
  userId: string;
  role: WorkspaceRole;
  revision: number;
  status: "active" | "stale" | "offboarded";
};

// Slack user id → the account it links to, as the stores would read it now.
let accounts: Map<string, Account>;
let guestsEnabled: boolean;
let outsideAccess: "use" | "view" | "none";
let recorded: Parameters<DecisionLog["record"]>[0][];
let recordFails: boolean;
// Channel id (null for the DM row) → the live binding the store resolves.
let stored: Map<string | null, SurfaceBindingRecord>;

const userId = (n: number) =>
  `019a0000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`;

function link(slackUser: string, n: number, role: WorkspaceRole = "member") {
  accounts.set(slackUser, {
    id: `019a0000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
    userId: userId(n),
    role,
    revision: 1,
    status: "active",
  });
}

beforeEach(() => {
  accounts = new Map();
  guestsEnabled = false;
  outsideAccess = "use";
  recorded = [];
  recordFails = false;
  stored = new Map();
});

// What the database reader does with a linked account: read it again by
// id and revision, then judge the person behind it with their current role.
const identity: IdentityReader = {
  async reread(subject) {
    const ref = subject.linked_account;
    const account = [...accounts.values()].find((a) => a.id === ref?.id);
    if (!ref || !account || account.userId !== subject.actor_user_id) {
      return { status: "unlinked" };
    }
    if (account.status === "offboarded") return { status: "disabled" };
    if (account.status === "stale" || account.revision !== ref.revision) {
      return { status: "stale_link" };
    }
    return {
      status: "ok",
      principal: {
        kind: "user",
        id: account.userId,
        workspace_id: WORKSPACE,
        role: account.role,
        scopes: [...scopesForRole(account.role)],
      },
    };
  },
};

const deps = () => ({
  authorization: createAuthorizationPolicy({
    identity,
    slackGuests: { enabled: async () => guestsEnabled },
    outsideAgents: { access: async () => outsideAccess },
    credentials: { unboundRefs: async () => [] },
    sessions: {
      async visibleTo(_ownerId, sessionId, viewer) {
        return sessionId !== PRIVATE_SESSION || viewer.userId === userId(1);
      },
      // B (user 1) made every session here.
      async originOf() {
        return { creatorUserId: userId(1), creatorApiKeyId: null };
      },
    },
    agents: {
      async agentOf(_workspaceId, resource) {
        if (resource.kind === "agent") return resource.id;
        if (resource.id === OTHER_SESSION) return OTHER_AGENT;
        return [SESSION, PRIVATE_SESSION, BINDING].includes(resource.id)
          ? AGENT
          : null;
      },
      async agentOfRelease(_workspaceId, releaseId) {
        if (releaseId === "rel-other") return OTHER_AGENT;
        return releaseId === "rel-1" ? AGENT : null;
      },
      async isAdmin() {
        return false;
      },
    },
    decisions: {
      async record(entry) {
        if (recordFails) throw new Error("authz_decisions unavailable");
        recorded.push(entry);
      },
    },
  }),
  agents: {
    async resolveSlackEvent(key: { appId: string; teamId: string }) {
      return key.appId === APP && key.teamId === TEAM
        ? {
            status: "resolved" as const,
            workspaceId: WORKSPACE,
            agentId: AGENT,
            identity: { id: "identity-1", revision: 1 },
            installationId: INSTALLATION,
            botUserId: "U0BOT",
            credentialRef: "slack_bot_token",
          }
        : { status: "dropped" as const, reason: "not_installed" as const };
    },
  },
  bindings: {
    async resolveSlackChannel(
      installationId: string,
      channelId: string | null,
    ) {
      const binding =
        installationId === INSTALLATION ? stored.get(channelId) : undefined;
      return binding?.status === "ready" ? binding : null;
    },
    async findPendingApproval(installationId: string, channelId: string) {
      const binding =
        installationId === INSTALLATION ? stored.get(channelId) : undefined;
      return binding?.status === "pending_approval"
        ? { id: binding.id, revision: binding.revision }
        : null;
    },
    async findLiveSlackChannel(installationId: string, channelId: string) {
      return (
        (installationId === INSTALLATION ? stored.get(channelId) : undefined) ??
        null
      );
    },
  },
  links: {
    async resolveLinkedSubject(ref: {
      externalUserId: string;
    }): Promise<LinkedSubject> {
      const account = accounts.get(ref.externalUserId);
      if (!account) return { status: "unlinked" };
      const linkedAccount = { id: account.id, revision: account.revision };
      const who = { userId: account.userId, workspaceId: WORKSPACE };
      if (account.status === "stale") {
        return { status: "stale", linkedAccount, ...who };
      }
      if (account.status === "offboarded") {
        return { status: "revoked", linkedAccount, ...who };
      }
      return { status: "linked", linkedAccount, ...who, role: account.role };
    },
  },
});

const everything: SurfaceCeiling = {
  actions: [
    "session.read",
    "session.submit",
    "session.control",
    "session.approve",
  ],
  disclosure: "full",
};

const slackUser = (id: string, extra: Partial<SlackUser> = {}): SlackUser => ({
  id,
  team_id: TEAM,
  ...extra,
});

// The channel's binding as the store holds it; `null` stores none.
type Binding = Partial<
  Pick<
    SurfaceBindingRecord,
    "channelKind" | "ceiling" | "mode" | "agentId" | "status"
  >
>;

function bind(channelId: string | null, binding: Binding) {
  stored.set(channelId, {
    id: BINDING,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    installationId: INSTALLATION,
    channelId,
    channelKind: channelId === null ? "dm" : "public_channel",
    mode: "on",
    ceiling: everything,
    home: false,
    memoryWritePolicy: "deny",
    status: "ready",
    approvedAt: null,
    membership: null,
    muted: false,
    revision: 1,
    createdAt: new Date(0),
    revokedAt: null,
    ...binding,
  });
}

function input(
  user: SlackUser,
  { binding, ...overrides }: Partial<SlackInput> & { binding?: Binding } = {},
): SlackInput {
  bind(CHANNEL, binding ?? {});
  return {
    event: { appId: APP, teamId: TEAM, agentId: AGENT },
    user,
    action: "session.submit",
    channel: { id: CHANNEL, dm: false },
    resource: { kind: "surface_binding" },
    requestId: crypto.randomUUID(),
    connectUrl: CONNECT_URL,
    ...overrides,
  };
}

async function judge(i: SlackInput) {
  const result = await authorizeSlackInput(deps(), i);
  if (result.status !== "decided") throw new Error(result.reason);
  authorizationDecisionSchema.parse(result.decision);
  return result;
}

const pressing = (user: SlackUser, ceiling: SurfaceCeiling = everything) =>
  input(user, {
    action: "session.approve",
    resource: { kind: "session", id: SESSION },
    binding: { ceiling },
  });

describe("design 3.2, a mention and its approval", () => {
  test("a linked member asks, an admin approves, and an unlinked one is told to link", async () => {
    link("U0B", 1);
    link("U0C", 2, "admin");

    // Steps 2–5: the app is this agent's, B is linked, the channel allows it.
    const asked = await judge(input(slackUser("U0B")));
    expect(asked).toMatchObject({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      actorUserId: userId(1),
      notice: null,
      decision: { outcome: "allow", reason_code: "ok" },
    });

    // Steps 7–8: C presses approve and C is who is judged, not B.
    // (94S-798: C answers for B as the workspace's admin.)
    const approved = await judge(pressing(slackUser("U0C")));
    expect(approved.actorUserId).toBe(userId(2));
    expect(approved.decision.outcome).toBe("allow");

    // D never linked: neither asking nor pressing runs, and D gets the link.
    for (const i of [input(slackUser("U0D")), pressing(slackUser("U0D"))]) {
      const refused = await judge(i);
      expect(refused).toMatchObject({
        actorUserId: null,
        decision: { outcome: "deny", reason_code: "unlinked" },
        notice: { message: "connect", link_url: CONNECT_URL },
      });
    }

    // Step 9: every Slack input and every approval is kept, refusals too.
    expect(
      recorded.map(({ request, decision }) => [
        request.action,
        request.subject.actor_user_id ?? null,
        decision.outcome,
      ]),
    ).toEqual([
      ["session.submit", userId(1), "allow"],
      ["session.approve", userId(2), "allow"],
      ["session.submit", null, "deny"],
      ["session.approve", null, "deny"],
    ]);
  });

  test("an input that waited while its sender unlinked does not run", async () => {
    link("U0B", 1);
    const waiting = input(slackUser("U0B"));
    accounts.delete("U0B");
    expect(await judge(waiting)).toMatchObject({
      decision: { reason_code: "unlinked" },
      actorUserId: null,
    });
  });

  test("an event from another app, or for another agent, is dropped before any decision", async () => {
    link("U0B", 1);
    const other = await authorizeSlackInput(
      deps(),
      input(slackUser("U0B"), { event: { appId: "A0OTHER", teamId: TEAM } }),
    );
    expect(other).toEqual({ status: "dropped", reason: "not_installed" });
    const misrouted = await authorizeSlackInput(
      deps(),
      input(slackUser("U0B"), {
        event: {
          appId: APP,
          teamId: TEAM,
          agentId: "019a0000-0000-7000-8000-0000000000ff",
        },
      }),
    );
    expect(misrouted).toEqual({ status: "dropped", reason: "agent_mismatch" });
    expect(recorded).toEqual([]);
  });
});

describe("the channel's stored binding (94S-177)", () => {
  test("a mention is asked of the stored binding, which carries its ceiling", async () => {
    link("U0B", 1);
    const asked = await judge(
      input(slackUser("U0B"), {
        resource: { kind: "surface_binding", releaseId: "rel-1" },
      }),
    );
    expect(asked.decision.outcome).toBe("allow");
    expect(recorded[0]?.request).toMatchObject({
      resource: { kind: "surface_binding", id: BINDING, release_id: "rel-1" },
      subject: {
        surface: {
          binding_id: BINDING,
          channel_kind: "public_channel",
          ceiling: everything,
        },
      },
    });
  });

  test("a member outside the agent starts nothing unless axis A is use; a reply in a thread still goes", async () => {
    link("U0B", 1);
    link("U0A", 2, "admin");
    for (const access of ["view", "none"] as const) {
      outsideAccess = access;
      const start = { kind: "surface_binding", releaseId: "rel-1" } as const;
      expect(
        await judge(input(slackUser("U0B"), { resource: start })),
      ).toMatchObject({
        decision: { outcome: "deny", reason_code: "role" },
        notice: { message: "noRequestRight" },
      });
      // An owner or admin is inside every agent.
      expect(
        (await judge(input(slackUser("U0A"), { resource: start }))).decision
          .outcome,
      ).toBe("allow");
      expect(
        (
          await judge(
            input(slackUser("U0B"), {
              resource: { kind: "session_link", id: SESSION },
            }),
          )
        ).decision.outcome,
      ).toBe("allow");
    }
  });

  test("a release of another agent, or none, is refused at the agent ceiling", async () => {
    link("U0B", 1);
    for (const releaseId of ["rel-other", "rel-missing"]) {
      const asked = await judge(
        input(slackUser("U0B"), {
          resource: { kind: "surface_binding", releaseId },
        }),
      );
      expect(asked.decision).toMatchObject({
        outcome: "deny",
        reason_code: "agent_ceiling",
      });
    }
  });

  test("a private channel waiting for approval takes nothing, and its people are told it waits, once per wait", async () => {
    link("U0B", 1);
    const waiting = input(slackUser("U0B"), {
      binding: { channelKind: "private_channel", status: "pending_approval" },
    });
    expect(await judge(waiting)).toMatchObject({
      decision: { outcome: "deny", reason_code: "surface_ceiling" },
      actorUserId: null,
      notice: { message: "pendingApproval" },
      pending: { id: BINDING, revision: 1 },
    });
    const pressed = pressing(slackUser("U0B"));
    stored.set(CHANNEL, {
      ...(stored.get(CHANNEL) as SurfaceBindingRecord),
      status: "pending_approval",
    });
    expect(await judge(pressed)).toMatchObject({
      decision: { outcome: "deny" },
      notice: { message: "pendingApproval" },
    });
    stored.set(CHANNEL, {
      ...(stored.get(CHANNEL) as SurfaceBindingRecord),
      status: "ready",
    });
    expect((await judge(input(slackUser("U0B")))).pending).toBeNull();
  });

  test("a channel the bot left is dropped: nobody is told, a press or a follow-up included, and no decision is recorded", async () => {
    link("U0B", 1);
    const before = recorded.length;
    for (const resource of [
      { kind: "surface_binding" as const },
      { kind: "session" as const, id: SESSION },
    ]) {
      const left = input(slackUser("U0B"), {
        binding: { channelKind: "private_channel", status: "left" },
        resource,
      });
      expect(await authorizeSlackInput(deps(), left)).toEqual({
        status: "dropped",
        reason: "channel_left",
      });
    }
    expect(recorded).toHaveLength(before);
    // A channel that is simply not bound is still refused out loud.
    const unbound = input(slackUser("U0B"), {
      channel: { id: "C0ELSEWHERE", dm: false },
    });
    expect((await judge(unbound)).notice).toMatchObject({
      message: "noRequestRight",
    });
  });

  test("an unbound, switched-off or other agent's channel is refused, not dropped", async () => {
    link("U0B", 1);
    const unbound = input(slackUser("U0B"), {
      channel: { id: "C0ELSEWHERE", dm: false },
    });
    for (const arrange of [
      () => unbound,
      () => input(slackUser("U0B"), { binding: { mode: "off" } }),
      () => input(slackUser("U0B"), { binding: { agentId: OTHER_AGENT } }),
    ]) {
      expect(await judge(arrange())).toMatchObject({
        decision: { outcome: "deny", reason_code: "surface_ceiling" },
        actorUserId: null,
        notice: { message: "noRequestRight" },
      });
    }
    // A follow-up in a channel switched off since is refused too.
    expect(
      await judge(
        input(slackUser("U0B"), {
          binding: { mode: "off" },
          resource: { kind: "session", id: SESSION },
        }),
      ),
    ).toMatchObject({ decision: { reason_code: "surface_ceiling" } });
    expect(recorded).toHaveLength(4);
  });

  test("every DM reads the install's one DM binding", async () => {
    link("U0B", 1);
    const dm = input(slackUser("U0B"), { channel: { id: "D0ANY", dm: true } });
    expect((await judge(dm)).decision.reason_code).toBe("surface_ceiling");
    bind(null, {});
    expect(await judge(dm)).toMatchObject({
      decision: { outcome: "allow" },
      actorUserId: userId(1),
    });
    expect(recorded[1]?.request.subject.surface).toMatchObject({
      channel_kind: "dm",
    });
    // DMs switched off in the console are refused, and the person told.
    bind(null, { mode: "off" });
    expect(await judge(dm)).toMatchObject({
      decision: { outcome: "deny", reason_code: "surface_ceiling" },
      notice: { message: "noRequestRight" },
    });
  });
});

describe("approval is the presser's, and only where the channel takes it", () => {
  test("a channel that does not take approvals refuses the press", async () => {
    link("U0C", 2, "owner");
    const refused = await judge(
      pressing(slackUser("U0C"), {
        ...everything,
        actions: ["session.submit"],
      }),
    );
    expect(refused).toMatchObject({
      decision: { outcome: "deny", reason_code: "surface_ceiling" },
      notice: { message: "noApproveRight" },
    });
  });

  test("the same channel's limit on asking reads as a request refusal", async () => {
    link("U0B", 1);
    const refused = await judge(
      input(slackUser("U0B"), {
        binding: {
          channelKind: "public_channel",
          ceiling: { actions: ["session.read"], disclosure: "full" },
        },
      }),
    );
    expect(refused.notice).toEqual({
      message: "noRequestRight",
    });
  });

  test("the effective scopes are the smallest of person, installation and channel", async () => {
    link("U0O", 3, "owner");
    const asked = await judge(
      input(slackUser("U0O"), {
        binding: {
          channelKind: "public_channel",
          ceiling: {
            actions: ["session.read", "session.submit"],
            disclosure: "full",
          },
        },
      }),
    );
    expect(asked.decision.effective_scopes).toEqual([
      "sessions:read",
      "sessions:write",
    ]);
  });
});

describe("guests and Slack Connect", () => {
  const guest = (id: string) => slackUser(id, { is_restricted: true });

  test("with the setting off a guest is refused, linked or not", async () => {
    link("U0G", 4);
    for (const user of [guest("U0G"), guest("U0H")]) {
      expect(await judge(input(user))).toMatchObject({
        decision: { outcome: "deny", reason_code: "guest_disabled" },
        notice: { message: "guestDisabled" },
      });
    }
    // A single-channel guest is a guest too.
    expect(
      (await judge(input(slackUser("U0G", { is_ultra_restricted: true }))))
        .decision.reason_code,
    ).toBe("guest_disabled");
  });

  test("with the setting on a guest still has to link", async () => {
    guestsEnabled = true;
    link("U0G", 4);
    expect((await judge(input(guest("U0H")))).decision.reason_code).toBe(
      "unlinked",
    );
    expect(await judge(input(guest("U0G")))).toMatchObject({
      decision: { outcome: "allow" },
      actorUserId: userId(4),
    });
  });

  test("a Slack Connect user is refused whatever the guest setting", async () => {
    guestsEnabled = true;
    link("U0X", 5);
    for (const user of [
      slackUser("U0X", { is_stranger: true }),
      slackUser("U0X", { is_external: true }),
      slackUser("U0X", { team_id: "T0PARTNER" }),
    ]) {
      expect(await judge(input(user))).toMatchObject({
        decision: { outcome: "deny", reason_code: "external_user" },
        notice: { message: "membersOnly" },
        actorUserId: null,
      });
    }
  });
});

describe("a channel whose ceiling is a summary (D13)", () => {
  const summary: SurfaceCeiling = { ...everything, disclosure: "summary" };

  test("a read is redacted to a summary, and there is nothing to tell", async () => {
    link("U0B", 1);
    const read = await judge(
      input(slackUser("U0B"), {
        action: "session.read",
        resource: { kind: "session", id: SESSION },
        binding: { channelKind: "public_channel", ceiling: summary },
      }),
    );
    expect(read).toMatchObject({
      decision: {
        outcome: "redact",
        reason_code: "surface_ceiling",
        redact: { view: "summary" },
      },
      actorUserId: userId(1),
      notice: null,
    });
    // A redaction is always kept.
    expect(recorded.map((entry) => entry.decision.outcome)).toEqual(["redact"]);
  });

  test("a summary that cannot be recorded is refused", async () => {
    link("U0B", 1);
    recordFails = true;
    const read = await judge(
      input(slackUser("U0B"), {
        action: "session.read",
        resource: { kind: "session", id: SESSION },
        binding: { channelKind: "public_channel", ceiling: summary },
      }),
    );
    expect(read).toMatchObject({
      decision: { outcome: "deny", reason_code: "error", effective_scopes: [] },
      actorUserId: null,
      notice: { message: "failed" },
    });
    if (read.status !== "decided") throw new Error("expected a decision");
    expect(read.decision.redact).toBeUndefined();
    expect(authorizationDecisionSchema.parse(read.decision)).toBeTruthy();
  });

  test("asking in that channel is not narrowed", async () => {
    link("U0B", 1);
    const asked = await judge(
      input(slackUser("U0B"), {
        binding: { channelKind: "public_channel", ceiling: summary },
      }),
    );
    expect(asked.decision.outcome).toBe("allow");
  });
});

describe("a session outside the share", () => {
  test("does not exist for a linked member's press, and is the creator's", async () => {
    link("U0B", 1);
    link("U0C", 2);
    const onPrivate = (user: SlackUser) =>
      input(user, {
        action: "session.approve",
        resource: { kind: "session", id: PRIVATE_SESSION },
      });

    expect(await judge(onPrivate(slackUser("U0C")))).toMatchObject({
      actorUserId: null,
      decision: { outcome: "deny", reason_code: "not_found" },
      notice: { message: "outOfShare" },
    });
    expect((await judge(onPrivate(slackUser("U0B")))).decision.outcome).toBe(
      "allow",
    );
  });

  test("a member who only sees it may not answer for its creator (94S-798)", async () => {
    link("U0B", 1);
    link("U0C", 2);
    const pressing = (user: SlackUser) =>
      input(user, {
        action: "session.approve",
        resource: { kind: "session", id: SESSION },
      });
    expect(await judge(pressing(slackUser("U0C")))).toMatchObject({
      actorUserId: null,
      decision: { outcome: "deny", reason_code: "role" },
      notice: { message: "noApproveRight" },
    });
    expect((await judge(pressing(slackUser("U0B")))).decision.outcome).toBe(
      "allow",
    );
  });
});

describe("every refusal reason and what the person is shown", () => {
  type Case = {
    name: string;
    reason: AuthorizationReason;
    message: SlackNoticeMessage;
    arrange: () => SlackInput;
  };
  const cases: Case[] = [
    {
      name: "never linked",
      reason: "unlinked",
      message: "connect",
      arrange: () => input(slackUser("U0N")),
    },
    {
      name: "link went stale",
      reason: "stale_link",
      message: "connect",
      arrange: () => {
        link("U0S", 6);
        const waiting = input(slackUser("U0S"));
        const account = accounts.get("U0S");
        if (account) account.status = "stale";
        return waiting;
      },
    },
    {
      name: "person offboarded",
      reason: "disabled",
      message: "noRequestRight",
      arrange: () => {
        link("U0L", 7);
        const account = accounts.get("U0L");
        if (account) account.status = "offboarded";
        return input(slackUser("U0L"));
      },
    },
    {
      name: "channel takes no input",
      reason: "surface_ceiling",
      message: "noRequestRight",
      arrange: () => {
        link("U0B", 1);
        return input(slackUser("U0B"), {
          binding: {
            channelKind: "public_channel",
            ceiling: { actions: [], disclosure: "full" },
          },
        });
      },
    },
    {
      name: "guest with the setting off",
      reason: "guest_disabled",
      message: "guestDisabled",
      arrange: () => input(slackUser("U0G", { is_restricted: true })),
    },
    {
      name: "Slack Connect user",
      reason: "external_user",
      message: "membersOnly",
      arrange: () => input(slackUser("U0X", { is_stranger: true })),
    },
  ];

  for (const c of cases) {
    test(`${c.name}: ${c.reason}`, async () => {
      const result = await judge(c.arrange());
      expect(result.decision).toMatchObject({
        outcome: "deny",
        reason_code: c.reason,
      });
      expect(result.notice?.message).toBe(c.message);
    });
  }
});

describe("what an installation can never do", () => {
  test("recovery and management are not Slack's, whatever the person's role", async () => {
    link("U0O", 3, "owner");
    const policy = deps().authorization;
    const ask = (action: string, kind: "session" | "workspace") =>
      policy.authorize({
        subject: {
          principal: {
            kind: "installation",
            id: INSTALLATION,
            owner_id: WORKSPACE,
            workspace_id: WORKSPACE,
            scopes: ["sessions:read", "sessions:write"],
          },
          actor_user_id: userId(3),
          linked_account: { id: accounts.get("U0O")?.id ?? "", revision: 1 },
          surface: {
            kind: "slack",
            slack_user_kind: "member",
            ceiling: everything,
            agent_id: AGENT,
          },
        },
        action: action as SlackSurfaceAction,
        resource: {
          kind,
          id: kind === "workspace" ? WORKSPACE : SESSION,
          owner_scope: WORKSPACE,
        },
        request_id: crypto.randomUUID(),
      });
    for (const [action, kind] of [
      ["session.recover", "session"],
      ["workspace.manage", "workspace"],
      // The installation itself was issued no approval here.
      ["session.approve", "session"],
    ] as const) {
      expect(await ask(action, kind)).toMatchObject({
        outcome: "deny",
        reason_code: "surface_ceiling",
      });
    }
  });

  test("a Slack request with no channel ceiling is refused", async () => {
    link("U0B", 1);
    const policy = deps().authorization;
    const decision = await policy.authorize({
      subject: {
        principal: {
          kind: "installation",
          id: INSTALLATION,
          owner_id: WORKSPACE,
          workspace_id: WORKSPACE,
          scopes: ["sessions:read", "sessions:write"],
        },
        actor_user_id: userId(1),
        linked_account: { id: accounts.get("U0B")?.id ?? "", revision: 1 },
        surface: { kind: "slack", slack_user_kind: "member", agent_id: AGENT },
      },
      action: "session.submit",
      resource: { kind: "session", id: SESSION, owner_scope: WORKSPACE },
      request_id: crypto.randomUUID(),
    });
    expect(decision).toMatchObject({
      outcome: "deny",
      reason_code: "surface_ceiling",
    });
  });

  test("a Slack request that names no agent is refused", async () => {
    link("U0B", 1);
    const decision = await deps().authorization.authorize({
      subject: {
        principal: {
          kind: "installation",
          id: INSTALLATION,
          owner_id: WORKSPACE,
          workspace_id: WORKSPACE,
          scopes: ["sessions:read", "sessions:write"],
        },
        actor_user_id: userId(1),
        linked_account: { id: accounts.get("U0B")?.id ?? "", revision: 1 },
        surface: {
          kind: "slack",
          slack_user_kind: "member",
          ceiling: everything,
        },
      },
      action: "session.submit",
      resource: { kind: "session", id: SESSION, owner_scope: WORKSPACE },
      request_id: crypto.randomUUID(),
    });
    expect(decision).toMatchObject({ outcome: "deny", reason_code: "error" });
  });

  test("one agent's app never reaches another agent's session", async () => {
    link("U0B", 1);
    for (const action of [
      "session.read",
      "session.submit",
      "session.control",
      "session.approve",
    ] as const) {
      expect(
        await judge(
          input(slackUser("U0B"), {
            action,
            resource: { kind: "session", id: OTHER_SESSION },
          }),
        ),
      ).toMatchObject({
        decision: { outcome: "deny", reason_code: "agent_ceiling" },
        actorUserId: null,
      });
    }
  });
});
