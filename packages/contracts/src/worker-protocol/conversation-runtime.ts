import { z } from "zod";
import { conversationCallIdSchema } from "../domain/budget.ts";
import {
  conversationIdSchema,
  conversationTopicIdSchema,
} from "../domain/conversation.ts";
import {
  agentIdSchema,
  timestampSchema,
  workspaceIdSchema,
} from "../shared/ids.ts";
import { runtimeProviderSchema } from "./index.ts";

/**
 * The conversation runtime's protocol: one shared process that runs the
 * conversation turns of every agent and topic of an installation. It pulls a
 * turn from the control host, runs it, and reports its result; nothing
 * connects to it. Its bearer opens these two routes and no other.
 */

export const conversationTurnIdSchema = z.uuid().brand<"ConversationTurnId">();
export type ConversationTurnId = z.infer<typeof conversationTurnIdSchema>;
export const conversationTurnLeaseIdSchema = z
  .uuid()
  .brand<"ConversationTurnLeaseId">();
export type ConversationTurnLeaseId = z.infer<
  typeof conversationTurnLeaseIdSchema
>;
/** One runtime process, named by itself at start; a restart is another. */
export const conversationRuntimeIdSchema = z
  .uuid()
  .brand<"ConversationRuntimeId">();
export type ConversationRuntimeId = z.infer<typeof conversationRuntimeIdSchema>;

/** How long one conversation turn may run. */
export const CONVERSATION_TURN_LIMIT_MS = 2 * 60_000;
/**
 * How long a runtime holds a turn it took: the turn's limit and the time to
 * report it. A turn not reported by then is closed as failed, never run again.
 */
export const CONVERSATION_TURN_LEASE_MS = CONVERSATION_TURN_LIMIT_MS + 30_000;
/** The longest a poll for the next turn is held open. */
export const CONVERSATION_NEXT_TURN_MAX_WAIT_MS = 20_000;
export const CONVERSATION_TURN_TEXT_MAX = 16_000;
/** The longest context a new topic session starts from. */
export const CONVERSATION_TURN_FRESH_TEXT_MAX = 32_000;
/** How long a topic's session lives past its last turn's end. */
export const CONVERSATION_TOPIC_SESSION_IDLE_MS = 10 * 60_000;
/**
 * How many topic sessions one runtime keeps alive; one more drops the one
 * idle longest. Each holds an engine process (docs: conversation runtime).
 */
export const CONVERSATION_TOPIC_SESSION_LIMIT = 8;
/**
 * How much a topic session may have been sent and said, in UTF-8 bytes, before
 * its next turn starts anew: four times the context assembler's cap.
 */
export const CONVERSATION_TOPIC_SESSION_MAX_BYTES = 4 * 24_576;

/**
 * What bounds a turn: the one topic, of the one conversation of the one
 * agent, it runs for. Its working directory is keyed by the topic, and so is
 * every tool call it makes.
 */
export const conversationTurnScopeSchema = z
  .object({
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema,
    conversation_id: conversationIdSchema,
    topic_id: conversationTopicIdSchema,
  })
  .strict();
export type ConversationTurnScope = z.infer<typeof conversationTurnScopeSchema>;

export const conversationRuntimeTurnSchema = z
  .object({
    turn_id: conversationTurnIdSchema,
    lease_id: conversationTurnLeaseIdSchema,
    lease_expires_at: timestampSchema,
    scope: conversationTurnScopeSchema,
    model: z.string().min(1).max(128),
    // `auth.token` is the turn's one-call permit: the egress proxy trades it
    // for the connection's credential on one Messages request.
    provider: runtimeProviderSchema,
    call: z
      .object({
        id: conversationCallIdSchema,
        /** The output cap the call was reserved with; a request over it is refused. */
        max_tokens: z.number().int().positive(),
      })
      .strict(),
    /** What the turn says to a session of its topic that is still alive. */
    input: z
      .object({
        id: z.uuid(),
        text: z.string().min(1).max(CONVERSATION_TURN_TEXT_MAX),
      })
      .strict(),
    /**
     * What a new session of the topic starts from instead: the context the
     * control host assembled for this turn, its input included.
     */
    fresh_input: z
      .object({
        id: z.uuid(),
        text: z.string().min(1).max(CONVERSATION_TURN_FRESH_TEXT_MAX),
      })
      .strict(),
    /**
     * The control host's check of what the topic's live session has seen:
     * `keep` lets the turn go on in it; `drop`, or no check, starts anew.
     */
    topic_session: z.enum(["keep", "drop"]).optional(),
  })
  .strict();
export type ConversationRuntimeTurn = z.infer<
  typeof conversationRuntimeTurnSchema
>;

export const CONVERSATION_TURN_FAILURE_VALUES = [
  // The engine ended the turn without a clean answer.
  "engine_failed",
  // The runtime could not start or drive the engine.
  "runtime_failed",
  // The runtime cut the turn at its lease.
  "timed_out",
  // The runtime was stopping.
  "interrupted",
] as const;

export const conversationTurnResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      text: z.string().max(CONVERSATION_TURN_TEXT_MAX),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      reason: z.enum(CONVERSATION_TURN_FAILURE_VALUES),
      /** The engine's own word for it, when it gave one; never a message body. */
      detail: z
        .string()
        .regex(/^[a-z0-9_]{1,64}$/)
        .optional(),
    })
    .strict(),
]);
export type ConversationTurnResult = z.infer<
  typeof conversationTurnResultSchema
>;

export const conversationNextTurnRequestSchema = z
  .object({
    runtime_id: conversationRuntimeIdSchema,
    wait_ms: z
      .number()
      .int()
      .min(0)
      .max(CONVERSATION_NEXT_TURN_MAX_WAIT_MS)
      .optional(),
  })
  .strict();
export type ConversationNextTurnRequest = z.infer<
  typeof conversationNextTurnRequestSchema
>;
export const conversationNextTurnResponseSchema = z
  .object({ turn: conversationRuntimeTurnSchema.nullable() })
  .strict();
export type ConversationNextTurnResponse = z.infer<
  typeof conversationNextTurnResponseSchema
>;

export const conversationTurnResultRequestSchema = z
  .object({
    runtime_id: conversationRuntimeIdSchema,
    turn_id: conversationTurnIdSchema,
    lease_id: conversationTurnLeaseIdSchema,
    result: conversationTurnResultSchema,
  })
  .strict();
export type ConversationTurnResultRequest = z.infer<
  typeof conversationTurnResultRequestSchema
>;
export const conversationTurnResultResponseSchema = z
  // False when this same report was already recorded.
  .object({ recorded: z.boolean() })
  .strict();
export type ConversationTurnResultResponse = z.infer<
  typeof conversationTurnResultResponseSchema
>;

export const CONVERSATION_RUNTIME_ROUTE_PREFIX = "/conversation-runtime";
// Every route the conversation runtime's bearer opens, under /internal.
export const CONVERSATION_RUNTIME_ROUTES = {
  "/next-turn": {
    request: conversationNextTurnRequestSchema,
    response: conversationNextTurnResponseSchema,
  },
  "/turn-result": {
    request: conversationTurnResultRequestSchema,
    response: conversationTurnResultResponseSchema,
  },
} as const;
export type ConversationRuntimeRoute = keyof typeof CONVERSATION_RUNTIME_ROUTES;
