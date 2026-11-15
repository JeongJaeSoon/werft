import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type MenuItemProps = Omit<ComponentProps<"button">, "type"> & {
  /** Render the single child (a link) as the item. */
  readonly asChild?: boolean;
  /** `danger` for an item that removes or revokes. */
  readonly tone?: "default" | "danger" | undefined;
};

/*
 * One choice in a popover menu: a 32px row with the control's corner and
 * type. The pointer and the keyboard land on the same hover surface; the
 * keyboard also gets the focus outline drawn inside the row, so it never
 * spills past the menu's edge. A withheld item (disabled, or aria-disabled
 * so it keeps its place in the arrow order) fades to 0.5 and does not hover.
 * The menu owns its role, keys and closing; the item is only the row.
 */
export function MenuItem({
  className,
  asChild = false,
  tone = "default",
  ...props
}: MenuItemProps): JSX.Element {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="menu-item"
      data-tone={tone}
      {...(asChild ? {} : { type: "button" as const })}
      className={cn(
        "flex h-[var(--werft-control-height)] w-full items-center gap-2 rounded-control border-0 bg-transparent px-2 text-start text-control text-foreground no-underline transition-[background-color] not-disabled:not-aria-disabled:hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring disabled:opacity-50 aria-disabled:opacity-50 motion-reduce:transition-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        tone === "danger" && "text-destructive",
        className,
      )}
      {...props}
    />
  );
}
