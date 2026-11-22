import type { PendingRequest, ToolVerbMessage } from "@werft-ai/contracts";
import {
  Button,
  CodeBlock,
  FieldError,
  formatTimestamp,
  Text,
  type TimestampLocale,
} from "@werft-ai/ui";
import { ShieldCheck } from "lucide-react";
import { type JSX, type ReactNode, useId } from "react";

import { AnswerForms, useAnswerForm } from "./answer-form.tsx";
import { Busy } from "./busy.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";
import { inputText } from "./input-text.ts";
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
  /** The label of the denial form's reason field, which is optional. */
  readonly denyReason: string;
  readonly denySubmit: string;
  readonly cancel: string;
  /** The button that opens the instruction field. */
  readonly allowNote: string;
  /** The label of the instruction field, which is required. */
  readonly note: string;
  readonly noteSubmit: string;
  /** The field is blank: plain allow is the way without one. */
  readonly noteRequired: string;
  /** Over the API's 8 KiB of UTF-8. */
  readonly noteTooLong: string;
}

export interface ApprovalCardProps {
  readonly request: PermissionRequest;
  readonly messages: ApprovalCardMessages;
  /**
   * Takes the trimmed instruction from "allow with instruction", which the
   * API hands to the model with the approval; none from the plain allow.
   */
  readonly onAllow: (reason?: string) => void;
  /** Takes the trimmed reason; empty when the person gave none. */
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
  const denial = useAnswerForm();
  const note = useAnswerForm();
  const expired = useExpired(request.request_id, request.expires_at, now);
  const { noticeRef, within } = useExpiryFocus(expired);
  const blocked = pending || disabled;
  const summary =
    request.summary !== undefined && messages.summary !== undefined
      ? request.summary
      : undefined;

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
          <Text className="text-control text-foreground [overflow-wrap:anywhere]">
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
      <details className="group/input min-w-0">
        <summary className="w-fit cursor-pointer rounded-control py-0.5 text-caption text-muted-foreground hover:text-foreground">
          {messages.input}
        </summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <code className="w-fit max-w-full rounded-control bg-muted px-2 py-0.5 font-mono text-caption [overflow-wrap:anywhere]">
            {request.tool}
          </code>
          <CodeBlock className="max-h-60 overflow-y-auto">
            {inputText(request.input)}
          </CodeBlock>
        </div>
      </details>
      <FieldError>{error}</FieldError>
      {expired ? null : denial.shown || note.shown ? (
        <AnswerForms
          denial={denial}
          note={note}
          messages={messages}
          onDeny={onDeny}
          onAllow={onAllow}
          pending={pending}
          blocked={blocked}
        />
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          {/* While sending, not `disabled`: Chrome takes focus off a disabled
              button, and the keyboard would lose its place. */}
          <Button
            type="button"
            size="sm"
            disabled={blocked && !pending}
            aria-disabled={pending || undefined}
            onClick={() => {
              if (!blocked) onAllow();
            }}
          >
            <Busy shown={pending} />
            {messages.allow}
          </Button>
          <Button
            ref={note.openerRef}
            type="button"
            variant="outline"
            size="sm"
            className="bg-card"
            disabled={blocked && !pending}
            aria-disabled={pending || undefined}
            onClick={() => {
              if (!blocked) note.open();
            }}
          >
            {messages.allowNote}
          </Button>
          <Button
            ref={denial.openerRef}
            type="button"
            variant="outline"
            size="sm"
            className="bg-card"
            disabled={blocked && !pending}
            aria-disabled={pending || undefined}
            onClick={() => {
              if (!blocked) denial.open();
            }}
          >
            {messages.deny}
          </Button>
        </div>
      )}
    </RequestCard>
  );
}
