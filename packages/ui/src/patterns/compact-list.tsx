import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

export interface CompactRowProps extends ComponentProps<"li"> {
  /** At the row's right end, such as "+8 −3" or a download button. */
  readonly trailing?: ReactNode;
}

/**
 * One line of a narrow list, such as a session's changed files: its text
 * truncates before `trailing`, which keeps its width.
 */
export function CompactRow({
  trailing,
  className,
  children,
  ...props
}: CompactRowProps): JSX.Element {
  return (
    <li
      data-slot="compact-row"
      className={cn(
        "flex min-h-8 min-w-0 items-center gap-3 text-control",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
      {trailing ? (
        <span className="flex flex-none items-center gap-2 tabular-nums">
          {trailing}
        </span>
      ) : null}
    </li>
  );
}

/** The list `CompactRow`s sit in, without frame or lines. */
export function CompactList({
  className,
  ...props
}: ComponentProps<"ul">): JSX.Element {
  return (
    <ul
      data-slot="compact-list"
      className={cn("m-0 flex list-none flex-col gap-1 p-0", className)}
      {...props}
    />
  );
}

/** Lines added and removed, green then red: "+8 −3". */
export function DiffStat({
  additions,
  deletions,
  className,
}: {
  readonly additions: number;
  readonly deletions: number;
  readonly className?: string | undefined;
}): JSX.Element {
  return (
    <span
      data-slot="diff-stat"
      className={cn("inline-flex gap-2 font-mono text-caption", className)}
    >
      <span className="text-[var(--werft-tone-success-fg)]">+{additions}</span>
      <span className="text-[var(--werft-tone-danger-fg)]">−{deletions}</span>
    </span>
  );
}
