import { Button, cn, PageFrame, Section, useMediaQuery } from "@werft-ai/ui";
import { X } from "lucide-react";
import {
  type ComponentProps,
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

export type DetailLayoutProps = Omit<ComponentProps<"div">, "children"> & {
  /** The page itself: its header, tabs and content. */
  readonly children: ReactNode;
  /** A `DetailRail`, drawn at the right edge from 1280px and under the body below. */
  readonly rail?: ReactNode;
};

/**
 * A detail page with a right rail (Cloudflare's domain overview). The host
 * gives it the whole area under the top bar, with no padding of its own: the
 * body sits in the same `PageFrame` as every other page, and the rail runs
 * from the top bar to the bottom of the screen. Below 1280px the rail
 * follows the body, so DOM, focus and reading order agree at every width.
 */
export function DetailLayout({
  children,
  rail,
  className,
  ...props
}: DetailLayoutProps): JSX.Element {
  return (
    <div
      data-slot="detail-layout"
      className={cn(
        "@container flex min-w-0 flex-1 flex-col xl:grid xl:grid-cols-[minmax(0,1fr)_auto]",
        className,
      )}
      {...props}
    >
      {/* The body's left edge is where a page without a rail centres it,
          measured on the whole width rather than what the rail leaves, so
          opening a rail or switching to a tab without one does not move it;
          a narrow screen gives up the body's right edge instead. 3rem is
          PageFrame's own padding from 768px. */}
      <PageFrame className="xl:[&>[data-slot=page-frame-body]]:mr-0 xl:[&>[data-slot=page-frame-body]]:w-auto xl:[&>[data-slot=page-frame-body]]:ml-[max(0px,calc((100cqw-3rem-var(--werft-w-page))/2))]">
        {children}
      </PageFrame>
      {rail}
    </div>
  );
}

export type DetailRailProps = Omit<
  ComponentProps<"aside">,
  "aria-label" | "children"
> & {
  /** The landmark's name: a page has one rail, and it is read by this. */
  readonly label: string;
  /** `DetailRailSection`s, in reading order. */
  readonly children: ReactNode;
  /**
   * A rail the reader folds away with a toggle of the page's own
   * (`useDetailRailToggle`). Without it the rail is always there.
   */
  readonly toggle?: DetailRailToggle | undefined;
};

/**
 * The rail beside a detail page's body: a 400px column with a 1px line on
 * its left, 24px inside above and below at every width and on the sides
 * from 768px (V4-RAIL-PAD, V4-DETAIL-HEADER), as
 * tall as the body or the screen, whichever is taller. Its
 * content stays in view while the page scrolls and scrolls on its own when
 * taller than the screen. Below 1280px it is a band under the body, its
 * sections side by side where they fit.
 */
export function DetailRail({
  label,
  children,
  toggle,
  className,
  ...props
}: DetailRailProps): JSX.Element {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const scrollable = useOverflows(content, children);
  const sheet = toggle !== undefined && !toggle.wide;
  const sheetOpen = sheet && toggle.open;
  const self = useRef<HTMLElement>(null);
  // An opened sheet covers the body, so the reader lands inside it.
  useEffect(() => {
    if (sheetOpen) self.current?.focus();
  }, [sheetOpen]);
  return (
    <aside
      ref={self}
      data-slot="detail-rail"
      aria-label={label}
      id={toggle?.id}
      // Folded, it stays mounted so an answer in flight keeps its state.
      hidden={toggle !== undefined && !toggle.open}
      data-sheet={sheet ? "" : undefined}
      // The sheet takes focus when it opens, so it needs to be focusable.
      tabIndex={sheet ? -1 : undefined}
      onKeyDown={
        sheet
          ? (event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              toggle.close();
            }
          : undefined
      }
      className={cn(
        "min-w-0 border-t bg-surface xl:w-[25rem] xl:border-t-0 xl:border-l",
        // Below 1280px a foldable rail does not follow the body, where the
        // timeline's full-screen height would push it out of sight: it
        // opens over the body's right side, under the top bar.
        "data-[sheet]:fixed data-[sheet]:top-[var(--werft-topbar-h)] data-[sheet]:right-0 data-[sheet]:bottom-0 data-[sheet]:z-30 data-[sheet]:w-[min(100%,25rem)] data-[sheet]:overflow-y-auto data-[sheet]:border-t data-[sheet]:border-l data-[sheet]:shadow-pop data-[sheet]:outline-none",
        className,
      )}
      {...props}
    >
      {sheet ? (
        <div className="flex items-center justify-between gap-2 px-4 pt-4 md:px-[var(--werft-space-6)]">
          <span className="font-medium text-control">{label}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={toggle.closeLabel}
            onClick={toggle.close}
          >
            <X strokeWidth={1.5} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <div
        ref={setContent}
        data-slot="detail-rail-content"
        // Only while it scrolls on its own: a keyboard needs a stop to
        // scroll it, and the band below 1280px would gain a useless one.
        {...(scrollable
          ? { tabIndex: 0, role: "group", "aria-label": label }
          : undefined)}
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] items-start gap-x-8 gap-y-6 px-4 py-6 md:p-[var(--werft-space-6)] xl:sticky xl:top-0 xl:flex xl:max-h-[calc(100dvh-var(--werft-topbar-h))] xl:flex-col xl:items-stretch xl:gap-y-0 xl:divide-y xl:overflow-y-auto"
      >
        {children}
      </div>
    </aside>
  );
}

function useOverflows(element: HTMLElement | null, children: ReactNode) {
  const [overflows, setOverflows] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new children may change the height
  useEffect(() => {
    if (!element) return;
    const check = () =>
      setOverflows(element.scrollHeight > element.clientHeight);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [element, children]);
  return overflows;
}

export interface DetailRailSectionProps {
  readonly title: ReactNode;
  /** One line under the title, such as what the section's rule is. */
  readonly description?: ReactNode;
  /** Drawn at the head's far end, such as a done mark. */
  readonly actions?: ReactNode;
  readonly className?: string;
  /** Rows: a `KeyValueList`, a short paragraph, or request cards. */
  readonly children?: ReactNode;
}

/**
 * One titled group of the rail, without a card around it: lines between
 * groups stand in for the borders.
 */
export function DetailRailSection({
  title,
  description,
  actions,
  className,
  children,
}: DetailRailSectionProps): JSX.Element {
  return (
    <Section
      data-slot="detail-rail-section"
      title={title}
      description={description}
      actions={actions}
      className={cn(
        "min-w-0 xl:py-[var(--werft-space-6)] xl:first:pt-0 xl:last:pb-0",
        className,
      )}
    >
      {children}
    </Section>
  );
}

/** What a foldable rail and its toggle share; `useDetailRailToggle` makes it. */
export interface DetailRailToggle {
  /** The rail's id, for the toggle's `aria-controls`. */
  readonly id: string;
  /** Whether the rail shows at the current width. */
  readonly open: boolean;
  /** 1280px and up: the rail is a column, else a sheet over the body. */
  readonly wide: boolean;
  readonly toggle: () => void;
  /** Closes the rail and gives focus back to the toggle. */
  readonly close: () => void;
  /** The sheet's close button's name. */
  readonly closeLabel: string;
  /** Put on the toggle button, so closing from the rail returns there. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

/** The width from which the rail is a column: Tailwind's `xl`, 80rem. */
export const DETAIL_RAIL_WIDE = "(min-width: 80rem)";

function storedFolded(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "folded";
  } catch {
    // Storage can be blocked; the column then starts open.
    return false;
  }
}

/**
 * The state behind a rail the reader can fold. From 1280px the rail is a
 * column that starts open, and folding it is remembered in this browser
 * under `storageKey` (a convenience: blocked storage only forgets it).
 * Narrower, it is a sheet that starts closed on every visit, since an open
 * one covers the body.
 */
export function useDetailRailToggle({
  id,
  storageKey,
  closeLabel,
}: {
  readonly id: string;
  readonly storageKey: string;
  readonly closeLabel: string;
}): DetailRailToggle {
  // Without matchMedia the rail is the column it always was.
  const wide = useMediaQuery(DETAIL_RAIL_WIDE, true);
  const [folded, setFolded] = useState(() => storedFolded(storageKey));
  const [sheetOpen, setSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const setColumn = (next: boolean) => {
    setFolded(next);
    try {
      globalThis.localStorage?.setItem(storageKey, next ? "folded" : "open");
    } catch {
      // Storage can be blocked; the choice then lasts for this page only.
    }
  };
  const open = wide ? !folded : sheetOpen;
  return {
    id,
    open,
    wide,
    closeLabel,
    triggerRef,
    toggle: () => (wide ? setColumn(!folded) : setSheetOpen(!sheetOpen)),
    close: () => {
      if (wide) setColumn(true);
      else setSheetOpen(false);
      triggerRef.current?.focus();
    },
  };
}
