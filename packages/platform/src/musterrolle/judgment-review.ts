import {
  type ConversationJudgmentId,
  type GetSlackJudgmentsResponse,
  type JudgmentGrade,
  type JudgmentOutcome,
  type JudgmentReason,
  type M1Decision,
  SLACK_JUDGMENT_RECENT_LIMIT,
  SLACK_JUDGMENT_WINDOW_DAYS,
  type SlackJudgmentChannel,
  slackMessageUrl,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";

/** One channel's judged records of the window, a row per reason and decision. */
export type JudgmentTallyRow = {
  teamId: string;
  channelId: string;
  /** The live binding's; null when the channel has none. */
  channelKind: "public_channel" | "private_channel" | "dm" | null;
  m1JudgmentsPerHour: number | null;
  reason: JudgmentReason;
  decision: M1Decision;
  count: number;
};

export type JudgmentReviewItem = {
  id: ConversationJudgmentId;
  grade: JudgmentGrade;
  teamId: string;
  channelId: string;
  ts: string;
  outcome: JudgmentOutcome;
  decision: M1Decision;
  reason: JudgmentReason;
  judgedAt: Date;
};

/** M1's judgment records as an agent's admins read them; codes only. */
export interface JudgmentReviewStore {
  /** The database's clock. */
  now(): Promise<Date>;
  tallies(input: {
    workspaceId: string;
    agentId: string;
    since: Date;
  }): Promise<JudgmentTallyRow[]>;
  /** Newest first, of the channels named only. */
  recent(input: {
    workspaceId: string;
    agentId: string;
    since: Date;
    channels: readonly { teamId: string; channelId: string }[];
    limit: number;
  }): Promise<JudgmentReviewItem[]>;
}

const DAY_MS = 86_400_000;
const channelKey = (teamId: string, channelId: string) =>
  `${teamId}:${channelId}`;

/**
 * Who sees M1's shadow records (a1/S3, Architect Q15): owners, admins and
 * the agent's admins, every channel's, a private channel's included. Codes
 * and links only; no message text is stored here to show.
 */
export function createJudgmentReviewService(deps: {
  authorization: AuthorizationPolicy;
  store: JudgmentReviewStore;
}) {
  const { authorization, store } = deps;
  return {
    async getSlackJudgments(
      caller: Caller,
      agentId: string,
    ): Promise<GetSlackJudgmentsResponse> {
      await requirePermitted(authorization, caller, "judgment.read", {
        kind: "agent",
        id: agentId,
      });
      const workspaceId = caller.ownerId;
      const since = new Date(
        (await store.now()).getTime() - SLACK_JUDGMENT_WINDOW_DAYS * DAY_MS,
      );
      const rows = await store.tallies({ workspaceId, agentId, since });
      const byChannel = new Map<string, SlackJudgmentChannel>();
      for (const row of rows) {
        const key = channelKey(row.teamId, row.channelId);
        let channel = byChannel.get(key);
        if (channel === undefined) {
          channel = {
            slack_team_id: row.teamId,
            channel_id: row.channelId,
            channel_kind:
              row.channelKind === "public_channel" ||
              row.channelKind === "private_channel"
                ? row.channelKind
                : null,
            m1_judgments_per_hour: row.m1JudgmentsPerHour,
            judgments: 0,
            speak: 0,
            reasons: [],
          };
          byChannel.set(key, channel);
        }
        channel.judgments += row.count;
        if (row.decision === "speak") channel.speak += row.count;
        const reason = channel.reasons.find((r) => r.reason === row.reason);
        if (reason) reason.count += row.count;
        else channel.reasons.push({ reason: row.reason, count: row.count });
      }
      const visible = [...byChannel.values()];
      for (const channel of visible) {
        channel.reasons.sort(
          (a, b) => b.count - a.count || a.reason.localeCompare(b.reason),
        );
      }
      visible.sort(
        (a, b) =>
          b.judgments - a.judgments || a.channel_id.localeCompare(b.channel_id),
      );
      const recent =
        visible.length === 0
          ? []
          : await store.recent({
              workspaceId,
              agentId,
              since,
              channels: visible.map((channel) => ({
                teamId: channel.slack_team_id,
                channelId: channel.channel_id,
              })),
              limit: SLACK_JUDGMENT_RECENT_LIMIT,
            });
      return {
        window_days: SLACK_JUDGMENT_WINDOW_DAYS,
        since: since.toISOString(),
        channels: visible,
        recent: recent.map((item) => ({
          id: item.id,
          grade: item.grade,
          slack_team_id: item.teamId,
          channel_id: item.channelId,
          ts: item.ts,
          url: slackMessageUrl(item.channelId, item.ts),
          outcome: item.outcome,
          decision: item.decision,
          reason: item.reason,
          judged_at: item.judgedAt.toISOString(),
        })),
      };
    },
  };
}

export type JudgmentReviewService = ReturnType<
  typeof createJudgmentReviewService
>;
