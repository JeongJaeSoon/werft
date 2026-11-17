import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import {
  formatExactTime,
  formatRelativeTime,
} from "../foundations/format-relative-time.ts";
import type { TimestampLocale } from "../foundations/format-timestamp.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

export interface RelativeTimeProps
  extends Omit<ComponentProps<"time">, "children" | "dateTime"> {
  /** An ISO string from the API, or a Date. */
  readonly value: string | Date;
  readonly locale?: TimestampLocale;
  /** The instant "N분 전" counts from; nothing re-renders as time passes. */
  readonly now?: number | Date;
}

/**
 * A GridTable track for a column of RelativeTime and nothing wider: it fits
 * the longest phrase each locale writes ("2025/10/20" 74.4px, "Tomorrow
 * 23:59" 97.3px in Geist at the 13px body size), unwrapped. Every row of a
 * GridTable is a grid of its own, so a column cannot size itself to its
 * content; this width stands in for it.
 */
export const RELATIVE_TIME_TRACK: Readonly<Record<TimestampLocale, string>> = {
  ko: "78px",
  ja: "78px",
  en: "104px",
};

/**
 * "N분 전" in a focusable <time>, with the exact instant in a Tooltip. Font
 * size, colour and alignment come from the caller.
 */
export function RelativeTime({
  value,
  locale = "ko",
  now,
  className,
  ...props
}: RelativeTimeProps): JSX.Element {
  const dateTime =
    typeof value === "string"
      ? value
      : Number.isNaN(value.getTime())
        ? undefined
        : value.toISOString();
  return (
    <Tooltip>
      <TooltipTrigger asChild={true}>
        <time
          dateTime={dateTime}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the exact time only through focus
          tabIndex={0}
          className={cn(
            "rounded-sm focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
            className,
          )}
          {...props}
        >
          {formatRelativeTime(value, locale, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatExactTime(value, locale)}</TooltipContent>
    </Tooltip>
  );
}
