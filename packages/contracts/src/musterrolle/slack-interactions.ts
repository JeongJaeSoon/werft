import { z } from "zod";

import { agentIdSchema } from "../shared/index.ts";

/** Slack sends a modal's whole state on submit; the same bound as events. */
export const SLACK_INTERACTIONS_BODY_MAX_BYTES = 256 * 1024;

/**
 * The buttons and the modal the platform posts for a request a session
 * waits on. Each id names what pressing it does; the value names the
 * request, and the server judges both again.
 */
export const SLACK_INTERACTION_ACTIONS = {
  permissionAllow: "permission.allow",
  permissionAllowSession: "permission.allow_session",
  permissionDeny: "permission.deny",
  questionOption: "question.option",
  questionOpen: "question.open",
  pushApprove: "push.approve",
  pushReject: "push.reject",
} as const;
export const SLACK_QUESTION_VIEW_CALLBACK = "question.answer";

const slackId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/);
const slackTs = z
  .string()
  .min(1)
  .max(32)
  .regex(/^\d+\.\d+$/);

/** A button's value: the session, the request, and the option it picks. */
export const slackInteractionValueSchema = z
  .object({
    s: z.uuid(),
    r: z.string().min(1).max(512),
    o: z.string().min(1).max(512).optional(),
  })
  .strict();

/** What a question modal carries back: its request and the card to update. */
export const slackQuestionViewMetadataSchema = z
  .object({
    s: z.uuid(),
    r: z.string().min(1).max(512),
    c: slackId,
    m: slackTs,
    t: slackTs,
  })
  .strict();

export const slackBlockActionsPayloadSchema = z.looseObject({
  type: z.literal("block_actions"),
  api_app_id: slackId,
  team: z.looseObject({ id: slackId }),
  user: z.looseObject({ id: slackId }),
  channel: z.looseObject({ id: slackId }),
  message: z.looseObject({ ts: slackTs, thread_ts: slackTs.optional() }),
  trigger_id: z.string().min(1).max(256),
  actions: z
    .array(
      z.looseObject({
        action_id: z.string().min(1).max(255),
        value: z.string().max(2000).optional(),
      }),
    )
    .min(1),
});

export const slackViewSubmissionPayloadSchema = z.looseObject({
  type: z.literal("view_submission"),
  api_app_id: slackId,
  team: z.looseObject({ id: slackId }),
  user: z.looseObject({ id: slackId }),
  view: z.looseObject({
    callback_id: z.string().max(255),
    private_metadata: z.string().max(3000),
    state: z.looseObject({
      values: z.record(z.string(), z.record(z.string(), z.unknown())),
    }),
  }),
});

/** Any other payload type is acknowledged and ignored. */
export const slackInteractionPayloadSchema = z.union([
  slackBlockActionsPayloadSchema,
  slackViewSubmissionPayloadSchema,
  z.looseObject({ type: z.string().min(1).max(64) }),
]);

/** The form Slack posts: one `payload` field holding the JSON. */
export const slackInteractionFormSchema = z
  .object({ payload: z.string().min(2) })
  .strict();

export const slackInteractionsParamsSchema = z
  .object({ agent_id: agentIdSchema })
  .strict();

/**
 * `ok`: a button press, whose answer Slack ignores. `clear`: the modal was
 * taken and closes. `errors`: the modal stays open with these messages
 * under the named blocks.
 */
export const slackInteractionResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ response_action: z.literal("clear") }).strict(),
  z
    .object({
      response_action: z.literal("errors"),
      errors: z.record(z.string(), z.string()),
    })
    .strict(),
]);

export type SlackInteractionValue = z.infer<typeof slackInteractionValueSchema>;
export type SlackQuestionViewMetadata = z.infer<
  typeof slackQuestionViewMetadataSchema
>;
export type SlackBlockActionsPayload = z.infer<
  typeof slackBlockActionsPayloadSchema
>;
export type SlackViewSubmissionPayload = z.infer<
  typeof slackViewSubmissionPayloadSchema
>;
export type SlackInteractionResponse = z.infer<
  typeof slackInteractionResponseSchema
>;
