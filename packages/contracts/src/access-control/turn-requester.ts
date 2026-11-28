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
export const REQUESTER_KIND_VALUES = [
  "user",
  "api_key",
  "slack_bot",
  // A turn the platform queues as the agent's own work; no person asked.
  "agent",
] as const;
export const requesterKindSchema = z.enum(REQUESTER_KIND_VALUES);
export type RequesterKind = z.infer<typeof requesterKindSchema>;

export const webSessionIdSchema = z.uuid().brand<"WebSessionId">();
export type WebSessionId = z.infer<typeof webSessionIdSchema>;

/** Who a turn's instruction came from; `kind` decides what `id` is. */
export const turnRequesterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: userIdSchema }),
  z.object({ kind: z.literal("api_key"), id: opaqueIdSchema }),
  z.object({ kind: z.literal("slack_bot"), id: opaqueIdSchema }),
  z.object({ kind: z.literal("agent"), id: agentIdSchema }),
]);
export type TurnRequester = z.infer<typeof turnRequesterSchema>;

export const CARRIED_REASON_VALUES = [
  "continuation",
  // Not a carry of the requester: the turn whose push request this follows.
  "push_follow_up",
] as const;

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

/**
 * Whose request a push follow-up turn comes from: the requester columns,
 * credential and `via` of the turn that asked for the push, or that turn's
 * own root when it was itself a follow-up, so roots never nest. Absent when
 * that turn was not found.
 */
export const pushRootSchema = z.object({
  requester_kind: z.string().nullable(),
  requester_id: z.string().nullable(),
  requester_auth: z.unknown().nullable(),
  via: z.array(z.unknown()),
});
export type PushRoot = z.infer<typeof pushRootSchema>;

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
  // Not a credential: the platform queued the turn after this decision.
  z.object({
    method: z.literal("push_decision"),
    push_request_id: z.uuid(),
    decision: z.enum(["approve", "reject"]),
    root: pushRootSchema.optional(),
    ...carried,
  }),
]);
export type RequesterAuth = z.infer<typeof requesterAuthSchema>;
