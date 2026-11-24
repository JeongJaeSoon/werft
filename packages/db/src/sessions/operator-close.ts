import { randomUUID } from "node:crypto";
import type {
  AdmissionState,
  ControlAcceptedResponse,
} from "@werft-ai/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { receipts, sessions } from "../schema.ts";
import { closeAtomic, OPERATOR_CLI } from "./close-control.ts";
import { openDrainReceipt } from "./drain.ts";

export type OperatorCloseResult =
  | {
      outcome: "accepted";
      ownerId: string;
      receiptId: string;
      receiptStatus: ControlAcceptedResponse["receipt_status"];
      admissionState: AdmissionState;
    }
  | { outcome: "already_closed" }
  // A close already under way; its receipt, while it still waits on the worker.
  | { outcome: "closing"; receiptId: string | null }
  | {
      outcome:
        | "not_found"
        | "recovery_required"
        | "checkpoint_unavailable"
        | "unsupported";
    }
  | { outcome: "rejected"; admissionState: AdmissionState };

// A session that moves between the read and the close is read again; one
// that keeps moving is left to the operator to run the command again.
const REVISION_ATTEMPTS = 3;

/**
 * The owner's close (closeAtomic), asked for by the operator with no API key:
 * on whatever revision the session is at, under the session owner's
 * partition, with the stream naming the operator. A live worker drains and
 * releases as for any close; the session is closed once it is seen gone.
 */
export async function closeSessionAsOperator(
  db: Database,
  input: { sessionId: string; reason: string; now: Date },
): Promise<OperatorCloseResult> {
  const sessionId = input.sessionId.toLowerCase();
  for (let attempt = 1; ; attempt++) {
    const [row] = await db
      .select({
        ownerId: sessions.ownerId,
        revision: sessions.revision,
        admissionState: sessions.admissionState,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return { outcome: "not_found" };
    if (row.admissionState === "closed") return { outcome: "already_closed" };
    if (row.admissionState === "closing") {
      const [open] = await db
        .select({ id: receipts.id })
        .from(receipts)
        .where(openDrainReceipt(sessionId))
        .limit(1);
      return { outcome: "closing", receiptId: open?.id ?? null };
    }
    const result = await closeAtomic(db, {
      principal: { ownerId: row.ownerId },
      sessionId,
      idempotencyKey: randomUUID(),
      payloadHash: OPERATOR_CLI,
      expectedRevision: row.revision,
      reason: input.reason,
      now: input.now,
      by: OPERATOR_CLI,
    });
    switch (result.outcome) {
      case "accepted": {
        const [after] = await db
          .select({ admissionState: sessions.admissionState })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        return {
          outcome: "accepted",
          ownerId: row.ownerId,
          receiptId: result.response.receipt_id,
          receiptStatus: result.response.receipt_status,
          admissionState: after?.admissionState ?? "closed",
        };
      }
      case "revision_conflict":
        if (attempt < REVISION_ATTEMPTS) continue;
        throw new Error(
          `session ${sessionId} kept changing while it was closed; run the command again`,
        );
      case "rejected":
        // Closed or closing by someone else since the read: say which.
        if (
          result.admissionState === "closed" ||
          result.admissionState === "closing"
        ) {
          continue;
        }
        return result;
      case "replayed":
      case "conflict":
        // A fresh key each time: nothing to replay or conflict with.
        throw new Error(`unexpected close outcome ${result.outcome}`);
      default:
        return { outcome: result.outcome };
    }
  }
}
