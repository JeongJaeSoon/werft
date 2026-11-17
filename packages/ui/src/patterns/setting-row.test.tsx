import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Badge, Button, NativeSelect, NativeSelectOption, RowList } =
  await import("../index.ts");
const { Switch } = await import("../primitives/switch.tsx");
const { SettingRow } = await import("./setting-row.tsx");

const SWITCH_ID = "receive-dms";
const SELECT_ID = "reaction";

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `missing:${id}`);
}

describe("SettingRow", () => {
  test("RowList joined 안의 <li>로 그리고 행 사이에 선을 둔다", () => {
    const { container } = render(
      <RowList variant="joined">
        <SettingRow title="Slack 연결" />
        <SettingRow title="DM 받기" />
      </RowList>,
    );
    const list = container.querySelector("ul");
    const rows = Array.from(list?.children ?? []);
    expect(rows.map((row) => row.tagName)).toEqual(["LI", "LI"]);
    expect(list?.className).toContain("[&>li]:border-b");
    expect(rows[0]?.getAttribute("data-slot")).toBe("setting-row");
  });

  test("컨트롤 하나는 제목이 이름, 설명이 설명이다", () => {
    const { getByRole } = render(
      <RowList variant="joined">
        <SettingRow
          title="DM 받기"
          badge={<Badge variant="gray">새 기능</Badge>}
          description="에이전트가 DM으로도 답합니다."
          meta={<span>마지막 변경 3분 전</span>}
          status="꺼짐"
          control={<Switch />}
        />
      </RowList>,
    );
    const control = getByRole("switch", { name: "DM 받기" });
    expect(describedBy(control)).toEqual(["에이전트가 DM으로도 답합니다."]);
  });

  test("컨트롤이 자기 id를 가져도 제목이 이름이고 제목을 누르면 바뀐다", async () => {
    const user = await setupUser();
    const { getByRole, getByText } = render(
      <RowList variant="joined">
        <SettingRow
          title="DM 받기"
          description="에이전트가 DM으로도 답합니다."
          control={<Switch id={SWITCH_ID} />}
        />
        <SettingRow
          title="기본 반응"
          control={
            <NativeSelect id={SELECT_ID}>
              <NativeSelectOption value="mention">멘션할 때</NativeSelectOption>
            </NativeSelect>
          }
        />
      </RowList>,
    );
    const control = getByRole("switch", { name: "DM 받기" });
    expect(control.id).toBe(SWITCH_ID);
    expect(describedBy(control)).toEqual(["에이전트가 DM으로도 답합니다."]);
    expect(getByRole("combobox", { name: "기본 반응" }).id).toBe(SELECT_ID);
    await user.click(getByText("DM 받기"));
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  test("버튼은 자기 이름을 지킨다", () => {
    const { getByRole, container } = render(
      <RowList variant="joined">
        <SettingRow
          title="워크스페이스 삭제"
          description="되돌릴 수 없습니다."
          actions={
            <Button type="button" variant="danger" size="sm">
              삭제
            </Button>
          }
        />
      </RowList>,
    );
    expect(getByRole("button").textContent).toBe("삭제");
    expect(getByRole("button", { name: "삭제" }).tagName).toBe("BUTTON");
    expect(container.querySelector("label")).toBe(null);
  });

  test("어느 폭에서나 설명은 왼쪽 열에만 두고, 컨트롤은 오른쪽 열에서 행 전체의 세로 가운데에 두며, 640px 아래에서는 상태 글자만 뺀다", () => {
    const { getByRole, getByText } = render(
      <RowList variant="joined">
        <SettingRow
          title="DM 받기"
          description="에이전트가 DM으로도 답합니다."
          status="꺼짐"
          control={<Switch />}
        />
      </RowList>,
    );
    const classes = (element: Element | null | undefined) =>
      element?.className.split(" ") ?? [];
    const row = getByRole("listitem");
    for (const name of [
      "grid",
      "grid-cols-[minmax(0,1fr)_auto]",
      "items-center",
    ]) {
      expect(classes(row)).toContain(name);
    }
    for (const name of ["flex", "items-start", "sm:items-center"]) {
      expect(classes(row)).not.toContain(name);
    }
    const slot = getByRole("switch").parentElement;
    for (const name of [
      "col-start-2",
      "row-start-1",
      "row-span-2",
      "self-center",
    ]) {
      expect(classes(slot)).toContain(name);
    }
    // No width-dependent placement: the same at 390 as at 1280.
    expect(classes(slot).filter((name) => /^(sm|md|lg):/.test(name))).toEqual(
      [],
    );
    expect(classes(slot)).not.toContain("self-start");
    const title = getByText("DM 받기").parentElement;
    expect(classes(title)).toContain("row-start-1");
    expect(classes(title)).toContain("leading-5");
    // A taller control (a select, a button) centres a one-line title on it.
    expect(classes(title)).toContain("self-center");
    const lines = getByText("에이전트가 DM으로도 답합니다.").parentElement;
    for (const name of ["col-start-1", "row-start-2"]) {
      expect(classes(lines)).toContain(name);
    }
    for (const name of ["col-span-2", "sm:col-span-1"]) {
      expect(classes(lines)).not.toContain(name);
    }
    const status = getByText("꺼짐");
    expect(classes(status)).toEqual(["hidden", "sm:contents"]);
    expect(status.nextElementSibling === getByRole("switch")).toBe(true);
  });

  test("tone이 danger면 제목만 빨간 글씨이고, 기본은 빨갛지 않다", () => {
    const { getByText } = render(
      <RowList variant="joined">
        <SettingRow
          tone="danger"
          title="팀 삭제"
          description="되돌릴 수 없습니다."
          actions={<Button size="sm">삭제</Button>}
        />
        <SettingRow title="DM 받기" description="DM으로도 답합니다." />
      </RowList>,
    );
    expect(getByText("팀 삭제").className.split(" ")).toContain(
      "text-destructive",
    );
    expect(getByText("되돌릴 수 없습니다.").className).not.toContain(
      "text-destructive",
    );
    expect(getByText("DM 받기").className).not.toContain("text-destructive");
  });

  test("설명이 없으면 컨트롤이 두 줄에 걸치지 않는다", () => {
    const { getByRole } = render(
      <RowList variant="joined">
        <SettingRow title="DM 받기" control={<Switch />} />
      </RowList>,
    );
    const slot = getByRole("switch").parentElement;
    expect(slot?.className.split(" ")).not.toContain("sm:row-span-2");
  });

  test("값 줄만 있는 행은 폰에서도 값을 제목 아래 왼쪽 열에 두고, 버튼을 두 줄의 가운데에 둔다", () => {
    const { getByRole, getByText } = render(
      <RowList variant="joined">
        <SettingRow
          title="비상 관리자"
          meta="Dana · dana@example.test"
          actions={<Button size="sm">바꾸기</Button>}
        />
      </RowList>,
    );
    const classes = (element: Element | null | undefined) =>
      element?.className.split(" ") ?? [];
    const slot = getByRole("button").parentElement;
    for (const name of ["col-start-2", "row-start-1", "row-span-2"]) {
      expect(classes(slot)).toContain(name);
    }
    expect(classes(slot)).toContain("self-center");
    expect(classes(slot)).not.toContain("self-start");
    const lines = getByText("Dana · dana@example.test");
    expect(classes(lines)).toContain("col-start-1");
    expect(classes(lines)).toContain("row-start-2");
    expect(classes(lines)).not.toContain("col-span-2");
    expect(classes(lines)).toContain("wrap-anywhere");
  });
});
