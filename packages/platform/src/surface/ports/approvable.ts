import type { DeliveryInput, DeliveryOutcome } from "./delivery.ts";

/**
 * Puts a request a person must decide in front of them, in the channel's own
 * shape. The answer does not come back through this port: it enters the
 * decision service.
 */
export interface Approvable {
  /**
   * Delivers one decision-request row (`input_notice`) whose card is already
   * drawn. Never throws for a send: a request that may have gone out comes
   * back `uncertain`.
   */
  requestDecision(input: DeliveryInput): Promise<DeliveryOutcome>;
}
