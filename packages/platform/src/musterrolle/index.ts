// The entrance other platform domains import (A2 in package-structure.md):
// only the names other domains use, not a barrel over the directory.
export type { CallerLimitDimension } from "./caller-limit.ts";
export {
  type AuthorizationPolicy,
  type Caller,
  deciderKeyOf,
  MANAGEMENT_ROLES,
  type OutsideAgentAccess,
  type OutsideAgentAccessSetting,
  outsideAgentsUse,
  type Principal,
  receiptActorOf,
} from "./policy.ts";
export {
  agentPrivateError,
  isAgentPrivate,
  requireAllowed,
  requirePermitted,
} from "./require-permitted.ts";
export {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
  SessionServiceError,
  TEAM_HOLDING,
  TEAM_NOT_ALLOWED,
  TEAM_NOT_FOUND,
} from "./service-errors.ts";
