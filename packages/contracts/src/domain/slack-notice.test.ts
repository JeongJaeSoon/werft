import { describe, expect, test } from "bun:test";
import { slackNoticeTextSchema } from "../musterrolle/slack-notice-approval.ts";
import {
  SLACK_NOTICE_LOCALE_VALUES,
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
  slackNoticeWindow,
} from "./slack-notice.ts";

const TEXT = {
  body: ["notice"],
  policyLink: { label: "policy", href: "https://docs.example.test/data" },
};
const entry = (
  version: number,
  requiresReapproval: boolean,
): SlackNoticeVersionEntry => ({
  version: slackNoticeVersionSchema.parse(version),
  text: { ko: TEXT, ja: TEXT },
  requiresReapproval,
});

describe("slackNoticeWindow", () => {
  test("no versions is no notice", () => {
    expect(slackNoticeWindow([])).toBeNull();
  });

  test("the first version is counted whatever its flag", () => {
    expect(slackNoticeWindow([entry(1, false)])).toEqual({
      current: 1,
      oldestCounted: 1,
    } as never);
  });

  test("a rewording keeps the older approvals; a re-approval version cuts them", () => {
    expect(slackNoticeWindow([entry(1, true), entry(2, false)])).toEqual({
      current: 2,
      oldestCounted: 1,
    } as never);
    expect(
      slackNoticeWindow([entry(1, true), entry(2, false), entry(3, true)]),
    ).toEqual({ current: 3, oldestCounted: 3 } as never);
    expect(
      slackNoticeWindow([
        entry(1, true),
        entry(3, true),
        entry(4, false),
        entry(5, false),
      ]),
    ).toEqual({ current: 5, oldestCounted: 3 } as never);
  });

  test("versions out of order are refused", () => {
    expect(() => slackNoticeWindow([entry(2, true), entry(2, false)])).toThrow(
      "increase",
    );
    expect(() => slackNoticeWindow([entry(3, true), entry(1, true)])).toThrow(
      "increase",
    );
  });

  test("the published list is in order", () => {
    expect(() => slackNoticeWindow(SLACK_NOTICE_VERSIONS)).not.toThrow();
  });
});

describe("SLACK_NOTICE_VERSIONS", () => {
  test("every published version has its words in Korean and Japanese, with an https policy link", () => {
    for (const published of SLACK_NOTICE_VERSIONS) {
      for (const locale of SLACK_NOTICE_LOCALE_VALUES) {
        const text = published.text[locale];
        expect(
          slackNoticeTextSchema.safeParse({
            body: [...text.body],
            policy_link: text.policyLink,
          }).success,
        ).toBe(true);
      }
    }
  });
});
