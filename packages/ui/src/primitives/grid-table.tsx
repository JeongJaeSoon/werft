/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: a static table's rows and cells take no focus; the row opener does. */
import { Slot } from "@radix-ui/react-slot";
import {
  Children,
  type ComponentProps,
  type CSSProperties,
  createContext,
  Fragment,
  isValidElement,
  type JSX,
  type ReactNode,
  useContext,
} from "react";

import { cn } from "../foundations/cn.ts";

/*
 * Console v4 `.tbl`: a table drawn as a div grid that never scrolls sideways.
 * The table holds the one column template and every row is a subgrid of it,
 * so a `max-content` track is as wide as the widest cell of its column,
 * header included. Below a container width the table switches to a narrower
 * template and drops the columns marked `hideNarrow`, header and cells
 * together, so each row keeps as many cells as there are column headers.
 *
 * Container query widths cannot come from a CSS variable, so the narrow
 * widths are the ones v4 uses, each a fixed class Tailwind can see.
 */
const NARROW = {
  // A table beside a 400px rail at 1280px is about 600px wide and keeps
  // every column; only a phone's drops some. Exclusive, because a half of a
  // two-column row at 1280px is exactly 480px and keeps its columns.
  480: {
    table:
      "[@container(width<480px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(width<480px)]:hidden",
  },
  640: {
    table:
      "[@container(max-width:640px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:640px)]:hidden",
  },
  760: {
    table:
      "[@container(max-width:760px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:760px)]:hidden",
  },
  820: {
    table:
      "[@container(max-width:820px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:820px)]:hidden",
  },
  860: {
    table:
      "[@container(max-width:860px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:860px)]:hidden",
  },
} as const;

export type GridTableNarrowAt = keyof typeof NARROW;

// `narrowCards`: at 640px or less each row is a card of its own, the cells
// stacked, the header kept for screen readers only and every column shown.
const CARDS = {
  table:
    "[@container(max-width:640px)]:flex [@container(max-width:640px)]:flex-col [@container(max-width:640px)]:gap-3 [@container(max-width:640px)]:rounded-none [@container(max-width:640px)]:border-0 [@container(max-width:640px)]:bg-transparent",
  header: "[@container(max-width:640px)]:sr-only",
  row: "[@container(max-width:640px)]:flex [@container(max-width:640px)]:flex-col [@container(max-width:640px)]:items-stretch [@container(max-width:640px)]:gap-2 [@container(max-width:640px)]:py-[var(--werft-row-padding-y)] [@container(max-width:640px)]:rounded-card [@container(max-width:640px)]:border [@container(max-width:640px)]:bg-card [@container(max-width:640px)]:last:border-b",
  start:
    "[@container(max-width:640px)]:justify-start [@container(max-width:640px)]:text-start",
  label:
    "hidden w-28 shrink-0 text-caption text-subtle-foreground [@container(max-width:640px)]:inline",
} as const;

type Narrow = {
  readonly table: string;
  readonly row?: string;
  readonly header?: string;
  readonly hide?: string;
  readonly start?: string;
  readonly label?: string;
};

const NarrowContext = createContext<
  { readonly at: GridTableNarrowAt; readonly cards: boolean } | undefined
>(undefined);

/**
 * Where a column's header and cells sit, set once per column on the table so
 * the two cannot disagree:
 * - "start": text, names, roles, states, dates and relative times.
 * - "end": numbers compared down the column (counts, costs, tokens, times,
 *   ratios), in tabular figures on one line; and, as the last column, a
 *   switch whose visible header names the setting it turns on.
 * - "action": the row's controls, last; the header is read by screen
 *   readers only.
 * Nothing is centred. Stacked as cards (`narrowCards`), every column starts.
 */
export type GridTableColumnAlign = "start" | "end" | "action";

const AlignContext = createContext<readonly GridTableColumnAlign[]>([]);
const ColumnContext = createContext<number | undefined>(undefined);

function useColumnAlign(): GridTableColumnAlign {
  const align = useContext(AlignContext);
  const column = useContext(ColumnContext);
  return column === undefined ? "start" : (align[column] ?? "start");
}

/**
 * A row's children as its columns, in order: arrays and fragments opened,
 * empty slots (null, false) not counted, each other child wrapped with its
 * column index. Each child counts as one column, so a row's or header's
 * children must be its cells themselves, conditionals, arrays or fragments
 * of them; a component that renders several cells, or none, shifts the
 * columns after it.
 */
function indexColumns(children: ReactNode): ReactNode {
  let next = 0;
  // Children.map keys each result under its parent, and a fragment stays a
  // fragment, so keys never collide across levels.
  const open = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (child) => {
      if (child === null || child === undefined || typeof child === "boolean")
        return null;
      if (isValidElement(child) && child.type === Fragment)
        return (
          <Fragment>
            {open((child.props as { readonly children?: ReactNode }).children)}
          </Fragment>
        );
      return (
        <ColumnContext.Provider value={next++}>{child}</ColumnContext.Provider>
      );
    });
  return open(children);
}

type GridTableName =
  | { readonly "aria-label": string; readonly "aria-labelledby"?: undefined }
  | { readonly "aria-labelledby": string; readonly "aria-label"?: undefined };

type GridTableNarrow =
  | {
      readonly narrowAt?: undefined;
      readonly narrowColumns?: undefined;
      readonly narrowCards?: undefined;
    }
  | {
      /** The table width (px) at and below which `narrowColumns` applies. */
      readonly narrowAt: GridTableNarrowAt;
      /** The template once the `hideNarrow` columns are gone. */
      readonly narrowColumns: string;
      readonly narrowCards?: false | undefined;
    }
  | {
      readonly narrowAt: 640;
      readonly narrowColumns?: undefined;
      /**
       * At and below `narrowAt` each row becomes a card with its cells
       * stacked and no column hidden; give the cells a `cardLabel`.
       */
      readonly narrowCards: true;
    };

export type GridTableProps = Omit<
  ComponentProps<"div">,
  "role" | "aria-label" | "aria-labelledby"
> &
  GridTableName &
  GridTableNarrow & {
    /**
     * `grid-template-columns` for every row, e.g.
     * "minmax(0,1fr) max-content max-content". A short column (state, time,
     * count, switch, row action) takes `max-content`: as wide as its widest
     * cell or header, unwrapped. The longest text column takes
     * `minmax(0,1fr)` and with it the width left over. Keep every other track
     * `minmax(0,…)` or fixed, and `narrowAt` wide enough for the
     * `max-content` columns, so no cell can push the table wider.
     */
    readonly columns: string;
    /**
     * Each column's alignment, in the order of `columns`; a column left out
     * starts. Header and cells both follow it.
     */
    readonly align?: readonly GridTableColumnAlign[] | undefined;
    /**
     * Draws the card frame on the table itself. A min-width on the table then
     * includes the 1px border on each side.
     */
    readonly framed?: boolean | undefined;
  };

const START: readonly GridTableColumnAlign[] = [];

export function GridTable({
  columns,
  align = START,
  narrowAt,
  narrowColumns,
  narrowCards = false,
  framed = false,
  className,
  style,
  ...props
}: GridTableProps): JSX.Element {
  const narrow =
    narrowAt === undefined
      ? undefined
      : narrowCards
        ? CARDS.table
        : NARROW[narrowAt].table;
  const table = (
    <div
      role="table"
      data-slot="grid-table"
      data-narrow-at={narrowAt}
      data-narrow-cards={narrowCards || undefined}
      data-framed={framed || undefined}
      className={cn(
        // Each row spans the template and lays its cells on it as a subgrid;
        // the gap matches the rows' own, used when a row leaves the subgrid.
        "grid min-w-0 grid-cols-[var(--grid-table-columns)] gap-x-4 *:col-span-full",
        narrow,
        framed && "rounded-card border bg-card",
        className,
      )}
      style={
        {
          "--grid-table-columns": columns,
          "--grid-table-narrow-columns": narrowColumns,
          ...style,
        } as CSSProperties
      }
      {...props}
    />
  );
  return (
    <NarrowContext.Provider
      value={
        narrowAt === undefined
          ? undefined
          : { at: narrowAt, cards: narrowCards }
      }
    >
      <AlignContext.Provider value={align}>
        {/* The table cannot query its own width to change its template or
            drop its frame, and its rows and cells query the same wrapper so
            they all switch at one width. */}
        <div className="@container min-w-0">{table}</div>
      </AlignContext.Provider>
    </NarrowContext.Provider>
  );
}

// The last row rounds like the header, so a filled last row (hover, inactive)
// keeps the frame's bottom corners; the frame cannot clip (see the opener).
const ROW =
  "relative grid grid-cols-subgrid items-center gap-4 border-b px-[var(--werft-row-padding-x)] last:rounded-b-card last:border-b-0";

function useNarrow(): Narrow | undefined {
  const narrow = useContext(NarrowContext);
  if (narrow === undefined) return undefined;
  return narrow.cards ? CARDS : NARROW[narrow.at];
}

/** The column header row, v4 `.tr.th`. */
export function GridTableHeader({
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "role">): JSX.Element {
  const narrow = useNarrow();
  return (
    <div
      role="row"
      data-slot="grid-table-header"
      className={cn(
        ROW,
        narrow?.header ?? narrow?.row,
        "min-h-[var(--werft-row-head-min-height)] rounded-t-card bg-surface-sunken py-[var(--werft-row-head-padding-y)] font-medium text-caption text-subtle-foreground",
        className,
      )}
      {...props}
    >
      {indexColumns(children)}
    </div>
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
 * A body row, v4 `.tr`. A row holding a GridTableRowOpener is clickable as a
 * whole: it takes the hover fill and the pointer.
 */
export function GridTableRow({
  inactive = false,
  className,
  children,
  ...props
}: GridTableRowProps): JSX.Element {
  const narrow = useNarrow();
  return (
    <div
      role="row"
      data-slot="grid-table-row"
      data-inactive={inactive || undefined}
      className={cn(
        ROW,
        narrow?.row,
        "min-h-[var(--werft-row-min-height)] py-[var(--werft-grid-row-padding-y)] text-control",
        "has-[[data-slot=grid-table-row-opener]]:cursor-pointer has-[[data-slot=grid-table-row-opener]]:hover:bg-hover",
        className,
      )}
      {...props}
    >
      {indexColumns(children)}
    </div>
  );
}

type GridTableCellLayout = {
  /** v4 `.hide-md`: gone, from screen and accessibility tree, when narrow. */
  readonly hideNarrow?: boolean | undefined;
};

function cellClasses(
  narrow: Narrow | undefined,
  align: GridTableColumnAlign,
  hideNarrow: boolean | undefined,
): string {
  return cn(
    "flex min-w-0 items-center gap-2",
    // justify-end places the boxes; text-end the lines of text that wraps.
    align !== "start" && cn("justify-end text-end", narrow?.start),
    align === "end" && "whitespace-nowrap tabular-nums",
    hideNarrow && narrow?.hide,
  );
}

export type GridTableColumnHeaderProps = Omit<ComponentProps<"div">, "role"> &
  GridTableCellLayout;

/** Sits where the table's `align` puts its column's cells. */
export function GridTableColumnHeader({
  hideNarrow,
  className,
  children,
  ...props
}: GridTableColumnHeaderProps): JSX.Element {
  const narrow = useNarrow();
  const align = useColumnAlign();
  return (
    <div
      role="columnheader"
      data-slot="grid-table-column-header"
      data-align={align}
      data-hide-narrow={hideNarrow || undefined}
      className={cn(cellClasses(narrow, align, hideNarrow), className)}
      {...props}
    >
      {align === "action" ? (
        <span className="sr-only">{children}</span>
      ) : (
        children
      )}
    </div>
  );
}

export type GridTableCellProps = Omit<ComponentProps<"div">, "role"> &
  GridTableCellLayout & {
    /**
     * v4 `.cell.col`: the children stacked, a 20px first line then 16px lines
     * that end in "…" instead of wrapping. The ellipsis is visual only; give
     * the line a `title` or Tooltip with the full text.
     */
    readonly lines?: boolean | undefined;
    /**
     * v4 `.cell.z`: drawn above the row's opener, so the buttons and links in
     * it take their own clicks. Never put the opener itself in a raised cell.
     * An `inactive` row leaves a raised cell at full contrast.
     */
    readonly raised?: boolean | undefined;
    /**
     * The column's name, shown before the content when `narrowCards` draws
     * the row as a card. Hidden from screen readers, which have the column
     * header. Not for a `lines` cell.
     */
    readonly cardLabel?: string | undefined;
  };

export function GridTableCell({
  hideNarrow,
  lines = false,
  raised = false,
  cardLabel,
  className,
  children,
  ...props
}: GridTableCellProps): JSX.Element {
  const narrow = useNarrow();
  const align = useColumnAlign();
  return (
    <div
      role="cell"
      data-slot="grid-table-cell"
      data-align={align}
      data-hide-narrow={hideNarrow || undefined}
      data-lines={lines || undefined}
      data-raised={raised || undefined}
      className={cn(
        cellClasses(narrow, align, hideNarrow),
        // The lines after the first that is not the row opener.
        lines &&
          "flex-col items-start gap-[var(--werft-row-line-gap)] leading-5 [&>:not([data-slot=grid-table-row-opener])~*]:max-w-full [&>:not([data-slot=grid-table-row-opener])~*]:truncate [&>:not([data-slot=grid-table-row-opener])~*]:leading-4",
        raised && "relative z-1",
        className,
      )}
      {...props}
    >
      {cardLabel !== undefined && narrow?.label !== undefined ? (
        <span aria-hidden="true" className={narrow.label}>
          {cardLabel}
        </span>
      ) : null}
      {children}
    </div>
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
 * v4 `.row-open`: an invisible button over the whole row, so a click anywhere
 * on it opens the row and a keyboard reaches it in one Tab stop. Put it in a
 * cell that is not `raised` (a button cannot be a row's own child); it covers
 * the row, not the cell. Its focus outline is the console's 2px ring, outside
 * the row's edge, so the table's parent must not clip overflow.
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
        "focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}
