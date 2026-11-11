import type { UsageSummaryFilter } from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import { findPgError } from "../control-shared.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { eventWithNeutralFields } from "./event-payload.ts";
import { histMedianMs } from "./tool-calls-hist.ts";

/**
 * How far behind now the cursor stays. Event ids are taken at insert and
 * only a session's own writers are ordered (session-events.ts), so a lower
 * id from another session can commit after a higher one. A row the cursor
 * has passed is never read again, so the cursor only passes rows whose
 * transaction began (created_at) this long ago: a lower id still
 * uncommitted then would need a writing transaction longer than half of
 * this. Rows newer than that are applied anyway and read again next pass;
 * applying is idempotent.
 */
export const TOOL_CALL_CURSOR_MARGIN_SECONDS = 60;

export type ToolCallProjection = {
  /** Events read, re-reads of the margin included. */
  eventsRead: number;
  batches: number;
  appliedThrough: number;
  /** Nothing left to read beyond the margin when the pass stopped. */
  caughtUp: boolean;
  /** Batches cut by the statement timeout and retried smaller. */
  timedOut: number;
  /**
   * Seconds since the neutral field fill last moved, when the last batch's
   * cursor stopped at it with events ready beyond; null otherwise.
   */
  heldByFillSeconds: number | null;
};

// The scope rows of tool_call_days each call of a session adds to; see the
// table's comment in schema.ts.
const scopesOf = (sessionIds: SQL) => sql`
  SELECT s.id AS session_id, sk.scope_key, ak.agent_key
  FROM sessions s
  LEFT JOIN agent_releases ar ON ar.id = s.agent_release_id
  CROSS JOIN LATERAL unnest(ARRAY[
    '',
    'user:' || s.created_by_user_id || ':' || s.owner_id,
    'api_key:' || s.created_by_api_key_id || ':' || s.owner_id
  ]) AS sk(scope_key)
  CROSS JOIN LATERAL unnest(ARRAY['', ar.agent_id::text]) AS ak(agent_key)
  WHERE sk.scope_key IS NOT NULL AND ak.agent_key IS NOT NULL
    AND s.id IN (${sessionIds})`;

// An event as read below (FROM events e), with its neutral fields.
const neutral = eventWithNeutralFields(sql`e`);

// A tool_use event's call becomes a call once: a replayed event, or a
// second one with an id already seen in its session and attempt, does
// nothing. An event holds one call, at ord 1.
async function applyUses(tx: Database, from: number, to: number) {
  await tx.execute(sql`
    WITH blocks AS (
      SELECT e.id, 1 AS ord, e.session_id,
        coalesce(e.attempt_id, '') AS attempt_key,
        ${neutral}->'tool_call'->>'id' AS tool_use_id,
        ${neutral}->'tool_call'->>'name' AS name, e.occurred_at, e.created_at
      FROM events e
      WHERE e.id > ${from} AND e.id <= ${to} AND e.type = 'tool_use'
        AND jsonb_typeof(${neutral}->'tool_call'->'id') = 'string'
        AND jsonb_typeof(${neutral}->'tool_call'->'name') = 'string'
      ORDER BY e.id
    ),
    inserted AS (
      INSERT INTO tool_calls (use_event_id, ord, session_id, attempt_key, tool_use_id, name, used_at, at, created_at)
      SELECT id, ord, session_id, attempt_key, tool_use_id, name,
        occurred_at, coalesce(occurred_at, created_at), created_at
      FROM blocks
      ON CONFLICT DO NOTHING
      RETURNING session_id, name, created_at
    ),
    scopes AS (${scopesOf(sql`SELECT session_id FROM inserted`)})
    INSERT INTO tool_call_days AS d (scope_key, agent_key, day, name, calls, failed, timed, total_ms, max_ms, hist)
    SELECT scopes.scope_key, scopes.agent_key, (inserted.created_at AT TIME ZONE 'UTC')::date,
      inserted.name, count(*)::integer, 0, 0, 0, 0, array_fill(0, ARRAY[161])
    FROM inserted JOIN scopes ON scopes.session_id = inserted.session_id
    GROUP BY 1, 2, 3, 4
    ON CONFLICT (scope_key, agent_key, day, name)
      DO UPDATE SET calls = d.calls + excluded.calls`);
}

// A result settles the call it pairs with when that call has none yet or
// this one came earlier by (occurred_at, id); the day rows then trade the
// old result's share for the new one's. A null is_error (the engine said
// neither) leaves the outcome unknown.
async function applyResults(tx: Database, from: number, to: number) {
  await tx.execute(sql`
    WITH results AS (
      SELECT DISTINCT ON (e.session_id, coalesce(e.attempt_id, ''), ${neutral}->'tool_result'->>'tool_call_id')
        e.id, e.session_id, coalesce(e.attempt_id, '') AS attempt_key,
        ${neutral}->'tool_result'->>'tool_call_id' AS tool_use_id, e.occurred_at,
        CASE ${neutral}->'tool_result'->'is_error'
          WHEN 'true'::jsonb THEN 'failed'
          WHEN 'false'::jsonb THEN 'ok'
          ELSE 'unknown'
        END AS outcome
      FROM events e
      WHERE e.id > ${from} AND e.id <= ${to} AND e.type = 'tool_result'
        AND jsonb_typeof(e.payload) = 'object'
        AND jsonb_typeof(${neutral}->'tool_result'->'tool_call_id') = 'string'
      ORDER BY e.session_id, coalesce(e.attempt_id, ''), ${neutral}->'tool_result'->>'tool_call_id',
        coalesce(e.occurred_at, 'infinity'), e.id
    ),
    changed AS (
      SELECT c.use_event_id, c.ord, c.session_id, c.name,
        (c.created_at AT TIME ZONE 'UTC')::date AS day,
        c.outcome AS old_outcome, c.ms AS old_ms,
        r.id AS result_event_id, r.occurred_at AS result_at, r.outcome,
        CASE WHEN c.used_at IS NOT NULL AND r.occurred_at IS NOT NULL
          THEN greatest(round(extract(epoch FROM r.occurred_at - c.used_at) * 1000), 0)::bigint
        END AS ms
      FROM results r
      JOIN tool_calls c ON c.session_id = r.session_id
        AND c.attempt_key = r.attempt_key AND c.tool_use_id = r.tool_use_id
      WHERE c.result_event_id IS NULL
        OR (coalesce(r.occurred_at, 'infinity'), r.id)
          < (coalesce(c.result_at, 'infinity'), c.result_event_id)
      FOR UPDATE OF c
    ),
    updated AS (
      UPDATE tool_calls c
      SET result_event_id = changed.result_event_id, result_at = changed.result_at,
        outcome = changed.outcome, ms = changed.ms
      FROM changed
      WHERE c.use_event_id = changed.use_event_id AND c.ord = changed.ord
    ),
    scopes AS (${scopesOf(sql`SELECT session_id FROM changed`)})
    INSERT INTO tool_call_days AS d (scope_key, agent_key, day, name, calls, failed, timed, total_ms, max_ms, hist)
    SELECT scopes.scope_key, scopes.agent_key, changed.day, changed.name, 0,
      sum((changed.outcome = 'failed')::integer - (changed.old_outcome = 'failed')::integer)::integer,
      sum((changed.ms IS NOT NULL)::integer - (changed.old_ms IS NOT NULL)::integer)::integer,
      sum(coalesce(changed.ms, 0) - coalesce(changed.old_ms, 0)),
      coalesce(max(changed.ms), 0),
      tool_hist_add(
        tool_hist(tool_ms_bucket(changed.ms), 1),
        tool_hist(tool_ms_bucket(changed.old_ms), -1)
      )
    FROM changed JOIN scopes ON scopes.session_id = changed.session_id
    GROUP BY 1, 2, 3, 4
    ON CONFLICT (scope_key, agent_key, day, name) DO UPDATE SET
      failed = d.failed + excluded.failed,
      timed = d.timed + excluded.timed,
      total_ms = d.total_ms + excluded.total_ms,
      max_ms = greatest(d.max_ms, excluded.max_ms),
      hist = tool_hist_add(d.hist, excluded.hist)`);
}

// An init event's tools that carry a description. A replayed event, or an
// older init read after a newer one, changes nothing.
async function applyDescriptions(tx: Database, from: number, to: number) {
  await tx.execute(sql`
    INSERT INTO tool_descriptions AS d (session_id, name, description, event_id)
    SELECT DISTINCT ON (e.session_id, t.tool->>'name')
      e.session_id, t.tool->>'name', t.tool->>'description', e.id
    FROM events e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.payload->'tools') = 'array'
        THEN e.payload->'tools' ELSE '[]'::jsonb END
    ) AS t(tool)
    WHERE e.id > ${from} AND e.id <= ${to} AND e.type = 'system'
      AND ${neutral}->'engine_event'->>'category' = 'started'
      AND jsonb_typeof(t.tool->'name') = 'string'
      AND jsonb_typeof(t.tool->'description') = 'string'
      AND char_length(t.tool->>'description') BETWEEN 1 AND 200
    ORDER BY e.session_id, t.tool->>'name', e.id DESC
    ON CONFLICT (session_id, name) DO UPDATE
      SET description = excluded.description, event_id = excluded.event_id
      WHERE excluded.event_id > d.event_id`);
}

/**
 * Projects tool calls from events the reconciler has not read yet, a batch
 * of `batchSize` events per transaction, until it has read up to the newest
 * event or `budgetMs` has passed. A batch cut by the statement timeout is
 * retried at a tenth of the size, and that size is committed at once, so a
 * pass killed before any batch lands leaves the next one starting smaller. A
 * pass with no timeout grows it back tenfold, up to `batchSize`. Passes must
 * not overlap; the progress row lock makes a second one wait rather than
 * double-count.
 */
export async function projectToolCalls(
  db: Database,
  options: {
    batchSize: number;
    budgetMs: number;
    marginSeconds?: number;
    now?: () => number;
    onTimeout?: (batchSize: number, retrySize: number) => void;
  },
): Promise<ToolCallProjection> {
  const now = options.now ?? Date.now;
  const margin = options.marginSeconds ?? TOOL_CALL_CURSOR_MARGIN_SECONDS;
  const started = now();
  let read: number | null = null;
  let eventsRead = 0;
  let batches = 0;
  let appliedThrough = 0;
  let caughtUp = false;
  let heldByFillSeconds: number | null = null;
  const [stored] = rowsOf<{ batch_size: number | null }>(
    await db.execute(
      sql`SELECT batch_size FROM tool_call_progress WHERE id = 1`,
    ),
  );
  const startSize = Math.min(
    stored?.batch_size ?? options.batchSize,
    options.batchSize,
  );
  let batchSize = startSize;
  let timedOut = 0;
  // At least one batch lands per pass, or a pass spent on timeouts alone
  // would end without moving.
  while (!caughtUp && (batches === 0 || now() - started < options.budgetMs)) {
    let batch: Awaited<ReturnType<typeof projectBatch>>;
    try {
      batch = await projectBatch(db, read, batchSize, margin);
    } catch (error) {
      // A batch past the statement timeout rolled back whole. Under heavy
      // writes one batch can take ten times its usual time, so a fixed size
      // could stall the cursor for good; a smaller one still moves it.
      if (findPgError(error, "57014") === undefined || batchSize === 1) {
        throw error;
      }
      const retrySize = Math.ceil(batchSize / 10);
      options.onTimeout?.(batchSize, retrySize);
      await storeBatchSize(db, retrySize);
      batchSize = retrySize;
      timedOut += 1;
      continue;
    }
    read = batch.hi;
    eventsRead += batch.n;
    batches += 1;
    appliedThrough = batch.cursor;
    heldByFillSeconds = batch.heldByFillSeconds;
    // Held by the fill, the pass ends: the fill may pass rows this pass has
    // read unfilled, and the next batch would carry the cursor over them.
    caughtUp = batch.n < batchSize || heldByFillSeconds !== null;
  }
  if (timedOut === 0 && startSize < options.batchSize) {
    const grown = startSize * 10;
    await storeBatchSize(db, grown >= options.batchSize ? null : grown);
  }
  return {
    eventsRead,
    batches,
    appliedThrough,
    caughtUp,
    timedOut,
    heldByFillSeconds,
  };
}

function storeBatchSize(db: Database, size: number | null) {
  return db.execute(
    sql`UPDATE tool_call_progress SET batch_size = ${size} WHERE id = 1`,
  );
}

function projectBatch(
  db: Database,
  read: number | null,
  batchSize: number,
  margin: number,
) {
  return db.transaction(async (tx) => {
    const [progress] = rowsOf<{ applied_through: string }>(
      await tx.execute(
        sql`SELECT applied_through FROM tool_call_progress WHERE id = 1 FOR UPDATE`,
      ),
    );
    if (!progress) throw new Error("tool_call_progress has no row");
    const cursor = Number(progress.applied_through);
    // Calls are read from the neutral fields (neutral-fields.ts): history
    // stored before them is read only once the fill has given it those, and
    // the cursor never passes the fill, so a row an older replica stored
    // without them is read again once filled.
    const [fill] = rowsOf<{
      filled_through: string;
      history_through: string;
      idle_seconds: number;
    }>(
      await tx.execute(
        sql`SELECT filled_through, history_through,
          extract(epoch FROM now() - updated_at)::float8 AS idle_seconds
        FROM neutral_field_progress WHERE id = 1`,
      ),
    );
    const ceiling =
      fill && Number(fill.filled_through) < Number(fill.history_through)
        ? Number(fill.filled_through)
        : null;
    // Re-reading from the cursor each pass covers what the margin held
    // back; within a pass, batches move on from the last one read.
    const from = read === null ? cursor : Math.max(read, cursor);
    const [bounds] = rowsOf<{
      n: string;
      hi: string | null;
      safe: string | null;
    }>(
      await tx.execute(sql`
          SELECT count(*) AS n, max(id) AS hi,
            max(id) FILTER (WHERE created_at < now() - make_interval(secs => ${margin})) AS safe
          FROM (SELECT id, created_at FROM events WHERE id > ${from}${
            ceiling === null ? sql`` : sql` AND id <= ${ceiling}`
          } ORDER BY id LIMIT ${batchSize}) AS b`),
    );
    const n = Number(bounds?.n ?? 0);
    if (n === 0 || bounds?.hi == null) {
      return {
        n,
        from,
        hi: from,
        cursor,
        heldByFillSeconds:
          fill && ceiling !== null ? Number(fill.idle_seconds) : null,
      };
    }
    const hi = Number(bounds.hi);
    await applyUses(tx, from, hi);
    await applyResults(tx, from, hi);
    await applyDescriptions(tx, from, hi);
    const safe = Number(bounds.safe ?? cursor);
    const filled = fill
      ? Number(fill.filled_through)
      : Number.POSITIVE_INFINITY;
    const next = Math.max(cursor, Math.min(safe, filled));
    const heldByFillSeconds =
      fill && (ceiling !== null || safe > filled)
        ? Number(fill.idle_seconds)
        : null;
    if (next !== cursor) {
      await tx.execute(
        sql`UPDATE tool_call_progress SET applied_through = ${next}, updated_at = now() WHERE id = 1`,
      );
    }
    return { n, from, hi, cursor: next, heldByFillSeconds };
  });
}

/**
 * Each named tool's newest description among the sessions the filter may
 * read, whenever they declared it; a name none of them described is absent.
 */
export async function toolDescriptionsOf(
  db: Database,
  filter: UsageSummaryFilter,
  agentId: string | undefined,
  names: readonly string[],
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const scope = scopeOf(filter, agentId);
  // One index walk per name, newest first, stopping at the first session in
  // scope: a common MCP tool is described in every session that has it.
  const result = await db.execute(sql`
    SELECT n.name, latest.description
    FROM unnest(ARRAY[${sql.join(
      names.map((name) => sql`${name}`),
      sql`, `,
    )}]::text[]) AS n(name)
    CROSS JOIN LATERAL (
      SELECT d.description
      FROM tool_descriptions d JOIN sessions s ON s.id = d.session_id
      WHERE d.name = n.name AND ${scope.sessions}
      ORDER BY d.event_id DESC
      LIMIT 1
    ) AS latest`);
  return new Map(
    rowsOf<{ name: string; description: string }>(result).map((row) => [
      row.name,
      row.description,
    ]),
  );
}

export type ToolCallTotals = {
  name: string;
  calls: number;
  failed: number;
  totalMs: number;
  /** From the histogram: within 5% of the true median. */
  medianMs: number;
  maxMs: number;
};

export const DAY_MS = 86_400_000;

// Which tool_call_days rows a usage filter reads, and the same sessions as
// a condition on `sessions s` for the part of the period no whole day covers.
export function scopeOf(
  filter: UsageSummaryFilter,
  agentId: string | undefined,
) {
  // Rows are keyed by uuid::text, which Postgres writes in lowercase.
  const agentKey = agentId?.toLowerCase() ?? "";
  const agent =
    agentId === undefined
      ? sql`true`
      : sql`s.agent_release_id IN (SELECT id FROM agent_releases WHERE agent_id = ${agentId})`;
  switch (filter.kind) {
    case "installation":
      return { scopeKey: "", agentKey, sessions: agent };
    case "user":
      return {
        scopeKey: `user:${filter.userId}:${filter.ownerId}`,
        agentKey,
        sessions: sql`s.owner_id = ${filter.ownerId} AND s.created_by_user_id = ${filter.userId} AND ${agent}`,
      };
    case "api_key":
      return {
        scopeKey: `api_key:${filter.apiKeyId}:${filter.ownerId}`,
        agentKey,
        sessions: sql`s.owner_id = ${filter.ownerId} AND s.created_by_api_key_id = ${filter.apiKeyId} AND ${agent}`,
      };
  }
}

/**
 * [since, until) as the whole UTC days tool_call_days answers for and the
 * ends no whole day covers, which tool_calls answers for. A period still
 * open, its until omitted or not yet reached, takes the current day whole:
 * that day's row holds every call stored so far, and reading today's calls
 * one by one is what a busy installation cannot afford.
 */
export function periodParts(
  since: Date,
  until: Date | undefined,
  now = Date.now(),
): { days: SQL; ends: SQL; until: Date } {
  const from = since.getTime();
  const open = until === undefined || until.getTime() >= now;
  const to = open ? Math.max(now, from) : until.getTime();
  const firstDay = Math.ceil(from / DAY_MS) * DAY_MS;
  const endDay = (open ? Math.ceil : Math.floor)(to / DAY_MS) * DAY_MS;
  const stamp = (ms: number) => sql`${new Date(ms).toISOString()}::timestamptz`;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (firstDay >= endDay) {
    return {
      days: sql`false`,
      ends: sql`c.created_at >= ${stamp(from)} AND c.created_at < ${stamp(to)}`,
      until: new Date(to),
    };
  }
  const head = sql`(c.created_at >= ${stamp(from)} AND c.created_at < ${stamp(firstDay)})`;
  return {
    days: sql`day >= ${day(firstDay)}::date AND day < ${day(endDay)}::date`,
    ends: open
      ? head
      : sql`${head} OR (c.created_at >= ${stamp(endDay)} AND c.created_at < ${stamp(to)})`,
    until: new Date(to),
  };
}

/**
 * Calls per tool among those whose tool_use was stored in [since, until),
 * the most-called first, read as periodParts splits the period. As current
 * as the last projection pass.
 */
export async function toolCallTotals(
  db: Database,
  filter: UsageSummaryFilter,
  options: { since: Date; until?: Date; agentId?: string; limit: number },
): Promise<ToolCallTotals[]> {
  const scope = scopeOf(filter, options.agentId);
  const { days, ends } = periodParts(options.since, options.until);
  const result = await db.execute(sql`
    WITH whole AS (
      SELECT name, sum(calls) AS calls, sum(failed) AS failed,
        sum(total_ms) AS total_ms, max(max_ms) AS max_ms, tool_hist_sum(hist) AS hist
      FROM tool_call_days
      WHERE scope_key = ${scope.scopeKey} AND agent_key = ${scope.agentKey} AND ${days}
      GROUP BY name
    ),
    ends AS (
      SELECT c.name, count(*) AS calls, count(*) FILTER (WHERE c.outcome = 'failed') AS failed,
        coalesce(sum(c.ms), 0) AS total_ms, coalesce(max(c.ms), 0) AS max_ms,
        tool_hist(tool_ms_bucket(c.ms), 1) AS hist
      FROM tool_calls c JOIN sessions s ON s.id = c.session_id
      WHERE (${ends}) AND ${scope.sessions}
      GROUP BY c.name
    )
    SELECT name, sum(calls) AS calls, sum(failed) AS failed, sum(total_ms) AS total_ms,
      max(max_ms) AS max_ms, tool_hist_sum(hist) AS hist
    FROM (SELECT * FROM whole UNION ALL SELECT * FROM ends) AS both_parts
    GROUP BY name
    ORDER BY sum(calls) DESC, name
    LIMIT ${options.limit}`);
  return rowsOf<{
    name: string;
    calls: string | number;
    failed: string | number;
    total_ms: string | number;
    max_ms: string | number;
    hist: number[];
  }>(result).map((row) => ({
    name: row.name,
    calls: Number(row.calls),
    failed: Number(row.failed),
    totalMs: Number(row.total_ms),
    medianMs: histMedianMs(row.hist, Number(row.max_ms)),
    maxMs: Number(row.max_ms),
  }));
}
