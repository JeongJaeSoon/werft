import {
  type FormEvent,
  type JSX,
  type ReactNode,
  type Ref,
  useId,
} from "react";

import { RowList } from "../primitives/row-list.tsx";

export interface SettingsSectionProps {
  /** A fragment others link to. */
  readonly id?: string | undefined;
  readonly title: string;
  /** `h3` under a page whose own sections are `h2`. */
  readonly titleAs?: "h2" | "h3" | undefined;
  /** After the title, outside the heading's name: a count. */
  readonly badge?: ReactNode | undefined;
  readonly description?: ReactNode | undefined;
  readonly titleRef?: Ref<HTMLHeadingElement> | undefined;
  readonly descriptionId?: string | undefined;
  /**
   * The section's main action (an "add" button), on the right of the title
   * row so it reads as belonging to this section's list.
   */
  readonly actions?: ReactNode | undefined;
  /**
   * Draws the body in one bordered box, for content that is not already a
   * framed table or row list (a form, a paragraph, an empty state).
   */
  readonly box?: boolean | undefined;
  /** SettingRows in their own bordered box under the body. */
  readonly rows?: ReactNode | undefined;
  readonly foot?: ReactNode | undefined;
  /** Wraps the body, rows and foot in a form. */
  readonly onSubmit?: ((event: FormEvent) => void) | undefined;
  readonly children?: ReactNode | undefined;
}

/**
 * A settings page's block: a title ruled off from its body, an optional
 * description, then the body, a joined list of SettingRows and a foot.
 */
export function SettingsSection({
  id,
  title,
  titleAs: Heading = "h2",
  badge,
  description,
  descriptionId,
  titleRef,
  actions,
  box = false,
  rows,
  foot,
  onSubmit,
  children,
}: SettingsSectionProps): JSX.Element {
  const titleId = useId();
  const content = (
    <>
      {children && box ? (
        <div className="flex min-w-0 flex-col gap-4 rounded-card border bg-card p-4">
          {children}
        </div>
      ) : (
        children
      )}
      {rows ? (
        <RowList variant="joined" aria-labelledby={titleId}>
          {rows}
        </RowList>
      ) : null}
      {foot ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {foot}
        </div>
      ) : null}
    </>
  );
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      // A page may zero the row padding so unframed rows sit on its edge;
      // the section's rows and tables are in a box, which needs it back.
      className="flex min-w-0 flex-col gap-4 [--werft-row-padding-x:var(--werft-space-4)]"
    >
      <div className="flex flex-col gap-1 border-b pb-2">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Heading
              id={titleId}
              ref={titleRef}
              tabIndex={titleRef ? -1 : undefined}
              className="m-0 font-semibold text-body leading-6"
            >
              {title}
            </Heading>
            {badge}
          </div>
          {actions ? (
            <div className="flex flex-none items-center gap-2">{actions}</div>
          ) : null}
        </div>
        {description ? (
          // The rule above runs to the page's edge; the text keeps to a
          // reading line.
          <div
            id={descriptionId}
            className="m-0 max-w-[var(--werft-layout-reading-width)] text-control text-muted-foreground"
          >
            {description}
          </div>
        ) : null}
      </div>
      {onSubmit ? (
        // noValidate: the server owns the limits and says why it refused.
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {content}
        </form>
      ) : (
        content
      )}
    </section>
  );
}
