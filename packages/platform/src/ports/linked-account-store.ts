import type {
  LinkedAccountProvider,
  LinkedAccountStatus,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/index.ts";

export type LinkedAccountRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  provider: LinkedAccountProvider;
  externalTenant: string;
  externalUserId: string;
  externalTenantName: string | null;
  externalUserName: string | null;
  status: LinkedAccountStatus;
  verifiedAt: Date;
  revision: number;
};

export type ExternalAccountRef = {
  provider: LinkedAccountProvider;
  externalTenant: string;
  externalUserId: string;
};

/** Names the provider gave at verification; display only, never matched on. */
export type ExternalAccountNames = {
  externalTenantName: string | null;
  externalUserName: string | null;
};

/** What a decision carries forward and compares at processing time. */
export type LinkedAccountRef = { id: string; revision: number };

/**
 * The external account as it resolves now (design A.7). Only `linked` names
 * someone to act as; the rest say why not:
 * - `unlinked`: never linked, or the person unlinked it.
 * - `stale`: the provider reported the account deactivated.
 * - `revoked`: the person was offboarded.
 * - `disabled`: the link is live but the user or membership is not.
 */
export type LinkedSubject =
  | {
      status: "linked";
      linkedAccount: LinkedAccountRef;
      userId: string;
      workspaceId: string;
      role: WorkspaceRole;
    }
  | { status: "unlinked" }
  | {
      status: "stale" | "revoked" | "disabled";
      linkedAccount: LinkedAccountRef;
      userId: string;
      workspaceId: string;
    };

export type LinkAccountResult =
  | { outcome: "linked"; account: LinkedAccountRecord; receiptId: string }
  // The workspace has no verified Slack install at all.
  | { outcome: "not_installed" }
  | { outcome: "team_mismatch"; workspaceName: string }
  // Linked to someone else.
  | { outcome: "taken" }
  // The caller already linked another account in that team.
  | { outcome: "exists" }
  | { outcome: "actor_inactive" };

export type UnlinkAccountResult =
  | { outcome: "unlinked"; receiptId: string }
  | { outcome: "not_found" };

export type MarkStaleResult =
  | { outcome: "stale"; account: LinkedAccountRecord }
  | { outcome: "not_found" };

export interface LinkedAccountStore {
  /** Team ids of the workspace's verified Slack installs. */
  installedSlackTeams(workspaceId: string): Promise<string[]>;
  /**
   * Links the account to the caller after checking, under the membership
   * lock, that no one else holds it and, for Slack, that its team is
   * installed for the workspace (a GitHub account has no team to check). The caller's own active or stale link to the same account is
   * re-verified and made active, its names replaced by these. Writes a
   * `link_account` receipt.
   */
  link(input: {
    principal: Principal;
    workspaceId: string;
    userId: string;
    account: ExternalAccountRef;
    names: ExternalAccountNames;
  }): Promise<LinkAccountResult>;
  /** Revokes the caller's own link and writes an `unlink_account` receipt. */
  unlink(input: {
    principal: Principal;
    workspaceId: string;
    userId: string;
    linkedAccountId: string;
  }): Promise<UnlinkAccountResult>;
  /** The caller's links that still resolve (active or stale). */
  list(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<LinkedAccountRecord[]>;
  /** Read at processing time; never cached. */
  resolveLinkedSubject(account: ExternalAccountRef): Promise<LinkedSubject>;
  /** For the provider's deactivation event: an active link turns stale. */
  markStale(account: ExternalAccountRef): Promise<MarkStaleResult>;
}
