import { Heading } from "@werft-ai/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Whether a step flow has left the step it opened on. A step heading takes
 * focus once the flow has moved, not on arrival.
 */
export function useStepMoved(step: string): boolean {
  const [firstStep] = useState(step);
  const [moved, setMoved] = useState(false);
  if (!moved && step !== firstStep) setMoved(true);
  return moved;
}

/** A step's heading, which takes focus when the flow moves onto the step. */
export function StepHeading({
  focus,
  id,
  describedBy,
  hidden = false,
  children,
}: {
  readonly focus: boolean;
  readonly id?: string;
  /** What is read after the heading when it takes focus. */
  readonly describedBy?: string;
  /** Read and focused, not shown: for a step whose first field says the same. */
  readonly hidden?: boolean;
  readonly children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <Heading
      ref={heading}
      id={id}
      aria-describedby={describedBy}
      tabIndex={-1}
      // Important: the unlayered `[tabindex]:focus-visible` rule in
      // styles.css would draw a ring round the heading it moves focus to.
      className={hidden ? "sr-only outline-none!" : "outline-none!"}
    >
      {children}
    </Heading>
  );
}
