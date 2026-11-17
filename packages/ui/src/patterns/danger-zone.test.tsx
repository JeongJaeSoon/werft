import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { DangerZone, DangerZoneRow } = await import("../index.ts");

describe("DangerZone", () => {
  test("빨간 제목이 이름인 구역 하나에 빨간 테두리 목록으로 행을 둔다", () => {
    const { getByRole } = render(
      <DangerZone title="위험 구역">
        <DangerZoneRow
          title="GitHub App 삭제"
          description="저장소는 clone할 수 없습니다."
          actionLabel="삭제"
          onAction={() => {}}
        />
      </DangerZone>,
    );
    const region = getByRole("region", { name: "위험 구역" });
    const heading = getByRole("heading", { level: 2, name: "위험 구역" });
    expect(heading.className).toContain("text-destructive");
    const list = region.querySelector("ul");
    expect(list?.className).toContain("border-destructive");
    expect(list?.children[0]?.getAttribute("data-slot")).toBe(
      "danger-zone-row",
    );
  });

  test("행은 설정 행과 같은 배치다: 제목·설명은 왼쪽 열에만 있고, 버튼은 오른쪽 열에서 행 전체의 세로 가운데에 있으며 폰에서도 내려가지 않는다", () => {
    const { getByRole, getByText } = render(
      <DangerZone title="위험 구역">
        <DangerZoneRow
          title="팀 삭제"
          description="팀과 팀 구성원 목록이 지워지고, 이 팀이 관리하던 에이전트는 관리 팀을 잃습니다. 되돌릴 수 없습니다."
          actionLabel="삭제"
          onAction={() => {}}
        />
      </DangerZone>,
    );
    const classes = (element: Element | null | undefined) =>
      element?.className.split(" ") ?? [];
    const row = getByRole("listitem");
    expect(row.getAttribute("data-slot")).toBe("danger-zone-row");
    for (const name of ["grid", "grid-cols-[minmax(0,1fr)_auto]"]) {
      expect(classes(row)).toContain(name);
    }
    for (const name of ["flex-col", "sm:flex-row", "sm:items-start"]) {
      expect(classes(row)).not.toContain(name);
    }
    const title = getByText("팀 삭제").parentElement;
    expect(classes(title)).toContain("col-start-1");
    const lines = getByText(/되돌릴 수 없습니다/).parentElement;
    expect(classes(lines)).toContain("col-start-1");
    expect(classes(lines)).not.toContain("col-span-2");
    const slot = getByRole("button", { name: "팀 삭제" }).parentElement;
    for (const name of [
      "col-start-2",
      "row-start-1",
      "row-span-2",
      "self-center",
    ]) {
      expect(classes(slot)).toContain(name);
    }
    expect(classes(slot)).not.toContain("self-start");
  });

  test("actionRef는 행의 버튼을 가리켜, 확인 창이 닫히면 초점을 돌려받을 수 있다", () => {
    const ref = createRef<HTMLButtonElement>();
    const { getByRole } = render(
      <DangerZone title="위험 구역">
        <DangerZoneRow
          title="팀 삭제"
          description="설명"
          actionLabel="삭제"
          actionRef={ref}
          onAction={() => {}}
        />
      </DangerZone>,
    );
    expect(ref.current === getByRole("button", { name: "팀 삭제" })).toBe(true);
  });

  test("호출한 쪽 className은 구역에만 붙고, 제목·상자 간격과 행 패딩은 그 안 감싸개가 가진다", () => {
    const { getByRole } = render(
      <DangerZone tabIndex={-1} title="위험 구역" className="scroll-mt-4 gap-8">
        <DangerZoneRow
          title="팀 삭제"
          description="설명"
          actionLabel="삭제"
          onAction={() => {}}
        />
      </DangerZone>,
    );
    const region = getByRole("region", { name: "위험 구역" });
    expect(region.getAttribute("tabindex")).toBe("-1");
    expect(region.className.split(" ")).toEqual(["scroll-mt-4", "gap-8"]);
    const heading = getByRole("heading", { name: "위험 구역" });
    const inner = heading.parentElement as HTMLElement;
    expect(inner.parentElement === region).toBe(true);
    // A page may zero the row padding; rows in the red box take it back.
    for (const name of [
      "flex",
      "flex-col",
      "gap-3",
      "[--werft-row-padding-x:var(--werft-space-4)]",
    ]) {
      expect(inner.className.split(" ")).toContain(name);
    }
    expect(inner.querySelector("ul")?.parentElement === inner).toBe(true);
  });

  test("버튼은 동작만 보이고, 이름은 대상을 담은 행 제목이며 actionName이 있으면 그것을 쓴다", () => {
    const { getAllByRole } = render(
      <DangerZone title="위험 구역">
        <DangerZoneRow
          title="팀 삭제"
          description="설명"
          actionLabel="삭제"
          onAction={() => {}}
        />
        <DangerZoneRow
          title={<span>werft-review 연결 해제</span>}
          actionName="werft-review 연결 해제"
          description="설명"
          actionLabel="연결 해제"
          onAction={() => {}}
        />
        <DangerZoneRow
          title="Slack 연결 해제"
          actionName="Slack 앱 연결 해제"
          description="설명"
          actionLabel="연결 해제"
          onAction={() => {}}
        />
      </DangerZone>,
    );
    const buttons = getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "팀 삭제",
      "werft-review 연결 해제",
      "Slack 앱 연결 해제",
    ]);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "삭제",
      "연결 해제",
      "연결 해제",
    ]);
  });

  test("글자가 아닌 제목은 actionName 없이 쓸 수 없다", () => {
    const row = (
      // @ts-expect-error: a JSX title cannot name the button.
      <DangerZoneRow
        title={<span>팀 삭제</span>}
        description="설명"
        actionLabel="삭제"
        onAction={() => {}}
      />
    );
    expect(row === null).toBe(false);
  });

  test("행 제목은 빨간 글씨, 설명은 흐린 글씨다", () => {
    const { getByText } = render(
      <DangerZone title="위험 구역">
        <DangerZoneRow
          title="팀 삭제"
          description="되돌릴 수 없습니다."
          actionLabel="삭제"
          onAction={() => {}}
        />
      </DangerZone>,
    );
    const title = getByText("팀 삭제");
    expect(title.className.split(" ")).toContain("text-destructive");
    const description = getByText("되돌릴 수 없습니다.");
    expect(description.className).not.toContain("text-destructive");
    expect(description.className.split(" ")).toContain(
      "text-subtle-foreground",
    );
  });

  test("행의 버튼은 빨간 바탕에 흰 글씨이고 누르면 행이 아니라 호출한 쪽이 확인을 연다", async () => {
    const user = await setupUser();
    let opened = 0;
    const { getByRole } = render(
      <DangerZone title="위험 구역" titleAs="h3">
        <DangerZoneRow
          title="리뷰용 App 삭제"
          description="리뷰 요청은 거절됩니다."
          actionLabel="삭제"
          actionName="리뷰용 App 삭제"
          onAction={() => {
            opened += 1;
          }}
        />
      </DangerZone>,
    );
    expect(getByRole("heading", { level: 3 })).toBeDefined();
    const button = getByRole("button", { name: "리뷰용 App 삭제" });
    expect(button.textContent).toBe("삭제");
    const classes = button.className.split(" ");
    expect(classes).toContain("bg-destructive-solid");
    expect(classes).toContain("text-destructive-foreground");
    expect(classes).not.toContain("bg-card");
    expect(classes).not.toContain("text-destructive");
    // A RowAction: 28px, width from the label down to the 48px floor.
    expect(button.getAttribute("data-size")).toBe("sm");
    expect(button.className).toContain(
      "min-w-[var(--werft-row-action-button-min-width)]",
    );
    expect(button.className).not.toContain("min-w-24");
    await user.click(button);
    expect(opened).toBe(1);
  });

  test("이유가 있으면 버튼을 막고 그 이유를 설명으로 단다", async () => {
    const user = await setupUser();
    let opened = 0;
    const { getByRole } = render(
      <DangerZone title="위험 구역">
        <DangerZoneRow
          title="팀 삭제"
          description="되돌릴 수 없습니다."
          actionLabel="삭제"
          reason="소유자만 지울 수 있습니다."
          onAction={() => {
            opened += 1;
          }}
        />
      </DangerZone>,
    );
    const button = getByRole("button", {
      name: "팀 삭제",
    }) as HTMLButtonElement;
    expect(button.textContent).toBe("삭제");
    expect(button.disabled).toBe(true);
    // The filled red fades when disabled, so it does not read as ready.
    expect(button.className.split(" ")).toContain("disabled:opacity-50");
    const described = (button.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain("소유자만 지울 수 있습니다.");
    // The box that takes the focus for the disabled button reads the same name.
    const box = button.closest("[data-slot=disabled-reason]");
    expect(box?.getAttribute("aria-label")).toBe("팀 삭제");
    await user.click(button);
    expect(opened).toBe(0);
  });
});
