import { timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  agentIdSchema,
  CONVERSATION_NEXT_TURN_MAX_WAIT_MS,
  CONVERSATION_TURN_LEASE_MS,
  CONVERSATION_TURN_TEXT_MAX,
  type ConversationInputId,
  type ConversationTurnCallRefusal,
  type ConversationTurnId,
  type ConversationTurnState,
  conversationDecisionTools,
  conversationIdSchema,
  conversationInputIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
  workspaceIdSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type AgentStore,
  type ConversationCalls,
  type ConversationRuntimeTurns,
  type ConversationTurnLimitReached,
  type ConversationTurnOutcome,
  type ConversationTurnQueue,
  connectionOf,
  hashToken,
  type M1Speak,
  type M1SpeakOutcome,
  type MentionTurnRequest,
  type MentionTurnRetryRequests,
  type MentionTurnRetryStart,
  type MentionTurnStart,
  type MentionTurnStatusStore,
  type SessionCatalog,
} from "@werft-ai/platform";
import type { Server } from "bun";
import { z } from "zod";
import { booleanFlag } from "../boolean-flag.ts";
import type { AmbiguousPathGuard } from "./ambiguous-path.ts";

// A bearer an operator could type from memory is not a lock.
const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_CONVERSATION_TURN_SOCKET =
  "/tmp/werft-conversation-turns.sock";

// What an operator's turn may use at most. The engine's own request (its
// system prompt, with no tools) is about 16 KiB before the input.
export const OPERATOR_TURN_MAX_TOKENS = 4_096;
export const OPERATOR_TURN_MAX_REQUEST_BYTES = 96 * 1024;
// How long a queued turn waits for a runtime to take it.
export const OPERATOR_TURN_TAKE_MS = 30_000;

export type ConversationRuntimeConfig = {
  /** The bearers the runtime's routes accept: the current one, then the one being rotated out. */
  tokens: readonly string[];
  /** Where an operator in this container starts a turn. */
  socketPath: string;
};

/**
 * Unset, the conversation runtime is off: its routes are not served and an
 * operator's turn is refused. `CONVERSATION_RUNTIME_TOKEN_PREVIOUS` is the
 * bearer being rotated out, accepted beside the current one until the
 * runtime has restarted on the new value.
 */
export function conversationRuntimeConfigFromEnv(
  env: Record<string, string | undefined>,
): ConversationRuntimeConfig | null {
  const current = env.CONVERSATION_RUNTIME_TOKEN || undefined;
  const previous = env.CONVERSATION_RUNTIME_TOKEN_PREVIOUS || undefined;
  if (current === undefined) {
    if (previous !== undefined) {
      throw new Error(
        "CONVERSATION_RUNTIME_TOKEN_PREVIOUS is set without CONVERSATION_RUNTIME_TOKEN",
      );
    }
    return null;
  }
  for (const [name, value] of [
    ["CONVERSATION_RUNTIME_TOKEN", current],
    ["CONVERSATION_RUNTIME_TOKEN_PREVIOUS", previous],
  ] as const) {
    if (value !== undefined && value.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `${name} must be at least ${MIN_TOKEN_LENGTH} characters`,
      );
    }
  }
  return {
    tokens: previous === undefined ? [current] : [current, previous],
    socketPath:
      env.CONVERSATION_TURN_SOCKET || DEFAULT_CONVERSATION_TURN_SOCKET,
  };
}

/**
 * Whether conversation turns are dispatched from people's messages. The
 * switch exists so that turning it on over a queue held in one process's
 * memory stops the API at start rather than losing turns at its next
 * restart. The Slack role's mention turns (rollout `on`) are queued in the
 * database itself, whatever it says.
 */
export function assertConversationTurnDispatch(
  env: Record<string, string | undefined>,
  queue: Pick<ConversationTurnQueue, "durable">,
): void {
  const value = env.CONVERSATION_TURN_DISPATCH;
  if (value === undefined || value === "") return;
  if (!booleanFlag(value, "CONVERSATION_TURN_DISPATCH")) return;
  if (!queue.durable) {
    throw new Error(
      "CONVERSATION_TURN_DISPATCH is on, but conversation turns are queued in this process's memory: a restart loses them and a second API process does not see them. Leave it off until the queue is in the database.",
    );
  }
}

/** Whether a bearer is one of the runtime's, compared as digests. */
export function conversationRuntimeBearer(
  tokens: readonly string[],
): (token: string | null) => boolean {
  const expected = tokens.map((token) => hashToken(token));
  return (token) => {
    if (token === null) return false;
    const given = hashToken(token);
    // Every candidate is compared, so the time does not say which matched.
    let matched = false;
    for (const candidate of expected) {
      if (timingSafeEqual(given, candidate)) matched = true;
    }
    return matched;
  };
}

export const operatorTurnRequestSchema = z
  .object({
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema,
    conversation_id: conversationIdSchema,
    topic_id: conversationTopicIdSchema,
    text: z.string().min(1).max(CONVERSATION_TURN_TEXT_MAX),
    // Who ran the command, as its process saw itself: for the log only.
    operator: z
      .object({
        user: z.string().regex(/^[\w.@:-]{1,64}$/),
        host: z.string().regex(/^[\w.-]{1,255}$/),
      })
      .strict(),
  })
  .strict();
export type OperatorTurnRequest = z.infer<typeof operatorTurnRequestSchema>;

export type OperatorTurnResult =
  | { outcome: "invalid_request" }
  // No runtime has asked for a turn lately: none is running, or none reaches this API.
  | { outcome: "no_runtime" }
  | { outcome: "unknown_agent" }
  // The conversation is not the agent's, or the topic not the conversation's.
  | { outcome: "unknown_conversation" }
  // An admin emergency-stopped the agent in the conversation's channel.
  | { outcome: "channel_stopped" }
  | { outcome: "no_active_release" }
  // The release's connection is gone, or serves no Messages.
  | { outcome: "connection_unavailable" }
  | {
      outcome: "ended";
      turn_id: string;
      turn: ConversationTurnOutcome;
      // How the turn's record ended: decided, no_decision or voided_by_delete.
      recorded: ConversationTurnState | null;
      // The last call the turn asked for was refused, and why: the turn
      // ended on it.
      refused?: ConversationTurnCallRefusal;
      // The limit that ended the turn, and who held it there.
      limit_reached?: ConversationTurnLimitReached;
    };

/**
 * Starts one conversation turn for an operator: writes the turn and its
 * permit, queues the turn for the runtime, waits for how it ends and then
 * ends the turn's row and permit. Each provider call the turn makes is
 * reserved on the agent's team as an operator's call when the proxy asks.
 * Beside a person's mention under rollout `on` (createMentionConversationTurns),
 * the only way a turn starts.
 */
export function createOperatorConversationTurns(deps: {
  turns: ConversationRuntimeTurns;
  calls: Pick<ConversationCalls, "issueOperatorTurn" | "endTurn">;
  agents: Pick<AgentStore, "get">;
  catalog: Pick<SessionCatalog, "connections">;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    async run(request: OperatorTurnRequest): Promise<OperatorTurnResult> {
      // Before the turn is written: one nobody takes stays running until
      // its wait ends.
      if (
        !deps.turns.runtimePolledWithin(2 * CONVERSATION_NEXT_TURN_MAX_WAIT_MS)
      ) {
        return { outcome: "no_runtime" };
      }
      const agent = await deps.agents.get(
        request.workspace_id,
        request.agent_id,
      );
      if (agent === null) return { outcome: "unknown_agent" };
      const release = agent.active_release;
      if (release === null) return { outcome: "no_active_release" };
      const connection = connectionOf(deps.catalog, release.connection_id);
      const model = release.runtime_config_snapshot.model;
      if (
        connection === undefined ||
        connection.provider.kind === "openai_responses" ||
        typeof model !== "string"
      ) {
        return { outcome: "connection_unavailable" };
      }
      const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
      const issued = await deps.calls.issueOperatorTurn({
        workspaceId: request.workspace_id,
        agentId: request.agent_id,
        conversationId: request.conversation_id,
        topicId: request.topic_id,
        turnId,
        operator: `${request.operator.user}@${request.operator.host}`,
        // Valid for as long as the turn may wait and then run.
        ttlMs: OPERATOR_TURN_TAKE_MS + CONVERSATION_TURN_LEASE_MS,
        releaseId: release.id,
        connectionId: release.connection_id,
        model,
        maxTokens: OPERATOR_TURN_MAX_TOKENS,
        maxRequestBytes: OPERATOR_TURN_MAX_REQUEST_BYTES,
      });
      if (issued.outcome === "unknown_agent")
        return { outcome: "unknown_agent" };
      if (issued.outcome === "unavailable") {
        return { outcome: "connection_unavailable" };
      }
      if (
        issued.outcome === "unknown_conversation" ||
        issued.outcome === "channel_stopped"
      ) {
        return { outcome: issued.outcome };
      }
      let turn: ConversationTurnOutcome | null;
      try {
        const takeBy = new Date(
          Math.min(
            now().getTime() + OPERATOR_TURN_TAKE_MS,
            issued.expiresAt.getTime(),
          ),
        );
        // An operator's input is its own: in no conversation_inputs row,
        // and tried once.
        const inputId = conversationInputIdSchema.parse(crypto.randomUUID());
        const queued = await deps.turns.queue.enqueue(
          {
            turn_id: turnId,
            scope: {
              workspace_id: request.workspace_id,
              agent_id: request.agent_id,
              conversation_id: request.conversation_id,
              topic_id: request.topic_id,
            },
            model,
            provider: {
              kind: connection.provider.kind,
              endpoint: connection.provider.endpoint,
              auth: { kind: "egress_token", token: issued.token },
            },
            call: { max_tokens: OPERATOR_TURN_MAX_TOKENS },
            input: { id: inputId, text: request.text },
            // Assembled when a runtime takes the turn.
            fresh_input: { id: crypto.randomUUID(), text: request.text },
            // The requester issueOperatorTurn wrote.
            decision_tools: [
              ...conversationDecisionTools("operator", issued.place),
            ],
          },
          {
            inputId,
            attempt: 1,
            takeBy,
            now: now(),
            usableUntil: issued.expiresAt,
          },
        );
        // Ended between its permit and the queue (a stop): it never runs.
        if (queued === "ended") return { outcome: "channel_stopped" };
        turn = await deps.turns.ended(turnId);
      } catch (error) {
        // A turn that could not be queued or waited for gets no more calls.
        await deps.calls.endTurn(turnId);
        throw error;
      }
      const ended = await deps.calls.endTurn(turnId, turn ?? undefined);
      // Queued just above, so it has an end.
      if (turn === null)
        throw new Error(`Conversation turn ${turnId} vanished`);
      return {
        outcome: "ended",
        turn_id: turnId,
        turn,
        recorded: ended.state,
        ...(ended.refusal === null ? {} : { refused: ended.refusal }),
        ...(ended.limit === null ? {} : { limit_reached: ended.limit }),
      };
    },
  };
}

/**
 * Starts the conversation turn of a person's mention of the agent (v1-b/D1):
 * writes the turn, its permit and the mention's engagement, then queues the
 * turn for the runtime. It does not wait: the Slack role's pass ends it
 * (`endMentionTurns`). Sized as an operator's turn is. Its decision is
 * recorded only.
 */
export function createMentionConversationTurns(deps: {
  calls: Pick<ConversationCalls, "issueMentionTurn" | "endTurn">;
  queue: Pick<ConversationTurnQueue, "enqueue">;
  /** Lets the claim the turn is written with go once it is queued. */
  statuses: Pick<MentionTurnStatusStore, "releaseReset">;
  agents: Pick<AgentStore, "get">;
  catalog: Pick<SessionCatalog, "connections">;
  /** Where a try again reads its input; unset, nothing is tried again. */
  retries?: MentionTurnRetryRequests;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  // A try of the mention's input: the first, with an input id of its own,
  // or the next after `retryOf`, with its input id and the next attempt.
  async function begin(
    request: MentionTurnRequest,
    tried: {
      inputId: ConversationInputId;
      attempt: number;
      retryOf?: ConversationTurnId;
    },
    queuing: () => Promise<void>,
  ): Promise<MentionTurnStart> {
    // Before the turn is written: a turn's input could never hold it.
    if (request.text.length > CONVERSATION_TURN_TEXT_MAX) {
      return { outcome: "too_long" };
    }
    const agent = await deps.agents.get(request.workspaceId, request.agentId);
    if (agent === null) return { outcome: "unknown_agent" };
    const release = agent.active_release;
    if (release === null) return { outcome: "no_active_release" };
    const connection = connectionOf(deps.catalog, release.connection_id);
    const model = release.runtime_config_snapshot.model;
    if (
      connection === undefined ||
      connection.provider.kind === "openai_responses" ||
      typeof model !== "string"
    ) {
      return { outcome: "connection_unavailable" };
    }
    const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
    const issued = await deps.calls.issueMentionTurn({
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      conversationId: request.conversationId,
      topicId: request.topicId,
      turnId,
      requesterUserId: request.requesterUserId,
      slackInstallationId: request.slackInstallationId,
      message: request.message,
      slackSubject: request.slackSubject,
      ...(tried.retryOf === undefined ? {} : { retryOf: tried.retryOf }),
      ttlMs: OPERATOR_TURN_TAKE_MS + CONVERSATION_TURN_LEASE_MS,
      releaseId: release.id,
      connectionId: release.connection_id,
      model,
      maxTokens: OPERATOR_TURN_MAX_TOKENS,
      maxRequestBytes: OPERATOR_TURN_MAX_REQUEST_BYTES,
    });
    if (issued.outcome === "unavailable") {
      return { outcome: "connection_unavailable" };
    }
    if (issued.outcome !== "issued") return { outcome: issued.outcome };
    // Ended between its permit and the queue (a stop, or a pass that took
    // it for one whose writer died): it never runs, and nothing is said.
    let ended = false;
    try {
      await queuing();
      const at = now();
      const { inputId } = tried;
      const queued = await deps.queue.enqueue(
        {
          turn_id: turnId,
          scope: {
            workspace_id: request.workspaceId,
            agent_id: request.agentId,
            conversation_id: request.conversationId,
            topic_id: request.topicId,
          },
          model,
          provider: {
            kind: connection.provider.kind,
            endpoint: connection.provider.endpoint,
            auth: { kind: "egress_token", token: issued.token },
          },
          call: { max_tokens: OPERATOR_TURN_MAX_TOKENS },
          // The instruction is the requester's message alone; what else
          // the turn reads is assembled as data when a runtime takes it.
          // The engine skips a message whose id it has seen, as a try going
          // on in the topic's live session would be: each try's is its own.
          input: {
            id: tried.attempt === 1 ? inputId : crypto.randomUUID(),
            text: request.text,
          },
          fresh_input: { id: crypto.randomUUID(), text: request.text },
          decision_tools: [...conversationDecisionTools("user", issued.place)],
        },
        {
          inputId,
          attempt: tried.attempt,
          takeBy: new Date(
            Math.min(
              at.getTime() + OPERATOR_TURN_TAKE_MS,
              issued.expiresAt.getTime(),
            ),
          ),
          now: at,
          usableUntil: issued.expiresAt,
        },
      );
      ended = queued === "ended";
    } catch (error) {
      // A turn that could not be queued gets no calls. The queue's error is
      // the one thrown: what fails tidying up after it would hide it.
      await deps.calls.endTurn(turnId).catch(() => undefined);
      await deps.statuses.releaseReset(turnId).catch(() => undefined);
      throw error;
    }
    // Unreleased, the claim runs out and the next pass after it ends the
    // turn as it is: a try queued is queued all the same.
    await deps.statuses.releaseReset(turnId).catch(() => undefined);
    if (ended) return { outcome: "channel_stopped" };
    return { outcome: "queued", turnId };
  }
  return {
    /**
     * `queuing` runs once the turn is written and before a runtime can take
     * it, so what it tells the thread is never told after the turn's end.
     */
    start(
      request: MentionTurnRequest,
      queuing: () => Promise<void>,
    ): Promise<MentionTurnStart> {
      // The engagement keeps a repeated event from a second turn, so the
      // mention's first try has an input id of its own.
      const inputId = conversationInputIdSchema.parse(crypto.randomUUID());
      return begin(request, { inputId, attempt: 1 }, queuing);
    },
    /**
     * The next try of a mention turn's input that ended with no decision
     * (v1-b/F1): the same input id under the next attempt, a permit of its
     * own, the release and connection the agent has now. `queuing` is the
     * ending pass's word to the thread, said once the try is written.
     */
    async retry(
      turnId: ConversationTurnId,
      queuing: () => Promise<void>,
    ): Promise<MentionTurnRetryStart> {
      const request = await deps.retries?.requestOf(turnId);
      if (request === undefined || request === null) {
        return { outcome: "input_gone" };
      }
      // Another pass wrote the next try already.
      if (request === "moved") return { outcome: "duplicate" };
      if (request === "off") return { outcome: "rollout_off" };
      const { inputId, attempt, ...mention } = request;
      return begin(
        mention,
        { inputId, attempt: attempt + 1, retryOf: turnId },
        queuing,
      );
    },
  };
}

/**
 * Starts the agent's own conversation turn on a post M1 judged "speak"
 * (v1-b/U1): no person asked, so its requester is the agent and its calls
 * are held on the agent's team (root none). Its decisions are an answer or
 * silence alone. It does not wait: the Slack role's pass ends it, with no
 * try again, no line and no 👀. Sized as a mention's turn is.
 */
export function createUnsolicitedConversationTurns(deps: {
  calls: Pick<ConversationCalls, "issueUnsolicitedTurn" | "endTurn">;
  queue: Pick<ConversationTurnQueue, "enqueue">;
  statuses: Pick<MentionTurnStatusStore, "releaseReset">;
  agents: Pick<AgentStore, "get">;
  catalog: Pick<SessionCatalog, "connections">;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    async start(speak: M1Speak): Promise<M1SpeakOutcome> {
      const { post } = speak;
      if (post.body.length > CONVERSATION_TURN_TEXT_MAX) return "too_long";
      const agent = await deps.agents.get(speak.workspaceId, speak.agentId);
      if (agent === null) return "unknown_agent";
      const release = agent.active_release;
      if (release === null) return "no_active_release";
      const connection = connectionOf(deps.catalog, release.connection_id);
      const model = release.runtime_config_snapshot.model;
      if (
        connection === undefined ||
        connection.provider.kind === "openai_responses" ||
        typeof model !== "string"
      ) {
        return "connection_unavailable";
      }
      const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
      const issued = await deps.calls.issueUnsolicitedTurn({
        workspaceId: speak.workspaceId,
        agentId: speak.agentId,
        conversationId: speak.conversationId,
        turnId,
        message: {
          teamId: speak.teamId,
          channelId: speak.channelId,
          ts: post.ts,
          threadTs: post.threadTs,
        },
        ttlMs: OPERATOR_TURN_TAKE_MS + CONVERSATION_TURN_LEASE_MS,
        releaseId: release.id,
        connectionId: release.connection_id,
        model,
        maxTokens: OPERATOR_TURN_MAX_TOKENS,
        maxRequestBytes: OPERATOR_TURN_MAX_REQUEST_BYTES,
      });
      if (issued.outcome === "unavailable") return "connection_unavailable";
      if (issued.outcome !== "issued") {
        return issued.outcome === "duplicate" ? "duplicate" : issued.outcome;
      }
      let ended = false;
      try {
        const at = now();
        const queued = await deps.queue.enqueue(
          {
            turn_id: turnId,
            scope: {
              workspace_id: speak.workspaceId,
              agent_id: speak.agentId,
              conversation_id: speak.conversationId,
              topic_id: issued.topicId,
            },
            model,
            provider: {
              kind: connection.provider.kind,
              endpoint: connection.provider.endpoint,
              auth: { kind: "egress_token", token: issued.token },
            },
            call: { max_tokens: OPERATOR_TURN_MAX_TOKENS },
            // The post M1 judged is the turn's input; what else it reads is
            // assembled as data when a runtime takes it.
            input: { id: post.inputId, text: post.body },
            fresh_input: { id: crypto.randomUUID(), text: post.body },
            decision_tools: [
              ...conversationDecisionTools("agent", issued.place),
            ],
          },
          {
            // The held post's id: one verdict's turn is queued once.
            inputId: post.inputId,
            attempt: 1,
            takeBy: new Date(
              Math.min(
                at.getTime() + OPERATOR_TURN_TAKE_MS,
                issued.expiresAt.getTime(),
              ),
            ),
            now: at,
            usableUntil: issued.expiresAt,
          },
        );
        ended = queued === "ended";
      } catch (error) {
        await deps.calls.endTurn(turnId).catch(() => undefined);
        await deps.statuses.releaseReset(turnId).catch(() => undefined);
        throw error;
      }
      await deps.statuses.releaseReset(turnId).catch(() => undefined);
      return ended ? "channel_stopped" : "turn";
    },
  };
}

/**
 * The operator's door: a socket in this container's own filesystem, so only
 * a process started inside it (`conversation-turn.ts`) reaches it and no
 * bearer is needed. Removed with the API; a leftover from a killed one is
 * replaced.
 */
export async function serveOperatorConversationTurns(deps: {
  socketPath: string;
  operator: ReturnType<typeof createOperatorConversationTurns>;
  logger: StructuredLogger;
  guard: AmbiguousPathGuard;
}): Promise<{ stop(): Promise<void> }> {
  await rm(deps.socketPath, { force: true });
  const server = Bun.serve({
    unix: deps.socketPath,
    fetch: deps.guard.front(
      "operator-conversation-turns",
      async (request: Request, server: Server<undefined>) => {
        // A turn is held open until it ends, longer than the idle default.
        server.timeout(request, 0);
        if (request.method !== "POST") {
          return Response.json({ outcome: "invalid_request" }, { status: 405 });
        }
        const parsed = operatorTurnRequestSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) {
          return Response.json(
            { outcome: "invalid_request" } satisfies OperatorTurnResult,
            { status: 400 },
          );
        }
        try {
          const result = await deps.operator.run(parsed.data);
          // Ids and outcomes only: neither the input nor the answer is logged.
          deps.logger.info("Operator conversation turn", {
            operator_user: parsed.data.operator.user,
            operator_host: parsed.data.operator.host,
            agent_id: parsed.data.agent_id,
            topic_id: parsed.data.topic_id,
            outcome: result.outcome,
            ...(result.outcome === "ended"
              ? {
                  turn_id: result.turn_id,
                  ...(result.refused === undefined
                    ? {}
                    : { turn_refused: result.refused }),
                  turn_outcome: result.turn.outcome,
                  turn_recorded: result.recorded,
                  ...(result.turn.outcome === "completed" &&
                  result.turn.decision !== undefined
                    ? { turn_decision: result.turn.decision.tool }
                    : {}),
                  ...("reason" in result.turn
                    ? { turn_failure: result.turn.reason }
                    : {}),
                }
              : {}),
          });
          return Response.json(result);
        } catch (error) {
          deps.logger.error("Operator conversation turn failed", {
            operator_user: parsed.data.operator.user,
            operator_host: parsed.data.operator.host,
            agent_id: parsed.data.agent_id,
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
          return Response.json({ outcome: "error" }, { status: 500 });
        }
      },
    ),
  });
  return {
    async stop() {
      await server.stop(true);
      await rm(deps.socketPath, { force: true });
    },
  };
}
