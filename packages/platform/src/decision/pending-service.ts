import type {
  ListPendingRequestsResponse,
  PostSessionAnswerRequest,
  PostSessionAnswerResponse,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  deciderKeyOf,
} from "../musterrolle/policy.ts";
import type {
  PendingRequestOutcome,
  PendingRequestStore,
} from "../ports/pending-requests.ts";
import {
  idempotencyConflict,
  payloadHash,
  requireAllowed,
  requirePermitted,
  SessionServiceError,
  selfApproval,
} from "../sessions/index.ts";

// api.md § 승인·중단·강제 종료. Kept apart from the session service so the
// answer path owns its own error vocabulary: REQUEST_EXPIRED and
// REQUEST_STALE mean nothing to any other session command.
export function createPendingRequestService(deps: {
  authorization: AuthorizationPolicy;
  store: PendingRequestStore;
}) {
  const { authorization, store } = deps;

  return {
    async listPendingRequests(
      actor: Caller,
      sessionId: string,
    ): Promise<ListPendingRequestsResponse> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const items = await store.listOpen(actor.ownerId, sessionId);
      if (items === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      const answer = await authorization
        .authorize(
          {
            subject: actor.subject,
            action: "session.approve",
            resource: {
              kind: "session",
              id: sessionId,
              owner_scope: actor.ownerId,
            },
            request_id: actor.requestId,
          },
          { record: false },
        )
        .catch(() => null);
      return { items, answerable: answer?.outcome === "allow" };
    },

    async outcome(
      actor: Caller,
      sessionId: string,
      requestId: string,
    ): Promise<PendingRequestOutcome | null> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      return store.requestOutcome(actor.ownerId, sessionId, requestId);
    },

    async answer(
      actor: Caller,
      sessionId: string,
      input: { idempotencyKey: string; body: PostSessionAnswerRequest },
    ): Promise<PostSessionAnswerResponse> {
      const decision = await requireAllowed(
        authorization,
        actor,
        "session.approve",
        { kind: "session", id: sessionId },
      ).catch(async (error: unknown) => {
        if (!selfApproval(error)) throw error;
        const receiptId = await store.recordSelfApproval({
          principal: actor,
          sessionId,
          requestId: input.body.request_id,
          deciderKey: deciderKeyOf(actor),
        });
        const refusal = error as SessionServiceError;
        throw new SessionServiceError(
          refusal.code,
          refusal.message,
          undefined,
          {
            reason_code: "self_approval",
            receipt_id: receiptId,
          },
        );
      });
      const result = await store.answerAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        answer: input.body,
        approval: {
          surface: actor.subject.surface.kind,
          decisionId: decision.decision_id,
        },
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "expired":
          throw new SessionServiceError(
            "REQUEST_EXPIRED",
            "The request is already answered, expired or closed",
          );
        case "stale":
          throw new SessionServiceError(
            "REQUEST_STALE",
            "The attempt that asked no longer owns the session",
          );
        case "invalid":
          throw new SessionServiceError("BAD_REQUEST", result.reason);
        case "recovery_required":
          throw new SessionServiceError(
            "RECOVERY_REQUIRED",
            result.unconfirmedTurnId === null
              ? "The session waits for an operator recovery decision before the parked turn can resume"
              : `Turn ${result.unconfirmedTurnId} has an unknown outcome; an operator recovery decision is required before the parked turn can resume`,
          );
        case "checkpoint_unavailable":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "The session has no checkpoint the parked turn can resume from",
          );
        case "actor_inactive":
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
        case "role":
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal holds sessions:approve but may not use it on this session",
            undefined,
            { reason_code: "role" },
          );
        default:
          return result.response;
      }
    },
  };
}

export type PendingRequestService = ReturnType<
  typeof createPendingRequestService
>;
