import {
  type BuiltinToolCatalog,
  CLAUDE_DESCRIPTOR,
  CLAUDE_TOOL_CATALOGS,
  claudeCheckpointCodec,
  claudeEventCodec,
} from "@werft-ai/runtime-claude-codec";
import {
  CODEX_DESCRIPTOR,
  codexCheckpointCodec,
  codexEventCodec,
} from "@werft-ai/runtime-codex-codec";
import type {
  CheckpointCodec,
  EventCodec,
  RuntimeDescriptor,
} from "@werft-ai/runtime-core";

export const installedCheckpointCodecs: readonly CheckpointCodec[] = [
  claudeCheckpointCodec,
  codexCheckpointCodec,
];

export const installedDescriptors: readonly RuntimeDescriptor[] = [
  CLAUDE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
];

export const installedEventCodecs: readonly EventCodec[] = [
  claudeEventCodec,
  codexEventCodec,
];

// Codex has no entry on purpose. A catalog is what the workspace's and the
// agent's deny rules name tools from, and the Codex adapter refuses a start
// that carries deny rules (the engine has none to enforce them with), so an
// entry would offer the console a control that fails at the session's first
// input. The engine's one tool is fixed by its adapter (`CODEX_BUILTIN_TOOLS`).
export const installedToolCatalogs: readonly BuiltinToolCatalog[] = [
  ...CLAUDE_TOOL_CATALOGS,
];

export {
  canonicalToolName,
  equivalentToolCatalogVersions,
  toolCatalogFor,
} from "@werft-ai/runtime-claude-codec";
