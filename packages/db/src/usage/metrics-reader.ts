import type { SessionBudget } from "@werft-ai/platform";
import { type AnyColumn, and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { rowsOf } from "../control-unit-of-work.ts";
import { actionableOfSession } from "../decision/pending-requests.ts";
import type { Database } from "../queries.ts";
import { awaitingLaunch } from "../scheduler/scheduler-store.ts";
import {
  providerUsageTotals,
  queueMessages,
  sessions,
  turns,
  unassignedSessions,
} from "../schema.ts";

// Endings a turn keeps. outcome_unknown is left out: an operator's recovery
// decision rewrites it to completed or cancelled (recovery-control.ts), and
// a counter must never lose what it counted.
const SETTLED_TURN_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type SettledTurnStatus = (typeof SETTLED_TURN_STATUSES)[number];

export type ToolCallOutcome = "ok" | "failed" | "denied" | "unknown";

export type PlatformMetricsSnapshot = {
  /** Stored status and admission, with what an actionable request makes of them. */
  sessions: {
    status: string;
    admission: string;
    awaitingApproval: boolean;
    awaitingAnswer: boolean;
    count: number;
  }[];
  settledTurns: {
    status: SettledTurnStatus;
    count: number;
    /** Turns with both timestamps; `le[i]` counts those within `buckets[i]`. */
    timed: number;
    seconds: number;
    le: number[];
  }[];
  outcomeUnknownTurns: number;
  /** `firstAt` is the earliest call of the name, whatever its outcome. */
  toolCalls: {
    name: string;
    outcome: ToolCallOutcome;
    count: number;
    firstAt: Date;
  }[];
  providerUsage: {
    model: string;
    pricedBy: "table" | "fallback" | "unmetered";
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    /** numeric(…, 6) summed in the database, as text so no cent is lost. */
    costUsd: string;
    firstAt: Date;
  }[];
  launchQueue: { sessions: number; oldestWaitSeconds: number };
  inputQueueOldestAgeSeconds: number;
};

export type PlatformMetricsOptions = {
  /** The scheduler's, so the launch queue is the one it drains. */
  budget: SessionBudget;
  /** Ascending upper bounds of the turn-duration histogram, in seconds. */
  buckets: readonly number[];
};

/**
 * Installation-wide figures for the platform metrics, read from the tables
 * the API reads. Totals come from rows that are never deleted, so a reader
 * restart or a second reader reports the same numbers.
 */
export async function readPlatformMetrics(
  db: Database,
  options: PlatformMetricsOptions,
): Promise<PlatformMetricsSnapshot> {
  const [
    sessionRows,
    settledTurns,
    outcomeUnknownTurns,
    toolCallRows,
    providerUsageRows,
    launchQueue,
    inputQueueOldestAgeSeconds,
  ] = await Promise.all([
    readSessions(db),
    readSettledTurns(db, options.buckets),
    readOutcomeUnknownTurns(db),
    readToolCalls(db),
    readProviderUsage(db),
    readLaunchQueue(db, options.budget),
    readInputQueueOldestAge(db),
  ]);
  return {
    sessions: sessionRows,
    settledTurns,
    outcomeUnknownTurns,
    toolCalls: toolCallRows,
    providerUsage: providerUsageRows,
    launchQueue,
    inputQueueOldestAgeSeconds,
  };
}

async function readSessions(db: Database) {
  const awaitingApproval = sql<boolean>`EXISTS (${actionableOfSession(db, "permission")})`;
  const awaitingAnswer = sql<boolean>`EXISTS (${actionableOfSession(db, "question")})`;
  return db
    .select({
      status: sessions.status,
      admission: sessions.admissionState,
      awaitingApproval: awaitingApproval.as("awaiting_approval"),
      awaitingAnswer: awaitingAnswer.as("awaiting_answer"),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(sessions)
    .groupBy(sql`1, 2, 3, 4`);
}

async function readSettledTurns(db: Database, buckets: readonly number[]) {
  const seconds = sql`greatest(extract(epoch FROM ${turns.endedAt} - ${turns.startedAt}), 0)`;
  const timed = sql`${turns.startedAt} IS NOT NULL AND ${turns.endedAt} IS NOT NULL`;
  const le = buckets.map(
    (bound) =>
      sql`count(*) FILTER (WHERE ${timed} AND ${seconds} <= ${bound})::int`,
  );
  const rows = rowsOf<{
    status: SettledTurnStatus;
    count: number;
    timed: number;
    seconds: number;
    le: (number | null)[];
  }>(
    await db.execute(sql`
    SELECT ${turns.status} AS status,
      count(*)::int AS count,
      count(*) FILTER (WHERE ${timed})::int AS timed,
      coalesce(sum(${seconds}) FILTER (WHERE ${timed}), 0)::float8 AS seconds,
      ARRAY[${le.length === 0 ? sql`NULL::int` : sql.join(le, sql`, `)}] AS le
    FROM ${turns}
    WHERE ${turns.status} IN (${sql.join(
      SETTLED_TURN_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})
    GROUP BY 1
  `),
  );
  return rows.map((row) => ({
    status: row.status,
    count: Number(row.count),
    timed: Number(row.timed),
    seconds: Number(row.seconds),
    le: buckets.map((_, i) => Number(row.le[i] ?? 0)),
  }));
}

async function readOutcomeUnknownTurns(db: Database) {
  const [row] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(turns)
    .where(eq(turns.status, "outcome_unknown"));
  return row?.count ?? 0;
}

// A call whose permission request a person denied counts as denied. tool_use
// ids come from the provider and are unique, so the pair names one call even
// when the answer reached a later attempt than the one that asked (a parked
// request). tool_call_outcomes counts every call under its stored outcome; the
// few denied ones are moved here. `first_at` is the name's first call,
// across its outcomes.
async function readToolCalls(db: Database) {
  const rows = rowsOf<{
    name: string;
    outcome: ToolCallOutcome;
    count: number | string;
    first_at: Date | string;
  }>(
    await db.execute(sql`
    WITH denied AS (
      SELECT DISTINCT session_id, tool_use_id FROM pending_requests
      WHERE kind = 'permission' AND (answer ->> 'decision') = 'deny'
        AND tool_use_id IS NOT NULL
    ),
    moved AS (
      SELECT c.name, c.outcome, count(*) AS calls
      FROM denied d
      JOIN tool_calls c ON c.session_id = d.session_id AND c.tool_use_id = d.tool_use_id
      GROUP BY c.name, c.outcome
    ),
    counted AS (
      SELECT t.name, t.outcome, t.calls - coalesce(m.calls, 0) AS calls
      FROM tool_call_outcomes t
      LEFT JOIN moved m ON m.name = t.name AND m.outcome = t.outcome
      UNION ALL
      SELECT name, 'denied', sum(calls) FROM moved GROUP BY name
    )
    SELECT counted.name, counted.outcome, counted.calls::bigint AS count, f.first_at
    FROM counted
    JOIN (SELECT name, min(first_at) AS first_at FROM tool_call_outcomes GROUP BY name) f
      ON f.name = counted.name
    WHERE counted.calls > 0`),
  );
  return rows.map((row) => ({
    name: row.name,
    outcome: row.outcome,
    count: Number(row.count),
    firstAt: new Date(row.first_at),
  }));
}

async function readProviderUsage(db: Database) {
  const total = (column: AnyColumn) => sql<number>`${column}`.mapWith(Number);
  const rows = await db
    .select({
      model: providerUsageTotals.model,
      pricedBy: sql<
        "table" | "fallback" | "unmetered"
      >`${providerUsageTotals.pricedBy}`,
      inputTokens: total(providerUsageTotals.inputTokens),
      outputTokens: total(providerUsageTotals.outputTokens),
      cacheReadInputTokens: total(providerUsageTotals.cacheReadInputTokens),
      cacheCreationInputTokens: total(
        providerUsageTotals.cacheCreationInputTokens,
      ),
      costUsd: sql<string>`${providerUsageTotals.costUsd}::text`,
      firstAt: providerUsageTotals.firstAt,
    })
    .from(providerUsageTotals)
    .where(gt(providerUsageTotals.calls, 0));
  const firstOf = new Map<string, number>();
  for (const row of rows) {
    const at = row.firstAt.getTime();
    firstOf.set(row.model, Math.min(firstOf.get(row.model) ?? at, at));
  }
  return rows.map((row) => ({
    ...row,
    firstAt: new Date(firstOf.get(row.model) ?? row.firstAt.getTime()),
  }));
}

async function readLaunchQueue(db: Database, budget: SessionBudget) {
  const [row] = await db
    .select({
      sessions: sql<number>`count(*)`.mapWith(Number),
      oldestWaitSeconds:
        sql<number>`coalesce(extract(epoch FROM clock_timestamp() - min(${unassignedSessions.signaledAt})), 0)::float8`.mapWith(
          Number,
        ),
    })
    .from(unassignedSessions)
    .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
    .where(awaitingLaunch(db, budget));
  return {
    sessions: row?.sessions ?? 0,
    oldestWaitSeconds: Math.max(row?.oldestWaitSeconds ?? 0, 0),
  };
}

// infra/datadog/conf.d/postgres.d/conf.yaml's queue.oldest_age_seconds, so a
// Kubernetes install reads the same figure from the metrics endpoint.
async function readInputQueueOldestAge(db: Database) {
  const [row] = await db
    .select({
      seconds:
        sql<number>`coalesce(extract(epoch FROM clock_timestamp() - min(${queueMessages.createdAt})), 0)::float8`.mapWith(
          Number,
        ),
    })
    .from(queueMessages)
    .where(
      and(
        isNull(queueMessages.claimedBy),
        lte(queueMessages.visibleAt, sql`clock_timestamp()`),
      ),
    );
  return Math.max(row?.seconds ?? 0, 0);
}
