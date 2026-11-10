/**
 * The Claude checkpoint manifest codec, in a package of its own so the control
 * plane can decode and validate manifests without depending on the Claude
 * Agent SDK: the API image is built without it (apps/control-host/Dockerfile), and the
 * adapter package that runs the SDK declares it. Everything that needs the
 * runtime's configuration (the profile fingerprint) stays in the adapter.
 * The manifest body is the one every engine shares (runtime-codec-kit
 * `createCheckpointCodec`); only the engine's name is Claude's.
 */
import {
  createCheckpointCodec,
  sha256Hex,
  validateCompatibility,
} from "@werft-ai/runtime-codec-kit";
import type { CheckpointCodec } from "@werft-ai/runtime-core";

import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION } from "./versions.ts";

export const CLAUDE_CHECKPOINT_ENGINE = "claude";

export const CLAUDE_RUNTIME_FINGERPRINT = {
  cliVersion: CLAUDE_CODE_VERSION,
  engine: CLAUDE_CHECKPOINT_ENGINE,
  sdkVersion: CLAUDE_AGENT_SDK_VERSION,
} as const;

export const claudeCheckpointCodec: CheckpointCodec = createCheckpointCodec({
  engine: CLAUDE_CHECKPOINT_ENGINE,
  label: "Claude",
});

export const encodeCheckpointManifest = claudeCheckpointCodec.encode;
export const decodeCheckpointManifest = claudeCheckpointCodec.decode;
export { sha256Hex, validateCompatibility };
