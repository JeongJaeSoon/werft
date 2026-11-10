import {
  Badge,
  Button,
  CodeBlock,
  cn,
  Field,
  FieldError,
  FieldLabel,
  formatTimestamp,
  RowAction,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { Hourglass } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type {
  ApprovalCardMessages,
  ApprovalCardProps,
} from "./approval-card.tsx";
import { Busy } from "./busy.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";
import { ToolSummary } from "./tool-summary.tsx";

export interface ApprovalRowMessages extends ApprovalCardMessages {
  /**
   * The allow button's accessible name: what it approves, such as the tool
   * and the session's short id. Starts with `allow`, the visible word.
   */
  readonly allowName: (tool: string) => string;
  readonly denyName: (tool: string) => string;
}

export interface ApprovalRowProps extends Omit<ApprovalCardProps, "messages"> {
  readonly messages: ApprovalRowMessages;
  /**
   * Draws the row as a list line under its session: this on the first line
   * with the request as a badge, `meta` and the expiry below. `subject` is
   * then not shown.
   */
  readonly heading?: ReactNode;
  /** The second line's lead, such as the session's short id and its wait. */
  readonly meta?: ReactNode;
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * One permission request on one line: what asks, for which session and until
 * when, with allow and deny at the line's end. The tool input and the denial
 * form open below the line. Answers the same way as `ApprovalCard`.
 */
export function ApprovalRow({
  request,
  messages,
  onAllow,
  onDeny,
  pending = false,
  disabled = false,
  error,
  now = Date.now(),
  locale = "ko",
  subject,
  heading,
  meta,
  className,
}: ApprovalRowProps): JSX.Element {
  const titleId = useId();
  const inputId = useId();
  const [inputOpen, setInputOpen] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  // Set when a cancel should hand focus back to the button that opened it.
  const returnFocus = useRef(false);
  const expired = useExpired(request.request_id, request.expires_at, now);
  const { noticeRef, within } = useExpiryFocus(expired);
  const blocked = pending || disabled;

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      denyRef.current?.focus();
    }
  }, [denying]);

  const notice = (
    <Text ref={noticeRef} variant="meta" tabIndex={expired ? -1 : undefined}>
      {expired
        ? messages.expired
        : messages.expires(formatTimestamp(request.expires_at, locale))}
    </Text>
  );
  const inputToggle = (
    <details
      className="min-w-0"
      onToggle={(event) => setInputOpen(event.currentTarget.open)}
    >
      <summary
        // Only while open: a closed input is not in the DOM to name.
        aria-controls={inputOpen ? inputId : undefined}
        className="cursor-pointer text-muted-foreground text-caption"
      >
        {messages.input}
      </summary>
    </details>
  );

  const submitDenial = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed) onDeny(trimmed);
  };

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={pending || undefined}
      data-slot="approval-row"
      data-expired={expired || undefined}
      className={cn(
        "flex min-h-[var(--werft-row-min-height)] min-w-0 flex-col gap-3 px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)] text-control",
        // A list line sits in its list's frame; a lone row carries its own.
        heading === undefined &&
          "rounded-card border border-[var(--werft-tone-attention-border)] bg-[var(--werft-tone-attention-bg)]",
        className,
      )}
      {...within}
    >
      <div
        className={cn(
          "flex flex-wrap justify-end gap-x-4 gap-y-2",
          heading === undefined ? "items-start" : "items-center",
        )}
      >
        {/* At least the buttons' height, centred, so the two read as one
            line; wrapped lines keep their own height. */}
        {heading === undefined ? (
          <div className="flex min-h-[var(--werft-control-height)] min-w-0 flex-1 basis-60 flex-wrap content-center items-center gap-x-4 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2">
              <Hourglass
                className="size-4 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {/* Not a heading: the level depends on the screen around the row. */}
              <Text
                id={titleId}
                className="font-semibold text-body [overflow-wrap:anywhere]"
              >
                {messages.title(request.tool)}
              </Text>
              {/* Each separator wraps with the item after it, never left trailing. */}
              {subject === undefined ? null : (
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
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                {notice}
              </span>
            </div>
            <ToolSummary summary={request.summary} verb={messages.summary} />
            {/* The input opens below the whole line, so the summary stays put. */}
            {inputToggle}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
            <Text
              id={titleId}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium text-control leading-5"
            >
              {/* On a narrow line the badge goes under the title rather than
                  both being cut; a long tool name is still cut, never pushed
                  past the frame. */}
              <span className="min-w-16 max-w-full truncate">{heading}</span>
              <Badge variant="amber" className="min-w-0 max-w-full shrink">
                <span className="truncate">{messages.title(request.tool)}</span>
              </Badge>
            </Text>
            {/* A space either side of each dot, as inside `meta`; each dot
                wraps with the item after it, never left trailing. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-caption text-muted-foreground leading-4">
              {meta === undefined ? null : (
                <span className="min-w-0 [overflow-wrap:anywhere]">{meta}</span>
              )}
              <span className="flex items-center gap-1">
                {meta === undefined ? null : <span aria-hidden="true">·</span>}
                {notice}
              </span>
            </div>
            <ToolSummary summary={request.summary} verb={messages.summary} />
            {/* Its own line: after a dot it wrapped alone on a narrow line. */}
            {inputToggle}
          </div>
        )}
        {expired || denying ? null : (
          <div className="flex shrink-0 gap-2">
            <RowAction
              variant="default"
              disabled={blocked}
              aria-label={messages.allowName(request.tool)}
              onClick={onAllow}
            >
              <Busy shown={pending} />
              {messages.allow}
            </RowAction>
            <RowAction
              ref={denyRef}
              disabled={blocked}
              aria-label={messages.denyName(request.tool)}
              onClick={() => setDenying(true)}
            >
              {messages.deny}
            </RowAction>
          </div>
        )}
      </div>
      {inputOpen ? (
        <CodeBlock id={inputId} className="max-h-60 overflow-y-auto">
          {inputText(request.input)}
        </CodeBlock>
      ) : null}
      <FieldError>{error}</FieldError>
      {expired || !denying ? null : (
        <form className="flex flex-col gap-3" onSubmit={submitDenial}>
          <Field>
            <FieldLabel>{messages.denyReason}</FieldLabel>
            <Textarea
              ref={reasonRef}
              value={reason}
              required
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="submit"
              variant="destructive"
              disabled={blocked || !reason.trim()}
            >
              <Busy shown={pending} />
              {messages.denySubmit}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                returnFocus.current = true;
                setDenying(false);
              }}
            >
              {messages.cancel}
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
