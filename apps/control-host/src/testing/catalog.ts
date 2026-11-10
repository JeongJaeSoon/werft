import {
  TEST_CONNECTION_ID,
  TEST_MODEL,
  testSessionCatalog,
} from "@werft-ai/db/testing/spec-pins";
import type { SessionCatalog, ToolCatalogs } from "@werft-ai/platform";
import { installedRuntimeVersions } from "../api/catalog-config.ts";
import { installedToolCatalogView } from "../api/tool-catalogs.ts";

export { TEST_CONNECTION_ID, TEST_MODEL };

/** The runtime versions this image ships, as the API hands the agent service. */
export const TEST_RUNTIMES = installedRuntimeVersions;

/**
 * A catalog whose one connection (`TEST_CONNECTION_ID`) offers `models`,
 * with this image's tool catalogs so a release on it can be made.
 */
export function testCatalog(
  input: Parameters<typeof testSessionCatalog>[0] = { repositories: {} },
): SessionCatalog & { tool_catalogs: ToolCatalogs } {
  return {
    ...testSessionCatalog(input),
    tool_catalogs: installedToolCatalogView,
  };
}
