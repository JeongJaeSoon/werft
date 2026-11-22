import {
  CircleSmall,
  Hexagon,
  type LucideIcon,
  Play,
  Receipt,
  Square,
} from "lucide-react";
import type { JSX } from "react";

import type { StatusAxis } from "./vocabulary.ts";

/*
 * Every axis gets its own silhouette, so two labels that happen to share a tone
 * are still told apart without reading the colour (dual encoding).
 */
const SHAPE: Record<StatusAxis, LucideIcon> = {
  // A dot, not the turn's play mark: a session at rest must not read as playing.
  session: CircleSmall,
  admission: Square,
  turn: Play,
  receipt: Receipt,
  execution: Hexagon,
};

export function AxisIcon({ axis }: { axis: StatusAxis }): JSX.Element {
  const Shape = SHAPE[axis];
  return (
    <Shape
      className="werft-status__icon"
      size={12}
      strokeWidth={1.25}
      absoluteStrokeWidth
      fill={axis === "turn" || axis === "session" ? "currentColor" : "none"}
      aria-hidden="true"
      focusable="false"
    />
  );
}
