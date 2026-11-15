import { Button } from "@werft-ai/ui";
import { type JSX, useEffect, useRef } from "react";

export interface LoadMoreButtonMessages {
  readonly more: string;
  readonly loading: string;
}

export interface LoadMoreButtonProps {
  /** Another page waits. Keep it true after that page failed to come. */
  readonly hasMore: boolean;
  /** The next page is on its way. */
  readonly loading: boolean;
  /** Any read a press now would cancel or race; defaults to `loading`. */
  readonly busy?: boolean | undefined;
  readonly onLoadMore: () => void;
  readonly messages: LoadMoreButtonMessages;
}

/** The body rows of the tables in `scope`; header rows hold no cells. */
function bodyRows(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("[role=row]")].filter(
    (row) => row.querySelector("[role=cell]") !== null,
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
 * A list's "더 보기" under its table. While busy it is aria-disabled, not
 * disabled, so the keyboard stays on it. When the last page arrives the
 * button goes, and if that dropped the focus it moves to the first new row
 * (its first focusable, usually the row opener), found in the button's
 * parent, or to that parent when it holds no row. Stay mounted (hasMore
 * false) so the move can happen.
 */
export function LoadMoreButton({
  hasMore,
  loading,
  busy = loading,
  onLoadMore,
  messages,
}: LoadMoreButtonProps): JSX.Element | null {
  const asked = useRef<{ scope: HTMLElement; shown: number } | null>(null);

  useEffect(() => {
    if (loading) return;
    const pending = asked.current;
    asked.current = null;
    if (pending === null || hasMore || !pending.scope.isConnected) return;
    const { activeElement: active, body } = pending.scope.ownerDocument;
    if (active !== null && active !== body && active.isConnected) {
      return;
    }
    const rows = bodyRows(pending.scope);
    const row = rows[pending.shown] ?? rows[rows.length - 1];
    if (row === undefined) {
      // A filtered list can end with no row at all: the keyboard stays on
      // the list, which now holds only its empty state.
      pending.scope.tabIndex = -1;
      pending.scope.focus();
      return;
    }
    const target = row.querySelector<HTMLElement>(FOCUSABLE);
    if (target === null) row.tabIndex = -1;
    (target ?? row).focus();
  }, [loading, hasMore]);

  if (!hasMore) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="self-start aria-disabled:opacity-45"
      aria-disabled={busy || undefined}
      onClick={(event) => {
        if (busy) return;
        const scope = event.currentTarget.parentElement;
        if (scope !== null) {
          asked.current = {
            scope,
            shown: bodyRows(scope).length,
          };
        }
        onLoadMore();
      }}
    >
      {loading ? messages.loading : messages.more}
    </Button>
  );
}
