import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "../access-control/index.ts";
import type { createInterruptService } from "./interrupt-service.ts";
import type { SessionStops } from "./ports/session-stops.ts";

export type SessionStopResult =
  /** The running turn was interrupted, or queued input cancelled, or both. */
  | {
      outcome: "stopped";
      interrupted: boolean;
      cancelled: number;
      /** A task stopped before its first turn, closed with it. */
      closed: boolean;
    }
  | { outcome: "nothing_running" }
  /**
   * The caller may not control the session, or may not see it: neither its
   * requester nor anyone it lets write to it.
   */
  | { outcome: "not_permitted" }
  | { outcome: "closed" };

/**
 * Stopping a session's work, whichever way it was asked for (a Slack
 * message, a web button, Slack's stop button): queued input from before the
 * request is cancelled, then the running turn is interrupted. The session
 * stays open and takes the next input as usual (decision 35).
 */
export function createSessionStop(deps: {
  authorization: AuthorizationPolicy;
  stops: SessionStops;
  interrupts: Pick<ReturnType<typeof createInterruptService>, "interrupt">;
}) {
  return {
    async stop(
      actor: Caller,
      sessionId: string,
      input: { idempotencyKey: string },
    ): Promise<SessionStopResult> {
      try {
        await requirePermitted(deps.authorization, actor, "session.control", {
          kind: "session",
          id: sessionId,
        });
      } catch (error) {
        // NOT_FOUND is how the policy refuses someone the session is hidden
        // from; retrying would only hold up the thread's later messages.
        if (
          error instanceof SessionServiceError &&
          (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
        ) {
          return { outcome: "not_permitted" };
        }
        throw error;
      }
      // Queued input first: once the running turn ends, the next one starts.
      const queued = await deps.stops.cancelQueued({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
      });
      if (queued.outcome === "not_found") {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (queued.outcome === "closed") return { outcome: "closed" };
      let interrupted = false;
      if (queued.runningTurnId !== null) {
        try {
          await deps.interrupts.interrupt(actor, sessionId, {
            idempotencyKey: input.idempotencyKey,
            body: { target_turn_id: queued.runningTurnId },
          });
          interrupted = true;
        } catch (error) {
          // Put back in the queue since it was read. (One that ended takes
          // the interrupt as a no-op receipt.)
          if (
            !(error instanceof SessionServiceError) ||
            error.code !== "TURN_NOT_STARTED"
          ) {
            throw error;
          }
        }
      }
      return interrupted || queued.cancelled > 0
        ? {
            outcome: "stopped",
            interrupted,
            cancelled: queued.cancelled,
            closed: queued.closed,
          }
        : { outcome: "nothing_running" };
    },

    /**
     * Whether the stop asked under `idempotencyKey` was already made in one
     * of these sessions: the request's message read again after its work
     * closed. It answers no one, so nothing is authorized.
     */
    stoppedBefore(
      sessionIds: readonly string[],
      input: { idempotencyKey: string },
    ): Promise<boolean> {
      if (sessionIds.length === 0) return Promise.resolve(false);
      return deps.stops.stoppedIn({
        sessionIds,
        idempotencyKey: input.idempotencyKey,
      });
    },
  };
}

export type SessionStop = ReturnType<typeof createSessionStop>;
