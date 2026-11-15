import type { ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

/**
 * What a count asks of the reader. `attention` (someone has to answer) and
 * `danger` (something failed) turn a count above 0 into a toned badge, in the
 * status dot's colours; at 0, and with no tone, it stays a quiet number.
 */
export type ItemCountTone = "attention" | "danger";

const BADGE: Record<ItemCountTone, string> = {
  attention:
    "border-(color:--werft-tone-attention-border) bg-(color:--werft-tone-attention-bg) text-(color:--werft-tone-attention-fg)",
  danger:
    "border-(color:--werft-tone-danger-border) bg-(color:--werft-tone-danger-bg) text-(color:--werft-tone-danger-fg)",
};

export interface ItemCountProps {
  readonly count: number | undefined;
  readonly countLabel: ReactNode | undefined;
  readonly tone?: ItemCountTone | undefined;
}

/**
 * The count after a segment, tab or route tab label, 0 included, so an item
 * keeps its width while the numbers change. The space keeps the label and
 * the number apart in the accessible name; flex drops it from the layout,
 * and the screen-reader text is out of flow, so the gap before the number is
 * the item's own.
 */
export function ItemCount({
  count,
  countLabel,
  tone,
}: ItemCountProps): ReactNode {
  if (count === undefined) return null;
  const hasLabel = countLabel !== undefined && countLabel !== null;
  const badge = tone !== undefined && count > 0;
  return (
    <>
      {" "}
      <span
        data-slot="item-count"
        data-tone={badge ? tone : undefined}
        aria-hidden={hasLabel ? "true" : undefined}
        className={cn(
          "tabular-nums",
          badge
            ? cn(
                // 14px line + 1px edge each side: a 16px pill that fits the
                // 26px item without moving the label.
                "min-w-4 rounded-full border px-1.5 text-center font-medium text-2xs leading-[14px]",
                BADGE[tone],
              )
            : "text-caption text-subtle-foreground",
        )}
      >
        {count}
      </span>
      {hasLabel ? <span className="sr-only">{countLabel}</span> : null}
    </>
  );
}
