import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Tabs, TabsList, TabsTrigger } = await import("./tabs.tsx");

describe("Tabs", () => {
  test("line 밑줄은 v4처럼 글자 쪽으로 8px 들어가 바닥선 위에 놓이고 reduced motion에서 전환하지 않는다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const classes = getByRole("tab", { name: "개요" }).className.split(" ");
    expect(classes).toContain("motion-reduce:after:transition-none");
    for (const name of [
      "group-data-[orientation=horizontal]/tabs:after:inset-x-2",
      "group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]",
      "group-data-[orientation=horizontal]/tabs:after:h-0.5",
      "group-data-[orientation=horizontal]/tabs:after:rounded-[1px]",
    ]) {
      expect(classes).toContain(name);
    }
  });

  test("탭은 상태 사이에 바뀌는 글자색·배경·테두리·그림자·투명도만 전환하고 reduced motion에서 전환하지 않는다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const classes = getByRole("tab", { name: "개요" }).className.split(" ");
    // opacity: disabled:opacity-50 fades as it did under transition-all.
    expect(classes).toContain(
      "transition-[color,background-color,border-color,box-shadow,opacity]",
    );
    expect(classes).toContain("motion-reduce:transition-none");
    expect(classes).not.toContain("transition-all");
  });

  test("line 목록은 탭 사이 4px, 탭은 36px·좌우 8px이고 바닥선은 호출부 몫이다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line" aria-label="세션">
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = getByRole("tablist", { name: "세션" }).className.split(" ");
    for (const name of [
      "gap-1",
      "p-0",
      "group-data-[orientation=horizontal]/tabs:h-auto",
    ]) {
      expect(list).toContain(name);
    }
    expect(list).not.toContain("gap-6");
    // Callers draw the rule on a wrapper beside other controls; a second one
    // here would double it (see the session detail screen story).
    expect(list.some((name) => name.includes("border-b"))).toBe(false);
    expect(list).toContain("w-fit");
    expect(list).not.toContain("group-data-[orientation=horizontal]/tabs:h-9");
    const tab = getByRole("tab", { name: "개요" }).className.split(" ");
    for (const name of [
      "group-data-[variant=line]/tabs-list:h-9",
      "group-data-[variant=line]/tabs-list:px-2",
      "group-data-[variant=line]/tabs-list:py-0",
      "group-data-[variant=line]/tabs-list:border-0",
    ]) {
      expect(tab).toContain(name);
    }
  });

  test("asChild는 넘긴 요소 하나를 탭으로 그리고, 개수가 있으면 그 요소 안 글자 뒤에 둔다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a" asChild>
            <button type="button">개요</button>
          </TabsTrigger>
          <TabsTrigger value="b" asChild count={2}>
            <button type="button">성과물</button>
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const plain = getByRole("tab", { name: "개요" });
    expect(plain.tagName).toBe("BUTTON");
    expect(plain.querySelector('[data-slot="item-count"]')).toBeNull();
    const counted = getByRole("tab", { name: "성과물 2" });
    expect(counted.getAttribute("data-slot")).toBe("tabs-trigger");
    expect(counted.querySelector('[data-slot="item-count"]')?.textContent).toBe(
      "2",
    );
  });

  test("포커스는 다른 부품처럼 focus-ring 2px outline을 2px 띄워 그린다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const classes = getByRole("tab", { name: "개요" }).className.split(" ");
    for (const name of [
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-focus-ring",
    ]) {
      expect(classes).toContain(name);
    }
    expect(classes.some((name) => name.includes("ring-ring"))).toBe(false);
  });

  test("기본 variant 목록은 세그먼트와 같은 회색 트랙·흰 알약이고 컨트롤 높이다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList aria-label="보기">
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = getByRole("tablist", { name: "보기" });
    expect(list.getAttribute("data-variant")).toBe("default");
    const classes = list.className.split(" ");
    expect(classes).toContain("bg-segment-track");
    expect(classes).toContain("p-[3px]");
    expect(classes).toContain(
      "group-data-[orientation=horizontal]/tabs:h-[var(--werft-control-height)]",
    );
    expect(classes).not.toContain("border-b");
    const trigger = getByRole("tab", { name: "개요" }).className.split(" ");
    expect(trigger).toContain(
      "group-data-[variant=default]/tabs-list:data-[state=active]:bg-segment-thumb",
    );
    expect(trigger).toContain(
      "group-data-[variant=default]/tabs-list:data-[state=active]:shadow-segment-thumb",
    );
  });

  test("개수는 이름 뒤에 읽히고 0도 그리며 countLabel이 있으면 그 문장을 읽는다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a" count={12}>
            산출물
          </TabsTrigger>
          <TabsTrigger value="b" count={0}>
            요청
          </TabsTrigger>
          <TabsTrigger value="c" count={3} countLabel="3개 실행 중">
            실행 중
          </TabsTrigger>
          <TabsTrigger value="d">정보</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const counted = getByRole("tab", { name: "산출물 12" });
    expect(counted.textContent).toBe("산출물 12");
    const number = counted.querySelector('[data-slot="item-count"]');
    expect(number?.previousSibling?.textContent).toBe(" ");
    expect(number?.className.split(" ")).toContain("tabular-nums");
    expect(
      getByRole("tab", { name: "요청 0" }).querySelector(
        '[data-slot="item-count"]',
      )?.textContent,
    ).toBe("0");
    const labelled = getByRole("tab", { name: "실행 중 3개 실행 중" });
    expect(
      labelled
        .querySelector('[data-slot="item-count"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      getByRole("tab", { name: "정보" }).querySelector(
        '[data-slot="item-count"]',
      ),
    ).toBeNull();
  });

  test("countTone은 1 이상일 때만 색 배지이고, 뜻은 countLabel로 읽힌다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger
            value="a"
            count={3}
            countTone="danger"
            countLabel="3개, 거절 있음"
          >
            성과물
          </TabsTrigger>
          <TabsTrigger value="b" count={0} countTone="danger">
            요청
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const toned = getByRole("tab", { name: "성과물 3개, 거절 있음" });
    const badge = toned.querySelector<HTMLElement>('[data-slot="item-count"]');
    expect(badge?.dataset.tone).toBe("danger");
    expect(badge?.className).toContain("bg-(color:--werft-tone-danger-bg)");
    const zero = getByRole("tab", {
      name: "요청 0",
    }).querySelector<HTMLElement>('[data-slot="item-count"]');
    expect(zero?.dataset.tone).toBeUndefined();
  });

  test("개수 없이 tone과 countLabel만 있으면 아이콘만 든 배지를 그리고, 뜻은 countLabel로 읽힌다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a" countTone="danger" countLabel="거절 있음">
            성과물
          </TabsTrigger>
          <TabsTrigger value="b" countTone="danger">
            요청
          </TabsTrigger>
          <TabsTrigger value="c" countLabel="모름">
            기록
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const toned = getByRole("tab", { name: "성과물 거절 있음" });
    const badge = toned.querySelector<HTMLElement>('[data-slot="item-count"]');
    expect(badge?.dataset.tone).toBe("danger");
    expect(badge?.textContent).toBe("");
    // As tall as the badge with a number; the count arriving widens it only.
    expect(badge?.className.split(" ")).toContain("h-4");
    const icon = badge?.querySelector("svg");
    expect(icon?.classList.contains("lucide-circle-x")).toBe(true);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    // Without words to say it the icon would mean nothing to a screen
    // reader, and without a tone there is nothing to say.
    for (const name of ["요청", "기록"]) {
      const tab = getByRole("tab", { name });
      expect(tab.querySelector('[data-slot="item-count"]') === null).toBe(true);
    }
  });
});
