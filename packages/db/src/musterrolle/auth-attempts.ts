import type { AuthAttemptKind } from "@werft-ai/contracts";
import type {
  AuthAttemptKey,
  AuthAttemptStore,
  AuthAttemptWindowRef,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { authAttemptWindows, memberships, receipts, users } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

const windows = authAttemptWindows;

// Only keeps the refusal count from overflowing its integer column.
const COUNT_CAP = 2_147_483_647;

/** Longer than any window may be set to (api-settings caps them at a day). */
export const AUTH_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

const millis = (ms: number) =>
  sql`${ms}::double precision * interval '1 millisecond'`;

const keyOf = (kind: AuthAttemptKind, key: AuthAttemptKey) =>
  and(eq(windows.kind, kind), eq(windows.key, key));

export function createPostgresAuthAttemptStore(db: Database): AuthAttemptStore {
  return {
    async take(kind, key, rule) {
      // One statement per attempt: the row lock orders concurrent attempts
      // on every replica, and the database clock alone dates the window.
      // SET reads the row as it was, so `refused` says whether this attempt
      // found the window full. A refusal is not counted in `count`: only
      // admitted attempts are, and each of those can be given back.
      const ended = sql`${windows.windowStartedAt} <= excluded.window_started_at - ${millis(rule.windowMs)}`;
      const full = sql`${windows.count} >= ${rule.limit}`;
      const result = await db.execute(sql`
        INSERT INTO ${windows} (kind, key, window_started_at, count, refusals, refused)
        VALUES (${kind}, ${key}, clock_timestamp(), 1, 0, false)
        ON CONFLICT (kind, key) DO UPDATE SET
          window_started_at = CASE WHEN ${ended} THEN excluded.window_started_at ELSE ${windows.windowStartedAt} END,
          count = CASE WHEN ${ended} THEN 1 WHEN ${full} THEN ${windows.count} ELSE ${windows.count} + 1 END,
          refusals = CASE WHEN ${ended} THEN 0 WHEN ${full} THEN least(${windows.refusals} + 1, ${COUNT_CAP}) ELSE ${windows.refusals} END,
          refused = CASE WHEN ${ended} THEN false ELSE ${full} END
        RETURNING refused, refusals,
          window_started_at::text AS window_ref,
          (extract(epoch FROM window_started_at) * 1000)::text AS started_ms,
          (extract(epoch FROM window_started_at + ${millis(rule.windowMs)} - clock_timestamp()) * 1000)::text AS left_ms`);
      const [row] = rowsOf<{
        refused: boolean;
        refusals: number | string;
        window_ref: string;
        started_ms: string;
        left_ms: string;
      }>(result);
      if (!row) throw new Error("auth attempt upsert returned no row");
      if (!row.refused) {
        // The text form keeps the microseconds a Date would drop.
        return {
          admitted: true,
          window: row.window_ref as AuthAttemptWindowRef,
        };
      }
      return {
        admitted: false,
        retryAfterMs: Math.max(1, Math.ceil(Number(row.left_ms))),
        closedNow: Number(row.refusals) === 1,
        windowStartedAt: new Date(Number(row.started_ms)),
      };
    },

    async giveBack(kind, key, window) {
      await db
        .update(windows)
        .set({ count: sql`${windows.count} - 1` })
        .where(
          and(
            keyOf(kind, key),
            sql`${windows.windowStartedAt} = ${window}::timestamptz`,
            sql`${windows.count} >= 1`,
          ),
        );
    },

    async clear(kind, key) {
      await db.delete(windows).where(keyOf(kind, key));
    },

    async recordAccountLock(input) {
      const result = await db.execute(sql`
        INSERT INTO ${receipts} (id, owner_id, operation, target_ref, status, result)
        SELECT gen_random_uuid(), m.workspace_id::text, 'lock_login',
          jsonb_build_object('user_id', u.id, 'workspace_id', m.workspace_id),
          'succeeded',
          ${JSON.stringify({
            kind: "account",
            window_started_at: input.windowStartedAt.toISOString(),
            window_seconds: input.windowMs / 1000,
            failures: input.failures,
          })}::jsonb
        FROM ${users} u
        JOIN ${memberships} m ON m.user_id = u.id AND m.disabled_at IS NULL
        WHERE u.email = ${input.email} AND u.disabled_at IS NULL
        RETURNING owner_id, target_ref ->> 'user_id' AS user_id`);
      const rows = rowsOf<{ owner_id: string; user_id: string }>(result);
      const [first] = rows;
      if (!first) return null;
      return {
        userId: first.user_id,
        workspaceIds: rows.map((row) => row.owner_id),
      };
    },
  };
}

/** Windows that ended long ago: no attempt reads them any more. */
export async function purgeEndedAuthAttemptWindows(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  const ended = sql`
    SELECT kind, key FROM ${windows}
    WHERE window_started_at < statement_timestamp() - ${millis(AUTH_ATTEMPT_RETENTION_MS)}
    ORDER BY window_started_at
    LIMIT ${input.limit}`;
  const result = await db.execute(
    input.dryRun
      ? ended
      : sql`DELETE FROM ${windows} WHERE (kind, key) IN (${ended} FOR UPDATE SKIP LOCKED) RETURNING kind`,
  );
  return rowsOf<{ kind: string }>(result).length;
}
