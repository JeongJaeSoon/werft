import type { ModelFamilies } from "../sessions/catalog.ts";
import type {
  SettingsEntries,
  SettingsImportAdd,
  SettingsImportPlan,
  SettingsKind,
} from "../sessions/settings-document.ts";
import type { TeamActor } from "./team-store.ts";

export type SettingsImportResult =
  | (SettingsImportPlan & {
      /**
       * `refused`: a conflict or a refused reference, and nothing written.
       * `dry_run`: what `applied` would have written.
       */
      outcome: "applied" | "dry_run" | "refused";
      /** One per added row; empty when no workspace exists to keep them under. */
      receipt_ids: string[];
    })
  | { outcome: "actor_inactive" };

export interface SettingsDocumentStore {
  /**
   * The rows not disabled or removed, as entries, and each stored value's
   * last four characters by its reference; no value is opened.
   */
  exportEntries(): Promise<{
    entries: SettingsEntries;
    last4: ReadonlyMap<string, string>;
  }>;
  /**
   * Adds the entries whose id no row holds, in one transaction under the
   * settings writers' locks, or nothing when the plan has a conflict or a
   * refused reference. `actor` null is the operator's CLI: no one to check
   * and a system receipt; otherwise the actor must still be a live owner.
   */
  importEntries(
    entries: SettingsEntries,
    options: {
      dryRun: boolean;
      allowExternal: boolean;
      /** An import of an old catalog directory: see `SettingsImportPlan.kept`. */
      databaseOwnsRepositories?: boolean;
      actor: TeamActor | null;
    },
  ): Promise<SettingsImportResult>;

  /**
   * The sessions not yet `failed` or `stopped` that name one of `ids`: as
   * the primary repository, in the attached list, or through the policy
   * list an unset attached list falls back to. Only ids no live catalog row
   * holds count: the ones an import leaves out.
   */
  sessionsOnRepositories(ids: readonly string[]): Promise<
    Array<{
      session_id: string;
      repository_id: string;
      via: "primary" | "attached" | "policy";
    }>
  >;

  /**
   * What runs on `connectionId` right now, and whether a workspace's judge
   * setting names it: the active agents whose active release runs on it,
   * and the sessions not yet `failed` or `stopped` whose spec does. Counts
   * only; read when a person asks what disabling a connection would stop.
   */
  connectionUse(input: {
    connectionId: string;
  }): Promise<{ agents: number; sessions: number; judgeNamed: boolean }>;

  /**
   * Every row of one kind, disabled and removed ones too; for repositories
   * only those that are not the console App's.
   */
  listRows(kind: SettingsKind): Promise<SettingsRow[]>;

  /**
   * The console's writes, each in one transaction under the import's locks
   * and with one receipt. `create` plans the entry as an import would, so
   * an id ever taken, or a value already sealed under it, is refused; the
   * row's own value is sealed in the same transaction.
   */
  create(
    add: SettingsImportAdd,
    value: string | null,
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  setValue(
    owner: { kind: SettingsKind; id: string },
    value: string,
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  /**
   * Moves a connection whose credential comes from the deployment (an env
   * or Secrets Manager reference) to a value the person enters, sealed under
   * the same id. The reference stays on the row as `replaces`, so the
   * ceilings made over it keep matching it. The server never reads the
   * referenced value: `value` is what was typed.
   */
  convertConnection(
    id: string,
    value: string,
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  /**
   * Records the operator's judgement of whether the connection's models run
   * the auto-mode classifier. Changes that column only, never the stored
   * definition. A disabled connection is refused. A release made after it
   * reads it; sessions keep the spec they hold.
   */
  setConnectionAutoMode(
    id: string,
    autoMode: "supported" | "unsupported" | "unknown",
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  /**
   * The models an agent may name on the connection and their series. Beside
   * the definition, never in it: the list changes over a connection's life
   * where what it points at does not. A disabled connection is refused.
   * `model_families` left out keeps the stored series; `null` clears them.
   */
  setConnectionModels(
    id: string,
    models: {
      models: readonly string[];
      model_families?: ModelFamilies | null;
    },
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  /** For a repository: removed. Never undone; the id stays taken. */
  disable(
    owner: { kind: SettingsKind; id: string },
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  /**
   * Clears a connection's `disabled_at`. Refused when another live
   * connection holds the same definition (or an alias of it), or when its
   * own stored value is gone. A deployment's reference is not opened here.
   */
  enableConnection(
    id: string,
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
  setMcpWorkspaces(
    id: string,
    workspaces: readonly string[],
    actor: TeamActor,
  ): Promise<SettingsConsoleResult>;
}

export type SettingsRow = {
  id: string;
  /** The row as an entry would be, `stored` naming its own reference. */
  entry: unknown;
  origin: "import" | "console";
  /** A stored value's last four characters; null when none is set. */
  last4: string | null;
  createdAt: Date;
  /** Disabled, or for a repository removed. */
  disabledAt: Date | null;
  /** A connection's judged auto mode; absent on the other kinds. */
  autoMode?: "supported" | "unsupported" | "unknown";
  /** A connection's models and their series; absent on the other kinds. */
  models?: readonly string[];
  modelFamilies?: ModelFamilies | null;
};

export type SettingsConsoleResult =
  | { outcome: "done"; receiptId: string }
  /** The actor lost the role the write needs after the policy's check. */
  | { outcome: "actor_inactive" }
  | { outcome: "not_found" }
  | {
      outcome: "conflict";
      /**
       * `already_exists`: the id, or a value sealed under it, is taken.
       * `not_stored`: the row's credential is not its own value (an
       * operator's reference, which the console only shows and disables).
       * `disabled`: the row is disabled or removed.
       * `not_external`: moving a row to a stored value needs one whose
       * credential comes from the deployment.
       * `alias_taken`: another connection is, or was, exactly what this one
       * was, so a ceiling made over it could not tell which one is its own.
       * `not_disabled`: enabling a row that is already in use.
       * `definition_active`: enabling needs the definition (or an alias of
       * it) to be held by no other live connection.
       * `needs_value`: enabling a stored connection whose value is gone.
       */
      reason:
        | "already_exists"
        | "not_stored"
        | "disabled"
        | "not_external"
        | "alias_taken"
        | "not_disabled"
        | "definition_active"
        | "needs_value";
    };
