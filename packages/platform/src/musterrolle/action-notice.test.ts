import { describe, expect, test } from "bun:test";
import { USER_LOCALE_VALUES } from "@werft-ai/contracts";
import {
  ACTION_NOTICE_RESULTS,
  type ActionNotice,
  actionNoticeDedupeKey,
  actionNoticeText,
} from "./action-notice.ts";

const base = {
  repository: "app",
  branch: "agent/s-1",
  commit: "a".repeat(40),
  number: 12,
  reason: "head_moved",
} satisfies Omit<ActionNotice, "result">;

describe("action notices", () => {
  test("every result has words in every language, naming what it reports", () => {
    for (const locale of USER_LOCALE_VALUES) {
      for (const result of ACTION_NOTICE_RESULTS) {
        const text = actionNoticeText(locale, { ...base, result });
        expect(text).toContain("app");
        if (
          result === "opened" ||
          result === "pr_updated" ||
          result === "pr_closed"
        ) {
          expect(text).toContain("12");
        }
        if (result === "pushed" || result === "pr_updated") {
          expect(text).toContain("aaaaaaa");
        }
        if (result.endsWith("failed") || result === "pr_uncertain") {
          expect(text).toContain("head_moved");
        }
      }
    }
  });

  test("the languages differ, and an unknown reader reads Korean", () => {
    const notice = { ...base, result: "opened" } as const;
    const ko = actionNoticeText("ko", notice);
    expect(actionNoticeText("en", notice)).not.toBe(ko);
    expect(actionNoticeText("ja", notice)).not.toBe(ko);
    expect(actionNoticeText(null, notice)).toBe(ko);
    expect(actionNoticeText(undefined, notice)).toBe(ko);
  });

  test("the key is one per push request and result", () => {
    expect(actionNoticeDedupeKey("p-1", "opened")).toBe("action:p-1:opened");
    expect(actionNoticeDedupeKey("p-1", "pushed")).not.toBe(
      actionNoticeDedupeKey("p-1", "opened"),
    );
  });
});
