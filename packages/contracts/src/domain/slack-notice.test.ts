import { describe, expect, test } from "bun:test";
import {
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
  slackNoticeWindow,
} from "./slack-notice.ts";

const entry = (
  version: number,
  requiresReapproval: boolean,
): SlackNoticeVersionEntry => ({
  version: slackNoticeVersionSchema.parse(version),
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
