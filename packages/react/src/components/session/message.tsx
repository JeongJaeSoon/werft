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
        "flex w-fit min-w-0 max-w-[85%] flex-col gap-1 rounded-card border px-3 py-2 text-sm",
        // Mine sit on the right in the solid primary; the text and the meta
        // lines keep full strength so they stay readable on it.
        user
          ? "ml-auto border-transparent bg-primary text-primary-foreground"
          : "bg-card",
        error && "border-destructive",
        className,
      )}
    >
      <header
        className={cn(
          "flex flex-wrap items-baseline gap-x-2 text-xs",
          !user && "text-muted-foreground",
        )}
      >
        <span className={cn("font-medium", !user && "text-foreground")}>
          {author}
        </span>
        {occurredAt ? (
          <time dateTime={occurredAt}>
            {formatTimestamp(occurredAt, locale)}
          </time>
        ) : null}
        {source}
      </header>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
      {receipt || error ? (
        <footer className="flex flex-col gap-1">
          {receipt ? (
            <span
              data-receipt={receipt.status}
              className={cn(
                "text-xs",
                !user && "text-muted-foreground",
                receipt.status === "failed" &&
                  (user ? "font-medium underline" : "text-destructive"),
              )}
            >
              {receipt.label}
            </span>
          ) : null}
          {error ? (
            <p
              className={cn(
                "text-xs [overflow-wrap:anywhere]",
                user ? "font-medium underline" : "text-destructive",
              )}
            >
              {error}
            </p>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
