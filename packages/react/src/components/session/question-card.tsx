import type { PendingRequest } from "@werft-ai/contracts";
import {
  Button,
  Checkbox,
  cn,
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  formatTimestamp,
  Input,
  RadioGroup,
  RadioGroupItem,
  Text,
  Textarea,
  type TimestampLocale,
} from "@werft-ai/ui";
import { Hourglass } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  useId,
  useRef,
  useState,
} from "react";

import { Busy } from "./busy.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";
import { RequestCard } from "./request-card.tsx";

export type QuestionRequest = Extract<PendingRequest, { kind: "question" }>;
type Question = QuestionRequest["questions"][number];

/** One question's answer, as the answers endpoint takes it. */
export interface QuestionAnswer {
  readonly question_id: string;
  readonly selected_option_ids: string[];
  readonly free_text?: string;
}

export interface QuestionCardMessages {
  readonly title: string;
  /** Takes the formatted expiry time. */
  readonly expires: (at: string) => string;
  readonly expired: string;
  /** Labels the free-text field of a question that allows one. */
  readonly freeText: string;
  /** Shown under a question left without a choice or text. */
  readonly unanswered: string;
  readonly submit: string;
}

export interface QuestionCardProps {
  readonly request: QuestionRequest;
  readonly messages: QuestionCardMessages;
  /** Every question answered, in the order asked. */
  readonly onSubmit: (answers: QuestionAnswer[]) => void;
  /** An answer was sent and its receipt has not come back. */
  readonly pending?: boolean | undefined;
  /** The reader may not answer; the screen says why next to the card. */
  readonly disabled?: boolean | undefined;
  /** Why the last answer was refused. */
  readonly error?: string | undefined;
  /** Epoch ms the expiry is compared against; the screen's clock. */
  readonly now?: number | undefined;
  readonly locale?: TimestampLocale | undefined;
  /**
   * "plain" drops the card's frame and title line, for a list line that
   * already names the question and its expiry; an expired notice still shows.
   */
  readonly variant?: "card" | "plain" | undefined;
  readonly className?: string | undefined;
}

interface Draft {
  readonly selected: readonly string[];
  readonly text: string;
}

const EMPTY: Draft = { selected: [], text: "" };

function answerOf(question: Question, draft: Draft): QuestionAnswer | null {
  const text = question.allow_free_text ? draft.text.trim() : "";
  if (draft.selected.length === 0 && !text) return null;
  return {
    question_id: question.question_id,
    selected_option_ids: [...draft.selected],
    ...(text ? { free_text: text } : {}),
  };
}

export function QuestionCard({
  request,
  messages,
  onSubmit,
  pending = false,
  disabled = false,
  error,
  now = Date.now(),
  locale = "ko",
  variant = "card",
  className,
}: QuestionCardProps): JSX.Element {
  const titleId = useId();
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [tried, setTried] = useState(false);
  const expired = useExpired(request.request_id, request.expires_at, now);
  const { noticeRef, within } = useExpiryFocus(expired);

  const draftOf = (question: Question) => drafts[question.question_id] ?? EMPTY;
  const edit = (question: Question, change: Partial<Draft>) =>
    setDrafts((current) => ({
      ...current,
      [question.question_id]: {
        ...(current[question.question_id] ?? EMPTY),
        ...change,
      },
    }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const answers = request.questions.map((question) =>
      answerOf(question, draftOf(question)),
    );
    if (answers.some((answer) => answer === null)) {
      setTried(true);
      return;
    }
    onSubmit(answers as QuestionAnswer[]);
  };

  return (
    <RequestCard
      titleId={titleId}
      icon={Hourglass}
      title={messages.title}
      variant={variant}
      headHidden={variant === "plain" && !expired}
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
      aria-busy={pending || undefined}
      slot="question-card"
      data-expired={expired || undefined}
      className={className}
      {...within}
    >
      <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
        {request.questions.map((question) => (
          <QuestionFields
            key={question.question_id}
            question={question}
            draft={draftOf(question)}
            onChange={(change) => edit(question, change)}
            disabled={expired || pending || disabled}
            freeTextLabel={messages.freeText}
            unanswered={
              tried && answerOf(question, draftOf(question)) === null
                ? messages.unanswered
                : undefined
            }
          />
        ))}
        <FieldError>{error}</FieldError>
        {expired ? null : (
          <Button
            type="submit"
            size="sm"
            className="self-end"
            disabled={pending || disabled}
          >
            <Busy shown={pending} />
            {messages.submit}
          </Button>
        )}
      </form>
    </RequestCard>
  );
}

function QuestionFields({
  question,
  draft,
  onChange,
  disabled,
  freeTextLabel,
  unanswered,
}: {
  readonly question: Question;
  readonly draft: Draft;
  readonly onChange: (change: Partial<Draft>) => void;
  readonly disabled: boolean;
  readonly freeTextLabel: string;
  readonly unanswered: string | undefined;
}) {
  const legendId = useId();
  const textRef = useRef<HTMLInputElement>(null);
  const options = question.options;
  const toggle = (id: string) =>
    onChange({
      selected: draft.selected.includes(id)
        ? draft.selected.filter((other) => other !== id)
        : [...draft.selected, id],
    });

  // A row's number picks it, as long as the key is not typed into the text.
  const pickByNumber = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0) return;
    const option = options[index];
    if (option) {
      event.preventDefault();
      if (question.multi_select) toggle(option.option_id);
      else onChange({ selected: [option.option_id] });
    } else if (index === options.length && question.allow_free_text) {
      event.preventDefault();
      textRef.current?.focus();
    }
  };

  if (options.length === 0) {
    return (
      <FieldSet className="m-0 gap-2 border-0 p-0">
        <FieldLegend
          variant="label"
          className="mb-1 text-control [overflow-wrap:anywhere]"
        >
          {question.prompt}
        </FieldLegend>
        {question.allow_free_text ? (
          <Field>
            <FieldLabel className="sr-only">{freeTextLabel}</FieldLabel>
            <Textarea
              disabled={disabled}
              value={draft.text}
              placeholder={`${freeTextLabel}…`}
              className="min-h-0 bg-card [field-sizing:content]"
              rows={1}
              onChange={(event) => onChange({ text: event.target.value })}
            />
          </Field>
        ) : null}
        <FieldError>{unanswered}</FieldError>
      </FieldSet>
    );
  }

  const freeText = question.allow_free_text ? (
    <li className={cn(ROW, "cursor-text")}>
      <Input
        ref={textRef}
        aria-label={freeTextLabel}
        placeholder={`${freeTextLabel}…`}
        disabled={disabled}
        value={draft.text}
        maxLength={1000}
        className="h-auto flex-1 rounded-none border-0 bg-transparent p-0 focus-visible:outline-none enabled:not-aria-invalid:hover:border-0"
        onChange={(event) => onChange({ text: event.target.value })}
      />
      <Key n={options.length + 1} on={draft.text.trim() !== ""} />
    </li>
  ) : null;

  return (
    <FieldSet className="m-0 gap-2 border-0 p-0" onKeyDown={pickByNumber}>
      <FieldLegend
        id={legendId}
        variant="label"
        className="mb-1 text-control [overflow-wrap:anywhere]"
      >
        {question.prompt}
      </FieldLegend>
      {question.multi_select ? (
        <ul className={LIST}>
          {options.map((option, index) => {
            const on = draft.selected.includes(option.option_id);
            return (
              <li key={option.option_id}>
                <FieldLabel className={ROW}>
                  <Checkbox
                    className={HIDDEN}
                    disabled={disabled}
                    checked={on}
                    onCheckedChange={() => toggle(option.option_id)}
                  />
                  <span className="min-w-0 flex-1">{option.label}</span>
                  <Key n={index + 1} on={on} />
                </FieldLabel>
              </li>
            );
          })}
          {freeText}
        </ul>
      ) : (
        <div className={LIST}>
          <RadioGroup
            aria-labelledby={legendId}
            className="flex flex-col gap-0 divide-y"
            disabled={disabled}
            value={draft.selected[0] ?? ""}
            onValueChange={(value) => onChange({ selected: [value] })}
          >
            {options.map((option, index) => (
              <FieldLabel key={option.option_id} className={ROW}>
                <RadioGroupItem className={HIDDEN} value={option.option_id} />
                <span className="min-w-0 flex-1">{option.label}</span>
                <Key
                  n={index + 1}
                  on={draft.selected.includes(option.option_id)}
                />
              </FieldLabel>
            ))}
          </RadioGroup>
          {freeText ? <ul className="m-0 list-none p-0">{freeText}</ul> : null}
        </div>
      )}
      <FieldError>{unanswered}</FieldError>
    </FieldSet>
  );
}

// The control spans its row unseen, so the row is what is clicked and ringed.
const HIDDEN =
  "absolute inset-0 aspect-auto size-auto rounded-none border-0 bg-transparent opacity-0";

// Each choice is a row of one list, as in a chat app's picker: the words on
// the left, the number that picks it on the right. The control itself is out
// of sight; the row's fill says what is chosen, its ring where focus is.
const LIST =
  "m-0 flex list-none flex-col divide-y overflow-hidden rounded-card border bg-card p-0";
const ROW =
  "relative flex min-h-9 w-full cursor-pointer items-center gap-3 px-3 py-1.5 font-normal text-control [overflow-wrap:anywhere] hover:bg-muted has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-focus-ring has-[[data-state=checked]]:bg-[var(--werft-tone-progress-bg)] has-disabled:cursor-not-allowed has-disabled:opacity-50";

/** The number that picks a row, filled once the row is chosen. */
function Key({ n, on }: { readonly n: number; readonly on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 flex-none items-center justify-center rounded-md text-caption tabular-nums",
        on
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground",
      )}
    >
      {n}
    </span>
  );
}
