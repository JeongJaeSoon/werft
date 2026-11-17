import { DisabledReason, RowAction } from "@werft-ai/ui";
import { Ghost, SameWidth } from "./same-width.tsx";

/** A row's action; one that is withheld stays on the page and says why. */
export function Action({
  label,
  name,
  reason,
  busy,
  alike,
  onClick,
}: {
  readonly label: string;
  /** What it is called where rows share a label; it contains the label. */
  readonly name?: string | undefined;
  readonly reason?: string | undefined;
  readonly busy: boolean;
  /** The labels of the buttons in the rows around, to be as wide as. */
  readonly alike?: readonly string[] | undefined;
  readonly onClick: (button: HTMLElement) => void;
}) {
  const button = (
    // Busy is `aria-disabled`, which keeps the button focusable: a dialog that
    // closes on a saved change gives the keyboard back to it while the
    // re-read is still out.
    <RowAction
      aria-label={name}
      disabled={reason !== undefined}
      aria-disabled={busy || undefined}
      onClick={(event) => {
        if (!busy) onClick(event.currentTarget);
      }}
    >
      {alike ? (
        <SameWidth
          center
          alike={alike.map((text) => <Ghost key={text} text={text} />)}
        >
          {label}
        </SameWidth>
      ) : (
        label
      )}
    </RowAction>
  );
  return reason === undefined ? (
    button
  ) : (
    <DisabledReason reason={reason} label={label}>
      {button}
    </DisabledReason>
  );
}
