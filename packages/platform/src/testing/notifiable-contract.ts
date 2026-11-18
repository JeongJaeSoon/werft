import type { ClaimedOutboxRow } from "../surface/ports/delivery.ts";
import type { Notifiable } from "../surface/ports/notifiable.ts";
import {
  type DeliverySubject,
  describeDeliveryContract,
} from "./delivery-contract.ts";

export type NotifiableSubject<Row = ClaimedOutboxRow> = DeliverySubject<Row> & {
  notifiable: Notifiable<Row>;
};

/**
 * What every `Notifiable` promises: a notice row (`notice`, `failure_notice`,
 * `action_notice`, `model_notice`) ends as one of the five `DeliveryOutcome`s
 * the way the channel's answer says, and `notify` never throws for a send.
 */
export function describeNotifiableContract<Row>(
  make: () => Promise<NotifiableSubject<Row>>,
) {
  describeDeliveryContract(
    "Notifiable",
    ["notice", "failure_notice", "action_notice", "model_notice"],
    async () => {
      const subject = await make();
      return { subject, deliver: (input) => subject.notifiable.notify(input) };
    },
  );
}
