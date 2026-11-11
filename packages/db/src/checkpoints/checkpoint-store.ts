import { OPEN_PUSH_REQUEST_STATES } from "@werft-ai/contracts";
import type {
  CheckpointCollectionFences,
  CheckpointCollectionStore,
  CheckpointPointer,
  CheckpointStore,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { ENDED_ATTEMPT_STATES, hasRestorePoint } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { RESTORE_FAILURES_CLEARED } from "../restore-failures.ts";
import { openResumeReceipt } from "../resume-control.ts";
import {
  attempts,
  checkpoints,
  pushIntents,
  pushRequests,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "../schema.ts";
import { openDrainReceipt } from "../sessions/drain.ts";
import { recordEvent, recordStatus } from "../sessions/session-events.ts";
import { readCheckpointPointer } from "../worker-unit-of-work.ts";

/**
 * Whether any checkpoint garbage collection has not yet collected exists:
 * one whose objects a restore or a backup still expects in the bucket.
 */
export async function hasUncollectedCheckpoint(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ sessionId: checkpoints.sessionId })
    .from(checkpoints)
    .where(isNull(checkpoints.collectedAt))
    .limit(1);
  return row !== undefined;
}

/** Why forgetLostCheckpoints holds a session, in its status and system events. */
export const CHECKPOINT_OBJECTS_LOST_REASON = "checkpoint_objects_lost";

/** What forgetLostCheckpoints gave up, by session id. */
export type LostCheckpoints = {
  /** Sessions now in recovery_required: their restore point was lost. */
  readonly held: string[];
  /**
   * Sessions that lost checkpoints but keep their state: closed, or with no
   * restore point left among them (retired by start_fresh).
   */
  readonly unchanged: string[];
};

const LOST_CHECKPOINT_RECEIPT_ERROR = {
  code: "RECOVERY_REQUIRED",
  message:
    "the object store lost the session's checkpoints; an operator recovery decision is required",
} as const;

/**
 * Marks every uncollected checkpoint collected, for an operator who has
 * accepted that the object store lost all of them; the caller checks the
 * bucket first. Every session that is not closed and would restore one of
 * them, whatever it was doing, has that pointer retired and waits in
 * recovery_required with its input kept; its open pause or resume receipt
 * fails. Resume and retry_restore refuse, start_fresh goes on without the
 * lost context, close ends the session.
 */
export function forgetLostCheckpoints(
  db: Database,
  now: Date,
): Promise<LostCheckpoints> {
  return db.transaction(async (tx) => {
    const lost = await tx
      .selectDistinct({ sessionId: checkpoints.sessionId })
      .from(checkpoints)
      .where(isNull(checkpoints.collectedAt));
    if (lost.length === 0) return { held: [], unchanged: [] };
    const ids = lost.map((row) => row.sessionId);
    // A claim locks the signal row before the session, a finalize the
    // session before its checkpoints: this takes them in the same order.
    await tx
      .select({ sessionId: unassignedSessions.sessionId })
      .from(unassignedSessions)
      .where(inArray(unassignedSessions.sessionId, ids))
      .orderBy(asc(unassignedSessions.sessionId))
      .for("update");
    const rows = await tx
      .select()
      .from(sessions)
      .where(inArray(sessions.id, ids))
      .orderBy(asc(sessions.id))
      .for("update");
    await tx
      .update(checkpoints)
      .set({ collectedAt: DB_NOW })
      .where(
        and(
          inArray(checkpoints.sessionId, ids),
          isNull(checkpoints.collectedAt),
        ),
      );
    const held: string[] = [];
    const unchanged: string[] = [];
    for (const session of rows) {
      if (!hasRestorePoint(session) || session.admissionState === "closed") {
        unchanged.push(session.id);
        continue;
      }
      held.push(session.id);
      await tx
        .update(receipts)
        .set({
          status: "failed",
          error: LOST_CHECKPOINT_RECEIPT_ERROR,
          updatedAt: now,
        })
        .where(or(openDrainReceipt(session.id), openResumeReceipt(session.id)));
      // Retired the way start_fresh retires a pointer, but with no turn
      // forgiven: every turn that ran is now a context gap, so the claim
      // gate, resume and each recovery decision judge the session as having
      // no restore point, whichever state a later decision leaves it in.
      await tx
        .update(sessions)
        .set({
          revision: sql`${sessions.revision} + 1`,
          status: "failed",
          admissionState: "recovery_required",
          contextResetCheckpointRevision: session.checkpointRevision,
          checkpointFallbackRevision: null,
          checkpointRestoreAttemptId: null,
          // The failing restores were of a checkpoint that is retired now.
          ...RESTORE_FAILURES_CLEARED,
          updatedAt: now,
        })
        .where(eq(sessions.id, session.id));
      await tx
        .delete(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.id));
      await recordEvent(tx, {
        sessionId: session.id,
        type: "system",
        payload: {
          type: "system",
          subtype: CHECKPOINT_OBJECTS_LOST_REASON,
          retired_checkpoint_revision: session.checkpointRevision,
        },
        turnRowId: null,
        now,
      });
      await recordStatus(tx, {
        sessionId: session.id,
        phase: "failed",
        extra: {
          admission_state: "recovery_required",
          reason: CHECKPOINT_OBJECTS_LOST_REASON,
        },
        turnRowId: null,
        now,
      });
    }
    return { held, unchanged };
  });
}

/**
 * The checkpoint pointer on PostgreSQL, read with the helpers a turn's finalize
 * uses (worker-unit-of-work.ts), so a read judges the fence, the clock and the
 * pointer the same way. The pointer moves only in `finalizeAtomic`.
 */
export function createPostgresCheckpointStore(
  db: Database,
): CheckpointStore & CheckpointCollectionStore {
  return {
    /**
     * The fence judged the way `acquireFence` judges it, for every attempt
     * at once, from one snapshot of the session row and its attempts. A
     * lease that merely ran out is not a lost fence: the attempt may yet
     * heartbeat before the reconciler ends it.
     */
    readCollectionFences(
      sessionId: string,
    ): Promise<CheckpointCollectionFences | null> {
      return db.transaction(
        async (tx) => {
          const [session] = await tx
            .select({
              authRevision: sessions.authRevision,
              executionGeneration: sessions.executionGeneration,
              fallbackRevision: sessions.checkpointFallbackRevision,
              leaseEpoch: sessions.leaseEpoch,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (!session) return null;
          const rows = await tx
            .select({
              authRevision: attempts.authRevision,
              executionGeneration: attempts.executionGeneration,
              id: attempts.id,
              leaseEpoch: attempts.leaseEpoch,
              state: attempts.state,
            })
            .from(attempts)
            .where(eq(attempts.sessionId, sessionId));
          const fenced = rows.filter(
            (attempt) =>
              ENDED_ATTEMPT_STATES.includes(attempt.state) ||
              attempt.leaseEpoch !== session.leaseEpoch ||
              attempt.executionGeneration !== session.executionGeneration ||
              attempt.authRevision !== session.authRevision,
          );
          return {
            executionGeneration: session.executionGeneration,
            fallbackRevision: session.fallbackRevision,
            fencedAttemptIds: new Set(fenced.map((attempt) => attempt.id)),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async readPushPinnedRevisions(sessionId: string): Promise<number[]> {
      // One statement, so one snapshot: an intent turning into a request is
      // a single transaction, and any snapshot sees the revision in one of
      // the two. The collector reads the pointer first and this after.
      const rows = await db
        .select({ revision: pushRequests.checkpointRevision })
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.sessionId, sessionId),
            inArray(pushRequests.state, [...OPEN_PUSH_REQUEST_STATES]),
          ),
        )
        .union(
          db
            // The where clause leaves no null; the column type cannot say so.
            .select({ revision: sql<number>`${pushIntents.pinnedRevision}` })
            .from(pushIntents)
            .where(
              and(
                eq(pushIntents.sessionId, sessionId),
                eq(pushIntents.status, "pinned"),
                isNotNull(pushIntents.pinnedRevision),
              ),
            ),
        );
      return rows.map((row) => row.revision);
    },

    async markCollected(
      sessionId: string,
      options: { keep: readonly number[]; throughRevision: number },
    ): Promise<number> {
      const marked = await db
        .update(checkpoints)
        .set({ collectedAt: DB_NOW })
        .where(
          and(
            eq(checkpoints.sessionId, sessionId),
            lte(checkpoints.revision, options.throughRevision),
            isNull(checkpoints.collectedAt),
            ...(options.keep.length === 0
              ? []
              : [notInArray(checkpoints.revision, [...options.keep])]),
          ),
        )
        .returning({ revision: checkpoints.revision });
      return marked.length;
    },

    async markPurged(
      sessionId: string,
      options: { keep: readonly number[]; throughRevision: number },
    ): Promise<void> {
      // Rows an earlier, failed pass collected are included: this pass
      // listed their directories again and deleted what it found.
      await db
        .update(checkpoints)
        .set({ objectsPurgedAt: DB_NOW })
        .where(
          and(
            eq(checkpoints.sessionId, sessionId),
            lte(checkpoints.revision, options.throughRevision),
            isNotNull(checkpoints.collectedAt),
            isNull(checkpoints.objectsPurgedAt),
            ...(options.keep.length === 0
              ? []
              : [notInArray(checkpoints.revision, [...options.keep])]),
          ),
        );
    },

    async listSessionIds(options: {
      after: string | null;
      limit: number;
    }): Promise<string[]> {
      const rows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            isNull(sessions.checkpointCollectionSettledAt),
            options.after === null ? undefined : gt(sessions.id, options.after),
          ),
        )
        .orderBy(asc(sessions.id))
        .limit(options.limit);
      return rows.map((row) => row.id);
    },

    async settleCollection(sessionId: string): Promise<boolean> {
      // Closed is final, and a day is past the worker credential's 12 hours
      // (worker-gateway.ts), so no attempt can still write an object here.
      // updated_at is the close at the latest. Without an open push request
      // no pin can be released to free more revisions.
      const settled = await db
        .update(sessions)
        .set({ checkpointCollectionSettledAt: DB_NOW })
        .where(
          and(
            eq(sessions.id, sessionId),
            isNull(sessions.checkpointCollectionSettledAt),
            eq(sessions.admissionState, "closed"),
            lt(sessions.updatedAt, sql`now() - interval '1 day'`),
            sql`NOT EXISTS (SELECT 1 FROM ${pushRequests} WHERE ${pushRequests.sessionId} = ${sessions.id} AND ${inArray(pushRequests.state, [...OPEN_PUSH_REQUEST_STATES])})`,
            // A deferred or pinned intent still becomes a request that
            // pins a revision; the collection is not over while one exists.
            sql`NOT EXISTS (SELECT 1 FROM ${pushIntents} WHERE ${pushIntents.sessionId} = ${sessions.id} AND ${pushIntents.status} IN ('deferred','pinned'))`,
          ),
        )
        .returning({ id: sessions.id });
      return settled.length > 0;
    },

    readPointer(sessionId: string): Promise<CheckpointPointer | null> {
      // Repeatable read, so the row and the checkpoint it names are read
      // from a single snapshot; read committed takes one per statement.
      return db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({
              id: sessions.id,
              checkpointRevision: sessions.checkpointRevision,
              checkpointCommittedAt: sessions.checkpointCommittedAt,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          return row ? readCheckpointPointer(tx, row) : null;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async listCheckpoints(
      sessionId: string,
      options: { belowRevision: number; limit: number },
    ): Promise<CheckpointPointer[]> {
      if (options.limit <= 0) return [];
      // Rows are only ever inserted, together with the pointer advance, so
      // everything below a pointer the caller already read is settled.
      const rows = await db
        .select({
          revision: checkpoints.revision,
          manifestRef: checkpoints.manifestRef,
          manifestSha256: checkpoints.manifestSha256,
          manifestVersion: checkpoints.manifestVersion,
          versionsHeld: checkpoints.versionsHeld,
          parentRevision: checkpoints.parentRevision,
          committedAt: checkpoints.committedAt,
          turnSequence: turns.sequence,
        })
        .from(checkpoints)
        .leftJoin(turns, eq(turns.id, checkpoints.turnId))
        .where(
          and(
            eq(checkpoints.sessionId, sessionId),
            lt(checkpoints.revision, options.belowRevision),
          ),
        )
        .orderBy(desc(checkpoints.revision))
        .limit(options.limit);
      return rows.map((row) => ({
        committedAt: row.committedAt,
        manifestRef: row.manifestRef,
        manifestSha256: row.manifestSha256,
        manifestVersion: row.manifestVersion,
        parentRevision: row.parentRevision,
        revision: row.revision,
        versionsHeld: row.versionsHeld,
        turnId: row.turnSequence === null ? null : String(row.turnSequence),
      }));
    },

    async listPinnedCommits(sessionId: string, limit: number) {
      if (limit <= 0) return [];
      const rows = await db
        .select({
          gitCommit: pushRequests.gitCommit,
          newest: sql<Date>`max(${pushRequests.createdAt})`,
        })
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.sessionId, sessionId),
            ne(pushRequests.state, "rejected"),
          ),
        )
        .groupBy(pushRequests.gitCommit)
        .orderBy(desc(sql`max(${pushRequests.createdAt})`))
        .limit(limit);
      return rows.map((row) => row.gitCommit);
    },
  };
}
