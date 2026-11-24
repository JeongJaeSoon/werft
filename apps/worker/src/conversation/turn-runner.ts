import {
  CONVERSATION_TOPIC_SESSION_MAX_BYTES,
  CONVERSATION_TURN_LIMIT_MS,
  CONVERSATION_TURN_TEXT_MAX,
  type ConversationRuntimeTurn,
  type ConversationTurnResult,
} from "@werft-ai/contracts";
import type { RuntimeModule } from "@werft-ai/runtime-core";
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

const utf8 = new TextEncoder();
// As a request body carries it: quoted and escaped.
const bytesOf = (text: string) => utf8.encode(JSON.stringify(text)).length;

// What a request adds around the next input: the two messages' own wrapping,
// and what the engine attaches to a prompt.
const TURN_OVERHEAD_BYTES = 1_024;

// The engine was started on one model, provider and output cap: a turn on
// others starts its own.
const startedFor = (turn: ConversationRuntimeTurn) =>
  JSON.stringify([
    turn.model,
    turn.provider.kind,
    turn.provider.endpoint,
    turn.call.max_tokens,
  ]);

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
  limitMs?: number;
  maxBytes?: number;
}): ConversationTurnRunner {
  const { builtinTools, eventCodec } = deps.runtime;
  if (builtinTools === undefined || eventCodec === undefined) {
    throw new Error(
      `The ${deps.runtime.descriptor.kind} runtime cannot serve conversation turns: it names no built-in tools to deny or reads no answer text`,
    );
  }
  const limitMs = deps.limitMs ?? CONVERSATION_TURN_LIMIT_MS;
  const maxBytes = deps.maxBytes ?? CONVERSATION_TOPIC_SESSION_MAX_BYTES;
  const { sessions } = deps;

  return {
    async run(turn, stop) {
      const topicId = turn.scope.topic_id;
      const live = await sessions.get(topicId);
      const continued = goesOn(live, turn, maxBytes);
      const start = (directory: TopicSession["directory"], permitKey: string) =>
        deps.runtime
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
              // One provider call: the turn's token covers no second one.
              maxTurns: 1,
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
      deps.relay.hold(session.permitKey, turn.provider.auth.token);
      let cut: "timed_out" | "interrupted" | null = null;
      const timer = setTimeout(() => {
        cut ??= "timed_out";
        run.abort();
      }, limitMs);
      const onStop = () => {
        cut ??= "interrupted";
        run.abort();
      };
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
        // Read turn by turn: the stream outlives this turn with its session.
        for (;;) {
          const next = await session.events.next();
          if (next.done === true) break;
          const event = next.value;
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
          if (event.type === "public" && event.event.event === "assistant") {
            const neutral = eventCodec.withNeutralFields(event.event);
            const said = (neutral.data as { text?: unknown }).text;
            if (typeof said === "string") text += said;
            continue;
          }
          if (event.type !== "turn.ended") continue;
          if (event.turn.isError || event.turn.abortedByStop) {
            return failed("engine_failed", event.turn.failure?.reason);
          }
          return cut === null
            ? {
                outcome: "completed",
                text: text.slice(0, CONVERSATION_TURN_TEXT_MAX),
              }
            : failed("engine_failed");
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
        // Where a failed or cut turn left the engine is not known.
        await sessions.drop(topicId);
      }
      return result;
    },
  };
}
