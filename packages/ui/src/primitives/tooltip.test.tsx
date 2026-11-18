import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { fireEvent, render, waitFor } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Tooltip, TooltipContent, TooltipTrigger } = await import(
  "./tooltip.tsx"
);
const { Button } = await import("./button.tsx");

function renderTooltip() {
  const result = render(
    <div>
      <Tooltip>
        <TooltipTrigger asChild={true}>
          <button type="button" aria-label="일시 정지">
            ||
          </button>
        </TooltipTrigger>
        <TooltipContent>실행을 잠시 멈춥니다</TooltipContent>
      </Tooltip>
      <button type="button">다른 곳</button>
    </div>,
  );
  const trigger = result.getByRole("button", { name: "일시 정지" });
  const elsewhere = result.getByRole("button", { name: "다른 곳" });
  const note = () => document.querySelector('[data-slot="popover-content"]');
  return { ...result, trigger, elsewhere, note };
}

describe("Tooltip", () => {
  test("닫혀 있어도 aria-describedby가 가리키는 글자가 설명이다", () => {
    const { trigger, note } = renderTooltip();
    expect(note()).toBeNull();
    const id = trigger.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")?.textContent).toBe(
      "실행을 잠시 멈춥니다",
    );
    expect(trigger.hasAttribute("aria-expanded")).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBe("false");
  });

  test("hover로 열리고 포인터가 나가면 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, elsewhere, note } = renderTooltip();
    await user.hover(trigger);
    await waitFor(() =>
      expect(note()?.textContent).toBe("실행을 잠시 멈춥니다"),
    );
    expect(note()?.getAttribute("role")).toBe("tooltip");
    await user.hover(elsewhere);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("포인터가 트리거에서 내용으로 옮겨 가면 열린 채다", async () => {
    const user = await setupUser();
    const { trigger, note } = renderTooltip();
    await user.hover(trigger);
    await waitFor(() => expect(note()).not.toBeNull());
    // user-event leaves relatedTarget empty; React derives leave from it.
    fireEvent.pointerOut(trigger, {
      pointerType: "mouse",
      relatedTarget: note(),
    });
    expect(note()).not.toBeNull();
    fireEvent.pointerOut(note() as Element, {
      pointerType: "mouse",
      relatedTarget: trigger,
    });
    expect(note()).not.toBeNull();
    fireEvent.pointerOut(note() as Element, {
      pointerType: "mouse",
      relatedTarget: document.body,
    });
    await waitFor(() => expect(note()).toBeNull());
  });

  test("Tab focus로 열려도 포커스는 트리거에 남고, Esc로 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, note } = renderTooltip();
    await user.tab();
    expect(document.activeElement === trigger).toBe(true);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(document.activeElement === trigger).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(note()).toBeNull());
    expect(document.activeElement === trigger).toBe(true);
  });

  test("blur로 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, elsewhere, note } = renderTooltip();
    await user.tab();
    await waitFor(() => expect(note()).not.toBeNull());
    await user.tab();
    expect(document.activeElement === elsewhere).toBe(true);
    expect(document.activeElement === trigger).toBe(false);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("누르기로 열리고, 다시 누르면 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, note } = renderTooltip();
    // A touch press: no hover, and the click after its focus must not close it.
    await user.pointer([{ keys: "[TouchA]", target: trigger }]);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(document.activeElement === trigger).toBe(true);
    await user.pointer([{ keys: "[TouchA]", target: trigger }]);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("마우스 클릭으로 열린 채 남고, 바깥 누르기로 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, elsewhere, note } = renderTooltip();
    await user.click(trigger);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(document.activeElement === trigger).toBe(true);
    await user.pointer([{ keys: "[TouchA]", target: elsewhere }]);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("기본 동작을 취소한 클릭 뒤에도 Esc로 닫힌다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <Tooltip>
        <TooltipTrigger asChild={true}>
          <button type="button" onClick={(event) => event.preventDefault()}>
            취소
          </button>
        </TooltipTrigger>
        <TooltipContent>설명</TooltipContent>
      </Tooltip>,
    );
    const note = () => document.querySelector('[data-slot="popover-content"]');
    await user.click(getByRole("button", { name: "취소" }));
    await waitFor(() => expect(note()).not.toBeNull());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(note()).toBeNull());
  });

  test("자식이 가진 aria-describedby와 설명 id를 함께 둔다", () => {
    const { getByRole } = render(
      <>
        <Tooltip>
          <TooltipTrigger asChild={true}>
            <button type="button" aria-describedby="existing-help">
              도움
            </button>
          </TooltipTrigger>
          <TooltipContent>툴팁 설명</TooltipContent>
        </Tooltip>
      </>,
    );
    const ids = (
      getByRole("button", { name: "도움" }).getAttribute("aria-describedby") ??
      ""
    ).split(" ");
    expect(ids[0]).toBe("existing-help");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[1] ?? "")?.textContent).toBe(
      "툴팁 설명",
    );
  });

  test("처음부터 열린 툴팁은 첫 누르기로 닫힌다", async () => {
    const user = await setupUser();
    const changes: boolean[] = [];
    const { getByRole } = render(
      <Tooltip
        defaultOpen={true}
        onOpenChange={(open) => {
          changes.push(open);
        }}
      >
        <TooltipTrigger asChild={true}>
          <button type="button">열림</button>
        </TooltipTrigger>
        <TooltipContent>처음부터 열림</TooltipContent>
      </Tooltip>,
    );
    const note = () => document.querySelector('[data-slot="popover-content"]');
    expect(note()).not.toBeNull();
    await user.pointer([
      { keys: "[TouchA]", target: getByRole("button", { name: "열림" }) },
    ]);
    await waitFor(() => expect(note()).toBeNull());
    expect(changes.at(-1)).toBe(false);
  });

  test("부모가 닫았다 다시 연 툴팁은 첫 누르기로 닫힌다", async () => {
    const user = await setupUser();
    const changes: boolean[] = [];
    const view = (open: boolean) => (
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          changes.push(next);
        }}
      >
        <TooltipTrigger asChild={true}>
          <button type="button">부모</button>
        </TooltipTrigger>
        <TooltipContent>부모가 연 설명</TooltipContent>
      </Tooltip>
    );
    const { getByRole, rerender } = render(view(false));
    const button = getByRole("button", { name: "부모" });
    await user.hover(button);
    expect(changes).toEqual([true]);
    rerender(view(true));
    rerender(view(false));
    rerender(view(true));
    await user.click(button);
    expect(changes.at(-1)).toBe(false);
  });

  test("부모가 거절한 hover 뒤 부모가 직접 연 툴팁은 첫 누르기로 닫힌다", async () => {
    const user = await setupUser();
    const changes: boolean[] = [];
    const view = (open: boolean) => (
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          changes.push(next);
        }}
      >
        <TooltipTrigger asChild={true}>
          <button type="button">거절</button>
        </TooltipTrigger>
        <TooltipContent>부모가 연 설명</TooltipContent>
      </Tooltip>
    );
    const { getByRole, rerender } = render(view(false));
    const button = getByRole("button", { name: "거절" });
    await user.hover(button);
    expect(changes).toEqual([true]);
    rerender(view(true));
    await user.click(button);
    expect(changes.at(-1)).toBe(false);
  });

  test("ref가 돌려준 cleanup을 unmount 때 부른다", () => {
    const calls: string[] = [];
    const ref = (node: HTMLElement | null) => {
      calls.push(node ? "attach" : "null");
      return () => {
        calls.push("cleanup");
      };
    };
    const { unmount } = render(
      <Tooltip>
        <TooltipTrigger ref={ref}>설명</TooltipTrigger>
        <TooltipContent>내용</TooltipContent>
      </Tooltip>,
    );
    unmount();
    expect(calls).toEqual(["attach", "cleanup"]);
  });

  test("open을 넘기면 그 값대로 열려 있다", () => {
    render(
      <Tooltip open={true}>
        <TooltipTrigger asChild={true}>
          <button type="button">설명</button>
        </TooltipTrigger>
        <TooltipContent>열린 설명</TooltipContent>
      </Tooltip>,
    );
    expect(
      document.querySelector('[data-slot="popover-content"]')?.textContent,
    ).toBe("열린 설명");
  });

  test("asChild로 감싼 Button은 slot이 바뀌어도 data-werft-button 표시를 남긴다", () => {
    const { getByRole } = render(
      <Tooltip>
        <TooltipTrigger asChild={true}>
          <Button asChild={true} variant="outline">
            <a href="#members">다시 활성화</a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>다시 들어올 수 있게 합니다</TooltipContent>
      </Tooltip>,
    );
    const link = getByRole("link", { name: "다시 활성화" });
    // styles.css finds an inactive row's actions by this mark.
    expect(link.getAttribute("data-slot")).toBe("popover-trigger");
    expect(link.hasAttribute("data-werft-button")).toBe(true);
  });
});
