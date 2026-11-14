import type {
  CatalogMcpServerConfig,
  CatalogProviderConfig,
  CatalogRepositoryConfig,
  ModelFamilies,
  StoredOwnerKind,
} from "../sessions/catalog.ts";

/**
 * The installation's settings in one read (decision
 * settings-replace-file-catalog.md §1): connections and MCP servers not
 * disabled, and repositories that carry their own credential or none (the
 * console App's rows are CatalogRepositoryStore's), each in the shape a
 * settings document gives the entry.
 */
export interface InstallationSettings {
  /** `settings_generation` as it was before the rows were read. */
  generation: number;
  connections: ReadonlyArray<{
    id: string;
    provider: CatalogProviderConfig;
    /**
     * The provider as it was while its credential came from the deployment,
     * when the console has since moved it to a stored value.
     */
    replaces?: CatalogProviderConfig;
    /** Absent reads as `unknown`. */
    auto_mode?: "supported" | "unsupported" | "unknown";
    /** The models an agent may name on it; absent reads as none. */
    models?: readonly string[];
    /** Their series, for a retired model's successor. */
    model_families?: ModelFamilies | undefined;
  }>;
  repositories: ReadonlyArray<{
    id: string;
    repository: CatalogRepositoryConfig;
  }>;
  mcpServers: ReadonlyArray<{ id: string; server: CatalogMcpServerConfig }>;
  /**
   * Stored values by their reference (`connection:<id>`, …): only when the
   * read was asked to open them, and only a row's own.
   */
  stored: ReadonlyMap<string, string>;
  /** Rows left out because they no longer parse, as `<kind>:<id>`. */
  invalid: readonly string[];
}

/**
 * What became of one row whose credential names an env variable:
 * `missing` when the variable has no value, `waiting` while there is no
 * workspace to keep a value under (or no secret store), `invalid` when the
 * catalog would refuse the value, `failed` on a database error. Only
 * `carried` changed the row.
 */
export type EnvCredentialCarry = {
  /** `<kind>:<id>`. */
  entry: string;
  /** The variable's name, never its value. */
  env: string;
} & (
  | {
      outcome: "carried";
      /**
       * A repository's: the push requests and worker credentials moved from
       * its old binding to the new one.
       */
      rebound?: { push_requests: number; worker_credentials: number };
    }
  | { outcome: "missing" | "waiting" | "failed" }
  /** `reason` names where the reference sits, never the value. */
  | { outcome: "invalid"; reason: string }
);

export interface InstallationSettingsStore {
  /**
   * One snapshot of the rows and the generation they were read at. Without
   * `openStored` no value is decrypted, for a process that holds none.
   */
  read(options?: { openStored?: boolean }): Promise<InstallationSettings>;
  /**
   * Sets the value behind `stored: <kind>:<id>` under a new
   * `secret_version`, kept under the installation's first workspace.
   */
  putStoredValue(
    owner: { kind: StoredOwnerKind; id: string },
    value: string,
    updatedBy: string | null,
  ): Promise<void>;
  /**
   * Seals the value `env` gives each enabled row's `value_env` and points
   * the row at it as its own stored value, once: its old `auth` is kept for
   * a rollback and a receipt names the variable. A repository's binding
   * changes with its reference, so the rows that held exactly the old one
   * are moved to the new one in the same transaction. One transaction per row,
   * in the settings writers' lock order; a row changed since it was listed
   * is left as it is, so two replicas move it once.
   */
  carryEnvCredentials(
    env: (name: string) => string | undefined,
  ): Promise<EnvCredentialCarry[]>;
}
