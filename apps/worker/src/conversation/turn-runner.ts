import {
  CONVERSATION_DECISION_TOOL_NAMES,
  CONVERSATION_READ_TOOL_NAMES,
  CONVERSATION_TOOL_SERVER,
  CONVERSATION_TOPIC_SESSION_MAX_BYTES,
  CONVERSATION_TURN_LIMIT_MS,
  CONVERSATION_TURN_MODEL_CALL_LIMIT,
  CONVERSATION_TURN_TEXT_MAX,
  CONVERSATION_TURN_TOOL_CALL_LIMIT,
  type ConversationRuntimeTurn,
  type ConversationTurnDecision,
  type ConversationTurnLimit,
  type ConversationTurnResult,
} from "@werft-ai/contracts";
import type {
  RuntimeModule,
  RuntimeProcessObserver,
} from "@werft-ai/runtime-core";
import type { ConversationTools } from "./conversation-tools.ts";
import type { PermitRelay } from "./permit-relay.ts";
import type { TopicSession, TopicSessions } from "./topic-sessions.ts";

/** Runs one conversation turn to its end; never throws for a turn that failed. */
export interface ConversationTurnRunner {
  run(
    turn: ConversationRuntimeTurn,
    /** Aborted when the runtime is stopping. */
    stop: AbortSignal,
  ): Promise<ConversationTurnResult>;
}

/**
 * What a conversation turn may call of the engine's own tools: none. The
 * tools that change files, run commands or use git exist in a work session
 * only. The engine is given an empty tool list and, as a second lock, a deny
 * rule for every tool it has built in.
 */
export const CONVERSATION_BUILTIN_TOOLS: readonly string[] = [];

/**
 * Every tool a conversation turn's engine may be given: the read tools and
 * the decision tools of the runtime's own server, a fixed list, and nothing
 * built in. A turn is given the decision tools the server chose for it.
 */
export const CONVERSATION_TURN_TOOLS: readonly string[] = [
  ...CONVERSATION_BUILTIN_TOOLS,
  ...CONVERSATION_READ_TOOL_NAMES,
  ...CONVERSATION_DECISION_TOOL_NAMES,
];

/** The decision tools a turn's engine is given; absent, the fewest. */
export function turnDecisionTools(
  turn: ConversationRuntimeTurn,
): readonly ConversationTurnDecision[] {
  return turn.decision_tools ?? ["reply", "no_reply"];
}

/** The tools a turn's engine is started with. */
export function turnTools(turn: ConversationRuntimeTurn): string[] {
  return [
    ...CONVERSATION_BUILTIN_TOOLS,
    ...CONVERSATION_READ_TOOL_NAMES,
    ...turnDecisionTools(turn).map(
      (tool) => `mcp__${CONVERSATION_TOOL_SERVER}__${tool}`,
    ),
  ];
}

const utf8 = new TextEncoder();
// As a request body carries it: quoted and escaped.
const bytesOf = (text: string) => utf8.encode(JSON.stringify(text)).length;

// What a request adds around the next input: the two messages' own wrapping,
// and what the engine attaches to a prompt.
const TURN_OVERHEAD_BYTES = 1_024;

// The engine was started on one model, provider, output cap and set of
// decision tools: a turn on others starts its own, so no turn is given a
// tool its requester is not.
const startedFor = (turn: ConversationRuntimeTurn) =>
  JSON.stringify([
    turn.model,
    turn.provider.kind,
    turn.provider.endpoint,
    turn.call.max_tokens,
    turnDecisionTools(turn),
  ]);

/** The provider's id for the message an event's block is from, when it gave one. */
function providerMessageId(data: unknown): string | null {
  const message = (data as { message?: { id?: unknown } } | null)?.message;
  return typeof message?.id === "string" && message.id !== ""
    ? message.id
    : null;
}

/** Whether a turn goes on in the topic's live session rather than a new one. */
function goesOn(
  session: TopicSession | null,
  turn: ConversationRuntimeTurn,
  maxBytes: number,
): session is TopicSession {
  return (
    session !== null &&
    session.startedFor === startedFor(turn) &&
    // No check, or one that could not be made, drops it.
    turn.topic_session === "keep" &&
    session.bytes + bytesOf(turn.input.text) + TURN_OVERHEAD_BYTES <= maxBytes
  );
}

/**
 * A turn runs in its topic's session: the topic's live engine, when the
 * control host's check keeps it and it has not grown past `maxBytes`, which
 * is sent the turn's input; else a new engine in a new, empty directory, sent
 * the context the control host assembled. The engine never compacts nor
 * resumes a conversation. Its provider calls go through the relay, which
 * carries the running turn's permit to the egress proxy; the proxy adds the
 * credential this process never holds.
 */
export function createConversationTurnRunner(deps: {
  runtime: RuntimeModule;
  sessions: TopicSessions;
  relay: Pick<
    PermitRelay,
    "hold" | "release" | "url" | "requestBytes" | "responseBytes"
  >;
  /** The read tools each session's engine calls, held to the running turn. */
  tools: Pick<ConversationTools, "hold" | "release" | "server" | "decision">;
  limitMs?: number;
  maxBytes?: number;
  modelCallLimit?: number;
  toolCallLimit?: number;
}): ConversationTurnRunner {
  const { builtinTools, eventCodec } = deps.runtime;
  if (builtinTools === undefined || eventCodec === undefined) {
    throw new Error(
      `The ${deps.runtime.descriptor.kind} runtime cannot serve conversation turns: it names no built-in tools to deny or reads no answer text`,
    );
  }
  const limitMs = deps.limitMs ?? CONVERSATION_TURN_LIMIT_MS;
  const maxBytes = deps.maxBytes ?? CONVERSATION_TOPIC_SESSION_MAX_BYTES;
  const modelCallLimit =
    deps.modelCallLimit ?? CONVERSATION_TURN_MODEL_CALL_LIMIT;
  const toolCallLimit = deps.toolCallLimit ?? CONVERSATION_TURN_TOOL_CALL_LIMIT;
  const { sessions } = deps;

  return {
    async run(turn, stop) {
      const topicId = turn.scope.topic_id;
      const live = await sessions.get(topicId);
      const continued = goesOn(live, turn, maxBytes);
      const start = (
        directory: TopicSession["directory"],
        permitKey: string,
        engines: RuntimeProcessObserver,
      ) =>
        deps.runtime
          .createRuntime({
            stateDir: directory.stateDir,
            // The token is bound to its first request: a retry is another, refused.
            providerMaxRetries: 0,
            // Its session sees the engine exit before the directory goes.
            processObserver: engines,
          })
          .start({
            config: {
              mode: "new",
              correlationId: turn.turn_id,
              cwd: directory.cwd,
              home: directory.home,
              tmpDir: directory.tmp,
              model: turn.model,
              // Nobody answers a permission request here: what is not allowed is refused.
              permissionMode: "dontAsk",
              tools: turnTools(turn),
              disallowedTools: builtinTools,
              // The engine's own stop at the call limit, behind the count below.
              maxTurns: modelCallLimit,
              maxOutputTokens: turn.call.max_tokens,
              // A session that grows past its size starts anew instead.
              compactionOff: true,
            },
            bindings: {
              principal: { ownerScope: turn.scope.workspace_id },
              provider: {
                kind: turn.provider.kind,
                endpoint: turn.provider.endpoint,
                // The session's key: the relay puts each turn's permit in its place.
                auth: {
                  kind: "egress_token",
                  token: permitKey,
                  transport: deps.relay.url,
                },
              },
            },
            bundle: {
              instructions: [],
              repoInstructions: null,
              mcpServers: [],
              localToolServers: [
                deps.tools.server(permitKey, turnDecisionTools(turn)),
              ],
            },
          });
      let session: TopicSession;
      try {
        session = continued
          ? live
          : await sessions.open(topicId, start, startedFor(turn));
      } catch {
        return { outcome: "failed", reason: "runtime_failed" };
      }
      const { run } = session;
      const sent = continued ? turn.input : turn.fresh_input;
      deps.tools.hold(session.permitKey, turn);
      deps.relay.hold(session.permitKey, turn.provider.auth.token);
      // The first cut is the turn's reason; the abort that follows it ends
      // the engine's events with a turn.ended of its own.
      let cut: ConversationTurnLimit | "interrupted" | null = null;
      const cutAt = (why: ConversationTurnLimit | "interrupted") => {
        if (cut !== null) return;
        cut = why;
        run.abort();
      };
      const timer = setTimeout(() => cutAt("time_limit"), limitMs);
      const onStop = () => cutAt("interrupted");
      if (stop.aborted) onStop();
      else stop.addEventListener("abort", onStop, { once: true });
      const failed = (
        reason: Extract<
          ConversationTurnResult,
          { outcome: "failed" }
        >["reason"],
        detail?: string,
      ): ConversationTurnResult => ({
        outcome: "failed",
        reason: cut ?? reason,
        ...(cut === null &&
        detail !== undefined &&
        /^[a-z0-9_]{1,64}$/.test(detail)
          ? { detail }
          : {}),
      });
      const play = async (): Promise<ConversationTurnResult> => {
        if (!continued) await run.ready();
        run.send({ message: sent.text, uuid: sent.id });
        let text = "";
        // Counted on the engine's events, not left to its settings: a provider
        // call is one provider message, each of whose blocks comes as an event
        // of its own and may come after another block's tool result. Without
        // a message id, a call is the model speaking after the turn began or
        // after tool results went back to it.
        let modelCalls = 0;
        const providerMessages = new Set<string>();
        let awaitingCall = true;
        const toolCalls = new Set<string>();
        // Read turn by turn: the stream outlives this turn with its session.
        for (;;) {
          const next = await session.events.next();
          if (next.done === true) break;
          const event = next.value;
          if (event.type === "tool.called") {
            toolCalls.add(event.toolCallId);
            if (toolCalls.size > toolCallLimit) cutAt("tool_call_limit");
            // Its result could go nowhere but to a call past the limit.
            else if (modelCalls >= modelCallLimit) cutAt("model_call_limit");
            continue;
          }
          if (event.type === "approval.requested") {
            // Not reached in dontAsk; refused if an engine ever asks.
            await run.answer({
              localId: event.request.localId,
              inputHash: event.request.inputHash,
              kind: "selected",
              optionKind: "reject_once",
            });
            continue;
          }
          if (event.type === "public") {
            const kind = event.event.event;
            if (kind === "tool_result") awaitingCall = true;
            if (kind !== "assistant" && kind !== "tool_use") continue;
            const callId = providerMessageId(event.event.data);
            if (
              callId === null ? awaitingCall : !providerMessages.has(callId)
            ) {
              if (callId !== null) providerMessages.add(callId);
              awaitingCall = false;
              modelCalls += 1;
              if (modelCalls > modelCallLimit) cutAt("model_call_limit");
            }
            if (kind === "tool_use") continue;
            const neutral = eventCodec.withNeutralFields(event.event);
            const said = (neutral.data as { text?: unknown }).text;
            if (typeof said === "string") text += said;
            continue;
          }
          if (event.type !== "turn.ended") continue;
          if (event.turn.isError || event.turn.abortedByStop) {
            const engineWord = event.turn.failure?.reason;
            // The engine stopped at its own copy of the call limit first.
            if (engineWord === "error_max_turns") {
              return failed("model_call_limit");
            }
            return failed("engine_failed", engineWord);
          }
          if (cut !== null) return failed("engine_failed");
          // The one decision the control host accepted and recorded, reported for its log.
          const decision = deps.tools.decision(session.permitKey);
          return {
            outcome: "completed",
            text: text.slice(0, CONVERSATION_TURN_TEXT_MAX),
            ...(decision === undefined ? {} : { decision }),
          };
        }
        return failed("engine_failed");
      };
      let result: ConversationTurnResult;
      try {
        result = await play();
      } catch {
        // What the engine threw may quote the conversation; the reason is enough.
        result = failed("runtime_failed");
      } finally {
        clearTimeout(timer);
        stop.removeEventListener("abort", onStop);
        deps.relay.release(session.permitKey);
        deps.tools.release(session.permitKey);
      }
      if (result.outcome === "completed") {
        // The relay saw the request whole, the engine's own parts with it.
        session.bytes =
          Math.max(
            deps.relay.requestBytes(session.permitKey),
            session.bytes + bytesOf(sent.text),
          ) +
          Math.max(
            deps.relay.responseBytes(session.permitKey),
            bytesOf(result.text),
          );
        session.lastUsedAt = sessions.now();
      } else {
        // Where a failed or cut turn left the engine is not known. One that
        // will not end keeps its topic closed; the turn's own reason stands.
        await sessions.drop(topicId).catch(() => undefined);
      }
      return result;
    },
  };
}
