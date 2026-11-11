import type { CheckpointStore } from "./checkpoint-store.ts";

/** One stored write of a key, or the delete marker a key-level delete left. */
export type StoredObjectVersion = {
  deleteMarker: boolean;
  key: string;
  version: string;
};

/**
 * What garbage collection needs from the object store beyond reading: every
 * version under a prefix, and the one operation that ends a version for
 * good. Kept apart from `CheckpointObjectStore` because the worker is handed
 * that one, and whoever can release a hold can undo every hold a checkpoint
 * relies on.
 */
export interface CheckpointObjectCollector {
  listVersions(prefix: string): Promise<StoredObjectVersion[]>;
  /**
   * Lifts the legal hold, then deletes that version itself — not the key, which
   * would only stack a delete marker on top of it. A delete marker has no hold
   * to lift and is deleted the same way.
   */
  purge(entry: StoredObjectVersion): Promise<void>;
}

export type CheckpointCollectionFences = {
  /**
   * Attempts of the session that can never commit again: ended, or bound to
   * an epoch, generation or auth revision the session has moved past. Each
   * of those only ever moves forward, so an attempt that is here once stays
   * here — which is what lets a collector read this before listing objects.
   */
  fencedAttemptIds: ReadonlySet<string>;
  /** `sessions.checkpoint_fallback_revision`: a fallback restore's base. */
  fallbackRevision: number | null;
  /**
   * `sessions.execution_generation`. Only ever moves forward, and an attempt
   * of an earlier generation is fenced, so no generation below it can commit
   * again.
   */
  executionGeneration: number;
};

export interface CheckpointCollectionStore
  extends Pick<CheckpointStore, "listCheckpoints" | "readPointer"> {
  /** null when the session does not exist. */
  readCollectionFences(
    sessionId: string,
  ): Promise<CheckpointCollectionFences | null>;
  /**
   * Revisions an open push request (`requested`, `approved`, `pushing`)
   * pinned: the platform pushes from them after the session has moved on.
   */
  readPushPinnedRevisions(sessionId: string): Promise<number[]>;
  /**
   * Records that every committed revision up to `throughRevision`, other
   * than `keep`, is no longer restorable, before its objects go: a backup
   * then skips those rows instead of refusing over their missing objects.
   * Returns how many rows it newly marked.
   */
  markCollected(
    sessionId: string,
    options: { keep: readonly number[]; throughRevision: number },
  ): Promise<number>;
  /**
   * Records that the objects of the collected revisions `markCollected`
   * names with the same options are deleted, once every delete of the pass
   * succeeded: output usage stops counting them only then. A pass that fails
   * leaves them counted until one succeeds.
   */
  markPurged(
    sessionId: string,
    options: { keep: readonly number[]; throughRevision: number },
  ): Promise<void>;
  /**
   * Session ids in ascending order, strictly after `after` when given,
   * leaving out the sessions `settleCollection` settled.
   */
  listSessionIds(options: {
    after: string | null;
    limit: number;
  }): Promise<string[]>;
  /**
   * Called once a pass collected the session: leaves it out of later passes
   * when nothing there can become collectible again (closed long enough that
   * no worker can still write, no open push request pinning a revision).
   * Whether it did.
   */
  settleCollection(sessionId: string): Promise<boolean>;
}
