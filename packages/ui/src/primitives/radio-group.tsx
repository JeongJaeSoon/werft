import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york RadioGroup. Changed from upstream: an inline dot instead
 * of lucide-react, card background, no `dark:` variants, and the ring drawn
 * in `muted-foreground`: the outline is all that shows an unchecked radio,
 * and `border-input` is under 3:1 against the canvas in both themes. Focus
 * and the unselected hover are Checkbox's. Name the
 * group from a visible heading (`aria-labelledby` on a FieldLegend's id);
 * each item takes the id of the horizontal Field it sits in, so its
 * FieldLabel needs no htmlFor.
 */
export function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>): JSX.Element {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>): JSX.Element {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-4 shrink-0 rounded-full border border-muted-foreground bg-card text-primary transition-[background-color,border-color] enabled:data-[state=unchecked]:hover:bg-hover enabled:not-aria-invalid:data-[state=unchecked]:hover:border-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive motion-reduce:transition-none",
        className,
      )}
      {...useFieldControl(props)}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <svg
          className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-primary"
          viewBox="0 0 8 8"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="4" cy="4" r="4" />
        </svg>
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}
