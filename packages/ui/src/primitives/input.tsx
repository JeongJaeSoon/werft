import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york Input. Changed from upstream: inside a Field it takes the
 * Field's id and ARIA (field.tsx), the background is the card surface instead
 * of transparent so it reads on the canvas, there are no `dark:` variants, and
 * transitions stop under reduced motion.
 */
export function Input({
  className,
  type,
  ...props
}: ComponentProps<"input">): JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[var(--werft-control-height)] w-full min-w-0 rounded-control border border-input bg-card px-3 py-0 text-control transition-[color,border-color] selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-[var(--werft-control-height-sm)] file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-body placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ",
        "enabled:not-aria-invalid:hover:border-subtle-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        "aria-invalid:border-destructive",
        className,
      )}
      {...useFieldControl(props)}
    />
  );
}
