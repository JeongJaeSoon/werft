import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromDbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { setupLinks } from "../schema.ts";

/**
 * The hash of a live setup link, for a test that calls bootstrapOwner
 * directly. Inserted without issueSetupLink's lock and owner check, so a test
 * can hold it while it stages a race.
 */
export async function liveSetupLinkHash(db: Database): Promise<Uint8Array> {
  const tokenHash = randomBytes(32);
  await db.insert(setupLinks).values({
    tokenHash,
    expiresAt: fromDbNow(60_000),
    epoch: sql`(SELECT last_value FROM setup_link_epoch)`,
  });
  return tokenHash;
}
