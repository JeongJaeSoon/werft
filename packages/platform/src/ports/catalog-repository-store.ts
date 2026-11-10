import type { ReceiptActor, WorkspaceRole } from "@werft-ai/contracts";

/**
 * A repository that uses the console's GitHub App, as the database holds it
 * (repository-catalog-db.md §1; settings-replace-file-catalog.md §1.1).
 * Removed rows are never listed.
 */
export interface CatalogRepositoryRow {
  id: string;
  github_repository_id: number | null;
  owner: string;
  name: string;
  url: string;
  branch: string;
  source: "seed" | "console" | "selection";
  version: number;
  created_at: string;
  updated_at: string;
}

interface RepositoryWrite {
  workspaceId: string;
  userId: string;
  actor: ReceiptActor;
  requestId: string | null;
  /** The id of the receipt the write leaves, which the response names. */
  receiptId: string;
}

export interface CatalogRepositoryStore {
  listActive(): Promise<CatalogRepositoryRow[]>;
  /**
   * `listActive` and the rows with an App of their own (`github_app_explicit`):
   * every repository an agent can be given, since a PAT one cannot.
   */
  listAgentChoosable(): Promise<CatalogRepositoryRow[]>;
  /**
   * `listActive`, or null while the table has never held a row.
   */
  readCatalog(): Promise<CatalogRepositoryRow[] | null>;
  /**
   * The row of that GitHub repository: found by its id (taking the new
   * owner/name and URL after a rename), else by owner/name on a row with no
   * GitHub id yet (filling it in), else inserted as a `selection` row under
   * `base`, numbered `-2`, `-3` past ids ever used. A row of
   * another GitHub repository, or a second row with no GitHub id, under that
   * name is `name_held`. An insert or a rename leaves a receipt.
   */
  resolve(
    input: RepositoryWrite & {
      /**
       * The agent it is picked for: the right to manage it is read again
       * under locks, `managerRoles` holding it outright.
       */
      agentId: string;
      managerRoles: readonly WorkspaceRole[];
      base: string;
      githubRepositoryId: number;
      owner: string;
      name: string;
      url: string;
      branch: string;
    },
  ): Promise<
    | {
        outcome: "resolved";
        repository: CatalogRepositoryRow;
        /** False when an earlier row was found. */
        created: boolean;
        /** Whether the catalog changed, an insert or a rename: a receipt was written. */
        changed: boolean;
      }
    | { outcome: "name_held"; id: string }
    | { outcome: "actor_inactive" | "outranked" }
  >;
  setBranch(
    input: RepositoryWrite & { id: string; branch: string; version: number },
  ): Promise<
    | { outcome: "stored"; repository: CatalogRepositoryRow }
    | { outcome: "actor_inactive" | "not_found" | "revision_conflict" }
  >;
  /**
   * Per catalog id, how many agents' active releases name it (`author`),
   * and how many of those turn review on (`reviewer`).
   */
  agentCounts(): Promise<
    ReadonlyMap<string, { author: number; reviewer: number }>
  >;
}
