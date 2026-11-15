import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { RowLink, RowList, RowListItem } = await import("./row-list.tsx");

function Teams({ inset = false }: { readonly inset?: boolean }) {
  return (
    <RowList variant={inset ? "joined" : "separate"}>
      <RowListItem opens>
        <RowLink inset={inset}>
          <a href="/teams/platform">플랫폼</a>
        </RowLink>
        <span>구성원 3명</span>
        <button type="button" className="relative z-1">
          나가기
        </button>
      </RowListItem>
    </RowList>
  );
}

describe("RowLink", () => {
  test("행 전체가 링크 하나로 열리고, 링크 이름은 행 제목 글자다", () => {
    const { getByRole } = render(<Teams />);
    const row = getByRole("listitem");
    expect(row.getAttribute("data-opens")).toBe("true");
    for (const name of ["relative", "cursor-pointer", "hover:bg-hover"])
      expect(row.classList.contains(name)).toBe(true);
    const link = getByRole("link", { name: "플랫폼" });
    expect(link.getAttribute("data-slot")).toBe("row-link");
    // The link's box stretches over the row (after:inset-0 inside `relative`).
    for (const name of [
      "after:absolute",
      "after:inset-0",
      "after:rounded-card",
      "focus-visible:outline-none!",
      "focus-visible:after:outline-offset-2",
    ])
      expect(link.classList.contains(name)).toBe(true);
  });

  test("Tab은 링크에 한 번, 그다음 행의 버튼에 멈춘다", async () => {
    const user = await setupUser();
    const { getByRole } = render(<Teams />);
    await user.tab();
    expect(document.activeElement === getByRole("link")).toBe(true);
    await user.tab();
    expect(document.activeElement === getByRole("button")).toBe(true);
  });

  test("inset은 링 안쪽, 모서리 없음(표 안의 행)", () => {
    const { getByRole } = render(<Teams inset />);
    const link = getByRole("link");
    expect(
      link.classList.contains("focus-visible:after:-outline-offset-2"),
    ).toBe(true);
    expect(link.classList.contains("after:rounded-card")).toBe(false);
    expect(
      link.classList.contains("focus-visible:after:outline-offset-2"),
    ).toBe(false);
  });

  test("opens가 없는 행은 지금과 같다", () => {
    const { getByRole } = render(
      <RowList>
        <RowListItem>하나</RowListItem>
      </RowList>,
    );
    const row = getByRole("listitem");
    expect(row.hasAttribute("data-opens")).toBe(false);
    expect(row.classList.contains("cursor-pointer")).toBe(false);
  });
});

describe("RowLink Slot", () => {
  test("자식 링크의 class·속성·클릭 처리를 그대로 두고 자기 class를 더한다", () => {
    let clicks = 0;
    const { getByRole } = render(
      <RowList>
        <RowListItem opens>
          <RowLink className="font-medium">
            <a
              href="/teams/platform"
              className="text-foreground"
              data-team="platform"
              onClick={(event) => {
                event.preventDefault();
                clicks += 1;
              }}
            >
              플랫폼
            </a>
          </RowLink>
        </RowListItem>
      </RowList>,
    );
    const link = getByRole("link", { name: "플랫폼" });
    for (const name of ["text-foreground", "font-medium", "after:inset-0"])
      expect(link.classList.contains(name)).toBe(true);
    expect(link.getAttribute("data-team")).toBe("platform");
    expect(link.getAttribute("href")).toBe("/teams/platform");
    link.click();
    expect(clicks).toBe(1);
  });
});
