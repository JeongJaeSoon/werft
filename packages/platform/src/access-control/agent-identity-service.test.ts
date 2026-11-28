import { describe, expect, test } from "bun:test";
import type { WorkspaceRole } from "@werft-ai/contracts";
import {
  agentForSlackEvent,
  createAgentIdentityService,
} from "./agent-identity-service.ts";
import {
  type AgentAuthority,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";
import type {
  AgentIdentityRecord,
  AgentIdentityStore,
  LinkAgentIdentityResult,
  RevokeAgentIdentityResult,
  SlackEventAgent,
} from "./ports/agent-identity-store.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const PERSON = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000b1";
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000b2";
const IDENTITY = "019a0000-0000-7000-8000-0000000000d1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const KEY = "019a0000-0000-7000-8000-0000000000c1";

const record: AgentIdentityRecord = {
  id: IDENTITY,
  workspaceId: WORKSPACE,
  agentId: AGENT,
  provider: "slack_bot",
  installationId: "019a0000-0000-7000-8000-000000000011",
  appId: "A0APP",
  teamId: "T0TEAM",
  externalPrincipalId: "B0BOT",
  credentialRef: "slack-bot-token",
  status: "active",
  revision: 1,
  createdBy: PERSON,
  createdAt: new Date("2026-10-11T00:00:00Z"),
  revokedAt: null,
};

const REQUEST = {
  provider: "slack_bot",
  app_id: "A0APP",
  team_id: "T0TEAM",
  credential_ref: "slack-bot-token",
} as const;

// PERSON administers AGENT and nothing else.
const agents: AgentAuthority = {
  async agentOf(_workspaceId, resource) {
    return resource.kind === "agent" ? resource.id : null;
  },
  async isAdmin(_workspaceId, agentId, userId) {
    return agentId === AGENT && userId === PERSON;
  },
};

function serviceWith(overrides: Partial<AgentIdentityStore> = {}) {
  const calls: unknown[] = [];
  const store: AgentIdentityStore = {
    link: async (input) => {
      calls.push(input);
      return { outcome: "linked", identity: record, receiptId: RECEIPT };
    },
    revoke: async (input) => {
      calls.push(input);
      return {
        outcome: "revoked",
        identity: { ...record, status: "revoked", revision: 2 },
        receiptId: RECEIPT,
      };
    },
    list: async (workspaceId, agentId, limit) => {
      calls.push({ workspaceId, agentId, limit });
      return [record];
    },
    resolveSlackEvent: async () => ({
      status: "dropped",
      reason: "not_installed",
    }),
    ...overrides,
  };
  return {
    service: createAgentIdentityService({
      authorization: createAuthorizationPolicy({ agents }),
      store,
    }),
    calls,
  };
}

const asPerson = (role: WorkspaceRole, id = PERSON) =>
  callerFor(
    {
      kind: "user",
      id,
      workspace_id: WORKSPACE,
      role,
      scopes: ["sessions:read"],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );

const asServiceKey = () =>
  callerFor(
    {
      kind: "api_key",
      id: KEY,
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: "api" },
    crypto.randomUUID(),
    { creatorId: null },
  );

describe("linking an agent to its Slack app", () => {
  test("owner, admin and the agent's admin link; another member and a key cannot", async () => {
    const stranger = "019a0000-0000-7000-8000-0000000000a2";
    for (const caller of [
      asPerson("owner", stranger),
      asPerson("admin", stranger),
      asPerson("member"),
    ]) {
      const { service } = serviceWith();
      expect(
        (await service.linkAgentIdentity(caller, AGENT, REQUEST)).receipt_id,
      ).toBe(RECEIPT);
    }
    const { service, calls } = serviceWith();
    await expect(
      service.linkAgentIdentity(asPerson("member"), OTHER_AGENT, REQUEST),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    });
    await expect(
      service.linkAgentIdentity(asServiceKey(), AGENT, REQUEST),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual([]);
  });

  test("hands the store the caller's workspace, the request and the roles it re-reads", async () => {
    const { service, calls } = serviceWith();
    expect(
      await service.linkAgentIdentity(asPerson("owner"), AGENT, REQUEST),
    ).toEqual({
      agent_identity: {
        id: IDENTITY,
        agent_id: AGENT,
        provider: "slack_bot",
        app_id: "A0APP",
        team_id: "T0TEAM",
        bot_user_id: "B0BOT",
        credential_ref: "slack-bot-token",
        status: "active",
        revision: 1,
        created_by: PERSON,
        created_at: "2026-10-11T00:00:00.000Z",
        revoked_at: null,
      },
      receipt_id: RECEIPT,
    });
    expect(calls).toMatchObject([
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        key: { appId: "A0APP", teamId: "T0TEAM" },
        credentialRef: "slack-bot-token",
        managerRoles: ["owner", "admin"],
      },
    ]);
  });

  test("each refusal from the store has its own code", async () => {
    const cases: [LinkAgentIdentityResult, string, RegExp][] = [
      [{ outcome: "agent_not_found" }, "NOT_FOUND", /not found/],
      [{ outcome: "not_installed" }, "SLACK_NOT_INSTALLED", /설치/],
      [{ outcome: "taken" }, "AGENT_IDENTITY_TAKEN", /다른 에이전트/],
      [
        { outcome: "exists", identity: record },
        "ALREADY_EXISTS",
        /이미 이 Slack 앱/,
      ],
      [
        { outcome: "credential_ref_in_use" },
        "CREDENTIAL_REF_IN_USE",
        /전용 이름/,
      ],
      [{ outcome: "outranked" }, "FORBIDDEN", /no longer holds/],
      [{ outcome: "actor_inactive" }, "FORBIDDEN", /no longer a member/],
    ];
    for (const [result, code, message] of cases) {
      const { service } = serviceWith({ link: async () => result });
      const refusal = service.linkAgentIdentity(
        asPerson("owner"),
        AGENT,
        REQUEST,
      );
      await expect(refusal).rejects.toMatchObject({ code });
      await expect(refusal).rejects.toThrow(message);
    }
  });
});

describe("listing and revoking", () => {
  test("lists the agent's identities for whoever may manage it", async () => {
    const { service, calls } = serviceWith();
    expect(
      (await service.listAgentIdentities(asPerson("member"), AGENT)).items,
    ).toHaveLength(1);
    expect(calls).toEqual([
      { workspaceId: WORKSPACE, agentId: AGENT, limit: 50 },
    ]);
    await expect(
      service.listAgentIdentities(asPerson("member"), OTHER_AGENT),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("revokes once with a receipt, then answers a null receipt", async () => {
    const { service } = serviceWith();
    const revoked = await service.revokeAgentIdentity(
      asPerson("admin"),
      AGENT,
      IDENTITY,
    );
    expect(revoked).toMatchObject({
      agent_identity: { status: "revoked", revision: 2 },
      receipt_id: RECEIPT,
    });
    const { service: again } = serviceWith({
      revoke: async () => ({ outcome: "already_revoked", identity: record }),
    });
    expect(
      await again.revokeAgentIdentity(asPerson("owner"), AGENT, IDENTITY),
    ).toMatchObject({ receipt_id: null });
    const refusals: [RevokeAgentIdentityResult, string][] = [
      [{ outcome: "not_found" }, "NOT_FOUND"],
      [{ outcome: "outranked" }, "FORBIDDEN"],
      [{ outcome: "actor_inactive" }, "FORBIDDEN"],
    ];
    for (const [result, code] of refusals) {
      const { service: refused } = serviceWith({ revoke: async () => result });
      await expect(
        refused.revokeAgentIdentity(asPerson("owner"), AGENT, IDENTITY),
      ).rejects.toMatchObject({ code });
    }
  });
});

describe("the agent a Slack event moves", () => {
  const resolved: SlackEventAgent = {
    status: "resolved",
    workspaceId: WORKSPACE,
    agentId: AGENT,
    identity: { id: IDENTITY, revision: 1 },
    installationId: record.installationId,
    botUserId: "B0BOT",
    credentialRef: "slack-bot-token",
    allowedBotUserIds: [],
    werftBotUserIds: [],
  };
  const store = {
    resolveSlackEvent: async () => resolved,
  };

  test("is the app's agent, whether or not the event names one", async () => {
    expect(
      await agentForSlackEvent(store, { appId: "A0APP", teamId: "T0TEAM" }),
    ).toEqual(resolved);
    expect(
      await agentForSlackEvent(store, {
        appId: "A0APP",
        teamId: "T0TEAM",
        agentId: AGENT.toUpperCase(),
      }),
    ).toEqual(resolved);
  });

  test("an event for another agent than the app's is dropped", async () => {
    expect(
      await agentForSlackEvent(store, {
        appId: "A0APP",
        teamId: "T0TEAM",
        agentId: OTHER_AGENT,
      }),
    ).toEqual({ status: "dropped", reason: "agent_mismatch" });
  });

  test("a drop from the store passes through", async () => {
    expect(
      await agentForSlackEvent(
        {
          resolveSlackEvent: async () => ({
            status: "dropped",
            reason: "identity_revoked",
          }),
        },
        { appId: "A0APP", teamId: "T0TEAM", agentId: AGENT },
      ),
    ).toEqual({ status: "dropped", reason: "identity_revoked" });
  });
});
