import type { Principal } from "../../musterrolle/index.ts";

export type StopQueuedInput = {
  principal: Principal;
  sessionId: string;
  /** The stop request's key: a retry under it replays the first result. */
  idempotencyKey: string;
};

export type StopQueuedResult =
  | { outcome: "not_found" }
  | { outcome: "closed" }
  | {
      outcome: "cancelled";
      /** How many queued turns were cancelled. */
      cancelled: number;
      /** The turn running now, the one to interrupt; null for none. */
      runningTurnId: string | null;
      /**
       * The stop closed the session: a task whose first turn never started,
       * so nothing is left to carry on.
       */
      closed: boolean;
    };

export interface SessionStops {
  /**
   * Cancels the session's queued input in one transaction, and names the
   * turn still running. A turn that carries on a
   * parked one is the platform's, not queued input, and stays.
   */
  cancelQueued(input: StopQueuedInput): Promise<StopQueuedResult>;
}
