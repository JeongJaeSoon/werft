import { describe, expect, test } from "bun:test";

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
    expect(list?.children[0]?.getAttribute("data-slot")).toBe("setting-row");
  });

  test("행 패딩을 0으로 둔 페이지에서도 빨간 상자 안 행은 패딩을 되찾고, 테두리 없이 두면 그대로 둔다", () => {
    const { getAllByRole } = render(
      <>
        <DangerZone title="위험 구역">
          <DangerZoneRow
            title="삭제"
            description="설명"
            actionLabel="삭제"
            onAction={() => {}}
          />
        </DangerZone>
        <DangerZone title="테두리 없음" framed={false}>
          <DangerZoneRow
            title="삭제"
            description="설명"
            actionLabel="삭제"
            onAction={() => {}}
          />
        </DangerZone>
      </>,
    );
    const [framed, bare] = getAllByRole("region");
    expect(framed?.className).toContain(
      "[--werft-row-padding-x:var(--werft-space-4)]",
    );
    expect(bare?.className).not.toContain("--werft-row-padding-x");
  });

  test("행의 버튼은 빨간 외곽선이고 누르면 행이 아니라 호출한 쪽이 확인을 연다", async () => {
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
    expect(button.className).toContain(
      "border-[var(--werft-tone-danger-border)]",
    );
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
    const button = getByRole("button", { name: "삭제" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const described = (button.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain("소유자만 지울 수 있습니다.");
    await user.click(button);
    expect(opened).toBe(0);
  });
});
