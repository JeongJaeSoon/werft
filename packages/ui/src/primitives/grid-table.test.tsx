import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const {
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
} = await import("./grid-table.tsx");

const COLUMNS =
  "minmax(0,2.2fr) 120px minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1fr) 72px";

function Sessions({
  onOpen = () => {},
  onStop = () => {},
}: {
  readonly onOpen?: () => void;
  readonly onStop?: () => void;
}) {
  return (
    <GridTable aria-label="세션" columns={COLUMNS} minWidth="52rem">
      <GridTableHeader>
        <GridTableColumnHeader>제목</GridTableColumnHeader>
        <GridTableColumnHeader>상태</GridTableColumnHeader>
        <GridTableColumnHeader>에이전트</GridTableColumnHeader>
        <GridTableColumnHeader>저장소</GridTableColumnHeader>
        <GridTableColumnHeader>시작</GridTableColumnHeader>
        <GridTableColumnHeader align="end">최근</GridTableColumnHeader>
      </GridTableHeader>
      {["배포 점검", "요금 분석"].map((title) => (
        <GridTableRow key={title}>
          <GridTableCell lines={true}>
            <GridTableRowOpener
              aria-label={`세션 열기: ${title}`}
              onClick={onOpen}
            />
            <span>{title}</span>
            <span>ses_01</span>
          </GridTableCell>
          <GridTableCell>실행 중</GridTableCell>
          <GridTableCell raised={true}>
            <button type="button" onClick={onStop}>
              멈추기
            </button>
          </GridTableCell>
          <GridTableCell>werft/api</GridTableCell>
          <GridTableCell>김하나</GridTableCell>
          <GridTableCell align="end">3분 전</GridTableCell>
        </GridTableRow>
      ))}
    </GridTable>
  );
}

describe("GridTable", () => {
  test("이름 있는 table 안에 row·columnheader·cell이 있고 행마다 셀 수가 머리 셀 수와 같다", () => {
    const { getByRole, getAllByRole } = render(<Sessions />);
    const table = getByRole("table", { name: "세션" });
    const rows = getAllByRole("row");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.parentElement === table).toBe(true);
    const headers = getAllByRole("columnheader");
    expect(headers).toHaveLength(6);
    for (const row of rows.slice(1)) {
      expect(row.querySelectorAll("[role=cell]")).toHaveLength(headers.length);
    }
  });

  test("열 템플릿과 최소 폭은 표의 변수로 모든 행에 가고, 표는 가로 스크롤 상자 안에 있다", () => {
    const { getByRole, getAllByRole } = render(<Sessions />);
    const table = getByRole("table");
    expect(table.style.getPropertyValue("--grid-table-columns")).toBe(COLUMNS);
    expect(table.style.getPropertyValue("--grid-table-min-width")).toBe(
      "52rem",
    );
    expect(
      table.classList.contains("min-w-[var(--grid-table-min-width)]"),
    ).toBe(true);
    const scroller = table.parentElement as HTMLElement;
    expect(scroller.getAttribute("data-slot")).toBe("grid-table-scroll");
    expect(scroller.classList.contains("overflow-x-auto")).toBe(true);
    for (const row of getAllByRole("row")) {
      expect(
        row.classList.contains("grid-cols-[var(--grid-table-columns)]"),
      ).toBe(true);
    }
  });

  test("최소 폭을 주지 않으면 토큰 값을 쓰고, 넘치지 않는 상자는 Tab을 받지 않는다", () => {
    const { getByRole } = render(
      <GridTable aria-label="구성원" columns="minmax(0,1fr) 120px">
        <GridTableHeader>
          <GridTableColumnHeader>이름</GridTableColumnHeader>
          <GridTableColumnHeader>역할</GridTableColumnHeader>
        </GridTableHeader>
      </GridTable>,
    );
    const table = getByRole("table", { name: "구성원" });
    expect(table.style.getPropertyValue("--grid-table-min-width")).toBe(
      "var(--werft-table-min-width)",
    );
    const scroller = table.parentElement as HTMLElement;
    expect(scroller.hasAttribute("tabindex")).toBe(false);
    expect(scroller.hasAttribute("role")).toBe(false);
  });

  test("머리 행은 배경 없이 아래 선만 두고 본문 행은 56px 바닥을 갖는다", () => {
    const { getAllByRole } = render(<Sessions />);
    const [header, body] = getAllByRole("row") as HTMLElement[];
    expect(header?.className).not.toContain("bg-");
    expect(header?.classList.contains("border-b")).toBe(true);
    expect(
      body?.classList.contains("min-h-[var(--werft-table-row-min-height)]"),
    ).toBe(true);
    for (const row of [header, body])
      expect(row?.classList.contains("px-[var(--werft-table-padding-x)]")).toBe(
        true,
      );
  });

  test("aria-busy를 표에 넘긴다", () => {
    const { getByRole } = render(
      <GridTable aria-labelledby="t" aria-busy={true} columns="1fr">
        <GridTableHeader>
          <GridTableColumnHeader>이름</GridTableColumnHeader>
        </GridTableHeader>
      </GridTable>,
    );
    expect(getByRole("table").getAttribute("aria-busy")).toBe("true");
    expect(getByRole("table").getAttribute("aria-labelledby")).toBe("t");
  });

  test("여는 버튼에 Tab으로 닿아 Enter로 열고 셀 안 버튼은 따로 눌린다", async () => {
    let opened = 0;
    let stopped = 0;
    const { getAllByRole, getByRole } = render(
      <Sessions onOpen={() => opened++} onStop={() => stopped++} />,
    );
    const user = await setupUser();
    const opener = getByRole("button", { name: "세션 열기: 배포 점검" });
    expect(opener.getAttribute("type")).toBe("button");
    await user.tab();
    expect(document.activeElement === opener).toBe(true);
    await user.keyboard("{Enter}");
    expect(opened).toBe(1);
    await user.tab();
    const stop = getAllByRole("button", { name: "멈추기" })[0] as HTMLElement;
    expect(document.activeElement === stop).toBe(true);
    await user.click(stop);
    expect([opened, stopped]).toEqual([1, 1]);
    // The stop button sits in a raised cell, above the opener.
    expect(stop.parentElement?.classList.contains("z-1")).toBe(true);
    expect(opener.parentElement?.classList.contains("z-1")).toBe(false);
  });

  test("여는 버튼이 있는 행만 hover 배경을 받고 asChild면 링크가 여는 자리가 된다", () => {
    const { getAllByRole, getByRole } = render(
      <GridTable aria-label="구성원" columns="1fr">
        <GridTableRow>
          <GridTableCell>
            <GridTableRowOpener aria-label="열기: 김하나" asChild={true}>
              {/* biome-ignore lint/a11y/useAnchorContent: the opener's aria-label names the link. */}
              <a href="/members/1" />
            </GridTableRowOpener>
            김하나
          </GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    const link = getByRole("link", { name: "열기: 김하나" });
    expect(link.tagName).toBe("A");
    expect(link.hasAttribute("type")).toBe(false);
    expect(link.classList.contains("absolute")).toBe(true);
    const row = getAllByRole("row")[0] as HTMLElement;
    expect(row.className).toContain(
      "has-[[data-slot=grid-table-row-opener]]:hover:bg-hover",
    );
  });

  test("inactive 행만 data-inactive를 갖는다", () => {
    const { getAllByRole } = render(
      <GridTable aria-label="구성원" columns="1fr">
        <GridTableRow inactive={true}>
          <GridTableCell>김하나</GridTableCell>
        </GridTableRow>
        <GridTableRow>
          <GridTableCell>이두리</GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    const [inactive, active] = getAllByRole("row") as HTMLElement[];
    expect(inactive?.getAttribute("data-inactive")).toBe("true");
    expect(active?.hasAttribute("data-inactive")).toBe(false);
  });
});

describe("GridTable action column", () => {
  test("action 열 머리글은 끝에 붙고 버튼 최소 폭의 가운데에 글자를 둔다", () => {
    const { getByRole } = render(
      <GridTable aria-label="구성원" columns="1fr 120px">
        <GridTableHeader>
          <GridTableColumnHeader>이름</GridTableColumnHeader>
          <GridTableColumnHeader action>관리</GridTableColumnHeader>
        </GridTableHeader>
      </GridTable>,
    );
    const header = getByRole("columnheader", { name: "관리" });
    expect(header.getAttribute("data-action")).toBe("true");
    expect(header.classList.contains("justify-end")).toBe(true);
    const label = header.firstElementChild as HTMLElement;
    expect(label.tagName).toBe("SPAN");
    expect(label.textContent).toBe("관리");
    expect(label.classList.contains("text-center")).toBe(true);
    expect(
      label.classList.contains(
        "min-w-[var(--werft-row-action-button-min-width)]",
      ),
    ).toBe(true);
    const name = getByRole("columnheader", { name: "이름" });
    expect(name.hasAttribute("data-action")).toBe(false);
    expect(name.firstElementChild).toBeNull();
  });
});
