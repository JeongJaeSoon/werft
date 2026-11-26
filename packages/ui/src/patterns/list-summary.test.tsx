import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, within } = await setupDom();
const { ListSummary, ListSummaryItem } = await import("./list-summary.tsx");

function Line() {
  return (
    <ListSummary aria-label="세션 요약">
      <ListSummaryItem label="세션" value="12" />
      <ListSummaryItem
        label="실패"
        value="3"
        status="failed"
        link={<a href="/sessions?status=failed">ignored</a>}
      />
    </ListSummary>
  );
}

describe("ListSummary", () => {
  test("is a named list of figures, each read as its name then its value", () => {
    const view = render(<Line />);
    const line = view.getByRole("list", { name: "세션 요약" });
    const items = within(line).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "세션 12",
      "실패 3",
    ]);
    // A plain figure is text: nothing to tab to.
    expect(within(items[0] as HTMLElement).queryByRole("link")).toBeNull();
    // The status dot is colour only; the name says the status.
    const dot = (items[1] as HTMLElement).querySelector(
      "[data-slot=status-dot]",
    );
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    view.unmount();
  });

  test("a figure given a link renders as that link, the figure in place of its children", async () => {
    const user = await setupUser();
    const view = render(<Line />);
    const link = view.getByRole("link", { name: "실패 3" });
    expect(link.getAttribute("href")).toBe("/sessions?status=failed");
    expect(link.textContent).not.toContain("ignored");
    await user.tab();
    expect(document.activeElement === link).toBe(true);
    view.unmount();
  });

  test("movement stops under reduced motion, and the focus outline is drawn", () => {
    const view = render(<Line />);
    const link = view.getByRole("link", { name: "실패 3" });
    expect(link.className).toContain("motion-reduce:transition-none");
    expect(link.className).toContain("focus-visible:outline-2");
    // The line wraps instead of scrolling sideways on a narrow screen.
    expect(view.getByRole("list").className).toContain("flex-wrap");
    view.unmount();
  });
});
