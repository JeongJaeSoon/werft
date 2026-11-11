import type { Pool } from "pg";

/**
 * One job at a time: a session-level advisory lock on its own connection,
 * held until `release`. Null when another job holds it.
 */
export async function acquireMigrationLock(
  pool: Pool,
): Promise<{ release(): Promise<void> } | null> {
  const client = await pool.connect();
  const { rows } = await client.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('agents:migration')) AS ok",
  );
  if (rows[0]?.ok !== true) {
    client.release();
    return null;
  }
  return {
    async release() {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('agents:migration'))",
        );
      } finally {
        client.release();
      }
    },
  };
}
