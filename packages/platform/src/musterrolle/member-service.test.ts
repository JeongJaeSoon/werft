import { describe, expect, test } from "bun:test";
import type { MemberStore, SetAccessResult } from "../ports/member-store.ts";
import { createMemberService } from "./member-service.ts";
import { callerFor, createAuthorizationPolicy } from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a2";
const KEY = "019a0000-0000-7000-8000-0000000000c1";

const member = {
  userId: MEMBER,
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  disabledAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
};

function serviceAnswering(result: SetAccessResult) {
  const calls: Parameters<MemberStore["setAccess"]>[0][] = [];
  const service = createMemberService({
    authorization: createAuthorizationPolicy(),
    store: {
      setAccess: async (input) => {
        calls.push(input);
        return result;
      },
      listAwaitingTakeover: async () => [],
      takeOver: async () => ({ outcome: "not_found" }),
    },
  });
  return { service, calls };
}

function asOwner() {
  return callerFor(
    {
      kind: "user",
      id: OWNER,
      workspace_id: WORKSPACE,
      role: "owner",
      scopes: ["sessions:read"],
    },
    { kind: "api" },
    crypto.randomUUID(),
  );
}

describe("member access", () => {
  test("turning yourself off is the store's refusal, under its locks", async () => {
    const { service, calls } = serviceAnswering({ outcome: "self_protected" });
    for (const disable of [service.disableMember, service.disableUser]) {
      await expect(
        disable(asOwner(), OWNER.toUpperCase()),
      ).rejects.toMatchObject({ code: "SELF_PROTECTED" });
    }
    expect(calls).toMatchObject([{ userId: OWNER }, { userId: OWNER }]);
  });

  test("a member and an API key never reach the store", async () => {
    const { service, calls } = serviceAnswering({ outcome: "not_found" });
    const asMember = callerFor(
      {
        kind: "user",
        id: MEMBER,
        workspace_id: WORKSPACE,
        role: "member",
        scopes: ["sessions:read"],
      },
      { kind: "api" },
      crypto.randomUUID(),
    );
    const asKey = callerFor(
      {
        kind: "api_key",
        id: KEY,
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: ["sessions:read"],
      },
      { kind: "api" },
      crypto.randomUUID(),
      { creatorId: null },
    );
    for (const caller of [asMember, asKey]) {
      await expect(service.disableMember(caller, OWNER)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    expect(calls).toEqual([]);
  });

  test("the store is asked as the acting owner, in the caller's workspace, with the reason", async () => {
    const { service, calls } = serviceAnswering({
      outcome: "unchanged",
      member,
    });
    const done = await service.enableUser(
      asOwner(),
      MEMBER.toUpperCase(),
      "back",
    );
    expect(done).toEqual({
      member: {
        user_id: MEMBER,
        email: "member@example.com",
        display_name: "Member",
        role: "member",
        disabled_at: null,
        created_at: "2026-10-01T00:00:00.000Z",
      },
      receiptId: null,
      effects: null,
    });
    expect(calls).toMatchObject([
      {
        actor: { workspaceId: WORKSPACE, userId: OWNER },
        userId: MEMBER,
        scope: "account",
        disabled: false,
        reason: "back",
      },
    ]);
  });

  test("each refusal from the store keeps its own error code", async () => {
    const cases = [
      ["not_found", "NOT_FOUND"],
      ["last_owner", "LAST_OWNER"],
      ["elsewhere", "FORBIDDEN"],
      ["outranked", "OWNER_PROTECTED"],
      ["self_protected", "SELF_PROTECTED"],
      ["account_disabled", "ACCOUNT_DISABLED"],
      ["actor_inactive", "FORBIDDEN"],
    ] as const;
    for (const [outcome, code] of cases) {
      const { service } = serviceAnswering({ outcome });
      await expect(
        service.disableMember(asOwner(), MEMBER),
      ).rejects.toMatchObject({ code });
    }
  });

  test("the emergency admin is turned off in neither scope: a conflict that names why", async () => {
    const { service } = serviceAnswering({ outcome: "emergency_admin" });
    for (const attempt of [
      () => service.disableMember(asOwner(), MEMBER),
      () => service.disableUser(asOwner(), MEMBER),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: "REVISION_CONFLICT",
        details: { reason_code: "emergency_admin" },
      });
    }
  });
});
