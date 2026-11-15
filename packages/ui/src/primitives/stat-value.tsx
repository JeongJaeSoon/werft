import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type StatValueProps = ComponentProps<"span"> & {
  /** Render the single child (a `<p>`, a `<dd>`) as the figure. */
  readonly asChild?: boolean;
};

/*
 * A headline figure: Geist Mono at the number size, medium, with tabular
 * digits so a changing count does not shift its row. Only the figure; a unit
 * or the meta line under it stays in the sans face.
 */
export function StatValue({
  className,
  asChild = false,
  ...props
}: StatValueProps): JSX.Element {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="stat-value"
      className={cn(
        "font-medium font-mono text-number tracking-normal tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
