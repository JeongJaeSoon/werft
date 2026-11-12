import {
  type ListTakeoversResponse,
  type MemberView,
  TAKEOVER_LIST_LIMIT,
  type TakeOverSessionResponse,
} from "@werft-ai/contracts";
import type {
  AccessEffects,
  AccessScope,
  MemberStore,
} from "../ports/member-store.ts";
import { memberView } from "./invite-service.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import { SessionServiceError } from "./service-errors.ts";

/** `receiptId` and `effects` are null when the state was already as asked. */
export type AccessChange = {
  member: MemberView;
  receiptId: string | null;
  effects: AccessEffects | null;
};

export function createMemberService(deps: {
  authorization: AuthorizationPolicy;
  store: MemberStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  function personOf(caller: Caller): string {
    const userId = caller.actor?.userId;
    if (!userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "This principal does not hold member.manage",
      );
    }
    return userId;
  }

  async function setAccess(
    caller: Caller,
    input: {
      scope: AccessScope;
      userId: string;
      disabled: boolean;
      reason: string | null;
    },
  ): Promise<AccessChange> {
    await requirePermitted(authorization, caller, "member.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const actingUserId = personOf(caller);
    const workspaceId = caller.actor?.workspaceId;
    if (!workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "This principal does not hold member.manage",
      );
    }
    const result = await store.setAccess({
      actor: { principal: caller, workspaceId, userId: actingUserId },
      userId: input.userId.toLowerCase(),
      scope: input.scope,
      disabled: input.disabled,
      reason: input.reason,
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
      case "elsewhere":
        throw new SessionServiceError(
          "FORBIDDEN",
          "The account also belongs to a workspace this principal does not manage",
        );
      case "outranked":
        throw new SessionServiceError(
          "OWNER_PROTECTED",
          "Only an owner can change an owner's access",
        );
      case "self_protected":
        throw new SessionServiceError(
          "SELF_PROTECTED",
          "A manager cannot change their own access",
        );
      case "account_disabled":
        throw new SessionServiceError(
          "ACCOUNT_DISABLED",
          "The account is suspended; lift the suspension instead",
        );
      case "actor_inactive":
        throw new SessionServiceError(
          "FORBIDDEN",
          "This principal no longer manages the workspace's members",
        );
      case "unchanged":
        return {
          member: memberView(result.member),
          receiptId: null,
          effects: null,
        };
      default:
        return {
          member: memberView(result.member),
          receiptId: result.receiptId,
          effects: result.effects,
        };
    }
  }

  const access =
    (scope: AccessScope, disabled: boolean) =>
    (caller: Caller, userId: string, reason: string | null = null) =>
      setAccess(caller, { scope, userId, disabled, reason });

  return {
    disableMember: access("membership", true),
    enableMember: access("membership", false),
    disableUser: access("account", true),
    enableUser: access("account", false),

    async listTakeovers(caller: Caller): Promise<ListTakeoversResponse> {
      await requirePermitted(authorization, caller, "member.manage", {
        kind: "workspace",
        id: caller.ownerId,
      });
      const rows = await store.listAwaitingTakeover(
        caller.ownerId,
        TAKEOVER_LIST_LIMIT,
      );
      return {
        items: rows.map((row) => ({
          session_id: row.sessionId,
          departed_user_id: row.departedUserId,
          status: row.status,
          created_at: row.createdAt.toISOString(),
          takeover_required_at: row.takeoverRequiredAt.toISOString(),
        })),
      };
    },

    async takeOverSession(
      caller: Caller,
      sessionId: string,
      // Required by the policy when the session is outside the caller's
      // share; it then rides on the decision and the receipt.
      justification: string | null = null,
    ): Promise<TakeOverSessionResponse> {
      await requirePermitted(
        authorization,
        caller,
        "member.manage",
        { kind: "session", id: sessionId },
        justification ?? undefined,
      );
      const result = await store.takeOver({
        principal: caller,
        workspaceId: caller.ownerId,
        sessionId,
        newRequesterId: personOf(caller),
        justification,
      });
      switch (result.outcome) {
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "not_awaiting":
          throw new SessionServiceError(
            "REQUEST_STALE",
            "Session is not awaiting a takeover",
          );
        case "actor_inactive":
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
        default:
          return { receipt_id: result.receiptId, receipt_status: "succeeded" };
      }
    },
  };
}

export type MemberService = ReturnType<typeof createMemberService>;
