import type {
  SkillRepositorySyncResult,
  SkillRepositoryTriggerKind,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../../access-control/index.ts";
import type { SkillSyncIssue } from "./skill-git-source-store.ts";

/** What started a listing of a skill repository. */
export type SkillRepositoryTrigger = {
  kind: SkillRepositoryTriggerKind;
  /** The person who registered, pressed "지금 확인" or changed the ref. */
  userId: string | null;
};

export type SkillRepositorySync = {
  at: Date;
  trigger: SkillRepositoryTrigger;
  commit: string | null;
  result: SkillRepositorySyncResult;
  issues: SkillSyncIssue[];
};

/** One skill directory as a listing read it. */
export type SkillListingEntry = {
  /** The directory holding SKILL.md; empty for the repository root. */
  path: string;
  /** The frontmatter name; null when SKILL.md was not read or names none. */
  name: string | null;
  description: string | null;
  license: string | null;
  /** The directory's git tree: it changes when anything under it does. */
  treeSha: string;
  fileCount: number;
  totalBytes: number;
  /** Seen on the tree alone: an execute bit, or not a document extension. */
  hasScripts: boolean;
  /** Why it cannot be switched on; empty when the listing found nothing. */
  issues: SkillSyncIssue[];
};

export type SkillRepository = {
  workspaceId: string;
  id: string;
  repositoryId: number;
  /** `owner/name` when it was registered. */
  repository: string;
  ref: string;
  access: "public";
  /** The author App connection that reads it. */
  connectionId: string;
  /** The installation whose access reads it; it need not cover the repository. */
  installationId: number;
  /** The owning account's id when it was registered. */
  ownerId: number;
  license: string | null;
  /**
   * Raised by a removal, a restore and a ref change. A listing that read
   * GitHub under another generation writes nothing.
   */
  generation: number;
  lastCommit: string | null;
  lastSync: SkillRepositorySync | null;
  /** Directories the last listing found. */
  skillCount: number;
  createdBy: string;
  createdAt: Date;
  removedBy: string | null;
  removedAt: Date | null;
};

export type SkillRepositorySkill = SkillListingEntry & {
  id: string;
  /** False once the directory is gone from the repository. */
  present: boolean;
  enabled: boolean;
  /** The source of the workspace skill that holds this name; null when none. */
  nameOwner: "upload" | "github" | null;
  /** Another listed directory of the workspace reads the same name. */
  nameShared: boolean;
};

/** A listing GitHub answered in full. */
export type SkillRepositoryRead = {
  commit: string;
  license: string | null;
  entries: SkillListingEntry[];
};

type Managed = {
  workspaceId: string;
  receiptId: string;
  principal: Principal;
  managerRoles: readonly WorkspaceRole[];
};
type Refused = { outcome: "actor_inactive" | "outranked" };

export type RegisterSkillRepositoryResult =
  | {
      outcome: "registered" | "restored";
      repository: SkillRepository;
      receiptId: string;
    }
  /** The workspace already follows that GitHub repository. */
  | { outcome: "already_registered"; repository: SkillRepository }
  | Refused;

export type RemoveSkillRepositoryResult =
  | { outcome: "removed"; repository: SkillRepository; receiptId: string }
  | { outcome: "unchanged"; repository: SkillRepository }
  | { outcome: "not_found" }
  | Refused;

export type SetSkillRepositoryRefResult =
  | { outcome: "updated"; repository: SkillRepository; receiptId: string }
  | { outcome: "unchanged"; repository: SkillRepository }
  /** Removed, restored or pointed elsewhere since the ref was checked. */
  | { outcome: "changed" }
  /** No such repository, or it is removed. */
  | { outcome: "not_found" }
  | Refused;

/**
 * A workspace's skill repositories and what their listings found. A listing
 * takes the repository with `begin`, so one runs at a time across replicas;
 * a trigger that arrives meanwhile is kept and `finish` hands it back for
 * one more run.
 */
export interface SkillRepositoryStore {
  /** Removed ones too, oldest first. */
  list(workspaceId: string): Promise<SkillRepository[]>;
  find(workspaceId: string, id: string): Promise<SkillRepository | null>;
  /** The repository's skill directories by path, with who holds each name. */
  skills(workspaceId: string, id: string): Promise<SkillRepositorySkill[]>;
  /**
   * Writes the repository, its first listing and the
   * `register_skill_repository` receipt in one transaction. A removed row of
   * the same GitHub repository is brought back instead (`restored`): a new
   * generation, the ref and reader given here, every switch off.
   */
  register(
    input: Managed & {
      /** The id a new row takes; a restored row keeps its own. */
      id: string;
      url: string;
      github: { repositoryId: number; repository: string; ownerId: number };
      ref: string;
      connectionId: string;
      installationId: number;
      read: SkillRepositoryRead;
      at: Date;
    },
  ): Promise<RegisterSkillRepositoryResult>;
  /** Marks it removed under a new generation, with `remove_skill_repository`. */
  remove(input: Managed & { id: string }): Promise<RemoveSkillRepositoryResult>;
  /**
   * Points it at `ref` under a new generation, with
   * `update_skill_repository_ref`; `generation` is the one the ref was
   * checked under.
   */
  setRef(
    input: Managed & { id: string; ref: string; generation: number },
  ): Promise<SetSkillRepositoryRefResult>;
  /**
   * Takes an active repository for a listing until `leaseMs` from now under
   * a new token, or keeps `trigger` for the listing that holds it.
   */
  begin(
    workspaceId: string,
    id: string,
    trigger: SkillRepositoryTrigger,
    leaseMs: number,
  ): Promise<
    { outcome: "started"; token: string } | { outcome: "queued" | "not_found" }
  >;
  /**
   * Lets the repository go, or, when a trigger was kept meanwhile, keeps it
   * for one more run and returns that trigger. Null and no change when
   * `token` no longer holds it.
   */
  finish(
    workspaceId: string,
    id: string,
    leaseMs: number,
    token: string,
  ): Promise<SkillRepositoryTrigger | null>;
  /**
   * Records a listing's outcome, and the listing itself when GitHub answered
   * one (`read`): directories it names are written, the others marked gone.
   * Nothing is written, and false returned, unless `token` still holds the
   * repository, it is active and its generation is `generation`.
   */
  record(input: {
    workspaceId: string;
    id: string;
    token: string;
    generation: number;
    sync: SkillRepositorySync;
    read: SkillRepositoryRead | null;
  }): Promise<boolean>;
}
