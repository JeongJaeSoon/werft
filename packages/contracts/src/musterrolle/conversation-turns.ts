import { z } from "zod";
import { INITIATOR_VALUES } from "../domain/budget.ts";
import {
  CONVERSATION_TURN_DECISION_VALUES,
  CONVERSATION_TURN_LIMIT_SIDE_VALUES,
  CONVERSATION_TURN_LIMIT_VALUES,
} from "../domain/conversation.ts";
import { costUsdSchema } from "../domain/digest.ts";
import {
  pageSchema,
  paginationQuerySchema,
  sessionIdSchema,
  userIdSchema,
} from "../shared/ids.ts";
import { timestampSchema } from "../shared/index.ts";
import { conversationTurnIdSchema } from "../worker-protocol/conversation-runtime.ts";

// An agent's conversation turns as its admins read them (v1-b/V2): when,
// for whom, how each ended and what it cost, never what anyone wrote.

const slackIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const slackTsSchema = z.string().regex(/^\d{1,20}\.\d{1,20}$/);
const countSchema = z.number().int().nonnegative();

/** `conversation_turns.requester_kind` of a turn that ran. */
export const CONVERSATION_TURN_REQUESTER_KIND_VALUES = [
  "user",
  "slack_user",
  "slack_bot",
  "operator",
] as const;

/** A turn's row past `received`, which only a web input's holder is. */
export const LISTED_CONVERSATION_TURN_STATE_VALUES = [
  "running",
  "decided",
  "no_decision",
  "voided_by_delete",
] as const;

/** Only a Werft user is named; a Slack id never leaves Slack. */
export const conversationTurnRequesterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), user_id: userIdSchema }).strict(),
  z.object({ kind: z.literal("slack_user") }).strict(),
  z.object({ kind: z.literal("slack_bot") }).strict(),
  z.object({ kind: z.literal("operator") }).strict(),
]);

export const conversationTurnItemSchema = z
  .object({
    id: conversationTurnIdSchema,
    started_at: timestampSchema,
    ended_at: timestampSchema.nullable(),
    state: z.enum(LISTED_CONVERSATION_TURN_STATE_VALUES),
    /** The limit that ended a `no_decision` turn, and who held it there. */
    limit: z
      .object({
        reached: z.enum(CONVERSATION_TURN_LIMIT_VALUES),
        by: z.enum(CONVERSATION_TURN_LIMIT_SIDE_VALUES),
      })
      .strict()
      .nullable(),
    requester: conversationTurnRequesterSchema,
    decision: z.enum(CONVERSATION_TURN_DECISION_VALUES).nullable(),
    /** Its provider calls' models, first used first. */
    models: z.array(z.string()),
    /** Summed over its settled calls. */
    input_tokens: countSchema,
    output_tokens: countSchema,
    cost_usd: costUsdSchema,
    /** Calls with no usage report: reserved, in flight, or closed unknown. */
    unpriced_calls: countSchema,
    slack_thread: z
      .object({
        team_id: slackIdSchema,
        channel_id: slackIdSchema,
        thread_ts: slackTsSchema,
        url: z.string().url(),
      })
      .strict()
      .nullable(),
    /**
     * The task session open in the turn's thread now, not necessarily one
     * the turn handed to.
     */
    thread_task_session_id: sessionIdSchema.nullable(),
  })
  .strict();

export const listConversationTurnsQuerySchema = paginationQuerySchema.extend({
  initiator: z.enum(INITIATOR_VALUES).optional(),
});

export const listConversationTurnsResponseSchema = pageSchema(
  conversationTurnItemSchema,
).strict();

export type ConversationTurnRequester = z.infer<
  typeof conversationTurnRequesterSchema
>;
export type ConversationTurnItem = z.infer<typeof conversationTurnItemSchema>;
export type ListConversationTurnsQuery = z.infer<
  typeof listConversationTurnsQuerySchema
>;
export type ListConversationTurnsResponse = z.infer<
  typeof listConversationTurnsResponseSchema
>;
