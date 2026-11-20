import { z } from "zod";

import { receiptAcceptedResponseSchema } from "../api/receipt.ts";
import { sessionStatusSchema } from "../api/session.ts";
import {
  agentIdSchema,
  sessionIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { justificationSchema } from "./session-shares.ts";

/**
 * A session whose requester was offboarded. It takes no input
 * until an owner takes it over and becomes its requester.
 */
export const takeoverSchema = z
  .object({
    session_id: sessionIdSchema,
    agent_id: agentIdSchema.nullable().meta({
      description:
        "The agent the session was created for. Null for a session created without `agent_release_id`.",
    }),
    /** The offboarded person who asked for the session. */
    departed_user_id: userIdSchema,
    status: sessionStatusSchema,
    created_at: timestampSchema,
    takeover_required_at: timestampSchema,
  })
  .strict();

export const TAKEOVER_LIST_LIMIT = 200;

export const listTakeoversQuerySchema = z.object({
  agent_id: agentIdSchema.optional().meta({
    description: "Keeps the sessions created for this agent.",
  }),
  session_id: sessionIdSchema.optional().meta({
    description: "Keeps this session, if it awaits a takeover.",
  }),
});

export const listTakeoversResponseSchema = z
  .object({
    items: z.array(takeoverSchema).max(TAKEOVER_LIST_LIMIT),
    total: z
      .number()
      .int()
      .nonnegative()
      .meta({
        description: `Every session the filters keep; \`items\` holds the first ${TAKEOVER_LIST_LIMIT}.`,
      }),
  })
  .strict();

// Required by the policy when the session is outside the taker's share.
export const takeOverSessionRequestSchema = z
  .object({ justification: justificationSchema.optional() })
  .strict();

export const takeOverSessionResponseSchema = receiptAcceptedResponseSchema;

export type ListTakeoversQuery = z.infer<typeof listTakeoversQuerySchema>;
export type Takeover = z.infer<typeof takeoverSchema>;
export type ListTakeoversResponse = z.infer<typeof listTakeoversResponseSchema>;
export type TakeOverSessionResponse = z.infer<
  typeof takeOverSessionResponseSchema
>;
