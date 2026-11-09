import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";

const { render, waitFor } = await setupDom();
// After setupDom: this loads @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const {
  DETAIL_RAIL_WIDE,
  DetailLayout,
  DetailRail,
  DetailRailSection,
  useDetailRailToggle,
} = await import("./detail-layout.tsx");

// Happy DOM lays nothing out, so the rail's heights are set on the element
// and a new render runs the check again.
const sized = (content: Element | null, scroll: number, client: number) => {
  Object.defineProperty(content, "scrollHeight", { value: scroll });
  Object.defineProperty(content, "clientHeight", { value: client });
};

function Page() {
  return (
    <DetailLayout
      rail={
        <DetailRail label="세션 요약">
          <DetailRailSection title="운영">rows</DetailRailSection>
        </DetailRail>
      }
    >
      <h1>본문</h1>
    </DetailLayout>
  );
}

describe("DetailLayout", () => {
  test("the body's left edge is measured on the whole width, not what the rail leaves", () => {
    const { container } = render(<Page />);
    const layout = container.querySelector('[data-slot="detail-layout"]');
    const frame = container.querySelector('[data-slot="page-frame"]');
    expect(layout?.classList.contains("@container")).toBe(true);
    // Happy DOM lays nothing out; the browser check measures the edges.
    expect(frame?.className).toContain(
      "xl:[&>[data-slot=page-frame-body]]:ml-[max(0px,calc((100cqw-3rem-var(--werft-w-page))/2))]",
    );
    expect(frame?.className).toContain(
      "xl:[&>[data-slot=page-frame-body]]:w-auto",
    );
  });
});

describe("DetailRail", () => {
  test("a rail taller than the screen takes a keyboard stop to scroll", async () => {
    const { container, rerender, getByRole } = render(<Page />);
    const content = container.querySelector(
      '[data-slot="detail-rail-content"]',
    );
    expect(content?.hasAttribute("tabindex")).toBe(false);
    sized(content, 900, 600);
    rerender(<Page />);
    await waitFor(() => expect(content?.getAttribute("tabindex")).toBe("0"));
    expect(getByRole("group", { name: "세션 요약" }) === content).toBe(true);
    expect(
      getByRole("complementary", { name: "세션 요약" }).contains(content),
    ).toBe(true);
  });

  test("a rail that fits takes no extra stop", () => {
    const { container, rerender } = render(<Page />);
    const content = container.querySelector(
      '[data-slot="detail-rail-content"]',
    );
    sized(content, 400, 400);
    rerender(<Page />);
    expect(content?.hasAttribute("tabindex")).toBe(false);
    expect(content?.hasAttribute("role")).toBe(false);
  });
});

const KEY = "test.rail";

/** happy-dom has no opinion on widths; the test says which side it is on. */
function stubWide(wide: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === DETAIL_RAIL_WIDE ? wide : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function Foldable({ visit }: { readonly visit?: string }) {
  const toggle = useDetailRailToggle({
    id: "rail",
    storageKey: KEY,
    closeLabel: "요약 닫기",
    visit,
  });
  return (
    <DetailLayout
      rail={
        <DetailRail label="세션 요약" toggle={toggle}>
          <DetailRailSection title="운영">
            <button type="button">허용</button>
          </DetailRailSection>
        </DetailRail>
      }
    >
      <button
        ref={toggle.triggerRef}
        type="button"
        aria-expanded={toggle.open}
        aria-controls={toggle.id}
        onClick={toggle.toggle}
      >
        패널
      </button>
    </DetailLayout>
  );
}

describe("useDetailRailToggle", () => {
  test("from 1280px the column starts open and folding it is remembered", async () => {
    const restore = stubWide(true);
    localStorage.removeItem(KEY);
    try {
      const user = await setupUser();
      const { getByRole, container, unmount } = render(<Foldable />);
      const button = getByRole("button", { name: "패널" });
      const rail = container.querySelector("#rail");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-controls")).toBe("rail");
      expect(rail?.hasAttribute("hidden")).toBe(false);
      expect(rail?.hasAttribute("data-sheet")).toBe(false);
      await user.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(rail?.hasAttribute("hidden")).toBe(true);
      expect(localStorage.getItem(KEY)).toBe("folded");
      unmount();
      const again = render(<Foldable />);
      expect(
        again
          .getByRole("button", { name: "패널" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      localStorage.removeItem(KEY);
      restore();
    }
  });

  test("narrower, the rail is a sheet that starts closed, takes focus and closes on Escape", async () => {
    const restore = stubWide(false);
    localStorage.setItem(KEY, "open");
    try {
      const user = await setupUser();
      const { getByRole, container } = render(<Foldable />);
      const button = getByRole("button", { name: "패널" });
      const rail = container.querySelector("#rail");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(rail?.hasAttribute("hidden")).toBe(true);
      await user.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(rail?.hasAttribute("data-sheet")).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(rail));
      await user.keyboard("{Escape}");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(button);
      // The close button inside the sheet does the same.
      await user.click(button);
      await user.click(getByRole("button", { name: "요약 닫기" }));
      expect(rail?.hasAttribute("hidden")).toBe(true);
      expect(document.activeElement).toBe(button);
      // A sheet is per visit: nothing was written.
      expect(localStorage.getItem(KEY)).toBe("open");
    } finally {
      localStorage.removeItem(KEY);
      restore();
    }
  });

  test("a sheet opened on one visit starts closed on the next", async () => {
    const restore = stubWide(false);
    try {
      const user = await setupUser();
      const { getByRole, rerender } = render(<Foldable visit="a" />);
      const button = getByRole("button", { name: "패널" });
      await user.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      rerender(<Foldable visit="b" />);
      expect(
        getByRole("button", { name: "패널" }).getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      restore();
    }
  });

  test("blocked storage only forgets the choice", async () => {
    const restore = stubWide(true);
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      const user = await setupUser();
      const { getByRole } = render(<Foldable />);
      const button = getByRole("button", { name: "패널" });
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await user.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      restore();
    }
  });
});
