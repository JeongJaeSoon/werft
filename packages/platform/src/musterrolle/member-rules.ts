import {
  type MemberActions,
  type MemberVerdict,
  WORKSPACE_ROLE_VALUES,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { MANAGEMENT_ROLES } from "./policy.ts";

/**
 * Who may do what to a member of the workspace (design 4.1): the one place
 * the rule lives. The stores call it on the rows they locked, and the member
 * list calls it on the rows it read, so what a row offers is what a write
 * accepts.
 *
 * No count of the workspace's owners goes in. With yourself refused and an
 * owner's row only an owner's to change, the actor of any change to an owner
 * is another live owner, so the target is never the last one. Only two owners
 * demoting or disabling each other at once get there, and the write sees that
 * under its row locks (`last_owner`).
 */

export const MEMBER_MANAGER_ROLES: readonly WorkspaceRole[] =
  MANAGEMENT_ROLES["member.manage"] ?? [];

export function managesMembers(role: string): boolean {
  return (MEMBER_MANAGER_ROLES as readonly string[]).includes(role);
}

/** Only an owner grants the owner role, by invite or by a role change. */
export function mayGrantRole(
  actorRole: WorkspaceRole,
  role: WorkspaceRole,
): boolean {
  return actorRole === "owner" || role !== "owner";
}

/** The roles an invite from `actorRole` may carry, in the contract's order. */
export function assignableRoles(actorRole: WorkspaceRole): WorkspaceRole[] {
  return WORKSPACE_ROLE_VALUES.filter((role) => mayGrantRole(actorRole, role));
}

export type MemberActor = { userId: string; role: WorkspaceRole };

export function passwordResetIssueDenial(
  actor: MemberActor,
  targetUserId: string,
): "owner_required" | "self_protected" | null {
  if (actor.role !== "owner") return "owner_required";
  // A stolen session must not issue a link that replaces its own password.
  if (actor.userId === targetUserId) return "self_protected";
  return null;
}

export type MemberTarget = {
  userId: string;
  role: WorkspaceRole;
  membershipDisabled: boolean;
  /** Suspended account-wide; a membership change cannot bring them back. */
  accountDisabled: boolean;
};

export type MemberAction =
  | { kind: "change_role"; role: WorkspaceRole }
  | { kind: "disable" }
  | { kind: "enable" };

const ALLOWED: MemberVerdict = { allowed: true };
const refused = (reason: Exclude<MemberVerdict, { allowed: true }>["reason"]) =>
  ({ allowed: false, reason }) as const;

/** The actor is a live manager of the workspace; callers check that first. */
export function memberVerdict(
  actor: MemberActor,
  target: MemberTarget,
  action: MemberAction,
): MemberVerdict {
  // Turning yourself off would also end the session making the change.
  if (actor.userId === target.userId) return refused("self_protected");
  if (
    !mayGrantRole(actor.role, target.role) ||
    (action.kind === "change_role" && !mayGrantRole(actor.role, action.role))
  ) {
    return refused("owner_protected");
  }
  switch (action.kind) {
    case "change_role":
      if (target.accountDisabled) return refused("account_disabled");
      if (target.membershipDisabled) return refused("member_disabled");
      return target.role === action.role ? refused("unchanged") : ALLOWED;
    case "disable":
      return target.membershipDisabled ? refused("unchanged") : ALLOWED;
    case "enable":
      if (target.accountDisabled) return refused("account_disabled");
      return target.membershipDisabled ? ALLOWED : refused("unchanged");
  }
}

export function memberActions(
  actor: MemberActor,
  target: MemberTarget,
): MemberActions {
  const changeTo = (role: WorkspaceRole) =>
    memberVerdict(actor, target, { kind: "change_role", role });
  return {
    change_role: {
      owner: changeTo("owner"),
      admin: changeTo("admin"),
      member: changeTo("member"),
    },
    disable: memberVerdict(actor, target, { kind: "disable" }),
    enable: memberVerdict(actor, target, { kind: "enable" }),
  };
}
