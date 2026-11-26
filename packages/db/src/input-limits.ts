import {
  type InputLimitRefusal,
  type InputLimitsSource,
  inputLimitsOf,
} from "@werft-ai/platform";
import { and, count, eq, sql } from "drizzle-orm";
import { findPgError } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import { storageUsage, turns } from "./schema.ts";
import { rowsOf } from "./statement-rows.ts";

/** The one storage_usage row every acceptance charges today. */
export const INSTALLATION_STORAGE_SCOPE = "installation";

/**
 * Set for its transaction by an acceptance, read by the charge trigger
 * (`storage_usage_charge_turn`) at commit: the bytes the installation may
 * keep. A transaction that leaves it unset is charged and never refused.
 */
export const STORAGE_LIMIT_SETTING = "werft.storage_limit_bytes";

/** What the charge trigger raises at commit past the limit, and nothing else does. */
export const STORAGE_LIMIT_SQLSTATE = "WF001";

/**
 * Admits one input message against the installation's limits, inside the
 * acceptance transaction and after its replay check.
 *
 * The storage check here takes no lock and decides nothing for good: it
 * refuses early what cannot fit, so a full installation answers without
 * writing. What decides is the charge trigger on `turns`, which adds the
 * message's bytes at commit and raises `STORAGE_LIMIT_SQLSTATE` when the sum
 * it wrote is past the limit set here; `acceptanceTransaction` answers that
 * as the same refusal. The storage row is locked for the commit alone, so
 * acceptances do not wait for each other's transactions, and two racing for
 * the last bytes still cannot both fit.
 *
 * `sessionId` is null for a session this transaction is creating: it has no
 * queued turns yet, and the limit is at least one.
 */
export async function admitInput(
  tx: Database,
  input: {
    sessionId: string | null;
    message: string;
    limits: InputLimitsSource;
  },
): Promise<InputLimitRefusal | null> {
  const limits = inputLimitsOf(input.limits);
  if (input.sessionId !== null) {
    const [queued] = await tx
      .select({ count: count() })
      .from(turns)
      .where(
        and(eq(turns.sessionId, input.sessionId), eq(turns.status, "queued")),
      );
    if ((queued?.count ?? 0) >= limits.queuedInputLimitPerSession) {
      return { outcome: "queue_full" };
    }
  }
  // One statement, and a row even when storage_usage has none: the setting
  // must not depend on the usage row being there.
  const result = await tx.execute(sql`
    SELECT set_config(${STORAGE_LIMIT_SETTING}, ${String(limits.storageLimitBytes)}, true),
      (SELECT ${storageUsage.bytes} FROM ${storageUsage}
        WHERE ${storageUsage.scope} = ${INSTALLATION_STORAGE_SCOPE}) AS bytes`);
  const used = Number(rowsOf<{ bytes: unknown }>(result)[0]?.bytes ?? 0);
  const bytes = Buffer.byteLength(input.message, "utf8");
  return used + bytes > limits.storageLimitBytes
    ? { outcome: "storage_exhausted" }
    : null;
}

/**
 * Runs an acceptance in a transaction of its own and answers the charge
 * trigger's refusal at its commit as `storage_exhausted`. The transaction
 * rolled back whole, its receipt and idempotency record included, so the
 * same key sent again is decided anew. Any other commit error is thrown as
 * it came.
 */
export async function acceptanceTransaction<T>(
  db: Database,
  work: (tx: Database) => Promise<T>,
): Promise<T | InputLimitRefusal> {
  try {
    return await db.transaction(work);
  } catch (error) {
    if (findPgError(error, STORAGE_LIMIT_SQLSTATE) === undefined) throw error;
    return { outcome: "storage_exhausted" };
  }
}
