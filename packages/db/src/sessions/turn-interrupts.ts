import type {
  InterruptReceiptResult,
  TerminalTurnStatus,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  type ControlResultEvent,
  logControlResult,
} from "../control-observability.ts";
import {
  expireOverdueReceipts,
  OPEN_TURN_STATUSES,
} from "../control-shared.ts";
import { fromDbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { controlIntents, receipts, turns } from "../schema.ts";

const INTERRUPT = "interrupt";

/**
 * `pending` is an interrupt stored while its turn ran. One that arrives after
 * the terminal did nothing, whatever the terminal says; a pending one did,
 * when the turn ended interrupted, and nobody can say it did not when the
 * outcome is unknown.
 */
export function interruptReceiptResult(
  turnSequence: number,
  terminal: TerminalTurnStatus,
  pending: boolean,
): InterruptReceiptResult {
  return {
    turn_id: String(turnSequence),
    terminal,
    no_op:
      !pending ||
      (terminal !== "interrupted" && terminal !== "outcome_unknown"),
  };
}

/**
 * Settles every interrupt still waiting on a turn, in the transaction that
 * gives the turn its terminal: the receipt then says what the turn actually
 * ended as, and nothing can hand the intent out after that. `interrupted` is
 * the interrupt's own doing; any other terminal got there first, which makes
 * the interrupt a no-op. An unknown outcome leaves the receipt unknown too.
 */
export async function settleTurnInterrupts(
  tx: Database,
  input: {
    sessionId: string;
    turnRowId: number;
    turnSequence: number;
    terminal: TerminalTurnStatus;
    terminalReason: string | null;
    at: Date;
  },
): Promise<ControlResultEvent[]> {
  const settled = await tx
    .update(controlIntents)
    .set({ settledAt: input.at })
    .where(
      and(
        eq(controlIntents.targetTurnId, input.turnRowId),
        eq(controlIntents.kind, INTERRUPT),
        isNull(controlIntents.settledAt),
      ),
    )
    .returning({
      acceptedAt: controlIntents.issuedAt,
      controlId: controlIntents.id,
      receiptId: controlIntents.receiptId,
    });
  if (settled.length === 0) return [];
  const result = interruptReceiptResult(
    input.turnSequence,
    input.terminal,
    true,
  );
  const unknown = input.terminal === "outcome_unknown";
  const updated = await tx
    .update(receipts)
    .set({
      status: unknown ? "unknown" : "succeeded",
      result,
      error: unknown
        ? {
            code: "RECOVERY_REQUIRED",
            message:
              "the interrupted turn ended without a result anyone can confirm",
          }
        : null,
      updatedAt: input.at,
    })
    .where(
      and(
        inArray(
          receipts.id,
          settled.map((row) => row.receiptId),
        ),
        // One already reported unknown past its deadline is upgraded to what
        // the turn actually ended as.
        inArray(receipts.status, ["accepted", "unknown"]),
      ),
    )
    .returning({ id: receipts.id });
  const updatedIds = new Set(updated.map(({ id }) => id));
  const reasonCode = result.no_op
    ? "no_op"
    : stableReasonCode(input.terminalReason, input.terminal);
  return settled
    .filter(({ receiptId }) => updatedIds.has(receiptId))
    .map(({ acceptedAt, controlId }) => ({
      acceptedAt,
      controlId,
      effectiveAt: input.at,
      operation: "interrupt",
      outcome: input.terminal,
      reasonCode,
      sessionId: input.sessionId,
    }));
}

function stableReasonCode(reason: string | null, outcome: string): string {
  if (reason === null) return outcome === "interrupted" ? "none" : outcome;
  return /^[a-z0-9_]+$/.test(reason) ? reason : "unspecified";
}

/**
 * an interrupt its turn has not settled by `deadlineMs` is reported
 * unknown rather than left accepted, as a terminate is past its deadline. By
 * then the reconciler has asked for the execution to go; if nothing confirms
 * that, nothing else would ever answer. The intent stays open, so the turn's
 * terminal, whenever it is written, still settles the receipt.
 */
export async function expireOverdueInterrupts(
  db: Database,
  input: {
    now: Date;
    deadlineMs: number;
    dryRun?: boolean;
    limit: number;
    logger?: Pick<StructuredLogger, "info">;
  },
): Promise<number> {
  return expireOverdueReceipts(db, {
    overdue: inArray(
      receipts.id,
      db
        .select({ id: controlIntents.receiptId })
        .from(controlIntents)
        .where(
          and(
            eq(controlIntents.kind, INTERRUPT),
            isNull(controlIntents.settledAt),
            lte(controlIntents.issuedAt, fromDbNow(-input.deadlineMs)),
          ),
        ),
    ),
    message: `the interrupted turn did not end within ${Math.round(input.deadlineMs / 1000)}s; reconciliation continues`,
    onExpired: async (expired) => {
      if (expired.length === 0) return;
      const intents = await db
        .select({
          acceptedAt: controlIntents.issuedAt,
          controlId: controlIntents.id,
          receiptId: controlIntents.receiptId,
          sessionId: controlIntents.sessionId,
        })
        .from(controlIntents)
        .where(
          and(
            eq(controlIntents.kind, INTERRUPT),
            inArray(
              controlIntents.receiptId,
              expired.map(({ id }) => id),
            ),
          ),
        );
      const expiredIds = new Set(expired.map(({ id }) => id));
      for (const intent of intents) {
        if (!expiredIds.has(intent.receiptId)) continue;
        logControlResult(input.logger, {
          acceptedAt: intent.acceptedAt,
          controlId: intent.controlId,
          effectiveAt: input.now,
          operation: "interrupt",
          outcome: "unknown",
          reasonCode: "deadline_exceeded",
          sessionId: intent.sessionId,
        });
      }
    },
    ...input,
  });
}

/**
 * The oldest interrupt this attempt still owes, while its turn is open. It is
 * handed out on every poll until the turn's terminal settles it: the worker
 * ignores repeats, and a crash between delivery and the interrupt loses
 * nothing.
 */
export async function openInterruptFor(
  tx: Database,
  input: { sessionId: string; attemptId: string },
) {
  const [row] = await tx
    .select({
      controlId: controlIntents.id,
      turnSequence: turns.sequence,
      issuedAt: controlIntents.issuedAt,
    })
    .from(controlIntents)
    .innerJoin(turns, eq(turns.id, controlIntents.targetTurnId))
    .where(
      and(
        eq(controlIntents.sessionId, input.sessionId),
        eq(controlIntents.attemptId, input.attemptId),
        eq(controlIntents.kind, INTERRUPT),
        isNull(controlIntents.settledAt),
        eq(turns.attemptId, input.attemptId),
        inArray(turns.status, OPEN_TURN_STATUSES),
      ),
    )
    .orderBy(asc(controlIntents.issuedAt), asc(controlIntents.id))
    .limit(1);
  return row ?? null;
}

/** Whether a turn has an interrupt waiting on it: it takes no new callbacks then. */
export async function turnInterruptPending(
  tx: Database,
  turnRowId: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(controlIntents)
    .where(
      and(
        eq(controlIntents.targetTurnId, turnRowId),
        eq(controlIntents.kind, INTERRUPT),
        isNull(controlIntents.settledAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}
