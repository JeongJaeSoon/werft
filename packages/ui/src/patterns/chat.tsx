import { ChevronRight } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

export type ChatSide = "self" | "other";

export interface ChatMessageProps
  extends Omit<ComponentProps<"article">, "children"> {
  /** `self`: the reader's side, right and filled. `other`: left, muted. */
  readonly side: ChatSide;
  /** Who said it, bold over the bubble. */
  readonly author: ReactNode;
  /** When, grey after the name; a `<time>` reads best. */
  readonly time?: ReactNode;
  /** Drawn after the time, such as a link to where it was first said. */
  readonly source?: ReactNode;
  /** `error` draws the other side's words as a failure. */
  readonly tone?: "default" | "error";
  /** Under the bubble, such as a send receipt. */
  readonly footer?: ReactNode;
  /** The words; plain text keeps its line breaks. */
  readonly children: ReactNode;
}

/**
 * One chat message: the reader's own on the right in a filled bubble, the
 * other side's on the left as plain text, without a bubble or avatar. Each
 * message names its author and time again, even after one from the same
 * person.
 */
export function ChatMessage({
  side,
  author,
  time,
  source,
  tone = "default",
  footer,
  className,
  children,
  ...props
}: ChatMessageProps): JSX.Element {
  const self = side === "self";
  return (
    <article
      data-slot="chat-message"
      data-side={side}
      className={cn(
        "flex min-w-0 gap-3",
        self ? "justify-end" : "justify-start",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col gap-0.5",
          self ? "max-w-[70%]" : "max-w-full",
          self ? "items-end" : "items-start",
        )}
      >
        <header className="flex flex-wrap items-baseline gap-x-2 text-caption">
          <span className="font-medium text-control text-foreground">
            {author}
          </span>
          {time ? <span className="text-muted-foreground">{time}</span> : null}
          {source}
        </header>
        <div
          data-slot="chat-bubble"
          className={cn(
            "w-fit min-w-0 max-w-full text-control leading-[1.6] [overflow-wrap:anywhere]",
            self
              ? "whitespace-pre-wrap rounded-2xl bg-primary px-3.5 py-2 text-primary-foreground"
              : "text-foreground",
            tone === "error" && "text-destructive",
          )}
        >
          {children}
        </div>
        {footer}
      </div>
    </article>
  );
}

export interface ChatToolGroupProps
  extends Omit<ComponentProps<"details">, "children" | "title"> {
  /** The folded line: "도구 호출 3개". */
  readonly summary: ReactNode;
  /** After the summary, such as "실행 중" or a failure mark. */
  readonly status?: ReactNode;
  /** `ChatToolItem`s, shown once the line is opened. */
  readonly children: ReactNode;
}

/**
 * The tool calls the other side made in a row, folded to one plain line
 * that opens to the list of calls. No frame until it is opened.
 */
export function ChatToolGroup({
  summary,
  status,
  className,
  children,
  ...props
}: ChatToolGroupProps): JSX.Element {
  return (
    <details
      data-slot="chat-tool-group"
      className={cn("group/tools min-w-0 text-control", className)}
      {...props}
    >
      <summary className="flex w-fit max-w-full cursor-pointer list-none items-center gap-1 rounded-control py-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="truncate">{summary}</span>
        <ChevronRight
          className="size-4 flex-none transition-transform group-open/tools:rotate-90 motion-reduce:transition-none"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {status}
      </summary>
      <ol className="m-0 mt-2 flex list-none flex-col divide-y rounded-card border p-0">
        {children}
      </ol>
    </details>
  );
}

export interface ChatToolItemProps
  extends Omit<ComponentProps<"li">, "children" | "title"> {
  /** The tool's name, in monospace. */
  readonly name: ReactNode;
  /** At the line's right end. */
  readonly time?: ReactNode;
  /** After the name, such as a failure mark. */
  readonly status?: ReactNode;
  /** Shown once the call is opened: its input and result. */
  readonly children?: ReactNode;
}

/** One call in an opened `ChatToolGroup`, itself opening to what it did. */
export function ChatToolItem({
  name,
  time,
  status,
  className,
  children,
  ...props
}: ChatToolItemProps): JSX.Element {
  return (
    <li
      data-slot="chat-tool-item"
      className={cn("min-w-0", className)}
      {...props}
    >
      <details className="group/tool min-w-0">
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <code className="min-w-0 truncate font-mono text-caption">
            {name}
          </code>
          {status}
          <ChevronRight
            className="size-4 flex-none text-muted-foreground transition-transform group-open/tool:rotate-90 motion-reduce:transition-none"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {time ? (
            <span className="ml-auto flex-none whitespace-nowrap text-caption text-muted-foreground">
              {time}
            </span>
          ) : null}
        </summary>
        {children ? (
          <div className="flex min-w-0 flex-col gap-2 px-4 pb-3">
            {children}
          </div>
        ) : null}
      </details>
    </li>
  );
}

/** A chat's messages in order, generously spaced. */
export function ChatList({
  className,
  ...props
}: ComponentProps<"ol">): JSX.Element {
  return (
    <ol
      data-slot="chat-list"
      className={cn(
        "m-0 flex min-w-0 list-none flex-col gap-6 p-0 [&>li]:min-w-0",
        className,
      )}
      {...props}
    />
  );
}
