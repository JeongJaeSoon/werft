import { randomUUID } from "node:crypto";
import { ENDED_ATTEMPT_STATES } from "@werft-ai/contracts";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";

import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  attempts,
  egressDenials,
  sessions,
  turns,
  workerCredentials,
} from "../schema.ts";

/**
 * The most refusals one attempt records. The token rides in the engine's
 * environment, where its tools can read it, so a tool that loops over hosts
 * stops adding rows here rather than filling the table.
 */
export const EGRESS_DENIALS_PER_ATTEMPT = 50;

export type EgressDenialReport = {
  /** sha256 of the `egress_report` token the proxy read off the request. */
  tokenHash: Uint8Array;
  host: string;
  port: number;
};

export type EgressDenialOutcome =
  | { outcome: "recorded"; sessionId: string; turnId: number | null }
  | { outcome: "duplicate" }
  | { outcome: "over_limit" }
  /** Unknown, revoked, expired, or a token of another purpose. */
  | { outcome: "invalid_token" }
  /** The attempt ended, lost its lease, or no longer owns its session. */
  | { outcome: "stale" };

/**
 * Records one refusal the forward proxy reported, against the turn the
 * attempt is running now. The session and attempt rows are locked in the
 * order every gateway path takes them (lease-reconcile.ts), and everything is
 * judged again after the locks: a release, a revocation or a claim replay
 * that committed while this waited is seen. The attempt lock also orders
 * reports of one attempt, so the count and the insert see each other.
 */
export function recordEgressDenial(
  db: Database,
  report: EgressDenialReport,
): Promise<EgressDenialOutcome> {
  return db.transaction(async (tx) => {
    // A report waits on the rows a heartbeat or a release holds; it is not
    // worth a proxy's slot for longer than one heartbeat waits.
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    const byToken = and(
      eq(workerCredentials.tokenHash, report.tokenHash),
      eq(workerCredentials.purpose, "egress_report"),
    );
    const [token] = await tx
      .select({
        attemptId: workerCredentials.attemptId,
        sessionId: attempts.sessionId,
      })
      .from(workerCredentials)
      .innerJoin(attempts, eq(attempts.id, workerCredentials.attemptId))
      .where(and(byToken, isNull(workerCredentials.revokedAt)))
      .limit(1);
    if (!token) return { outcome: "invalid_token" };
    await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, token.sessionId))
      .for("update");
    await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.id, token.attemptId))
      .for("update");
    // One statement after the locks, so its clock is read after any wait.
    const [judged] = await tx
      .select({
        live: sql<boolean>`${isNull(workerCredentials.revokedAt)} AND ${gt(workerCredentials.expiresAt, DB_NOW)}`,
        owns: sql<boolean>`${and(
          notInArray(attempts.state, ENDED_ATTEMPT_STATES),
          gt(attempts.leaseExpiresAt, DB_NOW),
          eq(sessions.leaseEpoch, attempts.leaseEpoch),
          eq(sessions.executionGeneration, attempts.executionGeneration),
        )}`,
      })
      .from(workerCredentials)
      .innerJoin(attempts, eq(attempts.id, workerCredentials.attemptId))
      .innerJoin(sessions, eq(sessions.id, attempts.sessionId))
      .where(byToken)
      .limit(1);
    if (!judged?.live) return { outcome: "invalid_token" };
    if (!judged.owns) return { outcome: "stale" };
    const [turn] = await tx
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.sessionId, token.sessionId),
          eq(turns.attemptId, token.attemptId),
          eq(turns.status, "running"),
        ),
      )
      .orderBy(desc(turns.id))
      .limit(1);
    const turnId = turn?.id ?? null;
    const [held] = await tx
      .select({ n: count() })
      .from(egressDenials)
      .where(eq(egressDenials.attemptId, token.attemptId));
    if ((held?.n ?? 0) >= EGRESS_DENIALS_PER_ATTEMPT) {
      return { outcome: "over_limit" };
    }
    const inserted = await tx
      .insert(egressDenials)
      .values({
        id: randomUUID(),
        sessionId: token.sessionId,
        attemptId: token.attemptId,
        turnId,
        host: report.host,
        port: report.port,
      })
      .onConflictDoNothing()
      .returning({ id: egressDenials.id });
    return inserted.length === 0
      ? { outcome: "duplicate" }
      : { outcome: "recorded", sessionId: token.sessionId, turnId };
  });
}

/**
 * With the attempt's credentials, on every path that revokes them: the rows
 * serve the attempt that holds them.
 */
export async function deleteAttemptEgressDenials(
  tx: Database,
  attemptId: string,
): Promise<void> {
  await tx.delete(egressDenials).where(eq(egressDenials.attemptId, attemptId));
}

/**
 * Rows an ended attempt still holds. Every end path of this code takes them,
 * but a control-host from before them (a rolling upgrade, a rollback) ends
 * attempts and revokes their tokens without, and a later pass sees the
 * attempt ended and skips it.
 */
export async function deleteEndedAttemptEgressDenials(
  db: Database,
): Promise<void> {
  await db.delete(egressDenials).where(
    exists(
      db
        .select({ id: attempts.id })
        .from(attempts)
        .where(
          and(
            eq(attempts.id, egressDenials.attemptId),
            inArray(attempts.state, ENDED_ATTEMPT_STATES),
          ),
        ),
    ),
  );
}

/** An operator's revocation takes every attempt's tokens of the session. */
export async function deleteSessionEgressDenials(
  tx: Database,
  sessionId: string,
): Promise<void> {
  await tx.delete(egressDenials).where(eq(egressDenials.sessionId, sessionId));
}

// Read by tests only.
export const egressDenialsOf = (db: Database, attemptId: string) =>
  db
    .select({
      turnId: egressDenials.turnId,
      host: egressDenials.host,
      port: egressDenials.port,
    })
    .from(egressDenials)
    .where(eq(egressDenials.attemptId, attemptId))
    .orderBy(sql`${egressDenials.createdAt}`);
