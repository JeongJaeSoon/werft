import { describe, expect, test } from "bun:test";
import { PUSH_CONTINUATION_MESSAGE } from "./push-continuations.ts";

describe("PUSH_CONTINUATION_MESSAGE", () => {
  test("a push waiting for a person is not called again now", () => {
    expect(PUSH_CONTINUATION_MESSAGE).toContain(
      "If the push request it answers is in state requested, a person has to approve the push before it runs: do not wait for it or call open_pull_request again now; finish your reply and tell the user, in plain words, that the push needs their approval.",
    );
  });

  test("shows the user no internal words", () => {
    expect(PUSH_CONTINUATION_MESSAGE).not.toMatch(/\b(turn|checkpoint)s?\b/i);
  });

  test("calling again in a few seconds is only for an approved or pushing push", () => {
    expect(PUSH_CONTINUATION_MESSAGE).toContain(
      "if open_pull_request answers not_pushed with push_request_state approved or pushing, wait a few seconds and call it again",
    );
    expect(PUSH_CONTINUATION_MESSAGE).not.toMatch(/answers not_pushed, wait/);
  });

  test("promises no pull request after the turn ends", () => {
    // A push approved outside Slack starts no follow-up turn.
    expect(PUSH_CONTINUATION_MESSAGE).not.toMatch(
      /pull request (will )?opens?/i,
    );
  });
});
