import { describe, expect, test } from "bun:test";

import {
  classifySlackSendResult,
  SLACK_PERMANENT_SEND_ERRORS,
  SLACK_SEND_MAX_ATTEMPTS,
  type SlackSendResultInput,
} from "./slack-send-result.ts";

function input(over: Partial<SlackSendResultInput>): SlackSendResultInput {
  return {
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: true, channel: "C1", ts: "1758500000.0002" },
    attempts: 1,
    ...over,
  };
}

describe("classifySlackSendResult", () => {
  test("an accepted message is sent with its timestamp", () => {
    expect(classifySlackSendResult(input({}))).toEqual({
      kind: "sent",
      ts: "1758500000.0002",
    });
  });

  test("ok without a timestamp fails instead of risking a duplicate post", () => {
    for (const body of [
      { ok: true, channel: "C1" },
      { ok: true, ts: "" },
      { ok: true, ts: 12 },
    ]) {
      expect(classifySlackSendResult(input({ body }))).toEqual({
        kind: "failed",
        code: "missing_ts",
      });
    }
  });

  test("HTTP 429 waits for Retry-After", () => {
    expect(
      classifySlackSendResult(
        input({ httpStatus: 429, retryAfterHeader: "7", body: null }),
      ),
    ).toEqual({ kind: "retry_after", waitMs: 7000 });
  });

  test("a rate limit reported in the body with status 200 also waits", () => {
    expect(
      classifySlackSendResult(
        input({
          retryAfterHeader: "2",
          body: { ok: false, error: "ratelimited" },
        }),
      ),
    ).toEqual({ kind: "retry_after", waitMs: 2000 });
  });

  test.each([null, "", "abc", "0", "-3", "0x10", "1e3", "1.5", "1e308"])(
    "a missing or unusable Retry-After (%p) waits one second",
    (retryAfterHeader) => {
      expect(
        classifySlackSendResult(
          input({ httpStatus: 429, retryAfterHeader, body: null }),
        ),
      ).toEqual({ kind: "retry_after", waitMs: 1000 });
    },
  );

  test("a rate limit is waited out even past the attempt cap", () => {
    expect(
      classifySlackSendResult(
        input({
          httpStatus: 429,
          retryAfterHeader: "3",
          body: null,
          attempts: SLACK_SEND_MAX_ATTEMPTS + 2,
        }),
      ),
    ).toEqual({ kind: "retry_after", waitMs: 3000 });
  });

  test("lists the thirteen errors no retry clears", () => {
    expect([...SLACK_PERMANENT_SEND_ERRORS].sort()).toEqual([
      "account_inactive",
      "channel_not_found",
      "invalid_auth",
      "invalid_blocks",
      "invalid_blocks_format",
      "is_archived",
      "missing_scope",
      "msg_blocks_too_long",
      "msg_too_long",
      "no_permission",
      "not_in_channel",
      "restricted_action",
      "token_revoked",
    ]);
  });

  test.each([...SLACK_PERMANENT_SEND_ERRORS])(
    "%s fails on the first attempt",
    (error) => {
      expect(
        classifySlackSendResult(input({ body: { ok: false, error } })),
      ).toEqual({ kind: "failed", code: error });
    },
  );

  test("an unknown error retries until the attempt cap, then fails", () => {
    const body = { ok: false, error: "internal_error" };
    expect(
      classifySlackSendResult(
        input({ body, attempts: SLACK_SEND_MAX_ATTEMPTS - 1 }),
      ),
    ).toEqual({ kind: "retry", code: "internal_error" });
    expect(
      classifySlackSendResult(
        input({ body, attempts: SLACK_SEND_MAX_ATTEMPTS }),
      ),
    ).toEqual({ kind: "failed", code: "internal_error" });
    expect(SLACK_SEND_MAX_ATTEMPTS).toBe(5);
  });

  test("a server error or a missing body retries under its HTTP status", () => {
    expect(
      classifySlackSendResult(
        input({
          httpStatus: 503,
          body: { ok: false, error: "service_unavailable" },
        }),
      ),
    ).toEqual({ kind: "retry", code: "service_unavailable" });
    expect(
      classifySlackSendResult(input({ httpStatus: 502, body: null })),
    ).toEqual({ kind: "retry", code: "http_502" });
    expect(
      classifySlackSendResult(input({ httpStatus: 500, body: "<html>" })),
    ).toEqual({ kind: "retry", code: "http_500" });
    expect(
      classifySlackSendResult(
        input({
          httpStatus: 502,
          body: null,
          attempts: SLACK_SEND_MAX_ATTEMPTS,
        }),
      ),
    ).toEqual({ kind: "failed", code: "http_502" });
  });
});
