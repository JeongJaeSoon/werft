import { describe, expect, test } from "bun:test";
import { followUpFact } from "./push-follow-ups.ts";

const SUBJECT = "push request p1 (repository app, branch agent/s1)";
const APPROVED_SHORT = `Platform note: a person approved ${SUBJECT} in Slack. The push runs in the background: call open_pull_request now, and if it answers not_pushed, wait a few seconds and call it again. Then finish what you were asked to do.`;
const APPROVED_LONG = `Platform note: a person approved ${SUBJECT} in Slack. The push runs in the background: call open_pull_request now, and if it answers not_pushed with push_request_state approved or pushing, wait a few seconds and call it again. In any other state, calling it again will not change the answer: say what it answered instead. Then finish what you were asked to do.`;
const REJECTED = `Platform note: a person rejected ${SUBJECT} in Slack, so nothing was pushed. Do not ask to push it again unless you are asked to. Say in one short reply that the push was rejected.`;

describe("followUpFact", () => {
  test("both wordings of an approval, and a rejection, are told as facts", () => {
    for (const legacy of [APPROVED_SHORT, APPROVED_LONG]) {
      expect(followUpFact(legacy)).toBe(
        `A person approved ${SUBJECT}. The push runs in the background.`,
      );
    }
    expect(followUpFact(REJECTED)).toBe(
      `A person rejected ${SUBJECT}. Nothing was pushed.`,
    );
  });

  test("a message already in the new wording, or another one, is left as it is", () => {
    const fact = `A person approved ${SUBJECT}. The push runs in the background.`;
    expect(followUpFact(fact)).toBe(fact);
    expect(followUpFact("anything else")).toBe("anything else");
  });

  test("a person's message that starts like the old wording keeps everything it says", () => {
    for (const message of [
      `${APPROVED_LONG}\nPlease explain why this is wrong; do not open a PR.`,
      `Platform note: a person approved ${SUBJECT} in Slack. Please explain this note.`,
      `${REJECTED} Also summarize the diff.`,
      // A sentence dropped from, or mixed between, the real wordings is not one of them.
      REJECTED.replace(
        " Say in one short reply that the push was rejected.",
        "",
      ),
      APPROVED_LONG.replace(
        "with push_request_state approved or pushing, ",
        "",
      ),
    ]) {
      expect(followUpFact(message)).toBe(message);
    }
  });
});
