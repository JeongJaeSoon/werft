import type { JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * A to-do checklist, not navigation: each row is done or not on its own and
 * may carry its own action (the screen passes the button). Unlike `Stepper`
 * there is no current step and no keyboard model of its own.
 */

/** `unknown`: whether the step is done could not be read. */
export type StepsItemState = "done" | "todo" | "unknown";

export interface StepsItem {
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  /** Wins over `done` when both are given. */
  readonly state?: StepsItemState | undefined;
  /** The older two-state form: `true` is `"done"`, otherwise `"todo"`. */
  readonly done?: boolean | undefined;
  /** Shown at the row's right end, e.g. a `RowAction`. */
  readonly action?: ReactNode | undefined;
}

export interface StepsProps {
  readonly items: readonly StepsItem[];
  /** Read out after each done item; the circle's check mark is not. */
  readonly completedLabel?: string | undefined;
  /** Read out after each open item when given. */
  readonly todoLabel?: string | undefined;
  /**
   * Shown on an unknown item's description line and read out after its
   * title, in place of the circle's "?".
   */
  readonly unknownLabel?: string | undefined;
  readonly className?: string | undefined;
}

function stateOf(item: StepsItem): StepsItemState {
  return item.state ?? (item.done ? "done" : "todo");
}

export function Steps({
  items,
  completedLabel = "완료",
  todoLabel,
  unknownLabel = "확인할 수 없음",
  className,
}: StepsProps): JSX.Element {
  return (
    <ol data-slot="steps" className={cn("flex flex-col", className)}>
      {items.map((item, index) => {
        const state = stateOf(item);
        const spoken =
          state === "done"
            ? completedLabel
            : state === "unknown"
              ? unknownLabel
              : todoLabel;
        return (
          <li
            key={item.id}
            data-slot="steps-item"
            data-state={state}
            className="flex items-center gap-3 border-t py-3 break-keep first:border-t-0 first:pt-0 last:pb-0"
          >
            <span
              aria-hidden="true"
              // The pointer's name for the "?"; the reader hears the label.
              title={state === "unknown" ? unknownLabel : undefined}
              className={cn(
                "grid size-6 flex-none place-content-center rounded-full border font-medium text-xs",
                state === "done"
                  ? "border-(color:--werft-tone-success-border) bg-(color:--werft-tone-success-bg) text-(color:--werft-tone-success-fg)"
                  : state === "unknown"
                    ? "border-border-strong border-dashed text-muted-foreground"
                    : "border-border-strong text-muted-foreground",
              )}
            >
              {state === "done" ? "✓" : state === "unknown" ? "?" : index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium text-control">
                {item.title}
                {spoken ? <span className="sr-only">, {spoken}</span> : null}
              </span>
              {item.description || state === "unknown" ? (
                <span className="text-caption text-subtle-foreground leading-normal">
                  {item.description}
                  {state === "unknown" ? (
                    // Already read out after the title.
                    <span aria-hidden="true">
                      {item.description ? " · " : null}
                      {unknownLabel}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            {item.action}
          </li>
        );
      })}
    </ol>
  );
}
