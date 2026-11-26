import { describe, expect, test } from "bun:test";
import { isStopRequest, STOP_REQUEST_WORDS } from "./stop-request.ts";

describe("isStopRequest", () => {
  test("every word of the table stops, in each language", () => {
    for (const word of Object.values(STOP_REQUEST_WORDS).flat()) {
      expect(isStopRequest(word)).toBe(true);
    }
  });

  test("spaces around, case and closing punctuation are allowed", () => {
    for (const text of [
      "  멈춰  ",
      "STOP",
      "Stop.",
      "stop!!",
      "그만!",
      "止めて。",
      "やめて！",
      "ｓｔｏｐ",
    ]) {
      expect(isStopRequest(text)).toBe(true);
    }
  });

  test("a word inside a longer message does not stop", () => {
    for (const text of [
      "멈춰 주세요, 그런데 이건 해 줘",
      "이거 멈추고 다른 거 해 줘",
      "그만 하고 테스트만 돌려",
      "stop the build",
      "don't stop",
      "?stop",
      "stop?",
      "止めてください",
      "멈춰요",
      "",
    ]) {
      expect(isStopRequest(text)).toBe(false);
    }
  });
});
