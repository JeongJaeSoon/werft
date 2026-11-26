import { sql } from "drizzle-orm";
import type { Database } from "./queries.ts";

// The database clock is the one authority on lease, token and launch nonce
// time. Every API replica and the scheduler carry their own clocks, and a
// lagging one would otherwise approve writes for an attempt whose lease
// ended, accept a nonce whose window closed, or refuse a live one early.
export const DB_NOW = sql<Date>`clock_timestamp()`;

export function fromDbNow(ttlMs: number) {
  return sql<Date>`clock_timestamp() + ${ttlMs}::double precision * interval '1 millisecond'`;
}

// As epoch milliseconds: the driver hands raw SQL timestamps back as text.
export const DB_NOW_EPOCH_MS = sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`;

export function parseDbNow(epochMs: string | undefined): Date {
  const parsed = Number(epochMs);
  if (!Number.isFinite(parsed)) {
    throw new Error("clock_timestamp() unreadable");
  }
  return new Date(parsed);
}

// Never in the target list of a locking SELECT: a volatile function there is
// evaluated before the row lock is granted, which would reopen the lock-wait
// window the fence exists to close. Read it above the lock instead, as
// acquireFence does.
export async function dbNow(tx: Database): Promise<Date> {
  const [row] = await tx
    .select({ epochMs: DB_NOW_EPOCH_MS })
    .from(sql`(SELECT 1) AS one`);
  return parseDbNow(row?.epochMs);
}
