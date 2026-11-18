import type { Approvable } from "../surface/ports/approvable.ts";
import type { ClaimedOutboxRow } from "../surface/ports/delivery.ts";
import {
  type DeliverySubject,
  describeDeliveryContract,
} from "./delivery-contract.ts";

export type ApprovableSubject<Row = ClaimedOutboxRow> = DeliverySubject<Row> & {
  approvable: Approvable<Row>;
};

/**
 * What every `Approvable` promises: a decision-request row (`input_notice`,
 * its card already drawn) ends as one of the five `DeliveryOutcome`s the way
 * the channel's answer says, and `requestDecision` never throws for a send.
 * The answer to the request is not here: it enters the decision service.
 */
export function describeApprovableContract<Row>(
  make: () => Promise<ApprovableSubject<Row>>,
) {
  describeDeliveryContract("Approvable", ["input_notice"], async () => {
    const subject = await make();
    return {
      subject,
      deliver: (input) => subject.approvable.requestDecision(input),
    };
  });
}
