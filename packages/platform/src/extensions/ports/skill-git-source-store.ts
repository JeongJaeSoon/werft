import type {
  SkillAutoApprovalReason,
  SkillSyncResult,
  SkillSyncTriggerKind,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";

/** What started a check of a GitHub skill. */
export type SkillSyncTrigger = {
  kind: SkillSyncTriggerKind;
  /** `X-GitHub-Delivery` of a webhook; null for the other kinds. */
  deliveryId: string | null;
  /** The person who registered, pressed "지금 확인" or resumed. */
  userId: string | null;
};

export type SkillSyncIssue = { path: string; code: string; message: string };

export type SkillSyncCheck = {
  at: Date;
  trigger: SkillSyncTrigger;
  commit: string | null;
  result: SkillSyncResult;
  versionId: string | null;
  issues: SkillSyncIssue[];
  /** A new version's auto-approval; null when auto-approve was off. */
  autoApproval: SkillAutoApproval | null;
};

/** The rule that requires a reviewed pull request on the branch. */
export type SkillProtectionRule = {
  kind: "ruleset" | "branch_protection";
  requiredReviews: number;
};

/**
 * What GitHub showed about the ref and the commit, for auto-approve. Read
 * without a commit (when it is turned on), only the branch and its rule.
 */
export type SkillProtectionEvidence =
  | { met: true; rule: SkillProtectionRule; pullRequest: number | null }
  | { met: false; reason: SkillAutoApprovalReason };

export type SkillAutoApproval = {
  result: "approved" | "pending";
  reason: SkillAutoApprovalReason | null;
  rule: SkillProtectionRule | null;
  pullRequest: number | null;
};

export type SkillAutoApproveState = {
  state: "off" | "requested" | "on";
  requestedBy: string | null;
  consentedBy: string | null;
  /**
   * The receipt that last changed settings while on (the consent, a pause,
   * a resume); null unless on.
   */
  grantId: string | null;
};

/** Where a GitHub version was read, kept on the version. */
export type SkillGitLocation = {
  repositoryId: number;
  path: string;
  ref: string;
  commit: string;
};

export type SkillGitSource = {
  workspaceId: string;
  name: string;
  /** The author App connection that reads it; once removed, checks fail. */
  connectionId: string;
  installationId: number;
  repositoryId: number;
  /** `owner/name` when it was registered. */
  repository: string;
  path: string;
  ref: string;
  syncEnabled: boolean;
  autoApprove: SkillAutoApproveState;
  lastCheck: SkillSyncCheck | null;
};

export type SetAutoApproveResult =
  | { outcome: "updated"; source: SkillGitSource; receiptId: string }
  | { outcome: "unchanged"; source: SkillGitSource }
  | { outcome: "not_found" | "actor_inactive" | "outranked" }
  /** A consent by the manager who requested, while another could consent. */
  | { outcome: "self_consent" }
  /** A consent with nothing requested. */
  | { outcome: "not_requested" };

export type SetSkillSyncResult =
  | { outcome: "updated"; source: SkillGitSource; receiptId: string }
  | { outcome: "unchanged"; source: SkillGitSource }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * GitHub skills' sources and their sync. A check takes the skill with
 * `begin`, so one runs at a time across replicas; a trigger that arrives
 * meanwhile is kept and `finish` hands it back for one more run.
 */
export interface SkillGitSourceStore {
  get(workspaceId: string, name: string): Promise<SkillGitSource | null>;
  list(workspaceId: string): Promise<SkillGitSource[]>;
  /**
   * Sources a push to `ref` (`refs/heads/…` or `refs/tags/…`) of that
   * repository reaches through one of the connections, sync on.
   */
  matching(input: {
    connectionIds: readonly string[];
    installationId: number;
    repositoryId: number;
    ref: string;
  }): Promise<SkillGitSource[]>;
  /**
   * Sources with sync on whose last check is before `before`, or none yet.
   * Each is claimed for `claimMs`: due again then unless a check recorded.
   */
  due(
    before: Date,
    limit: number,
    claimMs: number,
  ): Promise<Array<{ workspaceId: string; name: string }>>;
  /**
   * Takes the skill for a check until `leaseMs` from now under a new token,
   * or keeps `trigger` for the check that holds it (`queued`). A person's
   * kept trigger is not replaced by a webhook's or the daily pass's.
   */
  begin(
    workspaceId: string,
    name: string,
    trigger: SkillSyncTrigger,
    leaseMs: number,
  ): Promise<
    { outcome: "started"; token: string } | { outcome: "queued" | "not_found" }
  >;
  /**
   * Lets the skill go, or, when a trigger was kept meanwhile, keeps it for
   * one more run and returns that trigger. Null and no change when `token`
   * no longer holds it.
   */
  finish(
    workspaceId: string,
    name: string,
    leaseMs: number,
    token: string,
  ): Promise<SkillSyncTrigger | null>;
  /** Records a check that wrote no version, while `token` holds the skill. */
  recordCheck(
    workspaceId: string,
    name: string,
    check: SkillSyncCheck,
    token: string,
  ): Promise<void>;
  /**
   * Pauses or resumes sync under the source row's lock and writes the
   * `update_extension_sync` receipt with it.
   */
  setEnabled(input: {
    workspaceId: string;
    name: string;
    enabled: boolean;
    receiptId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<SetSkillSyncResult>;
  /**
   * Requests, consents to or turns off auto-approve under the source row's
   * lock, writing `update_extension_sync` with the action. A consent by
   * the requester passes only while no other member holds a manager role.
   * The caller checked the branch and its rule on GitHub just before.
   */
  setAutoApprove(input: {
    workspaceId: string;
    name: string;
    action: "request" | "consent" | "off";
    receiptId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<SetAutoApproveResult>;
}
