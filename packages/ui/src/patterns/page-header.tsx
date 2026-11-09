import { type JSX, type ReactNode, type Ref, useId } from "react";

import { cn } from "../foundations/cn.ts";

export interface PageHeaderProps {
  /** The page's one `h1`; match the sidebar and breadcrumb wording. */
  readonly title: ReactNode;
  /**
   * Beside the title on its line but outside the heading, such as a state
   * tag, so the heading's name stays the page's name.
   */
  readonly titleAside?: ReactNode | undefined;
  /** One line on what the page is for; screen readers hear it with the title. */
  readonly description?: ReactNode | undefined;
  /**
   * The page's own actions, such as its primary button; several sit in a
   * row (a view switch, then the primary button).
   */
  readonly actions?: ReactNode | undefined;
  /**
   * A `PageBreadcrumb` on the line above the title, where another page's
   * title starts. A detail screen's way back to its list is a button at
   * the end of `actions` instead (user decision 2026-10-25).
   */
  readonly breadcrumb?: ReactNode | undefined;
  /**
   * For a screen that hands focus to its title when the part of the page
   * that held it goes away; the title then takes `tabIndex={-1}`.
   */
  readonly titleRef?: Ref<HTMLHeadingElement> | undefined;
  /**
   * Below this breakpoint the actions go under the description, so the
   * title and description keep the full width (owner decision 2026-10-29).
   * `lg` for a head whose title needs more room beside its actions.
   * `wrap` for a head whose actions change in number and width, such as a
   * session's commands: no breakpoint, the title column keeps at least
   * 20rem (or the whole row when narrower) and the actions go under it
   * whenever the row cannot hold both.
   */
  readonly stackBelow?: "md" | "lg" | "wrap" | undefined;
  readonly className?: string | undefined;
}

const STACK = {
  md: {
    head: "md:flex-row md:items-start md:justify-between md:gap-4",
    title: "",
    actions: "md:flex-none md:flex-nowrap",
  },
  lg: {
    head: "lg:flex-row lg:items-start lg:justify-between lg:gap-4",
    title: "",
    actions: "lg:flex-none lg:flex-nowrap",
  },
  // The title grows from a 20rem basis and never gives that up, so the
  // actions wrap to the next line instead of squeezing it; a row of actions
  // wider than the page then wraps inside itself. Beside the title the
  // actions take almost none of the spare width (1 to the title's 999);
  // alone on their line they fill it, so an `ms-auto` item still reaches
  // the right edge as it did in the stacked column.
  wrap: {
    head: "flex-row flex-wrap items-start justify-between gap-x-4",
    title: "grow-[999] basis-80 min-w-[min(100%,20rem)]",
    actions: "grow max-w-full",
  },
} as const;

/**
 * The head of a console page (console v35): a 20/28 title, a 13/20
 * description, actions on the right, no divider, 24px above the content.
 */
export function PageHeader({
  title,
  titleAside,
  description,
  actions,
  breadcrumb,
  titleRef,
  stackBelow = "md",
  className,
}: PageHeaderProps): JSX.Element {
  const descriptionId = useId();
  const hasDescription =
    description !== undefined && description !== null && description !== "";
  const heading = (
    <h1
      ref={titleRef}
      tabIndex={titleRef ? -1 : undefined}
      className="m-0 font-semibold text-foreground text-title"
      aria-describedby={hasDescription ? descriptionId : undefined}
    >
      {title}
    </h1>
  );
  return (
    <header
      data-slot="page-header"
      className={cn(
        "mb-[var(--werft-space-page-head)] flex flex-col gap-3",
        STACK[stackBelow].head,
        className,
      )}
    >
      <div
        className={cn("flex min-w-0 flex-col gap-1", STACK[stackBelow].title)}
      >
        {breadcrumb}
        {titleAside ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {heading}
            {titleAside}
          </div>
        ) : (
          heading
        )}
        {hasDescription ? (
          <p
            id={descriptionId}
            className="m-0 text-description text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            STACK[stackBelow].actions,
          )}
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
