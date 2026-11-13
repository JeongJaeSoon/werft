import { describe, expect, test } from "bun:test";
import {
  SESSION_SCOPE_VALUES,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  InviteRecord,
  InviteStore,
  MemberRecord,
} from "../ports/identity-store.ts";
import { createInviteService, INVITE_TTL_MS } from "./invite-service.ts";
import { type Caller, callerFor, createAuthorizationPolicy } from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a2";
const KEY = "019a0000-0000-7000-8000-0000000000k1";

const INVITE: InviteRecord = {
  id: "019a0000-0000-7000-8000-0000000000c1",
  workspaceId: WORKSPACE,
  email: "invitee@example.com",
  role: "member",
  invitedBy: OWNER,
  status: "pending",
  expiresAt: new Date("2026-10-18T00:00:00.000Z"),
  acceptedAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-11T00:00:00.000Z"),
};

const MEMBER_ROW: MemberRecord = {
  userId: MEMBER,
  email: "member@example.com",
  displayName: "Member",
  role: "owner",
  disabledAt: null,
  createdAt: new Date("2026-10-11T00:00:00.000Z"),
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

const workspaceKey: Parameters<typeof callerFor>[0] = {
  kind: "api_key",
  id: KEY,
  owner_id: WORKSPACE,
  workspace_id: WORKSPACE,
  scopes: [...SESSION_SCOPE_VALUES],
};

function store(overrides: Partial<InviteStore> = {}): InviteStore {
  const unreachable = async (): Promise<never> => {
    throw new Error("store reached");
  };
  return {
    createInvite: unreachable,
    listInvites: unreachable,
    revokeInvite: unreachable,
    peekInvite: unreachable,
    acceptInvite: unreachable,
    listMembers: unreachable,
    changeMemberRole: unreachable,
    ...overrides,
  };
}

function service(overrides: Partial<InviteStore> = {}) {
  return createInviteService({
    authorization: createAuthorizationPolicy(),
    store: store(overrides),
  });
}

const EVERY_ENTRY = {
  issueInvite: (s: ReturnType<typeof service>, c: Caller) =>
    s.issueInvite(c, {
      email: "invitee@example.com",
      role: "member",
      tokenHash: new Uint8Array(32),
    }),
  listInvites: (s: ReturnType<typeof service>, c: Caller) => s.listInvites(c),
  revokeInvite: (s: ReturnType<typeof service>, c: Caller) =>
    s.revokeInvite(c, INVITE.id),
  listMembers: (s: ReturnType<typeof service>, c: Caller) =>
    s.listMembers(c, { limit: 50 }),
  changeMemberRole: (s: ReturnType<typeof service>, c: Caller) =>
    s.changeMemberRole(c, MEMBER, "owner"),
};

describe("invite service", () => {
  for (const [name, call] of Object.entries(EVERY_ENTRY)) {
    test(`${name}: a member and a workspace key are refused before the store`, async () => {
      const s = service();
      await expect(call(s, user(MEMBER, "member"))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        call(s, callerFor(workspaceKey, { kind: "api" }, crypto.randomUUID())),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }

  test("an invite expires seven days out and is written as the calling owner", async () => {
    let asked: Parameters<InviteStore["createInvite"]>[0] | undefined;
    const s = service({
      createInvite: async (input) => {
        asked = input;
        return { outcome: "created", invite: INVITE };
      },
    });
    await expect(
      EVERY_ENTRY.issueInvite(s, user(OWNER, "owner")),
    ).resolves.toEqual(INVITE);
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(asked?.ttlMs).toBe(INVITE_TTL_MS);
    expect(asked?.actor).toMatchObject({
      userId: OWNER,
      workspaceId: WORKSPACE,
    });
    expect(asked?.receiptId).not.toBe(asked?.id);
  });

  test("store outcomes become the API's error codes", async () => {
    const owner = user(OWNER, "owner");
    await expect(
      EVERY_ENTRY.issueInvite(
        service({ createInvite: async () => ({ outcome: "already_member" }) }),
        owner,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      EVERY_ENTRY.issueInvite(
        service({ createInvite: async () => ({ outcome: "actor_inactive" }) }),
        owner,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      EVERY_ENTRY.revokeInvite(
        service({ revokeInvite: async () => ({ outcome: "accepted" }) }),
        owner,
      ),
    ).rejects.toMatchObject({ code: "INVITE_USED" });
    await expect(
      EVERY_ENTRY.revokeInvite(
        service({ revokeInvite: async () => ({ outcome: "not_found" }) }),
        owner,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      EVERY_ENTRY.revokeInvite(
        service({ revokeInvite: async () => ({ outcome: "already_revoked" }) }),
        owner,
      ),
    ).resolves.toBeUndefined();
    await expect(
      EVERY_ENTRY.changeMemberRole(
        service({ changeMemberRole: async () => ({ outcome: "last_owner" }) }),
        owner,
      ),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
    await expect(
      EVERY_ENTRY.changeMemberRole(
        service({
          changeMemberRole: async () => ({ outcome: "emergency_admin" }),
        }),
        owner,
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: { reason_code: "emergency_admin" },
    });
    const admin = user(MEMBER, "admin");
    await expect(
      EVERY_ENTRY.changeMemberRole(
        service({
          changeMemberRole: async () => ({ outcome: "owner_protected" }),
        }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
    await expect(
      EVERY_ENTRY.issueInvite(
        service({ createInvite: async () => ({ outcome: "owner_protected" }) }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
    await expect(
      EVERY_ENTRY.changeMemberRole(
        service({
          changeMemberRole: async () => ({ outcome: "actor_inactive" }),
        }),
        owner,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      EVERY_ENTRY.changeMemberRole(
        service({
          changeMemberRole: async () => ({
            outcome: "changed",
            member: MEMBER_ROW,
          }),
        }),
        owner,
      ),
    ).resolves.toMatchObject({ user_id: MEMBER, role: "owner" });
  });

  test("lists read the caller's workspace and render API views", async () => {
    const s = service({
      listInvites: async (workspaceId) =>
        workspaceId === WORKSPACE ? [INVITE] : [],
      listMembers: async (workspaceId, query) => ({
        items:
          workspaceId === WORKSPACE && query.q === "x"
            ? [
                {
                  ...MEMBER_ROW,
                  membershipDisabled: false,
                  accountDisabled: false,
                  administeredAgents: [],
                  lastActiveAt: null,
                },
              ]
            : [],
        next_cursor: "next",
      }),
    });
    const owner = user(OWNER, "owner");
    expect(await s.listInvites(owner)).toEqual([
      expect.objectContaining({
        id: INVITE.id,
        status: "pending",
        expires_at: "2026-10-18T00:00:00.000Z",
      }),
    ]);
    expect(await s.listMembers(owner, { limit: 50, q: "x" })).toEqual({
      items: [
        expect.objectContaining({
          user_id: MEMBER,
          disabled_at: null,
          actions: expect.objectContaining({ disable: { allowed: true } }),
        }),
      ],
      next_cursor: "next",
      assignable_roles: ["owner", "admin", "member"],
    });
    // The row is an owner's: what it offers follows the caller's role.
    const seenByAdmin = await s.listMembers(user(OWNER, "admin"), {
      limit: 50,
      q: "x",
    });
    expect(seenByAdmin.items[0]?.actions.disable).toEqual({
      allowed: false,
      reason: "owner_protected",
    });
    expect(seenByAdmin.assignable_roles).toEqual(["admin", "member"]);
  });
});
