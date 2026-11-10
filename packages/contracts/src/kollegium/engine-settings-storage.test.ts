import { describe, expect, test } from "bun:test";

import type { ToolCatalogView } from "../api/profile-tools.ts";
import {
  ADMIN_DENY_RULES_MAX,
  ENGINE_AUTO_MODE_RULE_MAX_LENGTH,
  ENGINE_SETTINGS_LIMITS,
  engineSettingsStartSchema,
  storedEngineSettingsSchema,
  validateAdminDeny,
  validateEngineSettings,
} from "./engine-settings-storage.ts";

const catalog: ToolCatalogView = {
  id: "test@1",
  tools: ["Read", "Edit", "Bash", "WebFetch", "WebSearch", "Agent"].map(
    (name) => ({ name, boundary: "local" as const }),
  ),
  aliases: { Task: "Agent" },
};

const settings = (input: unknown, source: "workspace" | "agent" = "agent") =>
  validateEngineSettings(catalog, input, source);
const refusedAs = (input: unknown, source: "workspace" | "agent" = "agent") => {
  const result = settings(input, source);
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

  test("a list over its source's rule budget is refused, not cut", () => {
    const rules = Array.from({ length: 49 }, (_, index) => `Bash(cmd${index})`);
    // An agent saves 24 a list and a workspace 48: what a claim merges has to
    // fit the 128 a worker accepts.
    expect(refusedAs({ permissions: { deny: rules }, auto_mode: {} })).toBe(
      "too_many_rules",
    );
    expect(
      refusedAs({ permissions: { deny: rules.slice(0, 24) }, auto_mode: {} }),
    ).toBe("accepted");
    expect(
      refusedAs({ permissions: { deny: rules.slice(0, 25) }, auto_mode: {} }),
    ).toBe("too_many_rules");
    expect(
      refusedAs(
        { permissions: { deny: rules.slice(0, 48) }, auto_mode: {} },
        "workspace",
      ),
    ).toBe("accepted");
    expect(
      refusedAs({ permissions: { deny: rules }, auto_mode: {} }, "workspace"),
    ).toBe("too_many_rules");
  });

  test("the largest a claim can merge fits what a worker accepts", () => {
    const { workspace, agent } = ENGINE_SETTINGS_LIMITS;
    const admin = ADMIN_DENY_RULES_MAX;
    // The workspace's, the inherited deny, and the agent's twice (start and now).
    expect(workspace.permissionRules + admin + 2 * agent.permissionRules).toBe(
      128,
    );
    expect(
      workspace.autoModeRules + 2 * agent.autoModeRules,
    ).toBeLessThanOrEqual(64);
  });

  test("an mcp__ rule can be denied but not asked or allowed", () => {
    expect(
      refusedAs({ permissions: { ask: ["mcp__docs__write"] }, auto_mode: {} }),
    ).toBe("mcp_rule_verdict");
    expect(
      refusedAs({
        permissions: { allow: ["mcp__docs__write"] },
        auto_mode: {},
      }),
    ).toBe("mcp_rule_verdict");
  });

  test("a whole-tool rule can be asked: the worker takes it in permissions.ask", () => {
    expect(settings({ permissions: { ask: ["Edit"] }, auto_mode: {} })).toEqual(
      {
        settings: { permissions: { ask: ["Edit"] }, auto_mode: {} },
      },
    );
  });

  test("permission rules have a byte limit apart from the count", () => {
    // Three lists of 24 rules of 253 characters: within every count, about
    // 18 KB of JSON against the 6 KB an agent may save.
    const list = (tag: string) =>
      Array.from(
        { length: 24 },
        (_, index) =>
          `Bash(${tag}${index.toString().padStart(2, "0")}${"a".repeat(242)})`,
      );
    expect(
      refusedAs({
        permissions: { allow: list("a"), ask: list("b"), deny: list("c") },
        auto_mode: {},
      }),
    ).toBe("settings_too_large");
    expect(
      refusedAs({
        permissions: { deny: list("c").slice(0, 8) },
        auto_mode: {},
      }),
    ).toBe("accepted");
  });

  test("the size limit counts the JSON text, escapes included", () => {
    // 20 sentences would pass a count of 16 only if cut; 16 sentences of
    // quotes become two bytes each in JSON and push the text over 4 KB.
    const quotes = Array.from(
      { length: 16 },
      (_, index) => `${'"'.repeat(150)}${index}`,
    );
    expect(refusedAs({ permissions: {}, auto_mode: { allow: quotes } })).toBe(
      "settings_too_large",
    );
    const plain = Array.from(
      { length: 16 },
      (_, index) => `${"a".repeat(150)}${index}`,
    );
    expect(refusedAs({ permissions: {}, auto_mode: { allow: plain } })).toBe(
      "accepted",
    );
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
      { length: ENGINE_SETTINGS_LIMITS.agent.autoModeRules + 1 },
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
    const unique = Array.from({ length: 24 }, (_, index) => `Bash(c${index})`);
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
    // At the character limit the sentence passes the length check, and is then
    // refused by the byte limit (4 bytes a character in JSON), not by length.
    expect(
      refusedAs({
        permissions: {},
        auto_mode: { allow: ["😀".repeat(limit)] },
      }),
    ).toBe("settings_too_large");
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

describe("validateAdminDeny", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    exempt_release_ids: ["r1", "r2"],
    permissions_deny: ["WebSearch", "Bash(rm:*)"],
    mcp_deny: ["mcp__docs__write"],
    ...over,
  });
  const refused = (input: unknown) => {
    const result = validateAdminDeny(catalog, input);
    return "refusal" in result ? result.refusal.reason_code : "accepted";
  };

  test("accepts entries and stores their rules under current names", () => {
    const result = validateAdminDeny(catalog, [
      entry({ permissions_deny: ["Task", "Agent"] }),
    ]);
    expect(result).toEqual({
      entries: [
        {
          exempt_release_ids: ["r1", "r2"],
          permissions_deny: ["Agent"],
          mcp_deny: ["mcp__docs__write"],
        },
      ],
    });
  });

  test("an empty list is no inherited restriction", () => {
    expect(validateAdminDeny(catalog, [])).toEqual({ entries: [] });
  });

  test("keeps the two routes apart: mcp__ rules only in mcp_deny", () => {
    expect(refused([entry({ permissions_deny: ["mcp__docs__write"] })])).toBe(
      "settings_shape",
    );
    expect(refused([entry({ mcp_deny: ["WebSearch"] })])).toBe(
      "settings_shape",
    );
  });

  test("refuses rules the engine would drop, like a saved rule", () => {
    expect(refused([entry({ permissions_deny: ["Skill(web)"] })])).toBe(
      "rule_no_effect",
    );
  });

  test("the rule budget counts the union of all entries, not each entry", () => {
    const rules = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `Bash(c${from + index})`);
    // The same 20 rules in two entries are 20, not 40.
    expect(
      refused([
        entry({ permissions_deny: rules(0, 20), mcp_deny: [] }),
        entry({ permissions_deny: rules(0, 20), mcp_deny: [] }),
      ]),
    ).toBe("accepted");
    expect(
      refused([
        entry({ permissions_deny: rules(0, 20), mcp_deny: [] }),
        entry({ permissions_deny: rules(20, 20), mcp_deny: [] }),
      ]),
    ).toBe("too_many_rules");
    expect(ADMIN_DENY_RULES_MAX).toBe(32);
  });

  test("the rule budget counts both routes together", () => {
    const rules = (count: number) =>
      Array.from({ length: count }, (_, index) => `Bash(c${index})`);
    const mcp = (count: number) =>
      Array.from({ length: count }, (_, index) => `mcp__docs__t${index}`);
    expect(
      refused([entry({ permissions_deny: rules(16), mcp_deny: mcp(16) })]),
    ).toBe("accepted");
    expect(
      refused([entry({ permissions_deny: rules(20), mcp_deny: mcp(20) })]),
    ).toBe("too_many_rules");
  });

  test("the rule text has a byte limit of its own", () => {
    // 32 rules within the count limit, each 253 characters: over 8 KB of JSON.
    const long = Array.from(
      { length: 32 },
      (_, index) =>
        `Bash(${index.toString().padStart(2, "0")}${"a".repeat(244)})`,
    );
    expect(refused([entry({ permissions_deny: long, mcp_deny: [] })])).toBe(
      "settings_too_large",
    );
    expect(
      refused([entry({ permissions_deny: long.slice(0, 16), mcp_deny: [] })]),
    ).toBe("accepted");
  });

  test("the release lists have their own budget apart from the rules", () => {
    const ids = Array.from(
      { length: 3000 },
      (_, index) => `${"a".repeat(70)}${index}`,
    );
    expect(refused([entry({ exempt_release_ids: ids })])).toBe("accepted");
    const more = Array.from(
      { length: 3600 },
      (_, index) => `${"a".repeat(70)}${index}`,
    );
    expect(refused([entry({ exempt_release_ids: more })])).toBe(
      "settings_too_large",
    );
  });

  test("refuses a shape that is not a list of entries", () => {
    for (const input of [
      null,
      {},
      [{}],
      [entry({ extra: 1 })],
      [entry({ mcp_deny: "x" })],
    ]) {
      expect(refused(input)).toBe("settings_shape");
    }
  });
});
