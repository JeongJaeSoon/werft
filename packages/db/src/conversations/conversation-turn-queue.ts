import { randomUUID } from "node:crypto";
import {
  CONVERSATION_TURN_LEASE_MS,
  type ConversationTurnId,
  conversationRuntimeTurnSchema,
  conversationTurnLeaseIdSchema,
  conversationTurnResultSchema,
} from "@werft-ai/contracts";
import {
  assertAttempt,
  type ConversationTurnOutcome,
  type ConversationTurnQueue,
  derivedSecretKey,
  ENDED_TURN_KEPT_MS,
  openWithKey,
  type SecretKey,
  sameResult,
  sealWithKey,
} from "@werft-ai/platform";
import { and, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { conversationTurnQueue as queue } from "../schema.ts";

const queuedTurnSchema = conversationRuntimeTurnSchema.omit({
  lease_id: true,
  lease_expires_at: true,
});

// A lease taken now would outlast the turn's permit.
const tooLate = (usableUntil: Date | null, now: Date, leaseMs: number) =>
  usableUntil !== null && now.getTime() + leaseMs > usableUntil.getTime();

// The sealed turn opens under its own row alone.
const aadOf = (turnId: string) =>
  Buffer.from(`conversation_turn_queue|${turnId}`, "utf8");

const notTaken = { outcome: "failed", reason: "not_taken" } as const;

/**
 * How long a turn that ended on spawn_task keeps its request for its task's
 * effect: the effect pass's window to try again (Architect, v1-b/E3). Past
 * it the request is let go, and the effect fails without it.
 */
export const SPAWN_INPUT_KEPT_MS = 60 * 60_000;

// A turn ending keeps its sealed input only when it was leased (what is
// sealed is then the input alone) and decided spawn_task with no effect yet.
const keepsInput = sql`(${queue.leaseId} IS NOT NULL AND EXISTS (
  SELECT 1 FROM conversation_turns t
  WHERE t.id = ${queue.turnId} AND t.decision = 'spawn_task'
    AND t.task_effect IS NULL))`;
const keptInputAt = (now: Date) => ({
  turnNonce: sql`CASE WHEN ${keepsInput} THEN ${queue.turnNonce} END`,
  turnCiphertext: sql`CASE WHEN ${keepsInput} THEN ${queue.turnCiphertext} END`,
  inputKeptUntil: sql`CASE WHEN ${keepsInput} THEN ${new Date(now.getTime() + SPAWN_INPUT_KEPT_MS).toISOString()}::timestamptz END`,
});
const OPEN = ["queued", "leased"] as const;

function outcomeOf(stored: unknown): ConversationTurnOutcome {
  if (
    typeof stored === "object" &&
    stored !== null &&
    "outcome" in stored &&
    "reason" in stored &&
    stored.outcome === "failed" &&
    (stored.reason === "not_taken" || stored.reason === "lease_expired") &&
    Object.keys(stored).length === 2
  ) {
    return { outcome: "failed", reason: stored.reason };
  }
  return conversationTurnResultSchema.parse(stored);
}

/**
 * The request a turn that ended on spawn_task kept for its task: its input
 * as its runtime was given it, the one place a turn's input is read from.
 * Null once it was let go, past its deadline, or when it cannot be opened.
 */
export async function keptTurnRequest(
  db: Database,
  secretKey: SecretKey,
  turnId: ConversationTurnId,
): Promise<string | null> {
  const [row] = await db
    .select({ nonce: queue.turnNonce, ciphertext: queue.turnCiphertext })
    .from(queue)
    .where(
      and(
        eq(queue.turnId, turnId),
        sql`${queue.inputKeptUntil} > clock_timestamp()`,
      ),
    );
  if (row?.nonce == null || row.ciphertext == null) return null;
  try {
    const opened = JSON.parse(
      openWithKey(
        derivedSecretKey(secretKey, "conversation-turn-queue"),
        aadOf(turnId),
        {
          nonce: Buffer.from(row.nonce),
          ciphertext: Buffer.from(row.ciphertext),
        },
      ),
    ) as { input?: { text?: unknown } };
    return typeof opened.input?.text === "string" ? opened.input.text : null;
  } catch {
    return null;
  }
}

/** Lets go of the request a turn kept, whatever its task's effect did. */
export async function releaseKeptTurnRequest(
  tx: Database,
  turnId: ConversationTurnId,
): Promise<void> {
  await tx
    .update(queue)
    .set({ turnNonce: null, turnCiphertext: null, inputKeptUntil: null })
    .where(and(eq(queue.turnId, turnId), isNotNull(queue.inputKeptUntil)));
}

/**
 * The turn queue in the database: what is queued outlives a restart, and
 * every API process sees the same turns. Each call runs in one transaction
 * under one lock for the whole queue, so a turn is leased to one runtime
 * once, and a topic has one turn out at a time across processes. Times are
 * the caller's `now`, as in the memory queue.
 */
export function createPostgresConversationTurnQueue(
  db: Database,
  secretKey: SecretKey,
): ConversationTurnQueue {
  const key = derivedSecretKey(secretKey, "conversation-turn-queue");

  const locked = <T>(work: (tx: Database) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('conversation_turn_queue'))`,
      );
      return work(tx);
    });

  const end = (
    tx: Database,
    turnId: ConversationTurnId,
    outcome: ConversationTurnOutcome,
    now: Date,
  ) =>
    tx
      .update(queue)
      .set({
        state: "ended",
        outcome,
        endedAt: now,
        ...keptInputAt(now),
      })
      .where(eq(queue.turnId, turnId));

  // A turn nobody took, or whose holder went quiet, ends here: never
  // requeued, since its permit may already be spent. One ended long enough
  // ago is forgotten, as the memory queue forgets it, but its row stays.
  async function settle(tx: Database, now: Date): Promise<void> {
    await tx
      .update(queue)
      // Its lease's ids and end stay: a turn queued behind it waits from then.
      .set({ state: "forgotten", outcome: null })
      .where(
        and(
          eq(queue.state, "ended"),
          sql`${queue.endedAt} <= ${new Date(now.getTime() - ENDED_TURN_KEPT_MS).toISOString()}::timestamptz`,
        ),
      );
    await tx
      .update(queue)
      .set({
        state: "ended",
        outcome: { outcome: "failed", reason: "lease_expired" },
        endedAt: now,
        ...keptInputAt(now),
      })
      .where(
        and(
          eq(queue.state, "leased"),
          sql`${queue.leaseExpiresAt} <= ${now.toISOString()}::timestamptz`,
        ),
      );
    // A kept request its task's effect never took is let go at its deadline.
    await tx
      .update(queue)
      .set({ turnNonce: null, turnCiphertext: null, inputKeptUntil: null })
      .where(sql`${queue.inputKeptUntil} <= ${now.toISOString()}::timestamptz`);
    const open = await tx
      .select({
        turnId: queue.turnId,
        topicId: queue.topicId,
        state: queue.state,
        takeBy: queue.takeBy,
        takeMs: queue.takeMs,
        usableUntil: queue.usableUntil,
      })
      .from(queue)
      .where(inArray(queue.state, [...OPEN]))
      .orderBy(queue.seq);
    const waiting = open.filter((row) => row.state === "queued");
    if (waiting.length === 0) return;
    const busy = new Set(
      open.filter((row) => row.state === "leased").map((row) => row.topicId),
    );
    // When each topic's last turn out ended: one queued behind it waits from then.
    const freed = new Map(
      (
        await tx
          .select({ topicId: queue.topicId, at: max(queue.endedAt) })
          .from(queue)
          .where(
            and(
              inArray(queue.topicId, [
                ...new Set(waiting.map((row) => row.topicId)),
              ]),
              inArray(queue.state, ["ended", "forgotten"]),
              isNotNull(queue.leaseId),
            ),
          )
          .groupBy(queue.topicId)
      ).map((row) => [row.topicId, row.at?.getTime() ?? 0]),
    );
    for (const row of waiting) {
      if (
        tooLate(row.usableUntil, now, CONVERSATION_TURN_LEASE_MS) ||
        (!busy.has(row.topicId) &&
          now.getTime() >=
            Math.max(
              row.takeBy.getTime(),
              (freed.get(row.topicId) ?? 0) + row.takeMs,
            ))
      ) {
        await end(tx, row.turnId, notTaken, now);
      }
    }
  }

  async function settledRow(
    tx: Database,
    turnId: ConversationTurnId,
    now: Date,
  ) {
    await settle(tx, now);
    const [row] = await tx.select().from(queue).where(eq(queue.turnId, turnId));
    return row;
  }

  return {
    durable: true,

    async enqueue(
      turn,
      { inputId, attempt, takeBy, now = new Date(), usableUntil },
    ) {
      assertAttempt(attempt);
      const sealed = sealWithKey(
        key,
        aadOf(turn.turn_id),
        JSON.stringify(turn),
      );
      const inserted = await db
        .insert(queue)
        .values({
          turnId: turn.turn_id,
          inputId,
          attempt,
          topicId: turn.scope.topic_id,
          state: "queued",
          takeBy,
          takeMs: Math.max(0, takeBy.getTime() - now.getTime()),
          usableUntil: usableUntil ?? null,
          turnNonce: sealed.nonce,
          turnCiphertext: sealed.ciphertext,
        })
        .onConflictDoNothing()
        .returning({ turnId: queue.turnId });
      if (inserted.length > 0) return "queued";
      const [same] = await db
        .select({ turnId: queue.turnId })
        .from(queue)
        .where(eq(queue.turnId, turn.turn_id));
      if (same !== undefined) {
        throw new Error(`Conversation turn ${turn.turn_id} is already queued`);
      }
      return "duplicate";
    },

    lease: ({ runtimeId, now, leaseMs }) =>
      locked(async (tx) => {
        await settle(tx, now);
        const open = await tx
          .select()
          .from(queue)
          .where(inArray(queue.state, [...OPEN]))
          .orderBy(queue.seq);
        // One turn of a topic at a time: the next waits for the one out to end.
        const busy = new Set(
          open
            .filter((row) => row.state === "leased")
            .map((row) => row.topicId),
        );
        for (const row of open) {
          if (row.state !== "queued" || busy.has(row.topicId)) continue;
          if (tooLate(row.usableUntil, now, leaseMs)) continue;
          let turn: ReturnType<typeof queuedTurnSchema.parse>;
          try {
            turn = queuedTurnSchema.parse(
              JSON.parse(
                openWithKey(key, aadOf(row.turnId), {
                  nonce: Buffer.from(row.turnNonce ?? []),
                  ciphertext: Buffer.from(row.turnCiphertext ?? []),
                }),
              ),
            );
          } catch {
            // Sealed under another key, or not a turn: no runtime can take it.
            await end(tx, row.turnId, notTaken, now);
            continue;
          }
          const leaseId = conversationTurnLeaseIdSchema.parse(randomUUID());
          const expiresAt = new Date(now.getTime() + leaseMs);
          // The turn's input alone stays sealed while it runs, for a task
          // its decision may ask for; its permit never outlives the lease.
          const input = sealWithKey(
            key,
            aadOf(row.turnId),
            JSON.stringify({ input: turn.input }),
          );
          await tx
            .update(queue)
            .set({
              state: "leased",
              leaseId,
              runtimeId,
              leaseExpiresAt: expiresAt,
              turnNonce: input.nonce,
              turnCiphertext: input.ciphertext,
            })
            .where(eq(queue.turnId, row.turnId));
          return {
            ...turn,
            lease_id: leaseId,
            lease_expires_at: expiresAt.toISOString(),
          };
        }
        return null;
      }),

    report: ({ turnId, leaseId, runtimeId, result, now }) =>
      locked(async (tx) => {
        const row = await settledRow(tx, turnId, now);
        if (row === undefined || row.state === "forgotten") {
          return "unknown_turn";
        }
        if (row.state === "queued") return "not_holder";
        if (row.leaseId !== leaseId || row.runtimeId !== runtimeId) {
          return "not_holder";
        }
        if (row.state === "leased") {
          await end(tx, turnId, result, now);
          return "recorded";
        }
        const outcome = outcomeOf(row.outcome);
        if ("reason" in outcome && outcome.reason === "lease_expired") {
          return "lease_expired";
        }
        return sameResult(outcome, result) ? "duplicate" : "conflict";
      }),

    outcome: (turnId, now) =>
      locked(async (tx) => {
        const row = await settledRow(tx, turnId, now);
        if (row === undefined || row.state === "forgotten") return null;
        return row.state === "ended" ? outcomeOf(row.outcome) : "pending";
      }),
  };
}
