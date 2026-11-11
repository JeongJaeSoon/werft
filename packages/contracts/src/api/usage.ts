import { z } from "zod";

import { costUsdSchema } from "../domain/digest.ts";
import {
  agentIdSchema,
  opaqueCursorSchema,
  sessionIdSchema,
  timestampSchema,
} from "../shared/index.ts";
import {
  achievementEvidenceKindSchema,
  achievementReviewStateSchema,
  achievementRuleJudgeSchema,
} from "./achievements.ts";

const countSchema = z.number().int().nonnegative();

/**
 * What the storage limit counts today. A reader must not assume
 * events, checkpoints or worker disks are inside `used_bytes`.
 */
export const STORAGE_ACCOUNTED_CONTENT_VALUES = ["input_messages"] as const;

/**
 * GET /v1/limits: the limits the installation runs under and how
 * much of the installation-wide ones is in use. Every figure under `usage`
 * is summed across all owners, so none of them compares against a
 * per-session limit.
 */
export const installationLimitsResponseSchema = z
  .object({
    scope: z.literal("installation"),
    refreshed_at: timestampSchema,
    limits: z
      .object({
        execution_slot_limit: countSchema,
        queued_input_limit_per_session: countSchema,
        storage_limit_bytes: countSchema,
        max_turn_seconds: countSchema,
        session_cost_limit_usd: costUsdSchema,
        // null when the installation sets no token limit.
        session_token_limit: countSchema.nullable(),
        provider_max_retries: countSchema,
      })
      .strict(),
    usage: z
      .object({
        // Launches holding a slot, reservations and workers still being
        // removed included: the count the scheduler compares to the limit.
        execution_slots_used: countSchema,
        queued_input_count: countSchema,
        storage: z
          .object({
            used_bytes: countSchema,
            accounted_content: z.array(
              z.enum(STORAGE_ACCOUNTED_CONTENT_VALUES),
            ),
            // When the counter last moved; `refreshed_at` is when it was read.
            updated_at: timestampSchema.nullable(),
          })
          .strict(),
        // Session outputs kept in the object store, apart from `storage`:
        // shown, never enforced. An object a later checkpoint inherits is
        // counted once; one too large to upload is not counted.
        outputs: z
          .object({
            used_bytes: countSchema,
            // When the figure last moved; null while nothing was recorded.
            updated_at: timestampSchema.nullable(),
            // false while a checkpoint from before outputs were recorded may
            // still have objects stored: they are missing from `used_bytes`.
            complete: z.boolean(),
          })
          .strict(),
        // Session events moved to the object store once their sessions went
        // idle (docs/operator/data-retention.md), as stored, compressed;
        // shown, never enforced.
        archived_events: z
          .object({
            used_bytes: countSchema,
            // When the last chunk was archived; null while none was.
            updated_at: timestampSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/**
 * GET /v1/limits?scope=me: the per-session limits every signed-in member
 * runs under. Installation settings, so nobody else's figures; no `usage`.
 */
export const memberLimitsResponseSchema = z
  .object({
    scope: z.literal("me"),
    refreshed_at: timestampSchema,
    limits: z
      .object({
        queued_input_limit_per_session: countSchema,
        max_turn_seconds: countSchema,
        session_cost_limit_usd: costUsdSchema,
        session_token_limit: countSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const limitsResponseSchema = z.discriminatedUnion("scope", [
  installationLimitsResponseSchema,
  memberLimitsResponseSchema,
]);

/** GET /v1/limits. Without `scope` it is the installation's. */
export const limitsQuerySchema = z.object({
  scope: z.enum(["installation", "me"]).default("installation"),
});

/**
 * GET /v1/sessions/{id}/usage. The cost is an estimate, never a
 * bill: every Messages call the egress proxy saw, the engine's and a tool's
 * alike, priced by the platform's table. A session from before
 * that also carries the engine's own turn totals up to then. `complete` is
 * about turn reports only: false while a turn is running or when a turn
 * ended without reporting a cost, in which case the true total is unknown.
 */
export const sessionUsageResponseSchema = z
  .object({
    session_id: sessionIdSchema,
    period: z.literal("session_lifetime"),
    refreshed_at: timestampSchema,
    cost: z
      .object({
        amount_usd: costUsdSchema,
        // `unmetered`: the session's connection declared it is not billed per
        // token, so its calls cost nothing and the cost limit never stops it.
        kind: z.enum(["estimated", "unmetered"]),
        source: z.literal("provider_usage"),
        completeness_scope: z.literal("turn_reports"),
        complete: z.boolean(),
        reported_turn_count: countSchema,
        unreported_turn_count: countSchema,
        open_turn_count: countSchema,
      })
      .strict(),
    // null for an unmetered session: the cost limit does not apply to it.
    cost_limit_usd: costUsdSchema.nullable(),
    // Every token of the same calls the cost counts, whatever they cost.
    token_count: countSchema,
    token_limit: countSchema.nullable(),
    // Either limit reached.
    budget_exceeded: z.boolean(),
    queued_input_count: countSchema,
    queued_input_limit: countSchema,
  })
  .strict();

export const USAGE_SUMMARY_SCOPE_VALUES = ["installation", "me"] as const;

// A calendar date is that day's 00:00 UTC; a timestamp with an offset is
// moved to UTC. Either way the period is cut on UTC.
const periodBoundSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform(
    (value) => new Date(value.length === 10 ? `${value}T00:00:00Z` : value),
  )
  // An impossible day such as 2026-02-30 is no date; PostgreSQL has no year 0.
  .pipe(z.date().min(new Date("0001-01-01T00:00:00Z")));

const usagePeriodQuerySchema = z.object({
  scope: z.enum(USAGE_SUMMARY_SCOPE_VALUES),
  since: periodBoundSchema,
  // Omitted: the moment the database reads the figures.
  until: periodBoundSchema.optional(),
});

function checkPeriod(
  query: { since: Date; until?: Date | undefined },
  ctx: z.RefinementCtx,
) {
  if (query.since < (query.until ?? new Date())) return;
  ctx.addIssue(
    query.until === undefined
      ? {
          code: "custom",
          message: "since must be in the past",
          path: ["since"],
        }
      : {
          code: "custom",
          message: "until must be after since",
          path: ["until"],
        },
  );
}

export const USAGE_SUMMARY_GROUP_BY_VALUES = ["agent", "user"] as const;

/** The summary's scopes: the period scopes and one agent's sessions. */
export const USAGE_SUMMARY_TOTALS_SCOPE_VALUES = [
  ...USAGE_SUMMARY_SCOPE_VALUES,
  "agent",
] as const;

/**
 * GET /v1/usage/summary. `installation` sums every owner's sessions and is
 * the installation owner's alone; `me` sums the sessions the caller started;
 * `agent` sums the workspace's sessions started from any release of
 * `agent_id`, for the workspace's owners and admins and that agent's admins.
 */
export const usageSummaryQuerySchema = usagePeriodQuerySchema
  .extend({
    scope: z.enum(USAGE_SUMMARY_TOTALS_SCOPE_VALUES),
    agent_id: agentIdSchema.optional(),
    group_by: z.enum(USAGE_SUMMARY_GROUP_BY_VALUES).optional(),
  })
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    if (query.scope === "agent") {
      if (query.agent_id === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "scope=agent needs agent_id",
          path: ["agent_id"],
        });
      }
      if (query.group_by !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "scope=agent takes no group_by",
          path: ["group_by"],
        });
      }
    } else if (query.agent_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "agent_id goes only with scope=agent",
        path: ["agent_id"],
      });
    }
  });

/**
 * GET /v1/usage/outcomes: the summary's scopes, period and readers, with
 * the pull requests those sessions opened. `group_by` takes `agent` only.
 */
export const usageOutcomesQuerySchema = usagePeriodQuerySchema
  .extend({
    scope: z.enum(USAGE_SUMMARY_TOTALS_SCOPE_VALUES),
    agent_id: agentIdSchema.optional(),
    group_by: z.enum(["agent"]).optional(),
  })
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    if (query.scope === "agent") {
      if (query.agent_id === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "scope=agent needs agent_id",
          path: ["agent_id"],
        });
      }
      if (query.group_by !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "scope=agent takes no group_by",
          path: ["group_by"],
        });
      }
    } else if (query.agent_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "agent_id goes only with scope=agent",
        path: ["agent_id"],
      });
    }
  });

const DAY_MS = 86_400_000;
/**
 * The longest period a series or breakdown answers, a leap year of day
 * buckets: each reads every session of the period.
 */
export const USAGE_PERIOD_MAX_DAYS = 366;

function checkBoundedPeriod(
  query: z.infer<typeof usagePeriodQuerySchema>,
  ctx: z.RefinementCtx,
) {
  checkPeriod(query, ctx);
  const until = query.until ?? new Date();
  if (until.getTime() - query.since.getTime() <= USAGE_PERIOD_MAX_DAYS * DAY_MS)
    return;
  ctx.addIssue({
    code: "custom",
    message: `a period spans at most ${USAGE_PERIOD_MAX_DAYS} days`,
    path: ["since"],
  });
}

/** GET /v1/usage/series: the summary's sessions, one bucket per UTC day. */
export const usageSeriesQuerySchema = usagePeriodQuerySchema
  .extend({ bucket: z.enum(["day"]).default("day") })
  .superRefine(checkBoundedPeriod);

export const USAGE_BREAKDOWN_BY_VALUES = ["model", "agent"] as const;

/** GET /v1/usage/breakdown: the summary's sessions grouped by model or agent. */
export const usageBreakdownQuerySchema = usagePeriodQuerySchema
  .extend({ by: z.enum(USAGE_BREAKDOWN_BY_VALUES) })
  .superRefine(checkBoundedPeriod);

/**
 * GET /v1/usage/tools: the same scopes and period as the summary, the period
 * cutting on when each tool call's tool_use event was stored.
 */
export const usageToolsQuerySchema = usagePeriodQuerySchema
  .extend({ agent_id: agentIdSchema.optional() })
  .superRefine(checkPeriod);

/** The most tool names one GET /v1/usage/tools response lists. */
export const USAGE_TOOLS_LIMIT = 200;

export const USAGE_TOOL_FINDING_KIND_VALUES = [
  "most_time",
  "fails_often",
  "slowest",
] as const;

/**
 * Calls per tool name, the most-called first. A call is timed from its
 * tool_use to its paired tool_result; one without a result yet, or with
 * either time missing, counts in `calls` but in no `_ms` figure. `failed`
 * counts results with `is_error: true` only. Each finding names a row of
 * `tools`, whose figures it reads.
 */
export const usageToolsResponseSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            calls: countSchema,
            failed: countSchema,
            total_ms: countSchema,
            median_ms: countSchema,
            max_ms: countSchema,
            // From an MCP server, as its tools were listed at session start;
            // built-in tools have none.
            description: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .max(USAGE_TOOLS_LIMIT),
    findings: z.array(
      z
        .object({
          kind: z.enum(USAGE_TOOL_FINDING_KIND_VALUES),
          name: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const USAGE_TOOL_CALLS_SORT_VALUES = ["recent", "slowest"] as const;
export const USAGE_TOOL_CALLS_LIMIT_DEFAULT = 20;
export const USAGE_TOOL_CALLS_LIMIT_MAX = 100;
export const USAGE_TOOL_CALLS_MAX_DAYS = 366;
export const USAGE_TOOL_CALL_OUTCOME_VALUES = [
  "ok",
  "failed",
  "unknown",
] as const;

export const usageToolCallsParamsSchema = z.object({
  name: z.string().min(1).max(512),
});

/**
 * GET /v1/usage/tools/{name}/calls: the scopes, period and agent filter of
 * GET /v1/usage/tools, one page of that tool's calls.
 */
export const usageToolCallsQuerySchema = usagePeriodQuerySchema
  .extend({
    agent_id: agentIdSchema.optional(),
    sort: z.enum(USAGE_TOOL_CALLS_SORT_VALUES).default("recent"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(USAGE_TOOL_CALLS_LIMIT_MAX)
      .default(USAGE_TOOL_CALLS_LIMIT_DEFAULT),
    cursor: opaqueCursorSchema.optional(),
  })
  .superRefine(checkPeriod)
  // per_day lists every date, so the period is bounded.
  .superRefine((query, ctx) => {
    const until = query.until ?? new Date();
    if (
      until.getTime() - query.since.getTime() >
      USAGE_TOOL_CALLS_MAX_DAYS * 86_400_000
    ) {
      ctx.addIssue({
        code: "custom",
        message: `the period may span at most ${USAGE_TOOL_CALLS_MAX_DAYS} days`,
        path: ["since"],
      });
    }
  });

/**
 * `session_id` and `title` are null for a session the caller may not read;
 * the call's time, duration, outcome and agent still show. `agent` is null
 * for a session made without one. `per_day` has every UTC date the period
 * touches, zeros included.
 */
export const usageToolCallsResponseSchema = z
  .object({
    calls: z
      .array(
        z
          .object({
            session_id: sessionIdSchema.nullable(),
            title: z.string().nullable(),
            agent: z.string().nullable(),
            occurred_at: timestampSchema,
            duration_ms: countSchema.nullable(),
            outcome: z.enum(USAGE_TOOL_CALL_OUTCOME_VALUES),
          })
          .strict(),
      )
      .max(USAGE_TOOL_CALLS_LIMIT_MAX),
    next_cursor: opaqueCursorSchema.nullable(),
    per_day: z.array(
      z.object({ date: z.iso.date(), calls: countSchema }).strict(),
    ),
  })
  .strict();

/**
 * A session counts in the period it was created in, so `cost_usd` is the sum
 * of `GET /v1/sessions/{id}/usage` `cost.amount_usd` over the same sessions
 * and `cost_complete` is false when any of them is.
 */
export const usageSummaryResponseSchema = z
  .object({
    scope: z.enum(USAGE_SUMMARY_TOTALS_SCOPE_VALUES),
    // Half-open: since <= created_at < until.
    period: z
      .object({ since: timestampSchema, until: timestampSchema })
      .strict(),
    refreshed_at: timestampSchema,
    session_count: countSchema,
    cost_usd: costUsdSchema,
    cost_complete: z.boolean(),
    token_count: countSchema,
    // Wall-clock time turns ran: an open turn counts up to `refreshed_at`.
    run_seconds: countSchema,
    basis: z
      .object({
        sessions: z.literal("created_in_period"),
        cost: z.literal("provider_usage_estimate"),
        run_time: z.literal("turn_wall_clock"),
      })
      .strict(),
    /**
     * Only with `group_by`: the same sessions, each under its agent, or the
     * user holding it, largest cost first. The
     * groups' `session_count`, `cost_usd` and `run_seconds` add up to the
     * totals above, and `cost_complete` above is false when any group's is.
     * `id` is null for the sessions without an agent or a user (a key's
     * own). `name` is the agent's name or the user's display name (never an
     * email); null where the caller may not see that user.
     */
    groups: z
      .array(
        z
          .object({
            id: z.string().nullable(),
            name: z.string().nullable(),
            session_count: countSchema,
            run_seconds: countSchema,
            cost_usd: costUsdSchema,
            cost_complete: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/**
 * The outcome figures of a set of sessions: each session's cost once, however
 * many pull requests it opened. A state is as of each outcome's last check.
 */
const usageOutcomeFiguresSchema = z.object({
  session_count: countSchema,
  cost_usd: costUsdSchema,
  cost_complete: z.boolean(),
  token_count: countSchema,
  sessions_with_pr: countSchema,
  sessions_with_merged_pr: countSchema,
  pr_count: countSchema,
  merged_pr_count: countSchema,
  closed_pr_count: countSchema,
  // Only the sessions with a merged pull request.
  cost_of_merged_sessions_usd: costUsdSchema,
  // Every session's cost over merged_pr_count; null with none merged.
  cost_per_merged_pr_usd: costUsdSchema.nullable(),
});

export const usageOutcomesResponseSchema = usageOutcomeFiguresSchema
  .extend({
    scope: z.enum(USAGE_SUMMARY_TOTALS_SCOPE_VALUES),
    // Half-open: since <= created_at < until.
    period: z
      .object({ since: timestampSchema, until: timestampSchema })
      .strict(),
    refreshed_at: timestampSchema,
    /**
     * Only with `group_by=agent`: the same sessions, each under its agent,
     * largest cost first; `id` and `name` are null for the sessions without
     * one. The groups add up to the totals above.
     */
    groups: z
      .array(
        usageOutcomeFiguresSchema
          .extend({ id: z.string().nullable(), name: z.string().nullable() })
          .strict(),
      )
      .optional(),
  })
  .strict();

/**
 * GET /v1/usage/achievements: the summary's scopes, period and readers.
 * `agent_id` names the agent with `scope=agent`, and narrows the sessions to
 * that agent's with `installation` or `me`. `type_id` and `category_id` narrow
 * the achievements counted, not the sessions or their cost.
 */
export const usageAchievementsQuerySchema = usagePeriodQuerySchema
  .extend({
    scope: z.enum(USAGE_SUMMARY_TOTALS_SCOPE_VALUES),
    agent_id: agentIdSchema.optional(),
    type_id: z.uuid().optional(),
    category_id: z.uuid().optional(),
  })
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    if (query.scope === "agent" && query.agent_id === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "scope=agent needs agent_id",
        path: ["agent_id"],
      });
    }
  });

/** The most achievements `recent` lists, the newest first. */
export const USAGE_RECENT_ACHIEVEMENTS_LIMIT = 20;

// `achievement_count` counts `auto` and `confirmed`; superseded rows count
// nowhere.
const achievementCountsSchema = {
  achievement_count: countSchema,
  needs_review_count: countSchema,
};

/**
 * Each session's cost once, however many achievements it has. The judge's
 * cost is apart from the sessions' and is not narrowed by type or category:
 * one judgment covers every rule of its session. `cost_per_achievement_usd`
 * is every session's cost, those without an achievement included, over
 * `achievement_count`; null with none.
 */
export const usageAchievementsResponseSchema = z
  .object({
    scope: z.enum(USAGE_SUMMARY_TOTALS_SCOPE_VALUES),
    // Half-open: since <= created_at < until.
    period: z
      .object({ since: timestampSchema, until: timestampSchema })
      .strict(),
    refreshed_at: timestampSchema,
    session_count: countSchema,
    sessions_with_achievement_count: countSchema,
    cost_usd: costUsdSchema,
    cost_complete: z.boolean(),
    ...achievementCountsSchema,
    rejected_count: countSchema,
    // Judgments that called the judge, and its calls.
    judgment_count: countSchema,
    judge_calls: countSchema,
    judge_cost_usd: costUsdSchema,
    cost_per_achievement_usd: costUsdSchema.nullable(),
    // Rows with an achievement counted or waiting for review; a category or
    // type under its current name.
    by_category: z.array(
      z
        .object({ id: z.uuid(), name: z.string(), ...achievementCountsSchema })
        .strict(),
    ),
    by_type: z.array(
      z
        .object({
          id: z.uuid(),
          key: z.string(),
          name: z.string(),
          ...achievementCountsSchema,
        })
        .strict(),
    ),
    // One row per rule family, as its latest version (`id`, `version`,
    // title, category, type) with every version's achievements, in its
    // category's order.
    by_rule: z.array(
      z
        .object({
          id: z.uuid(),
          family_id: z.uuid(),
          version: z.number().int().positive(),
          title: z.string(),
          category_id: z.uuid(),
          category_name: z.string(),
          type_id: z.uuid(),
          type_key: z.string(),
          ...achievementCountsSchema,
        })
        .strict(),
    ),
    // Every agent with a session in the period; `id` and `name` are null for
    // the sessions without one.
    by_agent: z.array(
      z
        .object({
          id: agentIdSchema.nullable(),
          name: z.string().nullable(),
          session_count: countSchema,
          cost_usd: costUsdSchema,
          achievement_count: countSchema,
          cost_per_achievement_usd: costUsdSchema.nullable(),
        })
        .strict(),
    ),
    // An achievement of a session the caller may not read is left out, its
    // title and link with it (they can name the session); the counts above
    // still include it. `session_id` stays nullable for older readers.
    recent: z
      .array(
        z
          .object({
            id: z.uuid(),
            created_at: timestampSchema,
            session_id: sessionIdSchema.nullable(),
            session_title: z.string().nullable(),
            rule_id: z.uuid(),
            rule_title: z.string(),
            title: z.string().nullable(),
            link: z.string().nullable(),
            evidence_kind: achievementEvidenceKindSchema,
            judge: achievementRuleJudgeSchema,
            review_state: achievementReviewStateSchema,
          })
          .strict(),
      )
      .max(USAGE_RECENT_ACHIEVEMENTS_LIMIT),
  })
  .strict();

/**
 * Every UTC day the period touches, oldest first, empty days included. Each
 * bucket adds up the sessions created that day exactly as the summary does,
 * so the buckets of one response sum to the summary of the same period.
 * `run_seconds` is the floor of the running total minus the one before, so
 * whole seconds are never lost to rounding each day.
 */
export const usageSeriesResponseSchema = z
  .object({
    // Half-open: since <= created_at < until.
    period: z
      .object({ since: timestampSchema, until: timestampSchema })
      .strict(),
    refreshed_at: timestampSchema,
    buckets: z.array(
      z
        .object({
          date: z.iso.date(),
          session_count: countSchema,
          cost_usd: costUsdSchema,
          // true for a day without sessions.
          cost_complete: z.boolean(),
          token_count: countSchema,
          run_seconds: countSchema,
        })
        .strict(),
    ),
  })
  .strict();

const usageBreakdownFiguresSchema = z
  .object({
    session_count: countSchema,
    input_tokens: countSchema,
    output_tokens: countSchema,
    cache_read_input_tokens: countSchema,
    // The 1-hour cache writes are part of it, not a fifth column.
    cache_creation_input_tokens: countSchema,
    // The four columns' sum, the summary's `token_count` for the totals.
    token_count: countSchema,
    cost_usd: costUsdSchema,
  })
  .strict();

/**
 * The summary's sessions grouped, largest cost first. `by=agent`: each
 * session counts once, under its agent, so the rows add up to the totals in
 * every column. `by=model`: a session counts under every model it called, so
 * the rows' `session_count` may add up to more than the totals'; a session's
 * cost no metered call explains (sessions from before proxy metering) is the
 * row whose `key` is null. `key` and `label` are null on the row for sessions
 * without an agent or with that unexplained cost. `totals` is the summary of
 * the same period: `session_count`, `token_count` and `cost_usd` equal it.
 */
export const usageBreakdownResponseSchema = z
  .object({
    rows: z.array(
      usageBreakdownFiguresSchema
        .extend({
          // The agent id, or the model as the proxy recorded it.
          key: z.string().nullable(),
          // The agent's name; for a model, the model again.
          label: z.string().nullable(),
        })
        .strict(),
    ),
    totals: usageBreakdownFiguresSchema,
  })
  .strict();

export type UsageSummaryScope = (typeof USAGE_SUMMARY_SCOPE_VALUES)[number];
export type UsageBreakdownBy = (typeof USAGE_BREAKDOWN_BY_VALUES)[number];
export type UsageBreakdownQuery = z.infer<typeof usageBreakdownQuerySchema>;
export type UsageBreakdownResponse = z.infer<
  typeof usageBreakdownResponseSchema
>;
export type UsageSeriesQuery = z.infer<typeof usageSeriesQuerySchema>;
export type UsageSeriesResponse = z.infer<typeof usageSeriesResponseSchema>;
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>;
export type UsageOutcomesQuery = z.infer<typeof usageOutcomesQuerySchema>;
export type UsageOutcomesResponse = z.infer<typeof usageOutcomesResponseSchema>;
export type UsageAchievementsQuery = z.infer<
  typeof usageAchievementsQuerySchema
>;
export type UsageAchievementsResponse = z.infer<
  typeof usageAchievementsResponseSchema
>;
export type UsageSummaryResponse = z.infer<typeof usageSummaryResponseSchema>;
export type UsageToolsQuery = z.infer<typeof usageToolsQuerySchema>;
export type UsageToolsResponse = z.infer<typeof usageToolsResponseSchema>;
export type UsageToolCallsQuery = z.infer<typeof usageToolCallsQuerySchema>;
export type UsageToolCallsResponse = z.infer<
  typeof usageToolCallsResponseSchema
>;
export type InstallationLimitsResponse = z.infer<
  typeof installationLimitsResponseSchema
>;
export type MemberLimitsResponse = z.infer<typeof memberLimitsResponseSchema>;
export type LimitsResponse = z.infer<typeof limitsResponseSchema>;
export type SessionUsageResponse = z.infer<typeof sessionUsageResponseSchema>;
