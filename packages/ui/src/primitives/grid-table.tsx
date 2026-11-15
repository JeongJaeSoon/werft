/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: a static table's rows and cells take no focus; the row opener does. */
import { Slot } from "@radix-ui/react-slot";
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type JSX,
  useContext,
} from "react";

import { cn } from "../foundations/cn.ts";

/*
 * Console v4 `.tbl`: a table drawn as a div grid that never scrolls sideways.
 * Every row lays its cells out on the table's one column template; below a
 * container width the table switches to a narrower template and drops the
 * columns marked `hideNarrow`, header and cells together, so each row keeps
 * as many cells as there are column headers.
 *
 * Container query widths cannot come from a CSS variable, so the narrow
 * widths are the ones v4 uses, each a fixed class Tailwind can see.
 */
const NARROW = {
  // A table beside a 400px rail at 1280px is about 600px wide and keeps
  // every column; only a phone's drops some. Exclusive, because a half of a
  // two-column row at 1280px is exactly 480px and keeps its columns.
  480: {
    row: "[@container(width<480px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(width<480px)]:hidden",
  },
  640: {
    row: "[@container(max-width:640px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:640px)]:hidden",
  },
  760: {
    row: "[@container(max-width:760px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:760px)]:hidden",
  },
  820: {
    row: "[@container(max-width:820px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:820px)]:hidden",
  },
  860: {
    row: "[@container(max-width:860px)]:grid-cols-[var(--grid-table-narrow-columns)]",
    hide: "[@container(max-width:860px)]:hidden",
  },
} as const;

export type GridTableNarrowAt = keyof typeof NARROW;

// `narrowCards`: at 640px or less each row is a card of its own, the cells
// stacked, the header kept for screen readers only and every column shown.
const CARDS = {
  table:
    "[@container(max-width:640px)]:gap-3 [@container(max-width:640px)]:rounded-none [@container(max-width:640px)]:border-0 [@container(max-width:640px)]:bg-transparent",
  header: "[@container(max-width:640px)]:sr-only",
  row: "[@container(max-width:640px)]:flex [@container(max-width:640px)]:flex-col [@container(max-width:640px)]:items-stretch [@container(max-width:640px)]:gap-2 [@container(max-width:640px)]:rounded-card [@container(max-width:640px)]:border [@container(max-width:640px)]:bg-card [@container(max-width:640px)]:last:border-b",
  start:
    "[@container(max-width:640px)]:justify-start [@container(max-width:640px)]:text-start",
  label:
    "hidden w-28 shrink-0 text-caption text-subtle-foreground [@container(max-width:640px)]:inline",
} as const;

type Narrow = {
  readonly row: string;
  readonly header?: string;
  readonly hide?: string;
  readonly start?: string;
  readonly label?: string;
};

const NarrowContext = createContext<
  { readonly at: GridTableNarrowAt; readonly cards: boolean } | undefined
>(undefined);

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
     * "minmax(0,1.6fr) 120px minmax(0,1.4fr) minmax(0,1fr)". Keep each track
     * `minmax(0,…)` or a fixed width so no cell can push the table wider.
     */
    readonly columns: string;
    /**
     * Draws the card frame on the table itself. A min-width on the table then
     * includes the 1px border on each side.
     */
    readonly framed?: boolean | undefined;
  };

export function GridTable({
  columns,
  narrowAt,
  narrowColumns,
  narrowCards = false,
  framed = false,
  className,
  style,
  ...props
}: GridTableProps): JSX.Element {
  const table = (
    <div
      role="table"
      data-slot="grid-table"
      data-narrow-at={narrowAt}
      data-narrow-cards={narrowCards || undefined}
      data-framed={framed || undefined}
      className={cn(
        "flex min-w-0 flex-col",
        !narrowCards && "@container",
        framed && "rounded-card border bg-card",
        narrowCards && CARDS.table,
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
      {/* The table cannot query its own width to drop its frame, and its rows
          query the same wrapper so frame and cards switch at one width. */}
      {narrowCards ? <div className="@container min-w-0">{table}</div> : table}
    </NarrowContext.Provider>
  );
}

const ROW =
  "relative grid grid-cols-[var(--grid-table-columns)] items-center gap-4 border-b px-[var(--werft-row-padding-x)] last:border-b-0";

function useNarrow(): Narrow | undefined {
  const narrow = useContext(NarrowContext);
  if (narrow === undefined) return undefined;
  return narrow.cards ? CARDS : NARROW[narrow.at];
}

/** The column header row, v4 `.tr.th`. */
export function GridTableHeader({
  className,
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
 * A body row, v4 `.tr`. A row holding a GridTableRowOpener is clickable as a
 * whole: it takes the hover fill and the pointer.
 */
export function GridTableRow({
  inactive = false,
  className,
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
        "min-h-[var(--werft-row-min-height)] py-[var(--werft-row-padding-y)] text-control",
        "has-[[data-slot=grid-table-row-opener]]:cursor-pointer has-[[data-slot=grid-table-row-opener]]:hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

type GridTableCellLayout = {
  /**
   * v4 `.cell.end`: content at the end of the column. For a control column
   * (a switch, row button or menu) and for numbers compared down the column
   * (the operations metrics); a list's text, dates and counts start, header
   * and cells alike, so a row does not read half left, half right.
   */
  readonly align?: "start" | "end" | undefined;
  /** v4 `.hide-md`: gone, from screen and accessibility tree, when narrow. */
  readonly hideNarrow?: boolean | undefined;
};

function cellClasses(
  narrow: Narrow | undefined,
  { align, hideNarrow }: GridTableCellLayout,
): string {
  return cn(
    "flex min-w-0 items-center gap-2",
    // justify-end places the boxes; text-end the lines of text that wraps.
    align === "end" && cn("justify-end text-end", narrow?.start),
    hideNarrow && narrow?.hide,
  );
}

export type GridTableColumnHeaderProps = Omit<ComponentProps<"div">, "role"> &
  Pick<GridTableCellLayout, "hideNarrow"> &
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
  hideNarrow,
  action = false,
  className,
  children,
  ...props
}: GridTableColumnHeaderProps): JSX.Element {
  const narrow = useNarrow();
  return (
    <div
      role="columnheader"
      data-slot="grid-table-column-header"
      data-hide-narrow={hideNarrow || undefined}
      data-action={action || undefined}
      className={cn(
        cellClasses(narrow, { align: action ? "end" : align, hideNarrow }),
        className,
      )}
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
  align,
  hideNarrow,
  lines = false,
  raised = false,
  cardLabel,
  className,
  children,
  ...props
}: GridTableCellProps): JSX.Element {
  const narrow = useNarrow();
  return (
    <div
      role="cell"
      data-slot="grid-table-cell"
      data-hide-narrow={hideNarrow || undefined}
      data-lines={lines || undefined}
      data-raised={raised || undefined}
      className={cn(
        cellClasses(narrow, { align, hideNarrow }),
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
