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

import { Busy } from "./busy.tsx";
import { DenialForm, useDenial } from "./denial.tsx";
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
  /** The label of the denial form's reason field, which is optional. */
  readonly denyReason: string;
  readonly denySubmit: string;
  readonly cancel: string;
}

export interface ApprovalCardProps {
  readonly request: PermissionRequest;
  readonly messages: ApprovalCardMessages;
  /**
   * Takes no text: the worker drops an allow's reason and the runtime's
   * allow has no room for one, so a field here would reach no model.
   */
  readonly onAllow: () => void;
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
  const denial = useDenial();
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
      {expired ? null : denial.denying ? (
        <DenialForm
          denial={denial}
          messages={messages}
          onDeny={onDeny}
          pending={pending}
          blocked={blocked}
        />
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            disabled={blocked}
            onClick={() => onAllow()}
          >
            <Busy shown={pending} />
            {messages.allow}
          </Button>
          <Button
            ref={denial.denyRef}
            type="button"
            variant="outline"
            size="sm"
            className="bg-card"
            disabled={blocked}
            onClick={denial.open}
          >
            {messages.deny}
          </Button>
        </div>
      )}
    </RequestCard>
  );
}
