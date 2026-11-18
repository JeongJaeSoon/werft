/**
 * Whether the keyboard was left with nowhere to be: on the page, on a node
 * since swapped out, or, when `inDialog`, in a dialog on its way out. When
 * it is anywhere else the user moved on, and a screen does not pull it back.
 */
/** Focus a button, or, when it is withheld, the box that says why. */
export function focusOrReason(button: HTMLButtonElement | null): void {
  (button?.disabled
    ? button.closest<HTMLElement>("[data-slot=disabled-reason]")
    : button
  )?.focus();
}

export function focusLeftBehind(inDialog = false): boolean {
  const at = document.activeElement;
  return (
    !at ||
    at === document.body ||
    !at.isConnected ||
    (inDialog && at.closest('[role="dialog"], [role="alertdialog"]') !== null)
  );
}
