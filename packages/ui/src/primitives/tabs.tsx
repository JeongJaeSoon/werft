import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type JSX,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";
import { ItemCount } from "./segmented-control.tsx";

/*
 * shadcn/ui new-york Tabs. Changed from upstream: no `dark:` variants, the
 * idle trigger uses `text-muted-foreground` instead of `text-foreground/60`,
 * the active trigger sits on the card surface with an input border (canvas on
 * sunken barely differs, worst in dark) without a shadow, and transitions,
 * the line variant's underline included, stop under reduced motion. The line
 * variant is console v4 `.tab`: 36px tabs 4px apart with 8px sides, and the
 * underline inset to the label, 1px below the list so it covers the bottom
 * rule. The rule itself (v4 `.tabs` border-bottom) is still the caller's,
 * drawn on a wrapper that also holds controls beside the tabs.
 */
export function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: ComponentProps<typeof TabsPrimitive.Root>): JSX.Element {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

export const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-card p-[3px] text-muted-foreground data-[variant=line]:rounded-none group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-auto",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function TabsList({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>): JSX.Element {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

/**
 * The underline tab's size and bar, the one definition. Both read the
 * `group/tabs` (orientation) and `group/tabs-list` (variant) data attributes
 * of their ancestors, so LinkTabs shares it by carrying the same attributes.
 * Its colours, transitions and focus ring stay with each component.
 */
export const underlineTabClassName =
  "group-data-[variant=line]/tabs-list:h-9 group-data-[variant=line]/tabs-list:px-2 after:absolute after:bg-foreground after:opacity-0 group-data-[orientation=horizontal]/tabs:after:inset-x-2 group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=horizontal]/tabs:after:rounded-[1px]";

const tabTriggerClassName = cn(
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-control border border-transparent px-2 py-1 font-medium text-control text-muted-foreground transition-all hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
  "group-data-[variant=line]/tabs-list:flex-none group-data-[variant=line]/tabs-list:border-0 group-data-[variant=line]/tabs-list:py-0",
  "data-[state=active]:bg-card data-[state=active]:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:border-input",
  underlineTabClassName,
  "after:transition-opacity motion-reduce:after:transition-none group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
);

export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger> & {
  /** Drawn after the label, 0 included; omit for no count. */
  readonly count?: number | undefined;
  /**
   * Screen-reader text for the count, e.g. "3개". Without it the number
   * itself is read after the label.
   */
  readonly countLabel?: ReactNode | undefined;
};

export function TabsTrigger({
  className,
  count,
  countLabel,
  children,
  ...props
}: TabsTriggerProps): JSX.Element {
  const number =
    count === undefined ? null : (
      <ItemCount count={count} countLabel={countLabel} />
    );
  // Under asChild the Slot takes exactly one element, so the count goes
  // inside it, after its own children.
  const content =
    number === null ? (
      children
    ) : props.asChild && isValidElement<{ children?: ReactNode }>(children) ? (
      cloneElement(children, {
        children: (
          <>
            {children.props.children}
            {number}
          </>
        ),
      })
    ) : (
      <>
        {children}
        {number}
      </>
    );
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(tabTriggerClassName, className)}
      {...props}
    >
      {content}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>): JSX.Element {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}
