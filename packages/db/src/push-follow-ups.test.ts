import { describe, expect, test } from "bun:test";
import { followUpFact } from "./push-follow-ups.ts";

describe("followUpFact", () => {
  test("a held row written with the old directive wording is told as facts", () => {
    expect(
      followUpFact(
        "Platform note: a person approved push request p1 (repository app, branch agent/s1) in Slack. The push runs in the background: call open_pull_request now, and if it answers not_pushed with push_request_state approved or pushing, wait a few seconds and call it again. Then finish what you were asked to do.",
      ),
    ).toBe(
      "A person approved push request p1 (repository app, branch agent/s1). The push runs in the background.",
    );
    expect(
      followUpFact(
        "Platform note: a person rejected push request p1 (repository app, branch agent/s1) in Slack, so nothing was pushed. Do not ask to push it again unless you are asked to.",
      ),
    ).toBe(
      "A person rejected push request p1 (repository app, branch agent/s1). Nothing was pushed.",
    );
  });

  test("a message already in the new wording, or another one, is left as it is", () => {
    const fact =
      "A person approved push request p1 (repository app, branch agent/s1). The push runs in the background.";
    expect(followUpFact(fact)).toBe(fact);
    expect(followUpFact("anything else")).toBe("anything else");
  });
});
