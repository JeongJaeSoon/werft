import { and, asc, inArray, isNotNull, isNull, ne, not } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { agents } from "../schema.ts";
import { notDeleted } from "../soft-delete.ts";
import { hasOwner } from "./administers.ts";

export type OwnershipReconciled = { flagged: string[]; cleared: string[] };

/**
 * Stamps `ownerless_since` on up to `limit` live agents no one administers
 * that carry none, and clears it on up to `limit` that someone administers
 * again. Archived and deleted agents are left as they are. A dry run reports
 * what it would change. Rows a succession write holds are skipped; that write
 * judges them itself.
 */
export async function reconcileAgentOwnership(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<OwnershipReconciled> {
  const pick = (flag: boolean) => {
    const owned = hasOwner(db, agents.workspaceId, agents.id);
    return db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          notDeleted(agents),
          ne(agents.status, "archived"),
          flag
            ? and(isNull(agents.ownerlessSince), not(owned))
            : and(isNotNull(agents.ownerlessSince), owned),
        ),
      )
      .orderBy(asc(agents.id))
      .limit(input.limit);
  };
  const apply = async (flag: boolean): Promise<string[]> => {
    if (input.dryRun) return (await pick(flag)).map(({ id }) => id);
    const rows = await db
      .update(agents)
      .set({ ownerlessSince: flag ? DB_NOW : null })
      .where(inArray(agents.id, pick(flag).for("update", { skipLocked: true })))
      .returning({ id: agents.id });
    return rows.map(({ id }) => id);
  };
  return { flagged: await apply(true), cleared: await apply(false) };
}
