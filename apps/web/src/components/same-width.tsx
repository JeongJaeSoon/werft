import type { JSX, ReactNode } from "react";

/**
 * Its children, as wide as the widest of `alike`: for boxes in rows of their
 * own (each row a grid or a list item) that must start and end at one place.
 * Make each of `alike` a ghost: `aria-hidden`, `GHOST` and its text in
 * `data-text`, so it is neither seen, read, selected nor found by text.
 */
export function SameWidth({
  alike,
  center = false,
  children,
}: {
  readonly alike: ReactNode;
  readonly center?: boolean | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      data-slot="same-width"
      className={`inline-grid ${center ? "justify-items-center" : "justify-items-start"} [&>*]:col-start-1 [&>*]:row-start-1`}
    >
      {/* A bare text child would take a grid row of its own. */}
      <span className="flex items-center">{children}</span>
      {alike}
    </span>
  );
}

export const GHOST = "invisible before:content-[attr(data-text)]";

/** A ghost of plain text, in the font of where it sits. */
export function Ghost({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string | undefined;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-text={text}
      className={className ? `${GHOST} ${className}` : GHOST}
    />
  );
}
