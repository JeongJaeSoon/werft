import type { TurnEventPresentation } from "@werft-ai/contracts";
import { cn } from "@werft-ai/ui";
import type { JSX } from "react";

import { type FormatTurnMessage, turnPreviewText } from "./turn-text.ts";

export interface StageIndicatorProps {
  /**
   * presentTurnEvent's reading of the event that says where the turn is, or
   * null before there is one. Which event that is belongs to the screen: it
   * is announced as it changes, so feeding it every event floods a screen
   * reader.
   */
  readonly presentation: TurnEventPresentation | null;
  readonly formatMessage: FormatTurnMessage;
  /** Shown while `presentation` is null. */
  readonly emptyLabel: string;
  /** The turn is still going. */
  readonly busy?: boolean | undefined;
  readonly className?: string | undefined;
}

export function StageIndicator({
  presentation,
  formatMessage,
  emptyLabel,
  busy = false,
  className,
}: StageIndicatorProps): JSX.Element {
  const summary = presentation
    ? turnPreviewText(presentation, formatMessage)
    : "";
  const error = presentation?.error === true;
  return (
    <output
      data-slot="stage-indicator"
      data-busy={busy || undefined}
      data-error={error || undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-card border bg-card px-3 py-2 text-sm",
        error && "border-destructive",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full bg-muted-foreground",
          busy && "bg-primary motion-safe:animate-pulse",
          error && "bg-destructive",
        )}
      />
      {presentation ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className={cn("font-medium", error && "text-destructive")}>
            {formatMessage(presentation.label)}
          </span>
          {summary ? (
            <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
              {summary}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="text-muted-foreground">{emptyLabel}</span>
      )}
    </output>
  );
}
