import { describe, expect, test } from "bun:test";
import { Fragment } from "react";

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
        <GridTableColumnHeader>최근</GridTableColumnHeader>
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
          <GridTableCell>3분 전</GridTableCell>
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

  test("narrowCards이면 640px 이하에서 행이 카드가 되고, 머리는 화면 읽기용으로만 남고, 열을 숨기지 않는다", () => {
    const { getByRole, getAllByRole } = render(
      <GridTable
        aria-label="에이전트"
        columns="minmax(0,1fr) 96px 120px"
        narrowAt={640}
        narrowCards={true}
        framed={true}
        align={["start", "start", "end"]}
      >
        <GridTableHeader>
          <GridTableColumnHeader>이름</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>엔진</GridTableColumnHeader>
          <GridTableColumnHeader>실행 중</GridTableColumnHeader>
        </GridTableHeader>
        <GridTableRow>
          <GridTableCell>werft-agent</GridTableCell>
          <GridTableCell hideNarrow={true} cardLabel="엔진">
            Codex
          </GridTableCell>
          <GridTableCell cardLabel="실행 중">2</GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    const table = getByRole("table", { name: "에이전트" });
    // The frame goes from a container outside the table, and the rows query
    // that container too: a framed table's own content box is 2px narrower.
    expect(table.parentElement?.classList.contains("@container")).toBe(true);
    expect(table.classList.contains("@container")).toBe(false);
    expect(table.dataset.narrowCards).toBe("true");
    expect(
      table.classList.contains("[@container(max-width:640px)]:border-0"),
    ).toBe(true);
    const [header, row] = getAllByRole("row") as HTMLElement[];
    expect(
      header?.classList.contains("[@container(max-width:640px)]:sr-only"),
    ).toBe(true);
    expect(
      row?.classList.contains("[@container(max-width:640px)]:flex-col"),
    ).toBe(true);
    for (const cell of [
      ...getAllByRole("columnheader"),
      ...getAllByRole("cell"),
    ]) {
      expect(cell.className).not.toContain(":hidden");
    }
    const [name, engine, running] = getAllByRole("cell") as HTMLElement[];
    expect(name?.querySelector("[aria-hidden=true]") === null).toBe(true);
    const label = engine?.firstElementChild;
    expect(label?.getAttribute("aria-hidden")).toBe("true");
    expect(label?.textContent).toBe("엔진");
    expect(
      running?.classList.contains(
        "[@container(max-width:640px)]:justify-start",
      ),
    ).toBe(true);
  });

  test("narrowCards가 아니면 cardLabel을 그리지 않는다", () => {
    const { getByRole } = render(
      <GridTable
        aria-label="세션"
        columns="minmax(0,1fr) 120px"
        narrowAt={640}
        narrowColumns="minmax(0,1fr)"
      >
        <GridTableRow>
          <GridTableCell>배포 점검</GridTableCell>
          <GridTableCell cardLabel="상태">실행 중</GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    const table = getByRole("table", { name: "세션" });
    expect(table.querySelector("[aria-hidden=true]") === null).toBe(true);
    expect(table.dataset.narrowCards).toBeUndefined();
    expect(table.classList.contains("@container")).toBe(true);
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

describe("GridTable row density", () => {
  test("본문 행은 위아래 8px로 48px 하한에 맞고, 카드가 된 행만 16px을 둔다", async () => {
    const tokens = await Bun.file(
      `${import.meta.dir}/../foundations/tokens.css`,
    ).text();
    expect(tokens).toContain(
      "--werft-grid-row-padding-y: var(--werft-space-2);",
    );
    expect(tokens).toContain("--werft-row-min-height: 3rem;");
    const { getAllByRole } = render(
      <>
        <GridTable aria-label="표" columns="1fr">
          <GridTableRow>
            <GridTableCell>a</GridTableCell>
          </GridTableRow>
        </GridTable>
        <GridTable
          aria-label="카드"
          columns="1fr"
          narrowAt={640}
          narrowCards={true}
        >
          <GridTableRow>
            <GridTableCell>b</GridTableCell>
          </GridTableRow>
        </GridTable>
      </>,
    );
    const [row, card] = getAllByRole("row") as HTMLElement[];
    for (const each of [row, card]) {
      expect(
        each?.classList.contains("py-[var(--werft-grid-row-padding-y)]"),
      ).toBe(true);
      expect(
        each?.classList.contains("min-h-[var(--werft-row-min-height)]"),
      ).toBe(true);
    }
    expect(row?.className.includes("[@container(max-width:640px)]:py-")).toBe(
      false,
    );
    expect(
      card?.classList.contains(
        "[@container(max-width:640px)]:py-[var(--werft-row-padding-y)]",
      ),
    ).toBe(true);
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

  test("칠해진 마지막 행도 카드 틀의 아래 모서리를 따라 둥글다", () => {
    const { getAllByRole } = render(
      <>
        <GridTable aria-label="틀 있음" columns="1fr" framed>
          <GridTableHeader>
            <GridTableColumnHeader>이름</GridTableColumnHeader>
          </GridTableHeader>
          <GridTableRow>
            <GridTableCell>활성</GridTableCell>
          </GridTableRow>
          <GridTableRow className="bg-hover">
            <GridTableCell>정지</GridTableCell>
          </GridTableRow>
        </GridTable>
        <GridTable aria-label="카드" columns="1fr" narrowAt={640} narrowCards>
          <GridTableHeader>
            <GridTableColumnHeader>이름</GridTableColumnHeader>
          </GridTableHeader>
          <GridTableRow className="bg-hover">
            <GridTableCell>정지</GridTableCell>
          </GridTableRow>
        </GridTable>
      </>,
    );
    const rows = getAllByRole("row") as HTMLElement[];
    const header = rows[0];
    const filled = rows[2];
    const card = rows[4];
    expect(filled?.parentElement?.lastElementChild === filled).toBe(true);
    for (const row of [header, rows[1], filled, card])
      expect(row?.classList.contains("last:rounded-b-card")).toBe(true);
    expect(filled?.classList.contains("bg-hover")).toBe(true);
    expect(
      card?.classList.contains("[@container(max-width:640px)]:rounded-card"),
    ).toBe(true);
  });
});

describe("GridTable column alignment", () => {
  function Members({ roles }: { readonly roles: boolean }) {
    return (
      <GridTable
        aria-label="구성원"
        columns="1fr 80px 80px 120px"
        narrowAt={640}
        narrowCards={true}
        align={[
          "start",
          ...(roles ? (["start"] as const) : []),
          "end",
          "action",
        ]}
      >
        <GridTableHeader>
          <GridTableColumnHeader>이름</GridTableColumnHeader>
          {roles ? <GridTableColumnHeader>역할</GridTableColumnHeader> : null}
          {/* biome-ignore lint/complexity/noUselessFragments: a caller's fragment must still count as its columns. */}
          <>
            <GridTableColumnHeader>세션</GridTableColumnHeader>
            <GridTableColumnHeader>관리</GridTableColumnHeader>
          </>
        </GridTableHeader>
        {["김하나", "이두리"].map((name) => (
          <GridTableRow key={name}>
            <GridTableCell>{name}</GridTableCell>
            {roles ? <GridTableCell>관리자</GridTableCell> : null}
            <GridTableCell>12</GridTableCell>
            <GridTableCell raised={true}>
              <button type="button">비활성화</button>
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
    );
  }

  // Any one of these puts content at the end, so any one counts.
  const ends = (element: Element) =>
    ["justify-end", "text-end", "text-right"].some((name) =>
      element.classList.contains(name),
    );
  const figures = (element: Element) =>
    element.classList.contains("tabular-nums") &&
    element.classList.contains("whitespace-nowrap");

  for (const roles of [true, false]) {
    test(`머리글과 셀은 열마다 같은 쪽에 붙는다 (역할 열 ${roles ? "있음" : "없음"})`, () => {
      const { getAllByRole } = render(<Members roles={roles} />);
      const headers = getAllByRole("columnheader");
      const want = roles
        ? ["start", "start", "end", "action"]
        : ["start", "end", "action"];
      expect(headers.map((header) => header.dataset.align)).toEqual(want);
      for (const row of getAllByRole("row").slice(1)) {
        const cells = [...row.querySelectorAll<HTMLElement>("[role=cell]")];
        expect(cells).toHaveLength(headers.length);
        cells.forEach((cell, i) => {
          const header = headers[i] as HTMLElement;
          expect(cell.dataset.align).toBe(header.dataset.align as string);
          expect(ends(cell)).toBe(ends(header));
          expect(ends(cell)).toBe(want[i] !== "start");
          expect(figures(cell)).toBe(want[i] === "end");
          expect(figures(header)).toBe(want[i] === "end");
        });
      }
    });
  }

  test("행 동작 열의 머리글은 화면에서 숨고 스크린리더에만 읽힌다", () => {
    const { getAllByRole, getByRole } = render(<Members roles={false} />);
    const [name, count, action] = getAllByRole("columnheader") as HTMLElement[];
    for (const shown of [name, count])
      expect(shown?.firstElementChild === null).toBe(true);
    expect(action?.firstElementChild?.className).toBe("sr-only");
    expect(action?.textContent).toBe("관리");
    expect(getByRole("columnheader", { name: "관리" }) === action).toBe(true);
  });

  test("조건부 칸이 생겨도 다른 칸은 다시 그려지지 않고, fragment 안팎의 key가 겹치지 않는다", () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const table = (roles: boolean) => (
        <GridTable
          aria-label="구성원"
          columns="1fr 1fr 1fr"
          align={["start", ...(roles ? (["start"] as const) : []), "end"]}
        >
          <GridTableRow>
            <Fragment key="a">
              <GridTableCell key="b">김하나</GridTableCell>
            </Fragment>
            {roles ? <GridTableCell key="a/.$b">관리자</GridTableCell> : null}
            <GridTableCell key="n">12</GridTableCell>
          </GridTableRow>
        </GridTable>
      );
      const { getAllByRole, rerender } = render(table(false));
      const [name, count] = getAllByRole("cell") as HTMLElement[];
      expect(count?.dataset.align).toBe("end");
      rerender(table(true));
      const cells = getAllByRole("cell") as HTMLElement[];
      expect(cells.map((cell) => cell.dataset.align)).toEqual([
        "start",
        "start",
        "end",
      ]);
      expect(cells[0] === name).toBe(true);
      expect(cells[2] === count).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      console.error = original;
    }
  });

  test("align이 없으면 머리글과 셀이 모두 시작에 붙는다", () => {
    const { getAllByRole } = render(<Sessions />);
    for (const element of [
      ...getAllByRole("columnheader"),
      ...getAllByRole("cell"),
    ]) {
      expect(element.dataset.align).toBe("start");
      expect(ends(element)).toBe(false);
    }
  });
});
