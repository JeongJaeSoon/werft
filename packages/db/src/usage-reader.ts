import type { TurnStatus } from "@werft-ai/contracts";
import type {
  UsageAchievementCountsRecord,
  UsageAchievementsFilter,
  UsageAchievementsRecord,
  UsageReader,
  UsageTotalsFilter,
} from "@werft-ai/platform";
import {
  type AnyColumn,
  and,
  eq,
  inArray,
  isNull,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import { INSTALLATION_STORAGE_SCOPE } from "./input-limits.ts";
import { sessionVisibleTo } from "./musterrolle/session-shares.ts";
import type { Database } from "./queries.ts";
import {
  achievementCategories,
  achievementJudgments,
  achievementRules,
  achievementTypes,
  agentReleases,
  agents,
  checkpointOutputObjects,
  checkpointOutputTotals,
  checkpoints,
  sessionAchievements,
  sessionEventArchives,
  sessionModelUsage,
  sessionOutcomes,
  sessionPreMeteringCost,
  sessions,
  storageUsage,
  turns,
  users,
  workerLaunches,
} from "./schema.ts";
import { toolCallDays, toolCallPage } from "./sessions/tool-call-pages.ts";
import { toolCallTotals, toolDescriptionsOf } from "./sessions/tool-calls.ts";

// An open period ends at the read, and never before it starts.
const untilOf = (period: { since: Date; until?: Date }) =>
  period.until ?? new Date(Math.max(Date.now(), period.since.getTime()));

const ENDED: TurnStatus[] = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
];
const OPEN: TurnStatus[] = ["running", "needs_input"];

// Whether a turn reported a cost is read from the one field finalize writes
// only when the worker had a figure, whatever status the turn ended in, so a
// reclassified ending (interrupted, context lost) keeps its
// meaning. `->>` is NULL for a missing key, a JSON null and a NULL row alike;
// a reported zero stays reported.
const costReported = sql`(${turns.resultJson} ->> 'cost_usd') IS NOT NULL`;
// The one ending known never to have run: queued input cancelled on
// terminate or close. A legacy row without timestamps that ended any other
// way still counts as unreported.
const neverRan = sql`(${turns.status} = 'cancelled' AND ${turns.startedAt} IS NULL AND ${turns.attemptId} IS NULL AND NOT ${turns.outcomeUnknown})`;

// The turns that keep a session usage's `cost.complete` false.
const incomplete = or(
  and(inArray(turns.status, ENDED), not(costReported), not(neverRan)),
  inArray(turns.status, OPEN),
);
// Wall clock from start to end; an open turn runs until the read.
const runSeconds = sql`greatest(extract(epoch FROM (CASE WHEN ${inArray(turns.status, OPEN)} THEN now() ELSE ${turns.endedAt} END) - ${turns.startedAt}), 0)`;
const ran = and(
  sql`${turns.startedAt} IS NOT NULL`,
  or(
    inArray(turns.status, OPEN),
    and(inArray(turns.status, ENDED), sql`${turns.endedAt} IS NOT NULL`),
  ),
);

function startedBy(filter: UsageTotalsFilter): SQL | undefined {
  switch (filter.kind) {
    case "installation":
      return undefined;
    case "user":
      return and(
        eq(sessions.ownerId, filter.ownerId),
        eq(sessions.createdByUserId, filter.userId),
      );
    case "api_key":
      return and(
        eq(sessions.ownerId, filter.ownerId),
        eq(sessions.createdByApiKeyId, filter.apiKeyId),
      );
    case "agent":
      return and(
        eq(sessions.ownerId, filter.ownerId),
        sql`EXISTS (SELECT 1 FROM ${agentReleases} WHERE ${agentReleases.id} = ${sessions.agentReleaseId} AND ${agentReleases.agentId} = ${filter.agentId})`,
      );
  }
}

function periodBounds(period: { since: Date; until?: Date }) {
  const since = sql`${period.since.toISOString()}::timestamptz`;
  // The API's clock passed since; the database's may be a moment behind,
  // and a period must not end before it starts.
  const until = period.until
    ? sql`${period.until.toISOString()}::timestamptz`
    : sql`greatest(now(), ${since})`;
  return { since, until };
}

// On a 90-day installation read JIT spent longer compiling than the
// aggregate took to run (packages/db/bench/usage-reads.ts), so it is off for
// that one transaction.
async function executeWithoutJit<Row>(db: Database, query: SQL) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL jit = off`);
    const { rows } = (await tx.execute(query)) as unknown as { rows: Row[] };
    return rows;
  });
}

const pairTokenSums = sql`sum(${sessionModelUsage.inputTokens}) AS input_tokens,
  sum(${sessionModelUsage.outputTokens}) AS output_tokens,
  sum(${sessionModelUsage.cacheReadInputTokens}) AS cache_read_input_tokens,
  sum(${sessionModelUsage.cacheCreationInputTokens}) AS cache_creation_input_tokens`;

type BreakdownRow = {
  key: string | null;
  label: string | null;
  total: boolean;
  session_count: number;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_input_tokens: number | string;
  cache_creation_input_tokens: number | string;
  cost_usd: string;
};

// Each session under its agent; the total row is the GROUPING SETS () one.
// Counts and cost come from the sessions, tokens from the rollup's copy of
// each session's agent.
function breakdownByAgent(inPeriod: SQL, pairs: SQL) {
  return sql`
    WITH counted AS (
      SELECT ${agentReleases.agentId} AS agent_id,
             grouping(${agentReleases.agentId}) = 1 AS total,
             count(*) AS session_count, sum(${sessions.costUsd}) AS cost_usd
      FROM ${sessions}
      LEFT JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId}
      WHERE ${inPeriod}
      GROUP BY GROUPING SETS ((${agentReleases.agentId}), ())
    ),
    tokens AS (
      SELECT ${sessionModelUsage.agentId} AS agent_id,
             grouping(${sessionModelUsage.agentId}) = 1 AS total, ${pairTokenSums}
      FROM ${sessionModelUsage}
      WHERE ${pairs}
      GROUP BY GROUPING SETS ((${sessionModelUsage.agentId}), ())
    )
    SELECT counted.agent_id::text AS key, ${agents.name} AS label, counted.total,
           counted.session_count::int AS session_count,
           coalesce(tokens.input_tokens, 0) AS input_tokens,
           coalesce(tokens.output_tokens, 0) AS output_tokens,
           coalesce(tokens.cache_read_input_tokens, 0) AS cache_read_input_tokens,
           coalesce(tokens.cache_creation_input_tokens, 0) AS cache_creation_input_tokens,
           coalesce(counted.cost_usd, 0)::text AS cost_usd
    FROM counted
    LEFT JOIN tokens ON tokens.total = counted.total
      AND tokens.agent_id IS NOT DISTINCT FROM counted.agent_id
    LEFT JOIN ${agents} ON ${agents.id} = counted.agent_id
    ORDER BY counted.cost_usd DESC, key NULLS LAST`;
}

// Every model a session called, from the per-session rollup the period's
// `pairs` select; the cost from before proxy metering is the null row. The
// totals' count and cost are the sessions'.
function breakdownByModel(inPeriod: SQL, pairs: SQL, preMetered: SQL) {
  return sql`
    WITH picked AS (
      SELECT count(*) AS session_count, sum(${sessions.costUsd}) AS cost_usd
      FROM ${sessions}
      WHERE ${inPeriod}
    ),
    models AS (
      SELECT ${sessionModelUsage.model} AS model, count(*) AS session_count,
             ${pairTokenSums}, sum(${sessionModelUsage.costUsd}) AS cost_usd
      FROM ${sessionModelUsage}
      WHERE ${pairs}
      GROUP BY ${sessionModelUsage.model}
    ),
    pre AS (
      SELECT count(*) AS session_count, sum(${sessionPreMeteringCost.costUsd}) AS cost_usd
      FROM ${sessionPreMeteringCost}
      WHERE ${preMetered}
    ),
    grouped AS (
      SELECT model AS key, false AS total, session_count, input_tokens, output_tokens,
             cache_read_input_tokens, cache_creation_input_tokens, cost_usd
      FROM models
      UNION ALL
      SELECT NULL, false, session_count, 0, 0, 0, 0, cost_usd
      FROM pre
      WHERE session_count > 0
      UNION ALL
      SELECT NULL, true, picked.session_count,
             coalesce(sum(models.input_tokens), 0), coalesce(sum(models.output_tokens), 0),
             coalesce(sum(models.cache_read_input_tokens), 0),
             coalesce(sum(models.cache_creation_input_tokens), 0),
             coalesce(picked.cost_usd, 0)
      FROM picked
      LEFT JOIN models ON TRUE
      GROUP BY picked.session_count, picked.cost_usd
    )
    SELECT key, key AS label, total, session_count::int AS session_count,
           input_tokens, output_tokens, cache_read_input_tokens,
           cache_creation_input_tokens, cost_usd::text AS cost_usd
    FROM grouped
    ORDER BY grouped.cost_usd DESC, key NULLS LAST`;
}

// The summary's figures per agent or holding user, with
// the totals summed over the groups by window in the same statement. Run
// time is floored on the running total as the series does, so the groups
// add up to the totals' one floor. The one-row `one` keeps the totals when
// no session falls in the period.
function summaryGroups(inPeriod: SQL, until: SQL, by: "agent" | "user") {
  const grouping = {
    agent: {
      key: sql`${agentReleases.agentId}`,
      from: sql`${sessions} LEFT JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId}`,
      name: sql`${agents.name}`,
      named: sql`LEFT JOIN ${agents} ON ${agents.id}::text = grouped.key`,
    },
    user: {
      key: sql`${sessions.createdByUserId}`,
      from: sql`${sessions}`,
      name: sql`${users.displayName}`,
      named: sql`LEFT JOIN ${users} ON ${users.id}::text = grouped.key`,
    },
  }[by];
  return sql`
    WITH picked AS (
      SELECT ${sessions.id} AS id, ${sessions.costUsd} AS cost_usd,
             ${sessions.providerTokens} AS provider_tokens, ${grouping.key}::text AS key
      FROM ${grouping.from}
      WHERE ${inPeriod}
    ),
    per_key AS (
      SELECT key, count(*) AS session_count, sum(cost_usd) AS cost_usd,
             sum(provider_tokens) AS provider_tokens
      FROM picked
      GROUP BY key
    ),
    turn_key AS (
      SELECT picked.key,
             count(*) FILTER (WHERE ${incomplete}) AS incomplete,
             sum(${runSeconds}) FILTER (WHERE ${ran}) AS seconds
      FROM picked
      JOIN ${turns} ON ${turns.sessionId} = picked.id
      GROUP BY picked.key
    ),
    grouped AS (
      SELECT per_key.key, per_key.session_count, per_key.cost_usd, per_key.provider_tokens,
             coalesce(turn_key.incomplete, 0) AS incomplete,
             coalesce(turn_key.seconds, 0) AS seconds
      FROM per_key
      LEFT JOIN turn_key ON turn_key.key IS NOT DISTINCT FROM per_key.key
    )
    SELECT now() AS read_at, ${until} AS until,
           grouped.key, ${grouping.name} AS name,
           grouped.session_count::int AS session_count,
           grouped.cost_usd::text AS cost_usd,
           grouped.incomplete::int AS incomplete,
           (floor(sum(grouped.seconds) OVER running)
             - floor(sum(grouped.seconds) OVER running - grouped.seconds))::bigint AS run_seconds,
           coalesce(sum(grouped.session_count) OVER (), 0)::int AS total_session_count,
           coalesce(sum(grouped.cost_usd) OVER (), 0)::text AS total_cost_usd,
           coalesce(sum(grouped.provider_tokens) OVER (), 0)::bigint AS total_provider_tokens,
           coalesce(sum(grouped.incomplete) OVER (), 0)::int AS total_incomplete,
           coalesce(floor(sum(grouped.seconds) OVER ()), 0)::bigint AS total_run_seconds
    FROM (SELECT 1) AS one
    LEFT JOIN grouped ON TRUE
    ${grouping.named}
    WINDOW running AS (ORDER BY grouped.key NULLS LAST ROWS UNBOUNDED PRECEDING)
    ORDER BY grouped.cost_usd DESC, grouped.key NULLS LAST`;
}

type SummaryGroupRow = {
  read_at: Date | string;
  until: Date | string;
  key: string | null;
  name: string | null;
  // null on the lone `one` row of an empty period.
  session_count: number | null;
  cost_usd: string | null;
  incomplete: number | null;
  run_seconds: number | string | null;
  total_session_count: number;
  total_cost_usd: string;
  total_provider_tokens: number | string;
  total_incomplete: number;
  total_run_seconds: number | string;
};

type OutcomeRow = {
  read_at: Date | string;
  until: Date | string;
  key: string | null;
  name: string | null;
  total: boolean;
  session_count: number;
  cost_usd: string;
  token_count: number | string;
  incomplete: number;
  sessions_with_pr: number;
  sessions_with_merged_pr: number;
  pr_count: number;
  merged_pr_count: number;
  closed_pr_count: number;
  cost_of_merged_sessions_usd: string;
  cost_per_merged_pr_usd: string | null;
};

type AchievementTotalsRow = {
  read_at: Date | string;
  until: Date | string;
  key: string | null;
  name: string | null;
  total: boolean;
  session_count: number;
  cost_usd: string;
  incomplete: number;
  sessions_with: number;
  counted: number;
  waiting: number;
  rejected: number;
  judgments: number;
  calls: number;
  judge_cost_usd: string;
  cost_per_achievement_usd: string | null;
};

type AchievementRuleRow = {
  id: string;
  family_id: string;
  version: number;
  title: string;
  category_id: string;
  category_name: string;
  type_id: string;
  type_key: string;
  type_name: string;
  counted: number;
  waiting: number;
};

type RecentAchievementRow = {
  id: string;
  created_at: Date | string;
  session_id: string | null;
  session_title: string | null;
  rule_id: string;
  rule_title: string;
  title: string;
  link: string;
  evidence_kind: UsageAchievementsRecord["recent"][number]["evidenceKind"];
  judge: UsageAchievementsRecord["recent"][number]["judge"];
  review_state: UsageAchievementsRecord["recent"][number]["reviewState"];
};

const COUNTED = sql`a.review_state IN ('auto', 'confirmed')`;

/**
 * The three statements read one snapshot, so the totals, the groups and the
 * recent rows agree. Sessions are counted before the achievements join them,
 * so a session's cost adds once however many it has.
 */
async function usageAchievements(
  db: Database,
  filter: UsageTotalsFilter,
  options: UsageAchievementsFilter,
): Promise<UsageAchievementsRecord> {
  const { since, until } = periodBounds(options.period);
  const picked = sql`
    s AS (
      SELECT ${sessions.id} AS id, ${agentReleases.agentId} AS agent_id,
             ${sessions.costUsd} AS cost_usd
      FROM ${sessions}
      LEFT JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId}
      WHERE ${sessions.createdAt} >= ${since} AND ${sessions.createdAt} < ${until}
        AND ${startedBy(filter) ?? sql`TRUE`}
        AND ${options.agentId === undefined ? sql`TRUE` : sql`${agentReleases.agentId} = ${options.agentId}::uuid`}
    ),
    a AS (
      SELECT sa.*, r.category_id
      FROM ${sessionAchievements} sa
      JOIN ${achievementRules} r ON r.id = sa.rule_id
      WHERE sa.session_id IN (SELECT id FROM s) AND sa.superseded_at IS NULL
        AND ${options.typeId === undefined ? sql`TRUE` : sql`sa.type_id = ${options.typeId}::uuid`}
        AND ${options.categoryId === undefined ? sql`TRUE` : sql`r.category_id = ${options.categoryId}::uuid`}
    )`;
  return db.transaction(
    async (tx) => {
      const run = async <Row>(query: SQL) =>
        rowsOf<Row>(await tx.execute(query));
      const totals = await run<AchievementTotalsRow>(sql`
        WITH ${picked},
        per AS (
          SELECT a.session_id,
                 count(*) FILTER (WHERE ${COUNTED}) AS counted,
                 count(*) FILTER (WHERE a.review_state = 'needs_review') AS waiting,
                 count(*) FILTER (WHERE a.review_state = 'rejected') AS rejected
          FROM a
          GROUP BY a.session_id
        ),
        t AS (
          SELECT ${turns.sessionId} AS session_id, count(*) AS incomplete
          FROM ${turns}
          WHERE ${turns.sessionId} IN (SELECT id FROM s) AND ${incomplete}
          GROUP BY ${turns.sessionId}
        ),
        j AS (
          SELECT ${achievementJudgments.sessionId} AS session_id,
                 count(*) FILTER (WHERE ${achievementJudgments.calls} > 0) AS judgments,
                 sum(${achievementJudgments.calls}) AS calls,
                 sum(${achievementJudgments.costUsd}) AS cost_usd
          FROM ${achievementJudgments}
          WHERE ${achievementJudgments.sessionId} IN (SELECT id FROM s)
          GROUP BY ${achievementJudgments.sessionId}
        ),
        g AS (
          SELECT s.agent_id, grouping(s.agent_id) = 1 AS total,
                 count(s.id)::int AS session_count,
                 coalesce(sum(s.cost_usd), 0) AS cost_usd,
                 coalesce(sum(t.incomplete), 0)::int AS incomplete,
                 (count(*) FILTER (WHERE per.counted > 0))::int AS sessions_with,
                 coalesce(sum(per.counted), 0)::int AS counted,
                 coalesce(sum(per.waiting), 0)::int AS waiting,
                 coalesce(sum(per.rejected), 0)::int AS rejected,
                 coalesce(sum(j.judgments), 0)::int AS judgments,
                 coalesce(sum(j.calls), 0)::int AS calls,
                 coalesce(sum(j.cost_usd), 0) AS judge_cost_usd
          FROM s
          LEFT JOIN per ON per.session_id = s.id
          LEFT JOIN t ON t.session_id = s.id
          LEFT JOIN j ON j.session_id = s.id
          GROUP BY GROUPING SETS ((s.agent_id), ())
        )
        SELECT now() AS read_at, ${until} AS until, g.agent_id::text AS key,
               ${agents.name} AS name, g.total, g.session_count,
               g.cost_usd::text AS cost_usd, g.incomplete, g.sessions_with,
               g.counted, g.waiting, g.rejected, g.judgments, g.calls,
               g.judge_cost_usd::text AS judge_cost_usd,
               CASE WHEN g.counted > 0
                 THEN round(g.cost_usd / g.counted, 6)::text END AS cost_per_achievement_usd
        FROM g
        LEFT JOIN ${agents} ON ${agents.id} = g.agent_id
        ORDER BY g.total DESC, g.counted DESC, g.cost_usd DESC, key NULLS LAST`);
      const rules = await run<AchievementRuleRow>(sql`
        WITH ${picked}
        SELECT r.id, r.family_id, r.version, r.title, r.category_id,
               c.name AS category_name, r.type_id, ty.key AS type_key,
               ty.name AS type_name,
               (count(*) FILTER (WHERE ${COUNTED}))::int AS counted,
               (count(*) FILTER (WHERE a.review_state = 'needs_review'))::int AS waiting
        FROM a
        JOIN ${achievementRules} r ON r.id = a.rule_id
        JOIN ${achievementCategories} c ON c.id = r.category_id
        JOIN ${achievementTypes} ty ON ty.id = r.type_id
        GROUP BY r.id, c.id, ty.id
        HAVING count(*) FILTER (WHERE a.review_state <> 'rejected') > 0
        ORDER BY c.position, c.name, c.id, counted DESC, r.title, r.version DESC`);
      // A family is one row under its latest version, whose category, title
      // and type it shows, with what every version counted.
      const families = await run<AchievementRuleRow>(sql`
        WITH ${picked},
        f AS (
          SELECT r.family_id,
                 (count(*) FILTER (WHERE ${COUNTED}))::int AS counted,
                 (count(*) FILTER (WHERE a.review_state = 'needs_review'))::int AS waiting
          FROM a
          JOIN ${achievementRules} r ON r.id = a.rule_id
          GROUP BY r.family_id
          HAVING count(*) FILTER (WHERE a.review_state <> 'rejected') > 0
        )
        SELECT l.id, f.family_id, l.version, l.title, l.category_id,
               c.name AS category_name, l.type_id, ty.key AS type_key,
               ty.name AS type_name, f.counted, f.waiting
        FROM f
        CROSS JOIN LATERAL (
          SELECT * FROM ${achievementRules} r
          WHERE r.family_id = f.family_id
          ORDER BY r.version DESC LIMIT 1
        ) l
        JOIN ${achievementCategories} c ON c.id = l.category_id
        JOIN ${achievementTypes} ty ON ty.id = l.type_id
        ORDER BY c.position, c.name, c.id, f.counted DESC, l.title`);
      const recent = await run<RecentAchievementRow>(sql`
        WITH ${picked}
        SELECT a.id, a.created_at, a.session_id,
               ss.title AS session_title, a.rule_id, r.title AS rule_title,
               a.title, a.link, a.evidence_kind, a.judge, a.review_state
        FROM a
        JOIN ${achievementRules} r ON r.id = a.rule_id
        JOIN ${sessions} ss ON ss.id = a.session_id
        -- A session the viewer cannot see leaves its whole row out, title
        -- and link with it, before the limit; the totals still count it.
        WHERE EXISTS (
          SELECT 1 FROM ${sessions}
          WHERE ${sessions.id} = a.session_id AND ${sessions.ownerId} = ${options.ownerId}
            AND ${sessionVisibleTo(db, options.viewer)}
        )
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${options.recentLimit}`);
      const total = totals.find((row) => row.total);
      if (!total) throw new Error("usage achievements read returned no total");
      return {
        readAt: new Date(total.read_at),
        until: new Date(total.until),
        sessionCount: total.session_count,
        sessionsWithAchievementCount: total.sessions_with,
        costUsd: total.cost_usd,
        incompleteTurnCount: total.incomplete,
        achievementCount: total.counted,
        needsReviewCount: total.waiting,
        rejectedCount: total.rejected,
        judgmentCount: total.judgments,
        judgeCalls: total.calls,
        judgeCostUsd: total.judge_cost_usd,
        costPerAchievementUsd: total.cost_per_achievement_usd,
        byCategory: groupRules(rules, (row) => row.category_id).map(
          ([row, counts]) => ({
            id: row.category_id,
            name: row.category_name,
            ...counts,
          }),
        ),
        byType: groupRules(rules, (row) => row.type_id)
          .map(([row, counts]) => ({
            id: row.type_id,
            key: row.type_key,
            name: row.type_name,
            ...counts,
          }))
          .sort(
            (a, b) =>
              b.achievementCount - a.achievementCount ||
              a.key.localeCompare(b.key),
          ),
        byRule: families.map((row) => ({
          id: row.id,
          familyId: row.family_id,
          version: row.version,
          title: row.title,
          categoryId: row.category_id,
          categoryName: row.category_name,
          typeId: row.type_id,
          typeKey: row.type_key,
          achievementCount: row.counted,
          needsReviewCount: row.waiting,
        })),
        byAgent: totals
          .filter((row) => !row.total)
          .map((row) => ({
            id: row.key,
            name: row.name,
            sessionCount: row.session_count,
            costUsd: row.cost_usd,
            achievementCount: row.counted,
            costPerAchievementUsd: row.cost_per_achievement_usd,
          })),
        recent: recent.map((row) => ({
          id: row.id,
          createdAt: new Date(row.created_at),
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          ruleId: row.rule_id,
          ruleTitle: row.rule_title,
          title: row.title,
          link: row.link,
          evidenceKind: row.evidence_kind,
          judge: row.judge,
          reviewState: row.review_state,
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

// Rule rows summed under their category or type, in the rules' order.
function groupRules(
  rules: readonly AchievementRuleRow[],
  by: (row: AchievementRuleRow) => string,
): [AchievementRuleRow, UsageAchievementCountsRecord][] {
  const groups = new Map<
    string,
    [AchievementRuleRow, UsageAchievementCountsRecord]
  >();
  for (const row of rules) {
    const group = groups.get(by(row));
    if (group) {
      group[1].achievementCount += row.counted;
      group[1].needsReviewCount += row.waiting;
    } else {
      groups.set(by(row), [
        row,
        { achievementCount: row.counted, needsReviewCount: row.waiting },
      ]);
    }
  }
  return [...groups.values()];
}

function figuresOf(row: BreakdownRow) {
  return {
    sessionCount: row.session_count,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadInputTokens: Number(row.cache_read_input_tokens),
    cacheCreationInputTokens: Number(row.cache_creation_input_tokens),
    costUsd: row.cost_usd,
  };
}

function counted(condition: SQL | undefined) {
  return sql<number>`count(${turns.id}) FILTER (WHERE ${condition})`.mapWith(
    Number,
  );
}

export function createPostgresUsageReader(db: Database): UsageReader {
  return {
    async installationUsage() {
      const [row] = await db
        .select({
          readAt: sql<Date>`now()`.mapWith((value) => new Date(value)),
          // The scheduler's capacity predicate: a reservation or a worker
          // still being removed holds its slot too.
          executionSlotsUsed: sql<number>`(${db
            .select({ count: sql`count(*)` })
            .from(workerLaunches)
            .where(isNull(workerLaunches.slotReleasedAt))})`.mapWith(Number),
          // Queued turns, not queue rows: a delivered input keeps its row
          // until it settles.
          queuedInputCount: sql<number>`(${db
            .select({ count: sql`count(*)` })
            .from(turns)
            .where(eq(turns.status, "queued"))})`.mapWith(Number),
          storageUsedBytes:
            sql<number>`coalesce(${storageUsage.bytes}, 0)`.mapWith(Number),
          storageUpdatedAt: storageUsage.updatedAt,
          // An output object stays in the store while any checkpoint naming
          // it is not purged; a later checkpoint names its parent's objects
          // again rather than uploading them. Kept per key by triggers
          // (checkpointOutputObjects).
          outputsUsedBytes:
            sql<number>`coalesce((SELECT ${checkpointOutputTotals.keptBytes} FROM ${checkpointOutputTotals} WHERE ${checkpointOutputTotals.scope} = 'installation'), 0)`.mapWith(
              Number,
            ),
          // A kept key's count moved when its first checkpoint committed; a
          // released key's when the last checkpoint naming it was purged.
          outputsUpdatedAt:
            sql<Date | null>`greatest((SELECT max(${checkpointOutputObjects.firstAt}) FROM ${checkpointOutputObjects}), (SELECT max(${checkpointOutputObjects.releasedAt}) FROM ${checkpointOutputObjects} WHERE ${checkpointOutputObjects.liveRefs} = 0))`.mapWith(
              (value) => new Date(value),
            ),
          // Rows collected before objects_purged_at existed are stamped by
          // the next collection pass that deletes cleanly.
          outputsComplete: sql<boolean>`NOT EXISTS (SELECT 1 FROM ${checkpoints} WHERE ${checkpoints.objectsPurgedAt} IS NULL AND NOT ${checkpoints.outputsRecorded})`,
          // A row per chunk of up to a thousand events: small enough to sum.
          archivedEventsBytes:
            sql<number>`(SELECT coalesce(sum(${sessionEventArchives.bytes}), 0) FROM ${sessionEventArchives})`.mapWith(
              Number,
            ),
          archivedEventsUpdatedAt:
            sql<Date | null>`(SELECT max(${sessionEventArchives.createdAt}) FROM ${sessionEventArchives})`.mapWith(
              (value) => new Date(value),
            ),
        })
        .from(sql`(SELECT 1) AS one`)
        .leftJoin(
          storageUsage,
          eq(storageUsage.scope, INSTALLATION_STORAGE_SCOPE),
        );
      if (!row) throw new Error("installation usage read returned no row");
      return row;
    },

    async agentExists(ownerId, agentId) {
      const [row] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, ownerId), eq(agents.id, agentId)));
      return row !== undefined;
    },

    async sessionUsage(ownerId, sessionId) {
      const [row] = await db
        .select({
          readAt: sql<Date>`now()`.mapWith((value) => new Date(value)),
          sessionId: sessions.id,
          unmetered: sessions.unmetered,
          costUsd: sql<string>`${sessions.costUsd}::text`,
          providerTokens: sessions.providerTokens,
          reportedTurnCount: counted(
            and(inArray(turns.status, ENDED), costReported),
          ),
          unreportedTurnCount: counted(
            and(inArray(turns.status, ENDED), not(costReported), not(neverRan)),
          ),
          openTurnCount: counted(inArray(turns.status, OPEN)),
          queuedInputCount: counted(eq(turns.status, "queued")),
        })
        .from(sessions)
        .leftJoin(turns, eq(turns.sessionId, sessions.id))
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
        .groupBy(sessions.id);
      return row ?? null;
    },

    async usageSummary(filter, period) {
      const { since, until } = periodBounds(period);
      const picked = db.$with("picked").as(
        db
          .select({
            id: sessions.id,
            costUsd: sessions.costUsd,
            providerTokens: sessions.providerTokens,
          })
          .from(sessions)
          .where(
            and(
              sql`${sessions.createdAt} >= ${since}`,
              sql`${sessions.createdAt} < ${until}`,
              startedBy(filter),
            ),
          ),
      );
      const pickedTurns = inArray(
        turns.sessionId,
        db.select({ id: picked.id }).from(picked),
      );
      const [row] = await db
        .with(picked)
        .select({
          readAt: sql<Date>`now()`.mapWith((value) => new Date(value)),
          until: sql<Date>`${until}`.mapWith((value) => new Date(value)),
          sessionCount: sql<number>`count(*)`.mapWith(Number),
          costUsd: sql<string>`coalesce(sum(${picked.costUsd}), 0)::text`,
          providerTokens:
            sql<number>`coalesce(sum(${picked.providerTokens}), 0)`.mapWith(
              Number,
            ),
          incompleteTurnCount: sql<number>`(${db
            .select({ count: sql`count(*)` })
            .from(turns)
            .where(and(pickedTurns, incomplete))})`.mapWith(Number),
          runSeconds: sql<number>`(${db
            .select({
              seconds: sql`coalesce(floor(sum(${runSeconds})), 0)`,
            })
            .from(turns)
            .where(and(pickedTurns, ran))})`.mapWith(Number),
        })
        .from(picked);
      if (!row) throw new Error("usage summary read returned no row");
      return row;
    },

    async usageOutcomes(filter, period) {
      const { since, until } = periodBounds(period);
      // Outcomes are counted per session before the join, so a session's
      // cost adds once however many pull requests it opened (§10).
      const rows = await executeWithoutJit<OutcomeRow>(
        db,
        sql`
        WITH s AS (
          SELECT ${sessions.id} AS id, ${agentReleases.agentId} AS agent_id,
                 ${sessions.costUsd} AS cost_usd, ${sessions.providerTokens} AS provider_tokens
          FROM ${sessions}
          LEFT JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId}
          WHERE ${sessions.createdAt} >= ${since} AND ${sessions.createdAt} < ${until}
            AND ${startedBy(filter) ?? sql`TRUE`}
        ),
        o AS (
          SELECT ${sessionOutcomes.sessionId} AS session_id, count(*) AS prs,
                 count(*) FILTER (WHERE ${sessionOutcomes.state} = 'merged') AS merged,
                 count(*) FILTER (WHERE ${sessionOutcomes.state} = 'closed') AS closed
          FROM ${sessionOutcomes}
          WHERE ${sessionOutcomes.type} = 'github_pull_request'
            AND ${sessionOutcomes.sessionId} IN (SELECT id FROM s)
          GROUP BY ${sessionOutcomes.sessionId}
        ),
        t AS (
          SELECT ${turns.sessionId} AS session_id, count(*) AS incomplete
          FROM ${turns}
          WHERE ${turns.sessionId} IN (SELECT id FROM s) AND ${incomplete}
          GROUP BY ${turns.sessionId}
        ),
        g AS (
          SELECT s.agent_id, grouping(s.agent_id) = 1 AS total,
                 count(s.id)::int AS session_count,
                 coalesce(sum(s.cost_usd), 0) AS cost_usd,
                 coalesce(sum(s.provider_tokens), 0)::bigint AS token_count,
                 coalesce(sum(t.incomplete), 0)::int AS incomplete,
                 (count(*) FILTER (WHERE o.prs > 0))::int AS sessions_with_pr,
                 (count(*) FILTER (WHERE o.merged > 0))::int AS sessions_with_merged_pr,
                 coalesce(sum(o.prs), 0)::int AS pr_count,
                 coalesce(sum(o.merged), 0)::int AS merged_pr_count,
                 coalesce(sum(o.closed), 0)::int AS closed_pr_count,
                 coalesce(sum(s.cost_usd) FILTER (WHERE o.merged > 0), 0) AS cost_of_merged_sessions_usd
          FROM s
          LEFT JOIN o ON o.session_id = s.id
          LEFT JOIN t ON t.session_id = s.id
          GROUP BY GROUPING SETS ((s.agent_id), ())
        )
        SELECT now() AS read_at, ${until} AS until, g.agent_id::text AS key,
               ${agents.name} AS name, g.total, g.session_count,
               g.cost_usd::text AS cost_usd, g.token_count, g.incomplete,
               g.sessions_with_pr, g.sessions_with_merged_pr, g.pr_count,
               g.merged_pr_count, g.closed_pr_count,
               g.cost_of_merged_sessions_usd::text AS cost_of_merged_sessions_usd,
               CASE WHEN g.merged_pr_count > 0
                 THEN round(g.cost_usd / g.merged_pr_count, 6)::text END AS cost_per_merged_pr_usd
        FROM g
        LEFT JOIN ${agents} ON ${agents.id} = g.agent_id
        ORDER BY g.total DESC, g.cost_usd DESC, key NULLS LAST`,
      );
      const figures = (row: OutcomeRow) => ({
        sessionCount: row.session_count,
        costUsd: row.cost_usd,
        providerTokens: Number(row.token_count),
        incompleteTurnCount: row.incomplete,
        sessionsWithPr: row.sessions_with_pr,
        sessionsWithMergedPr: row.sessions_with_merged_pr,
        prCount: row.pr_count,
        mergedPrCount: row.merged_pr_count,
        closedPrCount: row.closed_pr_count,
        costOfMergedSessionsUsd: row.cost_of_merged_sessions_usd,
        costPerMergedPrUsd: row.cost_per_merged_pr_usd,
      });
      const total = rows.find((row) => row.total);
      if (!total) throw new Error("usage outcomes read returned no total");
      return {
        readAt: new Date(total.read_at),
        until: new Date(total.until),
        ...figures(total),
        groups: rows
          .filter((row) => !row.total)
          .map((row) => ({ id: row.key, name: row.name, ...figures(row) })),
      };
    },

    usageAchievements: (filter, options) =>
      usageAchievements(db, filter, options),

    async usageSummaryGroups(filter, period, by) {
      const { since, until } = periodBounds(period);
      const inPeriod = sql`${sessions.createdAt} >= ${since}
        AND ${sessions.createdAt} < ${until}
        AND ${startedBy(filter) ?? sql`TRUE`}`;
      const rows = await executeWithoutJit<SummaryGroupRow>(
        db,
        summaryGroups(inPeriod, until, by),
      );
      const [first] = rows;
      if (!first) throw new Error("usage summary groups read returned no row");
      return {
        readAt: new Date(first.read_at),
        until: new Date(first.until),
        sessionCount: first.total_session_count,
        costUsd: first.total_cost_usd,
        providerTokens: Number(first.total_provider_tokens),
        incompleteTurnCount: first.total_incomplete,
        runSeconds: Number(first.total_run_seconds),
        groups: rows.flatMap((row) =>
          row.session_count === null
            ? []
            : [
                {
                  id: row.key,
                  name: row.name,
                  sessionCount: row.session_count,
                  costUsd: row.cost_usd ?? "0",
                  incompleteTurnCount: row.incomplete ?? 0,
                  runSeconds: Number(row.run_seconds),
                },
              ],
        ),
      };
    },

    async usageSeries(filter, period) {
      const { since, until } = periodBounds(period);
      const inPeriod = sql`${sessions.createdAt} >= ${since}
            AND ${sessions.createdAt} < ${until}
            AND ${startedBy(filter) ?? sql`TRUE`}`;
      const day = sql`(${sessions.createdAt} AT TIME ZONE 'UTC')::date`;
      // The summary's figures per UTC day of created_at. Sessions and their
      // turns are each grouped by day, never by session, so a long period is
      // two hash aggregates. Run time is summed exactly (numeric) per day and
      // floored on the running total, so the days add up to the summary's
      // one floor over the whole period.
      const query = sql`
        WITH per_day AS (
          SELECT ${day} AS day,
                 count(*) AS session_count,
                 sum(${sessions.costUsd}) AS cost_usd,
                 sum(${sessions.providerTokens}) AS provider_tokens
          FROM ${sessions}
          WHERE ${inPeriod}
          GROUP BY 1
        ),
        turn_day AS (
          SELECT ${day} AS day,
                 count(*) FILTER (WHERE ${incomplete}) AS incomplete,
                 sum(${runSeconds}) FILTER (WHERE ${ran}) AS seconds
          FROM ${sessions}
          JOIN ${turns} ON ${turns.sessionId} = ${sessions.id}
          WHERE ${inPeriod}
          GROUP BY 1
        ),
        bounds AS (
          SELECT (${since} AT TIME ZONE 'UTC')::date AS first,
                 ((${until} AT TIME ZONE 'UTC') - interval '1 microsecond')::date AS last
        ),
        days AS (
          -- date + integer: a generate_series over dates steps timestamptz
          -- in the session's time zone, and a DST jump at midnight skips a day.
          SELECT bounds.first + n AS day
          FROM bounds, generate_series(0, bounds.last - bounds.first) n
        ),
        buckets AS (
          SELECT days.day,
                 coalesce(per_day.session_count, 0) AS session_count,
                 coalesce(per_day.cost_usd, 0) AS cost_usd,
                 coalesce(per_day.provider_tokens, 0) AS provider_tokens,
                 coalesce(turn_day.incomplete, 0) AS incomplete,
                 coalesce(turn_day.seconds, 0) AS seconds
          FROM days
          LEFT JOIN per_day ON per_day.day = days.day
          LEFT JOIN turn_day ON turn_day.day = days.day
        )
        SELECT now() AS read_at,
               ${until} AS until,
               to_char(day, 'YYYY-MM-DD') AS date,
               session_count::int AS session_count,
               cost_usd::text AS cost_usd,
               provider_tokens::bigint AS provider_tokens,
               incomplete::int AS incomplete,
               (floor(sum(seconds) OVER running)
                 - floor(sum(seconds) OVER running - seconds))::bigint AS run_seconds
        FROM buckets
        WINDOW running AS (ORDER BY day ROWS UNBOUNDED PRECEDING)
        ORDER BY day`;
      const rows = await executeWithoutJit<{
        read_at: Date | string;
        until: Date | string;
        date: string;
        session_count: number;
        cost_usd: string;
        provider_tokens: number | string;
        incomplete: number;
        run_seconds: number | string;
      }>(db, query);
      const [first] = rows;
      if (!first) throw new Error("usage series read returned no day");
      return {
        readAt: new Date(first.read_at),
        until: new Date(first.until),
        buckets: rows.map((row) => ({
          date: row.date,
          sessionCount: row.session_count,
          costUsd: row.cost_usd,
          providerTokens: Number(row.provider_tokens),
          incompleteTurnCount: row.incomplete,
          runSeconds: Number(row.run_seconds),
        })),
      };
    },

    async usageBreakdown(filter, period, by) {
      const { since, until } = periodBounds(period);
      const started = startedBy(filter);
      const inPeriod = sql`${sessions.createdAt} >= ${since}
        AND ${sessions.createdAt} < ${until}
        AND ${started ?? sql`TRUE`}`;
      // The installation's rollup rows are the period's alone; anyone
      // else's go through their sessions.
      const ofPeriod = (createdAt: AnyColumn, sessionId: AnyColumn) =>
        sql`${createdAt} >= ${since} AND ${createdAt} < ${until} AND ${
          started
            ? sql`${sessionId} IN (SELECT ${sessions.id} FROM ${sessions} WHERE ${inPeriod})`
            : sql`TRUE`
        }`;
      const pairs = ofPeriod(
        sessionModelUsage.sessionCreatedAt,
        sessionModelUsage.sessionId,
      );
      const rows = await executeWithoutJit<BreakdownRow>(
        db,
        by === "agent"
          ? breakdownByAgent(inPeriod, pairs)
          : breakdownByModel(
              inPeriod,
              pairs,
              ofPeriod(
                sessionPreMeteringCost.sessionCreatedAt,
                sessionPreMeteringCost.sessionId,
              ),
            ),
      );
      const total = rows.find((row) => row.total);
      if (!total) throw new Error("usage breakdown read returned no total");
      return {
        rows: rows
          .filter((row) => !row.total)
          .map((row) => ({
            key: row.key,
            label: row.label,
            ...figuresOf(row),
          })),
        totals: figuresOf(total),
      };
    },

    // From the reconciler's projection: calls made since its last pass do
    // not count yet.
    async usageTools(filter, tools, limit) {
      const totals = await toolCallTotals(db, filter, {
        since: tools.period.since,
        ...(tools.period.until === undefined
          ? {}
          : { until: tools.period.until }),
        ...(tools.agentId === undefined ? {} : { agentId: tools.agentId }),
        limit,
      });
      const descriptions = await toolDescriptionsOf(
        db,
        filter,
        tools.agentId,
        totals.map((row) => row.name),
      );
      return totals.map((row) => {
        const description = descriptions.get(row.name);
        return description === undefined ? row : { ...row, description };
      });
    },

    usageToolCalls(filter, calls) {
      return toolCallPage(db, filter, {
        ...calls,
        until: untilOf(calls.period),
      });
    },

    usageToolDays(filter, tools) {
      return toolCallDays(db, filter, {
        name: tools.name,
        since: tools.period.since,
        ...(tools.period.until === undefined
          ? {}
          : { until: tools.period.until }),
        ...(tools.agentId === undefined ? {} : { agentId: tools.agentId }),
      });
    },
  };
}
