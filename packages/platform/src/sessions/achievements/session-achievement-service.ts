import type {
  ListSessionAchievementsResponse,
  RejudgeSessionResponse,
  ReviewAchievementRequest,
  ReviewAchievementResponse,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  SessionServiceError,
} from "../../musterrolle/index.ts";
import type { TeamActor } from "../../ports/team-store.ts";
import type { AchievementJudgmentStore } from "./achievement-judgment-store.ts";

function personOf(caller: Caller, refusal: string): TeamActor {
  const userId = caller.actor?.userId;
  const workspaceId = caller.actor?.workspaceId;
  if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
    throw new SessionServiceError("FORBIDDEN", refusal, undefined, {
      reason_code: "role",
    });
  }
  return { principal: caller, workspaceId, userId };
}

/**
 * A session's achievements and its latest judgment, its manual rejudge, and
 * a person's review of one achievement.
 */
export function createSessionAchievementService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<AchievementJudgmentStore, "list" | "rejudge" | "find" | "review">;
  newId?: () => string;
}) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  return {
    async list(
      caller: Caller,
      rawSessionId: string,
    ): Promise<ListSessionAchievementsResponse> {
      const sessionId = rawSessionId.toLowerCase();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const listed = await deps.store.list(caller.ownerId, sessionId);
      if (listed === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return listed;
    },

    /**
     * Owners, admins and the agent's admins who can read the session; a
     * person, never a key.
     */
    async review(
      caller: Caller,
      rawAchievementId: string,
      request: ReviewAchievementRequest,
    ): Promise<ReviewAchievementResponse> {
      const achievementId = rawAchievementId.toLowerCase();
      const found = await deps.store.find(caller.ownerId, achievementId);
      if (found === null) throw NOT_FOUND();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: found.sessionId,
      });
      await requirePermitted(deps.authorization, caller, "achievement.review", {
        kind: "agent",
        id: found.agentId,
      });
      const actor = personOf(
        caller,
        "Only a signed-in person reviews an achievement",
      );
      const receiptId = newId();
      const result = await deps.store.review({
        actor,
        achievementId,
        action: request.action,
        note: request.note ?? null,
        receiptId,
      });
      switch (result.outcome) {
        case "reviewed":
          return { achievement: result.achievement, receipt_id: receiptId };
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        case "not_reviewable":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            request.action === "confirm"
              ? "Only an achievement that needs review can be confirmed"
              : "This achievement was already reviewed",
            undefined,
            { reason_code: "not_reviewable" },
          );
      }
    },

    /** Owners and admins who can read the session; a person, never a key. */
    async rejudge(
      caller: Caller,
      rawSessionId: string,
    ): Promise<RejudgeSessionResponse> {
      const sessionId = rawSessionId.toLowerCase();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      await requirePermitted(
        deps.authorization,
        caller,
        "achievement_rule.manage",
        { kind: "workspace", id: caller.ownerId },
      );
      const actor = personOf(
        caller,
        "Only a signed-in person rejudges a session",
      );
      const receiptId = newId();
      const result = await deps.store.rejudge({
        actor,
        sessionId,
        receiptId,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        default:
          return { judgment_id: result.judgmentId, receipt_id: receiptId };
      }
    },
  };
}

export type SessionAchievementService = ReturnType<
  typeof createSessionAchievementService
>;
