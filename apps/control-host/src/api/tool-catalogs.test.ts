import { describe, expect, test } from "bun:test";
import { canonicalTool } from "@werft-ai/contracts";
import {
  canonicalToolName,
  installedToolCatalogs,
} from "@werft-ai/runtime-codecs";
import { installedToolCatalogView } from "./tool-catalogs.ts";

describe("the installed tool catalogs", () => {
  test("contracts reads an old name as the runtime codecs do", () => {
    for (const catalog of installedToolCatalogs) {
      const names = [
        ...Object.keys(catalog.aliases),
        ...catalog.tools.map((tool) => tool.name),
        "TodoWrite",
        "hasOwnProperty",
        "mcp__github__get_file",
      ];
      for (const name of names) {
        expect(canonicalTool(catalog, name)).toBe(
          canonicalToolName(catalog, name),
        );
      }
    }
  });

  test("finds a runtime's catalog by either spelling of its runtime version", () => {
    for (const catalog of installedToolCatalogs) {
      for (const version of [catalog.sdkVersion, catalog.engineVersion]) {
        expect(
          installedToolCatalogView.for(catalog.runtimeKind, version)?.id,
        ).toBe(catalog.id);
      }
    }
    expect(
      installedToolCatalogView.for("claude_agent_sdk", "0.0.1"),
    ).toBeUndefined();
  });
});
