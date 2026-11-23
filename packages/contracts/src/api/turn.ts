import { z } from "zod";
import {
  slackPermalinkSchema,
  surfaceKindSchema,
} from "../kollegium/surfaces.ts";
import {
  attemptIdSchema,
  epochSchema,
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
  userIdSchema,
} from "../shared/index.ts";
import { receiptStatusSchema } from "./receipt.ts";
import {
  attemptStateSchema,
  messageInputSchema,
  messageTextSchema,
  turnStatusSchema,
} from "./session.ts";

export const sessionMessageSchema = z
  .object({ message: messageTextSchema })
  .strict();
export const postSessionMessageRequestSchema = sessionMessageSchema.extend({
  message: messageInputSchema,
  mode: z.literal("enqueue").default("enqueue"),
});
export const postSessionMessageResponseSchema = z.object({
  turn_id: turnIdSchema,
  receipt_id: receiptIdSchema,
  receipt_status: receiptStatusSchema,
});

export const attemptSummarySchema = z.object({
  attempt_id: attemptIdSchema,
  state: attemptStateSchema,
  lease_epoch: epochSchema,
  execution_generation: epochSchema,
  started_at: timestampSchema.nullable(),
  ended_at: timestampSchema.nullable(),
});
export const turnSummarySchema = z.object({
  turn_id: turnIdSchema,
  session_id: sessionIdSchema,
  status: turnStatusSchema.meta({
    description:
      "needs_input is derived when read, as for the session: a running turn with a pending request a client can still answer.",
  }),
  message: z.string(),
  channel: surfaceKindSchema.nullable().default(null).meta({
    description:
      "Where the instruction came from: `slack` (a mention, DM or thread reply), `web` (the console) or `api` (an API key). Null for a turn from before it was recorded, or one the platform queued itself, such as an approval answered after its worker was gone, or the follow-up to a turn whose push request came before the session had a checkpoint.",
  }),
  created_by: z
    .object({ user_id: userIdSchema, display_name: z.string() })
    .nullable()
    .default(null)
    .meta({
      description:
        "Who sent the instruction: the signed-in person, the Slack user's linked account, or for an API key the person who created the key. Null when no person is recorded: an API key no person created, or a turn the platform queued itself.",
    }),
  requester: z
    .object({
      kind: z.string().min(1),
      id: z.string().min(1),
      auth_method: z.string().min(1).nullable(),
      carried: z.boolean(),
    })
    .nullable()
    .default(null)
    .meta({
      description:
        "Who the instruction is recorded as coming from, as stored. `kind` is `user` (a person: console, linked Slack account or personal key), `api_key` (a key no person holds, `id` the key), `slack_bot` (an allowed Slack bot, `id` its Slack user id) or `agent` (work the platform queued as the agent's own, such as the follow-up to a push decision, `id` the agent); a client takes any other kind as unknown. `auth_method` is the credential it came in on: `web_session`, `personal_key`, `agent_key`, `service_key`, `slack_link`, `slack_bot`, `unauthenticated` or `push_decision` (not a credential: the push decision an `agent` turn follows), any other value read as unknown; null when none was recorded. `carried` is true for a turn that took its requester from an earlier one, such as the continuation after an approval. Null for a turn with no requester recorded: one from before it was, or one the platform queued itself.",
    }),
  slack_permalink: slackPermalinkSchema.nullable().default(null).meta({
    description:
      "The Slack message the instruction came from, as the link Slack gave for it (`chat.getPermalink`); it opens only for someone who can read that message in Slack. Null for an instruction not from Slack, one from before links were kept, or when Slack did not give a link.",
  }),
  source_deleted_at: timestampSchema.nullable().default(null).meta({
    description:
      "When Slack deleted the message the instruction came from. Set, the turn's `message` is empty, its `result` and `terminal_reason` null, and its events carry `source_deleted_at` with their text left out: the instruction, the agent's replies and what its tools read and returned. Only the turn the message was the instruction of is withheld; a later turn of the session shows as it is. What is stored is kept until an admin deletes it. Null otherwise, and from a server before the field.",
  }),
  terminal_reason: z.string().min(1).nullable(),
  checkpoint_revision: revisionSchema.nullable().meta({
    description:
      "The newest checkpoint this turn committed that a restore can still reach. A revision garbage collection removed, or one a start_fresh recovery decision retired, is not reported; null when none is left.",
  }),
  created_at: timestampSchema,
  started_at: timestampSchema.nullable(),
  ended_at: timestampSchema.nullable(),
});
export const turnDetailSchema = turnSummarySchema.extend({
  result: z.unknown().nullable(),
  usage: z.unknown().nullable(),
  attempts: z.array(attemptSummarySchema),
});
export const listTurnsQuerySchema = paginationQuerySchema;
export const listTurnsResponseSchema = pageSchema(turnSummarySchema);
export const getTurnResponseSchema = turnDetailSchema;

export type PostSessionMessageRequest = z.infer<
  typeof postSessionMessageRequestSchema
>;
export type PostSessionMessageResponse = z.infer<
  typeof postSessionMessageResponseSchema
>;
export type TurnSummary = z.infer<typeof turnSummarySchema>;
export type TurnDetail = z.infer<typeof turnDetailSchema>;
export type ListTurnsQuery = z.infer<typeof listTurnsQuerySchema>;
export type ListTurnsResponse = z.infer<typeof listTurnsResponseSchema>;
export type GetTurnResponse = z.infer<typeof getTurnResponseSchema>;
