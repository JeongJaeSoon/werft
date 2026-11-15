import { describe, expect, test } from "bun:test";
import { useId } from "react";

import { setupDom } from "../test-support/dom.ts";
import { Avatar, avatarInitials } from "./avatar.tsx";

const { render } = await setupDom();

describe("Avatar", () => {
  test("이름 없이 그리면 장식으로 숨는다", () => {
    const { container } = render(<Avatar initials="JS" />);
    const avatar = container.querySelector("[data-slot=avatar]");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.getAttribute("role")).toBeNull();
    expect(avatar?.textContent).toBe("JS");
  });

  test("aria 속성을 넘겨도 장식 규칙을 뒤집지 못한다", () => {
    const { container } = render(
      <Avatar initials="JS" aria-hidden={false} role="img" />,
    );
    const avatar = container.querySelector("[data-slot=avatar]");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.getAttribute("role")).toBeNull();
  });

  test("aria-labelledby를 넘겨도 이름은 label이다", () => {
    function Labelled() {
      const other = useId();
      return (
        <>
          <span id={other}>다른 이름</span>
          <Avatar initials="JS" label="정재순" aria-labelledby={other} />
        </>
      );
    }
    const { getByRole, queryByRole } = render(<Labelled />);
    expect(getByRole("img", { name: "정재순" }).textContent).toBe("JS");
    expect(queryByRole("img", { name: "다른 이름" })).toBeNull();
  });

  test("label을 주면 그 이름의 이미지로 읽힌다", () => {
    const { getByRole } = render(<Avatar initials="JS" label="정재순" />);
    const avatar = getByRole("img", { name: "정재순" });
    expect(avatar.getAttribute("aria-hidden")).toBeNull();
    expect(avatar.textContent).toBe("JS");
  });

  test("기본은 24px 원, 11px 글자, active 바탕이다", () => {
    const { container } = render(<Avatar initials="A" />);
    const classes = (
      container.querySelector("[data-slot=avatar]")?.className ?? ""
    ).split(" ");
    for (const name of [
      "size-6",
      "text-2xs",
      "rounded-full",
      "bg-active",
      "text-muted-foreground",
      "font-medium",
    ])
      expect(classes).toContain(name);
  });

  test("lg·square·tone이 32px·6px 모서리·아바타 토큰을 고른다", () => {
    const { container } = render(
      <Avatar initials="A" size="lg" shape="square" tone={3} />,
    );
    const classes = (
      container.querySelector("[data-slot=avatar]")?.className ?? ""
    ).split(" ");
    for (const name of [
      "size-8",
      "text-caption",
      "rounded-control",
      "bg-(color:--werft-avatar-3-bg)",
      "text-(color:--werft-avatar-3-fg)",
    ])
      expect(classes).toContain(name);
    for (const name of ["size-6", "text-2xs", "rounded-full", "bg-active"])
      expect(classes).not.toContain(name);
  });

  test("two-line은 두 줄 높이 토큰으로 정사각형을 만들고 첫 줄 위에 맞춘다", () => {
    const { container } = render(
      <Avatar initials="A" size="two-line" shape="square" />,
    );
    const classes = (
      container.querySelector("[data-slot=avatar]")?.className ?? ""
    ).split(" ");
    for (const name of [
      "size-(--werft-size-tile-two-line)",
      "self-start",
      "text-control",
    ])
      expect(classes).toContain(name);
    expect(classes).not.toContain("size-6");
  });
});

describe("avatarInitials", () => {
  test.each([
    ["Translator (EN)", "TE"],
    ["(Beta) Bot", "BB"],
    ["🦊 Fox", "F"],
    ["🦊 ✨ Fox", "F"],
    ["--- () Alice", "A"],
    ["릴리스 노트 작성", "릴노"],
    ["code-review", "CO"],
    ["Release 2", "R2"],
    ["정재순", "정재"],
  ])("%p → %p", (name, initials) => {
    expect(avatarInitials(name)).toBe(initials);
  });

  test("글자·숫자가 없는 이름은 빈 칸 대신 앞 기호를 쓴다", () => {
    expect(avatarInitials("🦊 ✨")).toBe("🦊✨");
    expect(avatarInitials("--")).toBe("--");
    // Nothing to draw: the avatar keeps its tone fill, as before.
    expect(avatarInitials("   ")).toBe("");
  });
});
