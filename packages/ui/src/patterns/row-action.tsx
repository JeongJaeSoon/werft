import type { JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { Button, type ButtonProps } from "../primitives/button.tsx";

export type RowActionProps = Omit<ButtonProps, "size" | "variant"> & {
  /**
   * `outline` for an ordinary action, `danger` for one that deletes, revokes,
   * disconnects or removes access, `default` for the one next step the row
   * asks for. Dropping an item from an unsaved draft and declining a request
   * are not `danger`. `destructive`, filled red, is the danger zone's own:
   * a list or table row keeps the quieter `danger`.
   */
  readonly variant?:
    | "outline"
    | "danger"
    | "destructive"
    | "default"
    | undefined;
  /** `icon-sm` for an icon-only button, named by `aria-label`. */
  readonly size?: "sm" | "icon-sm" | undefined;
};

/**
 * The button at the end of a setting row, a danger zone row or a list or
 * table row. The row aligns right ends; the width follows the label, down to
 * --werft-row-action-button-min-width. Page header, in-field, form and dialog
 * buttons are not row actions.
 */
export function RowAction({
  variant = "outline",
  size = "sm",
  type,
  asChild,
  className,
  ...props
}: RowActionProps): JSX.Element {
  return (
    <Button
      asChild={asChild === true}
      type={asChild ? type : (type ?? "button")}
      variant={variant}
      size={size}
      className={cn(
        size === "sm" && "min-w-[var(--werft-row-action-button-min-width)]",
        className,
      )}
      {...props}
    />
  );
}
