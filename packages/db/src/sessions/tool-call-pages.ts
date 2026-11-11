import type {
  UsageSummaryFilter,
  UsageToolCallRecord,
  UsageToolCallsFilter,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import { rowsOf } from "../control-unit-of-work.ts";
import { sessionVisibleTo } from "../musterrolle/session-shares.ts";
import type { Database } from "../queries.ts";
import {
  decodeToolCallCursor,
  encodeToolCallCursor,
  rethrowCursorCastError,
  type ToolCallCursor,
} from "./cursors.ts";
import { periodParts, scopeOf } from "./tool-calls.ts";

const stamp = (date: Date) => sql`${date.toISOString()}::timestamptz`;
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// The orders match tool_calls_recent_idx and tool_calls_slowest_idx.
function order(sort: ToolCallCursor["sort"]): SQL {
  return sort === "recent"
    ? sql`c.at DESC NULLS LAST, c.use_event_id DESC NULLS LAST, c.ord DESC NULLS LAST`
    : sql`c.ms DESC NULLS LAST, c.use_event_id DESC NULLS LAST, c.ord DESC NULLS LAST`;
}

function after(cursor: ToolCallCursor | undefined): SQL {
  if (cursor === undefined) return sql`true`;
  const tie = sql`(c.use_event_id, c.ord) < (${cursor.id}, ${cursor.ord})`;
  if (cursor.sort === "recent") {
    return sql`(c.at, c.use_event_id, c.ord) < (${cursor.at}::timestamptz, ${cursor.id}, ${cursor.ord})`;
  }
  // Untimed calls come last, after every timed one.
  return cursor.ms === null
    ? sql`(c.ms IS NULL AND ${tie})`
    : sql`(c.ms < ${cursor.ms} OR (c.ms = ${cursor.ms} AND ${tie}) OR c.ms IS NULL)`;
}

/**
 * One page of a tool's calls whose tool_use was stored in [since, until).
 * A session shows its id and title only in the caller's owner partition and
 * when sessionVisibleTo says the caller may read it; installation scope
 * crosses owners, where a workspace share means nothing to this caller.
 */
export async function toolCallPage(
  db: Database,
  filter: UsageSummaryFilter,
  options: UsageToolCallsFilter & { until: Date },
): Promise<{ calls: UsageToolCallRecord[]; nextCursor: string | null }> {
  const scope = scopeOf(filter, options.agentId);
  const cursor =
    options.cursor === undefined
      ? undefined
      : decodeToolCallCursor(options.cursor, options.sort);
  const result = await db
    .execute(sql`
      SELECT c.use_event_id, c.ord, c.at, c.at::text AS at_text, c.ms, c.outcome,
        a.name AS agent,
        CASE WHEN EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.id = c.session_id AND sessions.owner_id = ${options.ownerId}
            AND ${sessionVisibleTo(db, options.viewer)}
        ) THEN s.id END AS session_id,
        s.title
      FROM tool_calls c
      JOIN sessions s ON s.id = c.session_id
      LEFT JOIN agent_releases ar ON ar.id = s.agent_release_id
      LEFT JOIN agents a ON a.id = ar.agent_id
      WHERE c.name = ${options.name}
        AND c.created_at >= ${stamp(options.period.since)}
        AND c.created_at < ${stamp(options.until)}
        AND ${scope.sessions}
        AND ${after(cursor)}
      ORDER BY ${order(options.sort)}
      LIMIT ${options.limit + 1}`)
    .catch(rethrowCursorCastError);
  const rows = rowsOf<{
    use_event_id: string | number;
    ord: number;
    at: Date | string;
    at_text: string;
    ms: string | number | null;
    outcome: UsageToolCallRecord["outcome"];
    agent: string | null;
    session_id: string | null;
    title: string | null;
  }>(result);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > options.limit && last
      ? encodeToolCallCursor(
          options.sort === "recent"
            ? {
                sort: "recent",
                at: last.at_text,
                id: Number(last.use_event_id),
                ord: last.ord,
              }
            : {
                sort: "slowest",
                ms: last.ms === null ? null : Number(last.ms),
                id: Number(last.use_event_id),
                ord: last.ord,
              },
        )
      : null;
  return {
    calls: page.map((row) => ({
      sessionId: row.session_id,
      title: row.session_id === null ? null : row.title,
      agent: row.agent,
      occurredAt: new Date(row.at),
      durationMs: row.ms === null ? null : Number(row.ms),
      outcome: row.outcome,
    })),
    nextCursor,
  };
}

/**
 * Calls of one tool per UTC date of [since, until), every date the period
 * touches and zeros included, read as periodParts splits the period.
 */
export async function toolCallDays(
  db: Database,
  filter: UsageSummaryFilter,
  options: { name: string; since: Date; until?: Date; agentId?: string },
): Promise<{ date: string; calls: number }[]> {
  const scope = scopeOf(filter, options.agentId);
  const { days, ends, until: end } = periodParts(options.since, options.until);
  const since = options.since.getTime();
  const until = end.getTime();
  const result = await db.execute(sql`
    WITH dates AS (
      SELECT generate_series(${utcDate(since)}::date, ${utcDate(until - 1)}::date, interval '1 day')::date AS day
    ),
    counted AS (
      SELECT day, calls FROM tool_call_days
      WHERE scope_key = ${scope.scopeKey} AND agent_key = ${scope.agentKey}
        AND name = ${options.name} AND ${days}
      UNION ALL
      SELECT (c.created_at AT TIME ZONE 'UTC')::date, 1
      FROM tool_calls c JOIN sessions s ON s.id = c.session_id
      WHERE c.name = ${options.name} AND (${ends}) AND ${scope.sessions}
    )
    SELECT dates.day::text AS date, coalesce(sum(counted.calls), 0) AS calls
    FROM dates LEFT JOIN counted ON counted.day = dates.day
    GROUP BY dates.day
    ORDER BY dates.day`);
  return rowsOf<{ date: string; calls: string | number }>(result).map(
    (row) => ({ date: row.date, calls: Number(row.calls) }),
  );
}
