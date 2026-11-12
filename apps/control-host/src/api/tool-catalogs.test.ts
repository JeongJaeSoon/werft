import { describe, expect, test } from "bun:test";
import { installedToolCatalogs } from "@werft-ai/runtime-codecs";
import { installedToolCatalogView } from "./tool-catalogs.ts";

describe("the installed tool catalogs", () => {
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
