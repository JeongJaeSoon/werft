import { answerTextInputSchema } from "@werft-ai/contracts";
import { Button, Field, FieldError, FieldLabel, Textarea } from "@werft-ai/ui";
import {
  type FormEvent,
  type JSX,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { Busy } from "./busy.tsx";

export interface AnswerForm {
  readonly shown: boolean;
  /** Opens the form; for its button's click. */
  readonly open: () => void;
  /** The button that opened the form, which a cancel hands focus back to. */
  readonly openerRef: RefObject<HTMLButtonElement | null>;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly fieldRef: RefObject<HTMLTextAreaElement | null>;
  readonly cancel: () => void;
}

/**
 * A form a permission request's button opens below: its field takes focus,
 * and a cancel hands focus back to the button.
 */
export function useAnswerForm(): AnswerForm {
  const [shown, setShown] = useState(false);
  const [text, setText] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  // Set when a cancel should hand focus back to the button that opened it.
  const returnFocus = useRef(false);

  useEffect(() => {
    if (shown) fieldRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      openerRef.current?.focus();
    }
  }, [shown]);

  return {
    shown,
    open: () => setShown(true),
    openerRef,
    text,
    setText,
    fieldRef,
    // A cancel drops the text; a refused send keeps it for the retry.
    cancel: () => {
      returnFocus.current = true;
      setText("");
      setShown(false);
    },
  };
}

interface FormProps {
  readonly form: AnswerForm;
  readonly pending: boolean;
  readonly blocked: boolean;
}

function FormButtons({
  pending,
  blocked,
  variant,
  submit,
  cancel,
  onCancel,
}: {
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly variant: "default" | "destructive";
  readonly submit: string;
  readonly cancel: string;
  readonly onCancel: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {/* Not `disabled`, which takes focus off the button just pressed. */}
      <Button
        type="submit"
        variant={variant}
        disabled={blocked && !pending}
        aria-disabled={pending || undefined}
      >
        <Busy shown={pending} />
        {submit}
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={pending}
        onClick={onCancel}
      >
        {cancel}
      </Button>
    </div>
  );
}

export interface DenialFormProps extends FormProps {
  readonly messages: {
    readonly denyReason: string;
    readonly denySubmit: string;
    readonly cancel: string;
  };
  /** Takes the trimmed reason; empty when none was given. */
  readonly onDeny: (reason: string) => void;
}

/** The form a deny button opens. The reason is optional, as the API's. */
export function DenialForm({
  form,
  messages,
  onDeny,
  pending,
  blocked,
}: DenialFormProps): JSX.Element {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked) onDeny(form.text.trim());
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field>
        <FieldLabel>{messages.denyReason}</FieldLabel>
        <Textarea
          ref={form.fieldRef}
          value={form.text}
          maxLength={1000}
          // What is typed while the denial is sent would go nowhere.
          readOnly={pending}
          onChange={(event) => form.setText(event.target.value)}
        />
      </Field>
      <FormButtons
        pending={pending}
        blocked={blocked}
        variant="destructive"
        submit={messages.denySubmit}
        cancel={messages.cancel}
        onCancel={form.cancel}
      />
    </form>
  );
}

export interface NoteFormProps extends FormProps {
  readonly messages: {
    readonly note: string;
    readonly noteSubmit: string;
    readonly noteRequired: string;
    readonly noteTooLong: string;
    readonly cancel: string;
  };
  /** Takes the trimmed instruction, which the API hands to the model. */
  readonly onAllow: (reason: string) => void;
}

/**
 * The form "allow with instruction" opens. Unlike a denial's reason, the
 * instruction is required: without one, the plain allow is the way.
 */
export function NoteForm({
  form,
  messages,
  onAllow,
  pending,
  blocked,
}: NoteFormProps): JSX.Element {
  const [problem, setProblem] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    const text = form.text.trim();
    const found =
      text === ""
        ? messages.noteRequired
        : answerTextInputSchema.safeParse(text).success
          ? undefined
          : messages.noteTooLong;
    setProblem(found);
    if (found === undefined) onAllow(text);
    else form.fieldRef.current?.focus();
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field>
        <FieldLabel>{messages.note}</FieldLabel>
        <Textarea
          ref={form.fieldRef}
          value={form.text}
          readOnly={pending}
          onChange={(event) => {
            form.setText(event.target.value);
            setProblem(undefined);
          }}
        />
        <FieldError>{problem}</FieldError>
      </Field>
      <FormButtons
        pending={pending}
        blocked={blocked}
        variant="default"
        submit={messages.noteSubmit}
        cancel={messages.cancel}
        onCancel={form.cancel}
      />
    </form>
  );
}
