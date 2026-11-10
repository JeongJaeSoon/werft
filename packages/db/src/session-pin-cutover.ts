import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  checkpoints,
  queueMessages,
  sessionPinCutover,
  sessions,
} from "./schema.ts";
import { type PinGate, readPinGate } from "./session-pins.ts";

// One key for every writer of what the pin gate counts. The flip takes it
// exclusively, a writer shares it, so the gate is read with nothing
// committing in between.
const CUTOVER_LOCK = sql`hashtextextended('session_pin_cutover', 0)`;

/** The reason a live session of no release is stopped with. */
export const RELEASE_LESS_STRANDED = "release_less_stranded";

async function requireReadCommitted(tx: Database): Promise<void> {
  const result = (await tx.execute(
    sql`SHOW transaction_isolation`,
  )) as unknown as { rows: { transaction_isolation?: string }[] };
  const level = result.rows[0]?.transaction_isolation;
  // A snapshot taken before the lock could still read the flag as it was.
  if (level !== "read committed") {
    throw new Error(
      `The session pin cutover needs a read committed transaction, not ${level}`,
    );
  }
}

/**
 * Called first by a transaction that writes anything the pin gate counts
 * (a session's creation, resume, release, model or pin). Takes the cutover
 * lock shared, then reads the flag in a statement of its own, so the flag it
 * returns is the one committed before the lock was granted. The caller refuses
 * what the pin does not allow when `authoritative` is true.
 */
export async function pinWriterGuard(
  tx: Database,
): Promise<{ authoritative: boolean }> {
  await requireReadCommitted(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${CUTOVER_LOCK})`);
  const [row] = await tx
    .select({ authoritative: sessionPinCutover.authoritative })
    .from(sessionPinCutover)
    .where(eq(sessionPinCutover.id, 1));
  return { authoritative: row?.authoritative ?? false };
}

/**
 * True when the pin is authoritative and the session, brought back to a live
 * status, would break the rule migration 0259 enforces: a release, a pin, and
 * a pin on the session's own model. A caller that reactivates a stopped
 * session asks first, so it can refuse in its own words instead of failing on
 * the trigger.
 */
export async function pinRefusesLive(
  tx: Database,
  session: {
    agentReleaseId: string | null;
    runtimeSpec: Record<string, unknown> | null;
    model: string | null;
  },
): Promise<boolean> {
  const { authoritative } = await pinWriterGuard(tx);
  if (!authoritative) return false;
  return (
    session.agentReleaseId === null ||
    session.runtimeSpec === null ||
    (session.runtimeSpec.model ?? null) !== session.model
  );
}

export type PinCutover =
  | { flipped: true; gate: PinGate }
  | { flipped: false; reason: "already_authoritative" }
  | { flipped: false; reason: "gate_closed"; gate: PinGate };

/**
 * Turns the pin authoritative, once and for good, if and only if the gate
 * reads zero under the exclusive cutover lock. Nothing in the service calls
 * this: whoever runs it decides when, and a closed gate changes nothing.
 */
export function flipPinCutover(db: Database): Promise<PinCutover> {
  return db.transaction(
    async (raw) => {
      const tx = raw as unknown as Database;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CUTOVER_LOCK})`);
      const [row] = await tx
        .select({ authoritative: sessionPinCutover.authoritative })
        .from(sessionPinCutover)
        .where(eq(sessionPinCutover.id, 1));
      if (row?.authoritative) {
        return { flipped: false, reason: "already_authoritative" } as const;
      }
      // Started after the lock was granted, so it sees what writers committed.
      const gate = await readPinGate(tx);
      if (!gate.open) {
        return { flipped: false, reason: "gate_closed", gate } as const;
      }
      const flipped = await tx
        .update(sessionPinCutover)
        .set({ authoritative: true, flippedAt: sql`now()` })
        .where(
          and(
            eq(sessionPinCutover.id, 1),
            eq(sessionPinCutover.authoritative, false),
          ),
        )
        .returning({ id: sessionPinCutover.id });
      if (flipped.length !== 1) {
        throw new Error("The session pin cutover row is missing");
      }
      return { flipped: true, gate } as const;
    },
    { isolationLevel: "read committed" },
  );
}

export type StrandedSession = {
  id: string;
  ownerId: string;
  status: string;
  profileId: string | null;
  /** Inputs not yet taken by a turn; a stop keeps them. */
  queuedInputs: number;
  /** The newest checkpoint revision that is still restorable, if any. */
  lastCheckpoint: number | null;
};

/**
 * Live sessions of no release: they have no spec to pin, so they hold the
 * gate closed until they end. The owner decides which to stop (the close
 * call, reason `release_less_stranded`); a stop keeps inputs and checkpoints.
 */
export async function listStrandedSessions(
  db: Database,
  limit = 500,
): Promise<StrandedSession[]> {
  const rows = await db
    .select({
      id: sessions.id,
      ownerId: sessions.ownerId,
      status: sessions.status,
      profileId: sessions.profileId,
      queuedInputs: sql<number>`(SELECT count(*)::int FROM ${queueMessages} q
        WHERE q.session_id = "sessions"."id" AND q.claimed_by IS NULL AND q.kind = 'message')`,
      lastCheckpoint: sql<
        number | null
      >`(SELECT max(c.revision) FROM ${checkpoints} c
        WHERE c.session_id = "sessions"."id" AND c.collected_at IS NULL)`,
    })
    .from(sessions)
    .where(
      and(
        isNull(sessions.agentReleaseId),
        notInArray(sessions.status, ["failed", "stopped"]),
      ),
    )
    .orderBy(asc(sessions.id))
    .limit(limit);
  return rows;
}
