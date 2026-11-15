import {
  type ComponentProps,
  createContext,
  type JSX,
  type ReactNode,
  useContext,
} from "react";

import { cn } from "../foundations/cn.ts";
import { ItemCount, type ItemCountTone } from "./item-count.tsx";

/*
 * One choice out of a few, such as a list filter or a sort order. The items
 * are toggle buttons in a named group, each a Tab stop of its own, not a
 * tablist: picking one filters what is already on screen instead of showing
 * another panel. The track is a borderless grey pill as tall as a control
 * (the search field beside it), with the picked item raised on it as a white
 * thumb. Too many items wrap inside the track rather than scroll, so no
 * scroll box clips a focus outline.
 */

// The default TabsList draws the same track and thumb from the same tokens
// (segment-track, segment-thumb, shadow-segment-thumb).
const segmentTrackClassName =
  // w-fit: as a flex item in a column, stretch would carry the track past
  // the last item to the column's edge. 3px padding around 26px items makes
  // the 32px control height.
  "inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-card bg-segment-track p-[3px]";
const segmentItemHeightClassName = "h-[calc(var(--werft-control-height)-6px)]";

type SegmentedControlContextValue = {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
};

const SegmentedControlContext =
  createContext<SegmentedControlContextValue | null>(null);

export type SegmentedControlProps = Omit<
  ComponentProps<"div">,
  "aria-label" | "role" | "defaultValue" | "onChange"
> & {
  /** Names the choice for screen readers, e.g. "세션 상태". */
  readonly "aria-label": string;
  /** The `value` of the pressed item. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
};

export function SegmentedControl({
  className,
  value,
  onValueChange,
  ...props
}: SegmentedControlProps): JSX.Element {
  return (
    <SegmentedControlContext.Provider value={{ value, onValueChange }}>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would need a visible legend; v4 names the group with aria-label. */}
      <div
        role="group"
        data-slot="segmented-control"
        className={cn(segmentTrackClassName, className)}
        {...props}
      />
    </SegmentedControlContext.Provider>
  );
}

export type SegmentedControlItemProps = Omit<
  ComponentProps<"button">,
  "type" | "value" | "aria-pressed"
> & {
  readonly value: string;
  /** Drawn after the label, 0 included; omit for no count. */
  readonly count?: number | undefined;
  /**
   * Screen-reader text for the count, e.g. "3개 실행 중". Without it the
   * number itself is read after the label.
   */
  readonly countLabel?: ReactNode | undefined;
  /**
   * `attention` or `danger` draws a count above 0 as a toned badge, for a
   * state someone has to act on (an unanswered question, a failure).
   */
  readonly countTone?: ItemCountTone | undefined;
};

export function SegmentedControlItem({
  className,
  value,
  count,
  countLabel,
  countTone,
  onClick,
  children,
  ...props
}: SegmentedControlItemProps): JSX.Element {
  const group = useContext(SegmentedControlContext);
  if (group === null) {
    throw new Error("SegmentedControlItem must be inside a SegmentedControl");
  }
  return (
    <button
      type="button"
      data-slot="segmented-control-item"
      aria-pressed={group.value === value}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) group.onValueChange(value);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-control border-0 bg-transparent px-3 font-medium text-control text-subtle-foreground transition-[color,background-color,box-shadow] hover:text-foreground motion-reduce:transition-none",
        segmentItemHeightClassName,
        "aria-pressed:bg-segment-thumb aria-pressed:text-foreground aria-pressed:shadow-segment-thumb",
        // A quiet count on the thumb reads one step darker than off it.
        "aria-pressed:[&_[data-slot=item-count]:not([data-tone])]:text-muted-foreground",
        "focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <ItemCount count={count} countLabel={countLabel} tone={countTone} />
    </button>
  );
}
