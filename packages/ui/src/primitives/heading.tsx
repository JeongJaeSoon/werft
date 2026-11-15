import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { withLeading } from "./leading.ts";

// v4 `.page-title`: 20px on a 28px line, -0.4px tracking. `.section-title`
// and `.card-title`: 14px on a 20px line.
const HEADING_SIZE = {
  title: { size: "text-title", leading: "leading-7" },
  section: { size: "text-body", leading: "leading-5" },
} as const;

export type HeadingProps = ComponentProps<"h2"> & {
  /** The element, h1-h6: where it sits in the page's outline. */
  readonly level?: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
  /**
   * How it looks, apart from the level: a card's h2 is a 14px `section`,
   * a page's h1 a 20px `title`.
   */
  readonly size?: keyof typeof HEADING_SIZE | undefined;
};

export function Heading({
  level = 2,
  size = "section",
  className,
  ...props
}: HeadingProps): JSX.Element {
  const Tag = `h${level}` as const;
  return (
    <Tag
      data-slot="heading"
      data-size={size}
      className={withLeading(
        cn(
          "m-0 font-medium text-foreground",
          HEADING_SIZE[size].size,
          className,
        ),
        HEADING_SIZE[size].leading,
      )}
      {...props}
    />
  );
}
