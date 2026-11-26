import { describe, expect, test } from "bun:test";
import { useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, within } = await setupDom();
const { ListSummary, ListSummaryItem } = await import("./list-summary.tsx");

function Pressable() {
  const [on, setOn] = useState(false);
  return (
    <ListSummary aria-label="세션 요약">
      <ListSummaryItem label="세션" value="12" />
      <ListSummaryItem
        label="실패"
        value="3"
        status="failed"
        pressed={on}
        onPress={() => setOn(!on)}
      />
      <ListSummaryItem
        label="작업 중"
        value="2"
        status="run"
        link={<a href="/sessions?status=running">ignored</a>}
      />
    </ListSummary>
  );
}

describe("ListSummary", () => {
  test("is a named list of figures, each read as its name then its value", () => {
    const view = render(<Pressable />);
    const line = view.getByRole("list", { name: "세션 요약" });
    const items = within(line).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "세션 12",
      "실패 3",
      "작업 중 2",
    ]);
    // A plain figure is text: nothing to tab to.
    expect(within(items[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(within(items[0] as HTMLElement).queryByRole("link")).toBeNull();
    // The status dot is colour only; the name says the status.
    const dot = (items[1] as HTMLElement).querySelector(
      "[data-slot=status-dot]",
    );
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    view.unmount();
  });

  test("a figure with onPress is a toggle button that says whether its filter is on", async () => {
    const user = await setupUser();
    const view = render(<Pressable />);
    const failed = view.getByRole("button", { name: "실패 3" });
    expect(failed.getAttribute("aria-pressed")).toBe("false");
    expect(failed.getAttribute("type")).toBe("button");
    await user.click(failed);
    expect(failed.getAttribute("aria-pressed")).toBe("true");
    // More than the faint fill shows it pressed.
    expect(failed.className).toContain("aria-pressed:ring-subtle-foreground");
    // Keyboard: Tab reaches it and Enter or Space presses it.
    failed.blur();
    await user.tab();
    expect(document.activeElement).toBe(failed);
    await user.keyboard("{Enter}");
    expect(failed.getAttribute("aria-pressed")).toBe("false");
    await user.keyboard(" ");
    expect(failed.getAttribute("aria-pressed")).toBe("true");
    view.unmount();
  });

  test("a figure given a link renders as that link, the figure in place of its children", () => {
    const view = render(<Pressable />);
    const link = view.getByRole("link", { name: "작업 중 2" });
    expect(link.getAttribute("href")).toBe("/sessions?status=running");
    expect(link.textContent).not.toContain("ignored");
    // Pressed or not is the list's business; a link carries no aria-pressed.
    expect(link.hasAttribute("aria-pressed")).toBe(false);
    view.unmount();
  });

  test("movement stops under reduced motion, and the focus outline is drawn", () => {
    const view = render(<Pressable />);
    const failed = view.getByRole("button", { name: "실패 3" });
    expect(failed.className).toContain("motion-reduce:transition-none");
    expect(failed.className).toContain("focus-visible:outline-2");
    // The line wraps instead of scrolling sideways on a narrow screen.
    expect(view.getByRole("list").className).toContain("flex-wrap");
    view.unmount();
  });
});
