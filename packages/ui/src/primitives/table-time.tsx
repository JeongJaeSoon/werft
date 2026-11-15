import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { formatRelativeTime } from "../foundations/format-relative-time.ts";
import {
  formatTableDateTime,
  type TimestampLocale,
} from "../foundations/format-timestamp.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

export interface TableTimeProps
  extends Omit<ComponentProps<"time">, "children" | "dateTime"> {
  /** An ISO string from the API. */
  readonly value: string;
  readonly locale?: TimestampLocale;
  /** The instant the hover's "N분 전" counts from. */
  readonly now?: number | Date;
}

/**
 * A time in a table cell: the absolute "11월 11일 오전 09:42" in a focusable
 * <time>, with "N분 전" in a Tooltip on hover and focus. Every table shows
 * its times this way, so no table mixes "11/13" with "어제 21:11".
 */
export function TableTime({
  value,
  locale = "ko",
  now,
  className,
  ...props
}: TableTimeProps): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild={true}>
        <time
          data-slot="table-time"
          dateTime={value}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the relative time only through focus
          tabIndex={0}
          className={cn(
            "whitespace-nowrap rounded-sm tabular-nums focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2",
            className,
          )}
          {...props}
        >
          {formatTableDateTime(value, locale)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatRelativeTime(value, locale, now)}</TooltipContent>
    </Tooltip>
  );
}
