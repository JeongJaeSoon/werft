import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { Card, CardTitle } from "./card.tsx";
import { Checkbox } from "./checkbox.tsx";
import { Input } from "./input.tsx";
import { NativeSelect, NativeSelectOption } from "./native-select.tsx";
import { Textarea } from "./textarea.tsx";

const { render } = await setupDom();

describe("Button", () => {
  test("variant가 의미 변수 유틸리티로 그려진다", () => {
    const { getByRole } = render(
      <Button type="button" variant="destructive">
        삭제
      </Button>,
    );
    const button = getByRole("button", { name: "삭제" });
    expect(button.className).toContain("bg-destructive-solid");
    expect(button.className).toContain("text-destructive-foreground");
    expect(button.className).toContain("text-control");
  });

  test("danger는 채우지 않고 빨간 글자와 테두리로 그린다", () => {
    const { getByRole } = render(
      <Button type="button" variant="danger">
        취소
      </Button>,
    );
    const classes = getByRole("button").className.split(" ");
    expect(classes).toContain("text-destructive");
    expect(classes).toContain("border-[var(--werft-tone-danger-border)]");
    expect(classes).toContain("hover:bg-[var(--werft-tone-danger-bg)]");
    expect(classes).toContain("bg-card");
  });

  test("icon-sm은 28px 정사각형이다", () => {
    const { getByRole } = render(
      <Button type="button" size="icon-sm" aria-label="복사" />,
    );
    const button = getByRole("button", { name: "복사" });
    expect(button.getAttribute("data-size")).toBe("icon-sm");
    expect(button.className.split(" ")).toContain(
      "size-[var(--werft-control-height-sm)]",
    );
  });

  test("outline은 연한 테두리에 hover 바탕을 쓴다", () => {
    const { getByRole } = render(
      <Button type="button" variant="outline">
        세션 목록
      </Button>,
    );
    const classes = getByRole("button").className.split(" ");
    expect(classes).toContain("border-border");
    expect(classes).toContain("hover:bg-hover");
    expect(classes).not.toContain("border-input");
  });

  test("비활성은 다른 컨트롤과 같은 0.5로 흐려지고 누를 수 없다", () => {
    const { getByRole } = render(
      <Button type="button" disabled={true}>
        저장
      </Button>,
    );
    const classes = getByRole("button").className.split(" ");
    expect(classes).toContain("disabled:opacity-50");
    expect(classes).toContain("disabled:pointer-events-none");
  });

  test("aria-disabled도 0.5로 흐려지지만 포인터를 막지 않고 포커스를 지킨다", () => {
    const { getByRole } = render(
      <Button type="button" aria-disabled={true}>
        저장 중
      </Button>,
    );
    const button = getByRole("button", { name: "저장 중" });
    const classes = button.className.split(" ");
    expect(classes).toContain("aria-disabled:opacity-50");
    expect(classes.filter((c) => c.startsWith("aria-disabled:"))).toEqual([
      "aria-disabled:opacity-50",
    ]);
    button.focus();
    expect(document.activeElement === button).toBe(true);
  });

  test("호출자가 지정한 aria-disabled 투명도가 기본값을 이긴다", () => {
    const { getByRole } = render(
      <Button
        type="button"
        aria-disabled={true}
        className="aria-disabled:opacity-70"
      >
        만들기
      </Button>,
    );
    const classes = getByRole("button").className.split(" ");
    expect(classes).toContain("aria-disabled:opacity-70");
    expect(classes).not.toContain("aria-disabled:opacity-50");
  });

  test("호출자 className이 같은 축의 variant 유틸리티를 이긴다", () => {
    const { getByRole } = render(
      <Button type="button" className="px-2">
        좁게
      </Button>,
    );
    const classes = getByRole("button").className.split(" ");
    expect(classes).toContain("px-2");
    expect(classes).not.toContain("px-4");
  });

  test("asChild면 버튼을 겹치지 않고 자식 링크에 모양을 입힌다", () => {
    const { container } = render(
      <Button asChild={true} variant="outline">
        <a href="/agents">에이전트</a>
      </Button>,
    );
    const link = container.querySelector("a");
    expect(container.querySelector("button")).toBeNull();
    expect(link?.getAttribute("data-slot")).toBe("button");
    expect(link?.className.split(" ")).toContain("border-border");
  });

  test("motion-reduce에서 transition을 끈다", () => {
    const { getByRole } = render(<Button type="button">확인</Button>);
    expect(getByRole("button").className).toContain(
      "motion-reduce:transition-none",
    );
  });
});

describe("포커스", () => {
  const OUTLINE = [
    "focus-visible:outline-2",
    "focus-visible:outline-offset-2",
    "focus-visible:outline-focus-ring",
  ];

  test("조작 부품은 링 없이 2px 외곽선 하나로 포커스를 그린다", () => {
    const { container } = render(
      <>
        <Button type="button">확인</Button>
        <Input aria-label="이름" />
        <NativeSelect aria-label="상태">
          <NativeSelectOption value="all">전체</NativeSelectOption>
        </NativeSelect>
        <Textarea aria-label="메모" />
        <Checkbox aria-label="동의" />
      </>,
    );
    const slots = ["button", "input", "native-select", "textarea", "checkbox"];
    for (const slot of slots) {
      const node = container.querySelector(`[data-slot="${slot}"]`);
      const classes = node?.className.split(" ") ?? [];
      expect({
        slot,
        missing: OUTLINE.filter((c) => !classes.includes(c)),
      }).toEqual({ slot, missing: [] });
      expect({
        slot,
        ring: classes.filter((c) => /(^|:)ring(-|$)|outline-none/.test(c)),
      }).toEqual({ slot, ring: [] });
    }
  });

  test("일부만 고른 체크박스는 고른 것처럼 채우고 체크 대신 줄을 보인다", () => {
    const { getByRole } = render(
      <Checkbox aria-label="모두 고르기" checked="indeterminate" />,
    );
    const box = getByRole("checkbox", { name: "모두 고르기" });
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    const classes = box.className.split(" ");
    expect(classes).toContain("data-[state=indeterminate]:bg-primary");
    expect(classes).toContain("data-[state=indeterminate]:border-primary");
    const icons = Array.from(box.querySelectorAll("svg"));
    expect(icons.map((icon) => icon.getAttribute("class"))).toEqual([
      expect.stringContaining("group-data-[state=indeterminate]:hidden"),
      expect.stringContaining("group-data-[state=indeterminate]:block"),
    ]);
  });

  test("체크박스는 고르지 않은 정상 상태에서만 포인터에 테두리와 바탕이 바뀐다", () => {
    const { getByRole } = render(<Checkbox aria-label="알림" />);
    const classes = getByRole("checkbox").className.split(" ");
    const hover = classes.filter((c) => c.includes("hover:"));
    expect(hover.sort()).toEqual([
      "enabled:not-aria-invalid:data-[state=unchecked]:hover:bg-hover",
      "enabled:not-aria-invalid:data-[state=unchecked]:hover:border-foreground",
    ]);
  });

  test("입력 칸은 네 변 모두 border-input 테두리를 두고 hover에 진해진다", () => {
    const { container } = render(
      <>
        <Input aria-label="이름" />
        <NativeSelect aria-label="상태" />
        <Textarea aria-label="메모" />
      </>,
    );
    for (const slot of ["input", "native-select", "textarea"]) {
      const classes =
        container
          .querySelector(`[data-slot="${slot}"]`)
          ?.className.split(" ") ?? [];
      expect(classes).toContain("border-input");
      expect(classes).not.toContain("border-border-strong");
      expect(classes).not.toContain("border-b-input");
      // Hover only on an enabled, valid field: the red edge and a withheld
      // field keep their look under the pointer.
      expect(classes).toContain(
        "enabled:not-aria-invalid:hover:border-subtle-foreground",
      );
      expect(classes).not.toContain("hover:border-subtle-foreground");
    }
  });
});

describe("Badge · Card", () => {
  test("data-slot으로 자기 자리를 밝힌다", () => {
    const { container } = render(
      <Card>
        <CardTitle>결제 담당</CardTitle>
        <Badge variant="gray">초안</Badge>
      </Card>,
    );
    expect(
      [...container.querySelectorAll("[data-slot]")].map((node) =>
        node.getAttribute("data-slot"),
      ),
    ).toEqual(["card", "card-title", "badge"]);
  });
});
