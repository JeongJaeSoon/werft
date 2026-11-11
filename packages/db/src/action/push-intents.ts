import { randomUUID } from "node:crypto";
import {
  OPEN_PULL_REQUEST_STAGES,
  OPEN_PUSH_REQUEST_STATES,
  type PushClass,
  type PushIntent,
  type PushIntentRefusal,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type { PushIntentStore, PushIntentTransition } from "@werft-ai/platform";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { rowsOf } from "../control-unit-of-work.ts";
import { enqueueEndedIntentNotices } from "../musterrolle/action-notices.ts";
import { createPostgresPushRequests } from "../push-requests.ts";
import type { Database } from "../queries.ts";
import {
  pendingRequests,
  pushIntents,
  pushRequests,
  sessions,
  turnContinuations,
  turns,
} from "../schema.ts";

type Row = typeof pushIntents.$inferSelect;

export function publicPushIntent(row: Row): PushIntent {
  return {
    id: row.id,
    session_id: row.sessionId,
    repository_id: row.repositoryId,
    target_branch: row.targetBranch,
    status: row.status as PushIntent["status"],
    refusal_code: row.refusalCode as PushIntentRefusal | null,
    push_request_id: row.pushRequestId,
    source_ref: row.sourceRef,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Called from the finalize transaction of a turn, after its session row was
 * updated (so the session lock is held; creation takes the same lock first).
 * A turn that completed with a new checkpoint pins that revision on every
 * deferred intent of the turn; any other end cancels them, because the turn
 * left no state to push. A parked turn is not settled here: its intents wait
 * for the turn that carries it on. Returns how many intents it settled.
 */
export async function settleTurnPushIntents(
  tx: Database,
  input: {
    turnRowId: number;
    completedRevision: number | null;
  },
): Promise<number> {
  const pin = input.completedRevision;
  const rows = await tx
    .update(pushIntents)
    .set(
      pin === null
        ? {
            status: "cancelled",
            refusalCode: "turn_ended_without_checkpoint",
            settledAt: sql`now()`,
            updatedAt: sql`now()`,
          }
        : {
            status: "pinned",
            pinnedRevision: pin,
            updatedAt: sql`now()`,
          },
    )
    .where(
      and(
        eq(pushIntents.turnId, input.turnRowId),
        eq(pushIntents.status, "deferred"),
      ),
    )
    .returning({ id: pushIntents.id });
  if (pin === null) {
    await enqueueEndedIntentNotices(
      tx,
      rows.map((row) => row.id),
    );
  }
  return rows.length;
}

export function createPostgresPushIntents(db: Database): PushIntentStore {
  return {
    createDeferred(input) {
      const sessionId = input.sessionId.toLowerCase();
      return db.transaction(async (tx) => {
        // Session row first: finalize holds it while it pins or cancels this
        // turn's intents, so a create either lands before it (and is pinned
        // with the rest) or finds the turn no longer running.
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("update");
        if (session === undefined) return { outcome: "turn_not_running" };
        const [turn] = await tx
          .select({ id: turns.id })
          .from(turns)
          .where(
            and(
              eq(turns.id, input.turnId),
              eq(turns.sessionId, sessionId),
              eq(turns.attemptId, input.attemptId),
              eq(turns.status, "running"),
            ),
          )
          .limit(1);
        if (turn === undefined) return { outcome: "turn_not_running" };
        const taken = await tx
          .select()
          .from(pushIntents)
          .where(eq(pushIntents.turnId, input.turnId))
          .orderBy(asc(pushIntents.createdAt), asc(pushIntents.id));
        const sourceRef = input.sourceRef ?? null;
        const existing = taken.find(
          (row) =>
            row.repositoryId === input.repositoryId &&
            row.targetBranch === input.targetBranch,
        );
        if (
          existing &&
          (sourceRef === null ||
            existing.sourceRef === sourceRef ||
            existing.status !== "deferred")
        ) {
          return { outcome: "existing", intent: publicPushIntent(existing) };
        }
        const after = [
          ...taken.filter((row) => row !== existing),
          { sourceRef, targetBranch: input.targetBranch },
        ];
        const lacking =
          after.length > 1
            ? after.find((row) => row.sourceRef === null)
            : undefined;
        if (lacking) {
          return {
            outcome: "source_ref_required",
            targetBranch: lacking.targetBranch,
          };
        }
        if (existing) {
          const [updated] = await tx
            .update(pushIntents)
            .set({ sourceRef, updatedAt: sql`now()` })
            .where(eq(pushIntents.id, existing.id))
            .returning();
          if (!updated) throw new Error("push intent update returned no row");
          return { outcome: "existing", intent: publicPushIntent(updated) };
        }
        const [row] = await tx
          .insert(pushIntents)
          .values({
            id: randomUUID(),
            ownerId: input.ownerId,
            sessionId,
            turnId: input.turnId,
            attemptId: input.attemptId,
            repositoryId: input.repositoryId,
            targetBranch: input.targetBranch,
            sourceRef,
            actor: input.actor,
            approvalBasis: input.pushClass,
            policySource: input.policySource,
            pullRequest: input.pullRequest ?? null,
          })
          .returning();
        if (!row) throw new Error("push intent insert returned no row");
        return { outcome: "created", intent: publicPushIntent(row) };
      });
    },

    claimNext(leaseMs) {
      return db.transaction(async (tx) => {
        const [picked] = await tx
          .select({ intent: pushIntents, admission: sessions.admissionState })
          .from(pushIntents)
          .innerJoin(sessions, eq(sessions.id, pushIntents.sessionId))
          .where(
            and(
              eq(pushIntents.status, "pinned"),
              or(
                isNull(pushIntents.leaseExpiresAt),
                lt(pushIntents.leaseExpiresAt, sql`now()`),
              ),
              // One target is pushed in turn order: an older intent that is
              // still deferred or pinned goes first, even on another replica.
              sql`NOT EXISTS (
                SELECT 1 FROM push_intents earlier
                WHERE earlier.session_id = ${pushIntents.sessionId}
                  AND earlier.repository_id = ${pushIntents.repositoryId}
                  AND earlier.target_branch = ${pushIntents.targetBranch}
                  AND earlier.status IN ('deferred', 'pinned')
                  AND (earlier.created_at, earlier.id)
                    < (${pushIntents.createdAt}, ${pushIntents.id}))`,
              // Held sessions stay pinned; a closed one is claimed so the
              // runner can cancel it.
              or(
                eq(sessions.admissionState, "closed"),
                and(
                  eq(sessions.admissionState, "active"),
                  isNull(sessions.takeoverRequiredAt),
                ),
              ),
            ),
          )
          .orderBy(asc(pushIntents.createdAt))
          .limit(1)
          .for("update", { of: pushIntents, skipLocked: true });
        if (picked === undefined) return null;
        const { intent } = picked;
        const claimToken = randomUUID();
        await tx
          .update(pushIntents)
          .set({
            claimToken,
            leaseExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
            updatedAt: sql`now()`,
          })
          .where(eq(pushIntents.id, intent.id));
        return {
          id: intent.id,
          ownerId: intent.ownerId,
          sessionId: intent.sessionId,
          repositoryId: intent.repositoryId,
          targetBranch: intent.targetBranch,
          pinnedRevision: intent.pinnedRevision ?? 0,
          sourceRef: intent.sourceRef,
          actor: intent.actor as ReceiptActor,
          pushClass: intent.approvalBasis as PushClass,
          pullRequest: intent.pullRequest,
          claimToken,
          sessionClosed: picked.admission === "closed",
        };
      });
    },

    async end(job, status, code) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(pushIntents)
          .set({
            status,
            refusalCode: code,
            claimToken: null,
            leaseExpiresAt: null,
            settledAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(pushIntents.id, job.id),
              eq(pushIntents.status, "pinned"),
              eq(pushIntents.claimToken, job.claimToken),
            ),
          )
          .returning({ id: pushIntents.id });
        await enqueueEndedIntentNotices(
          tx,
          rows.map((row) => row.id),
        );
        return rows.length > 0;
      });
    },

    async settleStale() {
      // Session row first would be the lock order; this is a single
      // statement over rows no finalize can still pin (their turn is over or
      // their session closed), so it takes only the intent rows.
      return db.transaction(async (tx) => {
        const rows = await tx.execute(sql`
        UPDATE ${pushIntents} i
        SET status = 'cancelled',
            refusal_code = CASE WHEN s.admission_state = 'closed'
              THEN 'session_closed' ELSE 'turn_finalized_without_pin' END,
            settled_at = now(), updated_at = now()
        FROM ${sessions} s, ${turns} t
        WHERE i.status = 'deferred'
          AND s.id = i.session_id AND t.id = i.turn_id
          AND ((t.status NOT IN ('queued', 'running', 'needs_input')
                AND NOT EXISTS (
                  -- A parked turn whose group is not cancelled and not yet
                  -- carried on keeps its intent: the answer or a person's
                  -- resume takes it over, even after every request expired.
                  SELECT 1 FROM ${pendingRequests} p
                  WHERE p.turn_id = t.id AND p.parked_at IS NOT NULL
                    AND (p.settled_outcome IS NULL
                         OR p.settled_outcome <> 'cancelled')
                    AND NOT EXISTS (
                      SELECT 1 FROM ${turnContinuations} c
                      WHERE c.parked_turn_id = t.id)))
               OR s.admission_state = 'closed')
        RETURNING i.id`);
        const ended = rowsOf(rows) as Array<{ id: string }>;
        await enqueueEndedIntentNotices(
          tx,
          ended.map((row) => row.id),
        );
        return ended.length;
      });
    },

    transition(job, input) {
      return db.transaction(async (tx): Promise<PushIntentTransition> => {
        // Session row, then the intent row: the finalize and creation order.
        await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, job.sessionId))
          .for("update");
        const [row] = await tx
          .select()
          .from(pushIntents)
          .where(eq(pushIntents.id, job.id))
          .for("update");
        if (
          row === undefined ||
          row.status !== "pinned" ||
          row.claimToken !== job.claimToken
        ) {
          return { outcome: "lost" };
        }
        const end = async (
          status: "failed" | "cancelled",
          code: PushIntentRefusal,
        ): Promise<PushIntentTransition> => {
          await tx
            .update(pushIntents)
            .set({
              status,
              refusalCode: code,
              claimToken: null,
              leaseExpiresAt: null,
              settledAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(pushIntents.id, job.id));
          await enqueueEndedIntentNotices(tx, [job.id]);
          return { outcome: "ended", code };
        };
        // The session may have closed or been held since the claim: a closed
        // one cancels the intent, a held one keeps it pinned for later.
        const [held] = await tx
          .select({
            admission: sessions.admissionState,
            takeover: sessions.takeoverRequiredAt,
          })
          .from(sessions)
          .where(eq(sessions.id, job.sessionId));
        if (held === undefined || held.admission === "closed") {
          return end("cancelled", "session_closed");
        }
        if (held.admission !== "active" || held.takeover !== null) {
          await tx
            .update(pushIntents)
            .set({ claimToken: null, leaseExpiresAt: null })
            .where(eq(pushIntents.id, job.id));
          return { outcome: "waiting" };
        }
        // A person already turned this commit down for this target.
        const [rejected] = await tx
          .select({ id: pushRequests.id })
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.sessionId, job.sessionId),
              eq(pushRequests.repositoryId, job.repositoryId),
              eq(pushRequests.targetBranch, job.targetBranch),
              eq(pushRequests.gitCommit, input.gitCommit),
              eq(pushRequests.state, "rejected"),
            ),
          )
          .limit(1);
        if (rejected) return end("failed", "rejected_before");
        // The same target is busy: wait without writing a refusal receipt
        // on every drain. The common create below still checks it again.
        const [busy] = await tx
          .select({ id: pushRequests.id })
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.sessionId, job.sessionId),
              eq(pushRequests.repositoryId, job.repositoryId),
              eq(pushRequests.targetBranch, job.targetBranch),
              or(
                inArray(pushRequests.state, [...OPEN_PUSH_REQUEST_STATES]),
                inArray(pushRequests.prState, [...OPEN_PULL_REQUEST_STAGES]),
              ),
            ),
          )
          .limit(1);
        if (busy) {
          // A short lease with no token: the drain looks at the next intent
          // and comes back to this one, instead of re-picking it at once.
          await tx
            .update(pushIntents)
            .set({
              claimToken: null,
              leaseExpiresAt: sql`now() + interval '5 seconds'`,
            })
            .where(eq(pushIntents.id, job.id));
          return { outcome: "waiting" };
        }
        const result = await createPostgresPushRequests(tx).create({
          ...input,
          origin: "intent",
          // Copied in the same transaction and session row lock as the
          // request insert, so a later PR reservation sees both or neither.
          // The locked row, not the claim's copy: a reservation made after
          // the claim is on the row.
          pullRequestIntent: row.pullRequest ?? null,
          idempotencyKey: `intent-${job.id}`,
        });
        if (result.outcome === "refused") {
          if (result.refusal === "not_found") {
            return end("cancelled", "session_closed");
          }
          // request_open (an earlier push or PR stage): wait, stay pinned.
          await tx
            .update(pushIntents)
            .set({
              claimToken: null,
              leaseExpiresAt: sql`now() + interval '5 seconds'`,
            })
            .where(eq(pushIntents.id, job.id));
          return { outcome: "waiting" };
        }
        if (result.outcome === "conflict") return { outcome: "waiting" };
        await tx
          .update(pushIntents)
          .set({
            status: "requested",
            pushRequestId: result.request.id,
            claimToken: null,
            leaseExpiresAt: null,
            settledAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(pushIntents.id, job.id));
        return { outcome: "requested", pushRequestId: result.request.id };
      });
    },

    async list(ownerId, sessionId) {
      const rows = await db
        .select()
        .from(pushIntents)
        .where(
          and(
            eq(pushIntents.sessionId, sessionId.toLowerCase()),
            eq(pushIntents.ownerId, ownerId),
          ),
        )
        .orderBy(desc(pushIntents.createdAt), desc(pushIntents.id));
      return rows.map(publicPushIntent);
    },
  };
}
