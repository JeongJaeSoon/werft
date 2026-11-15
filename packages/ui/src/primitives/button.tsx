import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * shadcn/ui new-york Button. Changed from upstream: no `dark:` variants (the
 * tokens already switch theme, including the manual `data-theme` toggle that
 * Tailwind's `dark:` cannot see), `destructive` uses its own foreground token
 * instead of white, transitions stop under reduced motion, console v35
 * sizing (no shadow, 32px or 28px tall and no `lg`), and mockup v4's focus
 * outline, hovers, outlined `danger` and 28px `icon-sm`. No `outline-none`:
 * Tailwind 4 carries its `none` into `outline-2`. `aria-disabled` fades like
 * `disabled` but keeps pointer events, so a busy button keeps its focus.
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium text-control transition-[background-color,border-color] duration-[var(--werft-motion-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-invalid:border-destructive motion-reduce:transition-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive:
          "bg-destructive-solid text-destructive-foreground hover:brightness-92",
        outline:
          "border border-border bg-card hover:bg-hover hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "border border-transparent text-muted-foreground hover:bg-hover hover:text-foreground",
        link: "text-link underline-offset-4 hover:underline",
        danger:
          "border border-[var(--werft-tone-danger-border)] bg-card text-destructive hover:bg-[var(--werft-tone-danger-bg)]",
      },
      size: {
        default: "h-[var(--werft-control-height)] px-3",
        sm: "h-[var(--werft-control-height-sm)] px-2",
        icon: "size-[var(--werft-control-height)]",
        "icon-sm": "size-[var(--werft-control-height-sm)]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the single child (a link) with the button's look. */
    readonly asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps): JSX.Element {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      data-size={size ?? undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
      // A `…Trigger asChild` overrides data-slot; this mark survives it, so
      // an inactive table row can still find its actions (styles.css).
      data-werft-button=""
    />
  );
}
