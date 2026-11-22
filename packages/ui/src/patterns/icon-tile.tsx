import type { ComponentType, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type TileIcon = ComponentType<{
  readonly className?: string;
  readonly strokeWidth?: number;
  readonly "aria-hidden"?: "true";
}>;

export type IconTileProps = {
  readonly icon: TileIcon;
  readonly size?: "line" | "two-line" | undefined;
};

/**
 * An ink glyph on a quiet ink tile: the mark of a home card or a connection
 * section. Every tile is the same colour, so a page's only small colour is its
 * status dots. Beside two stacked lines it spans both.
 */
export function IconTile({
  icon: Icon,
  size = "line",
}: IconTileProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="icon-tile"
      className={cn(
        "grid shrink-0 place-items-center rounded-control bg-(--werft-color-tile) text-(--werft-color-tile-foreground)",
        size === "line"
          ? "size-(--werft-size-icon-tile)"
          : // Pinned to the first line when the text wraps past two.
            "size-(--werft-size-tile-two-line) self-start",
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={2}
        className={size === "line" ? "size-3.5" : "size-5"}
      />
    </span>
  );
}
