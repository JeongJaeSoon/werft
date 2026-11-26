import { sql } from "drizzle-orm";
import { INSTALLATION_STORAGE_SCOPE } from "./input-limits.ts";
import type { Database } from "./queries.ts";
import { rowsOf } from "./statement-rows.ts";

// pg_try_advisory_xact_lock key: no two replicas scan turns side by side. A
// replica that finds it taken skips that moment's check; one that comes after
// another's scan ended scans again, which only repeats a read.
export const STORAGE_COUNTER_CHECK_LOCK_KEY = 2_271_001;

export type StorageCounterCheck =
  | { outcome: "busy" }
  | { outcome: "checked"; counterBytes: number; actualBytes: number };

/**
 * Reads the installation's storage counter and the bytes its turns hold, in
 * one statement so both come from one snapshot: a turn and its charge commit
 * together. Changes nothing, the counter included. The turns read is a full
 * scan, so that statement is cut off after `timeoutMs` and the error is
 * thrown as it came.
 */
export async function checkStorageCounter(
  db: Database,
  options: { timeoutMs: number },
): Promise<StorageCounterCheck> {
  return db.transaction(async (tx) => {
    const [lock] = rowsOf<{ locked: boolean }>(
      await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(${STORAGE_COUNTER_CHECK_LOCK_KEY}) AS locked`,
      ),
    );
    if (!lock?.locked) return { outcome: "busy" };
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = ${Math.trunc(options.timeoutMs)}`),
    );
    const [row] = rowsOf<{ counter: unknown; actual: unknown }>(
      await tx.execute(sql`
        SELECT
          coalesce((SELECT bytes FROM storage_usage WHERE scope = ${INSTALLATION_STORAGE_SCOPE}), 0) AS counter,
          (SELECT coalesce(sum(octet_length(message)), 0) FROM turns) AS actual`),
    );
    return {
      outcome: "checked",
      counterBytes: Number(row?.counter ?? 0),
      actualBytes: Number(row?.actual ?? 0),
    };
  });
}
