import type { Principal } from "../../musterrolle/index.ts";

export type StopQueuedInput = {
  principal: Principal;
  sessionId: string;
  /** Queued input from before this moment is cancelled; later input stays. */
  queuedBefore: Date;
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
    };

export interface SessionStops {
  /**
   * Cancels the session's queued input from before `queuedBefore` in one
   * transaction, and names the turn still running. A turn that carries on a
   * parked one is the platform's, not queued input, and stays.
   */
  cancelQueuedBefore(input: StopQueuedInput): Promise<StopQueuedResult>;
}
