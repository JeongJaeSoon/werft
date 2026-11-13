import {
  INVITE_LIST_LIMIT,
  INVITE_TTL_DAYS,
  type Invite,
  type ListMembersQuery,
  type ListMembersResponse,
  type MemberView,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  ActingOwner,
  InviteRecord,
  InviteStore,
  MemberRecord,
} from "../ports/identity-store.ts";
import { assignableRoles, memberActions } from "./member-rules.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import { EMERGENCY_ADMIN, SessionServiceError } from "./service-errors.ts";

export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export function inviteView(row: InviteRecord): Invite {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    email: row.email,
    role: row.role,
    invited_by: row.invitedBy,
    status: row.status,
    expires_at: row.expiresAt.toISOString(),
    accepted_at: row.acceptedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export function memberView(row: MemberRecord): MemberView {
  return {
    user_id: row.userId,
    email: row.email,
    display_name: row.displayName,
    role: row.role,
    disabled_at: row.disabledAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

const NOT_AN_OWNER =
  "This principal no longer manages the members of the workspace";
const OWNER_PROTECTED = () =>
  new SessionServiceError(
    "OWNER_PROTECTED",
    "Only an owner can grant the owner role or change an owner's role",
  );

/**
 * Invites and roles. Every entry point asks the policy for
 * `member.manage` first, so which roles may manage members is the policy's
 * table, not this file's. That an admin cannot touch the owner role is the
 * store's to say: it reads both roles inside the change's transaction.
 */
export function createInviteService(deps: {
  authorization: AuthorizationPolicy;
  store: InviteStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function actingOwner(caller: Caller): Promise<ActingOwner> {
    await requirePermitted(authorization, caller, "member.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (!userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "This principal does not hold member.manage",
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  return {
    async issueInvite(
      caller: Caller,
      input: { email: string; role: WorkspaceRole; tokenHash: Uint8Array },
    ): Promise<InviteRecord> {
      const actor = await actingOwner(caller);
      const result = await store.createInvite({
        id: newId(),
        actor,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        ttlMs: INVITE_TTL_MS,
        receiptId: newId(),
      });
      switch (result.outcome) {
        case "already_member":
          throw new SessionServiceError(
            "BAD_REQUEST",
            "This email already belongs to a member of the workspace",
          );
        case "actor_inactive":
          throw new SessionServiceError("FORBIDDEN", NOT_AN_OWNER);
        case "owner_protected":
          throw OWNER_PROTECTED();
        default:
          return result.invite;
      }
    },

    async listInvites(caller: Caller): Promise<Invite[]> {
      const actor = await actingOwner(caller);
      const rows = await store.listInvites(
        actor.workspaceId,
        INVITE_LIST_LIMIT,
      );
      return rows.map(inviteView);
    },

    async revokeInvite(caller: Caller, inviteId: string): Promise<void> {
      const actor = await actingOwner(caller);
      const result = await store.revokeInvite({
        id: inviteId,
        actor,
        receiptId: newId(),
      });
      switch (result.outcome) {
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "accepted":
          throw new SessionServiceError(
            "INVITE_USED",
            "The invite was already accepted",
          );
        case "actor_inactive":
          throw new SessionServiceError("FORBIDDEN", NOT_AN_OWNER);
        default:
          return;
      }
    },

    async listMembers(
      caller: Caller,
      query: ListMembersQuery,
    ): Promise<ListMembersResponse> {
      const actor = await actingOwner(caller);
      const principal = caller.subject.principal;
      // member.manage is never an API key's, so the caller is a person.
      if (principal?.kind !== "user") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "This principal does not hold member.manage",
        );
      }
      const page = await store.listMembers(actor.workspaceId, query);
      const viewer = { userId: actor.userId, role: principal.role };
      return {
        ...page,
        items: page.items.map((row) => ({
          ...memberView(row),
          actions: memberActions(viewer, row),
          administered_agents: row.administeredAgents,
          last_active_at: row.lastActiveAt?.toISOString() ?? null,
        })),
        assignable_roles: assignableRoles(principal.role),
      };
    },

    async changeMemberRole(
      caller: Caller,
      userId: string,
      role: WorkspaceRole,
    ): Promise<MemberView> {
      const actor = await actingOwner(caller);
      const result = await store.changeMemberRole({
        userId,
        role,
        actor,
        receiptId: newId(),
      });
      switch (result.outcome) {
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "last_owner":
          throw new SessionServiceError(
            "LAST_OWNER",
            "The workspace must keep at least one live owner",
          );
        case "emergency_admin":
          throw EMERGENCY_ADMIN();
        case "actor_inactive":
          throw new SessionServiceError("FORBIDDEN", NOT_AN_OWNER);
        case "owner_protected":
          throw OWNER_PROTECTED();
        case "self_protected":
          throw new SessionServiceError(
            "SELF_PROTECTED",
            "A manager cannot change their own role",
          );
        case "member_disabled":
          throw new SessionServiceError(
            "MEMBER_DISABLED",
            "The membership is disabled; enable it first",
          );
        case "account_disabled":
          throw new SessionServiceError(
            "ACCOUNT_DISABLED",
            "The account is suspended; lift the suspension first",
          );
        default:
          return memberView(result.member);
      }
    },
  };
}

export type InviteService = ReturnType<typeof createInviteService>;
