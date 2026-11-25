import {
  JUDGMENT_REASON_VALUES,
  type JudgmentReason,
  type JudgmentRecordReason,
} from "@werft-ai/contracts";
import type {
  JudgmentReviewItem,
  JudgmentReviewStore,
  JudgmentTallyRow,
} from "@werft-ai/platform";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { dbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { conversationJudgments, surfaceBindings } from "../schema.ts";

// A voided record (a1/J6) has no result to show: its decision went with the
// message it read.
const resultReason = (
  reason: JudgmentRecordReason | null,
): reason is JudgmentReason =>
  reason !== null &&
  (JUDGMENT_REASON_VALUES as readonly string[]).includes(reason);

/** M1's judged records for the agent's admins: codes, ids and Slack ts. */
export function createPostgresJudgmentReviewStore(
  db: Database,
): JudgmentReviewStore {
  const judged = (input: {
    workspaceId: string;
    agentId: string;
    since: Date;
  }) =>
    and(
      eq(conversationJudgments.workspaceId, input.workspaceId),
      eq(conversationJudgments.agentId, input.agentId),
      isNotNull(conversationJudgments.outcome),
      ne(conversationJudgments.outcome, "voided"),
      gt(conversationJudgments.judgedAt, input.since),
    );

  return {
    now: () => dbNow(db),

    async tallies(input) {
      const counted = await db
        .select({
          teamId: conversationJudgments.slackTeamId,
          channelId: conversationJudgments.slackChannelId,
          reason: conversationJudgments.reason,
          decision: conversationJudgments.decision,
          count: sql<number>`count(*)::int`,
        })
        .from(conversationJudgments)
        .where(judged(input))
        .groupBy(
          conversationJudgments.slackTeamId,
          conversationJudgments.slackChannelId,
          conversationJudgments.reason,
          conversationJudgments.decision,
        );
      const channelIds = [...new Set(counted.map((row) => row.channelId))];
      const bindings =
        channelIds.length === 0
          ? []
          : await db
              .select({
                channelId: surfaceBindings.externalSurfaceId,
                kind: surfaceBindings.surfaceKind,
                cap: surfaceBindings.m1JudgmentsPerHour,
              })
              .from(surfaceBindings)
              .where(
                and(
                  eq(surfaceBindings.workspaceId, input.workspaceId),
                  eq(surfaceBindings.agentId, input.agentId),
                  eq(surfaceBindings.surface, "slack"),
                  isNull(surfaceBindings.revokedAt),
                  inArray(surfaceBindings.externalSurfaceId, channelIds),
                ),
              )
              // The cap reads the newest live binding of a channel; so does this.
              .orderBy(desc(surfaceBindings.createdAt));
      const live = new Map<
        string,
        { kind: JudgmentTallyRow["channelKind"]; cap: number }
      >();
      for (const binding of bindings) {
        if (binding.channelId !== null && !live.has(binding.channelId)) {
          live.set(binding.channelId, { kind: binding.kind, cap: binding.cap });
        }
      }
      const rows: JudgmentTallyRow[] = [];
      for (const row of counted) {
        // A judged record always has both (conversation_judgments_verdict_check).
        if (!resultReason(row.reason) || row.decision === null) continue;
        const binding = live.get(row.channelId);
        rows.push({
          teamId: row.teamId,
          channelId: row.channelId,
          channelKind: binding?.kind ?? null,
          m1JudgmentsPerHour: binding?.cap ?? null,
          reason: row.reason,
          decision: row.decision,
          count: Number(row.count),
        });
      }
      return rows;
    },

    async recent(input) {
      if (input.channels.length === 0) return [];
      const rows = await db
        .select({
          id: conversationJudgments.id,
          grade: conversationJudgments.grade,
          teamId: conversationJudgments.slackTeamId,
          channelId: conversationJudgments.slackChannelId,
          ts: sql<string>`${conversationJudgments.refs}[cardinality(${conversationJudgments.refs})]`,
          outcome: conversationJudgments.outcome,
          decision: conversationJudgments.decision,
          reason: conversationJudgments.reason,
          judgedAt: conversationJudgments.judgedAt,
        })
        .from(conversationJudgments)
        .where(
          and(
            judged(input),
            or(
              ...input.channels.map((channel) =>
                and(
                  eq(conversationJudgments.slackTeamId, channel.teamId),
                  eq(conversationJudgments.slackChannelId, channel.channelId),
                ),
              ),
            ),
          ),
        )
        .orderBy(
          desc(conversationJudgments.judgedAt),
          desc(conversationJudgments.id),
        )
        .limit(input.limit);
      const items: JudgmentReviewItem[] = [];
      for (const row of rows) {
        if (
          row.outcome === null ||
          row.outcome === "voided" ||
          row.decision === null ||
          !resultReason(row.reason) ||
          row.judgedAt === null
        ) {
          continue;
        }
        items.push({
          id: row.id,
          grade: row.grade,
          teamId: row.teamId,
          channelId: row.channelId,
          ts: row.ts,
          outcome: row.outcome,
          decision: row.decision,
          reason: row.reason,
          judgedAt: row.judgedAt,
        });
      }
      return items;
    },
  };
}
