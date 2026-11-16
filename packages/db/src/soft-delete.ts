import { isNull, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { DB_NOW } from "./db-clock.ts";

// A deleted row keeps its place with `deleted_at` and `deleted_by` set; every
// read of such a table leaves it out with `notDeleted`, so a deleted row
// looked up by id reads as not found. Its secret material is destroyed in the
// delete's own transaction.

/** The rows of a soft-deleted table that are still there. */
export function notDeleted(table: { deletedAt: PgColumn }): SQL {
  return isNull(table.deletedAt);
}

/**
 * The columns a soft delete sets. `deleted_by` is the person, or the API key
 * when no person stands behind it; a receipt says which.
 */
export function deletedBy(
  by:
    | string
    | { userId: string | null; apiKeyId: string | null }
    | null
    | undefined,
) {
  const id = typeof by === "string" ? by : (by?.userId ?? by?.apiKeyId);
  if (!id) throw new Error("a delete names who made it");
  return { deletedAt: DB_NOW, deletedBy: id };
}
