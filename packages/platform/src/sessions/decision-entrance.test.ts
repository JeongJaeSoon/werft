import { expect, test } from "bun:test";
import type { PushActor } from "../action/change-request/push-decision.ts";
import type { PushRequestService } from "../action/change-request/push-request-service.ts";
import type {
  PendingAnswerEntrance,
  PushDecisionEntrance,
} from "../decision/index.ts";
import type { PendingRequestService } from "../decision/pending-service.ts";
import type { Caller } from "../musterrolle/policy.ts";

// Compile-time proof: the services the channels call are the entrances
// decision/index.ts names. Drifting either signature breaks the typecheck.
type Implements<Service, Entrance> = Service extends Entrance ? true : false;
const pending: Implements<
  PendingRequestService,
  PendingAnswerEntrance<Caller>
> = true;
const push: Implements<
  PushRequestService,
  PushDecisionEntrance<PushActor>
> = true;

test("the pending and push services are the decision entrances", () => {
  expect([pending, push]).toEqual([true, true]);
});
