import type { Notifiable } from "../surface/ports/notifiable.ts";
import {
  type DeliverySubject,
  describeDeliveryContract,
} from "./delivery-contract.ts";

export type NotifiableSubject = DeliverySubject & { notifiable: Notifiable };

/**
 * What every `Notifiable` promises: a notice row (`notice`, `failure_notice`,
 * `action_notice`, `model_notice`) ends as one of the five `DeliveryOutcome`s
 * the way the channel's answer says, and `notify` never throws for a send.
 */
export function describeNotifiableContract(
  make: () => Promise<NotifiableSubject>,
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
