import type { WorkspaceRole } from "@werft-ai/contracts";
import type { BundleManifest } from "../extensions/bundle-validator.ts";
import type { ExtensionMode } from "../extensions/resolve.ts";
import type { Principal } from "../musterrolle/policy.ts";

export const EXTENSION_BUNDLE_REVIEWS = [
  "pending",
  "approved",
  "rejected",
] as const;
export type ExtensionBundleReview = (typeof EXTENSION_BUNDLE_REVIEWS)[number];

export const EXTENSION_BUNDLE_SOURCES = ["upload", "github"] as const;
export type ExtensionBundleSource = (typeof EXTENSION_BUNDLE_SOURCES)[number];

/**
 * One registration of a bundle. The digest names the content; everything else
 * here (label, source, who registered it, its review) is bookkeeping that can
 * change without changing the digest.
 */
export type ExtensionBundle = {
  id: string;
  workspaceId: string;
  /** The plugin slug the validator checked; it is also in plugin.json. */
  name: string;
  digest: string;
  label: string;
  source: ExtensionBundleSource;
  sizeBytes: number;
  manifest: BundleManifest;
  review: ExtensionBundleReview;
  registeredBy: string;
  registeredAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
};

export type RegisterExtensionBundleResult =
  | { outcome: "registered"; bundle: ExtensionBundle; receiptId: string }
  /** The same content was registered before: nothing changes, no receipt. */
  | { outcome: "already_registered"; bundle: ExtensionBundle }
  | { outcome: "actor_inactive" | "outranked" };

export type ReviewExtensionBundleResult =
  | { outcome: "reviewed"; bundle: ExtensionBundle; receiptId: string }
  | { outcome: "unchanged"; bundle: ExtensionBundle }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

export type AttachmentReceiptResult =
  | { outcome: "recorded"; receiptId: string }
  | { outcome: "bundle_not_found" | "agent_not_found" | "actor_inactive" }
  | { outcome: "outranked" };

/**
 * Stored bundles, one workspace's at a time. A bundle row is only ever written
 * for content the validator rebuilt; the files themselves are in the object
 * store under the digest.
 */
export interface ExtensionBundleStore {
  find(workspaceId: string, id: string): Promise<ExtensionBundle | null>;
  findByDigest(
    workspaceId: string,
    digest: string,
  ): Promise<ExtensionBundle | null>;
  list(workspaceId: string): Promise<ExtensionBundle[]>;
  /**
   * Whether the principal may manage bundles here. A fast refusal before an
   * object is written; every write below still checks again under its lock.
   */
  mayManage(input: {
    workspaceId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<"ok" | "actor_inactive" | "outranked">;
  /**
   * Inserts the row and its `register_extension` receipt in one transaction.
   * A second registration of the same digest in the workspace leaves the
   * first row as it is, whatever label or source it brings.
   */
  register(input: {
    id: string;
    receiptId: string;
    workspaceId: string;
    name: string;
    digest: string;
    label: string;
    source: ExtensionBundleSource;
    sizeBytes: number;
    manifest: BundleManifest;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<RegisterExtensionBundleResult>;
  /** Sets the review state and writes the `approve_extension` receipt. */
  review(input: {
    receiptId: string;
    workspaceId: string;
    bundleId: string;
    review: Exclude<ExtensionBundleReview, "pending">;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<ReviewExtensionBundleResult>;
  /**
   * Offers a bundle version to a workspace or to one agent (or takes it
   * back) and writes the `attach_extension` or `detach_extension` receipt in
   * the same transaction. A scope holds one version per bundle name:
   * attaching another version of a name replaces the earlier row.
   * `scope` defaults to `agent`, which needs `agentId`; a `workspace`
   * attachment names no agent. `mode` defaults to `optional`.
   */
  recordAttachment(input: {
    receiptId: string;
    workspaceId: string;
    bundleId: string;
    scope?: "agent" | "workspace";
    agentId?: string;
    mode?: ExtensionMode;
    kind: "attach" | "detach";
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<AttachmentReceiptResult>;
  /**
   * The bundles the workspace offers, and with `agentId` those its agent
   * offers, each with the version it names.
   */
  listAttachments(input: {
    workspaceId: string;
    agentId?: string;
  }): Promise<ExtensionAttachment[]>;
}

export type ExtensionAttachment = {
  scope: "workspace" | "agent";
  mode: ExtensionMode;
  bundle: ExtensionBundle;
};
