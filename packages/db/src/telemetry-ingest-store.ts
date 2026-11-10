import { and, eq, isNotNull } from "drizzle-orm";
import { dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { attempts, sessions, turns, workerCredentials } from "./schema.ts";

const ENDED = new Set(["exited", "lost"]);

export interface TelemetryAttemptRecord {
  sessionId: string;
  attemptId: string;
  executionId: string;
  executionGeneration: number;
  workspaceId: string | null;
  /** True while the credential is live and the attempt still holds the session's fence. */
  held: boolean;
  /** How long ago the attempt stopped holding it, by the database clock; 0 while held. */
  lostForMs: number;
}

/**
 * Read-only lookups behind the telemetry ingest listener. A lost attempt's
 * credential is still resolved here so the listener can apply its grace; the
 * listener, not this store, decides how long that lasts.
 */
export function createPostgresTelemetryIngestStore(db: Database) {
  return {
    async attemptOfCredential(
      tokenHash: Uint8Array,
    ): Promise<TelemetryAttemptRecord | null> {
      const [row] = await db
        .select({
          sessionId: attempts.sessionId,
          attemptId: attempts.id,
          executionId: attempts.executionId,
          executionGeneration: attempts.executionGeneration,
          attemptState: attempts.state,
          endedAt: attempts.endedAt,
          leaseExpiresAt: attempts.leaseExpiresAt,
          lastHeartbeatAt: attempts.lastHeartbeatAt,
          startedAt: attempts.startedAt,
          leaseEpoch: attempts.leaseEpoch,
          authRevision: attempts.authRevision,
          revokedAt: workerCredentials.revokedAt,
          expiresAt: workerCredentials.expiresAt,
          workspaceId: sessions.workspaceId,
          sessionLeaseEpoch: sessions.leaseEpoch,
          sessionGeneration: sessions.executionGeneration,
          sessionAuthRevision: sessions.authRevision,
        })
        .from(workerCredentials)
        .innerJoin(attempts, eq(attempts.id, workerCredentials.attemptId))
        .innerJoin(sessions, eq(sessions.id, attempts.sessionId))
        .where(
          and(
            eq(workerCredentials.tokenHash, tokenHash),
            eq(workerCredentials.purpose, "gateway"),
          ),
        )
        .limit(1);
      if (row === undefined) return null;

      const now = (await dbNow(db)).getTime();
      const past = (at: Date | null) =>
        at !== null && at.getTime() <= now ? at.getTime() : undefined;
      const lostMarks = [
        row.endedAt?.getTime(),
        row.revokedAt?.getTime(),
        past(row.expiresAt),
        past(row.leaseExpiresAt),
      ].filter((mark): mark is number => mark !== undefined);
      const fenceMoved =
        row.sessionLeaseEpoch !== row.leaseEpoch ||
        row.sessionGeneration !== row.executionGeneration ||
        row.sessionAuthRevision !== row.authRevision;
      const held =
        lostMarks.length === 0 && !ENDED.has(row.attemptState) && !fenceMoved;
      // A moved fence leaves no timestamp of its own; the last sign of life
      // is the latest the attempt can have lost it, so the grace never
      // outlasts the real loss by more than that.
      const lostAt = held
        ? now
        : Math.min(
            ...(lostMarks.length > 0
              ? lostMarks
              : [(row.lastHeartbeatAt ?? row.startedAt).getTime()]),
          );
      return {
        sessionId: row.sessionId,
        attemptId: row.attemptId,
        executionId: row.executionId,
        executionGeneration: row.executionGeneration,
        workspaceId: row.workspaceId,
        held,
        lostForMs: Math.max(0, now - lostAt),
      };
    },

    /** Public turn ids (per-session sequence numbers) this attempt was handed. */
    async turnSequencesOf(attemptId: string): Promise<number[]> {
      const rows = await db
        .select({ sequence: turns.sequence })
        .from(turns)
        .where(and(eq(turns.attemptId, attemptId), isNotNull(turns.sequence)));
      return rows.map((row) => row.sequence);
    },
  };
}

export type TelemetryIngestStore = ReturnType<
  typeof createPostgresTelemetryIngestStore
>;
