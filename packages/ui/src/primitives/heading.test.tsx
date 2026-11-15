import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { setupDom } from "../test-support/dom.ts";
import { Heading } from "./heading.tsx";

const { render } = await setupDom();

const classesOf = (element: Element | null) =>
  (element?.className ?? "").split(" ");

describe("Heading", () => {
  test("기본은 h2에 섹션 크기(14px, 20px 줄, 500)다", () => {
    const { getByRole } = render(<Heading>구성원</Heading>);
    const heading = getByRole("heading", { level: 2, name: "구성원" });
    expect(heading.tagName).toBe("H2");
    for (const name of ["text-body", "leading-5", "font-medium", "m-0"])
      expect(classesOf(heading)).toContain(name);
    expect(classesOf(heading)).not.toContain("text-title");
  });

  test("level은 요소만, size는 모양만 바꾼다", () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const { getByRole, unmount } = render(
        <Heading level={level}>제목</Heading>,
      );
      const heading = getByRole("heading", { level });
      expect(heading.tagName).toBe(`H${level}`);
      expect(heading.getAttribute("data-size")).toBe("section");
      expect(classesOf(heading)).toContain("text-body");
      unmount();
    }

    const { getByRole } = render(
      <Heading level={3} size="title">
        워크스페이스
      </Heading>,
    );
    const heading = getByRole("heading", { level: 3 });
    expect(heading.getAttribute("data-size")).toBe("title");
    expect(classesOf(heading)).toContain("text-title");
    for (const name of ["text-body", "leading-5"])
      expect(classesOf(heading)).not.toContain(name);
  });

  test("className이 크기 유틸리티를 덮고 ref·나머지 props가 h 요소에 간다", () => {
    const ref = createRef<HTMLHeadingElement>();
    const { getByRole } = render(
      <Heading ref={ref} title="전체" className="text-caption mb-2">
        설정
      </Heading>,
    );
    const heading = getByRole("heading");
    expect(ref.current === heading).toBe(true);
    expect(heading.getAttribute("title")).toBe("전체");
    expect(classesOf(heading)).toContain("text-caption");
    expect(classesOf(heading)).toContain("mb-2");
    expect(classesOf(heading)).not.toContain("text-body");
    // A caller's size keeps the part's line.
    expect(classesOf(heading)).toContain("leading-5");
  });

  test("호출자의 leading은 부품의 줄을 대신한다", () => {
    const { getByRole } = render(
      <Heading size="title" className="leading-5">
        제목
      </Heading>,
    );
    const classes = classesOf(getByRole("heading"));
    expect(classes).toContain("leading-5");
    expect(classes).not.toContain("leading-7");
  });
});
