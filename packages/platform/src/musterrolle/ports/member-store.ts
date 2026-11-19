import type { AuthorizationReason, SessionStatus } from "@werft-ai/contracts";
import type { ActingOwner, MemberRecord } from "../../ports/identity-store.ts";
import type { Principal } from "../index.ts";
import type { RefusalOf, UnrecordedAllow } from "./decision-log.ts";

/** A workspace membership, or the account across every workspace. */
export type AccessScope = "membership" | "account";

export type AccessEffects =
  | {
      disabled: true;
      revokedWebSessions: number;
      revokedPersonalKeys: number;
      revokedLinkedAccounts: number;
      sessionsAwaitingTakeover: number;
    }
  | { disabled: false; sessionsReleased: number };

export type SetAccessResult =
  | {
      outcome: "changed";
      member: MemberRecord;
      receiptId: string;
      effects: AccessEffects;
    }
  | { outcome: "unchanged"; member: MemberRecord }
  | { outcome: "not_found" }
  | { outcome: "last_owner" }
  /** The emergency admin is not turned off; name another one first. */
  | { outcome: "emergency_admin" }
  /** The account also belongs to a workspace the actor does not manage. */
  | { outcome: "elsewhere" }
  /** The target is an owner where the actor is not. */
  | { outcome: "outranked" }
  // What `memberVerdict` refuses besides an outranked actor.
  | { outcome: "self_protected" | "account_disabled" }
  | { outcome: "actor_inactive" };

const ACCESS_REFUSALS: Partial<
  Record<SetAccessResult["outcome"], AuthorizationReason>
> = {
  actor_inactive: "role",
  elsewhere: "role",
  outranked: "owner_protected",
  self_protected: "self_protected",
  last_owner: "last_owner",
  emergency_admin: "emergency_admin",
};

/**
 * The rules among the outcomes. The rest answer for the state the allowed
 * act met (gone, already so, suspended), so the allow stands.
 */
export const accessRefusal: RefusalOf<SetAccessResult["outcome"]> = (outcome) =>
  ACCESS_REFUSALS[outcome] ?? null;

export type TakeoverRecord = {
  sessionId: string;
  departedUserId: string;
  status: SessionStatus;
  createdAt: Date;
  takeoverRequiredAt: Date;
};

export type TakeOverResult =
  | { outcome: "taken_over"; receiptId: string }
  | { outcome: "not_found" }
  | { outcome: "not_awaiting" }
  | { outcome: "actor_inactive" };

export interface MemberStore {
  /**
   * Disabling, in one transaction with its receipt: the membership (or the
   * account) disabled, every web session of the user revoked, their personal
   * keys and linked accounts revoked, and every open session they asked for
   * marked as awaiting takeover. Enabling restores none of the sessions or keys; it only
   * releases the sessions still waiting for them. The actor is re-checked as
   * a member manager under the same locks. `decision` is kept in that
   * transaction as `accessRefusal` reads the outcome.
   */
  setAccess(input: {
    decision: UnrecordedAllow;
    actor: ActingOwner;
    userId: string;
    scope: AccessScope;
    disabled: boolean;
    reason: string | null;
    receiptId: string;
  }): Promise<SetAccessResult>;
  listAwaitingTakeover(
    workspaceId: string,
    limit: number,
  ): Promise<TakeoverRecord[]>;
  takeOver(input: {
    principal: Principal;
    workspaceId: string;
    sessionId: string;
    newRequesterId: string;
    /** Kept on the receipt when the taker gave one. */
    justification?: string | null;
  }): Promise<TakeOverResult>;
}
