import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { TableTime } = await import("./table-time.tsx");

const NOW = Date.parse("2026-11-11T14:42:00+09:00");
const AT = "2026-11-11T09:42:00+09:00";

describe("TableTime", () => {
  test("표 칸에는 절대 시각을, 설명에는 상대 시각을 둔다", () => {
    const { container } = render(<TableTime value={AT} now={NOW} />);
    const time = container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(AT);
    expect(time?.getAttribute("data-slot")).toBe("table-time");
    expect(time?.tabIndex).toBe(0);
    expect(time?.textContent).toBe("11월 11일 오전 09:42");
    expect(
      document.getElementById(time?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("5시간 전");
  });

  test("영어와 일본어도 같은 형식 규칙을 따른다", () => {
    const en = render(<TableTime value={AT} locale="en" now={NOW} />);
    expect(en.container.querySelector("time")?.textContent).toBe(
      "Nov 11, 9:42 AM",
    );
    const ja = render(<TableTime value={AT} locale="ja" now={NOW} />);
    expect(ja.container.querySelector("time")?.textContent).toBe(
      "11月11日 9:42",
    );
  });

  test("Tab으로 닿으면 상대 시각이 열린다", async () => {
    const user = await setupUser();
    const { container } = render(<TableTime value={AT} now={NOW} />);
    await user.tab();
    expect(document.activeElement === container.querySelector("time")).toBe(
      true,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]')?.textContent,
      ).toBe("5시간 전"),
    );
  });
});
