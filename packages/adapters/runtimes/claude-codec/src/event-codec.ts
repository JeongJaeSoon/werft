import { createV1EventCodec } from "@werft-ai/runtime-codec-kit";
import type { EventCodec } from "@werft-ai/runtime-core";

import { CLAUDE_DESCRIPTOR } from "./descriptor.ts";

// What the Claude adapter's mapper (runtime-claude mapper.ts) writes for an
// engine session it did not learn the id of.
const UNKNOWN_SESSION = "unknown-session";

export const claudeEventCodec: EventCodec = createV1EventCodec({
  kind: CLAUDE_DESCRIPTOR.kind,
  unknownSession: UNKNOWN_SESSION,
});
