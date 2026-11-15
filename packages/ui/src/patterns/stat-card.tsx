import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";
import { Card } from "../primitives/card.tsx";
import { StatValue } from "../primitives/stat-value.tsx";

export type StatCardProps = Omit<ComponentProps<"div">, "children"> & {
  readonly label: ReactNode;
  /** The figure, formatted by the caller. */
  readonly value: ReactNode;
  /** A Badge beside the label, such as the period it covers. */
  readonly badge?: ReactNode | undefined;
  /** The whole the figure is out of, drawn small after it: "7 / 10". */
  readonly outOf?: ReactNode | undefined;
  /** A Sparkline or Meter between the figure and the description. */
  readonly chart?: ReactNode | undefined;
  /** One meta line under the figure. */
  readonly description?: ReactNode | undefined;
  /** Greys the figure, for a value that is empty or not yet counted. */
  readonly muted?: boolean | undefined;
};

/** One KPI card (mockup v4 `.kpi-label`, `.kpi-num`, `.meta`). */
export function StatCard({
  label,
  value,
  badge,
  outOf,
  chart,
  description,
  muted = false,
  className,
  ...props
}: StatCardProps): JSX.Element {
  return (
    <Card data-slot="stat-card" className={cn("min-w-0", className)} {...props}>
      <div className="flex items-center gap-2 px-4 text-control text-muted-foreground">
        {label}
        {badge}
      </div>
      <div className="px-4">
        <StatValue className={cn(muted && "text-subtle-foreground")}>
          {value}
        </StatValue>
        {outOf === undefined ? null : (
          <>
            {" "}
            <span className="font-medium text-body text-subtle-foreground">
              / {outOf}
            </span>
          </>
        )}
      </div>
      {chart ? (
        <div data-slot="stat-card-chart" className="px-4">
          {chart}
        </div>
      ) : null}
      {description ? (
        <div className="px-4 text-caption text-subtle-foreground leading-4">
          {description}
        </div>
      ) : null}
    </Card>
  );
}
