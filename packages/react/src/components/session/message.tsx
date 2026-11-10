import type { ReceiptStatus } from "@werft-ai/contracts";
import { cn, formatTimestamp, type TimestampLocale } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

export interface MessageProps {
  readonly from: "user" | "assistant";
  /** Shown above the text: who said it. */
  readonly author: string;
  readonly text: string;
  readonly occurredAt?: string | undefined;
  /** At the end of the author line: where the message can be seen first. */
  readonly source?: ReactNode;
  /**
   * A sent message's receipt. `accepted` is not `succeeded`, so the
   * screen's label must say which one it is.
   */
  readonly receipt?:
    | { readonly status: ReceiptStatus; readonly label: string }
    | undefined;
  /** Why the message was refused, under the text. */
  readonly error?: string | undefined;
  readonly locale?: TimestampLocale | undefined;
  readonly className?: string | undefined;
}

export function Message({
  from,
  author,
  text,
  occurredAt,
  source,
  receipt,
  error,
  locale = "ko",
  className,
}: MessageProps): JSX.Element | null {
  // A message with nothing in it would be an empty bubble.
  if (!text.trim()) return null;
  const user = from === "user";
  return (
    <article
      data-slot="message"
      data-from={from}
      className={cn(
        "flex w-fit min-w-0 max-w-[85%] flex-col gap-1 text-sm",
        // Mine sit on the right; who and when stand over the bubble, not in it.
        user && "ml-auto items-end",
        className,
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{author}</span>
        {occurredAt ? (
          <time dateTime={occurredAt}>
            {formatTimestamp(occurredAt, locale)}
          </time>
        ) : null}
        {source}
      </header>
      <p
        className={cn(
          "whitespace-pre-wrap rounded-card px-3 py-2 [overflow-wrap:anywhere]",
          user ? "bg-primary/10" : "border bg-card",
          error && "border border-destructive",
        )}
      >
        {text}
      </p>
      {receipt || error ? (
        <footer className="flex flex-col gap-1">
          {receipt ? (
            <span
              data-receipt={receipt.status}
              className={cn(
                "text-muted-foreground text-xs",
                receipt.status === "failed" && "text-destructive",
              )}
            >
              {receipt.label}
            </span>
          ) : null}
          {error ? (
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">
              {error}
            </p>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
