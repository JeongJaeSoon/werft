import { sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";

export type FreezePhase =
  | "open"
  | "certified"
  | "cleanup_started"
  | "finalized";

export type FreezeState = {
  writesFrozen: boolean;
  reconcileGeneration: number;
  certifiedGeneration: number | null;
  phase: FreezePhase;
};

type FreezeRow = {
  writes_frozen: boolean;
  reconcile_generation: string | number;
  certified_generation: string | number | null;
  phase: FreezePhase;
};

const stateOf = (row: FreezeRow): FreezeState => ({
  writesFrozen: row.writes_frozen,
  reconcileGeneration: Number(row.reconcile_generation),
  certifiedGeneration:
    row.certified_generation === null ? null : Number(row.certified_generation),
  phase: row.phase,
});

/** The refusal a writer gets while profile tables or releases are frozen. */
export class ProfilesFrozenError extends Error {
  readonly code = "PROFILES_FROZEN";
  constructor(readonly scope: "profile_tables" | "releases") {
    super(
      `profile ${scope === "releases" ? "releases are" : "tables are"} frozen`,
    );
  }
}

/**
 * Reads the row and keeps it FOR SHARE until the transaction ends, so a freezer
 * (FOR UPDATE) waits for this writer and a writer that starts after the freeze
 * sees it. Call it first, in the same transaction as the write. A missing row
 * fails closed: it reads as frozen, never as open.
 */
async function lockedState(tx: Database): Promise<FreezeState> {
  const [row] = rowsOf<FreezeRow>(
    await tx.execute(
      sql`SELECT writes_frozen, reconcile_generation, certified_generation, phase
            FROM profile_freeze WHERE id = 1 FOR SHARE`,
    ),
  );
  if (row === undefined) throw new Error("profile_freeze has no row");
  return stateOf(row);
}

/** Writers of profile-only tables: blocked from the freeze on, for good once certified. */
export async function assertProfileTablesWritable(tx: Database): Promise<void> {
  if ((await lockedState(tx)).writesFrozen) {
    throw new ProfilesFrozenError("profile_tables");
  }
}

/**
 * Writers of `agent_releases`: blocked only while a reconcile window is open
 * and not yet certified. The window is judged by the current generations, not
 * by a phase it once passed, so "revert the reader, unfreeze, change profiles,
 * freeze again" closes this barrier again.
 */
export async function assertReleasesWritable(tx: Database): Promise<void> {
  const state = await lockedState(tx);
  if (
    state.writesFrozen &&
    state.certifiedGeneration !== state.reconcileGeneration
  ) {
    throw new ProfilesFrozenError("releases");
  }
}

/**
 * One read for the reader: whether the spec path may replace the profile path.
 * True only when a reconcile of the current window passed.
 */
export async function readerCertified(db: Database): Promise<boolean> {
  const [row] = rowsOf<{ certified: boolean }>(
    await db.execute(
      sql`SELECT coalesce(certified_generation = reconcile_generation, false) AS certified
            FROM profile_freeze WHERE id = 1`,
    ),
  );
  return row?.certified ?? false;
}

export async function readFreeze(db: Database): Promise<FreezeState | null> {
  const [row] = rowsOf<FreezeRow>(
    await db.execute(
      sql`SELECT writes_frozen, reconcile_generation, certified_generation, phase
            FROM profile_freeze WHERE id = 1`,
    ),
  );
  return row === undefined ? null : stateOf(row);
}

export type TransitionRefusal =
  | "wrong_phase"
  | "already_frozen"
  | "not_frozen"
  | "generation_mismatch"
  | "lock_timeout";

export type Transition =
  | { ok: true; before: FreezeState; after: FreezeState }
  | { ok: false; reason: TransitionRefusal; state: FreezeState | null };

type Options = {
  /** How long to wait for writers in flight before giving up with nothing changed. */
  lockTimeoutMs?: number;
  receipt?: string;
};

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

const isLockTimeout = (error: unknown): boolean => {
  for (let e: unknown = error; e !== undefined && e !== null; ) {
    const code = (e as { code?: unknown }).code;
    if (code === "55P03") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
};

type Step = (
  tx: Database,
  before: FreezeState,
) => Promise<TransitionRefusal | { set: ReturnType<typeof sql> }>;

/**
 * Takes the row FOR UPDATE, so writers in flight finish first and later ones
 * see the new state. `db` is the top-level handle, never a transaction: the
 * lock_timeout and the row lock last to the end of the transaction they run in,
 * and a writer that holds the row FOR SHARE and then calls this would wait on
 * itself. Operators run each transition on its own.
 */
async function transition(
  db: Database,
  options: Options,
  step: Step,
): Promise<Transition> {
  const timeout = Math.trunc(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("lockTimeoutMs must be a positive integer");
  }
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${timeout}`));
      const [row] = rowsOf<FreezeRow>(
        await tx.execute(
          sql`SELECT writes_frozen, reconcile_generation, certified_generation, phase
                FROM profile_freeze WHERE id = 1 FOR UPDATE`,
        ),
      );
      if (row === undefined) throw new Error("profile_freeze has no row");
      const before = stateOf(row);
      const outcome = await step(tx, before);
      if (typeof outcome === "string") {
        return { ok: false, reason: outcome, state: before } as const;
      }
      await tx.execute(
        sql`UPDATE profile_freeze SET ${outcome.set}, changed_at = now(),
              changed_by = NULL, receipt = ${options.receipt ?? null} WHERE id = 1`,
      );
      const [next] = rowsOf<FreezeRow>(
        await tx.execute(
          sql`SELECT writes_frozen, reconcile_generation, certified_generation, phase
                FROM profile_freeze WHERE id = 1`,
        ),
      );
      return {
        ok: true,
        before,
        after: stateOf(next as FreezeRow),
      } as const;
    });
  } catch (error) {
    if (isLockTimeout(error)) {
      return { ok: false, reason: "lock_timeout", state: null };
    }
    throw error;
  }
}

/** Starts a reconcile window: profile tables and releases stop changing. */
export const freezeProfiles = (db: Database, options: Options = {}) =>
  transition(db, options, async (_tx, before) => {
    if (before.phase !== "open") return "wrong_phase";
    if (before.writesFrozen) return "already_frozen";
    return {
      set: sql`writes_frozen = true, reconcile_generation = reconcile_generation + 1,
                 certified_generation = NULL`,
    };
  });

/** Ends a window that was not certified. A later freeze starts a new window. */
export const unfreezeProfiles = (db: Database, options: Options = {}) =>
  transition(db, options, async (_tx, before) => {
    if (before.phase !== "open") return "wrong_phase";
    if (!before.writesFrozen) return "not_frozen";
    return {
      set: sql`writes_frozen = false, reconcile_generation = reconcile_generation + 1,
                 certified_generation = NULL`,
    };
  });

/**
 * Records that the reconcile report for `expectedGeneration` passed. It takes
 * effect only if that is still the current window: a report file proves which
 * report it is, this proves the data it describes is the data now.
 */
export const certifyProfiles = (
  db: Database,
  expectedGeneration: number,
  options: Options = {},
) =>
  transition(db, options, async (_tx, before) => {
    if (before.phase !== "open") return "wrong_phase";
    if (!before.writesFrozen) return "not_frozen";
    if (before.reconcileGeneration !== expectedGeneration) {
      return "generation_mismatch";
    }
    return {
      set: sql`phase = 'certified', certified_generation = reconcile_generation`,
    };
  });

/** Puts the reader back on the profile path. Only while certified; the freeze stays. */
export const revertReader = (db: Database, options: Options = {}) =>
  transition(db, options, async (_tx, before) => {
    if (before.phase !== "certified") return "wrong_phase";
    return { set: sql`phase = 'open', certified_generation = NULL` };
  });

/** Enters the part that does not come back: from here the profile read path is deleted. */
export const startCleanup = (db: Database, options: Options = {}) =>
  transition(db, options, async (_tx, before) => {
    if (before.phase !== "certified") return "wrong_phase";
    return { set: sql`phase = 'cleanup_started', cleanup_started_at = now()` };
  });

export const finalizeCleanup = (db: Database, options: Options = {}) =>
  transition(db, options, async (_tx, before) => {
    if (before.phase !== "cleanup_started") return "wrong_phase";
    return { set: sql`phase = 'finalized', finalized_at = now()` };
  });
