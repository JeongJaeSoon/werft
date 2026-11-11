// The entrance other platform domains import (A2 in package-structure.md):
// only the names other domains use, not a barrel over the directory.
export type { CallerLimitDimension } from "./caller-limit.ts";
export {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  type Principal,
  receiptActorOf,
} from "./policy.ts";
export { ACTOR_INACTIVE, NOT_FOUND, OUTRANKED } from "./service-errors.ts";
