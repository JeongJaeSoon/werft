import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Button } from "./button.tsx";
import { RowLines, RowList, RowListItem } from "./row-list.tsx";
import { Switch } from "./switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.tsx";

const { render } = await setupDom();

const TOKENS = await Bun.file(
  `${import.meta.dir}/../foundations/tokens.css`,
).text();

function MembersTable() {
  return (
    <TableContainer label="구성원">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">이름</TableHead>
            <TableHead scope="col" variant="actions">
              관리
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <RowLines>
                <span>김하나</span>
                <span>hana@example.com</span>
              </RowLines>
            </TableCell>
            <TableCell variant="actions">
              <Button type="button" size="sm" aria-label="김하나 비활성화">
                비활성화
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </TableContainer>
  );
}

describe("Table", () => {
  test("프레임은 이름 있는 region이고 키보드로 닿는다", () => {
    const { getByRole } = render(<MembersTable />);
    const frame = getByRole("region", { name: "구성원" });
    expect(frame.tagName).toBe("SECTION");
    expect(frame.getAttribute("tabindex")).toBe("0");
    expect(frame.className).toContain("overflow-x-auto");
    expect(frame.className).toContain("focus-visible:outline-focus-ring");
  });

  test("행 높이 하한과 셀 padding은 --werft-row-* 토큰에서 온다", () => {
    const { container } = render(<MembersTable />);
    const head = container.querySelector("thead");
    const row = container.querySelector("tbody > tr");
    const cell = container.querySelector("td");
    const th = container.querySelector("th");
    expect(head?.className).toContain(
      "[&>tr]:h-[var(--werft-row-head-min-height)]",
    );
    expect(row?.className).toContain("h-[var(--werft-row-min-height)]");
    expect(cell?.className).toContain("py-[var(--werft-row-padding-y)]");
    expect(cell?.className).toContain(
      "px-[calc(var(--werft-row-padding-x)/2)]",
    );
    expect(th?.className).toContain("py-[var(--werft-row-head-padding-y)]");
    expect(TOKENS).toContain("--werft-row-min-height: 3rem;");
    expect(TOKENS).toContain("--werft-row-head-min-height: 2.5rem;");
  });

  test("actions 열은 내용 폭이고 그 안의 버튼 하한은 토큰 하나가 정한다", () => {
    const { getByRole } = render(<MembersTable />);
    const head = getByRole("columnheader", { name: "관리" });
    const button = getByRole("button", { name: "김하나 비활성화" });
    const cell = button.closest("td");
    for (const el of [head, cell]) {
      expect(el?.getAttribute("data-variant")).toBe("actions");
      expect(el?.className).toContain("w-px");
      expect(el?.className).toContain("whitespace-nowrap");
      expect(el?.className).toContain(
        "[&_[data-slot=button]:not([data-size^=icon])]:min-w-[var(--werft-row-action-button-min-width)]",
      );
    }
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(button.getAttribute("data-size")).toBe("sm");
    expect(TOKENS).toContain("--werft-row-action-button-min-width: 3rem;");
    // The column floor of grid rows is a separate token and stays.
    expect(TOKENS).toContain("--werft-row-action-min-width: 6rem;");
  });

  test("actions 셀의 아이콘 버튼은 하한 선택자에서 빠진다", () => {
    const { getByRole } = render(
      <table>
        <tbody>
          <tr>
            <TableCell variant="actions">
              <Button type="button" size="icon" aria-label="이유">
                i
              </Button>
              <Button type="button" size="icon-sm" aria-label="복사">
                c
              </Button>
              <Button type="button" size="sm">
                비활성화
              </Button>
            </TableCell>
          </tr>
        </tbody>
      </table>,
    );
    const labelled = getByRole("button", { name: "비활성화" });
    // The selector the cell's class actually carries, not a copy of it.
    const selector = /\[&_(.+)\]:min-w-/.exec(
      labelled.closest("td")?.className ?? "",
    )?.[1];
    expect(selector).toBeDefined();
    for (const name of ["이유", "복사"]) {
      expect(getByRole("button", { name }).matches(selector ?? "")).toBe(false);
    }
    expect(labelled.matches(selector ?? "")).toBe(true);
  });

  test("text 열은 남는 폭을 갖되 하한이 있고, 보조 줄은 원문을 DOM에 둔 채 말줄임된다", () => {
    const email = "alex.rivera.long-address@example.com";
    const { getByRole, getByText } = render(
      <table>
        <thead>
          <tr>
            <TableHead variant="text">이름</TableHead>
          </tr>
        </thead>
        <tbody>
          <tr>
            <TableCell variant="text">
              <RowLines>
                <span>Alex Rivera</span>
                <span title={email}>{email}</span>
              </RowLines>
            </TableCell>
          </tr>
        </tbody>
      </table>,
    );
    const head = getByRole("columnheader", { name: "이름" });
    const cell = getByRole("cell", { name: /Alex Rivera/ });
    for (const el of [head, cell]) {
      expect(el.getAttribute("data-variant")).toBe("text");
      expect(el.classList.contains("w-full")).toBe(true);
      expect(el.classList.contains("max-w-0")).toBe(true);
      expect(
        el.classList.contains("min-w-[var(--werft-row-text-min-width)]"),
      ).toBe(true);
    }
    expect(
      cell.classList.contains(
        "[&_[data-slot=row-lines]>*:not(:first-child)]:truncate",
      ),
    ).toBe(true);
    // The selector reaches the secondary line, not the first.
    const selector =
      "td[data-variant=text] [data-slot=row-lines]>*:not(:first-child)";
    const line = getByText(email);
    expect(line.matches(selector)).toBe(true);
    expect(getByText("Alex Rivera").matches(selector)).toBe(false);
    expect(line.getAttribute("title")).toBe(email);
    expect(cell.textContent).toBe(`Alex Rivera${email}`);
    expect(TOKENS).toContain("--werft-row-text-min-width: 10rem;");
  });

  test("nowrap 열은 내용 폭이고 줄을 바꾸지 않는다", () => {
    const { getByRole } = render(
      <table>
        <thead>
          <tr>
            <TableHead variant="nowrap">가입일</TableHead>
          </tr>
        </thead>
        <tbody>
          <tr>
            <TableCell variant="nowrap">2026-09-30</TableCell>
          </tr>
        </tbody>
      </table>,
    );
    for (const el of [
      getByRole("columnheader", { name: "가입일" }),
      getByRole("cell", { name: "2026-09-30" }),
    ]) {
      expect(el.getAttribute("data-variant")).toBe("nowrap");
      expect(el.classList.contains("w-px")).toBe(true);
      expect(el.classList.contains("whitespace-nowrap")).toBe(true);
    }
  });

  test("numeric 열은 머리글과 셀이 함께 끝에 붙고, 자릿수 폭이 같은 숫자로 한 줄에 쓴다", () => {
    const { getByRole } = render(
      <table>
        <thead>
          <tr>
            <TableHead variant="numeric">비용</TableHead>
          </tr>
        </thead>
        <tbody>
          <tr>
            <TableCell variant="numeric">$12.40</TableCell>
          </tr>
        </tbody>
      </table>,
    );
    for (const el of [
      getByRole("columnheader", { name: "비용" }),
      getByRole("cell", { name: "$12.40" }),
    ]) {
      expect(el.getAttribute("data-variant")).toBe("numeric");
      expect(el.classList.contains("text-right")).toBe(true);
      expect(el.classList.contains("text-left")).toBe(false);
      expect(el.classList.contains("tabular-nums")).toBe(true);
      expect(el.classList.contains("whitespace-nowrap")).toBe(true);
    }
  });

  test("switch 열은 머리글과 스위치가 함께 끝에 붙는다", () => {
    const { getByRole } = render(
      <table>
        <thead>
          <tr>
            <TableHead variant="switch">사용</TableHead>
          </tr>
        </thead>
        <tbody>
          <tr>
            <TableCell variant="switch">
              <Switch className="flex" aria-label="규칙 사용" />
            </TableCell>
          </tr>
        </tbody>
      </table>,
    );
    const toggle = getByRole("switch", { name: "규칙 사용" });
    const cell = toggle.closest("td") as HTMLElement;
    for (const el of [getByRole("columnheader", { name: "사용" }), cell]) {
      expect(el.getAttribute("data-variant")).toBe("switch");
      expect(el.classList.contains("w-px")).toBe(true);
      expect(el.classList.contains("text-right")).toBe(true);
      expect(el.classList.contains("text-left")).toBe(false);
    }
    // A block-level switch ignores text-right; the cell's own selector, not a
    // copy of it, must reach the switch to push it to the end.
    const selector = /\[&>(.+)\]:ml-auto/.exec(cell.className)?.[1];
    expect(selector).toBeDefined();
    expect(toggle.matches(`td > ${selector}`)).toBe(true);
  });

  test("기본 셀에는 actions 클래스가 붙지 않는다", () => {
    const { getByRole } = render(<MembersTable />);
    const name = getByRole("cell", { name: /김하나/ });
    expect(name.getAttribute("data-variant")).toBe("default");
    expect(name.className).not.toContain("w-px");
  });

  test("호출자 className이 같은 축의 유틸리티를 이긴다", () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <TableCell className="py-1">값</TableCell>
          </tr>
        </tbody>
      </table>,
    );
    const classes = container.querySelector("td")?.className.split(" ");
    expect(classes).toContain("py-1");
    expect(classes).not.toContain("py-[var(--werft-row-padding-y)]");
  });
});

describe("RowList", () => {
  test("separate는 행마다 카드, joined는 한 카드와 행 사이 선이다", () => {
    const { getAllByRole } = render(
      <>
        <RowList>
          <RowListItem>하나</RowListItem>
        </RowList>
        <RowList variant="joined">
          <RowListItem>둘</RowListItem>
        </RowList>
      </>,
    );
    const [separate, joined] = getAllByRole("list");
    expect(separate?.getAttribute("data-variant")).toBe("separate");
    expect(separate?.className).toContain("[&>li]:rounded-card");
    expect(joined?.getAttribute("data-variant")).toBe("joined");
    expect(joined?.className).toContain("[&>li]:border-b");
    expect(joined?.className).toContain("rounded-card");
  });

  test("joined는 기본으로 틀을 두고, framed={false}면 행 사이 선만 남는다", () => {
    const { getAllByRole } = render(
      <>
        <RowList variant="joined">
          <RowListItem>틀</RowListItem>
        </RowList>
        <RowList variant="joined" framed={false}>
          <RowListItem>선만</RowListItem>
        </RowList>
        <RowList framed={false}>
          <RowListItem>따로</RowListItem>
        </RowList>
      </>,
    );
    const [framed, bare, separate] = getAllByRole("list") as HTMLElement[];
    expect(framed?.getAttribute("data-framed")).toBe("true");
    for (const name of ["rounded-card", "border", "bg-card", "overflow-hidden"])
      expect(framed?.classList.contains(name)).toBe(true);
    expect(bare?.hasAttribute("data-framed")).toBe(false);
    for (const name of ["rounded-card", "border", "bg-card", "overflow-hidden"])
      expect(bare?.classList.contains(name)).toBe(false);
    expect(bare?.classList.contains("[&>li]:border-b")).toBe(true);
    // A separate list draws its cards per row, framed or not.
    expect(separate?.hasAttribute("data-framed")).toBe(false);
    expect(separate?.className).toContain("[&>li]:rounded-card");
  });

  test("행은 행 높이 하한을 지키고 좁으면 줄을 바꾼다", () => {
    const { getByRole } = render(
      <RowList>
        <RowListItem>하나</RowListItem>
      </RowList>,
    );
    const item = getByRole("listitem");
    expect(item.className).toContain("min-h-[var(--werft-row-min-height)]");
    expect(item.className).toContain("flex-wrap");
  });

  test("inactive 행만 data-inactive를 갖는다", () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow inactive={true}>
            <TableCell>김하나</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>이두리</TableCell>
          </TableRow>
        </tbody>
      </table>,
    );
    const [inactive, active] = container.querySelectorAll("tr");
    expect(inactive?.getAttribute("data-inactive")).toBe("true");
    expect(active?.hasAttribute("data-inactive")).toBe(false);
  });
});
