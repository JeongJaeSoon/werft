import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { StatusDot, type StatusDotStatus } from "./status-dot.tsx";

/*
 * shadcn/ui new-york Badge, without `dark:` variants (see button.tsx). A badge
 * names a category; a status with meaning (running, paused…) is StatusLabel.
 * The colour variants are console v35's badge tones, plus violet for the
 * owner role and teal for the Codex engine.
 */
export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap h-5 rounded-full border px-2 font-medium text-caption transition-[color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        gray: "border-(color:--werft-tone-neutral-border) bg-(color:--werft-tone-neutral-bg) text-(color:--werft-tone-neutral-fg)",
        blue: "border-(color:--werft-tone-progress-border) bg-(color:--werft-tone-progress-bg) text-(color:--werft-tone-progress-fg)",
        green:
          "border-(color:--werft-tone-success-border) bg-(color:--werft-tone-success-bg) text-(color:--werft-tone-success-fg)",
        amber:
          "border-(color:--werft-tone-caution-border) bg-(color:--werft-tone-caution-bg) text-(color:--werft-tone-caution-fg)",
        teal: "border-(color:--werft-tone-teal-border) bg-(color:--werft-tone-teal-bg) text-(color:--werft-tone-teal-fg)",
        violet:
          "border-(color:--werft-tone-violet-border) bg-(color:--werft-tone-violet-bg) text-(color:--werft-tone-violet-fg)",
        red: "border-(color:--werft-tone-danger-border) bg-(color:--werft-tone-danger-bg) text-(color:--werft-tone-danger-fg)",
        // An identifier such as a model name; grey like `gray` (mockup v4).
        mono: "border-(color:--werft-tone-neutral-border) bg-(color:--werft-tone-neutral-bg) font-mono font-normal text-(color:--werft-tone-neutral-fg)",
      },
    },
    defaultVariants: { variant: "gray" },
  },
);

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    readonly asChild?: boolean;
    /**
     * A status dot before the label (mockup v4's session head). Not drawn
     * with `asChild`, whose one child is the badge.
     */
    readonly dot?: StatusDotStatus | undefined;
  };

export function Badge({
  className,
  variant,
  asChild = false,
  dot,
  children,
  ...props
}: BadgeProps): JSX.Element {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot && !asChild ? (
        <>
          <StatusDot status={dot} />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}
