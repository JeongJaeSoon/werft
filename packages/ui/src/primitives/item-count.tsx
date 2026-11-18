import { CircleX, type LucideIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

/**
 * What a count asks of the reader. `attention` (someone has to answer) and
 * `danger` (something failed) turn a count above 0 into a toned badge, in the
 * status dot's colours and with the tone's icon, so the two differ without
 * colour; at 0, and with no tone, it stays a quiet number.
 */
export type ItemCountTone = "attention" | "danger";

// The icons the timeline's error and Alert's amber already mean.
const ICON: Record<ItemCountTone, LucideIcon> = {
  attention: TriangleAlert,
  danger: CircleX,
};

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
  const hasLabel = countLabel !== undefined && countLabel !== null;
  // A tone known before its count draws the icon alone, and only with the
  // label to say it: the icon is hidden from screen readers.
  if (count === undefined && (tone === undefined || !hasLabel)) return null;
  const badge = tone !== undefined && (count === undefined || count > 0);
  const Icon = badge ? ICON[tone] : undefined;
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
                // 26px item without moving the label. h-4 keeps the icon
                // alone at that height, so a count arriving keeps the height.
                "inline-flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full border font-medium text-2xs leading-[14px]",
                count === undefined ? "px-px" : "px-1.5",
                BADGE[tone],
              )
            : "text-caption text-subtle-foreground",
        )}
      >
        {Icon ? <Icon aria-hidden="true" className="size-3 shrink-0" /> : null}
        {count}
      </span>
      {hasLabel ? <span className="sr-only">{countLabel}</span> : null}
    </>
  );
}
