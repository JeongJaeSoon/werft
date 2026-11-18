import type { CSSProperties, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useReducedMotion } from "../foundations/use-reduced-motion.ts";

interface SkeletonLook {
  readonly shape?: "text" | "block" | "circle" | undefined;
  /** Only for `shape="text"`: how many lines to stand in for. */
  readonly lines?: number | undefined;
  /** Any CSS length; percentages keep it inside a 360px column. */
  readonly width?: string | undefined;
  readonly height?: string | undefined;
  readonly className?: string | undefined;
  /** Sit on a line of text, as one value in "7 / 10", keeping the line's box. */
  readonly inline?: boolean | undefined;
}

/**
 * A placeholder either says what is loading or is declared decorative; the
 * package has no wording of its own to fall back on.
 */
export type SkeletonProps = SkeletonLook &
  (
    | {
        /** What is loading, in the reader's language. */
        readonly label: string;
        readonly decorative?: false | undefined;
      }
    | {
        /**
         * Hidden from assistive tech, for a screen that says it is loading
         * once rather than at every placeholder.
         */
        readonly decorative: true;
        readonly label?: undefined;
      }
  );

export function Skeleton({
  shape = "text",
  lines = 1,
  width,
  height,
  className,
  label,
  inline = false,
  decorative = false,
}: SkeletonProps): JSX.Element {
  const reducedMotion = useReducedMotion();
  const style: CSSProperties = {};
  if (width) style.width = width;
  if (height) style.height = height;

  const count = shape === "text" ? Math.max(1, lines) : 1;
  const bars = Array.from({ length: count }, (_, index) => index);

  return (
    // <output> carries role="status" natively, so a screen reader hears the
    // label politely without a redundant aria-live.
    <output
      className={cn("werft-skeleton", className)}
      data-shape={shape}
      data-inline={inline || undefined}
      data-animated={reducedMotion ? undefined : "true"}
      style={style}
      aria-busy="true"
      aria-hidden={decorative || undefined}
    >
      {bars.map((index) => (
        // Placeholder bars have no identity beyond their position.
        <span key={index} className="werft-skeleton__bar" />
      ))}
      <span className="werft-visually-hidden">{label}</span>
    </output>
  );
}
