import type { PendingRequest, ToolVerbMessage } from "@werft-ai/contracts";
import {
  Button,
  CodeBlock,
  Field,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Input,
  Text,
  type TimestampLocale,
} from "@werft-ai/ui";
import { ShieldCheck } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useId,
  useState,
} from "react";

import { Busy } from "./busy.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";
import { RequestCard } from "./request-card.tsx";

export type PermissionRequest = Extract<PendingRequest, { kind: "permission" }>;

export interface ApprovalCardMessages {
  /** Names the card for screen readers: what asks, and for which tool. */
  readonly title: (tool: string) => string;
  /** The bold line by the shield: "승인 대기". Falls back to `title`. */
  readonly heading?: string | undefined;
  /** Words the verb of the request's `summary`; without it no summary shows. */
  readonly summary?: ((verb: ToolVerbMessage) => string) | undefined;
  /** Names the folded view of the tool input. */
  readonly input: string;
  /** Takes the formatted expiry time. */
  readonly expires: (at: string) => string;
  readonly expired: string;
  readonly allow: string;
  readonly deny: string;
  /** The denial form's reason label, where a caller still opens one. */
  readonly denyReason: string;
  /** The optional answer field's label: "답변 (선택)". */
  readonly answer?: string | undefined;
  /** The answer field's placeholder. */
  readonly answerPlaceholder?: string | undefined;
  /** Kept for callers that still pass it; the card no longer opens a form. */
  readonly denySubmit?: string | undefined;
  readonly cancel?: string | undefined;
}

export interface ApprovalCardProps {
  readonly request: PermissionRequest;
  readonly messages: ApprovalCardMessages;
  /** Takes what the person typed in the answer field, if anything. */
  readonly onAllow: (reason?: string) => void;
  /** Takes what the person typed; empty when they gave no reason. */
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
  const [answer, setAnswer] = useState("");
  const expired = useExpired(request.request_id, request.expires_at, now);
  const { noticeRef, within } = useExpiryFocus(expired);
  const blocked = pending || disabled;
  const reason = answer.trim();
  const summary =
    request.summary !== undefined && messages.summary !== undefined
      ? request.summary
      : undefined;

  const allow = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked) onAllow(reason || undefined);
  };

  return (
    <RequestCard
      titleId={titleId}
      icon={ShieldCheck}
      title={messages.heading ?? messages.title(request.tool)}
      label={messages.title(request.tool)}
      subject={subject}
      notice={
        <Text
          ref={noticeRef}
          variant="meta"
          tabIndex={expired ? -1 : undefined}
        >
          {expired
            ? messages.expired
            : messages.expires(formatTimestamp(request.expires_at, locale))}
        </Text>
      }
      slot="approval-card"
      aria-busy={pending || undefined}
      data-expired={expired || undefined}
      className={className}
      {...within}
    >
      {summary !== undefined && messages.summary !== undefined ? (
        <div data-slot="tool-summary" className="flex min-w-0 flex-col gap-2">
          <Text className="text-body text-foreground [overflow-wrap:anywhere]">
            {messages.summary(summary.verb)}
            {summary.target === null ? null : <> · {summary.target}</>}
          </Text>
          {summary.excerpt === null ? null : (
            <CodeBlock className="max-h-24 overflow-y-auto">
              {summary.excerpt}
            </CodeBlock>
          )}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 rounded-control bg-muted px-2 py-1 font-mono text-caption [overflow-wrap:anywhere]">
          {request.tool}
        </code>
        <details className="min-w-0 basis-full">
          <summary className="w-fit cursor-pointer rounded-control py-1 text-caption text-muted-foreground">
            {messages.input}
          </summary>
          <CodeBlock className="mt-2 max-h-60 overflow-y-auto">
            {inputText(request.input)}
          </CodeBlock>
        </details>
      </div>
      <FieldError>{error}</FieldError>
      {expired ? null : (
        <form className="flex flex-col gap-3" onSubmit={allow}>
          <Field>
            <FieldLabel>{messages.answer ?? messages.denyReason}</FieldLabel>
            <Input
              value={answer}
              maxLength={1000}
              placeholder={messages.answerPlaceholder}
              disabled={disabled}
              className="bg-card"
              onChange={(event) => setAnswer(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={blocked}>
              <Busy shown={pending} />
              {messages.allow}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="bg-card"
              disabled={blocked}
              onClick={() => onDeny(reason)}
            >
              {messages.deny}
            </Button>
          </div>
        </form>
      )}
    </RequestCard>
  );
}
