import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type JSX,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";
import { StatusDot, type StatusDotStatus } from "../primitives/status-dot.tsx";

/*
 * One line above a list that sums it up: a few figures, each a name and a
 * value. A figure that stands for one of the list's filters is a button the
 * screen presses that filter with, or a link the screen gives to a list that
 * applies it, so the line is also a way into the list. The rest are text.
 */

export type ListSummaryProps = Omit<ComponentProps<"ul">, "aria-label"> & {
  /** Names the line for screen readers, e.g. "세션 요약". */
  readonly "aria-label": string;
};

export function ListSummary({
  className,
  children,
  ...props
}: ListSummaryProps): JSX.Element {
  return (
    <ul
      data-slot="list-summary"
      className={cn(
        // The figures' own padding lines the first name up with the list.
        "-mx-2 my-0 flex min-w-0 list-none flex-wrap items-center gap-1 p-0",
        className,
      )}
      {...props}
    >
      {children}
    </ul>
  );
}

const FIGURE =
  "inline-flex h-[var(--werft-control-height-sm)] items-center gap-2 whitespace-nowrap rounded-control px-2 text-control";

const PRESSABLE = cn(
  FIGURE,
  "border-0 bg-transparent text-foreground no-underline transition-[background-color] duration-[var(--werft-motion-fast)] hover:bg-hover motion-reduce:transition-none",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
  "aria-pressed:bg-active",
);

// A router link's children may be a function of its state.
type ChildProps = { readonly className?: string; readonly children?: unknown };

export type ListSummaryItemProps = {
  readonly label: string;
  /** The figure, formatted by the caller. */
  readonly value: ReactNode;
  /** A dot before the name, for a figure that counts one status. */
  readonly status?: StatusDotStatus | undefined;
  /** Makes the figure a button; with `pressed`, it shows the filter is on. */
  readonly onPress?: (() => void) | undefined;
  readonly pressed?: boolean | undefined;
  /**
   * A link (a router link) to render the figure as; its own children are
   * replaced by the figure.
   */
  readonly link?: ReactElement<ChildProps> | undefined;
  readonly className?: string | undefined;
};

export function ListSummaryItem({
  label,
  value,
  status,
  onPress,
  pressed,
  link,
  className,
}: ListSummaryItemProps): JSX.Element {
  // The space keeps name and value apart in the accessible name.
  const figure = (
    <>
      {status ? <StatusDot status={status} /> : null}
      <span className="text-muted-foreground">{label}</span>{" "}
      <span
        data-slot="list-summary-value"
        className="font-medium text-foreground tabular-nums"
      >
        {value}
      </span>
    </>
  );
  let body: ReactNode;
  if (link && isValidElement<ChildProps>(link)) {
    body = cloneElement(link, {
      className: cn(PRESSABLE, link.props.className, className),
      children: figure,
    });
  } else if (onPress) {
    body = (
      <button
        type="button"
        aria-pressed={pressed ?? false}
        onClick={onPress}
        className={cn(PRESSABLE, "cursor-pointer", className)}
      >
        {figure}
      </button>
    );
  } else {
    body = <span className={cn(FIGURE, className)}>{figure}</span>;
  }
  return (
    <li data-slot="list-summary-item" className="flex min-w-0">
      {body}
    </li>
  );
}
