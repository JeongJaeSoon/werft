import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_REVOKE_NOTICE,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { userPrincipal } from "@werft-ai/testkit/callers";
import type {
  BindCredentialResult,
  CredentialBinding,
  CredentialBindingStore,
  RevokeCredentialResult,
} from "../ports/credential-binding-store.ts";
import { createCredentialBindingService } from "./credential-binding-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a3";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000a4";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const KEY = "019a0000-0000-7000-8000-0000000000e1";

const agents: AgentAuthority = {
  agentOf: async (_ws, resource) => resource.id,
  isAdmin: async (_ws, agentId, userId) =>
    agentId === AGENT && userId === AGENT_ADMIN,
};

const BINDING: CredentialBinding = {
  id: "019a0000-0000-7000-8000-0000000000c1",
  agentId: AGENT,
  credentialRef: "notion_token",
  boundBy: AGENT_ADMIN,
  boundAt: new Date("2026-10-11T00:00:00.000Z"),
  revokedAt: null,
  runningSessions: 3,
};

function user(id: string, role: WorkspaceRole): Caller {
  return callerFor(
    userPrincipal(id, WORKSPACE, role),
    { kind: "web" },
    crypto.randomUUID(),
  );
}

const key = callerFor(
  {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "api" },
  crypto.randomUUID(),
  { creatorId: AGENT_ADMIN },
);

function serviceOver(results: {
  bind?: BindCredentialResult;
  revoke?: RevokeCredentialResult;
}) {
  const calls: string[] = [];
  const store: CredentialBindingStore = {
    bind: async (input) => {
      calls.push(`bind:${input.boundBy}`);
      return results.bind ?? { outcome: "bound", binding: BINDING };
    },
    revoke: async () => {
      calls.push("revoke");
      return results.revoke ?? { outcome: "revoked", binding: BINDING };
    },
    list: async () => [BINDING],
    unboundRefs: async () => [],
    contacts: async () => [],
  };
  const service = createCredentialBindingService({
    authorization: createAuthorizationPolicy({ agents }),
    store,
  });
  return { service, calls };
}

async function codeOf(promise: Promise<unknown>) {
  return promise.then(
    () => "resolved",
    (error: { code?: string }) => error.code ?? "thrown",
  );
}

describe("credential binding service", () => {
  test("the agent's admin and an owner bind; a member and a key never reach the store", async () => {
    const { service, calls } = serviceOver({});
    const body = { credential_ref: "notion_token" };
    expect(
      await codeOf(service.bind(user(MEMBER, "member"), AGENT, body)),
    ).toBe("FORBIDDEN");
    expect(await codeOf(service.bind(key, AGENT, body))).toBe("FORBIDDEN");
    expect(await codeOf(service.list(key, AGENT))).toBe("FORBIDDEN");
    expect(calls).toEqual([]);

    const made = await service.bind(user(AGENT_ADMIN, "member"), AGENT, body);
    expect(made).toMatchObject({
      created: true,
      binding: { credential_ref: "notion_token", running_sessions: 3 },
    });
    expect(made.receipt_id).not.toBeNull();
    await service.bind(user(OWNER, "owner"), AGENT, body);
    expect(calls).toEqual([`bind:${AGENT_ADMIN}`, `bind:${OWNER}`]);
  });

  test("a binding already in place is no receipt; an identity's name is CREDENTIAL_REF_IN_USE", async () => {
    const admin = user(AGENT_ADMIN, "member");
    const body = { credential_ref: "notion_token" };
    const again = await serviceOver({
      bind: { outcome: "already_bound", binding: BINDING },
    }).service.bind(admin, AGENT, body);
    expect(again).toMatchObject({ created: false, receipt_id: null });
    const outcomes: [BindCredentialResult["outcome"], string][] = [
      ["ref_in_use", "CREDENTIAL_REF_IN_USE"],
      ["outranked", "FORBIDDEN"],
      ["actor_inactive", "FORBIDDEN"],
      ["agent_not_found", "NOT_FOUND"],
    ];
    for (const [outcome, code] of outcomes) {
      const { service } = serviceOver({
        bind: { outcome } as BindCredentialResult,
      });
      expect(await codeOf(service.bind(admin, AGENT, body))).toBe(code);
    }
  });

  test("unbinding answers the running count with the notice", async () => {
    const admin = user(AGENT_ADMIN, "member");
    const revoked = await serviceOver({}).service.revoke(
      admin,
      AGENT,
      BINDING.id,
    );
    expect(revoked.binding.running_sessions).toBe(3);
    expect(revoked.revoke_notice).toBe(CREDENTIAL_REVOKE_NOTICE);
    expect(
      await codeOf(
        serviceOver({ revoke: { outcome: "not_found" } }).service.revoke(
          admin,
          AGENT,
          BINDING.id,
        ),
      ),
    ).toBe("NOT_FOUND");
  });
});
