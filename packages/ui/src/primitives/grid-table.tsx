/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: a static table's rows and cells take no focus; the row opener does. */
import { Slot } from "@radix-ui/react-slot";
import {
  type ComponentProps,
  type CSSProperties,
  type JSX,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";

/*
 * The console's one table, drawn as a div grid. It is flat: no frame and no
 * header fill, a rule under the header and between rows, no vertical rules.
 * Every row lays its cells out on the table's one column template.
 *
 * The table never squeezes below `minWidth`. When its box is narrower (a
 * phone), the table scrolls sideways inside its own scroller and the page
 * keeps its width; while it can scroll, the scroller takes a Tab stop so a
 * keyboard can scroll it with the arrow keys.
 */

type GridTableName =
  | { readonly "aria-label": string; readonly "aria-labelledby"?: undefined }
  | { readonly "aria-labelledby": string; readonly "aria-label"?: undefined };

export type GridTableProps = Omit<
  ComponentProps<"div">,
  "role" | "aria-label" | "aria-labelledby"
> &
  GridTableName & {
    /**
     * `grid-template-columns` for every row, e.g.
     * "minmax(0,1.6fr) 120px minmax(0,1.4fr) minmax(0,1fr)". Keep each track
     * `minmax(0,…)` or a fixed width so no cell can push the table wider.
     */
    readonly columns: string;
    /**
     * The narrowest the table draws (a CSS length); below it the scroller
     * scrolls. Defaults to --werft-table-min-width (640px).
     */
    readonly minWidth?: string | undefined;
  };

/** True while the element's content is wider than its box. */
function useScrollsSideways(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [ref]);
  return scrolls;
}

export function GridTable({
  columns,
  minWidth,
  className,
  style,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  ...props
}: GridTableProps): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const scrolls = useScrollsSideways(scroller);
  return (
    // -m-1 p-1: a focus ring drawn 2px outside a control at the table's
    // edge stays inside the scroller's clip.
    <div
      ref={scroller}
      data-slot="grid-table-scroll"
      data-scrolls={scrolls || undefined}
      {...(scrolls
        ? {
            role: "group",
            tabIndex: 0,
            "aria-label": ariaLabel,
            "aria-labelledby": ariaLabelledby,
          }
        : {})}
      className="-m-1 min-w-0 overflow-x-auto overscroll-x-contain p-1 focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2"
    >
      <div
        role="table"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        data-slot="grid-table"
        className={cn(
          "flex min-w-[var(--grid-table-min-width)] flex-col",
          className,
        )}
        style={
          {
            "--grid-table-columns": columns,
            "--grid-table-min-width":
              minWidth ?? "var(--werft-table-min-width)",
            ...style,
          } as CSSProperties
        }
        {...props}
      />
    </div>
  );
}

// The rules run the table's full width; the cells sit 16px in from each end.
const ROW =
  "relative grid grid-cols-[var(--grid-table-columns)] items-center gap-4 border-b px-[var(--werft-table-padding-x)] last:border-b-0";

/** The column header row: small faint labels over a rule, no fill. */
export function GridTableHeader({
  className,
  ...props
}: Omit<ComponentProps<"div">, "role">): JSX.Element {
  return (
    <div
      role="row"
      data-slot="grid-table-header"
      className={cn(
        ROW,
        "min-h-[var(--werft-row-head-min-height)] py-[var(--werft-row-head-padding-y)] font-medium text-caption text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

export type GridTableRowProps = Omit<ComponentProps<"div">, "role"> & {
  /**
   * Draws the row in the inactive tone (styles.css): faint text, badges
   * without hue, buttons untouched. Say "inactive" in the row's text too.
   */
  readonly inactive?: boolean | undefined;
};

/**
 * A body row. A row holding a GridTableRowOpener is clickable as a
 * whole: it takes the hover fill and the pointer.
 */
export function GridTableRow({
  inactive = false,
  className,
  ...props
}: GridTableRowProps): JSX.Element {
  return (
    <div
      role="row"
      data-slot="grid-table-row"
      data-inactive={inactive || undefined}
      className={cn(
        ROW,
        "min-h-[var(--werft-table-row-min-height)] py-[var(--werft-table-row-padding-y)] text-control",
        "has-[[data-slot=grid-table-row-opener]]:cursor-pointer has-[[data-slot=grid-table-row-opener]]:hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

type GridTableCellLayout = {
  /** Content at the end of the column. */
  readonly align?: "start" | "end" | undefined;
};

function cellClasses({ align }: GridTableCellLayout): string {
  return cn(
    "flex min-w-0 items-center gap-2",
    // justify-end places the boxes; text-end the lines of text that wraps.
    align === "end" && "justify-end text-end",
  );
}

export type GridTableColumnHeaderProps = Omit<ComponentProps<"div">, "role"> &
  (
    | {
        /**
         * The row buttons' column: the label sits at the end, centred in a
         * box as wide as the narrowest row button (RowAction's floor), so it
         * lines up over a two-syllable button.
         */
        readonly action: true;
        readonly align?: undefined;
      }
    | {
        readonly action?: false | undefined;
        readonly align?: GridTableCellLayout["align"];
      }
  );

export function GridTableColumnHeader({
  align,
  action = false,
  className,
  children,
  ...props
}: GridTableColumnHeaderProps): JSX.Element {
  return (
    <div
      role="columnheader"
      data-slot="grid-table-column-header"
      data-action={action || undefined}
      className={cn(cellClasses({ align: action ? "end" : align }), className)}
      {...props}
    >
      {action ? (
        <span className="min-w-[var(--werft-row-action-button-min-width)] text-center">
          {children}
        </span>
      ) : (
        children
      )}
    </div>
  );
}

export type GridTableCellProps = Omit<ComponentProps<"div">, "role"> &
  GridTableCellLayout & {
    /**
     * The children stacked, a 20px first line then 16px lines
     * that end in "…" instead of wrapping. The ellipsis is visual only; give
     * the line a `title` or Tooltip with the full text.
     */
    readonly lines?: boolean | undefined;
    /**
     * Drawn above the row's opener, so the buttons and links in
     * it take their own clicks. Never put the opener itself in a raised cell.
     * An `inactive` row leaves a raised cell at full contrast.
     */
    readonly raised?: boolean | undefined;
  };

export function GridTableCell({
  align,
  lines = false,
  raised = false,
  className,
  ...props
}: GridTableCellProps): JSX.Element {
  return (
    <div
      role="cell"
      data-slot="grid-table-cell"
      data-lines={lines || undefined}
      data-raised={raised || undefined}
      className={cn(
        cellClasses({ align }),
        // The lines after the first that is not the row opener.
        lines &&
          "flex-col items-start gap-[var(--werft-row-line-gap)] leading-5 [&>:not([data-slot=grid-table-row-opener])~*]:max-w-full [&>:not([data-slot=grid-table-row-opener])~*]:truncate [&>:not([data-slot=grid-table-row-opener])~*]:leading-4",
        raised && "relative z-1",
        className,
      )}
      {...props}
    />
  );
}

export type GridTableRowOpenerProps = Omit<
  ComponentProps<"button">,
  "aria-label" | "children"
> & {
  /** Names what opens, e.g. "세션 열기: 배포 점검". */
  readonly "aria-label": string;
  /** Render the child (a link) as the opener instead of a button. */
  readonly asChild?: boolean | undefined;
  readonly children?: JSX.Element | undefined;
};

/**
 * An invisible button over the whole row, so a click anywhere on it opens the
 * row and a keyboard reaches it in one Tab stop. Put it in a cell that is not
 * `raised` (a button cannot be a row's own child); it covers the row, not the
 * cell. Its focus ring is drawn inside the row, which the scroller clips.
 */
export function GridTableRowOpener({
  asChild = false,
  className,
  ...props
}: GridTableRowOpenerProps): JSX.Element {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      {...(asChild ? {} : { type: "button" as const })}
      data-slot="grid-table-row-opener"
      className={cn(
        "absolute inset-0 z-0 cursor-pointer rounded-none border-0 bg-transparent p-0",
        "focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}
