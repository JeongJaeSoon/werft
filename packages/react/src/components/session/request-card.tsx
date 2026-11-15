import { cn, Text } from "@werft-ai/ui";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";

export interface RequestCardProps
  extends Omit<ComponentProps<"article">, "title"> {
  /** The id the card is named by; on `label` when given, else on `title`. */
  readonly titleId: string;
  /** Before the title, in the attention colour. */
  readonly icon: LucideIcon;
  /** The bold words on the head line: "승인 대기", "질문". */
  readonly title: ReactNode;
  /**
   * The card's name for screen readers when it says more than `title`, such
   * as which tool asks. The visible title is then not read twice.
   */
  readonly label?: ReactNode;
  /** After the title, such as what the request belongs to. */
  readonly subject?: ReactNode;
  /** At the head line's right end: until when it can be answered. */
  readonly notice?: ReactNode;
  /** `plain` drops the frame, for a request drawn inside a list line. */
  readonly variant?: "card" | "plain";
  /** `plain` only: hide the head line. */
  readonly headHidden?: boolean;
  /** The card's `data-slot`, naming which kind of request it is. */
  readonly slot: "approval-card" | "question-card";
}

/**
 * The frame every request waiting for an answer shares, a question or a
 * permission: the chat column's full width, slim padding, one border and
 * corner, and a head line of icon, title and expiry.
 */
export function RequestCard({
  titleId,
  icon: Icon,
  title,
  label,
  subject,
  notice,
  variant = "card",
  headHidden = false,
  slot,
  className,
  children,
  ...props
}: RequestCardProps): JSX.Element {
  return (
    // An article, not a section: two requests for the same tool would make
    // two landmarks with one name.
    <article
      aria-labelledby={titleId}
      data-slot={slot}
      className={cn(
        "flex min-w-0 flex-col gap-2 text-control",
        variant === "card" &&
          "w-full rounded-card border border-[var(--werft-tone-attention-border)] bg-[var(--werft-tone-attention-bg)] px-4 py-3",
        className,
      )}
      {...props}
    >
      {label === undefined ? null : (
        <span id={titleId} className="sr-only">
          {label}
        </span>
      )}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1",
          headHidden && "sr-only",
        )}
      >
        <Icon
          className="size-4 shrink-0 text-[var(--werft-tone-attention-fg)]"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* Not a heading: the level depends on the screen around the card. */}
        <Text
          as="span"
          {...(label === undefined
            ? { id: titleId }
            : { "aria-hidden": true as const })}
          className="font-medium text-[var(--werft-tone-attention-fg)] text-control"
        >
          {title}
        </Text>
        {subject === undefined ? null : (
          // Each separator wraps with the item after it, never left trailing.
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <Text
              as="span"
              variant="meta"
              className="min-w-0 text-foreground [overflow-wrap:anywhere]"
            >
              {subject}
            </Text>
          </span>
        )}
        {notice === undefined ? null : (
          <div className="ml-auto text-right">{notice}</div>
        )}
      </div>
      {children}
    </article>
  );
}
