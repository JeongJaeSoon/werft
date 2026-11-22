import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { retiredCatalogMcp } from "../schema.ts";

const AFTER_EVERY_SESSION = new Date("2999-01-01T00:00:00Z");

/**
 * Writes what a host wrote before migration 0303 retired the installation
 * catalog MCP: a version or release whose card names a catalog server. The
 * refusal triggers are off while `write` runs, and the server's restore
 * record is the one 0303 would have kept, retired after every session the
 * test makes, as 0303 ran after the sessions it found. One connection only
 * (PGlite): the setting is the session's.
 */
export async function beforeCatalogRetired<T>(
  db: Database,
  server: { name: string; url: string; credentialRef: string },
  write: () => Promise<T>,
): Promise<T> {
  await db
    .insert(retiredCatalogMcp)
    .values({ ...server, retiredAt: AFTER_EVERY_SESSION })
    .onConflictDoNothing({ target: retiredCatalogMcp.name });
  await db.execute(sql`SET session_replication_role = replica`);
  try {
    return await write();
  } finally {
    await db.execute(sql`RESET session_replication_role`);
  }
}
