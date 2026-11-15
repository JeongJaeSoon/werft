import {
  type InputLimitRefusal,
  type InputLimitsSource,
  inputLimitsOf,
} from "@werft-ai/platform";
import { and, count, eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { storageUsage, turns } from "./schema.ts";

/** The one storage_usage row every acceptance charges today. */
export const INSTALLATION_STORAGE_SCOPE = "installation";

/**
 * Admits one input message against the installation's limits, inside the
 * acceptance transaction and after its replay check. Takes the storage row
 * lock last, after any session row lock the caller holds, so acceptances
 * always lock in the same order.
 *
 * This only checks. The charge is the `turns` insert trigger from migration
 * 0107, so a writer that knows nothing of the limit (an API build from
 * before it, still running during a rollout) is counted too. The row lock
 * taken here is held until the caller's turn insert commits, so two
 * acceptances racing for the last bytes serialize and the second one reads
 * the first one's charge.
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
  // The migration seeds the row; this only matters on a database it did not.
  await tx
    .insert(storageUsage)
    .values({ scope: INSTALLATION_STORAGE_SCOPE })
    .onConflictDoNothing();
  const [usage] = await tx
    .select({ bytes: storageUsage.bytes })
    .from(storageUsage)
    .where(eq(storageUsage.scope, INSTALLATION_STORAGE_SCOPE))
    .for("update");
  const bytes = Buffer.byteLength(input.message, "utf8");
  return (usage?.bytes ?? 0) + bytes > limits.storageLimitBytes
    ? { outcome: "storage_exhausted" }
    : null;
}
