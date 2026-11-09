import { useSyncExternalStore } from "react";

function listen(query: string, onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const list = window.matchMedia(query);
  // Safari < 14 only has the deprecated listener pair.
  if (list.addEventListener) {
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }
  list.addListener(onChange);
  return () => list.removeListener(onChange);
}

/**
 * Whether a media query matches now, following changes. Where there is no
 * `matchMedia` (a server render, an old test DOM) it answers `fallback`.
 * For layout that CSS alone can draw, use CSS: this is for state that has
 * to know, such as a toggle's `aria-expanded` that means a different thing
 * on each side of a breakpoint.
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => listen(query, onChange),
    () =>
      typeof window === "undefined" || !window.matchMedia
        ? fallback
        : window.matchMedia(query).matches,
    () => fallback,
  );
}
