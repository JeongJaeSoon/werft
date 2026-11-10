import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { setupDom } from "../test-support/dom.ts";
import { Code, CodeBlock } from "./code.tsx";

const { render } = await setupDom();

const classesOf = (element: Element | null | undefined) =>
  (element?.className ?? "").split(" ");

describe("Code", () => {
  test("줄 안 코드는 배경 없는 12px mono code 요소다", () => {
    const { container } = render(
      <p>
        <Code>AP_TOKEN</Code>을 넣는다
      </p>,
    );
    const code = container.querySelector("[data-slot=code]");
    expect(code?.tagName).toBe("CODE");
    expect(code?.parentElement?.tagName).toBe("P");
    for (const name of ["font-mono", "text-caption", "font-normal"])
      expect(classesOf(code)).toContain(name);
    expect(classesOf(code)).toContain("bg-muted");
  });

  test('size="inherit"는 부모의 크기와 굵기를 따른다', () => {
    const { container } = render(
      <p className="font-medium text-control">
        모델 <Code size="inherit">claude-opus</Code>
      </p>,
    );
    const classes = classesOf(container.querySelector("[data-slot=code]"));
    expect(classes).toContain("font-mono");
    expect(classes).toContain("[font-size:inherit]");
    expect(classes).toContain("[font-weight:inherit]");
    for (const name of ["text-caption", "font-normal"])
      expect(classes).not.toContain(name);
  });

  test("className을 합치고 ref·나머지 props를 넘긴다", () => {
    const ref = createRef<HTMLElement>();
    const { container } = render(
      <Code ref={ref} translate="no" className="text-control">
        x
      </Code>,
    );
    const code = container.querySelector("[data-slot=code]");
    expect(ref.current === code).toBe(true);
    expect(code?.getAttribute("translate")).toBe("no");
    expect(classesOf(code)).toContain("text-control");
    expect(classesOf(code)).not.toContain("text-caption");
  });
});

describe("CodeBlock", () => {
  test("pre 안 code에 줄바꿈을 그대로 두고 v4 .code 모양을 건다", () => {
    const { container } = render(
      <CodeBlock>{"$ bun test\n12 pass"}</CodeBlock>,
    );
    const pre = container.querySelector("[data-slot=code-block]");
    expect(pre?.tagName).toBe("PRE");
    const code = pre?.firstElementChild;
    expect(code?.tagName).toBe("CODE");
    expect(code?.textContent).toBe("$ bun test\n12 pass");
    for (const name of [
      "m-0",
      "whitespace-pre-wrap",
      "wrap-anywhere",
      "rounded-control",
      "border",
      "bg-muted",
      "px-3",
      "py-2",
      "font-mono",
      "text-caption",
      "leading-[1.6]",
      "text-foreground",
    ])
      expect(classesOf(pre)).toContain(name);
  });

  test("className·ref·나머지 props는 pre에 간다", () => {
    const ref = createRef<HTMLPreElement>();
    const { container } = render(
      <CodeBlock ref={ref} title="출력" className="bg-background">
        ok
      </CodeBlock>,
    );
    const pre = container.querySelector("[data-slot=code-block]");
    expect(ref.current === pre).toBe(true);
    expect(pre?.getAttribute("title")).toBe("출력");
    expect(classesOf(pre)).toContain("bg-background");
    expect(classesOf(pre)).not.toContain("bg-muted");
  });

  test("호출자의 크기 클래스가 1.6 줄을 지우지 않는다", () => {
    const { container } = render(
      <CodeBlock className="text-control">ok</CodeBlock>,
    );
    const classes = classesOf(
      container.querySelector("[data-slot=code-block]"),
    );
    expect(classes).toContain("text-control");
    expect(classes).toContain("leading-[1.6]");
  });
});
