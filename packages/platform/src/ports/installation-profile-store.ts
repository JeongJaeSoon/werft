import type {
  GitHubAppRepositories,
  PermissionMode,
  RepositoryScope,
} from "@werft-ai/contracts";
import type { TeamActor } from "./team-store.ts";

/**
 * An installation ceiling as stored. `catalog` rows were seeded under a
 * plain id; `console` rows are named versions.
 * Nothing changes but `retired_at` and `blocked_at`.
 */
export type InstallationProfileRecord = {
  id: string;
  name: string | null;
  version: number;
  origin: "catalog" | "console";
  /** The profile entry as written, credential references only; parsed again on read. */
  definition: unknown;
  permission_mode: PermissionMode;
  /** `profileFingerprint` when written: a row that no longer hashes to it runs nothing. */
  fingerprint: string;
  /**
   * The repositories the ceiling may run against: the only record of it.
   * Null on a `catalog` row no seed has filled: it runs on no repository.
   */
  repository_ids: string[] | null;
  github_app_repositories: GitHubAppRepositories;
  /**
   * Which ceiling judges its repositories; absent reads as `profile`. Null:
   * the row names no repository, and the workspace's ceiling judges them.
   */
  repository_scope?: RepositoryScope | null;
  /** The version this one narrows; a block on it stops this one too. */
  derived_from?: string | null;
  /** The workspace an admin made it for; null or absent is installation-wide. */
  workspace_id?: string | null;
  /** The author's name for it, when `name` is the server's lineage key. */
  display_name?: string | null;
  /**
   * The tools blocked when it was made with a deny, as named in the tool
   * catalog `tool_catalog_id`; null (or absent, before T1b) from an allow
   * list. Outside `definition` and the fingerprint.
   */
  deny?: string[] | null;
  tool_catalog_id?: string | null;
  previous_id: string | null;
  created_by: string | null;
  created_at: Date;
  retired_at: Date | null;
  retired_by: string | null;
  blocked_at: Date | null;
  blocked_by: string | null;
};

/** One seed entry to import. */
export type CatalogProfileImport = {
  id: string;
  definition: unknown;
  permission_mode: PermissionMode;
  fingerprint: string;
};

/**
 * `seeded`: the ids put in an empty table. `migrated`: imported rows whose
 * repositories were filled from the seed, which happens once.
 */
export type CatalogSeedResult = {
  seeded: string[];
  migrated: string[];
};

/**
 * Where a new version belongs. `installation`: an owner's, named `name`.
 * `workspace`: an admin's (or an owner's for one workspace), keyed by the
 * author's `displayName`; the server makes the lineage key `wl_<uuid>`.
 */
export type CreateInstallationProfileScope =
  | { kind: "installation" }
  | {
      kind: "workspace";
      workspaceId: string;
      /** The version a new lineage narrows; a later version keeps its previous one's. */
      derivedFrom: string | null;
    };

/** A console profile to save as the next version of `name`. */
export type CreateInstallationProfileInput = {
  actor: TeamActor;
  receiptId: string;
  /** The author's name for it. */
  name: string;
  scope: CreateInstallationProfileScope;
  /** What the caller says it replaces: the latest version of the lineage, if any. */
  previousId: string | null;
  /** Its `catalogProfileConfigSchema` output, without a `repository` key. */
  definition: unknown;
  permission_mode: PermissionMode;
  fingerprint: string;
  /** Both null for a profile made from an allow list. */
  deny: string[] | null;
  toolCatalogId: string | null;
  /** Named in the receipt. */
  connectionId: string | null;
  /** Named in the receipt: the previous version's deny column read otherwise. */
  previousDenyDrift?: boolean;
};

export type CreateInstallationProfileResult =
  | { outcome: "created"; record: InstallationProfileRecord }
  /** Same execution form as the lineage's latest: nothing was written. */
  | { outcome: "unchanged"; record: InstallationProfileRecord }
  | { outcome: "actor_inactive" }
  /** `op_<name>_v<n>` is already a row, twice for a generated key. */
  | { outcome: "id_taken"; id: string }
  /** `previousId` is not the latest version of the lineage, which is `latestId`. */
  | { outcome: "stale_previous"; latestId: string | null }
  /** A new lineage's display name is one this workspace already sees. */
  | { outcome: "name_taken" }
  /** `previousId` or `derivedFrom` is no row, or one of another workspace. */
  | { outcome: "unknown_previous" };

export type RetireInstallationProfileResult =
  | { outcome: "retired" | "unchanged"; record: InstallationProfileRecord }
  | { outcome: "not_found" | "actor_inactive" };

export type BlockInstallationProfileResult =
  | { outcome: "changed" | "unchanged"; record: InstallationProfileRecord }
  | { outcome: "not_found" | "actor_inactive" };

export interface InstallationProfileStore {
  listAll(): Promise<InstallationProfileRecord[]>;
  /**
   * One seeder at a time across replicas, in one transaction: while the
   * table is empty, inserts what `entries` reads, so a filled table never
   * reads it; then gives each imported row without repositories its
   * `repositoryIdsOf`.
   */
  seedCatalog(input: {
    entries: () => Promise<CatalogProfileImport[]>;
    repositoryIdsOf: (profileId: string) => string[];
  }): Promise<CatalogSeedResult>;
  /**
   * Saves the next version of `input.name` and its receipt in one
   * transaction, under the import's lock, while the actor is still a live
   * owner.
   */
  create(
    input: CreateInstallationProfileInput,
  ): Promise<CreateInstallationProfileResult>;
  /** Sets `retired_at` once; a second call changes nothing and writes no receipt. */
  retire(input: {
    actor: TeamActor;
    receiptId: string;
    profileId: string;
  }): Promise<RetireInstallationProfileResult>;
  /** Sets (`blocked`) or clears `blocked_at`; one already so changes nothing and writes no receipt. */
  setBlocked(input: {
    actor: TeamActor;
    receiptId: string;
    profileId: string;
    blocked: boolean;
  }): Promise<BlockInstallationProfileResult>;
}
