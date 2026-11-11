/** CheckpointPointer.parentRevision of a checkpoint that starts a history. */
export const CHECKPOINT_ROOT_PARENT = -1;

export type CheckpointPointer = {
  committedAt: Date;
  manifestRef: string;
  manifestSha256: string;
  /**
   * The object version of the manifest finalize verified (the checkpoint
   * ref's `manifest_version`). Restore reads exactly that version. Null or
   * absent for a checkpoint committed without one, which only an
   * `objectProtection: "unversioned"` deployment restores.
   */
  manifestVersion?: string | null;
  /**
   * The revision this checkpoint's state was built on: the pointer before
   * it, or the earlier revision a fallback restored. Null or
   * absent for revision 0 and for rows committed before it was recorded,
   * which read as the revision before. CHECKPOINT_ROOT_PARENT for the first
   * checkpoint after a start_fresh decision: it was built on no
   * earlier state, and a fallback must never walk into the retired history.
   */
  parentRevision?: number | null;
  revision: number;
  turnId: string | null;
  /**
   * True only for a checkpoint a `locked` finalize committed: every version
   * it names was hashed by that version and held before the pointer moved.
   * Server-owned; absent reads as false.
   */
  versionsHeld?: boolean;
};

/**
 * The identity a post-claim write is fenced on, as the worker protocol defines
 * it. It travels with the commit so the pointer update and the ownership check
 * happen in one transaction: an execution whose lease has been taken over must
 * not win the next revision just because it uploaded first.
 */
export type CheckpointFence = {
  attemptId: string;
  authRevision: number;
  executionGeneration: number;
  leaseEpoch: number;
  sessionId: string;
};

/**
 * The durable half of a checkpoint, as the checkpoint service reads it. The
 * pointer advances only in a turn's finalize (`WorkerUnitOfWork.finalizeAtomic`),
 * in the same transaction as the turn's terminal — the object store and the
 * database cannot share a transaction, so the pointer is what decides which
 * uploaded manifest is the session's truth.
 */
export interface CheckpointStore {
  readPointer(sessionId: string): Promise<CheckpointPointer | null>;
  /**
   * The committed checkpoints below `belowRevision`, newest first, at most
   * `limit` of them: the generations a restore may fall back to when the
   * pointer's own checkpoint no longer verifies. Each entry is recorded the
   * way the pointer is, with the manifest version that revision committed.
   * Bounded on purpose — a session accumulates a row per checkpoint, and a
   * restore must not walk its whole history.
   */
  listCheckpoints(
    sessionId: string,
    options: { belowRevision: number; limit: number },
  ): Promise<CheckpointPointer[]>;
  /**
   * The distinct commits the session's push requests pinned, newest request
   * first, whatever their state but `rejected` (a rejected one never pushes):
   * the commits a remote may hold or a pending approval may still push. At
   * most `limit` are returned, so a caller that passes its bound plus one can
   * tell that the set did not fit.
   */
  listPinnedCommits(sessionId: string, limit: number): Promise<string[]>;
}
