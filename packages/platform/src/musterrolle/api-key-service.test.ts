import { describe, expect, test } from "bun:test";
import {
  type CreateApiKeyRequest,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  IssueKeyInput,
  WorkspaceKey,
  WorkspaceKeyStore,
} from "../ports/api-key-store.ts";
import { createApiKeyService } from "./api-key-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";
import { SessionServiceError } from "./service-errors.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const ADMIN = "019a0000-0000-7000-8000-0000000000a2";
const MEMBER = "019a0000-0000-7000-8000-0000000000a3";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000a4";
const AGENT_A = "019a0000-0000-7000-8000-00000000b0a1";
const AGENT_B = "019a0000-0000-7000-8000-00000000b0b1";

const agents: AgentAuthority = {
  agentOf: async (_ws, resource) => resource.id,
  isAdmin: async (_ws, agentId, userId) =>
    agentId === AGENT_A && userId === AGENT_ADMIN,
};

function user(id: string, role: WorkspaceRole): Caller {
  return callerFor(
    {
      kind: "user",
      id,
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );
}

function fakeStore() {
  const keys = new Map<string, WorkspaceKey>();
  const issued: IssueKeyInput[] = [];
  const store: WorkspaceKeyStore = {
    async issue(input) {
      issued.push(input);
      const key: WorkspaceKey = {
        id: input.id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        name: input.name,
        agentId: input.agentId,
        createdByUserId: input.createdByUserId,
        createdByDisplayName: "Issuer",
        scopes: [...input.scopes],
        createdAt: new Date("2026-10-11T00:00:00.000Z"),
        expiresAt: input.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      };
      keys.set(key.id, key);
      return { outcome: "issued", key };
    },
    find: async (_ws, id) => keys.get(id) ?? null,
    async list() {
      return { items: [...keys.values()], nextCursor: null };
    },
    async revoke(input) {
      const key = keys.get(input.keyId);
      if (!key) return { outcome: "not_found" };
      if (key.revokedAt) return { outcome: "already_revoked", key };
      key.revokedAt = new Date("2026-10-11T01:00:00.000Z");
      return { outcome: "revoked", key };
    },
  };
  return { store, issued, keys };
}

function service(store = fakeStore()) {
  return {
    ...store,
    keys: createApiKeyService({
      authorization: createAuthorizationPolicy({ agents }),
      store: store.store,
      mint: () => ({ secret: "csp_test", hash: new Uint8Array([1]) }),
      now: () => new Date("2026-10-11T00:00:00.000Z"),
    }),
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SessionServiceError);
  return error as SessionServiceError;
}

const personal: CreateApiKeyRequest = {
  kind: "personal",
  scopes: ["sessions:read"],
};
const agentKey = (agent: string): CreateApiKeyRequest => ({
  kind: "agent",
  scopes: ["sessions:read", "sessions:write"],
  agent_id: agent,
});

describe("issuing a key", () => {
  test("a member issues their own personal key and nothing else", async () => {
    const { keys, issued } = service();
    const caller = user(MEMBER, "member");
    const created = await keys.issue(caller, personal);
    expect(created).toMatchObject({
      secret: "csp_test",
      key: { kind: "personal", created_by: MEMBER, agent_id: null },
    });
    expect(issued[0]?.createdByUserId).toBe(MEMBER);

    const denied = await refusal(keys.issue(caller, agentKey(AGENT_A)));
    expect(denied.code).toBe("FORBIDDEN");
    expect(denied.details).toEqual({ reason_code: "role" });
  });

  test("owners and admins issue any agent's key", async () => {
    const { keys } = service();
    for (const caller of [user(OWNER, "owner"), user(ADMIN, "admin")]) {
      const created = await keys.issue(caller, agentKey(AGENT_B));
      expect(created.key).toMatchObject({ kind: "agent", agent_id: AGENT_B });
    }
  });

  test("the name the issuer gives is kept, and none is null", async () => {
    const { keys, issued } = service();
    const caller = user(OWNER, "owner");
    const named = await keys.issue(caller, { ...personal, name: "laptop" });
    expect(named.key.name).toBe("laptop");
    expect(issued[0]?.name).toBe("laptop");
    expect((await keys.issue(caller, personal)).key.name).toBeNull();
  });

  test("an agent's admin issues keys for that agent only", async () => {
    const { keys } = service();
    const caller = user(AGENT_ADMIN, "member");
    expect((await keys.issue(caller, agentKey(AGENT_A))).key.agent_id).toBe(
      AGENT_A,
    );
    expect((await refusal(keys.issue(caller, agentKey(AGENT_B)))).code).toBe(
      "FORBIDDEN",
    );
  });

  test("never above what the issuer holds now", async () => {
    const { keys } = service();
    const admin = await refusal(
      keys.issue(user(ADMIN, "admin"), {
        ...agentKey(AGENT_B),
        scopes: ["sessions:read", "sessions:recover"],
      }),
    );
    expect(admin.code).toBe("SCOPE_NOT_GRANTABLE");
    expect(admin.message).toContain("sessions:recover");
    // An owner holds recover, so the same key is theirs to make.
    expect(
      (
        await keys.issue(user(OWNER, "owner"), {
          kind: "personal",
          scopes: [...SESSION_SCOPE_VALUES],
        })
      ).key.scopes,
    ).toContain("sessions:recover");
  });

  test("an agent key takes any scope its issuer holds, sessions:approve included (GA-8)", async () => {
    const { keys } = service();
    const issued = await keys.issue(user(OWNER, "owner"), {
      ...agentKey(AGENT_A),
      scopes: [...SESSION_SCOPE_VALUES],
    });
    expect(issued.key.scopes).toEqual([...SESSION_SCOPE_VALUES]);
    expect(issued.key.scopes).toContain("sessions:approve");
    const beyond = await refusal(
      keys.issue(user(AGENT_ADMIN, "member"), {
        ...agentKey(AGENT_A),
        scopes: ["sessions:approve", "sessions:recover"],
      }),
    );
    expect(beyond.code).toBe("SCOPE_NOT_GRANTABLE");
    expect(beyond.message).toContain("sessions:recover");
  });

  test("an API key issues no key, its own kind included", async () => {
    const { keys, issued } = service();
    const caller = callerFor(
      {
        kind: "api_key",
        id: "019a0000-0000-7000-8000-0000000000e1",
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      crypto.randomUUID(),
      { creatorId: OWNER },
    );
    for (const body of [personal, agentKey(AGENT_A)]) {
      expect((await refusal(keys.issue(caller, body))).code).toBe("FORBIDDEN");
    }
    expect(issued).toHaveLength(0);
  });

  test("the store's recheck under the issuer's lock has the last word", async () => {
    for (const [outcome, code] of [
      ["outranked", "FORBIDDEN"],
      ["scope_not_grantable", "SCOPE_NOT_GRANTABLE"],
    ] as const) {
      const fake = fakeStore();
      fake.store.issue = async (input) => {
        fake.issued.push(input);
        return { outcome };
      };
      const { keys } = service(fake);
      expect(
        (await refusal(keys.issue(user(OWNER, "owner"), agentKey(AGENT_B))))
          .code,
      ).toBe(code);
      expect(fake.issued[0]?.issuerRoles).toEqual(["owner", "admin"]);
    }
    const { keys, issued: own } = service();
    await keys.issue(user(MEMBER, "member"), personal);
    expect(own[0]?.issuerRoles).toEqual(["owner", "admin", "member"]);
  });

  test("a past expiry is refused", async () => {
    const { keys } = service();
    const error = await refusal(
      keys.issue(user(MEMBER, "member"), {
        ...personal,
        expires_at: "2026-10-10T00:00:00.000Z",
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

describe("revoking a key", () => {
  test("another person's personal key does not exist for the caller", async () => {
    const { keys } = service();
    const { key } = await keys.issue(user(MEMBER, "member"), personal);
    expect(
      (await refusal(keys.revoke(user(OWNER, "owner"), key.id))).code,
    ).toBe("NOT_FOUND");
    const revoked = await keys.revoke(user(MEMBER, "member"), key.id);
    expect(revoked.key.revoked_at).not.toBeNull();
    expect(revoked.receipt_id).not.toBeNull();
    // A second revoke changes nothing and writes no receipt.
    expect(
      (await keys.revoke(user(MEMBER, "member"), key.id)).receipt_id,
    ).toBeNull();
  });

  test("an agent's key falls to that agent's admin, another agent's does not", async () => {
    const { keys } = service();
    const owner = user(OWNER, "owner");
    const bound = (await keys.issue(owner, agentKey(AGENT_A))).key;
    const plain = (await keys.issue(owner, agentKey(AGENT_B))).key;
    const caller = user(AGENT_ADMIN, "member");
    expect((await refusal(keys.revoke(caller, plain.id))).code).toBe(
      "FORBIDDEN",
    );
    expect((await keys.revoke(caller, bound.id)).key.revoked_at).not.toBeNull();
  });
});
