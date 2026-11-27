import { randomUUID } from "node:crypto";
import { ENDED_ATTEMPT_STATES } from "@werft-ai/contracts";
import { and, count, desc, eq, gt, isNull, notInArray, sql } from "drizzle-orm";

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
 * attempt is running now. The attempt row lock orders reports of one
 * attempt, so the count and the insert see each other.
 */
export function recordEgressDenial(
  db: Database,
  report: EgressDenialReport,
): Promise<EgressDenialOutcome> {
  return db.transaction(async (tx) => {
    const [token] = await tx
      .select({ attemptId: workerCredentials.attemptId })
      .from(workerCredentials)
      .where(
        and(
          eq(workerCredentials.tokenHash, report.tokenHash),
          eq(workerCredentials.purpose, "egress_report"),
          isNull(workerCredentials.revokedAt),
          gt(workerCredentials.expiresAt, DB_NOW),
        ),
      )
      .limit(1);
    if (!token) return { outcome: "invalid_token" };
    const [owned] = await tx
      .select({ sessionId: attempts.sessionId })
      .from(attempts)
      .innerJoin(sessions, eq(sessions.id, attempts.sessionId))
      .where(
        and(
          eq(attempts.id, token.attemptId),
          notInArray(attempts.state, ENDED_ATTEMPT_STATES),
          gt(attempts.leaseExpiresAt, DB_NOW),
          eq(sessions.leaseEpoch, attempts.leaseEpoch),
          eq(sessions.executionGeneration, attempts.executionGeneration),
        ),
      )
      .limit(1)
      .for("update", { of: attempts });
    if (!owned) return { outcome: "stale" };
    const [turn] = await tx
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.sessionId, owned.sessionId),
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
        sessionId: owned.sessionId,
        attemptId: token.attemptId,
        turnId,
        host: report.host,
        port: report.port,
      })
      .onConflictDoNothing()
      .returning({ id: egressDenials.id });
    return inserted.length === 0
      ? { outcome: "duplicate" }
      : { outcome: "recorded", sessionId: owned.sessionId, turnId };
  });
}

/** With the attempt's credentials: the rows serve the attempt that holds them. */
export async function deleteAttemptEgressDenials(
  tx: Database,
  attemptId: string,
): Promise<void> {
  await tx.delete(egressDenials).where(eq(egressDenials.attemptId, attemptId));
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
