import {
  CREDENTIAL_REVOKE_NOTICE,
  type CreateCredentialBindingRequest,
  type CreateCredentialBindingResponse,
  type CredentialBindingView,
  type ListCredentialBindingsResponse,
  type RevokeCredentialBindingResponse,
} from "@werft-ai/contracts";
import type {
  CredentialBinding,
  CredentialBindingStore,
} from "../ports/credential-binding-store.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
  SessionServiceError,
} from "./service-errors.ts";

// Binding a credential name to an agent (design 4.4, D11): owners, admins
// and that agent's admins, never a key. The value never reaches Werft.

const BINDERS = MANAGEMENT_ROLES["credential.bind"] ?? [];

export function bindingViewOf(
  binding: CredentialBinding,
): CredentialBindingView {
  return {
    id: binding.id,
    agent_id: binding.agentId,
    credential_ref: binding.credentialRef,
    bound_by: binding.boundBy,
    bound_at: binding.boundAt.toISOString(),
    revoked_at: binding.revokedAt?.toISOString() ?? null,
    running_sessions: binding.runningSessions,
  };
}

export function createCredentialBindingService(deps: {
  authorization: AuthorizationPolicy;
  store: CredentialBindingStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function bindOn(caller: Caller, agentId: string): Promise<string> {
    await requirePermitted(authorization, caller, "credential.bind", {
      kind: "agent",
      id: agentId,
    });
    const userId = caller.actor?.userId;
    if (caller.subject.principal?.kind !== "user" || !userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person binds credentials",
        undefined,
        { reason_code: "role" },
      );
    }
    return userId;
  }

  return {
    async list(
      caller: Caller,
      agentId: string,
    ): Promise<ListCredentialBindingsResponse> {
      await requirePermitted(authorization, caller, "agent.settings_read", {
        kind: "agent",
        id: agentId,
      });
      const bindings = await store.list(caller.ownerId, agentId);
      if (bindings === null) throw NOT_FOUND();
      return {
        items: bindings.map(bindingViewOf),
        revoke_notice: CREDENTIAL_REVOKE_NOTICE,
      };
    },

    async bind(
      caller: Caller,
      agentId: string,
      body: CreateCredentialBindingRequest,
    ): Promise<CreateCredentialBindingResponse> {
      const userId = await bindOn(caller, agentId);
      const receiptId = newId();
      const result = await store.bind({
        principal: caller,
        id: newId(),
        workspaceId: caller.ownerId,
        agentId,
        credentialRef: body.credential_ref,
        boundBy: userId,
        receiptId,
        binderRoles: BINDERS,
      });
      switch (result.outcome) {
        case "bound":
        case "already_bound": {
          const created = result.outcome === "bound";
          return {
            binding: bindingViewOf(result.binding),
            created,
            receipt_id: created ? receiptId : null,
          };
        }
        case "ref_in_use":
          throw new SessionServiceError(
            "CREDENTIAL_REF_IN_USE",
            `Credential ${body.credential_ref} belongs to an agent identity`,
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    async revoke(
      caller: Caller,
      agentId: string,
      bindingId: string,
    ): Promise<RevokeCredentialBindingResponse> {
      await bindOn(caller, agentId);
      const receiptId = newId();
      const result = await store.revoke({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        bindingId,
        receiptId,
        revokerRoles: BINDERS,
      });
      switch (result.outcome) {
        case "revoked":
          return {
            binding: bindingViewOf(result.binding),
            revoke_notice: CREDENTIAL_REVOKE_NOTICE,
            receipt_id: receiptId,
          };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type CredentialBindingService = ReturnType<
  typeof createCredentialBindingService
>;
