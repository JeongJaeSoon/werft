import { ChevronDown } from "lucide-react";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york NativeSelect: a styled <select>, chosen over the Radix
 * Select item. A native select submits with its form without a hidden mirror
 * input, and phones open their own picker, which screen readers and large
 * text already handle. Changed from upstream: Field wiring, card background,
 * no `dark:` variants.
 */
export function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<ComponentProps<"select">, "size"> & {
  readonly size?: "sm" | "default" | undefined;
}): JSX.Element {
  return (
    <div
      className="group/native-select relative w-fit max-w-full has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "h-[var(--werft-control-height)] w-full min-w-0 appearance-none rounded-control border border-input bg-card px-3 py-0 pr-10 text-control transition-[color,border-color] disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-[var(--werft-control-height-sm)] data-[size=sm]:text-caption motion-reduce:transition-none",
          "enabled:not-aria-invalid:hover:border-subtle-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          "aria-invalid:border-destructive",
          className,
        )}
        {...useFieldControl(props)}
      />
      <ChevronDown
        data-slot="native-select-icon"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 select-none text-subtle-foreground"
        strokeWidth={1.5}
        aria-hidden="true"
      />
    </div>
  );
}

export function NativeSelectOption({
  className,
  ...props
}: ComponentProps<"option">): JSX.Element {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export function NativeSelectOptGroup({
  className,
  ...props
}: ComponentProps<"optgroup">): JSX.Element {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}
