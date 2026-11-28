import type { TaskClosedReason } from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";

/** The reasons a task's requester closes it with (v1-b/C1). */
export type RequesterCloseReason = Extract<
  TaskClosedReason,
  "completed" | "cancelled"
>;

/**
 * What closing a task did: `closing` while its worker drains, `closed`
 * at once; `refused` when the session may not close now (it needs a
 * recovery decision, has no checkpoint to end on, or runs on a legacy pod).
 */
export type TaskCloseOutcome =
  | "closing"
  | "closed"
  | "already_closed"
  | "not_task"
  | "not_found"
  | "refused";

export interface TaskCloses {
  /** Closes a task for its requester with the reason they chose. */
  close(input: {
    principal: Principal;
    sessionId: string;
    reason: RequesterCloseReason;
  }): Promise<TaskCloseOutcome>;
  /**
   * Closes the open tasks whose pull requests settled, the event rules
   * of their closing rules on: completed once one merged; cancelled once
   * one closed and none is open or merged. Returns how many it closed.
   */
  closeOnPullRequests(limit: number): Promise<number>;
  /**
   * Closes as abandoned, at most `limit` of them, the open tasks their time
   * rules close: idle for the idle days of their closing rules, or quiet for
   * the quiet days once they reached their limits. Returns how many closes
   * it started: closed, or a drain accepted that settles later.
   */
  closeOnTimeRules(limit: number): Promise<number>;
}
