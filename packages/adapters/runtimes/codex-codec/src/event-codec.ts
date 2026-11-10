import { createV1EventCodec } from "@werft-ai/runtime-codec-kit";
import type { EventCodec } from "@werft-ai/runtime-core";

import { CODEX_DESCRIPTOR } from "./descriptor.ts";

// What the Codex adapter's mapper writes when a turn names no thread.
const UNKNOWN_SESSION = "unknown-thread";

export const codexEventCodec: EventCodec = createV1EventCodec({
  kind: CODEX_DESCRIPTOR.kind,
  unknownSession: UNKNOWN_SESSION,
});
