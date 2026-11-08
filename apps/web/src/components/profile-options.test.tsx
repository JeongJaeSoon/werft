import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@werft-ai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, type Translate, translate } from "../i18n/i18n.tsx";
import {
  ProfileOptions,
  pickable,
  profileDisplay,
} from "./profile-options.tsx";

const ceiling = (
  id: string,
  state?: NonNullable<ProfileSummary["installation"]>["state"],
) =>
  ({
    id,
    source: "operator",
    ...(state === undefined ? {} : { installation: { state } }),
  }) as ProfileSummary;

const version = (
  id: string,
  state: NonNullable<ProfileSummary["workspace"]>["state"],
) => ({ id, source: "workspace", workspace: { state } }) as ProfileSummary;

describe("profile options", () => {
  test("only a usable ceiling or version is pickable; a ceiling with no state still is", () => {
    expect(
      [
        ceiling("old-server"),
        ceiling("a", "usable"),
        ceiling("b", "retired"),
        ceiling("c", "connection_missing"),
        version("ws_a", "usable"),
        version("ws_b", "base_retired"),
      ].map((profile) => [profile.id, pickable(profile)]),
    ).toEqual([
      ["old-server", true],
      ["a", true],
      ["b", false],
      ["c", false],
      ["ws_a", true],
      ["ws_b", false],
    ]);
  });

  test("profileDisplay names a listed profile and keeps the id for any other", () => {
    const named = {
      ...version("op_wl_d970266b_v1", "usable"),
      installation: { name: "readonly-review", version: 2, state: "usable" },
    } as ProfileSummary;
    const nameless = {
      ...ceiling("op_old_v1", "usable"),
      installation: { name: null, version: 1, state: "usable" },
    } as ProfileSummary;
    for (const locale of ["ko", "en", "ja"] as const) {
      const t: Translate = (key, vars) => translate(locale, key, vars);
      const show = (
        profiles: readonly ProfileSummary[] | undefined,
        id: string,
      ) => profileDisplay(t, profiles, id);
      expect(show([named, nameless], "op_wl_d970266b_v1")).toBe(
        "readonly-review v2",
      );
      expect(show([named, nameless], "op_old_v1")).toBe("op_old_v1");
      // Not listed, not loaded, or not readable by this role.
      expect(show([named], "ws_gone_v1")).toBe("ws_gone_v1");
      expect(show(undefined, "op_wl_d970266b_v1")).toBe("op_wl_d970266b_v1");
    }
  });

  test("a ceiling that cannot be picked is disabled and says why", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <select>
          <ProfileOptions
            profiles={[
              ceiling("live", "usable"),
              ceiling("gone", "retired"),
              ceiling("elsewhere", "runtime_unsupported"),
            ]}
            label={(profile) => profile.id}
          />
        </select>
      </I18nProvider>,
    );
    const options = [
      ...html.matchAll(/value="([^"]+)"( disabled="")?>([^<]*)</g),
    ].map(([, value, disabled, text]) => [value, disabled !== undefined, text]);
    expect(options).toEqual([
      ["live", false, "live"],
      ["gone", true, "gone · Turned off"],
      ["elsewhere", true, "elsewhere · Runtime not supported"],
    ]);
  });
});
