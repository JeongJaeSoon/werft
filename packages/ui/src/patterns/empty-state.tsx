import type { JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string | undefined;
  /** Primary way out of the empty screen. */
  readonly action?: ReactNode | undefined;
  readonly secondaryAction?: ReactNode | undefined;
  /** A 16px icon, drawn in a quiet 40px box above the title. */
  readonly icon?: ReactNode | undefined;
  /** `sm` sits inside a card or a list, with less room around it. */
  readonly size?: "default" | "sm" | undefined;
  /** Draws the card frame, for an empty list that stands in a card's or a framed table's place. */
  readonly framed?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * Nothing here yet — calm, not alarming. `ErrorState` is the one that raises its
 * voice; the two must never look alike (§5 "보고할 것이 없으면 조용하다").
 */
export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  icon,
  size = "default",
  framed = false,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        "werft-state",
        "werft-state--empty",
        framed && "rounded-card border bg-card",
        className,
      )}
      data-size={size}
      data-framed={framed || undefined}
    >
      {icon ? (
        <span className="werft-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="werft-state__title">{title}</p>
      {description ? (
        <p className="werft-state__description">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="werft-state__actions">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
