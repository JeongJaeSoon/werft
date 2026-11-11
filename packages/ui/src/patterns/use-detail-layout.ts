import { useEffect, useState } from "react";

/** Below this width a detail page puts its side panel above the body. */
const DETAIL_NARROW_WIDTH = 900;

const DETAIL_LAYOUT = {
  wide: "grid min-w-0 grid-cols-[minmax(0,1fr)_var(--werft-layout-detail-panel-width)] items-start gap-6",
  // Stacked, panel and body are two sections of the page.
  narrow:
    "grid min-w-0 grid-cols-1 items-start gap-[var(--werft-space-section)]",
} as const;

/**
 * Whether a detail page's two columns have room. The page renders the panel
 * first when narrow, so the DOM and focus order follow what is seen; CSS
 * `order` alone would leave the keyboard reading the body first.
 */
export function useDetailLayout(enabled = true) {
  // A callback ref, because pages mount the layout only after their data loads.
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!enabled || typeof ResizeObserver === "undefined" || !element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < DETAIL_NARROW_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, element]);
  return {
    ref,
    narrow,
    className: narrow ? DETAIL_LAYOUT.narrow : DETAIL_LAYOUT.wide,
  };
}
