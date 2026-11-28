import { z } from "zod";
import { instructionsCommitSchema } from "../agents/agents.ts";
import { m1JudgmentsPerHourSchema } from "../agents/surfaces.ts";
import {
  conversationJudgmentIdSchema,
  JUDGMENT_ANSWER_VALUES,
  JUDGMENT_GRADE_VALUES,
  JUDGMENT_OUTCOME_VALUES,
  JUDGMENT_REASON_VALUES,
  M1_DECISION_VALUES,
} from "../domain/conversation.ts";
import { timestampSchema } from "../shared/index.ts";

// What an agent's admins see of M1's shadow judgments in its Slack channels
// (a1/S3): counts, codes, and where each judged message is, never its text.

/** The days the counts and the list cover, up to the request. */
export const SLACK_JUDGMENT_WINDOW_DAYS = 7;
export const SLACK_JUDGMENT_RECENT_LIMIT = 50;

const slackIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const slackTsSchema = z.string().regex(/^\d{1,20}\.\d{1,10}$/);

/** A Slack message's link, made from its channel and ts when shown. */
export function slackMessageUrl(channelId: string, ts: string): string {
  return `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

export const slackJudgmentChannelSchema = z
  .object({
    slack_team_id: slackIdSchema,
    channel_id: slackIdSchema,
    /** As the channel's live binding records it; null when none does. */
    channel_kind: z.enum(["public_channel", "private_channel"]).nullable(),
    /** The live binding's cap; null when the channel has no live binding. */
    m1_judgments_per_hour: m1JudgmentsPerHourSchema.nullable(),
    /** Every judgment with a result, whatever it was. */
    judgments: z.number().int().nonnegative(),
    /** Of those, the ones M1 judged `speak`. */
    speak: z.number().int().nonnegative(),
    /** How many of the judgments had each reason, most first. */
    reasons: z.array(
      z
        .object({
          reason: z.enum(JUDGMENT_REASON_VALUES),
          count: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const slackJudgmentItemSchema = z
  .object({
    id: conversationJudgmentIdSchema,
    grade: z.enum(JUDGMENT_GRADE_VALUES),
    slack_team_id: slackIdSchema,
    channel_id: slackIdSchema,
    /** The newest message the judgment read. */
    ts: slackTsSchema,
    /** That message in Slack; its text is read there. */
    url: z.string().url(),
    outcome: z.enum(JUDGMENT_OUTCOME_VALUES),
    decision: z.enum(M1_DECISION_VALUES),
    reason: z.enum(JUDGMENT_REASON_VALUES),
    /** What became of a judgment that spoke; null when nothing did. */
    answer: z.enum(JUDGMENT_ANSWER_VALUES).nullable(),
    judged_at: timestampSchema,
  })
  .strict();

/**
 * Narrows `recent` to the judgments with this reason and, or, this answer.
 * The per-channel counts stay whole, so they still say what the list was cut
 * from.
 */
export const getSlackJudgmentsQuerySchema = z
  .object({
    reason: z.enum(JUDGMENT_REASON_VALUES).optional(),
    answer: z.enum(JUDGMENT_ANSWER_VALUES).optional(),
  })
  .strict();

/**
 * The agent's judged records of the last SLACK_JUDGMENT_WINDOW_DAYS days:
 * per channel counts, and the newest SLACK_JUDGMENT_RECENT_LIMIT. Private
 * channels are in both; a reader needs only judgment.read.
 */
export const getSlackJudgmentsResponseSchema = z
  .object({
    window_days: z.literal(SLACK_JUDGMENT_WINDOW_DAYS),
    since: timestampSchema,
    channels: z.array(slackJudgmentChannelSchema),
    recent: z.array(slackJudgmentItemSchema).max(SLACK_JUDGMENT_RECENT_LIMIT),
  })
  .strict();

/**
 * The commit the active release's repository branch is at now, against the
 * commit its instruction snapshot was taken at. `unread` when there is
 * nothing to compare: no active release, a snapshot with no commit, a
 * repository not on GitHub (or no App reaches it), or the branch gone.
 */
export const getSlackInstructionsHeadResponseSchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("read"),
        commit: instructionsCommitSchema,
        /** The branch has moved past the snapshot's commit. */
        newer: z.boolean(),
      })
      .strict(),
    z
      .object({
        state: z.literal("unread"),
        reason: z.enum([
          "no_release",
          "no_commit",
          "not_on_github",
          "branch_missing",
        ]),
      })
      .strict(),
  ],
);

export type GetSlackInstructionsHeadResponse = z.infer<
  typeof getSlackInstructionsHeadResponseSchema
>;
export type SlackJudgmentChannel = z.infer<typeof slackJudgmentChannelSchema>;
export type SlackJudgmentItem = z.infer<typeof slackJudgmentItemSchema>;
export type GetSlackJudgmentsQuery = z.infer<
  typeof getSlackJudgmentsQuerySchema
>;
export type GetSlackJudgmentsResponse = z.infer<
  typeof getSlackJudgmentsResponseSchema
>;
