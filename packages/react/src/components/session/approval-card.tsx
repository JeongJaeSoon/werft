import type { PendingRequest, ToolVerbMessage } from "@werft-ai/contracts";
import {
  Button,
  CodeBlock,
  cn,
  Field,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Text,
  Textarea,
  type TimestampLocale,
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

import { Busy } from "./busy.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";
import { ToolSummary } from "./tool-summary.tsx";

export type PermissionRequest = Extract<PendingRequest, { kind: "permission" }>;

export interface ApprovalCardMessages {
  readonly title: (tool: string) => string;
  /** Words the verb of the request's `summary`; without it no summary shows. */
  readonly summary?: ((verb: ToolVerbMessage) => string) | undefined;
  /** Names the folded view of the tool input. */
  readonly input: string;
  /** Takes the formatted expiry time. */
  readonly expires: (at: string) => string;
  readonly expired: string;
  readonly allow: string;
  readonly deny: string;
  readonly denyReason: string;
  readonly denySubmit: string;
  readonly cancel: string;
}

export interface ApprovalCardProps {
  readonly request: PermissionRequest;
  readonly messages: ApprovalCardMessages;
  readonly onAllow: () => void;
  /** A denial always carries the reason the person typed. */
  readonly onDeny: (reason: string) => void;
  /** An answer was sent and its receipt has not come back. */
  readonly pending?: boolean | undefined;
  /** The reader may not answer; the screen says why next to the card. */
  readonly disabled?: boolean | undefined;
  /** Why the last answer was refused. */
  readonly error?: string | undefined;
  /** Epoch ms the expiry is compared against; the screen's clock. */
  readonly now?: number | undefined;
  readonly locale?: TimestampLocale | undefined;
  /** What the request belongs to, such as a link to its session; shown on the title line. */
  readonly subject?: ReactNode;
  readonly className?: string | undefined;
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

export function ApprovalCard({
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
  className,
}: ApprovalCardProps): JSX.Element {
  const titleId = useId();
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

  const submitDenial = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed) onDeny(trimmed);
  };

  return (
    // An article, not a section: two requests for the same tool would make
    // two landmarks with one name.
    <article
      aria-labelledby={titleId}
      aria-busy={pending || undefined}
      data-slot="approval-card"
      data-expired={expired || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-card border border-[var(--werft-tone-attention-border)] bg-[var(--werft-tone-attention-bg)] p-4 text-control",
        className,
      )}
      {...within}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Hourglass
          className="size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* Not a heading: the level depends on the screen around the card. */}
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
          <Text
            ref={noticeRef}
            variant="meta"
            tabIndex={expired ? -1 : undefined}
          >
            {expired
              ? messages.expired
              : messages.expires(formatTimestamp(request.expires_at, locale))}
          </Text>
        </span>
      </div>
      <ToolSummary summary={request.summary} verb={messages.summary} />
      {/* Full width on its own line, so an opened input never shares a row with the buttons. */}
      <details className="min-w-0">
        <summary className="cursor-pointer rounded-control py-1 text-muted-foreground text-caption">
          {messages.input}
        </summary>
        <CodeBlock className="mt-2 max-h-60 overflow-y-auto">
          {inputText(request.input)}
        </CodeBlock>
      </details>
      <FieldError>{error}</FieldError>
      {expired || denying ? null : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={blocked} onClick={onAllow}>
            <Busy shown={pending} />
            {messages.allow}
          </Button>
          <Button
            ref={denyRef}
            type="button"
            variant="outline"
            disabled={blocked}
            onClick={() => setDenying(true)}
          >
            {messages.deny}
          </Button>
        </div>
      )}
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
          <div className="flex flex-wrap gap-2">
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
