import {
  CONVERSATION_TURN_LIMIT_MS,
  CONVERSATION_TURN_MODEL_CALL_LIMIT,
  CONVERSATION_TURN_TEXT_MAX,
  CONVERSATION_TURN_TOOL_CALL_LIMIT,
  type ConversationRuntimeTurn,
  type ConversationTurnLimit,
  type ConversationTurnResult,
} from "@werft-ai/contracts";
import type { RuntimeModule } from "@werft-ai/runtime-core";
import type { TopicDirectories } from "./topic-directories.ts";

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

/** The provider's id for the message an event's block is from, when it gave one. */
function providerMessageId(data: unknown): string | null {
  const message = (data as { message?: { id?: unknown } } | null)?.message;
  return typeof message?.id === "string" && message.id !== ""
    ? message.id
    : null;
}

/**
 * A turn runs in its topic's directory, on a fresh engine process: the
 * engine reads its provider token, the turn's permit, once at start. Each
 * provider call goes to the egress proxy with it, and the proxy adds the
 * credential this process never holds.
 */
export function createConversationTurnRunner(deps: {
  runtime: RuntimeModule;
  /** The egress proxy's credential listener. */
  egressCredentialUrl: string;
  topics: TopicDirectories;
  limitMs?: number;
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
  const modelCallLimit =
    deps.modelCallLimit ?? CONVERSATION_TURN_MODEL_CALL_LIMIT;
  const toolCallLimit = deps.toolCallLimit ?? CONVERSATION_TURN_TOOL_CALL_LIMIT;

  return {
    async run(turn, stop) {
      const directory = await deps.topics.open(turn.scope.topic_id);
      const run = deps.runtime
        .createRuntime({
          stateDir: directory.stateDir,
          // The token is bound to its first request: a retry is another, refused.
          providerMaxRetries: 0,
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
            tools: CONVERSATION_BUILTIN_TOOLS,
            disallowedTools: builtinTools,
            // The engine's own stop at the call limit, behind the count below.
            maxTurns: modelCallLimit,
            maxOutputTokens: turn.call.max_tokens,
          },
          bindings: {
            principal: { ownerScope: turn.scope.workspace_id },
            provider: {
              kind: turn.provider.kind,
              endpoint: turn.provider.endpoint,
              auth: {
                kind: "egress_token",
                token: turn.provider.auth.token,
                transport: `${deps.egressCredentialUrl.replace(/\/$/, "")}/provider`,
              },
            },
          },
          bundle: { instructions: [], repoInstructions: null, mcpServers: [] },
        });
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
      try {
        await run.ready();
        run.send({ message: turn.input.text, uuid: turn.input.id });
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
        for await (const event of run.events()) {
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
          return cut === null
            ? {
                outcome: "completed",
                text: text.slice(0, CONVERSATION_TURN_TEXT_MAX),
              }
            : failed("engine_failed");
        }
        return failed("engine_failed");
      } catch {
        // What the engine threw may quote the conversation; the reason is enough.
        return failed("runtime_failed");
      } finally {
        clearTimeout(timer);
        stop.removeEventListener("abort", onStop);
        run.finishInput();
        await run.close().catch(() => undefined);
      }
    },
  };
}
