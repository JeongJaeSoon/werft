import type {
  ApiKeyView,
  AuthorizationAction,
  AuthorizationResource,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ListApiKeysQuery,
  ListApiKeysResponse,
  RevokeApiKeyResponse,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import type { WorkspaceKey, WorkspaceKeyStore } from "./ports/api-key-store.ts";
import {
  requireAllowedUnrecorded,
  requirePermitted,
} from "./require-permitted.ts";
import {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
  SessionServiceError,
} from "./service-errors.ts";

// Keys issued by a person (design 4.1): their own personal key, or the key
// of an agent they administer. An API key is never a person, so the policy
// refuses it here.

export function viewOf(key: WorkspaceKey): ApiKeyView {
  return {
    id: key.id,
    kind: key.kind,
    name: key.name,
    workspace_id: key.workspaceId,
    agent_id: key.agentId,
    created_by: key.createdByUserId,
    created_by_user:
      key.createdByUserId === null || key.createdByDisplayName === null
        ? null
        : { id: key.createdByUserId, display_name: key.createdByDisplayName },
    scopes: [...key.scopes],
    created_at: key.createdAt.toISOString(),
    expires_at: key.expiresAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
  };
}

export function createApiKeyService(deps: {
  authorization: AuthorizationPolicy;
  store: WorkspaceKeyStore;
  /** A fresh secret and the hash the store keeps in its place. */
  mint: () => { secret: string; hash: Uint8Array };
  newId?: () => string;
  now?: () => Date;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  function personOf(caller: Caller): string {
    const userId = caller.actor?.userId;
    // The policy already refused anyone else; this keeps a key row from
    // ever being written without its issuer.
    if (caller.subject.principal?.kind !== "user" || !userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person issues or revokes keys",
        undefined,
        { reason_code: "role" },
      );
    }
    return userId;
  }

  // The issuer of a key write. A caller with no person is refused here, the
  // policy's refusal being the request's one row.
  async function personFor(
    caller: Caller,
    action: AuthorizationAction,
    resource: Omit<AuthorizationResource, "owner_scope">,
  ): Promise<string> {
    if (caller.subject.principal?.kind !== "user" || !caller.actor?.userId) {
      await requirePermitted(authorization, caller, action, resource);
    }
    return personOf(caller);
  }

  // The right that issuing or revoking this kind of key takes.
  function rightFor(
    caller: Caller,
    key: { kind: WorkspaceKey["kind"]; agentId: string | null },
  ): [AuthorizationAction, Omit<AuthorizationResource, "owner_scope">] {
    if (key.kind === "personal") {
      return ["api_key.manage_own", { kind: "workspace", id: caller.ownerId }];
    }
    // The contract and the table's CHECK both keep an agent key's agent.
    if (key.agentId === null) throw NOT_FOUND();
    return ["api_key.manage", { kind: "agent", id: key.agentId }];
  }

  return {
    async issue(
      caller: Caller,
      body: CreateApiKeyRequest,
    ): Promise<CreateApiKeyResponse> {
      const agentId = body.agent_id?.toLowerCase() ?? null;
      const [action, resource] = rightFor(caller, { kind: body.kind, agentId });
      const expiresAt =
        body.expires_at === undefined ? null : new Date(body.expires_at);
      if (expiresAt !== null && expiresAt.getTime() <= now().getTime()) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "expires_at must be in the future",
        );
      }
      const { secret, hash } = deps.mint();
      const id = newId();
      const receiptId = newId();
      const userId = await personFor(caller, action, resource);
      // From here the store keeps the decision, whatever it answers. It caps
      // the key by the scopes held at this decision and by the role held
      // under its lock (design 4.1: never more than the issuer holds now).
      const decision = await requireAllowedUnrecorded(
        authorization,
        caller,
        action,
        resource,
      );
      const result = await store.issue({
        decision,
        principal: caller,
        id,
        workspaceId: caller.ownerId,
        keyHash: hash,
        kind: body.kind,
        name: body.name ?? null,
        agentId,
        createdByUserId: userId,
        scopes: [...new Set(body.scopes)],
        expiresAt,
        receiptId,
        issuerRoles: MANAGEMENT_ROLES[action] ?? [],
      });
      switch (result.outcome) {
        case "issued":
          break;
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "scope_not_grantable":
          throw new SessionServiceError(
            "SCOPE_NOT_GRANTABLE",
            `The issuer does not hold ${result.beyond.join(", ")}`,
          );
        default:
          throw NOT_FOUND();
      }
      return { key: viewOf(result.key), secret, receipt_id: receiptId };
    },

    async list(
      caller: Caller,
      query: ListApiKeysQuery,
    ): Promise<ListApiKeysResponse> {
      await requirePermitted(authorization, caller, "api_key.manage_own", {
        kind: "workspace",
        id: caller.ownerId,
      });
      const userId = personOf(caller);
      // Who sees every agent key is the role table's, applied by the store
      // to the role held now; a refused probe would record a denial for
      // each listing.
      const page = await store.list(
        caller.ownerId,
        {
          personalOf: userId,
          allAgentKeysFor: MANAGEMENT_ROLES["api_key.manage"] ?? [],
        },
        query,
      );
      return { items: page.items.map(viewOf), next_cursor: page.nextCursor };
    },

    async revoke(caller: Caller, keyId: string): Promise<RevokeApiKeyResponse> {
      const userId = await personFor(caller, "api_key.manage_own", {
        kind: "workspace",
        id: caller.ownerId,
      });
      const key = await store.find(caller.ownerId, keyId);
      // Another person's personal key is not the caller's to see.
      if (!key || (key.kind === "personal" && key.createdByUserId !== userId)) {
        throw NOT_FOUND();
      }
      const [action, resource] = rightFor(caller, key);
      const receiptId = newId();
      const decision = await requireAllowedUnrecorded(
        authorization,
        caller,
        action,
        resource,
      );
      const result = await store.revoke({
        decision,
        principal: caller,
        workspaceId: caller.ownerId,
        keyId: key.id,
        receiptId,
        revokerRoles: MANAGEMENT_ROLES[action] ?? [],
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "already_revoked":
          return { key: viewOf(result.key), receipt_id: null };
        default:
          return { key: viewOf(result.key), receipt_id: receiptId };
      }
    },
  };
}
export type ApiKeyService = ReturnType<typeof createApiKeyService>;
