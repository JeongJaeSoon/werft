import type { SecretPurpose, WorkspaceRole } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/index.ts";
import {
  STORED_OWNER_KINDS,
  type StoredOwnerKind,
} from "../sessions/catalog.ts";

/**
 * Who a secret belongs to: the workspace itself (the App Configuration
 * Token), one Slack app of it (that app's signing secret, client secret
 * and bot token) or its GitHub App (the private key); or an installation
 * settings row (a connection's, repository's or MCP server's stored
 * credential) or a login provider (its client secret), kept under the
 * default workspace for the table's foreign key but never the workspace's
 * to read or remove.
 */
export type SecretOwner =
  | { kind: "workspace" }
  | { kind: "slack_app" | "github_app"; id: string }
  | { kind: InstallationOwnerKind; id: string };

const INSTALLATION_OWNER_KINDS = [
  ...STORED_OWNER_KINDS,
  "login_provider",
] as const;
type InstallationOwnerKind = StoredOwnerKind | "login_provider";

export type SecretSlot = {
  workspaceId: string;
  owner: SecretOwner;
  purpose: SecretPurpose;
};

/** The owner as stored and bound into the ciphertext's AAD. */
export type SecretOwnerRef =
  | "workspace"
  | `slack_app:${string}`
  | `github_app:${string}`
  | `${InstallationOwnerKind}:${string}`;

/** An owner that is the installation's: no workspace route may name it. */
export function isSettingsSecretOwner(
  owner: SecretOwner,
): owner is { kind: InstallationOwnerKind; id: string } {
  return (INSTALLATION_OWNER_KINDS as readonly string[]).includes(owner.kind);
}

export function secretOwnerRef(owner: SecretOwner): SecretOwnerRef {
  if (owner.kind === "workspace") return "workspace";
  // Exactly as a definition's `stored` reference names it.
  if (isSettingsSecretOwner(owner)) return `${owner.kind}:${owner.id}`;
  return `${owner.kind}:${owner.id.toLowerCase()}`;
}

/** Everything about a stored secret except its value. */
export type SecretSummary = {
  last4: string;
  secretVersion: number;
  updatedAt: Date;
  /** The console user who last set it; null for a value the server wrote. */
  updatedBy: { userId: string; displayName: string } | null;
};

/**
 * A write made by a person through the API: their role is re-read under
 * lock against `roles`, and a receipt naming the purpose and last four
 * characters is written in the same transaction.
 */
export type SecretAudit = {
  principal: Principal;
  receiptId: string;
  roles: readonly WorkspaceRole[];
};

export type PutSecretResult =
  | { outcome: "stored"; summary: SecretSummary }
  | { outcome: "actor_inactive" | "outranked" | "workspace_not_found" };

export type DeleteSecretResult =
  | { outcome: "deleted"; last4: string }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * Encrypted runtime secrets (AES-256-GCM under the master key). Values go in
 * and, for server code only, come out; nothing here hands a value to a
 * route. One value per slot: a put replaces it under a new version.
 */
export interface SecretStore {
  describe(slot: SecretSlot): Promise<SecretSummary | null>;
  /** The value, for the server's own Slack calls; null when none is set. */
  get(slot: SecretSlot): Promise<string | null>;
  put(
    slot: SecretSlot,
    value: string,
    options?: { audit?: SecretAudit },
  ): Promise<PutSecretResult>;
  delete(
    slot: SecretSlot,
    options?: { audit?: SecretAudit },
  ): Promise<DeleteSecretResult>;
}
