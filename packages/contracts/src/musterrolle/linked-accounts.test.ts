import { describe, expect, test } from "bun:test";
import { LINK_MESSAGES } from "./linked-accounts.ts";

describe("LINK_MESSAGES", () => {
  test("menu paths use '>' like the console catalog and the docs", () => {
    // The console shows these server messages as they are, so a "›" here reads
    // as a different menu than the one the sidebar names.
    const texts = Object.entries(LINK_MESSAGES).map(([key, message]) => [
      key,
      typeof message === "function" ? message("workspace") : message,
    ]);
    // A guard that sees no messages would pass for the wrong reason.
    expect(texts.length).toBeGreaterThan(5);
    const withChevron = texts
      .filter(([, text]) => text?.includes("›"))
      .map(([key]) => key);
    expect(withChevron).toEqual([]);
  });
});
