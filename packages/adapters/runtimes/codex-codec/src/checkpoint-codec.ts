import { createCheckpointCodec } from "@werft-ai/runtime-codec-kit";
import type { CheckpointCodec } from "@werft-ai/runtime-core";

import { CODEX_CLI_VERSION } from "./versions.ts";

export const CODEX_CHECKPOINT_ENGINE = "codex";

export const CODEX_RUNTIME_FINGERPRINT = {
  cliVersion: CODEX_CLI_VERSION,
  engine: CODEX_CHECKPOINT_ENGINE,
  sdkVersion: CODEX_CLI_VERSION,
} as const;

export const codexCheckpointCodec: CheckpointCodec = createCheckpointCodec({
  engine: CODEX_CHECKPOINT_ENGINE,
  label: "Codex",
});
