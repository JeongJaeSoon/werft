import { type ComponentProps, type JSX, type ReactNode, useId } from "react";

import { cn } from "../foundations/cn.ts";

export type SectionProps = Omit<ComponentProps<"section">, "title"> & {
  readonly title: ReactNode;
  /** The heading level; `h2` under a page's `h1`. */
  readonly titleAs?: "h2" | "h3" | "h4" | undefined;
  /** A Badge after the title, outside the heading's name. */
  readonly badge?: ReactNode | undefined;
  /** One meta line under the title. */
  readonly description?: ReactNode | undefined;
  /** The section's own actions, on the right of its head. */
  readonly actions?: ReactNode | undefined;
  /** Passed to the heading, e.g. a ref and `tabIndex={-1}` to move focus there. */
  readonly titleProps?:
    | Omit<ComponentProps<"h2">, "id" | "children" | "dangerouslySetInnerHTML">
    | undefined;
};

/**
 * A titled block of a page (mockup v4 `.section-head`): head 32px tall like
 * SettingsSection's, 12px above the content. The space between sections is the page's.
 */
export function Section({
  title,
  titleAs: Heading = "h2",
  badge,
  description,
  actions,
  titleProps,
  className,
  children,
  ...props
}: SectionProps): JSX.Element {
  const titleId = useId();
  return (
    <section
      data-slot="section"
      aria-labelledby={titleId}
      className={className}
      {...props}
    >
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Heading
              {...titleProps}
              id={titleId}
              className={cn(
                "m-0 font-medium text-body leading-5",
                titleProps?.className,
              )}
            >
              {title}
            </Heading>
            {badge}
          </div>
          {description ? (
            <p className="m-0 text-caption text-subtle-foreground leading-normal">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          // The head is 32px tall, so an `sm` button here takes its height too.
          <div className="flex flex-none items-center gap-2 [&_[data-werft-button][data-size=sm]]:h-[var(--werft-control-height)] [&_[data-werft-button][data-size=sm]]:px-3">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
