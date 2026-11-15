import { describe, expect, test } from "bun:test";

import {
  formatDuration,
  formatTableDateTime,
  formatTimestamp,
} from "./format-timestamp.ts";

// 2026-11-11 09:42 and 15:05 in Seoul.
const MORNING = "2026-11-11T00:42:00.000Z";
const AFTERNOON = "2026-11-11T06:05:00.000Z";

describe("formatTableDateTime", () => {
  test("연도 없이 월·일과 오전/오후 시각을 언어마다의 순서로 적는다", () => {
    expect(formatTableDateTime(MORNING, "ko")).toBe("11월 11일 오전 09:42");
    expect(formatTableDateTime(AFTERNOON, "ko")).toBe("11월 11일 오후 03:05");
    expect(formatTableDateTime(MORNING, "en")).toBe("Nov 11, 9:42 AM");
    expect(formatTableDateTime(AFTERNOON, "en")).toBe("Nov 11, 3:05 PM");
    expect(formatTableDateTime(MORNING, "ja")).toBe("11月11日 9:42");
    expect(formatTableDateTime(AFTERNOON, "ja")).toBe("11月11日 15:05");
  });

  test("시각이 아니면 받은 글자를 그대로 돌려준다", () => {
    expect(formatTableDateTime("not-a-time")).toBe("not-a-time");
  });

  test("서울 시각으로 날짜가 넘어간다", () => {
    expect(formatTableDateTime("2026-11-10T15:30:00.000Z", "ko")).toBe(
      "11월 11일 오전 12:30",
    );
    expect(formatTimestamp("2026-11-10T15:30:00.000Z", "ko")).toBe(
      "2026. 11. 11. 00:30",
    );
  });
});

describe("formatDuration", () => {
  const MINUTE = 60_000;

  test("분 단위로, 1시간부터는 시간과 분으로 적는다", () => {
    expect(formatDuration(0.5 * MINUTE, "ko")).toBe("1분 미만");
    expect(formatDuration(18 * MINUTE, "ko")).toBe("18분");
    expect(formatDuration(65 * MINUTE, "ko")).toBe("1시간 5분");
    expect(formatDuration(120 * MINUTE, "ko")).toBe("2시간");
    expect(formatDuration(18 * MINUTE, "en")).toBe("18 min");
    expect(formatDuration(65 * MINUTE, "en")).toBe("1 h 5 min");
    expect(formatDuration(0.5 * MINUTE, "en")).toBe("<1 min");
    expect(formatDuration(65 * MINUTE, "ja")).toBe("1時間5分");
    expect(formatDuration(0.5 * MINUTE, "ja")).toBe("1分未満");
  });

  test("음수이거나 수가 아니면 null이다", () => {
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});
