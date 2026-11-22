// The entrance other platform domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.
export type {
  CheckpointRequestDecision,
  PushBundlesResult,
  PushSourceResult,
  RestoreFallback,
  RestorePlan,
  RestorePlanResult,
  SessionOutputBodyResult,
  SessionOutputsResult,
} from "./checkpoint-service.ts";
export { sessionObjectPrefix } from "./checkpoint-service.ts";
export { own } from "./checkpoint-support.ts";
export { checkpointPendingReason } from "./durability.ts";
