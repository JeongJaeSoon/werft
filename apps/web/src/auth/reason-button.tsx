import { DisabledReason } from "@werft-ai/ui";
import type { ButtonHTMLAttributes } from "react";

export interface ReasonButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Why the action is unavailable; the button is inert while it is set. */
  readonly reason: string | undefined;
}

/**
 * The shape every withheld action takes: still on the page at its own width,
 * focusable, and saying why on hover, focus or a tap (DisabledReason's
 * control mode, which keeps the same button as the reason comes and goes).
 */
export function ReasonButton({
  reason,
  className = "werft-button",
  type = "button",
  children,
  ...rest
}: ReasonButtonProps) {
  return (
    <DisabledReason mode="control" reason={reason} {...rest}>
      <button type={type} className={className}>
        {children}
      </button>
    </DisabledReason>
  );
}
