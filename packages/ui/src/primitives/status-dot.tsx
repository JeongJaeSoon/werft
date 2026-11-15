import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type StatusDotStatus = "wait" | "run" | "idle" | "done" | "failed";

const STATUS_DOT: Record<StatusDotStatus, string> = {
  wait: "bg-(color:--werft-color-status-dot-wait)",
  // A turning ring in the dot's own 8px box, so a status change does not
  // move the text beside it; with reduced motion, a still dot like the others.
  run: "animate-spin border-[1.5px] border-(color:--werft-color-status-dot-run) border-r-transparent motion-reduce:animate-none motion-reduce:border-r-(color:--werft-color-status-dot-run) motion-reduce:bg-(color:--werft-color-status-dot-run)",
  idle: "bg-(color:--werft-color-status-dot-idle)",
  done: "bg-(color:--werft-color-status-dot-done)",
  failed: "bg-(color:--werft-color-status-dot-failed)",
};

export type StatusDotProps = Omit<ComponentProps<"span">, "children"> & {
  readonly status: StatusDotStatus;
};

/**
 * A status said as a coloured dot and its name, not a badge: "● 활성".
 */
export function StatusText({
  status,
  className,
  children,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  readonly status: StatusDotStatus;
  readonly children: string;
}): JSX.Element {
  return (
    <span
      data-slot="status-text"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap",
        className,
      )}
      {...props}
    >
      <StatusDot status={status} />
      {children}
    </span>
  );
}

/**
 * Mockup v4's `.dot`: colour only, hidden from screen readers. The caller
 * puts the status's name beside it, as text or `sr-only`.
 */
export function StatusDot({
  status,
  className,
  style,
  ...props
}: StatusDotProps): JSX.Element {
  return (
    <span
      data-slot="status-dot"
      data-status={status}
      aria-hidden="true"
      className={cn(
        "size-2 flex-none rounded-full",
        STATUS_DOT[status],
        className,
      )}
      // Tailwind's spin turns once a second; v4 turns in 0.9s.
      style={status === "run" ? { animationDuration: "0.9s", ...style } : style}
      {...props}
    />
  );
}
