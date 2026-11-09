import { describe, expect, test } from "bun:test";

import { Skeleton } from "../primitives/skeleton.tsx";
import {
  setupDom,
  setupUser,
  stubPrefersReducedMotion,
} from "../test-support/dom.ts";
import { htmlOf } from "../test-support/html.ts";
import { EmptyState } from "./empty-state.tsx";
import { ErrorState } from "./error-state.tsx";

const { render } = await setupDom();

describe("EmptyState", () => {
  test("제목·설명·두 동작을 그린다", () => {
    const { container, getByText } = render(
      <EmptyState
        title="아직 세션이 없습니다"
        description="첫 지시를 보내면 여기에 쌓입니다."
        action={<button type="button">새 세션</button>}
        secondaryAction={<button type="button">에이전트 보기</button>}
      />,
    );

    expect(getByText("아직 세션이 없습니다")).toBeDefined();
    expect(
      container.querySelectorAll(".werft-state__actions button"),
    ).toHaveLength(2);
    expect(htmlOf(container.firstElementChild)).toMatchSnapshot();
  });

  test("icon은 제목 위 장식 상자에 들어가고 size는 data-size로 남는다", () => {
    const plain = render(<EmptyState title="비어 있습니다" />);
    expect(plain.container.querySelector(".werft-state__icon")).toBeNull();
    expect(
      plain.container.querySelector(".werft-state")?.getAttribute("data-size"),
    ).toBe("default");

    const { container } = render(
      <EmptyState title="비어 있습니다" icon={<svg />} size="sm" />,
    );
    const root = container.querySelector(".werft-state");
    const box = root?.firstElementChild;
    expect(box?.className).toBe("werft-state__icon");
    expect(box?.getAttribute("aria-hidden")).toBe("true");
    expect(box?.querySelector("svg")).not.toBeNull();
    expect(root?.getAttribute("data-size")).toBe("sm");
  });

  test("framed는 카드 테두리를 그리고 기본은 그리지 않는다", () => {
    const plain = render(<EmptyState title="비어 있습니다" />);
    const bare = plain.container.querySelector(".werft-state");
    expect(bare?.hasAttribute("data-framed")).toBe(false);
    expect(bare?.className).not.toContain("border");

    const { container } = render(<EmptyState title="비어 있습니다" framed />);
    const root = container.querySelector(".werft-state");
    expect(root?.getAttribute("data-framed")).toBe("true");
    expect(root?.className).toContain("rounded-card border bg-card");
  });

  test("조용하다 — alert로 읽히지 않는다", () => {
    const { container } = render(<EmptyState title="비어 있습니다" />);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});

describe("ErrorState", () => {
  test("EmptyState와 다른 모양·다른 역할로 그려진다", () => {
    const empty = render(<EmptyState title="비어 있습니다" />);
    const error = render(
      <ErrorState
        guidance="서버에서 처리하지 못했습니다 — 잠시 뒤 다시 시도하세요."
        message="boom"
        code="INTERNAL_ERROR"
      />,
    );

    const emptyRoot = empty.container.querySelector(".werft-state");
    const errorRoot = error.container.querySelector(".werft-state");

    expect(emptyRoot?.className).toContain("werft-state--empty");
    expect(errorRoot?.className).toContain("werft-state--error");
    expect(emptyRoot?.className).not.toContain("werft-state--error");
    expect(errorRoot?.getAttribute("role")).toBe("alert");
    expect(errorRoot?.querySelector(".werft-state__mark")).not.toBeNull();
    expect(emptyRoot?.querySelector(".werft-state__mark")).toBeNull();
    expect(htmlOf(errorRoot)).toMatchSnapshot();
  });

  test("할 일을 원문보다 먼저 보여준다", () => {
    const { container } = render(
      <ErrorState guidance="다시 로그인하세요." message="token expired" />,
    );
    const lines = [...container.querySelectorAll(".werft-state > p")].map(
      (line) => line.className,
    );
    expect(lines).toEqual([
      "werft-state__title",
      "werft-state__guidance",
      "werft-state__description",
    ]);
  });

  test("할 일을 받지 않으면 안내 줄이 없다", () => {
    const { container } = render(<ErrorState message="boom" code="X" />);
    expect(container.querySelector(".werft-state__guidance")).toBeNull();
  });

  test("retry와 증거 링크를 준 만큼만 그린다", () => {
    const calls: string[] = [];
    const { container } = render(
      <ErrorState
        code="BACKEND_UNAVAILABLE"
        retry={() => calls.push("retry")}
        evidenceLink={{ href: "/journal/1", label: "실행 기록" }}
      />,
    );

    const button = container.querySelector("button");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual(["retry"]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/journal/1",
    );
  });

  test("다시 시도는 아이콘을 단 버튼이고 클릭하면 retry를 부른다", async () => {
    const user = await setupUser();
    const calls: string[] = [];
    const { getByRole } = render(
      <ErrorState retry={() => calls.push("retry")} retryLabel="다시 시도" />,
    );
    expect(getByRole("alert")).toBeDefined();
    const button = getByRole("button", { name: "다시 시도" });
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await user.click(button);
    expect(calls).toEqual(["retry"]);
  });

  test("retry가 없으면 버튼도 없다", () => {
    const { container } = render(<ErrorState code="FORBIDDEN" />);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("Skeleton", () => {
  test("줄 수만큼 막대를 만든다", () => {
    const { container } = render(<Skeleton lines={3} />);
    expect(container.querySelectorAll(".werft-skeleton__bar")).toHaveLength(3);
    expect(htmlOf(container.firstElementChild)).toMatchSnapshot();
  });

  test("text가 아니면 막대는 하나다", () => {
    const { container } = render(<Skeleton shape="circle" lines={5} />);
    expect(container.querySelectorAll(".werft-skeleton__bar")).toHaveLength(1);
  });

  test("읽는 사람에게 로딩 중임을 알린다", () => {
    const { container } = render(<Skeleton />);
    const root = container.querySelector(".werft-skeleton");
    // <output> is role="status" without spelling it out.
    expect(root?.tagName).toBe("OUTPUT");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    expect(root?.textContent).toContain("불러오는 중");
  });

  test("decorative면 보조기술에서 숨는다", () => {
    const { container } = render(<Skeleton decorative inline />);
    const root = container.querySelector(".werft-skeleton");
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(root?.getAttribute("data-inline")).toBe("true");
  });

  test("prefers-reduced-motion이면 깜빡이지 않는다", () => {
    const restore = stubPrefersReducedMotion(true);
    try {
      const { container } = render(<Skeleton />);
      expect(
        container
          .querySelector(".werft-skeleton")
          ?.getAttribute("data-animated"),
      ).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("ErrorState framed", () => {
  test("framed는 카드 틀을 두고 상태 글자색은 그대로 둔다", () => {
    const { getAllByRole } = render(
      <>
        <ErrorState title="불러오지 못했습니다" framed />
        <ErrorState title="틀 없음" />
      </>,
    );
    const [framed, plain] = getAllByRole("alert");
    expect(framed?.getAttribute("data-framed")).toBe("true");
    expect(framed?.classList.contains("rounded-card")).toBe(true);
    expect(framed?.classList.contains("border")).toBe(true);
    expect(framed?.classList.contains("bg-card")).toBe(true);
    expect(framed?.classList.contains("text-card-foreground")).toBe(false);
    expect(plain?.classList.contains("border")).toBe(false);
  });
});
