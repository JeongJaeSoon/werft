import { describe, expect, test } from "bun:test";

import type { ToolCatalogView } from "../api/tool-names.ts";
import { validateEngineSettingsAcrossCatalogs } from "./engine-settings-catalogs.ts";

const catalog = (
  id: string,
  tools: string[],
  aliases?: Record<string, string>,
): ToolCatalogView => ({
  id,
  tools: tools.map((name) => ({ name, boundary: "local" as const })),
  aliases,
});

const input = (deny: string[]) => ({
  permissions: { deny },
  auto_mode: {},
});

describe("validateEngineSettingsAcrossCatalogs", () => {
  test("accepts rules every catalog reads the same way", () => {
    const result = validateEngineSettingsAcrossCatalogs(
      [catalog("a", ["Read", "Bash"]), catalog("b", ["Read", "Bash"])],
      input(["Read"]),
      "workspace",
    );
    expect(result).toEqual({
      settings: { permissions: { deny: ["Read"] }, auto_mode: {} },
    });
  });

  test("refuses what any one catalog refuses", () => {
    const result = validateEngineSettingsAcrossCatalogs(
      [catalog("a", ["Read", "Bash"]), catalog("b", ["Read"])],
      input(["Bash"]),
      "agent",
    );
    expect("refusal" in result).toBe(true);
  });

  test("refuses a rule that two catalogs store differently", () => {
    const result = validateEngineSettingsAcrossCatalogs(
      [catalog("old", ["Old"]), catalog("new", ["New"], { Old: "New" })],
      input(["Old"]),
      "workspace",
    );
    expect(result).toMatchObject({
      refusal: { reason_code: "engine_settings_catalog_ambiguous" },
    });
  });

  test("refuses when no catalog is installed rather than storing unchecked", () => {
    const result = validateEngineSettingsAcrossCatalogs(
      [],
      input([]),
      "workspace",
    );
    expect(result).toMatchObject({
      refusal: { reason_code: "engine_settings_catalog_unavailable" },
    });
  });

  test("an empty rule set is valid and stored as empty lists", () => {
    const result = validateEngineSettingsAcrossCatalogs(
      [catalog("a", ["Read"])],
      { permissions: {}, auto_mode: {} },
      "agent",
    );
    expect(result).toEqual({ settings: { permissions: {}, auto_mode: {} } });
  });
});
