import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york Textarea. Changed from upstream as Input is: Field wiring,
 * card background, no `dark:` variants, no transition under reduced motion.
 */
export function Textarea({
  className,
  ...props
}: ComponentProps<"textarea">): JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content flex max-h-64 min-h-16 w-full rounded-control border border-input bg-card px-3 py-2 text-control transition-[color,border-color] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        "enabled:not-aria-invalid:hover:border-subtle-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        "aria-invalid:border-destructive",
        className,
      )}
      {...useFieldControl(props)}
    />
  );
}
