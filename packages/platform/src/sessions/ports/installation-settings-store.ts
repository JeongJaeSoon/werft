import type {
  CatalogProviderConfig,
  CatalogRepositoryConfig,
  ConnectionNetwork,
  ModelFamilies,
  StoredOwnerKind,
} from "../../catalog/index.ts";

/**
 * The installation's settings in one read: connections not disabled, and
 * repositories that carry their own credential or none (the
 * console App's rows are CatalogRepositoryStore's), each in the shape a
 * settings document gives the entry.
 */
export interface InstallationSettings {
  /** `settings_generation` as it was before the rows were read. */
  generation: number;
  connections: ReadonlyArray<{
    id: string;
    provider: CatalogProviderConfig;
    /** The models an agent may name on it; absent reads as none. */
    models?: readonly string[];
    /** Their series, for a retired model's successor. */
    model_families?: ModelFamilies | undefined;
    /** What the endpoint was registered as; absent on a row from before. */
    network?: ConnectionNetwork | undefined;
  }>;
  repositories: ReadonlyArray<{
    id: string;
    repository: CatalogRepositoryConfig;
  }>;
  /**
   * Stored values by their reference (`connection:<id>`, …): only when the
   * read was asked to open them, and only a row's own.
   */
  stored: ReadonlyMap<string, string>;
  /** Rows left out because they no longer parse, as `<kind>:<id>`. */
  invalid: readonly string[];
}

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
}
