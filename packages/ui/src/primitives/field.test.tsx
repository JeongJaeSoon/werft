import { describe, expect, test } from "bun:test";
import { useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";
import { buttonVariants } from "./button.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./field.tsx";
import { Input } from "./input.tsx";
import { NativeSelect, NativeSelectOption } from "./native-select.tsx";
import { Textarea } from "./textarea.tsx";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Checkbox } = await import("./checkbox.tsx");
const { RadioGroup, RadioGroupItem } = await import("./radio-group.tsx");

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `missing:${id}`);
}

describe("Field", () => {
  test("label·설명·오류를 입력과 잇는다", () => {
    const { getByRole } = render(
      <Field>
        <FieldLabel>에이전트 이름</FieldLabel>
        <Input />
        <FieldDescription>팀 안에서 겹치지 않아야 합니다.</FieldDescription>
        <FieldError>이미 쓰는 이름입니다.</FieldError>
      </Field>,
    );
    const input = getByRole("textbox", { name: "에이전트 이름" });
    expect(describedBy(input)).toEqual([
      "팀 안에서 겹치지 않아야 합니다.",
      "이미 쓰는 이름입니다.",
    ]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(getByRole("alert").textContent).toBe("이미 쓰는 이름입니다.");
  });

  test("없는 부분은 aria-describedby에 넣지 않고 오류가 없으면 invalid가 아니다", () => {
    const { getByRole } = render(
      <Field>
        <FieldLabel>설명</FieldLabel>
        <Textarea />
        <FieldError>{undefined}</FieldError>
      </Field>,
    );
    const textarea = getByRole("textbox", { name: "설명" });
    expect(textarea.hasAttribute("aria-describedby")).toBe(false);
    expect(textarea.hasAttribute("aria-invalid")).toBe(false);
  });

  test("오류가 사라지면 연결과 invalid도 걷힌다", async () => {
    function Harness() {
      const [error, setError] = useState<string | undefined>("필수입니다.");
      return (
        <>
          <Field>
            <FieldLabel>팀 이름</FieldLabel>
            <Input />
            <FieldError>{error}</FieldError>
          </Field>
          <button type="button" onClick={() => setError(undefined)}>
            고침
          </button>
        </>
      );
    }
    const { getByRole } = render(<Harness />);
    const input = getByRole("textbox", { name: "팀 이름" });
    expect(describedBy(input)).toEqual(["필수입니다."]);
    await (await setupUser()).click(getByRole("button", { name: "고침" }));
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  test("호출자가 준 id·aria-describedby는 남기고 Field의 것을 덧붙인다", () => {
    const [hintId, inputId] = ["hint", "own"];
    const { getByRole } = render(
      <>
        <p id={hintId}>공통 안내</p>
        <Field>
          <FieldLabel htmlFor={inputId}>주소</FieldLabel>
          <Input id={inputId} aria-describedby={hintId} />
          <FieldDescription>https로 시작합니다.</FieldDescription>
        </Field>
      </>,
    );
    const input = getByRole("textbox", { name: "주소" });
    expect(input.id).toBe(inputId);
    expect(describedBy(input)).toEqual(["공통 안내", "https로 시작합니다."]);
  });

  test("설명·오류에 준 id가 그대로 연결된다", () => {
    const [descriptionId, errorId] = ["own-description", "own-error"];
    const { getByRole } = render(
      <Field>
        <FieldLabel>주소</FieldLabel>
        <Input />
        <FieldDescription id={descriptionId}>
          https로 시작합니다.
        </FieldDescription>
        <FieldError id={errorId}>주소 형식이 아닙니다.</FieldError>
      </Field>,
    );
    const input = getByRole("textbox", { name: "주소" });
    expect(input.getAttribute("aria-describedby")).toBe(
      `${descriptionId} ${errorId}`,
    );
  });

  test("설명이 둘이면 둘 다 잇고, 하나가 빠져도 남은 것은 이어진다", async () => {
    function Harness() {
      const [extra, setExtra] = useState(true);
      return (
        <>
          <Field>
            <FieldLabel>이름</FieldLabel>
            <Input />
            <FieldDescription>영문 소문자만 씁니다.</FieldDescription>
            {extra ? (
              <FieldDescription>나중에 못 바꿉니다.</FieldDescription>
            ) : null}
          </Field>
          <button type="button" onClick={() => setExtra(false)}>
            줄이기
          </button>
        </>
      );
    }
    const { getByRole } = render(<Harness />);
    const input = getByRole("textbox", { name: "이름" });
    expect(describedBy(input)).toEqual([
      "영문 소문자만 씁니다.",
      "나중에 못 바꿉니다.",
    ]);
    await (await setupUser()).click(getByRole("button", { name: "줄이기" }));
    expect(describedBy(input)).toEqual(["영문 소문자만 씁니다."]);
  });

  test("빈 문자열 오류는 오류가 아니다", () => {
    const { getByRole, queryByRole } = render(
      <Field>
        <FieldLabel>팀 이름</FieldLabel>
        <Input />
        <FieldError>{""}</FieldError>
      </Field>,
    );
    const input = getByRole("textbox", { name: "팀 이름" });
    expect(queryByRole("alert")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  test("Field 밖의 입력은 아무것도 덧붙이지 않는다", () => {
    const { getByRole } = render(<Input aria-label="검색" />);
    const input = getByRole("textbox", { name: "검색" });
    expect(input.hasAttribute("id")).toBe(false);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  test("Checkbox도 자기 Field의 label로 이름을 얻고, label을 누르면 바뀐다", async () => {
    const user = await setupUser();
    const { getByRole, getByText } = render(
      <FieldSet>
        <FieldLegend>알림</FieldLegend>
        <Field orientation="horizontal">
          <Checkbox />
          <FieldLabel>승인 요청이 오면 알립니다</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <Checkbox defaultChecked={true} />
          <FieldLabel>세션이 끝나면 알립니다</FieldLabel>
        </Field>
      </FieldSet>,
    );
    const first = getByRole("checkbox", { name: "승인 요청이 오면 알립니다" });
    expect(
      getByRole("checkbox", { name: "세션이 끝나면 알립니다" }).id,
    ).not.toBe(first.id);
    await user.click(getByText("승인 요청이 오면 알립니다"));
    expect(first.getAttribute("aria-checked")).toBe("true");
  });

  test("NativeSelect는 label·오류와 이어지고 이름으로 폼에 제출된다", () => {
    const { getByRole, container } = render(
      <form>
        <Field>
          <FieldLabel>모델</FieldLabel>
          <NativeSelect name="model" defaultValue="deep">
            <NativeSelectOption value="fast">빠른 모델</NativeSelectOption>
            <NativeSelectOption value="deep">깊은 모델</NativeSelectOption>
          </NativeSelect>
          <FieldError>이 모델은 지금 쓸 수 없습니다.</FieldError>
        </Field>
      </form>,
    );
    const select = getByRole("combobox", { name: "모델" });
    expect(describedBy(select)).toEqual(["이 모델은 지금 쓸 수 없습니다."]);
    expect(select.getAttribute("aria-invalid")).toBe("true");
    const form = container.querySelector("form") as HTMLFormElement;
    expect(new FormData(form).get("model")).toBe("deep");
  });

  // happy-dom computes no layout, so the height is pinned by class.
  test("NativeSelect 기본·sm은 Input·Button과 같은 컨트롤 높이 토큰을 쓴다", () => {
    const { getByRole } = render(
      <>
        <NativeSelect aria-label="기본">
          <NativeSelectOption>멤버</NativeSelectOption>
        </NativeSelect>
        <NativeSelect aria-label="작게" size="sm">
          <NativeSelectOption>멤버</NativeSelectOption>
        </NativeSelect>
        <Input aria-label="입력" />
      </>,
    );
    const base = getByRole("combobox", { name: "기본" });
    const small = getByRole("combobox", { name: "작게" });
    expect(base.dataset.size).toBe("default");
    expect(small.dataset.size).toBe("sm");
    expect(base.classList.contains("h-[var(--werft-control-height)]")).toBe(
      true,
    );
    expect(
      small.classList.contains(
        "data-[size=sm]:h-[var(--werft-control-height-sm)]",
      ),
    ).toBe(true);
    expect(
      getByRole("textbox", { name: "입력" }).classList.contains(
        "h-[var(--werft-control-height)]",
      ),
    ).toBe(true);
    expect(buttonVariants()).toContain("h-[var(--werft-control-height)]");
    expect(buttonVariants({ size: "sm" })).toContain(
      "h-[var(--werft-control-height-sm)]",
    );
  });

  test("RadioGroupItem은 각자 자기 Field의 label로 이름을 얻는다", async () => {
    const user = await setupUser();
    const legendId = "where";
    const { getByRole, getByText } = render(
      <FieldSet>
        <FieldLegend id={legendId}>실행 위치</FieldLegend>
        <RadioGroup defaultValue="local" aria-labelledby={legendId}>
          <Field orientation="horizontal">
            <RadioGroupItem value="local" />
            <FieldLabel>로컬</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="remote" />
            <FieldLabel>원격</FieldLabel>
          </Field>
        </RadioGroup>
      </FieldSet>,
    );
    expect(getByRole("radiogroup", { name: "실행 위치" })).toBeTruthy();
    const local = getByRole("radio", { name: "로컬" });
    const remote = getByRole("radio", { name: "원격" });
    expect(local.getAttribute("aria-checked")).toBe("true");
    expect(remote.id).not.toBe(local.id);
    await user.click(getByText("원격"));
    expect(remote.getAttribute("aria-checked")).toBe("true");
  });

  test("선택 카드는 손가락 커서이고 고르지 않은 카드는 포인터를 올리면 테두리·바탕이 바뀐다", () => {
    const { container } = render(
      <RadioGroup defaultValue="light" aria-label="테마">
        <FieldLabel>
          <Field orientation="horizontal">
            <RadioGroupItem value="light" />
            <FieldContent>밝게</FieldContent>
          </Field>
        </FieldLabel>
      </RadioGroup>,
    );
    const card = container.querySelector(
      "[data-slot=field-label]",
    ) as HTMLElement;
    const classes = card.className.split(" ");
    expect(classes).toContain("has-[>[data-slot=field]]:cursor-pointer");
    expect(classes).toContain(
      "has-[>[data-slot=field]]:has-[:disabled]:cursor-not-allowed",
    );
    for (const hover of ["border-border-strong", "bg-hover"]) {
      expect(classes).toContain(
        `has-[>[data-slot=field]]:not-has-[:disabled,[data-state=checked]]:hover:${hover}`,
      );
    }
  });
});

describe("Textarea", () => {
  // No layout engine here: an explicit height switches field-sizing off in a
  // browser, so the class list is what keeps the field growing with its text.
  test("내용에 따라 늘어나도록 고정 높이 없이 최소·최대 높이만 둔다", () => {
    const { getByRole } = render(<Textarea aria-label="다음 지시" />);
    const classes = getByRole("textbox", { name: "다음 지시" }).className.split(
      /\s+/,
    );
    expect(classes).toContain("field-sizing-content");
    expect(classes.filter((name) => /^h-/.test(name))).toEqual([]);
    expect(classes.some((name) => /^min-h-/.test(name))).toBe(true);
    expect(classes.some((name) => /^max-h-/.test(name))).toBe(true);
  });
});
