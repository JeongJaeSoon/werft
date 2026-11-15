import type { ComponentProps, JSX, ReactNode, Ref } from "react";

import { cn } from "../foundations/cn.ts";
import { Heading } from "../primitives/heading.tsx";
import { Text } from "../primitives/text.tsx";
import { IconTile, type TileIcon } from "./icon-tile.tsx";

export type IntegrationHeaderProps = Omit<ComponentProps<"div">, "title"> & {
  /** The service's mark, on a tile spanning the title and summary lines. */
  readonly icon: TileIcon;
  /** The service's name, as the card's `h2`. */
  readonly title: ReactNode;
  /** For the section around the card, labelled by this heading. */
  readonly titleId?: string | undefined;
  /**
   * For a screen that hands focus to the title when what held it goes away;
   * the title then takes `tabIndex={-1}`.
   */
  readonly titleRef?: Ref<HTMLHeadingElement> | undefined;
  /** Beside the title but outside the heading, such as a state badge. */
  readonly status?: ReactNode | undefined;
  /**
   * One muted paragraph under the title, such as counts; phrasing content
   * only, so "label value" pairs bring their own inline-flex span.
   */
  readonly summary?: ReactNode | undefined;
  /** At the end of the title row, such as a button that turns it on. */
  readonly action?: ReactNode | undefined;
  /** What the service does here, under the title row. */
  readonly description?: ReactNode | undefined;
  /** Notes and alerts under the description. */
  readonly children?: ReactNode | undefined;
};

/**
 * The head of a connected service's screen (GitHub, Slack): its mark, name,
 * state and summary in one row with an optional action, then a line on what
 * it is for and whatever stops it from working.
 */
export function IntegrationHeader({
  icon,
  title,
  titleId,
  titleRef,
  status,
  summary,
  action,
  description,
  children,
  className,
  ...props
}: IntegrationHeaderProps): JSX.Element {
  return (
    <div
      data-slot="integration-header"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-3">
        <IconTile icon={icon} size="two-line" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2">
            <Heading
              id={titleId}
              ref={titleRef}
              level={2}
              tabIndex={titleRef ? -1 : undefined}
              className={titleRef ? "focus-visible:outline-none" : undefined}
            >
              {title}
            </Heading>
            {status}
          </div>
          {summary == null ? null : <Text variant="sub">{summary}</Text>}
        </div>
        {action}
      </div>
      {description == null ? null : <Text variant="sub">{description}</Text>}
      {children}
    </div>
  );
}
