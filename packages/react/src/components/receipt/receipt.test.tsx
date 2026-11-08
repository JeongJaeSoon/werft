import { describe, expect, test } from "bun:test";
import { RECEIPT_STATUS_VALUES } from "@werft-ai/contracts";

import { setupDom } from "@werft-ai/ui/test-support/dom";
import { describeStatus } from "../status/vocabulary.ts";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists.
const { formatTimestamp } = await import("@werft-ai/ui");
const { ReceiptLink } = await import("./receipt-link.tsx");
const { ReceiptSummary } = await import("./receipt-summary.tsx");

const TARGET = {
  session_id: "01J8Z5T7Q0000000000000000A",
  turn_id: "01J8Z5T7Q0000000000000000B",
  request_id: null,
};
const TIMES = {
  created_at: "2026-09-21T02:15:00.000Z",
  updated_at: "2026-09-21T02:15:42.000Z",
};

function toneOf(container: HTMLElement): string | null {
  return container
    .querySelector(".werft-status[data-axis='receipt']")
    ?.getAttribute("data-tone") as string | null;
}

describe("ReceiptSummary", () => {
  test("accepted는 접수일 뿐, 성공 색이 아니다", () => {
    const { container, getByText } = render(
      <ReceiptSummary
        operation="append_message"
        status="accepted"
        target={TARGET}
        timestamps={{
          created_at: TIMES.created_at,
          updated_at: TIMES.created_at,
        }}
      />,
    );

    expect(getByText("접수됨")).toBeDefined();
    expect(toneOf(container)).toBe("progress");
    expect(toneOf(container)).not.toBe("positive");
  });

  test("unknown은 성공 색으로 그리지 않는다", () => {
    const { container, getByText } = render(
      <ReceiptSummary
        operation="terminate"
        status="unknown"
        target={TARGET}
        timestamps={TIMES}
      />,
    );

    expect(getByText("결과 미확정")).toBeDefined();
    expect(toneOf(container)).toBe("unknown");
    expect(toneOf(container)).not.toBe("positive");
  });

  test("라벨을 모르는 operation은 원문 그대로 그리고, enable_connection은 라벨이 있다", () => {
    const unknown = render(
      <ReceiptSummary
        // A value a newer server may send: the old label table lacks it.
        operation={"from_the_future" as never}
        status="succeeded"
        target={TARGET}
        timestamps={TIMES}
      />,
    );
    expect(unknown.getByText("from_the_future")).toBeDefined();
    unknown.unmount();

    const known = render(
      <ReceiptSummary
        operation="enable_connection"
        status="succeeded"
        target={TARGET}
        timestamps={TIMES}
      />,
    );
    expect(known.getByText("모델 연결 다시 사용")).toBeDefined();
  });

  test("succeeded만 성공 색을 받는다", () => {
    const { container } = render(
      <ReceiptSummary
        operation="pause"
        status="succeeded"
        target={TARGET}
        timestamps={TIMES}
      />,
    );
    expect(toneOf(container)).toBe("positive");
  });

  test("failed는 원문보다 할 일을 먼저 보여준다", () => {
    const { container, getByText } = render(
      <ReceiptSummary
        operation="answer"
        status="failed"
        target={TARGET}
        timestamps={TIMES}
        error={{ code: "SESSION_PAUSED", message: "session is paused" }}
      />,
    );

    const guidance = container.querySelector(
      ".werft-receipt__guidance",
    ) as Element;
    const detail = container.querySelector(".werft-receipt__detail") as Element;
    expect(guidance.textContent).toBe(
      "세션이 일시정지 상태입니다 — 재개한 뒤 보내세요.",
    );
    expect(detail.textContent).toContain("session is paused");
    // 할 일이 원문보다 먼저 온다 (§9).
    expect(
      guidance.compareDocumentPosition(detail) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(getByText("실패")).toBeDefined();
  });

  test("en·ja 안내에는 한국어가 나오지 않는다", () => {
    for (const [locale, expected] of [
      ["en", "The session is paused — resume it, then send."],
      ["ja", "セッションは一時停止中です — 再開してから送ってください。"],
    ] as const) {
      for (const code of ["SESSION_PAUSED", "NOT_A_REAL_CODE"]) {
        const { container, unmount } = render(
          <ReceiptSummary
            operation="answer"
            status="failed"
            target={TARGET}
            timestamps={TIMES}
            error={{
              code: code as "SESSION_PAUSED",
              message: "session is paused",
            }}
            locale={locale}
          />,
        );
        const guidance = container.querySelector(".werft-receipt__guidance")
          ?.textContent as string;
        if (code === "SESSION_PAUSED") expect(guidance).toBe(expected);
        expect(guidance).not.toMatch(/[가-힣]/);
        unmount();
      }
    }
  });

  test("없는 대상 필드는 빈 값으로 그리지 않는다", () => {
    const { container } = render(
      <ReceiptSummary
        operation="create_session"
        status="accepted"
        target={{
          session_id: TARGET.session_id,
          turn_id: null,
          request_id: null,
        }}
        timestamps={TIMES}
      />,
    );
    expect(container.querySelectorAll(".werft-receipt__field")).toHaveLength(1);
  });

  test("갱신 시각이 접수 시각과 같으면 한 번만 보여준다", () => {
    const { container } = render(
      <ReceiptSummary
        operation="create_session"
        status="accepted"
        target={TARGET}
        timestamps={{
          created_at: TIMES.created_at,
          updated_at: TIMES.created_at,
        }}
      />,
    );
    expect(container.querySelectorAll("time")).toHaveLength(1);
  });

  test("네 가지 receipt 상태가 모두 다른 tone을 받는다", () => {
    const tones = RECEIPT_STATUS_VALUES.map(
      (status) => describeStatus("receipt", status).tone,
    );
    expect(new Set(tones).size).toBe(RECEIPT_STATUS_VALUES.length);
  });
});

describe("ReceiptLink", () => {
  test("상태를 색뿐 아니라 글자로도 알려 준다", () => {
    const { container } = render(
      <ReceiptLink
        receiptId="rcpt_1"
        status="unknown"
        href="/receipts/rcpt_1"
      />,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/receipts/rcpt_1");
    expect(link?.getAttribute("data-tone")).toBe("unknown");
    expect(link?.textContent).toContain("결과 미확정");
    expect(link?.textContent).toContain("rcpt_1");
  });

  test("상태 문구가 눈에 보이는 자리에 있다", () => {
    const { container } = render(
      <ReceiptLink
        receiptId="rcpt_1"
        status="failed"
        href="/receipts/rcpt_1"
      />,
    );

    // 색만으로 상태를 말하지 않는다 (§4·§6): the dot carries the same signal,
    // so hiding this span would leave colour as the only difference.
    const status = container.querySelector(".werft-receipt-link__status");
    expect(status?.textContent).toBe("실패");
    expect(status?.classList.contains("werft-visually-hidden")).toBe(false);
    expect(status?.closest(".werft-visually-hidden")).toBeNull();
  });
});

describe("formatTimestamp", () => {
  test("러너의 시간대·ICU와 무관하게 같은 문자열을 만든다", () => {
    // Pinned literally: `dateStyle: "short"` rendered the year as "26" on
    // macOS and "2026" on the CI runner, which only the snapshot caught.
    expect(formatTimestamp("2026-09-21T02:15:00.000Z")).toBe(
      "2026. 09. 21. 11:15",
    );
    // KST is UTC+9, so an instant before 15:00Z still belongs to that day.
    expect(formatTimestamp("2026-09-21T14:59:59.000Z")).toBe(
      "2026. 09. 21. 23:59",
    );
    // …and the one after it rolls over to the next, at hour 00 rather than 24.
    expect(formatTimestamp("2026-09-21T15:00:00.000Z")).toBe(
      "2026. 09. 22. 00:00",
    );
  });

  test("en은 영어 월 이름으로, 같은 서울 시각을 쓴다", () => {
    expect(formatTimestamp("2026-09-21T02:15:00.000Z", "en")).toBe(
      "Sep 21, 2026, 11:15",
    );
    expect(formatTimestamp("2026-09-21T15:00:00.000Z", "en")).toBe(
      "Sep 22, 2026, 00:00",
    );
  });

  test("ja는 연/월/일 순서로, 같은 서울 시각을 쓴다", () => {
    expect(formatTimestamp("2026-09-21T02:15:00.000Z", "ja")).toBe(
      "2026/09/21 11:15",
    );
    expect(formatTimestamp("2026-09-21T15:00:00.000Z", "ja")).toBe(
      "2026/09/22 00:00",
    );
  });

  test("날짜가 아니면 받은 문자열을 그대로 둔다", () => {
    expect(formatTimestamp("나중에")).toBe("나중에");
  });
});
