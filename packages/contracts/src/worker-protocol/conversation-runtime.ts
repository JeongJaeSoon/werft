import { z } from "zod";
import {
  CONVERSATION_TURN_DECISION_VALUES,
  CONVERSATION_TURN_LIMIT_VALUES,
  CONVERSATION_TURN_REASON_MAX,
  type ConversationKind,
  type ConversationTurnDecision,
  conversationIdSchema,
  conversationTopicIdSchema,
} from "../domain/conversation.ts";
import { TASK_INTERPRETATION_TEXT_MAX } from "../domain/task.ts";
import {
  agentIdSchema,
  timestampSchema,
  workspaceIdSchema,
} from "../shared/ids.ts";
import { runtimeProviderSchema } from "./index.ts";

/**
 * The conversation runtime's protocol: one shared process that runs the
 * conversation turns of every agent and topic of an installation. It pulls a
 * turn from the control host, runs it, and reports its result; a turn's read
 * tools are answered there too. Nothing connects to it. Its bearer opens
 * these routes and no other.
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
/** How many provider calls one conversation turn may make. */
export const CONVERSATION_TURN_MODEL_CALL_LIMIT = 8;
/** How many tool calls one conversation turn may make, whatever their outcome. */
export const CONVERSATION_TURN_TOOL_CALL_LIMIT = 12;
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

export const conversationTurnDecisionSchema = z.enum(
  CONVERSATION_TURN_DECISION_VALUES,
);
const ALL_DECISIONS = CONVERSATION_TURN_DECISION_VALUES;
const ANSWER_ONLY = ["reply", "no_reply"] as const;
/**
 * The decision tools each kind of turn requester is given (G2): a person,
 * and the operator's own test turn, all four; an agent (a Slack bot) only
 * to answer or stay quiet. One table, for what the runtime loads and what
 * the server checks again.
 */
const DECISION_TOOLS_BY_REQUESTER: Record<
  string,
  readonly ConversationTurnDecision[]
> = {
  user: ALL_DECISIONS,
  slack_user: ALL_DECISIONS,
  operator: ALL_DECISIONS,
  slack_bot: ANSWER_ONLY,
};
/**
 * The decision tools of a turn whose requester is of `kind`; a kind not
 * known gets the fewest. A DM's turn opens no task: tasks start in channel
 * threads alone.
 */
export function conversationDecisionTools(
  kind: string,
  place: ConversationKind = "channel",
): readonly ConversationTurnDecision[] {
  const tools = Object.hasOwn(DECISION_TOOLS_BY_REQUESTER, kind)
    ? (DECISION_TOOLS_BY_REQUESTER[kind] ?? ANSWER_ONLY)
    : ANSWER_ONLY;
  return place === "dm" ? tools.filter((tool) => tool !== "spawn_task") : tools;
}

const decisionReasonSchema = z
  .string()
  .min(1)
  .max(CONVERSATION_TURN_REASON_MAX);
/**
 * The one decision a turn's model makes, as its decision tool was called.
 * The reply's body is kept as the turn's answer, and a new task's goal, end
 * and repository as its draft (v1-b/E3): the agent's reading of the request,
 * never the request itself, which the server attaches (G6). The repository
 * is the model's pick, checked by the server against the agent's (G3).
 */
export const conversationDecisionSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("reply"),
      body: z.string().min(1).max(CONVERSATION_TURN_TEXT_MAX),
      reason: decisionReasonSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("route_to_task"),
      // An open task of the conversation, as list_open_tasks names it.
      task_id: z.uuid(),
      reason: decisionReasonSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("spawn_task"),
      goal: z.string().trim().min(1).max(TASK_INTERPRETATION_TEXT_MAX),
      done_when: z.string().trim().min(1).max(TASK_INTERPRETATION_TEXT_MAX),
      repository: z.string().min(1).max(128).optional(),
      reason: decisionReasonSchema,
    })
    .strict(),
  z
    .object({ tool: z.literal("no_reply"), reason: decisionReasonSchema })
    .strict(),
]);
export type ConversationDecision = z.infer<typeof conversationDecisionSchema>;

export const conversationRuntimeTurnSchema = z
  .object({
    turn_id: conversationTurnIdSchema,
    lease_id: conversationTurnLeaseIdSchema,
    lease_expires_at: timestampSchema,
    scope: conversationTurnScopeSchema,
    model: z.string().min(1).max(128),
    // `auth.token` is the turn's permit: the egress proxy trades it for the
    // connection's credential on each Messages request of the turn, each
    // reserved on its own as the proxy asks.
    provider: runtimeProviderSchema,
    call: z
      .object({
        /** Each call's output cap, as it is reserved; a request over it is refused. */
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
    /**
     * The decision tools the engine is given, as the server chose them for
     * the turn's requester; absent, only reply and no_reply.
     */
    decision_tools: z
      .array(conversationTurnDecisionSchema)
      .max(CONVERSATION_TURN_DECISION_VALUES.length)
      .optional(),
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
  // The runtime cut the turn at one of its limits.
  ...CONVERSATION_TURN_LIMIT_VALUES,
  // The runtime was stopping.
  "interrupted",
] as const;

export const conversationTurnResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      text: z.string().max(CONVERSATION_TURN_TEXT_MAX),
      /** The decision the server accepted in the turn; absent, it made none. */
      decision: conversationDecisionSchema.optional(),
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

/**
 * The runtime's own MCP server for conversation turns, apart from the
 * session worker's built-in `werft` one: its tools read for the one turn
 * that calls them.
 */
export const CONVERSATION_TOOL_SERVER = "conversation";
/**
 * The read tools of a conversation turn, a fixed list. None takes an
 * argument: what each reads is the turn's own conversation and topic, as the
 * control host knows the turn from its lease.
 */
export const CONVERSATION_READ_TOOL_VALUES = [
  // The current topic's Slack thread, that thread only.
  "read_thread",
  "read_channel_summary",
  // The conversation's ended turns.
  "read_turns",
  // The conversation's tasks that have not ended.
  "list_open_tasks",
] as const;
export const conversationReadToolSchema = z.enum(CONVERSATION_READ_TOOL_VALUES);
export type ConversationReadTool = z.infer<typeof conversationReadToolSchema>;
/** The engine's names of the read tools: `mcp__conversation__<tool>`. */
export const CONVERSATION_READ_TOOL_NAMES: readonly string[] =
  CONVERSATION_READ_TOOL_VALUES.map(
    (tool) => `mcp__${CONVERSATION_TOOL_SERVER}__${tool}`,
  );
const utf8 = new TextEncoder();
/** How many thread reads one turn may make. */
export const CONVERSATION_TURN_THREAD_READ_LIMIT = 2;
/** The most messages one thread read takes, from the thread's start. */
export const CONVERSATION_THREAD_READ_MESSAGE_LIMIT = 50;
/** The most turns, or tasks, one read lists. */
export const CONVERSATION_READ_LIST_LIMIT = 20;
/**
 * The largest tool result a read gives back, in UTF-8 bytes: what a turn's
 * next request carries for it, well inside the request's own bound.
 */
export const CONVERSATION_READ_TOOL_RESULT_MAX_BYTES = 12_288;

export const CONVERSATION_READ_TOOL_REFUSAL_VALUES = [
  // The turn's tool calls are past CONVERSATION_TURN_TOOL_CALL_LIMIT.
  "tool_call_limit",
  // The turn's thread reads are used up, or Slack answered 429 to one.
  "thread_read_limit",
  // A private channel whose requester is not a member now, or not known to be.
  "not_channel_member",
  // Another organization shares the channel: its thread is not read.
  "external_shared_channel",
  // Slack did not answer the read; the turn goes on without it.
  "unavailable",
] as const;
export type ConversationReadToolRefusal =
  (typeof CONVERSATION_READ_TOOL_REFUSAL_VALUES)[number];

export const conversationReadToolRequestSchema = z
  .object({
    runtime_id: conversationRuntimeIdSchema,
    turn_id: conversationTurnIdSchema,
    lease_id: conversationTurnLeaseIdSchema,
    tool: conversationReadToolSchema,
  })
  .strict();
export type ConversationReadToolRequest = z.infer<
  typeof conversationReadToolRequestSchema
>;
export const conversationReadToolResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("read"),
        /** What was read, as data for the model: never an instruction. */
        text: z
          .string()
          .refine(
            (text) =>
              utf8.encode(text).length <=
              CONVERSATION_READ_TOOL_RESULT_MAX_BYTES,
          ),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("refused"),
        reason: z.enum(CONVERSATION_READ_TOOL_REFUSAL_VALUES),
      })
      .strict(),
  ],
);
export type ConversationReadToolResponse = z.infer<
  typeof conversationReadToolResponseSchema
>;

/** The engine's names of the decision tools: `mcp__conversation__<tool>`. */
export const CONVERSATION_DECISION_TOOL_NAMES: readonly string[] =
  CONVERSATION_TURN_DECISION_VALUES.map(
    (tool) => `mcp__${CONVERSATION_TOOL_SERVER}__${tool}`,
  );

export const CONVERSATION_DECISION_TOOL_REFUSAL_VALUES = [
  "tool_call_limit",
  // Not a tool of the turn's requester's kind (G2).
  "tool_not_allowed",
  // route_to_task named no open task of the conversation the requester sees.
  "unknown_task",
  "not_channel_member",
] as const;
export type ConversationDecisionToolRefusal =
  (typeof CONVERSATION_DECISION_TOOL_REFUSAL_VALUES)[number];

export const conversationDecisionToolRequestSchema = z
  .object({
    runtime_id: conversationRuntimeIdSchema,
    turn_id: conversationTurnIdSchema,
    lease_id: conversationTurnLeaseIdSchema,
    decision: conversationDecisionSchema,
  })
  .strict();
export type ConversationDecisionToolRequest = z.infer<
  typeof conversationDecisionToolRequestSchema
>;
/**
 * `accepted`: the turn may end on it. Nothing is written until the turn's
 * end, which checks it again (G2, and what the turn read was not deleted).
 */
export const conversationDecisionToolResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("accepted") }).strict(),
    z
      .object({
        outcome: z.literal("refused"),
        reason: z.enum(CONVERSATION_DECISION_TOOL_REFUSAL_VALUES),
      })
      .strict(),
  ],
);
export type ConversationDecisionToolResponse = z.infer<
  typeof conversationDecisionToolResponseSchema
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
  "/read-tool": {
    request: conversationReadToolRequestSchema,
    response: conversationReadToolResponseSchema,
  },
  "/decision-tool": {
    request: conversationDecisionToolRequestSchema,
    response: conversationDecisionToolResponseSchema,
  },
} as const;
export type ConversationRuntimeRoute = keyof typeof CONVERSATION_RUNTIME_ROUTES;
