import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/** The backend the transaction runs on, to name it as a blocker. */
export async function backendPid(tx: Database): Promise<number> {
  const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  const pid = rowsOf<{ pid: number }>(result)[0]?.pid;
  if (pid === undefined) throw new Error("no backend pid");
  return pid;
}

/**
 * True once another backend waits on a lock `blocker` holds; false when
 * `settled` turns true first, so a statement that never waited is told apart
 * from one that waited. Gives up after `timeoutMs`.
 */
export async function waitsOn(
  db: Database,
  blocker: number,
  settled: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE ${blocker}::int = ANY(pg_blocking_pids(pid))
      ) AS waiting`);
    if (rowsOf<{ waiting: boolean }>(result)[0]?.waiting === true) return true;
    if (settled()) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
