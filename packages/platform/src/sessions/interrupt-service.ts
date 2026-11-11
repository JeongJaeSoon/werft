import type {
  ControlAcceptedResponse,
  InterruptSessionRequest,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { TERMINATE_DEADLINE_MS } from "../scheduler/index.ts";
import type { TurnInterrupts } from "./ports/turn-interrupts.ts";
import {
  idempotencyConflict,
  payloadHash,
  requirePermitted,
  SessionServiceError,
} from "./session-service.ts";

/**
 * How long an accepted interrupt may stay unsettled before the reconciler
 * kills its execution. A worker takes it on its next control poll
 * (1s by default), gives the engine a 5s grace, then finalizes; this leaves
 * room for that finalize to retry through two heartbeat TTLs of trouble.
 */
export const INTERRUPT_SETTLE_DEADLINE_MS = 60_000;

/**
 * When an interrupt still unsettled is reported unknown: the kill above plus
 * the window a kill has to be observed in. The turn's terminal, if it comes
 * later, still settles the receipt.
 */
export const INTERRUPT_RECEIPT_DEADLINE_MS =
  INTERRUPT_SETTLE_DEADLINE_MS + TERMINATE_DEADLINE_MS;

export function createInterruptService(deps: {
  authorization: AuthorizationPolicy;
  store: TurnInterrupts;
}) {
  const { authorization, store } = deps;

  return {
    async interrupt(
      actor: Caller,
      sessionId: string,
      input: { idempotencyKey: string; body: InterruptSessionRequest },
    ): Promise<ControlAcceptedResponse> {
      await requirePermitted(authorization, actor, "session.control", {
        kind: "session",
        id: sessionId,
      });
      const result = await store.interruptAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        targetTurnId: input.body.target_turn_id,
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "not_started":
          throw new SessionServiceError(
            "TURN_NOT_STARTED",
            "The turn is still queued; only a running turn can be interrupted",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be interrupted",
          );
        default:
          return result.response;
      }
    },
  };
}

export type InterruptService = ReturnType<typeof createInterruptService>;
