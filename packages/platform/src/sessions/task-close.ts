import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "../musterrolle/index.ts";
import type {
  RequesterCloseReason,
  TaskCloseOutcome,
  TaskCloses,
} from "./ports/task-closes.ts";

/**
 * A task closed by its requester (v1-b/C1), whichever way it was asked
 * for. Whoever may control the session may close it, as for a stop: its
 * requester, or anyone it lets write to it.
 */
export function createTaskClose(deps: {
  authorization: AuthorizationPolicy;
  closes: Pick<TaskCloses, "close">;
}) {
  return {
    async close(
      actor: Caller,
      sessionId: string,
      reason: RequesterCloseReason,
    ): Promise<TaskCloseOutcome | "not_permitted"> {
      try {
        await requirePermitted(deps.authorization, actor, "session.control", {
          kind: "session",
          id: sessionId,
        });
      } catch (error) {
        // NOT_FOUND is how the policy refuses someone the session is hidden from.
        if (
          error instanceof SessionServiceError &&
          (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
        ) {
          return "not_permitted";
        }
        throw error;
      }
      return deps.closes.close({ principal: actor, sessionId, reason });
    },
  };
}

export type TaskClose = ReturnType<typeof createTaskClose>;
