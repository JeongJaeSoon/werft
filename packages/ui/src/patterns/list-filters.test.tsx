import { describe, expect, test } from "bun:test";
import { type JSX, useRef, useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { fireEvent, render, waitFor, within } = await setupDom();
// Radix Popover portals only when it found a DOM at import time.
const { AppliedFilters, ListFilters } = await import("./list-filters.tsx");

type Values = Record<string, string>;

const MESSAGES = {
  trigger: "필터",
  count: (count: string) => `${count}개`,
  applied: (count: number) => `${count}개 적용`,
};
const CHIPS = {
  label: "적용한 필터",
  remove: (facet: string, choice: string) => `${facet} 필터 빼기: ${choice}`,
  clearAll: "모두 지우기",
};

function facetsOf(values: Values) {
  return [
    {
      id: "relation",
      label: "관계",
      value: values.relation ?? "all",
      choices: [
        { value: "all", label: "모든 관계", count: 15 },
        { value: "started", label: "내가 시작", count: 4 },
        { value: "shared", label: "공유받음", count: 1000, countCapped: true },
        { value: "administered", label: "관리하는 에이전트" },
      ],
    },
    {
      id: "kind",
      label: "종류",
      value: values.kind ?? "all",
      choices: [
        { value: "all", label: "모든 종류" },
        { value: "decision", label: "접근 판단", count: 0 },
      ],
    },
  ];
}

function Screen({
  initial = {},
  onPick,
}: {
  readonly initial?: Values;
  readonly onPick?: (facet: string, value: string) => void;
}): JSX.Element {
  const [values, setValues] = useState<Values>(initial);
  const trigger = useRef<HTMLButtonElement>(null);
  const facets = facetsOf(values);
  const change = (facet: string, value: string) => {
    onPick?.(facet, value);
    setValues((current) => ({ ...current, [facet]: value }));
  };
  return (
    <>
      <ListFilters
        facets={facets}
        onValueChange={change}
        messages={MESSAGES}
        triggerRef={trigger}
      />
      <AppliedFilters
        facets={facets}
        onValueChange={change}
        onClearAll={() => setValues({})}
        messages={CHIPS}
        returnFocus={trigger}
      />
    </>
  );
}

describe("ListFilters", () => {
  test("거르지 않으면 버튼은 이름만 말하고 칩이 없다", () => {
    const { getByRole, queryByRole } = render(<Screen />);
    const button = getByRole("button", { name: "필터" });
    expect(button.hasAttribute("data-filtered")).toBe(false);
    expect(queryByRole("group", { name: "적용한 필터" })).toBeNull();
  });

  test("거른 묶음 수를 버튼이 읽고, 묶음마다 칩이 하나다", () => {
    const { getByRole } = render(
      <Screen initial={{ relation: "started", kind: "decision" }} />,
    );
    const button = getByRole("button", { name: "필터 2개 적용" });
    expect(button.hasAttribute("data-filtered")).toBe(true);
    const chips = getByRole("group", { name: "적용한 필터" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["관계 내가 시작", "종류 접근 판단"]);
  });

  test("열면 첫 묶음이 펼쳐지고 값마다 개수가 붙으며, 상한을 넘은 개수는 +로 보인다", async () => {
    const { getByRole } = render(<Screen />);
    const user = await setupUser();
    await user.click(getByRole("button", { name: "필터" }));
    const panel = await waitFor(() => getByRole("dialog", { name: "필터" }));
    const relation = within(panel).getByRole("button", { name: "관계" });
    expect(relation.getAttribute("aria-expanded")).toBe("true");
    const kind = within(panel).getByRole("button", { name: "종류" });
    expect(kind.getAttribute("aria-expanded")).toBe("false");
    const list = within(panel).getByRole("list", { name: "관계" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((choice) => choice.textContent),
    ).toEqual([
      "모든 관계 1515개",
      "내가 시작 44개",
      "공유받음 1000+1000+개",
      "관리하는 에이전트",
    ]);
    expect(
      within(list).getByRole("button", { name: "공유받음 1000+개" }),
    ).toBeTruthy();
    // A folded facet's choices are out of reach.
    expect(within(panel).queryByRole("list", { name: "종류" })).toBeNull();
    await user.click(kind);
    expect(kind.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(panel).getByRole("button", { name: "접근 판단 0개" }),
    ).toBeTruthy();
  });

  test("고르면 패널이 열린 채 값이 바뀌고, 같은 값은 다시 보내지 않는다", async () => {
    const picked: string[] = [];
    const { getByRole } = render(
      <Screen onPick={(facet, value) => picked.push(`${facet}=${value}`)} />,
    );
    const user = await setupUser();
    await user.click(getByRole("button", { name: "필터" }));
    const panel = await waitFor(() => getByRole("dialog", { name: "필터" }));
    await user.click(within(panel).getByRole("button", { name: /^내가 시작/ }));
    await user.click(within(panel).getByRole("button", { name: /^내가 시작/ }));
    expect(picked).toEqual(["relation=started"]);
    expect(
      within(panel)
        .getByRole("button", { name: /^내가 시작/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(getByRole("dialog", { name: "필터" })).toBeTruthy();
    // The facet's header says what it narrows to.
    expect(
      within(panel).getByRole("button", { name: "관계 내가 시작" }),
    ).toBeTruthy();
  });

  test("위아래 화살표가 펼친 버튼만 지나고 Home·End로 끝에 간다", async () => {
    const { getByRole } = render(<Screen />);
    const user = await setupUser();
    await user.click(getByRole("button", { name: "필터" }));
    const panel = await waitFor(() => getByRole("dialog", { name: "필터" }));
    const relation = within(panel).getByRole("button", { name: "관계" });
    relation.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("모든 관계 1515개");
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("종류");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement === relation).toBe(true);
    await user.keyboard("{ArrowUp}{Home}");
    expect(document.activeElement === relation).toBe(true);
  });

  test("다시 열면 첫 묶음과 거른 묶음이 펼쳐지고, 고른 값은 바탕이 채워진다", async () => {
    const { getByRole } = render(<Screen />);
    const user = await setupUser();
    await user.click(getByRole("button", { name: "필터" }));
    let panel = await waitFor(() => getByRole("dialog", { name: "필터" }));
    await user.click(within(panel).getByRole("button", { name: "관계" }));
    expect(
      within(panel)
        .getByRole("button", { name: "관계" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await user.click(within(panel).getByRole("button", { name: "종류" }));
    await user.click(within(panel).getByRole("button", { name: /^접근/ }));
    await user.keyboard("{Escape}");
    await user.click(getByRole("button", { name: /^필터/ }));
    panel = await waitFor(() => getByRole("dialog", { name: "필터" }));
    for (const name of ["관계", "종류 접근 판단"]) {
      expect(
        within(panel)
          .getByRole("button", { name })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    }
    const picked = within(panel).getByRole("button", { name: /^접근/ });
    expect(picked.className.split(" ")).toContain("aria-pressed:bg-active");
  });

  test("Escape로 닫고 버튼으로 돌아온다", async () => {
    const { getByRole, queryByRole } = render(<Screen />);
    const user = await setupUser();
    const button = getByRole("button", { name: "필터" });
    await user.click(button);
    await waitFor(() => getByRole("dialog"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === button).toBe(true));
  });
});

describe("AppliedFilters", () => {
  test("칩의 ×는 그 묶음만 풀고 포커스는 다음 칩으로 간다", async () => {
    const picked: string[] = [];
    const { getByRole } = render(
      <Screen
        initial={{ relation: "started", kind: "decision" }}
        onPick={(facet, value) => picked.push(`${facet}=${value}`)}
      />,
    );
    const user = await setupUser();
    await user.click(
      getByRole("button", { name: "관계 필터 빼기: 내가 시작" }),
    );
    expect(picked).toEqual(["relation=all"]);
    const next = getByRole("button", { name: "종류 필터 빼기: 접근 판단" });
    await waitFor(() => expect(document.activeElement === next).toBe(true));
    expect(getByRole("button", { name: "필터 1개 적용" })).toBeTruthy();
  });

  test("마지막 칩이 빠지면 포커스는 필터 버튼으로 간다", async () => {
    const { getByRole, queryByRole } = render(
      <Screen initial={{ kind: "decision" }} />,
    );
    const user = await setupUser();
    await user.click(
      getByRole("button", { name: "종류 필터 빼기: 접근 판단" }),
    );
    expect(queryByRole("group", { name: "적용한 필터" })).toBeNull();
    const button = getByRole("button", { name: "필터" });
    await waitFor(() => expect(document.activeElement === button).toBe(true));
  });

  test("모두 지우기는 모든 묶음을 풀고 필터 버튼으로 포커스를 보낸다", async () => {
    const { getByRole, queryByRole } = render(
      <Screen initial={{ relation: "shared", kind: "decision" }} />,
    );
    const user = await setupUser();
    await user.click(getByRole("button", { name: "모두 지우기" }));
    expect(queryByRole("group", { name: "적용한 필터" })).toBeNull();
    const button = getByRole("button", { name: "필터" });
    await waitFor(() => expect(document.activeElement === button).toBe(true));
  });

  // The screen answers later, as one that keeps filters in the address does.
  function Late({ values }: { readonly values: Values }) {
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <>
        <input aria-label="검색" />
        <button type="button" ref={trigger}>
          필터
        </button>
        <AppliedFilters
          facets={facetsOf(values)}
          onValueChange={() => {}}
          onClearAll={() => {}}
          messages={CHIPS}
          returnFocus={trigger}
        />
      </>
    );
  }
  const late = (values: Values) => <Late values={values} />;

  test.each([
    ["칩 ×", "관계 필터 빼기: 내가 시작"],
    ["모두 지우기", "모두 지우기"],
  ])(
    "%s 뒤 화면이 답하기 전에 값이 바깥에서 바뀌면, 나중에 풀려도 포커스를 옮기지 않는다",
    async (_, name) => {
      const view = render(late({ relation: "started" }));
      const user = await setupUser();
      await user.click(view.getByRole("button", { name }));
      view.rerender(late({ relation: "shared", kind: "decision" }));
      (document.activeElement as HTMLElement).blur();
      view.rerender(late({}));
      expect(document.activeElement === document.body).toBe(true);
    },
  );

  test("칩이 빠지기 전에 다른 곳으로 옮긴 포커스는 빼앗지 않는다", async () => {
    const view = render(late({ relation: "started", kind: "decision" }));
    const user = await setupUser();
    await user.click(
      view.getByRole("button", { name: "관계 필터 빼기: 내가 시작" }),
    );
    const search = view.getByRole("textbox", { name: "검색" });
    await user.click(search);
    view.rerender(late({ kind: "decision" }));
    expect(document.activeElement === search).toBe(true);
  });

  test("옮겨 갔다가 빈 곳으로 빠진 포커스도 다시 가져오지 않는다", async () => {
    const view = render(late({ relation: "started", kind: "decision" }));
    const user = await setupUser();
    await user.click(
      view.getByRole("button", { name: "관계 필터 빼기: 내가 시작" }),
    );
    const search = view.getByRole("textbox", { name: "검색" });
    await user.click(search);
    search.blur();
    view.rerender(late({ kind: "decision" }));
    expect(document.activeElement === document.body).toBe(true);
  });

  test("누른 버튼이 포커스를 받지 않는 브라우저에서도 다음 칩으로 간다", () => {
    const view = render(late({ relation: "started", kind: "decision" }));
    view.getByRole("textbox", { name: "검색" }).focus();
    // A click that leaves focus where it was.
    fireEvent.click(
      view.getByRole("button", { name: "관계 필터 빼기: 내가 시작" }),
    );
    view.rerender(late({ kind: "decision" }));
    const next = view.getByRole("button", {
      name: "종류 필터 빼기: 접근 판단",
    });
    expect(document.activeElement === next).toBe(true);
  });
});
