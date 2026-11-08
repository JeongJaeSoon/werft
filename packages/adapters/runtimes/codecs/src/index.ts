import {
  type BuiltinToolCatalog,
  CLAUDE_DESCRIPTOR,
  CLAUDE_TOOL_CATALOGS,
  claudeCheckpointCodec,
  claudeEventCodec,
} from "@werft-ai/runtime-claude-codec";
import type {
  CheckpointCodec,
  EventCodec,
  RuntimeDescriptor,
} from "@werft-ai/runtime-core";

export const installedCheckpointCodecs: readonly CheckpointCodec[] = [
  claudeCheckpointCodec,
];

export const installedDescriptors: readonly RuntimeDescriptor[] = [
  CLAUDE_DESCRIPTOR,
];

export const installedEventCodecs: readonly EventCodec[] = [claudeEventCodec];

export const installedToolCatalogs: readonly BuiltinToolCatalog[] = [
  ...CLAUDE_TOOL_CATALOGS,
];

export {
  type BuiltinTool,
  type BuiltinToolCatalog,
  canonicalToolName,
  equivalentToolCatalogVersions,
  legacyToolNames,
  type ToolBoundary,
  toolCatalogFor,
} from "@werft-ai/runtime-claude-codec";
