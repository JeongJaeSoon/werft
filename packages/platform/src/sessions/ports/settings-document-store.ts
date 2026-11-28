import type { ConnectionNetwork, ModelFamilies } from "../../catalog/index.ts";
import type { TeamActor } from "../../musterrolle/ports/team-store.ts";
import type {
  SettingsEntries,
  SettingsImportAdd,
  SettingsImportPlan,
  SettingsKind,
} from "../settings-document.ts";

export type SettingsImportResult =
  | (SettingsImportPlan & {
      /**
       * `refused`: a conflict, and nothing written.
       * `dry_run`: what `applied` would have written.
       */
      outcome: "applied" | "dry_run" | "refused";
      /** One per added row; empty when no workspace exists to keep them under. */
      receipt_ids: string[];
    })
  | { outcome: "actor_inactive" };

/**
 * Whether migrate's automatic seed still has an installation to seed. It
 * decides once: `decided` ever after, whatever is added or removed later.
 */
export type SettingsSeedDecision =
  | { outcome: "decided"; decided_at: Date }
  /** The installation held settings already; decided now. */
  | { outcome: "not_empty" }
  | { outcome: "empty" };

/** One source of the seed, imported under the operator's import rules. */
export type SettingsSeedStep = { entries: SettingsEntries };

export type SettingsSeedResult =
  | Exclude<SettingsSeedDecision, { outcome: "empty" }>
  /** Step `step` was refused, and nothing of any step was written. */
  | (SettingsImportPlan & { outcome: "refused"; step: number })
  | {
      outcome: "applied";
      steps: SettingsImportPlan[];
      receipt_ids: string[];
    };

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
   * settings writers' locks, or nothing when the plan has a conflict.
   * `actor` null is the operator's CLI: no one to check and a system
   * receipt; otherwise the actor must still be a live owner.
   */
  importEntries(
    entries: SettingsEntries,
    options: {
      dryRun: boolean;
      actor: TeamActor | null;
    },
  ): Promise<SettingsImportResult>;

  /** Decides under the import's locks, writing only to record `not_empty`. */
  decideSeed(): Promise<SettingsSeedDecision>;
  /**
   * Decides again under the import's locks and, when the installation is
   * still empty, imports each step in order as the operator's import would,
   * all in one transaction, and records the decision. A refused step leaves
   * nothing written and nothing decided.
   */
  seedEntries(steps: readonly SettingsSeedStep[]): Promise<SettingsSeedResult>;

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
    value: string,
    actor: TeamActor,
    /**
     * A connection's: what its endpoint resolved to, kept on the row and in
     * the receipt, with the actor's acknowledgement when that is private.
     */
    registered?: { network: ConnectionNetwork; acknowledgedPrivate: boolean },
  ): Promise<SettingsConsoleResult>;
  /**
   * Keeps a connection the operator's private allowlist names as `private`,
   * with a system receipt (`by: env_import`): the operator allowed it, so
   * no one is asked again. Only a row that holds no network yet; any other
   * is `unchanged`.
   */
  carryOperatorPrivate(
    id: string,
  ): Promise<
    { outcome: "carried"; receiptId: string | null } | { outcome: "unchanged" }
  >;
  setValue(
    owner: { kind: SettingsKind; id: string },
    value: string,
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
   * own stored value is gone.
   */
  enableConnection(
    id: string,
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
  /** A connection's: what it was registered as; null on a row from before. */
  network?: ConnectionNetwork | null;
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
       * `not_stored`: the row holds no credential of its own to set.
       * `disabled`: the row is disabled or removed.
       * `not_disabled`: enabling a row that is already in use.
       * `definition_active`: enabling needs the definition (or an alias of
       * it) to be held by no other live connection.
       * `needs_value`: enabling a stored connection whose value is gone.
       */
      reason:
        | "already_exists"
        | "not_stored"
        | "disabled"
        | "not_disabled"
        | "definition_active"
        | "needs_value";
    };
