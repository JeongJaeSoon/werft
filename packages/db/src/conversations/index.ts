// The entrance other db domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.
export {
  lockSessionForSources,
  newTurnSources,
  outboxSources,
  recordSourceInput,
  sourceSetHoldsMark,
} from "./turn-sources.ts";
