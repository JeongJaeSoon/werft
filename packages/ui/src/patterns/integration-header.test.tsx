import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Badge, IntegrationHeader } = await import("../index.ts");

const Mark = () => <svg />;

describe("IntegrationHeader", () => {
  test("제목은 h2이고, 상태·요약·동작·설명·안내가 각자 자리에 놓인다", () => {
    const { getByRole, getByText } = render(
      <section aria-labelledby="title">
        <IntegrationHeader
          icon={Mark}
          title="GitHub"
          titleId="title"
          status={<Badge variant="green">켜짐</Badge>}
          summary="저장소 2개 · push 전 승인 켜짐"
          action={<button type="button">GitHub 켜기</button>}
          description="이 에이전트가 GitHub에서 하는 일입니다."
        >
          <p>꺼져 있으면 GitHub 도구를 쓰지 않습니다.</p>
        </IntegrationHeader>
      </section>,
    );
    // The section around it takes its name from the title.
    getByRole("region", { name: "GitHub" });
    const heading = getByRole("heading", { level: 2, name: "GitHub" });
    expect(heading.hasAttribute("tabindex")).toBe(false);
    const root = heading.closest("[data-slot=integration-header]");
    expect(root?.className.split(" ")).toEqual(["flex", "flex-col", "gap-4"]);
    // The badge sits beside the heading, not inside its name.
    const status = getByText("켜짐");
    expect(heading.contains(status)).toBe(false);
    expect(status.parentElement === heading.parentElement).toBe(true);
    // The mark spans the title and summary lines.
    const row = root?.firstElementChild as HTMLElement;
    const tile = row.querySelector("[data-slot=icon-tile]");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(tile?.className).toContain("self-start");
    const summary = getByText("저장소 2개 · push 전 승인 켜짐");
    expect(summary.getAttribute("data-variant")).toBe("sub");
    expect(heading.parentElement?.nextElementSibling === summary).toBe(true);
    // The action ends the row; the description and notes follow it.
    expect(row.lastElementChild === getByRole("button")).toBe(true);
    const description = getByText("이 에이전트가 GitHub에서 하는 일입니다.");
    expect(row.nextElementSibling === description).toBe(true);
    expect(
      description.nextElementSibling ===
        getByText("꺼져 있으면 GitHub 도구를 쓰지 않습니다."),
    ).toBe(true);
  });

  test("titleRef를 주면 제목이 초점을 받을 수 있고, 빈 자리는 그리지 않는다", () => {
    const ref = createRef<HTMLHeadingElement>();
    const { getByRole } = render(
      <IntegrationHeader icon={Mark} title="Slack" titleRef={ref} />,
    );
    const heading = getByRole("heading", { level: 2, name: "Slack" });
    expect(ref.current === heading).toBe(true);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    heading.focus();
    expect(document.activeElement === heading).toBe(true);
    const root = heading.closest("[data-slot=integration-header]");
    // Only the title row: no summary, action, description or notes.
    expect(root?.children.length).toBe(1);
    expect(heading.parentElement?.parentElement?.children.length).toBe(1);
  });

  test("호출한 쪽 className과 속성은 바깥 틀에 붙는다", () => {
    const { container } = render(
      <IntegrationHeader
        icon={Mark}
        title="GitHub"
        className="mt-2"
        data-testid="card"
      />,
    );
    const root = container.querySelector("[data-slot=integration-header]");
    expect(root?.getAttribute("data-testid")).toBe("card");
    expect(root?.className).toContain("mt-2");
  });
});
