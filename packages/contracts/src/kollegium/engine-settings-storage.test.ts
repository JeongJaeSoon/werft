import { describe, expect, test } from "bun:test";

import type { ToolCatalogView } from "../api/profile-tools.ts";
import {
  ENGINE_AUTO_MODE_RULE_MAX_LENGTH,
  ENGINE_AUTO_MODE_RULES_MAX,
  engineSettingsStartSchema,
  storedEngineSettingsSchema,
  validateEngineSettings,
} from "./engine-settings-storage.ts";

const catalog: ToolCatalogView = {
  id: "test@1",
  tools: ["Read", "Edit", "Bash", "WebFetch", "WebSearch", "Agent"].map(
    (name) => ({ name, boundary: "local" as const }),
  ),
  aliases: { Task: "Agent" },
};

const settings = (input: unknown) => validateEngineSettings(catalog, input);
const refusedAs = (input: unknown) => {
  const result = settings(input);
  return "refusal" in result ? result.refusal.reason_code : "accepted";
};

describe("validateEngineSettings", () => {
  test("stores permission rules under the catalog's current names and drops repeats", () => {
    const result = settings({
      permissions: { deny: ["Task", "Agent", "Bash(rm:*)"], ask: [] },
      auto_mode: {},
    });
    expect(result).toEqual({
      settings: {
        permissions: { deny: ["Agent", "Bash(rm:*)"] },
        auto_mode: {},
      },
    });
  });

  test("an empty settings object is accepted and stored as empty", () => {
    expect(settings({ permissions: {}, auto_mode: {} })).toEqual({
      settings: { permissions: {}, auto_mode: {} },
    });
  });

  test("refuses the rules the engine would drop without a word", () => {
    expect(
      refusedAs({ permissions: { deny: ["Skill(web)"] }, auto_mode: {} }),
    ).toBe("rule_no_effect");
    expect(refusedAs({ permissions: { allow: ["Nope"] }, auto_mode: {} })).toBe(
      "rule_no_effect",
    );
    expect(
      refusedAs({ permissions: { allow: ["B*"] }, auto_mode: {} }),
    ).not.toBe("accepted");
    expect(
      refusedAs({ permissions: { allow: ["Read("] }, auto_mode: {} }),
    ).toBe("rule_syntax");
  });

  test("a list over the rule budget is refused, not cut", () => {
    const rules = Array.from({ length: 65 }, (_, index) => `Bash(cmd${index})`);
    expect(refusedAs({ permissions: { deny: rules }, auto_mode: {} })).toBe(
      "too_many_rules",
    );
    expect(
      refusedAs({ permissions: { deny: rules.slice(0, 64) }, auto_mode: {} }),
    ).toBe("accepted");
  });

  test("auto mode sentences are bounded prose, not tool patterns", () => {
    const sentence = "Do not push to the main branch.";
    expect(
      settings({
        permissions: {},
        auto_mode: { hard_deny: [sentence, sentence] },
      }),
    ).toEqual({
      settings: { permissions: {}, auto_mode: { hard_deny: [sentence] } },
    });
    expect(
      refusedAs({ permissions: {}, auto_mode: { environment: ["  "] } }),
    ).toBe("auto_mode_rule_syntax");
    expect(
      refusedAs({
        permissions: {},
        auto_mode: {
          environment: ["x".repeat(ENGINE_AUTO_MODE_RULE_MAX_LENGTH + 1)],
        },
      }),
    ).toBe("auto_mode_rule_syntax");
    const many = Array.from(
      { length: ENGINE_AUTO_MODE_RULES_MAX + 1 },
      (_, index) => `Sentence ${index}.`,
    );
    expect(refusedAs({ permissions: {}, auto_mode: { allow: many } })).toBe(
      "auto_mode_rule_syntax",
    );
  });

  test("a whole mcp__ rule is accepted: the platform enforces it, the engine never gets it", () => {
    expect(
      settings({
        permissions: { deny: ["mcp__docs__write"] },
        auto_mode: {},
      }),
    ).toEqual({
      settings: {
        permissions: { deny: ["mcp__docs__write"] },
        auto_mode: {},
      },
    });
  });

  test("a rule over the length limit is refused", () => {
    expect(
      refusedAs({
        permissions: { deny: [`Bash(${"a".repeat(260)})`] },
        auto_mode: {},
      }),
    ).toBe("rule_too_long");
  });

  test("the budget counts rules after repeats are dropped", () => {
    const unique = Array.from({ length: 64 }, (_, index) => `Bash(c${index})`);
    expect(
      refusedAs({
        permissions: { deny: [...unique, ...unique.slice(0, 10)] },
        auto_mode: {},
      }),
    ).toBe("accepted");
  });

  test("lengths are characters, the way the table counts them", () => {
    // An emoji is one character and two UTF-16 units.
    const limit = ENGINE_AUTO_MODE_RULE_MAX_LENGTH;
    expect(
      refusedAs({
        permissions: {},
        auto_mode: { allow: ["😀".repeat(limit)] },
      }),
    ).toBe("accepted");
    expect(
      refusedAs({
        permissions: {},
        auto_mode: { allow: ["😀".repeat(limit + 1)] },
      }),
    ).toBe("auto_mode_rule_syntax");
    expect(
      storedEngineSettingsSchema.safeParse({
        permissions: {},
        auto_mode: { allow: ["😀".repeat(600)] },
      }).success,
    ).toBe(true);
  });

  test("refuses a shape that is not two objects of string lists", () => {
    for (const input of [
      null,
      {},
      { permissions: {} },
      { permissions: { deny: "Bash" }, auto_mode: {} },
      { permissions: { other: [] }, auto_mode: {} },
      { permissions: {}, auto_mode: { allow: [3] } },
      { permissions: {}, auto_mode: {}, extra: 1 },
    ]) {
      expect(refusedAs(input)).toBe("settings_shape");
    }
  });
});

describe("engineSettingsStartSchema", () => {
  test("holds the content and the revision it was read at", () => {
    const start = {
      permissions: { deny: ["WebSearch"] },
      auto_mode: {},
      revision: 3,
    };
    expect(engineSettingsStartSchema.safeParse(start).success).toBe(true);
  });

  test("a later field does not make an older reader refuse the snapshot", () => {
    expect(
      engineSettingsStartSchema.safeParse({
        permissions: {},
        auto_mode: {},
        revision: 1,
        later: true,
      }).success,
    ).toBe(true);
  });

  test("a snapshot without a positive revision does not parse", () => {
    for (const revision of [0, -1, 1.5, "1", undefined]) {
      expect(
        engineSettingsStartSchema.safeParse({
          permissions: {},
          auto_mode: {},
          revision,
        }).success,
      ).toBe(false);
    }
  });
});
