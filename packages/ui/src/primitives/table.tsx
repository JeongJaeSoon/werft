import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * The console's tables. Their spacing is the --werft-row-* tokens in tokens.css,
 * shared with the session table in @werft-ai/react.
 *
 * A table cell takes half the row inset on each side, so neighbours sit one
 * full inset apart like the grid rows' gap, and only the outer cells take the
 * full inset from the frame.
 */
const CELL_PADDING_X =
  "px-[calc(var(--werft-row-padding-x)/2)] first:pl-[var(--werft-row-padding-x)] last:pr-[var(--werft-row-padding-x)]";

/*
 * `actions` is a column of row buttons: as narrow as its content, never
 * wrapped, and every labelled button in it at least
 * --werft-row-action-button-min-width wide, RowAction's floor. A label that
 * changes ("disable" ↔ "enable") may shift the width; the right end stays.
 * An icon button keeps its own square size.
 *
 * `nowrap` is a date or badge column: as narrow as its content and never
 * wrapped. `numeric` is a number compared down the column (count, cost,
 * tokens, time, ratio): `nowrap`, in tabular figures, header and cells at the
 * end, as GridTable's "end" columns. `switch` is the last column, a switch
 * under a visible header naming the setting: both end at one x, however wide
 * the header's language makes the column. Give a column's header and its
 * cells the same variant. `text` is the long-text column: it takes the width the other
 * columns leave, down to --werft-row-text-min-width, and the lines after the
 * first in its RowLines end in "…" instead of wrapping, so every row keeps one
 * height. `max-w-0` stops auto layout from widening the column to the text,
 * which is what lets the ellipsis appear. The ellipsis is visual only; give
 * the line a `title` with the full text (until Tooltip lands).
 */
const CELL_VARIANT = {
  default: "",
  actions:
    "w-px whitespace-nowrap [&_[data-slot=button]:not([data-size^=icon])]:min-w-[var(--werft-row-action-button-min-width)]",
  nowrap: "w-px whitespace-nowrap",
  numeric: "w-px whitespace-nowrap text-right tabular-nums",
  switch: "w-px whitespace-nowrap text-right [&>[data-slot=switch]]:ml-auto",
  text: "w-full min-w-[var(--werft-row-text-min-width)] max-w-0 [&_[data-slot=row-lines]>*:not(:first-child)]:truncate",
} as const;

export type TableCellVariant = keyof typeof CELL_VARIANT;

export type TableContainerProps = ComponentProps<"section"> & {
  readonly label: string;
};

/**
 * The bordered frame a table sits in. It scrolls sideways when the table is
 * wider than the screen; the tab stop lets a keyboard reach it and scroll with
 * the arrow keys. Its focus ring is the console's (apps/web styles.css), drawn
 * here too so a host without that rule still shows where focus is.
 */
export function TableContainer({
  label,
  className,
  ...props
}: TableContainerProps): JSX.Element {
  return (
    <section
      data-slot="table-container"
      aria-label={label}
      // relative: an sr-only header cell scrolled out of view would
      // otherwise widen the page instead of the scroller.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard
      tabIndex={0}
      className={cn(
        "relative overflow-x-auto rounded-card border bg-card focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export function Table({
  className,
  ...props
}: ComponentProps<"table">): JSX.Element {
  return (
    <table
      data-slot="table"
      className={cn("w-full border-collapse text-control", className)}
      {...props}
    />
  );
}

export function TableHeader({
  className,
  ...props
}: ComponentProps<"thead">): JSX.Element {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "bg-surface-sunken [&>tr]:h-[var(--werft-row-head-min-height)]",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({
  className,
  ...props
}: ComponentProps<"tbody">): JSX.Element {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&>tr:last-child]:border-b-0", className)}
      {...props}
    />
  );
}

export type TableRowProps = ComponentProps<"tr"> & {
  /**
   * Draws the row in the inactive tone (styles.css): faint text, badges
   * without hue, buttons untouched. Say "inactive" in the row's text too.
   */
  readonly inactive?: boolean | undefined;
};

/** A table row's height is its floor, as min-height is for a block. */
export function TableRow({
  inactive = false,
  className,
  ...props
}: TableRowProps): JSX.Element {
  return (
    <tr
      data-slot="table-row"
      data-inactive={inactive || undefined}
      className={cn("h-[var(--werft-row-min-height)] border-b", className)}
      {...props}
    />
  );
}

export type TableHeadProps = ComponentProps<"th"> & {
  readonly variant?: TableCellVariant;
};

export function TableHead({
  variant = "default",
  className,
  ...props
}: TableHeadProps): JSX.Element {
  return (
    <th
      data-slot="table-head"
      data-variant={variant}
      className={cn(
        CELL_PADDING_X,
        "py-[var(--werft-row-head-padding-y)] text-left align-middle font-medium text-caption text-subtle-foreground",
        CELL_VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}

export type TableCellProps = ComponentProps<"td"> & {
  readonly variant?: TableCellVariant;
};

export function TableCell({
  variant = "default",
  className,
  ...props
}: TableCellProps): JSX.Element {
  return (
    <td
      data-slot="table-cell"
      data-variant={variant}
      className={cn(
        CELL_PADDING_X,
        "py-[var(--werft-row-padding-y)] text-left align-middle",
        CELL_VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}
