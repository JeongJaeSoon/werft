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
const NARROW = "minmax(0,2fr) 116px minmax(0,1.2fr) 64px";
const NARROW_HIDE = "[@container(max-width:820px)]:hidden";
const NARROW_ROW =
  "[@container(max-width:820px)]:grid-cols-[var(--grid-table-narrow-columns)]";

function Sessions({
  onOpen = () => {},
  onStop = () => {},
}: {
  readonly onOpen?: () => void;
  readonly onStop?: () => void;
}) {
  return (
    <GridTable
      aria-label="세션"
      columns={COLUMNS}
      narrowAt={820}
      narrowColumns={NARROW}
    >
      <GridTableHeader>
        <GridTableColumnHeader>제목</GridTableColumnHeader>
        <GridTableColumnHeader>상태</GridTableColumnHeader>
        <GridTableColumnHeader>에이전트</GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow={true}>저장소</GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow={true}>시작</GridTableColumnHeader>
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
          <GridTableCell hideNarrow={true}>werft/api</GridTableCell>
          <GridTableCell hideNarrow={true}>김하나</GridTableCell>
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

  test("좁은 폭에서 숨는 열은 머리와 셀이 같이 숨어 남는 셀 수도 같다", () => {
    const { getAllByRole } = render(<Sessions />);
    const shown = (cells: Element[]) =>
      cells.filter((cell) => !cell.classList.contains(NARROW_HIDE)).length;
    const headers = getAllByRole("columnheader");
    expect(shown(headers)).toBe(4);
    for (const row of getAllByRole("row").slice(1)) {
      expect(shown([...row.querySelectorAll("[role=cell]")])).toBe(4);
    }
    // happy-dom does not resolve container queries, so the display: none
    // itself is not checked here.
  });

  test("열 템플릿은 표의 변수 하나로 모든 행에 가고 좁은 템플릿은 narrowAt 기준에서 바뀐다", () => {
    const { getByRole, getAllByRole } = render(<Sessions />);
    const table = getByRole("table");
    expect(table.style.getPropertyValue("--grid-table-columns")).toBe(COLUMNS);
    expect(table.style.getPropertyValue("--grid-table-narrow-columns")).toBe(
      NARROW,
    );
    expect(table.classList.contains("@container")).toBe(true);
    expect(table.className).not.toContain("overflow");
    for (const row of getAllByRole("row")) {
      expect(
        row.classList.contains("grid-cols-[var(--grid-table-columns)]"),
      ).toBe(true);
      expect(row.classList.contains(NARROW_ROW)).toBe(true);
    }
  });

  test("narrowAt이 없으면 좁은 폭 클래스가 없고 hideNarrow 열도 남는다", () => {
    const { getAllByRole } = render(
      <GridTable aria-label="구성원" columns="minmax(0,1fr) 120px">
        <GridTableHeader>
          <GridTableColumnHeader>이름</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>역할</GridTableColumnHeader>
        </GridTableHeader>
      </GridTable>,
    );
    const row = getAllByRole("row")[0] as HTMLElement;
    expect(row.className).not.toContain("@container");
    for (const header of getAllByRole("columnheader")) {
      expect(header.className).not.toContain("hidden");
    }
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

describe("GridTable framed", () => {
  test("framed는 표 자체에 카드 틀을 두고, 기본값은 틀이 없다", () => {
    const { getAllByRole } = render(
      <>
        <GridTable aria-label="틀 있음" columns="1fr" framed>
          <GridTableHeader>
            <GridTableColumnHeader>이름</GridTableColumnHeader>
          </GridTableHeader>
        </GridTable>
        <GridTable aria-label="틀 없음" columns="1fr">
          <GridTableHeader>
            <GridTableColumnHeader>이름</GridTableColumnHeader>
          </GridTableHeader>
        </GridTable>
      </>,
    );
    const [framed, plain] = getAllByRole("table") as HTMLElement[];
    expect(framed?.getAttribute("data-framed")).toBe("true");
    for (const name of ["rounded-card", "border", "bg-card", "@container"])
      expect(framed?.classList.contains(name)).toBe(true);
    expect(plain?.hasAttribute("data-framed")).toBe(false);
    expect(plain?.classList.contains("border")).toBe(false);
  });

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
