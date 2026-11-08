import { type ReactNode, useEffect, useRef } from "react";
import { type Outcome, OutcomeLine } from "../../components/outcome.tsx";

export type Place =
  | "page"
  | "card"
  | "mcp"
  | "credentials"
  | "releases"
  | "admins";

/** An outcome shows in the section whose button caused it. */
export interface Placed {
  readonly at: Place;
  readonly outcome: Outcome;
}

/** The outcome placed here, focused so the result is where the person is. */
export function PlacedOutcome({
  placed,
  at,
}: {
  readonly placed: Placed | null;
  readonly at: Place;
}) {
  const outcome = placed?.at === at ? placed.outcome : null;
  return (
    <TakesFocus on={outcome}>
      <OutcomeLine outcome={outcome} />
    </TakesFocus>
  );
}

/** Each new non-null `on` moves focus to what it wraps. */
export function TakesFocus({
  on,
  children,
}: {
  readonly on: unknown;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) ref.current?.focus();
  }, [on]);
  return on ? (
    <div ref={ref} tabIndex={-1}>
      {children}
    </div>
  ) : null;
}
