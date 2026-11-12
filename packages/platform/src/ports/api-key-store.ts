import type {
  PaginationQuery,
  SessionScope,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/index.ts";

export type WorkspaceKey = {
  id: string;
  workspaceId: string;
  kind: "personal" | "agent";
  name: string | null;
  /** Set exactly on an agent key: the agent whose sessions it reaches. */
  agentId: string | null;
  /** Who issued it; null on keys from before the API issued them. */
  createdByUserId: string | null;
  /** The issuer's display name now, set whenever createdByUserId is. */
  createdByDisplayName: string | null;
  scopes: SessionScope[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export type IssueKeyInput = {
  principal: Principal;
  id: string;
  workspaceId: string;
  keyHash: Uint8Array;
  kind: WorkspaceKey["kind"];
  name: string | null;
  agentId: string | null;
  createdByUserId: string;
  scopes: readonly SessionScope[];
  expiresAt: Date | null;
  receiptId: string;
  /**
   * The roles that may issue this key, re-read under the issuer's
   * membership lock along with the scope ceiling of the role they hold
   * then; a key bound to an agent may also come from its admins.
   */
  issuerRoles: readonly WorkspaceRole[];
};

export type IssueKeyResult =
  | { outcome: "issued"; key: WorkspaceKey }
  | {
      outcome:
        | "actor_inactive"
        | "agent_not_found"
        | "outranked"
        | "scope_not_grantable";
    };

export type RevokeKeyResult =
  | { outcome: "revoked" | "already_revoked"; key: WorkspaceKey }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * Which keys a list shows: the caller's own personal keys, plus every
 * agent key while their current role is one of `allAgentKeysFor`, or else
 * the keys of the agents they administer.
 */
export type KeyListFilter = {
  personalOf: string;
  allAgentKeysFor: readonly WorkspaceRole[];
};

export interface WorkspaceKeyStore {
  issue(input: IssueKeyInput): Promise<IssueKeyResult>;
  find(workspaceId: string, keyId: string): Promise<WorkspaceKey | null>;
  /** One page, newest first; a malformed cursor throws InvalidCursorError. */
  list(
    workspaceId: string,
    filter: KeyListFilter,
    query: PaginationQuery,
  ): Promise<{ items: WorkspaceKey[]; nextCursor: string | null }>;
  revoke(input: {
    principal: Principal;
    workspaceId: string;
    keyId: string;
    receiptId: string;
    /**
     * The roles that may revoke this key, re-read as on issue; a key bound
     * to an agent may also go by its admins.
     */
    revokerRoles: readonly WorkspaceRole[];
  }): Promise<RevokeKeyResult>;
}
