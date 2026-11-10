import { describe, expect, test } from "bun:test";
import {
  countOf,
  draftOf,
  ENGINE_LISTS,
  isDirty,
  listId,
  rulesOfText,
  settingsOf,
} from "./engine-settings-lists.ts";

const saved = {
  permissions: { deny: ["Bash(rm:*)", "WebFetch"], allow: ["Read"] },
  auto_mode: { environment: ["Staging only"] },
};

describe("engine settings lists", () => {
  test("each of the seven lists has its own id", () => {
    expect(ENGINE_LISTS.map(listId)).toEqual([
      "permissions.allow",
      "permissions.ask",
      "permissions.deny",
      "auto_mode.allow",
      "auto_mode.soft_deny",
      "auto_mode.hard_deny",
      "auto_mode.environment",
    ]);
  });

  test("a draft made from settings turns back into the same settings", () => {
    expect(settingsOf(draftOf(saved))).toEqual(saved);
    expect(isDirty(draftOf(saved), saved)).toBe(false);
  });

  test("blank lines and padding are not rules; order is kept", () => {
    expect(rulesOfText("  Read \n\n  \nBash(ls)\n")).toEqual([
      "Read",
      "Bash(ls)",
    ]);
  });

  test("an emptied list is left out of the document, as the API stores it", () => {
    const draft = { ...draftOf(saved), "permissions.deny": "\n  \n" };
    expect(settingsOf(draft).permissions).toEqual({ allow: ["Read"] });
    expect(isDirty(draft, saved)).toBe(true);
  });

  test("only a changed rule or order makes the draft dirty", () => {
    const base = draftOf(saved);
    expect(
      isDirty({ ...base, "permissions.deny": "Bash(rm:*)\nWebFetch\n" }, saved),
    ).toBe(false);
    expect(
      isDirty({ ...base, "permissions.deny": "WebFetch\nBash(rm:*)" }, saved),
    ).toBe(true);
    expect(
      isDirty({ ...base, "auto_mode.allow": "Run the tests" }, saved),
    ).toBe(true);
  });

  test("the count ignores blank lines", () => {
    const draft = { ...draftOf(saved), "permissions.ask": "Edit\n\nWrite" };
    expect(countOf(draft, ENGINE_LISTS[1])).toBe(2);
  });
});
