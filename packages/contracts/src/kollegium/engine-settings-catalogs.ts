import type { ToolCatalogView } from "../api/tool-names.ts";
import {
  type EngineSettingsRefusal,
  type EngineSettingsSource,
  type StoredEngineSettings,
  validateEngineSettings,
} from "./engine-settings-storage.ts";

export type EngineSettingsAcrossCatalogsRefusal =
  | EngineSettingsRefusal
  | {
      readonly reason_code:
        | "engine_settings_catalog_ambiguous"
        | "engine_settings_catalog_unavailable";
      readonly rule: "";
      readonly message: string;
    };

/**
 * A save is judged against every installed catalog, not the one an agent's
 * release happens to name: the saved rules also reach sessions of older
 * releases, and the claim path does not look at a catalog again. A rule must
 * parse in all of them and be stored the same way by all of them; one that a
 * catalog would rename (an older tool name) is refused when another keeps its
 * spelling, because the stored text could then mean different tools.
 */
export function validateEngineSettingsAcrossCatalogs(
  catalogs: readonly ToolCatalogView[],
  input: unknown,
  source: EngineSettingsSource,
):
  | { readonly settings: StoredEngineSettings }
  | { readonly refusal: EngineSettingsAcrossCatalogsRefusal } {
  let agreed: { settings: StoredEngineSettings; json: string } | undefined;
  for (const catalog of catalogs) {
    const checked = validateEngineSettings(catalog, input, source);
    if ("refusal" in checked) return checked;
    const json = JSON.stringify(checked.settings);
    if (agreed === undefined) {
      agreed = { settings: checked.settings, json };
    } else if (agreed.json !== json) {
      return {
        refusal: {
          reason_code: "engine_settings_catalog_ambiguous",
          rule: "",
          message:
            "The installed tool catalogs read these rules as different tools",
        },
      };
    }
  }
  if (agreed === undefined) {
    return {
      refusal: {
        reason_code: "engine_settings_catalog_unavailable",
        rule: "",
        message: "No tool catalog is installed to check the rules against",
      },
    };
  }
  return { settings: agreed.settings };
}
