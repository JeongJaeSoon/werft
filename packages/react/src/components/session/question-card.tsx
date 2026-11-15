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
  RadioGroup,
  RadioGroupItem,
  Text,
  Textarea,
  type TimestampLocale,
} from "@werft-ai/ui";
import { ChevronDown, Hourglass } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  useEffect,
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
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
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
  const options = question.options;
  return (
    <FieldSet className="m-0 gap-2 border-0 p-0">
      <FieldLegend
        id={legendId}
        variant="label"
        className="mb-2 text-body [overflow-wrap:anywhere]"
      >
        {question.prompt}
      </FieldLegend>
      {options.length === 0 ? null : question.multi_select ? (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <FieldLabel key={option.option_id} className={CHIP}>
              <Checkbox
                disabled={disabled}
                checked={draft.selected.includes(option.option_id)}
                onCheckedChange={(checked) =>
                  onChange({
                    selected:
                      checked === true
                        ? [...draft.selected, option.option_id]
                        : draft.selected.filter(
                            (id) => id !== option.option_id,
                          ),
                  })
                }
              />
              {option.label}
            </FieldLabel>
          ))}
        </div>
      ) : (
        <RadioGroup
          aria-labelledby={legendId}
          className="flex flex-wrap gap-2"
          disabled={disabled}
          value={draft.selected[0] ?? ""}
          onValueChange={(value) => onChange({ selected: [value] })}
        >
          {options.map((option) => (
            <FieldLabel key={option.option_id} className={CHIP}>
              <RadioGroupItem value={option.option_id} />
              {option.label}
            </FieldLabel>
          ))}
        </RadioGroup>
      )}
      {!question.allow_free_text ? null : options.length === 0 ? (
        <Field>
          <FieldLabel>{freeTextLabel}</FieldLabel>
          <Textarea
            disabled={disabled}
            value={draft.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        </Field>
      ) : (
        <FreeText
          label={freeTextLabel}
          text={draft.text}
          onChange={(text) => onChange({ text })}
          disabled={disabled}
          unanswered={unanswered !== undefined}
        />
      )}
      <FieldError>{unanswered}</FieldError>
    </FieldSet>
  );
}

// The label wraps its control, so the whole chip toggles it; `relative` keeps
// Radix's hidden form input inside the chip.
const CHIP =
  "relative min-h-[var(--werft-control-height)] max-w-full cursor-pointer rounded-control border border-input bg-card px-3 py-1 text-control [overflow-wrap:anywhere] has-disabled:cursor-not-allowed has-disabled:opacity-50";

/** Free text beside options starts folded; folding keeps what was written. */
function FreeText({
  label,
  text,
  onChange,
  disabled,
  unanswered,
}: {
  readonly label: string;
  readonly text: string;
  readonly onChange: (text: string) => void;
  readonly disabled: boolean;
  readonly unanswered: boolean;
}) {
  const toggleId = useId();
  const textId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const focusOnOpen = useRef(false);
  const [open, setOpen] = useState(text !== "");
  // The way to answer an unanswered question has to be in sight.
  if (unanswered && !open) setOpen(true);

  useEffect(() => {
    if (open && focusOnOpen.current) textRef.current?.focus();
    focusOnOpen.current = false;
  }, [open]);

  return (
    <>
      <Button
        id={toggleId}
        type="button"
        variant="link"
        size="sm"
        className="self-start px-0 text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls={textId}
        disabled={disabled}
        onClick={() => {
          focusOnOpen.current = !open;
          setOpen(!open);
        }}
      >
        <ChevronDown
          className={cn(
            "transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
        {label}
      </Button>
      <Textarea
        ref={textRef}
        id={textId}
        aria-labelledby={toggleId}
        hidden={!open}
        // The textarea's own `flex` would beat the attribute.
        className={cn(!open && "hidden")}
        disabled={disabled}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}
