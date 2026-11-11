import type { ControlAcceptedResponse } from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";

export type InterruptTurnInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  targetTurnId: string;
};

export type InterruptTurnResult =
  // `accepted` is still waiting on the worker; a turn already terminal comes
  // back `accepted` too, with a receipt that has already succeeded as a no-op.
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  // Queued input is not an interrupt target: it has not started, and an
  // interrupt never cancels input.
  | { outcome: "not_started" }
  // Running on the legacy pod lifecycle, whose worker never polls for control.
  | { outcome: "unsupported" };

/**
 * api.md § 승인·중단·강제 종료: an interrupt is bound to its target turn and
 * the attempt running it, and it reaches nothing else. It is settled by the
 * transaction that gives that turn its terminal.
 */
export interface TurnInterrupts {
  interruptAtomic(input: InterruptTurnInput): Promise<InterruptTurnResult>;
}
