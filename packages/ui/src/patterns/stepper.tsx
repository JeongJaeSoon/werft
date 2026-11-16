import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";

/*
 * Not a shadcn item (shadcn has no stepper). The steps form one tab stop:
 * Tab lands on the current step, the arrow keys, Home and End move between
 * steps that can be selected, and Enter or Space selects one. Which steps a
 * user may go back or forward to is the screen's decision, passed in as
 * `disabled`; without `onStepSelect` the steps are only a progress display.
 *
 * A finished step says so in words, never with a symbol. From `sm` up the
 * status word sits on its own 20px line under the name, so every step is the
 * same height; below `sm` it follows the name on the same line.
 *
 * The steps pack at the start, joined by short fixed lines: spread across a
 * wide page, the first and last numbers ended up at opposite edges.
 */

export interface StepperStep {
  readonly id: string;
  readonly label: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly disabled?: boolean | undefined;
  /** A word shown after the name, e.g. "선택". A finished step shows `completedLabel` instead. */
  readonly status?: ReactNode | undefined;
}

export interface StepperProps {
  readonly steps: readonly StepperStep[];
  readonly currentStepId: string;
  /** Names the step list for screen readers, e.g. "에이전트 만들기 단계". */
  readonly label: string;
  readonly onStepSelect?: ((id: string) => void) | undefined;
  /** Shown after each step before the current one. */
  readonly completedLabel?: string | undefined;
  readonly className?: string | undefined;
}

type StepState = "complete" | "current" | "upcoming";

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

export function Stepper({
  steps,
  currentStepId,
  label,
  onStepSelect,
  completedLabel = "완료",
  className,
}: StepperProps): JSX.Element {
  const currentIndex = steps.findIndex((step) => step.id === currentStepId);
  const [focusId, setFocusId] = useState(currentStepId);
  // When the screen moves to another step, the tab stop follows it.
  const [shownStepId, setShownStepId] = useState(currentStepId);
  if (shownStepId !== currentStepId) {
    setShownStepId(currentStepId);
    setFocusId(currentStepId);
  }
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selectable = steps.filter((step) => !step.disabled);
  const tabStopId = selectable.some((step) => step.id === focusId)
    ? focusId
    : (selectable.find((step) => step.id === currentStepId) ?? selectable[0])
        ?.id;

  const moveFocus = (event: KeyboardEvent, fromId: string): void => {
    const at = selectable.findIndex((step) => step.id === fromId);
    let target: StepperStep | undefined;
    if (NEXT_KEYS.has(event.key))
      target = selectable[(at + 1) % selectable.length];
    else if (PREVIOUS_KEYS.has(event.key))
      target = selectable[(at - 1 + selectable.length) % selectable.length];
    else if (event.key === "Home") target = selectable[0];
    else if (event.key === "End") target = selectable.at(-1);
    if (!target) return;
    event.preventDefault();
    setFocusId(target.id);
    buttons.current.get(target.id)?.focus();
  };

  return (
    <nav aria-label={label} data-slot="stepper" className={className}>
      <ol className="flex flex-col gap-2 break-keep sm:flex-row sm:flex-wrap sm:items-start sm:gap-3">
        {steps.map((step, index) => {
          const state: StepState =
            index < currentIndex
              ? "complete"
              : index === currentIndex
                ? "current"
                : "upcoming";
          const status = state === "complete" ? completedLabel : step.status;
          const last = index === steps.length - 1;
          const body = (
            <>
              <StepIndicator state={state} number={index + 1} />
              <span className="flex min-w-0 items-start gap-2 sm:flex-col sm:gap-0">
                <span className="flex min-w-0 flex-col">
                  <span className="whitespace-nowrap font-medium text-sm leading-6">
                    {step.label}
                  </span>
                  {step.description ? (
                    <span className="text-caption text-muted-foreground">
                      {step.description}
                    </span>
                  ) : null}
                </span>
                {status ? (
                  <span
                    data-slot="stepper-step-status"
                    className={cn(
                      // leading-6 below sm puts the word's centre on the name line.
                      "whitespace-nowrap text-caption leading-6 sm:leading-5",
                      state === "complete"
                        ? "text-(color:--werft-tone-success-fg)"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className="sr-only">, </span>
                    {status}
                  </span>
                ) : (
                  // Keeps every step the same height from sm up.
                  <span
                    aria-hidden="true"
                    data-slot="stepper-step-status"
                    className="hidden h-5 sm:block"
                  />
                )}
              </span>
            </>
          );
          const itemClass = cn(
            "flex min-w-0 items-start gap-2 sm:shrink-0",
            state === "upcoming" ? "text-muted-foreground" : "text-foreground",
          );
          return (
            <li
              key={step.id}
              data-slot="stepper-step"
              data-state={state}
              className="flex items-center gap-3 sm:items-start"
            >
              {onStepSelect ? (
                <button
                  type="button"
                  ref={(node) => {
                    if (node) buttons.current.set(step.id, node);
                    else buttons.current.delete(step.id);
                  }}
                  aria-current={state === "current" ? "step" : undefined}
                  disabled={step.disabled}
                  tabIndex={step.id === tabStopId ? 0 : -1}
                  onFocus={() => setFocusId(step.id)}
                  onKeyDown={(event) => moveFocus(event, step.id)}
                  onClick={() => onStepSelect(step.id)}
                  className={cn(
                    itemClass,
                    "cursor-pointer rounded-control text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  {body}
                </button>
              ) : (
                <div
                  aria-current={state === "current" ? "step" : undefined}
                  className={itemClass}
                >
                  {body}
                </div>
              )}
              {last ? null : (
                <span
                  aria-hidden="true"
                  data-slot="stepper-connector"
                  className={cn(
                    // Through the circle's centre, 12px from the top.
                    "hidden h-px w-8 shrink-0 sm:mt-3 sm:block sm:-translate-y-1/2",
                    state === "complete"
                      ? "bg-(color:--werft-tone-success-border)"
                      : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepIndicator({
  state,
  number,
}: {
  readonly state: StepState;
  readonly number: number;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-6 shrink-0 place-content-center rounded-full border font-medium text-xs",
        state === "complete" &&
          "border-(color:--werft-tone-success-border) bg-(color:--werft-tone-success-bg) text-(color:--werft-tone-success-fg)",
        state === "current" &&
          "border-primary bg-primary text-primary-foreground ring-[3px] ring-primary/25",
        state === "upcoming" &&
          "border-(color:--werft-tone-neutral-border) bg-card text-muted-foreground",
      )}
    >
      {number}
    </span>
  );
}
