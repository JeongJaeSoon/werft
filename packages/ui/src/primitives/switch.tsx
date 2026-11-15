import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

export type SwitchProps = ComponentProps<typeof SwitchPrimitive.Root>;

/*
 * shadcn/ui new-york Switch. Changed from upstream: Field wiring (a FieldLabel
 * names it, a FieldDescription describes it), a 20×36 track so the thumb sits
 * on the 4px grid, the console's focus outline instead of a ring, the on
 * track in `control-checked` and the off track in `control-unchecked` (both 3:1 against
 * the card), a card thumb, no thumb shadow and no `dark:` variants. The state
 * is `aria-checked`; any "on"/"off" words belong to the caller, outside.
 * `disabled` keeps each state's colour, faded to 0.5 like every control.
 * `aria-disabled` fades the same but keeps focus and only refuses the
 * toggle, with a spinner in the thumb, for a switch that is busy saving
 * rather than withheld.
 */
export function Switch({
  className,
  onClick,
  ...props
}: SwitchProps): JSX.Element {
  const busy =
    props["aria-disabled"] === true || props["aria-disabled"] === "true";
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-[background-color] duration-[var(--werft-motion-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-disabled:cursor-progress aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-control-checked data-[state=unchecked]:bg-control-unchecked data-[state=checked]:enabled:not-aria-disabled:hover:bg-control-checked/80 data-[state=unchecked]:enabled:not-aria-disabled:hover:bg-subtle-foreground motion-reduce:transition-none",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        // Radix skips its toggle when the click's default is prevented.
        if (busy) event.preventDefault();
      }}
      {...useFieldControl(props)}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="group pointer-events-none flex size-4 items-center justify-center rounded-full bg-card transition-transform duration-[var(--werft-motion-fast)] data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 motion-reduce:transition-none"
      >
        {busy && (
          <span
            data-slot="switch-spinner"
            aria-hidden="true"
            className="size-2.5 animate-spin rounded-full border-[1.5px] border-input border-r-transparent group-data-[state=checked]:border-control-checked group-data-[state=checked]:border-r-transparent motion-reduce:animate-none"
          />
        )}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}
