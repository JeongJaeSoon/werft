import { cn, StatusDot, useReducedMotion } from "@werft-ai/ui";
import type { JSX } from "react";

import { AxisIcon } from "./axis-icon.tsx";
import {
  describeStatus,
  STATUS_AXIS_LABEL,
  type StatusAxis,
  type StatusStateOf,
  statusDot,
} from "./vocabulary.ts";

export interface StatusLabelProps<A extends StatusAxis> {
  readonly axis: A;
  readonly state: StatusStateOf<A>;
  /** Overrides the vocabulary copy; omit to use the vocabulary wording. */
  readonly label?: string | undefined;
  /** Overrides the axis name a screen reader hears first. */
  readonly axisLabel?: string | undefined;
  /** Secondary line: elapsed time, waiting reason, error code. */
  readonly detail?: string | undefined;
  /** The value may be out of date — say so instead of showing it as fresh. */
  readonly stale?: boolean | undefined;
  /** Override the stale mark and its hover text. */
  readonly staleLabel?: string | undefined;
  readonly staleHint?: string | undefined;
  /**
   * "dot" draws the session list's mark: a coloured dot, or a turning ring
   * while in flight, beside plain text, with `detail` after a middle dot.
   */
  readonly appearance?: "pill" | "dot" | undefined;
  readonly className?: string | undefined;
}

export function StatusLabel<A extends StatusAxis>({
  axis,
  state,
  label,
  axisLabel,
  detail,
  stale = false,
  staleLabel = "갱신 지연",
  staleHint = "마지막으로 확인한 값입니다",
  appearance = "pill",
  className,
}: StatusLabelProps<A>): JSX.Element {
  const descriptor = describeStatus(axis, state);
  const reducedMotion = useReducedMotion();
  const text = label ?? descriptor.label;

  if (appearance === "dot") {
    const spinning = descriptor.inFlight && !reducedMotion;
    return (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-2 whitespace-nowrap text-control text-foreground",
          className,
        )}
        data-axis={axis}
        data-state={state}
        data-tone={descriptor.tone}
        data-stale={stale || undefined}
      >
        <StatusDot
          status={spinning ? "run" : statusDot(axis, state)}
          data-animated={spinning || undefined}
        />
        <span className="werft-visually-hidden">
          {axisLabel ?? STATUS_AXIS_LABEL[axis]}:{" "}
        </span>
        {/* A narrow column cuts the label, never the wait after it. */}
        <span className="flex min-w-0">
          <span className="min-w-0 truncate" title={text}>
            {text}
          </span>
          {detail ? (
            <span className="flex-none whitespace-pre"> · {detail}</span>
          ) : null}
        </span>
        {stale ? (
          <span
            className="text-caption text-muted-foreground"
            title={staleHint}
          >
            {staleLabel}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      className={cn("werft-status", className)}
      data-axis={axis}
      data-state={state}
      data-tone={descriptor.tone}
      data-stale={stale || undefined}
    >
      {/* One icon slot: a moving state's spinner takes the axis icon's place,
          so the axis reads from the label and the hidden axis name. */}
      {descriptor.inFlight && !reducedMotion ? (
        <span
          className="werft-status__spinner"
          data-animated="true"
          aria-hidden="true"
        />
      ) : (
        <AxisIcon axis={axis} />
      )}
      <span className="werft-visually-hidden">
        {axisLabel ?? STATUS_AXIS_LABEL[axis]}:{" "}
      </span>
      <span className="werft-status__text">{text}</span>
      {detail ? <span className="werft-status__detail">{detail}</span> : null}
      {stale ? (
        <span className="werft-status__stale" title={staleHint}>
          {staleLabel}
        </span>
      ) : null}
    </span>
  );
}
