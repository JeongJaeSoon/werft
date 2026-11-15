import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york Checkbox. Changed from upstream: Field wiring (put each
 * checkbox in its own horizontal Field with its FieldLabel), card
 * background, no `dark:` variants, and the box
 * drawn in `muted-foreground`: the outline is all that shows an unchecked box,
 * and `border-input` is under 3:1 against the canvas in both themes.
 * `indeterminate` fills like checked and draws a dash instead of the tick.
 */
export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>): JSX.Element {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group size-4 shrink-0 rounded-[4px] border border-muted-foreground bg-card transition-[background-color,border-color] enabled:not-aria-invalid:data-[state=unchecked]:hover:bg-hover enabled:not-aria-invalid:data-[state=unchecked]:hover:border-foreground motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        className,
      )}
      {...useFieldControl(props)}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <Check
          className="size-3.5 group-data-[state=indeterminate]:hidden"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <Minus
          className="hidden size-3.5 group-data-[state=indeterminate]:block"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
