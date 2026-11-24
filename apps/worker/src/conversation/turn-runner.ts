import {
  CONVERSATION_TURN_LIMIT_MS,
  CONVERSATION_TURN_TEXT_MAX,
  type ConversationRuntimeTurn,
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

/**
 * A turn runs in its topic's directory, on a fresh engine process: the
 * engine reads its provider token once at start, and a turn's token is good
 * for one call. Its provider call goes to the egress proxy with that token,
 * and the proxy adds the credential this process never holds.
 */
export function createConversationTurnRunner(deps: {
  runtime: RuntimeModule;
  /** The egress proxy's credential listener. */
  egressCredentialUrl: string;
  topics: TopicDirectories;
  limitMs?: number;
}): ConversationTurnRunner {
  const { builtinTools, eventCodec } = deps.runtime;
  if (builtinTools === undefined || eventCodec === undefined) {
    throw new Error(
      `The ${deps.runtime.descriptor.kind} runtime cannot serve conversation turns: it names no built-in tools to deny or reads no answer text`,
    );
  }
  const limitMs = deps.limitMs ?? CONVERSATION_TURN_LIMIT_MS;

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
            // One provider call: the turn's token covers no second one.
            maxTurns: 1,
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
      try {
        await run.ready();
        run.send({ message: turn.input.text, uuid: turn.input.id });
        let text = "";
        for await (const event of run.events()) {
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
