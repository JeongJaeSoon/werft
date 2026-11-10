import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type JSX,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Link } from "../primitives/link.tsx";
import { ItemCount } from "../primitives/segmented-control.tsx";
import { tabTriggerClassName } from "../primitives/tabs.tsx";

/*
 * Route tabs: each tab is an address, so they are links in a `nav`, the one
 * the screen is on marked `aria-current="page"`. Panels switched inside one
 * screen are Tabs (role=tab) instead. The look is Tabs' line variant, console
 * v4 `.tabs`/`.tab`.
 */

export type LinkTabsProps = Omit<ComponentProps<"nav">, "aria-label"> & {
  /** Names the tabs for screen readers, e.g. "API 키 종류". */
  readonly "aria-label": string;
};

/**
 * Too many tabs scroll sideways inside the nav instead of wrapping. 4px of
 * room on every side keeps a focused tab's 2px outline at 2px offset out of
 * the scroll clip: padding given back by margin above, below and on the left,
 * and the list's own padding on the right, so the nav never grows past its
 * parent's right edge.
 */
export function LinkTabs({
  className,
  children,
  ...props
}: LinkTabsProps): JSX.Element {
  return (
    <nav
      data-slot="link-tabs"
      data-orientation="horizontal"
      className={cn(
        "group/tabs -my-1 -ml-1 overflow-x-auto py-1 pl-1",
        className,
      )}
      {...props}
    >
      <ul
        data-variant="line"
        className="group/tabs-list m-0 flex w-max min-w-full list-none gap-1 border-border border-b py-0 pr-1 pl-0"
      >
        {children}
      </ul>
    </nav>
  );
}

// A router link's children may be a function of its state.
type ChildProps = { readonly children?: unknown };

export type LinkTabProps = ComponentProps<"a"> & {
  /**
   * The tab of the screen being shown; the caller matches the route. A router
   * link sets its own `aria-current` when it counts as active (TanStack does
   * for a parent path too), so give such a link exact matching.
   */
  readonly current?: boolean | undefined;
  /** Drawn after the label, 0 included; omit for no count. */
  readonly count?: number | undefined;
  /**
   * Screen-reader text for the count, e.g. "3개 실행 중". Without it the
   * number itself is read after the label.
   */
  readonly countLabel?: ReactNode | undefined;
  /** Render the single child (a router link) as the tab. */
  readonly asChild?: boolean | undefined;
};

function append(children: unknown, extra: ReactNode): unknown {
  if (typeof children !== "function") {
    return (
      <>
        {children as ReactNode}
        {extra}
      </>
    );
  }
  return (...args: unknown[]) => (
    <>
      {children(...args)}
      {extra}
    </>
  );
}

export function LinkTab({
  className,
  current = false,
  count,
  countLabel,
  asChild = false,
  children,
  ...props
}: LinkTabProps): JSX.Element {
  const countNode =
    count === undefined ? null : (
      <ItemCount count={count} countLabel={countLabel} />
    );
  const child =
    asChild && isValidElement<ChildProps>(children) ? children : null;
  return (
    <li className="flex">
      {/* Link brings asChild and the focus outline; its colour, weight and
          underline give way to the tab's. */}
      <Link
        data-slot="link-tab"
        aria-current={current ? "page" : undefined}
        asChild={child !== null}
        className={cn(
          tabTriggerClassName,
          "no-underline! aria-[current=page]:text-foreground aria-[current=page]:after:opacity-100",
          className,
        )}
        {...props}
      >
        {child ? (
          countNode ? (
            cloneElement(child, {
              children: append(child.props.children, countNode),
            })
          ) : (
            child
          )
        ) : (
          <>
            {children}
            {countNode}
          </>
        )}
      </Link>
    </li>
  );
}
