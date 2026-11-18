import { Button, Field, FieldLabel, Textarea } from "@werft-ai/ui";
import {
  type FormEvent,
  type JSX,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { Busy } from "./busy.tsx";

export interface Denial {
  readonly denying: boolean;
  /** Opens the form; for the deny button's click. */
  readonly open: () => void;
  /** The deny button, which focus goes back to when the form is cancelled. */
  readonly denyRef: RefObject<HTMLButtonElement | null>;
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  readonly reasonRef: RefObject<HTMLTextAreaElement | null>;
  readonly cancel: () => void;
}

/**
 * A permission request's denial: the deny button opens a form below, its
 * reason field takes focus, and a cancel hands focus back to the button.
 */
export function useDenial(): Denial {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  // Set when a cancel should hand focus back to the button that opened it.
  const returnFocus = useRef(false);

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      denyRef.current?.focus();
    }
  }, [denying]);

  return {
    denying,
    open: () => setDenying(true),
    denyRef,
    reason,
    setReason,
    reasonRef,
    // A cancel drops the reason; a refused send keeps it for the retry.
    cancel: () => {
      returnFocus.current = true;
      setReason("");
      setDenying(false);
    },
  };
}

export interface DenialFormProps {
  readonly denial: Denial;
  readonly messages: {
    readonly denyReason: string;
    readonly denySubmit: string;
    readonly cancel: string;
  };
  /** Takes the trimmed reason; empty when none was given. */
  readonly onDeny: (reason: string) => void;
  readonly pending: boolean;
  readonly blocked: boolean;
}

/** The form a deny button opens. The reason is optional, as the API's. */
export function DenialForm({
  denial,
  messages,
  onDeny,
  pending,
  blocked,
}: DenialFormProps): JSX.Element {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked) onDeny(denial.reason.trim());
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field>
        <FieldLabel>{messages.denyReason}</FieldLabel>
        <Textarea
          ref={denial.reasonRef}
          value={denial.reason}
          maxLength={1000}
          // What is typed while the denial is sent would go nowhere.
          readOnly={pending}
          onChange={(event) => denial.setReason(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        {/* Not `disabled`, which takes focus off the button just pressed. */}
        <Button
          type="submit"
          variant="destructive"
          disabled={blocked && !pending}
          aria-disabled={pending || undefined}
        >
          <Busy shown={pending} />
          {messages.denySubmit}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={denial.cancel}
        >
          {messages.cancel}
        </Button>
      </div>
    </form>
  );
}
