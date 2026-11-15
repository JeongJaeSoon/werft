import { Text } from "@werft-ai/ui";
import { type ReactNode, useId } from "react";

/**
 * One row of a settings form: the label and a short hint on the left, the
 * controls and their notes on the right; one column below md.
 */
export function FormRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    // min-w-0: a fieldset is otherwise as wide as its widest control.
    <fieldset
      aria-labelledby={labelId}
      aria-describedby={hintId}
      className="grid min-w-0 gap-2 border-b py-3.5 last:border-b-0 md:grid-cols-[260px_minmax(0,1fr)] md:gap-4"
    >
      <div className="min-w-0">
        <Text as="div" id={labelId} weight="medium">
          {label}
        </Text>
        <Text id={hintId} variant="meta">
          {hint}
        </Text>
      </div>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </fieldset>
  );
}
