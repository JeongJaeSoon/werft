import { z } from "zod";

import {
  agentIdSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const conversationIdSchema = z.uuid().brand<"ConversationId">();
export type ConversationId = z.infer<typeof conversationIdSchema>;
export const channelContextIdSchema = z.uuid().brand<"ChannelContextId">();
export type ChannelContextId = z.infer<typeof channelContextIdSchema>;
export const conversationTopicIdSchema = z
  .uuid()
  .brand<"ConversationTopicId">();
export type ConversationTopicId = z.infer<typeof conversationTopicIdSchema>;
export const conversationInputIdSchema = z
  .uuid()
  .brand<"ConversationInputId">();
export type ConversationInputId = z.infer<typeof conversationInputIdSchema>;
/** One judgment batch: buffered messages of a channel judged together. */
export const judgmentBatchIdSchema = z.uuid().brand<"JudgmentBatchId">();
export type JudgmentBatchId = z.infer<typeof judgmentBatchIdSchema>;
/**
 * A new value for each request that posts a web input's Slack mirror, sent
 * in the post's message metadata, so the post Slack sends back names the one
 * request that made it. Two posts of the same text are told apart by it.
 */
export const slackMirrorCorrelationIdSchema = z
  .uuid()
  .brand<"SlackMirrorCorrelationId">();
export type SlackMirrorCorrelationId = z.infer<
  typeof slackMirrorCorrelationIdSchema
>;
/** The message metadata `event_type` of a web input's Slack mirror. */
export const SLACK_INPUT_MIRROR_EVENT_TYPE = "werft_input_mirror";
export const channelSummaryLineIdSchema = z
  .uuid()
  .brand<"ChannelSummaryLineId">();
export type ChannelSummaryLineId = z.infer<typeof channelSummaryLineIdSchema>;

/** Most characters one channel summary line holds; the DB checks the same. */
export const CHANNEL_SUMMARY_LINE_TEXT_MAX = 2000;

/**
 * The key a web client gives an input so a retry finds it again: unique per
 * agent and person, with no expiry. The DB checks the same pattern.
 */
export const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const clientMessageIdSchema = z
  .string()
  .regex(CLIENT_MESSAGE_ID_PATTERN)
  .brand<"ClientMessageId">();
export type ClientMessageId = z.infer<typeof clientMessageIdSchema>;

/**
 * Whether Slack is to mirror a web input: `not_target` when the person has
 * no Slack account linked, which only a DM input can be, since a channel
 * input from such a person is refused; `pending` until Slack places it;
 * `unconfirmed` when its post may or may not be in Slack (the send went
 * `uncertain`), or the rows held for its thread waited past their limit. A
 * person may send it again; nothing sends it again on its own.
 */
export const CONVERSATION_INPUT_SLACK_MIRROR_VALUES = [
  "not_target",
  "pending",
  "unconfirmed",
] as const;
export const conversationInputSlackMirrorSchema = z.enum(
  CONVERSATION_INPUT_SLACK_MIRROR_VALUES,
);
export type ConversationInputSlackMirror = z.infer<
  typeof conversationInputSlackMirrorSchema
>;

/**
 * How an agent took part in a Slack message, as its engagement row says:
 * `mention` opened a session by calling the agent (a DM calls it too),
 * `reply` opened one unmentioned, `bound` went into a session already open
 * (mentioned or not), `proactive` is the agent speaking first, which nothing
 * writes yet.
 */
export const ENGAGEMENT_KIND_VALUES = [
  "mention",
  "reply",
  "bound",
  "proactive",
] as const;
export const engagementKindSchema = z.enum(ENGAGEMENT_KIND_VALUES);
export type EngagementKind = z.infer<typeof engagementKindSchema>;

/**
 * What wrote a conversation turn's row: `web_input` is a web input's, made
 * when it was taken to hold its text, `received` with no decision until a
 * turn runs on it; `m2` is a turn the conversation runtime ran. A count of
 * turns or judgments leaves the `received` ones out.
 */
export const CONVERSATION_TURN_ORIGIN_VALUES = ["web_input", "m2"] as const;
export type ConversationTurnOrigin =
  (typeof CONVERSATION_TURN_ORIGIN_VALUES)[number];

/**
 * Where a conversation turn's row is: `running` until it ends `decided`
 * (with one decision), `no_decision` (a limit or a failure ended it first)
 * or `voided_by_delete` (a message it read was deleted before its result was
 * written).
 */
export const CONVERSATION_TURN_STATE_VALUES = [
  "received",
  "running",
  "decided",
  "no_decision",
  "voided_by_delete",
] as const;
export type ConversationTurnState =
  (typeof CONVERSATION_TURN_STATE_VALUES)[number];

/**
 * Which of its limits ended a conversation turn: its provider calls, its
 * tool calls or its time.
 */
export const CONVERSATION_TURN_LIMIT_VALUES = [
  "model_call_limit",
  "tool_call_limit",
  "time_limit",
] as const;
export type ConversationTurnLimit =
  (typeof CONVERSATION_TURN_LIMIT_VALUES)[number];

/**
 * Who held a turn to its limit: the runtime's own count, or the server's
 * behind it, which a runtime that got past its count meets.
 */
export const CONVERSATION_TURN_LIMIT_SIDE_VALUES = [
  "runner",
  "server",
] as const;
export type ConversationTurnLimitSide =
  (typeof CONVERSATION_TURN_LIMIT_SIDE_VALUES)[number];

/** The one decision a conversation turn ends with. */
export const CONVERSATION_TURN_DECISION_VALUES = [
  "reply",
  "route_to_task",
  "spawn_task",
  "no_reply",
] as const;
export type ConversationTurnDecision =
  (typeof CONVERSATION_TURN_DECISION_VALUES)[number];

/** Most characters of a conversation turn's decision reason; the DB checks the same. */
export const CONVERSATION_TURN_REASON_MAX = 1000;

/**
 * Why a message carries a delete mark: Slack deleted it, or an admin deleted
 * the conversation records that held it while the message stays in Slack.
 * Every check treats both alike; a Slack delete replaces an admin's.
 */
export const DELETED_SOURCE_REASON_VALUES = [
  "slack_deleted",
  "admin_deleted",
] as const;
export type DeletedSourceReason = (typeof DELETED_SOURCE_REASON_VALUES)[number];

/**
 * An agent's main conversation: one per channel it is in, one per person it
 * talks to in DMs.
 */
export const CONVERSATION_KIND_VALUES = ["channel", "dm"] as const;
export const conversationKindSchema = z.enum(CONVERSATION_KIND_VALUES);
export type ConversationKind = z.infer<typeof conversationKindSchema>;

/**
 * What Slack last said of a channel conversation's channel. `deleted` is
 * final; `archived` goes back to `active` when the channel is unarchived. A
 * DM conversation stays `active`.
 */
export const CONVERSATION_CHANNEL_STATE_VALUES = [
  "active",
  "archived",
  "deleted",
] as const;
export const conversationChannelStateSchema = z.enum(
  CONVERSATION_CHANNEL_STATE_VALUES,
);
export type ConversationChannelState = z.infer<
  typeof conversationChannelStateSchema
>;

/** A Slack channel name as `channel_rename` carries it; the DB checks the length. */
export const SLACK_CHANNEL_NAME_MAX = 80;
export const slackChannelNameSchema = z
  .string()
  .min(1)
  .max(SLACK_CHANNEL_NAME_MAX)
  .refine((name) =>
    [...name].every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    }),
  );

/**
 * A Slack team or channel id. The scope key joins segments with ":", so a
 * segment holding one would let two scopes share a key. The DB checks the
 * same pattern.
 */
export const SLACK_SCOPE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const slackScopeSegmentSchema = z
  .string()
  .regex(SLACK_SCOPE_SEGMENT_PATTERN);
/** A Slack message ts: seconds, a dot, the fraction. */
export const SLACK_TS_PATTERN = /^[0-9]{1,20}\.[0-9]{1,20}$/;
export const slackTsSchema = z.string().regex(SLACK_TS_PATTERN);

/** What a piece of context may be read under. */
export const scopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("channel"),
    workspaceId: workspaceIdSchema,
    teamId: slackScopeSegmentSchema,
    channelId: slackScopeSegmentSchema,
  }),
  z.object({
    kind: z.literal("person"),
    workspaceId: workspaceIdSchema,
    userId: userIdSchema,
  }),
  z.object({
    kind: z.literal("agent"),
    workspaceId: workspaceIdSchema,
    agentId: agentIdSchema,
  }),
]);
export type Scope = z.infer<typeof scopeSchema>;

export const scopeKeySchema = z
  .string()
  .regex(
    /^(channel:[0-9a-f-]{36}:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}|person:[0-9a-f-]{36}:[0-9a-f-]{36}|agent:[0-9a-f-]{36}:[0-9a-f-]{36})$/,
  )
  .brand<"ScopeKey">();
/**
 * `channel:{W}:{T}:{C}` · `person:{W}:{U}` · `agent:{W}:{A}`. Every agent in
 * a channel reads the one channel key; U is a Werft user id, not Slack's.
 */
export type ScopeKey = z.infer<typeof scopeKeySchema>;

export function scopeKeyOf(input: Scope): ScopeKey {
  const scope = scopeSchema.parse(input);
  // Uuids may arrive in either case; one scope has one key.
  const w = scope.workspaceId.toLowerCase();
  const raw =
    scope.kind === "channel"
      ? `channel:${w}:${scope.teamId}:${scope.channelId}`
      : scope.kind === "person"
        ? `person:${w}:${scope.userId.toLowerCase()}`
        : `agent:${w}:${scope.agentId.toLowerCase()}`;
  return scopeKeySchema.parse(raw);
}

/** Where a main conversation is: a channel of a Slack team, or one person. */
export type ConversationPlace =
  | {
      kind: "channel";
      workspaceId: string;
      teamId: string;
      channelId: string;
    }
  | { kind: "dm"; workspaceId: string; personUserId: string };

/**
 * The scope a conversation reads: a channel conversation reads the channel's,
 * shared by every agent there; a DM reads the person's.
 */
export function conversationScopeKey(place: ConversationPlace): ScopeKey {
  return place.kind === "channel"
    ? scopeKeyOf(place)
    : scopeKeyOf({
        kind: "person",
        workspaceId: place.workspaceId,
        userId: place.personUserId,
      });
}

/** One M1 judgment's record: a batch's, or one unmentioned reply's. */
export const conversationJudgmentIdSchema = z
  .uuid()
  .brand<"ConversationJudgmentId">();
export type ConversationJudgmentId = z.infer<
  typeof conversationJudgmentIdSchema
>;

/**
 * What M1 judged: buffered messages in a batch (`buffer_m1`); one unmentioned
 * reply in a bound thread, its session not working (`m1`) or working
 * (`m1_to_task`); or one in a thread the agent took part in that has no
 * session (`m1_engaged`), which makes no turn.
 */
export const JUDGMENT_GRADE_VALUES = [
  "buffer_m1",
  "m1",
  "m1_to_task",
  "m1_engaged",
] as const;
export type JudgmentGrade = (typeof JUDGMENT_GRADE_VALUES)[number];

export const M1_DECISION_VALUES = ["speak", "quiet"] as const;
export type M1Decision = (typeof M1_DECISION_VALUES)[number];

/** The reasons the model picks one of. */
export const M1_MODEL_REASON_VALUES = [
  "not_for_agent",
  "human_conversation",
  "already_handled",
  "out_of_scope",
  "needs_agent",
  "unclear",
] as const;
export type M1ModelReason = (typeof M1_MODEL_REASON_VALUES)[number];

/** Why a judgment stopped before the model: it was never called. */
export const JUDGMENT_NOT_CALLED_REASON_VALUES = [
  "budget_refused",
  "concurrency_limited",
  "rate_limited",
  "input_too_large",
  "no_active_release",
  "model_unavailable",
] as const;
export type JudgmentNotCalledReason =
  (typeof JUDGMENT_NOT_CALLED_REASON_VALUES)[number];

/** Why a called judgment has no answer: silence, with this reason. */
export const JUDGMENT_FAILED_REASON_VALUES = [
  "timed_out",
  "unreachable",
  "provider_error",
  "malformed",
] as const;
export type JudgmentFailedReason =
  (typeof JUDGMENT_FAILED_REASON_VALUES)[number];

/**
 * Why a called judgment's result was thrown away (a1/J6): a message it read
 * was deleted, or edited, while the model ran. Its row keeps no decision and
 * no message's place.
 */
export const JUDGMENT_VOIDED_REASON_VALUES = [
  "voided_by_delete",
  "voided_by_edit",
] as const;
export type JudgmentVoidedReason =
  (typeof JUDGMENT_VOIDED_REASON_VALUES)[number];

export const JUDGMENT_OUTCOME_VALUES = [
  "judged",
  "not_called",
  "failed",
  "voided",
] as const;
export type JudgmentOutcome = (typeof JUDGMENT_OUTCOME_VALUES)[number];

export const JUDGMENT_REASON_VALUES = [
  ...M1_MODEL_REASON_VALUES,
  ...JUDGMENT_NOT_CALLED_REASON_VALUES,
  ...JUDGMENT_FAILED_REASON_VALUES,
  ...JUDGMENT_VOIDED_REASON_VALUES,
] as const;
export type JudgmentReason = (typeof JUDGMENT_REASON_VALUES)[number];

/** A judgment's result as its record keeps it; only `judged` can speak. */
export type JudgmentVerdict =
  | { outcome: "judged"; decision: M1Decision; reason: M1ModelReason }
  | {
      outcome: "not_called";
      decision: "quiet";
      reason: JudgmentNotCalledReason;
    }
  | { outcome: "failed"; decision: "quiet"; reason: JudgmentFailedReason };

/** The thread-reply rule's answer (slack-thread-shadow). */
export type ThreadReplyRule = {
  decision: "reply" | "skip";
  reason: "addressed_to_other_user" | "default_reply";
};

/**
 * What the current path did with a judged reply, kept beside M1's answer:
 * the thread-reply rule's, or `none`/`stray_reply` for a reply it makes no
 * turn of. A batch has none.
 */
export const JUDGMENT_RULE_DECISION_VALUES = ["reply", "skip", "none"] as const;
export type JudgmentRuleDecision =
  (typeof JUDGMENT_RULE_DECISION_VALUES)[number];
export const JUDGMENT_RULE_REASON_VALUES = [
  "addressed_to_other_user",
  "default_reply",
  "stray_reply",
] as const;
export type JudgmentRuleReason = (typeof JUDGMENT_RULE_REASON_VALUES)[number];
export type JudgmentRule =
  | ThreadReplyRule
  | { decision: "none"; reason: "stray_reply" };

/**
 * The fixed judgment rules a record was made under. Raised whenever the
 * system text changes, so judgments under other rules are never compared
 * as one.
 */
export const M1_PROMPT_VERSION = 1;
