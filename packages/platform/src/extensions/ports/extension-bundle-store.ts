import type {
  SkillAvailability,
  SkillCheckFinding,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";
import type { BundleManifest } from "../bundle-validator.ts";
import type { ExtensionMode } from "../resolve.ts";
import type {
  SkillGitLocation,
  SkillGitSource,
  SkillSyncTrigger,
} from "./skill-git-source-store.ts";
import type {
  SkillGateFindingRecord,
  SkillRepositoryTrigger,
} from "./skill-repository-store.ts";

/**
 * What approves a version of a registered repository's skill: registering
 * the repository approved its content, the switch offers this skill, and the
 * gate passed these bytes. The write re-reads all of it under the skill's
 * name lock and writes nothing when any of it changed since the check read
 * it: the repository removed, restored or pointed at another ref (its
 * generation), its check taken over (the lease), the switch turned off or on
 * again (the grant).
 */
export type RepositoryApprovalInput = {
  skillRepositoryId: string;
  /** The listed directory (`skill_repository_skills` row). */
  skillId: string;
  generation: number;
  leaseToken: string;
  grantId: string;
  /** What started the repository's check; kept with the skill's last check. */
  trigger: SkillRepositoryTrigger;
  /** The directory's git tree at the commit, recorded as passed with the version. */
  treeSha: string;
  /**
   * The gate's pass of this content against `baselineId`, the approved
   * version before it when the gate ran (null: none). Null when the gate did
   * not run, because the content already was an approved version: a version
   * still waiting is then left as it is.
   */
  gate: {
    baselineId: string | null;
    warnings: SkillGateFindingRecord[];
    notices: SkillGateFindingRecord[];
  } | null;
};

/**
 * A GitHub version of a skill. With
 * `newSource` it is the first registration, by a person, and the source row
 * is written with it. Without, the principal is the sync: the version is
 * written under the source row's lock once its settings are read again, and
 * the outcome is recorded as the skill's last check.
 */
export type GitVersionInput = {
  location: SkillGitLocation;
  trigger: SkillSyncTrigger;
  checkedAt: Date;
  newSource?: Pick<
    SkillGitSource,
    "connectionId" | "installationId" | "access" | "repositoryId" | "repository"
  >;
  /** The sync's lease token; a check that lost its lease writes nothing. */
  leaseToken?: string;
  /**
   * Set for a source whose auto-approve was on when the check read it, with
   * the source's `grantId` then. The version this content is (a new one,
   * or one still `pending`) is approved only when sync and auto-approve
   * are still on with that same grant (no off, pause or resume since),
   * under the source row's lock.
   */
  auto?: {
    grantId: string;
    /**
     * The fixed-rule checks of the tree against `baselineId`, the approved
     * version before it when they ran (null: none). Any finding, or another
     * approved version before it under the lock, leaves it `pending`.
     */
    checks: { baselineId: string | null; findings: SkillCheckFinding[] };
  };
  /**
   * Set for a skill of a registered repository, never with `newSource` or
   * `auto`: the version is written approved and current, or not at all.
   */
  repository?: RepositoryApprovalInput;
};

export const EXTENSION_BUNDLE_REVIEWS = [
  "pending",
  "approved",
  "rejected",
  // Closed while awaiting review: a newer version was approved or made current.
  "superseded",
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
  /** Null on a version the Git sync made. */
  registeredBy: string | null;
  /** Where a GitHub version was read and what started the check. */
  git: (SkillGitLocation & { trigger: SkillSyncTrigger }) | null;
  registeredAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  /**
   * The registration order of a skill's name (1, 2, …). Null on a bundle
   * from before skills: it keeps its slug and no new version joins it.
   */
  version: number | null;
  /** Set once the version is archived: nothing may attach it again. */
  archivedAt: Date | null;
  /** The skill's current version, which following attachments resolve to. */
  current: boolean;
};

export type RegisterExtensionBundleResult =
  | { outcome: "registered"; bundle: ExtensionBundle; receiptId: string }
  /** The same content was registered before: nothing changes, no receipt. */
  | { outcome: "already_registered"; bundle: ExtensionBundle }
  /** A bundle from before skills holds the name as its slug. */
  | { outcome: "actor_inactive" | "outranked" | "name_taken" }
  /**
   * The name's source is the other one: an upload to a GitHub skill, a
   * GitHub registration of a name that has versions, or a sync of a source
   * that is gone.
   */
  | { outcome: "source_mismatch" }
  /** A version by any check but "지금 확인" while sync is paused. */
  | { outcome: "paused" }
  /** The sync's check whose lease another check took over. */
  | { outcome: "lease_lost" }
  /**
   * A repository skill's version whose repository or switch is no longer
   * what its check read (`RepositoryApprovalInput`): nothing is written.
   */
  | { outcome: "stale" }
  /**
   * A repository skill whose name another skill of the workspace holds:
   * nothing is written but the switch, which is turned off.
   */
  | { outcome: "name_conflict" }
  /**
   * A repository skill's content that is a version a manager rejected or
   * archived: it stays out, whatever the gate says.
   */
  | { outcome: "withheld"; bundle: ExtensionBundle }
  /**
   * A repository skill's version whose approved version before it is not the
   * one the gate compared it with: nothing is written, the next check judges
   * it again.
   */
  | { outcome: "baseline_changed" };

export type ReviewExtensionBundleResult =
  | {
      outcome: "reviewed";
      bundle: ExtensionBundle;
      receiptId: string;
      /** The one manager of the workspace reviewed what they registered. */
      selfReview: boolean;
    }
  | { outcome: "unchanged"; bundle: ExtensionBundle }
  | { outcome: "not_found" | "actor_inactive" | "outranked" }
  /** The registrant, while another manager could review it. */
  | { outcome: "self_review" | "archived" }
  /**
   * An approval of a registered repository's skill: only its gate approves a
   * version. A rejection is taken, and stays.
   */
  | { outcome: "repository_skill" };

export type RevertSkillResult =
  | {
      outcome: "reverted";
      from: ExtensionBundle;
      to: ExtensionBundle;
      receiptId: string;
    }
  | { outcome: "not_found" | "actor_inactive" | "outranked" }
  /** No current version, or none approved and not archived below it. */
  | { outcome: "no_previous_version" }
  /** A registered repository's skill follows its repository; the next check would undo the step. */
  | { outcome: "repository_skill" };

export type AttachmentReceiptResult =
  | { outcome: "recorded"; receiptId: string }
  | { outcome: "bundle_not_found" | "agent_not_found" | "actor_inactive" }
  | { outcome: "outranked" }
  /** Only an approved version is offered, and never an archived one. */
  | { outcome: "not_approved" | "archived" }
  /** A detach with nothing of that version attached there: no receipt. */
  | { outcome: "not_attached" }
  /**
   * A skill of a registered repository whose switch is off or whose
   * repository is removed; only forbidding it is recorded.
   */
  | { outcome: "unavailable"; availability: Exclude<SkillAvailability, "ok"> }
  /** A skill of a registered repository is attached to an agent only. */
  | { outcome: "repository_skill_workspace" };

export type ArchiveExtensionBundleResult =
  | { outcome: "archived"; bundle: ExtensionBundle; receiptId: string }
  | { outcome: "unchanged"; bundle: ExtensionBundle }
  | { outcome: "not_found" | "actor_inactive" | "outranked" | "self_review" }
  /**
   * A scope still attaches it or follows it as the current version, or a
   * live session runs it.
   */
  | { outcome: "attached" | "in_use" | "current" };

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
   * first row as it is, whatever label or source it brings. With `skill`,
   * the row takes the next version of its name, and a name a bundle from
   * before skills holds is refused.
   */
  register(input: {
    skill?: boolean;
    git?: GitVersionInput;
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
  /**
   * Sets the review state and writes the `approve_extension` receipt. The
   * registrant may review their own version only while no other member holds
   * a manager role; the receipt says so.
   */
  review(input: {
    receiptId: string;
    workspaceId: string;
    bundleId: string;
    review: "approved" | "rejected";
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<ReviewExtensionBundleResult>;
  /**
   * Moves the skill's current version one step down: to the highest
   * approved, not archived version below it. Writes `revert_extension`.
   */
  revert(input: {
    receiptId: string;
    workspaceId: string;
    name: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<RevertSkillResult>;
  /**
   * Offers a bundle version to a workspace or to one agent (or takes it
   * back) and writes the `attach_extension` or `detach_extension` receipt in
   * the same transaction. A scope holds one version per bundle name:
   * attaching another version of a name replaces the earlier row.
   * `scope` defaults to `agent`, which needs `agentId`; a `workspace`
   * attachment names no agent. `mode` defaults to `optional`. On an agent,
   * `managerRoles` are the workspace roles that manage every agent; the
   * agent's own managers pass too. With `follow`, the row names the skill
   * `bundleId` belongs to and follows its current version (never
   * `forbidden`); a detach then takes back the following row.
   */
  recordAttachment(input: {
    receiptId: string;
    workspaceId: string;
    bundleId: string;
    follow?: boolean;
    scope?: "agent" | "workspace";
    agentId?: string;
    mode?: ExtensionMode;
    kind: "attach" | "detach";
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<AttachmentReceiptResult>;
  /**
   * Marks a version archived and writes the `archive_extension` receipt. A
   * version a scope attaches or a session that has not ended runs is
   * refused; the object stays for the checkpoints that name its digest.
   */
  archive(input: {
    receiptId: string;
    workspaceId: string;
    bundleId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<ArchiveExtensionBundleResult>;
  /**
   * The bundles the workspace offers, and with `agentId` those its agent
   * offers, each with the version it names; a following row with the
   * skill's current version, or null while it has none.
   */
  listAttachments(input: {
    workspaceId: string;
    agentId?: string;
  }): Promise<ExtensionAttachment[]>;
  /**
   * The skills of the workspace's registered repositories, by name, and
   * whether a new session takes each. A name absent is no repository's skill.
   */
  repositorySkills(
    workspaceId: string,
  ): Promise<Map<string, SkillAvailability>>;
}

export type ExtensionAttachment = {
  scope: "workspace" | "agent";
  mode: ExtensionMode;
  name: string;
  follows: boolean;
  bundle: ExtensionBundle | null;
  availability: SkillAvailability;
};
