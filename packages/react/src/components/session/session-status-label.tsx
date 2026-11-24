import type { SessionStatus, SessionSummary } from "@werft-ai/contracts";
import { type JSX, useEffect, useState } from "react";

import { StatusLabel } from "../status/status-label.tsx";

/** How long a worker waits for room before the screen says so. */
export const CAPACITY_WAIT_SHOWN_MS = 30_000;

export type SessionCapacityWait = Pick<
  SessionSummary,
  "wait_reason" | "waiting_since"
>;

/**
 * True once the session's worker has waited CAPACITY_WAIT_SHOWN_MS for room,
 * re-rendering when that moment comes: a poll that returns the same data
 * does not.
 */
export function useWaitingForCapacity(
  wait: SessionCapacityWait | undefined,
): boolean {
  const since =
    wait?.wait_reason === "waiting_for_capacity" && wait.waiting_since
      ? Date.parse(wait.waiting_since)
      : Number.NaN;
  const [, rerender] = useState(0);
  const shownAt = since + CAPACITY_WAIT_SHOWN_MS;
  useEffect(() => {
    const remaining = shownAt - Date.now();
    if (!(remaining > 0)) return;
    const id = setTimeout(() => rerender((n) => n + 1), remaining);
    return () => clearTimeout(id);
  }, [shownAt]);
  return shownAt <= Date.now();
}

export interface SessionStatusLabelProps {
  readonly status: SessionStatus;
  /** The screen's word for the status, in its own locale. */
  readonly label: string;
  /** Read in place of `label` once the worker has waited long for room. */
  readonly capacityWait?: SessionCapacityWait | undefined;
  readonly capacityWaitLabel?: string | undefined;
  readonly axisLabel?: string | undefined;
  readonly className?: string | undefined;
}

export function SessionStatusLabel({
  status,
  label,
  capacityWait,
  capacityWaitLabel,
  axisLabel,
  className,
}: SessionStatusLabelProps): JSX.Element {
  const waiting = useWaitingForCapacity(capacityWait);
  return (
    <StatusLabel
      axis="session"
      state={status}
      label={waiting && capacityWaitLabel ? capacityWaitLabel : label}
      axisLabel={axisLabel}
      className={className}
    />
  );
}
