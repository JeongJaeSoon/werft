// The entrance other platform domains import (A2 in package-structure.md):
// only the names github/ uses, not a barrel over the directory.
export {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  type Principal,
  receiptActorOf,
} from "./policy.ts";
export { ACTOR_INACTIVE, NOT_FOUND, OUTRANKED } from "./service-errors.ts";
