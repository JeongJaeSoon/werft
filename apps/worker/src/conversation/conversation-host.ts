import { writeFile } from "node:fs/promises";
import type {
  ConversationRuntimeTurn,
  ConversationTurnResult,
} from "@werft-ai/contracts";
import type { WorkerLogger } from "../console-logger.ts";
import { messageOf } from "../message-of.ts";
import type { TopicSessions } from "./topic-sessions.ts";
import type { ConversationTurnRunner } from "./turn-runner.ts";
import type { ConversationTurnSource } from "./turn-source.ts";

export type ConversationHostDeps = {
  source: ConversationTurnSource;
  runner: ConversationTurnRunner;
  sessions: TopicSessions;
  logger: WorkerLogger;
  /** Written after each answered poll; `main.ts --health` reads it. */
  statusFile?: string;
  /** How long to wait after a failed poll or report before the next try. */
  retryMs?: number;
  now?: () => number;
};

/**
 * The conversation runtime's loop: take a turn, run it in its topic's
 * session, report it. One turn at a time; between polls, sessions whose
 * topic has been idle for its lifetime are dropped, and at stop all are.
 */
export class ConversationHost {
  private readonly stopping = new AbortController();

  constructor(private readonly deps: ConversationHostDeps) {}

  /** Stops taking turns and cuts the one running; `run` returns once it is reported. */
  stop(reason: string): void {
    if (this.stopping.signal.aborted) return;
    this.deps.logger.info("conversation_runtime.stopping", { reason });
    this.stopping.abort();
  }

  async run(): Promise<void> {
    const { source, logger, sessions } = this.deps;
    const retryMs = this.deps.retryMs ?? 2_000;
    // What a process before this one left is no topic of this one's.
    await sessions.reset();
    logger.info("conversation_runtime.started");
    while (!this.stopping.signal.aborted) {
      let turn: ConversationRuntimeTurn | null;
      await this.sweep();
      try {
        turn = await source.next(this.stopping.signal);
        await this.touchStatus();
      } catch (error) {
        if (this.stopping.signal.aborted) break;
        logger.warn("conversation_runtime.poll_failed", {
          error: messageOf(error),
        });
        await this.pause(retryMs);
        continue;
      }
      if (turn === null) continue;
      await this.serve(turn);
    }
    await sessions.dropAll().catch((error) =>
      logger.error("conversation_runtime.sessions_not_dropped", {
        error: messageOf(error),
      }),
    );
    logger.info("conversation_runtime.stopped");
  }

  private async sweep(): Promise<void> {
    await this.deps.sessions.sweep().catch((error) =>
      this.deps.logger.error("conversation_runtime.sessions_not_swept", {
        error: messageOf(error),
      }),
    );
  }

  private async serve(turn: ConversationRuntimeTurn): Promise<void> {
    const { logger, runner } = this.deps;
    const now = this.deps.now ?? (() => performance.now());
    // Ids only: neither the input nor the answer is logged.
    const fields = {
      turn_id: turn.turn_id,
      lease_id: turn.lease_id,
      agent_id: turn.scope.agent_id,
      topic_id: turn.scope.topic_id,
      model: turn.model,
    };
    logger.info("conversation_turn.started", fields);
    const startedAt = now();
    let result: ConversationTurnResult;
    try {
      result = await runner.run(turn, this.stopping.signal);
    } catch (error) {
      logger.error("conversation_turn.runner_failed", {
        ...fields,
        error: messageOf(error),
      });
      result = { outcome: "failed", reason: "runtime_failed" };
    }
    logger.info("conversation_turn.ended", {
      ...fields,
      outcome: result.outcome,
      ...(result.outcome === "failed"
        ? { reason: result.reason, detail: result.detail }
        : {}),
      duration_ms: Math.round(now() - startedAt),
    });
    await this.report(turn, result, fields);
  }

  /**
   * Until the control host has it or says it will not take it. A report that
   * cannot arrive is given up at the lease's end, when the control host has
   * closed the turn itself.
   */
  private async report(
    turn: ConversationRuntimeTurn,
    result: ConversationTurnResult,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const retryMs = this.deps.retryMs ?? 2_000;
    const leaseEnds = Date.parse(turn.lease_expires_at);
    for (;;) {
      try {
        const reported = await this.deps.source.report(turn, result);
        this.deps.logger.info("conversation_turn.reported", {
          ...fields,
          reported,
        });
        return;
      } catch (error) {
        if (Date.now() >= leaseEnds) {
          this.deps.logger.error("conversation_turn.report_abandoned", {
            ...fields,
            error: messageOf(error),
          });
          return;
        }
        this.deps.logger.warn("conversation_turn.report_failed", {
          ...fields,
          error: messageOf(error),
        });
        await Bun.sleep(retryMs);
      }
    }
  }

  private async touchStatus(): Promise<void> {
    if (this.deps.statusFile === undefined) return;
    await writeFile(
      this.deps.statusFile,
      JSON.stringify({ polled_at: new Date().toISOString() }),
    ).catch(() => undefined);
  }

  /** A wait the stop cuts short. */
  private async pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const signal = this.stopping.signal;
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
