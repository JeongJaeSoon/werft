import type {
  ClaimedOutboxRow,
  DeliveryInput,
  DeliveryOutcome,
} from "./delivery.ts";

/** Tells a person the result of something, in the channel they are in. */
export interface Notifiable<Row = ClaimedOutboxRow> {
  /**
   * Delivers one notice row (`notice`, `failure_notice`, `action_notice`,
   * `model_notice`). Never throws for a send: a request that may have gone
   * out comes back `uncertain`.
   */
  notify(input: DeliveryInput<Row>): Promise<DeliveryOutcome>;
}
