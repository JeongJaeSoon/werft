import { verifyReleaseSpec } from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "./queries.ts";
import { agentReleases, sessions } from "./schema.ts";
import { sessionPinFromRelease } from "./session-spec-pin.ts";

const PAGE = 200;
const ENDED = ["failed", "stopped"] as const;
// The reconciliation pins a session of any status, though the gate counts
// live ones only: a stopped or failed session comes back through a resume, a
// recovery decision or a new input, and the flip refuses a live session
// without a pin.

export type PinReconciliation = {
  /** Pins written: missing, on another model than the session, or broken. */
  repaired: number;
  /** A model move or another pin got there first; the row was not touched. */
  raced: number;
  /** The release has no verified spec (yet), so there is nothing to copy. */
  unresolved: number;
  /** No model on the row: it is pinned once a claim or the model backfill sets one. */
  modelUnknown: number;
};

/**
 * Brings the spec pin of every live session of a release in line with the
 * release and the session's own model: a missing pin is written, a pin on
 * another model (an old replica moved the model only) or one that no longer
 * verifies is rewritten. The write is conditional on the model and pin it
 * read, so a model move or a newer pin is never overwritten. A session without
 * a model is counted, not guessed. Safe to run from several replicas and
 * again: a pin that holds is left alone.
 */
export async function reconcileSessionPins(
  db: Database,
): Promise<PinReconciliation> {
  const report: PinReconciliation = {
    repaired: 0,
    raced: 0,
    unresolved: 0,
    modelUnknown: 0,
  };
  let after: string | null = null;
  for (;;) {
    const page = await db
      .select({
        id: sessions.id,
        model: sessions.model,
        releaseId: sessions.agentReleaseId,
        pin: {
          spec_source: sessions.specSource,
          runtime_spec: sessions.runtimeSpec,
          spec_source_digest: sessions.specSourceDigest,
          spec_digest: sessions.specDigest,
        },
        release: {
          spec_source: agentReleases.specSource,
          runtime_spec: agentReleases.runtimeSpec,
          spec_source_digest: agentReleases.specSourceDigest,
          spec_digest: agentReleases.specDigest,
        },
      })
      .from(sessions)
      .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
      .where(
        and(
          // An ended session is read only when it lacks a pin or has one on
          // another model: its pin is not verified on every pass.
          or(
            notInArray(sessions.status, [...ENDED]),
            isNull(sessions.runtimeSpec),
            sql`${sessions.runtimeSpec} ->> 'model' IS DISTINCT FROM ${sessions.model}`,
          ),
          after === null ? undefined : gt(sessions.id, after),
        ),
      )
      .orderBy(asc(sessions.id))
      .limit(PAGE);
    for (const row of page) {
      after = row.id;
      if (row.releaseId === null) continue;
      if (row.model === null) {
        report.modelUnknown += 1;
        continue;
      }
      if (
        row.pin.runtime_spec !== null &&
        row.pin.runtime_spec.model === row.model &&
        verifyReleaseSpec(row.releaseId, row.pin).ok
      ) {
        continue;
      }
      const pin = sessionPinFromRelease(row.releaseId, row.release, row.model);
      if (pin === null) {
        report.unresolved += 1;
        continue;
      }
      const written = await db
        .update(sessions)
        .set(pin)
        .where(
          and(
            eq(sessions.id, row.id),
            eq(sessions.model, row.model),
            row.pin.spec_digest === null
              ? isNull(sessions.specDigest)
              : eq(sessions.specDigest, row.pin.spec_digest),
          ),
        )
        .returning({ id: sessions.id });
      if (written.length === 1) report.repaired += 1;
      else report.raced += 1;
    }
    if (page.length < PAGE) return report;
  }
}

export type PinGate = {
  /** A live release session with a model and no pin. */
  missing: number;
  /** A pin on another model than the session's, a null model included. */
  mismatched: number;
  /** A pin that does not verify against its release. */
  unverifiable: number;
  /** A live release session with neither a model nor a pin. */
  modelUnknown: number;
  /** A live session of no release: the release path cannot pin it. */
  releaseLess: number;
  /** True only when every count is zero. */
  open: boolean;
};

/**
 * What stands between the sessions and a reader that trusts the pin. Counts
 * live sessions only; a reader that uses a pin still checks it itself. All
 * five counts read one snapshot: a session that moves between kinds while
 * they run (a model backfill fills the model of one with neither) would
 * otherwise be missed by every count and let the gate open.
 */
export function sessionPinGate(db: Database): Promise<PinGate> {
  return db.transaction((tx) => readPinGate(tx as unknown as Database), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/**
 * The gate's counts on the transaction it is given. Each count is its own
 * statement, so the caller sets the isolation: `sessionPinGate` reads one
 * snapshot, the cutover flip holds the cutover lock instead.
 */
export async function readPinGate(db: Database): Promise<PinGate> {
  const live = notInArray(sessions.status, [...ENDED]);
  const count = async (where: ReturnType<typeof and>): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(live, where));
    return row?.n ?? 0;
  };
  const withRelease = isNotNull(sessions.agentReleaseId);
  const missing = await count(
    and(withRelease, isNull(sessions.runtimeSpec), isNotNull(sessions.model)),
  );
  const mismatched = await count(
    and(
      withRelease,
      isNotNull(sessions.runtimeSpec),
      sql`${sessions.runtimeSpec} ->> 'model' IS DISTINCT FROM ${sessions.model}`,
    ),
  );
  const modelUnknown = await count(
    and(withRelease, isNull(sessions.runtimeSpec), isNull(sessions.model)),
  );
  const releaseLess = await count(isNull(sessions.agentReleaseId));
  let unverifiable = 0;
  let after: string | null = null;
  for (;;) {
    const page = await db
      .select({
        id: sessions.id,
        releaseId: sessions.agentReleaseId,
        pin: {
          spec_source: sessions.specSource,
          runtime_spec: sessions.runtimeSpec,
          spec_source_digest: sessions.specSourceDigest,
          spec_digest: sessions.specDigest,
        },
      })
      .from(sessions)
      .where(
        and(
          live,
          isNotNull(sessions.runtimeSpec),
          isNotNull(sessions.agentReleaseId),
          after === null ? undefined : gt(sessions.id, after),
        ),
      )
      .orderBy(asc(sessions.id))
      .limit(PAGE);
    for (const row of page) {
      after = row.id;
      if (
        row.releaseId !== null &&
        !verifyReleaseSpec(row.releaseId, row.pin).ok
      ) {
        unverifiable += 1;
      }
    }
    if (page.length < PAGE) break;
  }
  return {
    missing,
    mismatched,
    unverifiable,
    modelUnknown,
    releaseLess,
    open:
      missing + mismatched + unverifiable + modelUnknown + releaseLess === 0,
  };
}
