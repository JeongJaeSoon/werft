import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// React Aria decides at import time whether a DOM exists; see test-support/dom.ts.
const { Button, Calendar, CalendarCell, CalendarGrid, Heading } = await import(
  "react-aria-components"
);
const { parseDate } = await import("@internationalized/date");
const { AriaLocale } = await import("../foundations/locale.tsx");

function November() {
  return (
    <Calendar aria-label="x" defaultValue={parseDate("2026-11-11")}>
      <header>
        <Button slot="previous" data-testid="previous" />
        <Heading />
      </header>
      <CalendarGrid>{(date) => <CalendarCell date={date} />}</CalendarGrid>
    </Calendar>
  );
}

// What React Aria itself draws, not the app's catalog: the month heading and
// the previous-month button's accessible name.
const EXPECTED = {
  ko: { heading: "2026년 11월", previous: "이전" },
  ja: { heading: "2026年11月", previous: "前へ" },
  en: { heading: "November 2026", previous: "Previous" },
} as const;

describe("React Aria under AriaLocale", () => {
  for (const [locale, expected] of Object.entries(EXPECTED)) {
    test(`${locale}: 달력의 월 제목과 이전 버튼 이름이 로캘을 따른다`, () => {
      const { getByTestId, getByRole, unmount } = render(
        <AriaLocale locale={locale as keyof typeof EXPECTED}>
          <November />
        </AriaLocale>,
      );
      // React Aria prefixes the calendar's own label to the visible month.
      expect(getByRole("heading", { level: 2 }).textContent).toBe(
        `x, ${expected.heading}`,
      );
      expect(getByTestId("previous").getAttribute("aria-label")).toBe(
        expected.previous,
      );
      unmount();
    });
  }
});
