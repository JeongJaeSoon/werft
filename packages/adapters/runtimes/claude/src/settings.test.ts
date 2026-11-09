import { describe, expect, test } from "bun:test";
import { PLATFORM_AUTO_MODE, TRUSTED_PLATFORM_AUTO_MODE } from "./auto-mode.ts";
import { modeSettings } from "./engine-settings.ts";

const tools = new Set(["Bash", "Write"]);
const base = { cwd: "/tenant/workspace", tools, trusted: false };

describe("settings files", () => {
  // The two sets are separate literals in settings/auto.json; a rule edited in
  // one and not the other would give trusted runs a different guard.
  test("the full and trusted auto rules agree where they overlap", () => {
    expect(TRUSTED_PLATFORM_AUTO_MODE.soft_deny).toEqual(
      PLATFORM_AUTO_MODE.soft_deny,
    );
    const merge = (rules: string[]) =>
      rules.filter((rule) => rule.startsWith("Werft Pull Request Merge:"));
    expect(merge(TRUSTED_PLATFORM_AUTO_MODE.allow)).toHaveLength(1);
    expect(merge(TRUSTED_PLATFORM_AUTO_MODE.allow)).toEqual(
      merge(PLATFORM_AUTO_MODE.allow),
    );
    for (const rules of [PLATFORM_AUTO_MODE, TRUSTED_PLATFORM_AUTO_MODE]) {
      for (const section of Object.values(rules)) {
        expect(section[0]).toBe("$defaults");
      }
    }
  });

  test("each mode gets its own file's rules and nothing else", () => {
    expect(modeSettings({ ...base, permissionMode: "plan" })).toEqual({});
    expect(modeSettings({ ...base, permissionMode: "auto" })).toEqual({
      autoMode: PLATFORM_AUTO_MODE,
    });
    expect(
      modeSettings({ ...base, permissionMode: "auto", trusted: true }),
    ).toEqual({ autoMode: TRUSTED_PLATFORM_AUTO_MODE });
    for (const permissionMode of [
      undefined,
      "default",
      "acceptEdits",
      "dontAsk",
      "bypassPermissions",
    ]) {
      const settings = modeSettings({ ...base, permissionMode });
      expect(settings).toHaveProperty("permissions");
      expect(settings).not.toHaveProperty("autoMode");
    }
    // No Bash and no file-writing tool: nothing to pre-approve.
    expect(
      modeSettings({
        ...base,
        tools: new Set(["Read"]),
        permissionMode: "default",
      }),
    ).toEqual({});
  });
});
