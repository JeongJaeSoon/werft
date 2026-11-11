import type { ToolCatalogView } from "@werft-ai/contracts";

/** A runtime's built-in tool catalog as the runtime codecs install it. */
export type InstalledToolCatalog = ToolCatalogView & {
  readonly runtimeKind: string;
  readonly sdkVersion: string;
  readonly engineVersion: string;
};

/**
 * The installed catalogs, and the runtime codecs' rule for which one a
 * runtime version reads (it may name the SDK or the engine build).
 */
export type ToolCatalogs = {
  readonly all: readonly InstalledToolCatalog[];
  for(
    runtimeKind: string,
    runtimeVersion: string,
  ): InstalledToolCatalog | undefined;
};
