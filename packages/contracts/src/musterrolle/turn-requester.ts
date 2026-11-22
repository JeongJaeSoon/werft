import { z } from "zod";
import {
  agentIdSchema,
  installationIdSchema,
  opaqueIdSchema,
  revisionSchema,
  turnIdSchema,
  userIdSchema,
} from "../shared/ids.ts";

/**
 * `turns.requester_kind`. Text with no CHECK: a release in the support
 * window writes the same column, and a reader takes a kind it does not know
 * as an unknown requester rather than an error.
 */
export const REQUESTER_KIND_VALUES = ["user", "api_key", "slack_bot"] as const;
export const requesterKindSchema = z.enum(REQUESTER_KIND_VALUES);
export type RequesterKind = z.infer<typeof requesterKindSchema>;

export const webSessionIdSchema = z.uuid().brand<"WebSessionId">();
export type WebSessionId = z.infer<typeof webSessionIdSchema>;

/** Who a turn's instruction came from; `kind` decides what `id` is. */
export const turnRequesterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: userIdSchema }),
  z.object({ kind: z.literal("api_key"), id: opaqueIdSchema }),
  z.object({ kind: z.literal("slack_bot"), id: opaqueIdSchema }),
]);
export type TurnRequester = z.infer<typeof turnRequesterSchema>;

export const CARRIED_REASON_VALUES = ["continuation"] as const;

/**
 * The turn that handed its requester down, and why. Only the one just
 * before: each carry writes it anew.
 */
export const carriedFromSchema = z.object({
  session_id: z.uuid().optional(),
  turn: turnIdSchema,
  reason: z.string().min(1),
});
export type CarriedFrom = z.infer<typeof carriedFromSchema>;

// What the requester columns do not say: the credential the instruction
// came in on. Holds no secret and no Slack user id.
const carried = {
  carried_from: carriedFromSchema.optional(),
  /** The agents the request passed through, first first; copied on a carry. */
  via: z.array(z.unknown()).optional(),
};
export const requesterAuthSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("web_session"),
    web_session_id: webSessionIdSchema,
    ...carried,
  }),
  z.object({
    method: z.literal("personal_key"),
    api_key_id: opaqueIdSchema,
    ...carried,
  }),
  z.object({
    method: z.literal("agent_key"),
    agent_id: agentIdSchema,
    ...carried,
  }),
  z.object({ method: z.literal("service_key"), ...carried }),
  z.object({
    method: z.literal("slack_link"),
    installation_id: installationIdSchema,
    linked_account_id: z.uuid(),
    linked_account_revision: revisionSchema,
    ...carried,
  }),
  z.object({
    method: z.literal("slack_bot"),
    installation_id: installationIdSchema,
    agent_id: agentIdSchema,
    ...carried,
  }),
  z.object({ method: z.literal("unauthenticated"), ...carried }),
]);
export type RequesterAuth = z.infer<typeof requesterAuthSchema>;
