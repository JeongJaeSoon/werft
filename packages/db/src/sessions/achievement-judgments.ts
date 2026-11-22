import { randomUUID } from "node:crypto";
import {
  type AchievementEvidenceKind,
  type AchievementJudgment,
  type AchievementJudgmentError,
  type AchievementJudgmentStatus,
  type AchievementJudgmentTrigger,
  type AchievementPayload,
  type AchievementReviewState,
  type AchievementRuleJudge,
  GITHUB_REVIEW_EVENT_VALUES,
  type GitHubPullRequestOutcomeState,
  type GitHubReviewEvent,
  PENDING_ACHIEVEMENT_JUDGMENT_STATUSES,
  type SessionAchievement,
  UNFINISHED_ACHIEVEMENT_JUDGMENT_STATUSES,
  type WorkspaceRole,
  workspaceSettingsSchema,
} from "@werft-ai/contracts";
import {
  ACHIEVEMENT_JUDGMENT_QUIET_MS,
  type AchievementJudgmentStore,
  type JudgmentEgressStore,
  type JudgmentResult,
  MANAGEMENT_ROLES,
  type OutcomeEvidence,
  receiptActorOf,
} from "@werft-ai/platform";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { findPgError, lockPeople } from "../control-shared.ts";
import { lockedAdministers } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  achievementJudgments,
  achievementJudgmentUsage,
  achievementRules,
  achievementTypes,
  agentReleases,
  checkpoints,
  receipts,
  sessionAchievements,
  sessionOutcomes,
  sessions,
  turns,
  workspaces,
} from "../schema.ts";
import { resultTextOf } from "../session-titles.ts";
import { sqlLiterals } from "../sql-literals.ts";
import { rowsOf } from "../statement-rows.ts";
import { managing } from "./achievement-rules.ts";
import { lockSessionReach } from "./requester-locks.ts";

/** What queued a judgment, with what its workspace setting is judged on. */
export type JudgmentCause =
  | { trigger: "evidence" }
  /** The session's turn of this sequence number just ended. */
  | { trigger: "turns"; turn: number }
  | { trigger: "idle" }
  | { trigger: "manual" };

const JUDGE = sql`w.settings -> 'achievement_judge'`;

// An enabled openai_decisions connection; the judge pass checks again that
// its credential resolves. FOR SHARE: a disable holding the row (FOR UPDATE)
// is waited out and the row read again, so nothing is queued after the last
// model went; a later disable waits for this transaction. Lock order: the
// session (FOR KEY SHARE), this row, the pending judgment. A console write
// takes the catalog lock, then this row, and never a session or a judgment.
const DECISION_MODEL = sql`EXISTS (
  SELECT 1 FROM provider_connections pc
  WHERE pc.definition ->> 'kind' = 'openai_decisions' AND pc.disabled_at IS NULL
  FOR SHARE)`;

// Since when the installation has had a decision model without a break
// (0291). NULL without one, and nothing compares as since NULL. FOR SHARE as
// DECISION_MODEL, so a window cannot end or restart before finish commits.
const JUDGING_SINCE = sql`(SELECT min(s.judging_since) FROM (
  SELECT pc.judging_since FROM provider_connections pc
  WHERE pc.definition ->> 'kind' = 'openai_decisions' AND pc.disabled_at IS NULL
  FOR SHARE) s)`;

function gateOf(cause: JudgmentCause): SQL {
  switch (cause.trigger) {
    case "evidence":
      return sql`(${JUDGE} -> 'on_evidence') IS DISTINCT FROM 'false'::jsonb`;
    case "turns":
      return sql`jsonb_typeof(${JUDGE} -> 'every_n_turns') = 'number'
        AND ${cause.turn}::int % (${JUDGE} ->> 'every_n_turns')::int = 0
        AND EXISTS (
          SELECT 1 FROM achievement_rules r
          JOIN achievement_types t ON t.id = r.type_id
          WHERE r.workspace_id = w.id AND r.superseded_by IS NULL
            AND r.disabled_at IS NULL AND t.evidence_kind = 'conversation')`;
    case "idle":
      return sql`(${JUDGE} -> 'on_idle') = 'true'::jsonb`;
    case "manual":
      return sql`TRUE`;
  }
}

/**
 * Queues a judgment of the session: `evidence` in
 * the transaction that wrote its evidence, `turns` and `idle` in the one
 * that ended the turn or the session's run, each when the workspace's
 * judge setting asks for it; `manual` always. A pending one already there
 * is kept and takes the newest trigger. A queued one waits the quiet time
 * again from now, never less than it already waits; a deferred one is
 * queued again after the quiet time, so its `always` pairs are counted
 * without waiting for the next day's budget and its `luna` pairs deferred
 * again. A retry it was becomes a first try, as a new trigger counts
 * afresh. Nothing is queued for a preview session, whose runs are its
 * admin's tries and no team's work, nor for a session without a workspace, nor while the
 * installation has no decision model: the evidence itself is still written
 * for the screens that show it, but no judgment waits to count it later.
 * Returns the pending judgment's id, or null when nothing was queued.
 */
export async function queueAchievementJudgment(
  tx: Database,
  sessionId: string,
  cause: JudgmentCause = { trigger: "evidence" },
): Promise<string | null> {
  // The session row is locked before the pending index entry is taken, the
  // order a checkpoint commit's fence (FOR UPDATE) takes them in; the other
  // order deadlocks against it on the index and the foreign key.
  await tx.execute(
    sql`SELECT 1 FROM sessions WHERE id = ${sessionId} FOR KEY SHARE`,
  );
  // clock_timestamp: a long transaction must not queue in its own past.
  const queued = await tx.execute(sql`
    INSERT INTO achievement_judgments
      (id, workspace_id, owner_id, session_id, trigger, status, next_attempt_at)
    SELECT ${randomUUID()}, s.workspace_id, s.owner_id, s.id, ${cause.trigger}, 'queued',
           clock_timestamp() + make_interval(secs => ${ACHIEVEMENT_JUDGMENT_QUIET_MS / 1000})
    FROM sessions s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = ${sessionId} AND NOT s.preview AND ${gateOf(cause)} AND ${DECISION_MODEL}
    ON CONFLICT (session_id) WHERE status IN (${sqlLiterals(PENDING_ACHIEVEMENT_JUDGMENT_STATUSES)})
    DO UPDATE SET trigger = EXCLUDED.trigger,
                  status = 'queued',
                  next_attempt_at = CASE achievement_judgments.status
                    WHEN 'deferred' THEN EXCLUDED.next_attempt_at
                    ELSE GREATEST(achievement_judgments.next_attempt_at, EXCLUDED.next_attempt_at)
                  END,
                  attempts = 0
    RETURNING id`);
  return rowsOf<{ id: string }>(queued)[0]?.id ?? null;
}

function judgeSettingsOf(settings: unknown) {
  return workspaceSettingsSchema.shape.achievement_judge.parse(
    (settings as { achievement_judge?: unknown } | null)?.achievement_judge,
  );
}

/**
 * The UTC day `at` falls in, whatever the connection's TimeZone: the day is
 * counted on the UTC calendar, so a DST change elsewhere never moves it.
 */
export function utcDayOf(at: SQL): { start: SQL; next: SQL } {
  const day = sql`date_trunc('day', (${at}) AT TIME ZONE 'UTC')`;
  return {
    start: sql`(${day} AT TIME ZONE 'UTC')`,
    next: sql`((${day} + interval '1 day') AT TIME ZONE 'UTC')`,
  };
}

// By the database's clock, the one leases and retries keep.
const TODAY = utcDayOf(sql`now()`);

/**
 * What the workspace's judgment calls made since UTC midnight cost, and when
 * the next day's budget starts.
 */
async function spentToday(
  db: Database,
  workspaceId: string,
): Promise<{ spentUsd: number; budgetResetsAt: Date }> {
  const [spent] = await db
    .select({
      usd: sql<string>`COALESCE(sum(${achievementJudgmentUsage.costUsd}), 0)`,
      resetsAtMs: sql<string>`(extract(epoch FROM ${TODAY.next}) * 1000)::float8`,
    })
    .from(achievementJudgmentUsage)
    .where(
      and(
        eq(achievementJudgmentUsage.workspaceId, workspaceId),
        sql`${achievementJudgmentUsage.createdAt} >= ${TODAY.start}`,
      ),
    );
  if (!spent) throw new Error("aggregate returned no row");
  return {
    spentUsd: Number(spent.usd),
    budgetResetsAt: new Date(Number(spent.resetsAtMs)),
  };
}

const iso = (at: Date | null) => at?.toISOString() ?? null;

type AchievementRow = {
  row: typeof sessionAchievements.$inferSelect;
  ruleTitle: string;
  ruleVersion: number;
  typeKey: string;
  threshold: number | null;
  rejudgedAfterMerge: boolean;
};

/** Achievements with their rule version's title and number and type key. */
function achievementsWhere(db: Database, where: SQL | undefined) {
  return db
    .select({
      row: sessionAchievements,
      ruleTitle: achievementRules.title,
      ruleVersion: achievementRules.version,
      typeKey: achievementTypes.key,
      threshold: achievementJudgments.threshold,
      // Counted by a judgment after the merge, with one before it.
      rejudgedAfterMerge: sql<boolean>`EXISTS (
        SELECT 1 FROM ${sessionOutcomes} o
        WHERE ${sessionAchievements.evidenceKind} = 'github_pull_request'
          AND o.id::text = ${sessionAchievements.evidenceId}
          AND o.merged_at < ${achievementJudgments.createdAt}
          AND EXISTS (
            SELECT 1 FROM ${achievementJudgments} earlier
            WHERE earlier.session_id = ${sessionAchievements.sessionId}
              AND earlier.created_at < o.merged_at
          )
      )`,
    })
    .from(sessionAchievements)
    .innerJoin(
      achievementRules,
      eq(achievementRules.id, sessionAchievements.ruleId),
    )
    .innerJoin(
      achievementTypes,
      eq(achievementTypes.id, sessionAchievements.typeId),
    )
    .innerJoin(
      achievementJudgments,
      eq(achievementJudgments.id, sessionAchievements.judgmentId),
    )
    .where(where)
    .orderBy(asc(sessionAchievements.createdAt), asc(sessionAchievements.id));
}

function achievementOf({
  row,
  ruleTitle,
  ruleVersion,
  typeKey,
  threshold,
  rejudgedAfterMerge,
}: AchievementRow): SessionAchievement {
  return {
    id: row.id,
    session_id: row.sessionId,
    agent_id: row.agentId,
    agent_release_id: row.agentReleaseId,
    rule_id: row.ruleId,
    rule_family_id: row.ruleFamilyId,
    type_id: row.typeId,
    title: row.title,
    link: row.link,
    evidence_kind: row.evidenceKind as AchievementEvidenceKind,
    evidence_id: row.evidenceId,
    payload: row.payload as AchievementPayload | null,
    judge: row.judge as AchievementRuleJudge,
    rule_title: ruleTitle,
    rule_version: ruleVersion,
    type_key: typeKey,
    probability: row.probability,
    threshold,
    rejudged_after_merge: rejudgedAfterMerge,
    judgment_id: row.judgmentId,
    review_state: row.reviewState as AchievementReviewState,
    reviewed_by: row.reviewedBy,
    reviewed_at: iso(row.reviewedAt),
    review_note: row.reviewNote,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * `pr_merged` when the session's pull request merged after the judgment
 * before this `evidence` one was made, and by the time this one was.
 */
async function evidenceChangeOf(
  db: Database,
  judgment: typeof achievementJudgments.$inferSelect,
): Promise<AchievementJudgment["evidence_change"]> {
  if (judgment.trigger !== "evidence") return null;
  // One statement over the rows themselves: a timestamp read back into a
  // Date loses its microseconds, and a merge in the judgment's millisecond
  // would fall outside.
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM ${achievementJudgments} j
      CROSS JOIN LATERAL (
        SELECT p.created_at
        FROM ${achievementJudgments} p
        WHERE p.session_id = j.session_id
          AND (p.created_at, p.id) < (j.created_at, j.id)
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1
      ) previous
      JOIN ${sessionOutcomes} o
        ON o.session_id = j.session_id
       AND o.type = 'github_pull_request'
       AND o.merged_at > previous.created_at
       AND o.merged_at <= j.created_at
      WHERE j.id = ${judgment.id}
    ) AS merged
  `);
  return rowsOf<{ merged: boolean }>(result)[0]?.merged ? "pr_merged" : null;
}

function judgmentOf(
  row: typeof achievementJudgments.$inferSelect,
  evidenceChange: AchievementJudgment["evidence_change"],
): AchievementJudgment {
  return {
    id: row.id,
    trigger: row.trigger as AchievementJudgmentTrigger,
    status: row.status as AchievementJudgmentStatus,
    error_code: row.errorCode as AchievementJudgmentError | null,
    evidence_change: evidenceChange,
    created_at: row.createdAt.toISOString(),
    finished_at: iso(row.finishedAt),
  };
}

function outcomeEvidenceOf(
  row: typeof sessionOutcomes.$inferSelect,
): OutcomeEvidence | null {
  const metadata = row.metadata as Record<string, unknown>;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : null;
  if (row.type === "github_pull_request") {
    const number = Number(row.externalId);
    if (!Number.isSafeInteger(number)) return null;
    return {
      kind: "github_pull_request",
      id: row.id,
      url: row.url,
      number,
      state: row.state as GitHubPullRequestOutcomeState,
      mergedAt: row.mergedAt,
      additions: count(metadata.additions),
      deletions: count(metadata.deletions),
      title: typeof metadata.title === "string" ? metadata.title : null,
    };
  }
  const event = metadata.event as GitHubReviewEvent;
  if (
    typeof metadata.number !== "number" ||
    !GITHUB_REVIEW_EVENT_VALUES.includes(event) ||
    typeof metadata.commit_id !== "string"
  ) {
    return null;
  }
  return {
    kind: "github_review",
    id: row.id,
    url: row.url,
    number: metadata.number,
    event,
    commitId: metadata.commit_id,
  };
}

export function createPostgresAchievementJudgments(
  db: Database,
): AchievementJudgmentStore {
  return {
    async claim({ max, leaseMs }) {
      if (max <= 0) return [];
      const leaseToken = randomUUID();
      const claimed = await db
        .update(achievementJudgments)
        .set({
          status: "running",
          leaseToken,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
          attempts: sql`${achievementJudgments.attempts} + 1`,
          // A lease taken over takes the earlier holder's token with it.
          tokenHash: null,
        })
        .where(
          sql`${achievementJudgments.id} IN (SELECT ${achievementJudgments.id} FROM ${achievementJudgments} WHERE ${achievementJudgments.status} IN (${sqlLiterals(UNFINISHED_ACHIEVEMENT_JUDGMENT_STATUSES)}) AND ${achievementJudgments.nextAttemptAt} <= now() AND (${achievementJudgments.leaseExpiresAt} IS NULL OR ${achievementJudgments.leaseExpiresAt} < now()) ORDER BY ${achievementJudgments.nextAttemptAt} LIMIT ${max} FOR UPDATE SKIP LOCKED)`,
        )
        .returning({
          id: achievementJudgments.id,
          sessionId: achievementJudgments.sessionId,
          attempts: achievementJudgments.attempts,
          errorCode: achievementJudgments.errorCode,
        });
      return claimed.map((row) => ({
        ...row,
        errorCode: row.errorCode as AchievementJudgmentError | null,
        leaseToken,
      }));
    },

    async context(judgment) {
      const [session] = await db
        .select({
          id: sessions.id,
          workspaceId: sessions.workspaceId,
          settings: workspaces.settings,
          title: sessions.title,
          agentReleaseId: sessions.agentReleaseId,
          agentId: agentReleases.agentId,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
        .where(eq(sessions.id, judgment.sessionId))
        .limit(1);
      if (!session?.workspaceId) {
        throw new Error("judged session has no workspace");
      }
      const agentId = session.agentId ?? null;
      // Read once, as text to keep every microsecond: a window that restarts
      // while the judgment reads is not mixed into it.
      const [window] = rowsOf<{ at: string | null }>(
        await db.execute(sql`SELECT ${JUDGING_SINCE}::text AS at`),
      );
      const at = window?.at ?? null;
      const since = sql`${at}::timestamptz`;
      const rules = await db
        .select({
          id: achievementRules.id,
          familyId: achievementRules.familyId,
          typeId: achievementRules.typeId,
          typeKey: achievementTypes.key,
          builtin: achievementTypes.builtin,
          evidenceKind: achievementTypes.evidenceKind,
          judge: achievementRules.judge,
          definition: achievementRules.definition,
        })
        .from(achievementRules)
        .innerJoin(
          achievementTypes,
          eq(achievementTypes.id, achievementRules.typeId),
        )
        .where(
          and(
            eq(achievementRules.workspaceId, session.workspaceId),
            isNull(achievementRules.supersededBy),
            isNull(achievementRules.disabledAt),
            agentId === null
              ? isNull(achievementRules.agentIds)
              : sql`(${achievementRules.agentIds} IS NULL OR ${agentId}::uuid = ANY(${achievementRules.agentIds}))`,
          ),
        )
        .orderBy(asc(achievementRules.createdAt), asc(achievementRules.id));
      // When the outcome reached its state: GitHub's merge or close time,
      // else when this server saw the state.
      const outcomes = await db
        .select()
        .from(sessionOutcomes)
        .where(
          and(
            eq(sessionOutcomes.sessionId, judgment.sessionId),
            sql`COALESCE(CASE ${sessionOutcomes.state}
                  WHEN 'merged' THEN ${sessionOutcomes.mergedAt}
                  WHEN 'closed' THEN ${sessionOutcomes.closedAt} END,
                ${sessionOutcomes.stateChangedAt}) >= ${since}`,
          ),
        )
        .orderBy(asc(sessionOutcomes.createdAt), asc(sessionOutcomes.id));
      const [conversation] = await db
        .select({ id: turns.id })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, judgment.sessionId),
            sql`${turns.endedAt} >= ${since}`,
          ),
        )
        .limit(1);
      const checkpointsSince = await db
        .select({
          revision: checkpoints.revision,
          manifestRef: checkpoints.manifestRef,
        })
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.sessionId, judgment.sessionId),
            sql`${checkpoints.committedAt} >= ${since}`,
          ),
        );
      const settings = judgeSettingsOf(session.settings);
      const [called] = await db
        .select({ count: count() })
        .from(achievementJudgments)
        .where(
          and(
            eq(achievementJudgments.sessionId, judgment.sessionId),
            ne(achievementJudgments.id, judgment.id),
            gt(achievementJudgments.calls, 0),
          ),
        );
      const [last] = await db
        .select({ inputDigest: achievementJudgments.inputDigest })
        .from(achievementJudgments)
        .where(
          and(
            eq(achievementJudgments.sessionId, judgment.sessionId),
            ne(achievementJudgments.id, judgment.id),
            eq(achievementJudgments.status, "succeeded"),
            isNotNull(achievementJudgments.inputDigest),
          ),
        )
        .orderBy(
          desc(achievementJudgments.finishedAt),
          desc(achievementJudgments.id),
        )
        .limit(1);
      return {
        session: {
          id: session.id,
          title: session.title,
          agentId,
          agentReleaseId: session.agentReleaseId,
        },
        judge: {
          connectionId: settings.connection_id,
          dailyBudgetUsd: settings.daily_budget_usd,
          maxPerSession: settings.max_per_session,
          ...(await spentToday(db, session.workspaceId)),
          sessionJudgments: called?.count ?? 0,
          threshold: settings.threshold,
          transcript: settings.transcript,
          lastInputDigest: last?.inputDigest ?? null,
        },
        rules: rules.map((rule) => ({
          ...rule,
          evidenceKind: rule.evidenceKind as AchievementEvidenceKind,
          judge: rule.judge as AchievementRuleJudge,
        })),
        outcomes: outcomes.flatMap((row) => {
          const evidence = outcomeEvidenceOf(row);
          return evidence === null ? [] : [evidence];
        }),
        since: {
          at,
          conversation: conversation !== undefined,
          // Never an empty directory: it would take every key as new.
          checkpoints: checkpointsSince.flatMap(({ revision, manifestRef }) => {
            const end = manifestRef.lastIndexOf("/");
            return end <= 0
              ? []
              : [{ revision, directory: manifestRef.slice(0, end + 1) }];
          }),
        },
      };
    },

    async renew(judgment, leaseMs) {
      const renewed = await db
        .update(achievementJudgments)
        .set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        })
        .where(
          and(
            eq(achievementJudgments.id, judgment.id),
            eq(achievementJudgments.leaseToken, judgment.leaseToken),
            eq(achievementJudgments.status, "running"),
          ),
        )
        .returning({ id: achievementJudgments.id });
      return renewed.length > 0;
    },

    async transcript(sessionId, limit, since) {
      // The person's message and the engine's final answer; tool calls and
      // their results live in events and are never read here.
      const rows = await db
        .select({
          sequence: turns.sequence,
          message: turns.message,
          resultJson: turns.resultJson,
        })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, sessionId),
            sql`${turns.endedAt} >= ${since}::timestamptz`,
          ),
        )
        .orderBy(desc(turns.sequence))
        .limit(limit);
      return rows.reverse().map((row) => ({
        sequence: row.sequence,
        message: row.message,
        result: resultTextOf(row.resultJson),
      }));
    },

    finish(judgment, judged) {
      return db.transaction(async (tx) => {
        // Before any judgment or achievement row, as queueAchievementJudgment.
        await tx.execute(
          sql`SELECT 1 FROM sessions WHERE id = ${judgment.sessionId} FOR KEY SHARE`,
        );
        // Then the decision models, as queueAchievementJudgment: evidence
        // read in a window that ended or restarted since counts for nothing.
        const [window] =
          judged.since === undefined
            ? [{ same: true }]
            : rowsOf<{ same: boolean | null }>(
                await tx.execute(
                  sql`SELECT ${JUDGING_SINCE} = ${judged.since}::timestamptz AS same`,
                ),
              );
        const result: JudgmentResult =
          window?.same === true
            ? judged
            : {
                status: "skipped",
                errorCode: "judge_unavailable",
                rules: judged.rules,
                evidenceIds: judged.evidenceIds,
                achievements: [],
              };
        const [held] = await tx
          .select({
            workspaceId: achievementJudgments.workspaceId,
            ownerId: achievementJudgments.ownerId,
            sessionId: achievementJudgments.sessionId,
          })
          .from(achievementJudgments)
          .where(
            and(
              eq(achievementJudgments.id, judgment.id),
              eq(achievementJudgments.leaseToken, judgment.leaseToken),
              eq(achievementJudgments.status, "running"),
            ),
          )
          .for("update");
        if (!held) return false;
        const done = {
          errorCode: result.errorCode,
          rules: result.rules,
          evidenceIds: result.evidenceIds,
          leaseToken: null,
          leaseExpiresAt: null,
          tokenHash: null,
          ...(result.luna === undefined
            ? {}
            : {
                inputDigest: result.luna.inputDigest,
                backend: "luna",
                connectionId: result.luna.connectionId,
              }),
          ...(result.threshold === undefined
            ? {}
            : { threshold: result.threshold }),
        };
        const self = eq(achievementJudgments.id, judgment.id);
        // A session has one pending judgment, and a newer trigger's judges
        // everything this one would. It waits for the retry too; a deferral
        // leaves it as it is, to count its always pairs after its own quiet
        // time and defer its luna pairs itself.
        const pending = and(
          eq(achievementJudgments.sessionId, held.sessionId),
          inArray(
            achievementJudgments.status,
            PENDING_ACHIEVEMENT_JUDGMENT_STATUSES,
          ),
        );
        const fold = async (at: SQL, deferred: boolean) => {
          const [other] = deferred
            ? await tx
                .select({ id: achievementJudgments.id })
                .from(achievementJudgments)
                .where(pending)
            : await tx
                .update(achievementJudgments)
                .set({
                  nextAttemptAt: sql`GREATEST(${achievementJudgments.nextAttemptAt}, ${at})`,
                })
                .where(pending)
                .returning({ id: achievementJudgments.id });
          return other !== undefined;
        };
        const end = (status: "succeeded" | "skipped" | "failed") =>
          tx
            .update(achievementJudgments)
            .set({ ...done, status, finishedAt: sql`now()` })
            .where(self);
        if (result.status !== "queued" && result.status !== "deferred") {
          await end(result.status);
        } else {
          const deferred = result.status === "deferred";
          const at =
            result.status === "deferred"
              ? sql`${result.until.toISOString()}::timestamptz`
              : sql`clock_timestamp() + make_interval(secs => ${result.retryInMs / 1000})`;
          let requeued = false;
          if (!(await fold(at, deferred))) {
            // A trigger committing meanwhile takes the pending slot first.
            requeued = await tx
              .transaction(async (savepoint) => {
                await savepoint
                  .update(achievementJudgments)
                  .set({
                    ...done,
                    status: result.status,
                    nextAttemptAt: at,
                    // A day's wait is not a failed try.
                    ...(deferred ? { attempts: 0 } : {}),
                  })
                  .where(self);
                return true;
              })
              .catch((error: unknown) => {
                if (findPgError(error, "23505")) return false;
                throw error;
              });
            if (!requeued) await fold(at, deferred);
          }
          if (!requeued) await end("failed");
        }
        for (const { ruleFamilyId, evidenceId } of result.luna?.declined ??
          []) {
          // The answer changed: the earlier row is taken down, never
          // rewritten, and a person's confirmation or rejection stands. One
          // counted in an earlier window was judged on evidence this one
          // leaves out, so it stands too.
          await tx
            .update(sessionAchievements)
            .set({ supersededAt: sql`now()`, supersededBy: judgment.id })
            .where(
              and(
                eq(sessionAchievements.sessionId, held.sessionId),
                eq(sessionAchievements.ruleFamilyId, ruleFamilyId),
                evidenceId === null
                  ? isNull(sessionAchievements.evidenceId)
                  : eq(sessionAchievements.evidenceId, evidenceId),
                isNull(sessionAchievements.supersededAt),
                sql`${sessionAchievements.createdAt} >= ${result.since ?? null}::timestamptz`,
                inArray(sessionAchievements.reviewState, [
                  "auto",
                  "needs_review",
                ]),
              ),
            );
        }
        if (result.achievements.length > 0) {
          // A family's achievement for the evidence stays as it is, and so
          // does whatever a person decided about it.
          await tx
            .insert(sessionAchievements)
            .values(
              result.achievements.map((achievement) => ({
                id: randomUUID(),
                workspaceId: held.workspaceId,
                ownerId: held.ownerId,
                sessionId: held.sessionId,
                agentId: achievement.agentId,
                agentReleaseId: achievement.agentReleaseId,
                ruleId: achievement.ruleId,
                ruleFamilyId: achievement.ruleFamilyId,
                typeId: achievement.typeId,
                title: achievement.title,
                link: achievement.link,
                evidenceKind: achievement.evidenceKind,
                evidenceId: achievement.evidenceId,
                payload: achievement.payload,
                judge: achievement.judge,
                probability: achievement.probability,
                judgmentId: judgment.id,
                reviewState: achievement.reviewState,
              })),
            )
            .onConflictDoNothing();
        }
        return true;
      });
    },

    rejudge({ actor, sessionId, receiptId }) {
      return db.transaction(async (tx) => {
        if (!(await managing(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, actor.principal.ownerId),
              eq(sessions.workspaceId, actor.workspaceId),
            ),
          )
          .limit(1);
        if (!session) return { outcome: "not_found" as const };
        const judgmentId = await queueAchievementJudgment(tx, sessionId, {
          trigger: "manual",
        });
        if (judgmentId === null) return { outcome: "not_found" as const };
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: actor.principal.ownerId,
          actor: receiptActorOf(actor.principal),
          operation: "rejudge_session",
          targetRef: { session_id: sessionId, turn_id: null, request_id: null },
          result: { judgment_id: judgmentId },
          status: "succeeded",
          requestId: actor.principal.requestId ?? null,
        });
        return { outcome: "queued" as const, judgmentId };
      });
    },

    async list(ownerId, rawSessionId) {
      const sessionId = rawSessionId.toLowerCase();
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
        .limit(1);
      if (!session) return null;
      const items = await achievementsWhere(
        db,
        and(
          eq(sessionAchievements.sessionId, sessionId),
          isNull(sessionAchievements.supersededAt),
        ),
      );
      const [latest] = await db
        .select()
        .from(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, sessionId))
        .orderBy(
          desc(achievementJudgments.createdAt),
          desc(achievementJudgments.id),
        )
        .limit(1);
      const [spent] = await db
        .select({
          finished: count(achievementJudgments.finishedAt),
          usd: sql<string>`COALESCE(sum(${achievementJudgments.costUsd}), 0)`,
        })
        .from(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, sessionId));
      return {
        items: items.map(achievementOf),
        judgment: latest
          ? judgmentOf(latest, await evidenceChangeOf(db, latest))
          : null,
        judgment_count: spent?.finished ?? 0,
        judge_cost_usd: Number(spent?.usd ?? 0),
      };
    },

    async find(ownerId, achievementId) {
      const [found] = await db
        .select({
          sessionId: sessionAchievements.sessionId,
          agentId: sessionAchievements.agentId,
        })
        .from(sessionAchievements)
        .where(
          and(
            eq(sessionAchievements.id, achievementId),
            eq(sessionAchievements.ownerId, ownerId),
            isNull(sessionAchievements.supersededAt),
          ),
        )
        .limit(1);
      return found ?? null;
    },

    review({ actor, achievementId, action, note, receiptId }) {
      return db.transaction(async (tx) => {
        const [me] = await lockPeople(tx, actor.workspaceId, [actor.userId]);
        if (me?.live !== true) return { outcome: "actor_inactive" as const };
        const current = and(
          eq(sessionAchievements.id, achievementId),
          eq(sessionAchievements.ownerId, actor.principal.ownerId),
          eq(sessionAchievements.workspaceId, actor.workspaceId),
          isNull(sessionAchievements.supersededAt),
        );
        const [target] = await tx
          .select({
            sessionId: sessionAchievements.sessionId,
            agentId: sessionAchievements.agentId,
          })
          .from(sessionAchievements)
          .where(current)
          .limit(1);
        if (!target) return { outcome: "not_found" as const };
        // The share may have narrowed since the service's session.read:
        // check it again under the session row (requester-locks.ts order).
        const [session] = await tx
          .select({
            id: sessions.id,
            workspaceId: sessions.workspaceId,
            createdByUserId: sessions.createdByUserId,
            createdByApiKeyId: sessions.createdByApiKeyId,
            agentReleaseId: sessions.agentReleaseId,
          })
          .from(sessions)
          .where(eq(sessions.id, target.sessionId))
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" as const };
        const reviewers: readonly string[] =
          MANAGEMENT_ROLES["achievement.review"] ?? [];
        if (
          !reviewers.includes(me.role) &&
          (target.agentId === null ||
            !(await lockedAdministers(
              tx,
              actor.workspaceId,
              target.agentId,
              actor.userId,
            )))
        ) {
          return { outcome: "actor_inactive" as const };
        }
        const reach = await lockSessionReach(
          tx,
          {
            userId: actor.userId,
            apiKeyId: null,
            role: me.role as WorkspaceRole,
            keyAgentId: null,
            slackBotUserId: null,
          },
          session,
        );
        if (reach !== "ok") return { outcome: "not_found" as const };
        const [found] = await tx
          .select()
          .from(sessionAchievements)
          .where(current)
          .for("update");
        if (!found) return { outcome: "not_found" as const };
        const from =
          action === "confirm" ? ["needs_review"] : ["auto", "needs_review"];
        if (!from.includes(found.reviewState)) {
          return { outcome: "not_reviewable" as const };
        }
        const reviewState = action === "confirm" ? "confirmed" : "rejected";
        await tx
          .update(sessionAchievements)
          .set({
            reviewState,
            reviewedBy: actor.userId,
            reviewedAt: sql`now()`,
            reviewNote: note,
          })
          .where(eq(sessionAchievements.id, found.id));
        // The note is the reviewer's words; the receipt names the resulting state.
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: actor.principal.ownerId,
          actor: receiptActorOf(actor.principal),
          operation: "review_achievement",
          targetRef: {
            session_id: found.sessionId,
            turn_id: null,
            request_id: null,
          },
          result: { achievement_id: found.id, review_state: reviewState },
          status: "succeeded",
          requestId: actor.principal.requestId ?? null,
        });
        const [reviewed] = await achievementsWhere(
          tx,
          eq(sessionAchievements.id, found.id),
        );
        if (!reviewed) throw new Error("reviewed achievement vanished");
        return {
          outcome: "reviewed" as const,
          achievement: achievementOf(reviewed),
        };
      });
    },
  };
}

/** The judgment egress token and its ledger. */
export function createPostgresJudgmentEgress(
  db: Database,
): JudgmentEgressStore {
  return {
    async issueToken(judgment, tokenHash) {
      const issued = await db
        .update(achievementJudgments)
        .set({ tokenHash })
        .where(
          and(
            eq(achievementJudgments.id, judgment.id),
            eq(achievementJudgments.leaseToken, judgment.leaseToken),
            eq(achievementJudgments.status, "running"),
            sql`${achievementJudgments.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: achievementJudgments.id });
      return issued.length > 0;
    },

    async authorizeToken({ tokenHash }) {
      const [held] = await db
        .select({
          id: achievementJudgments.id,
          workspaceId: achievementJudgments.workspaceId,
          settings: workspaces.settings,
        })
        .from(achievementJudgments)
        .innerJoin(
          workspaces,
          eq(workspaces.id, achievementJudgments.workspaceId),
        )
        .where(
          and(
            eq(achievementJudgments.tokenHash, tokenHash),
            eq(achievementJudgments.status, "running"),
            sql`${achievementJudgments.leaseExpiresAt} > now()`,
          ),
        )
        .limit(1);
      if (!held) return { outcome: "invalid_token" };
      const settings = judgeSettingsOf(held.settings);
      return {
        outcome: "ok",
        judgmentId: held.id,
        connectionId: settings.connection_id,
        dailyBudgetUsd: settings.daily_budget_usd,
        spentUsd: (await spentToday(db, held.workspaceId)).spentUsd,
      };
    },

    recordUsage({ exchangeId, judgmentId, inputTokens, costUsd }) {
      return db.transaction(async (tx) => {
        const [judgment] = await tx
          .select({
            sessionId: achievementJudgments.sessionId,
            workspaceId: achievementJudgments.workspaceId,
          })
          .from(achievementJudgments)
          .where(eq(achievementJudgments.id, judgmentId))
          .limit(1);
        if (!judgment) return { outcome: "unknown_judgment" as const };
        // Before the judgment row, as queueAchievementJudgment.
        await tx.execute(
          sql`SELECT 1 FROM sessions WHERE id = ${judgment.sessionId} FOR KEY SHARE`,
        );
        // Whole micro-dollars, rounded up like a session's spend.
        const [inserted] = await tx
          .insert(achievementJudgmentUsage)
          .values({
            exchangeId,
            judgmentId,
            workspaceId: judgment.workspaceId,
            inputTokens,
            costUsd: sql`ceil(${costUsd}::numeric * 1000000) / 1000000`,
          })
          .onConflictDoNothing({ target: achievementJudgmentUsage.exchangeId })
          .returning({ costUsd: achievementJudgmentUsage.costUsd });
        if (inserted === undefined) {
          // The proxy reports an exchange again when no answer came back.
          const [stored] = await tx
            .select({
              judgmentId: achievementJudgmentUsage.judgmentId,
              inputTokens: achievementJudgmentUsage.inputTokens,
              costUsd: achievementJudgmentUsage.costUsd,
            })
            .from(achievementJudgmentUsage)
            .where(eq(achievementJudgmentUsage.exchangeId, exchangeId));
          return stored?.judgmentId === judgmentId &&
            stored.inputTokens === inputTokens
            ? { outcome: "replayed" as const, costUsd: stored.costUsd }
            : { outcome: "conflict" as const };
        }
        await tx
          .update(achievementJudgments)
          .set({
            calls: sql`${achievementJudgments.calls} + 1`,
            inputTokens: sql`${achievementJudgments.inputTokens} + ${inputTokens}`,
            costUsd: sql`${achievementJudgments.costUsd} + ${inserted.costUsd}::numeric`,
          })
          .where(eq(achievementJudgments.id, judgmentId));
        return { outcome: "recorded" as const, costUsd: inserted.costUsd };
      });
    },
  };
}
