import {
  Button,
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { ArrowRight } from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type SetStateAction,
  useId,
  useState,
} from "react";

export interface ComposerQueuedMessage {
  readonly id: string;
  readonly text: string;
}

export interface ComposerMessages {
  readonly label: string;
  readonly send: string;
  /** Under the field, e.g. how to send from the keyboard. */
  readonly hint?: string | undefined;
  /** Names the list of messages waiting for the current turn to end. */
  readonly queued: string;
}

export interface ComposerProps {
  readonly messages: ComposerMessages;
  /**
   * Resolves once the server accepted the message; the field clears only
   * then. A rejection keeps the text so nothing typed is lost.
   */
  readonly onSend: (text: string) => unknown;
  readonly pending?: boolean | undefined;
  /** The session takes no messages now; `disabledReason` says why. */
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly error?: string | undefined;
  readonly queued?: readonly ComposerQueuedMessage[] | undefined;
  readonly placeholder?: string | undefined;
  readonly className?: string | undefined;
  /**
   * The draft held by the screen, so it outlives the composer when the
   * screen moves it. Without these the composer keeps its own.
   */
  readonly value?: string | undefined;
  readonly onValueChange?: Dispatch<SetStateAction<string>> | undefined;
}

export function Composer({
  messages,
  onSend,
  pending = false,
  disabled = false,
  disabledReason,
  error,
  queued = [],
  placeholder,
  className,
  value,
  onValueChange,
}: ComposerProps): JSX.Element {
  const [ownText, setOwnText] = useState("");
  const text = value ?? ownText;
  const setText = onValueChange ?? setOwnText;
  // Locks out a second send of the same text before `onSend` settles, even
  // when the screen does not pass `pending`.
  const [sending, setSending] = useState(false);
  const queuedId = useId();
  const blocked = disabled || pending || sending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || blocked) return;
    setSending(true);
    try {
      await onSend(message);
      // The field stays editable while sending: keep anything typed since.
      setText((current) => (current.trim() === message ? "" : current));
    } catch {
      // The screen shows why through `error`; the text stays for a retry.
    } finally {
      setSending(false);
    }
  };

  const sendFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <div
      data-slot="composer"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      {queued.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Text id={queuedId} variant="meta">
            {messages.queued}
          </Text>
          <ol aria-labelledby={queuedId} className="flex flex-col gap-1">
            {queued.map((message) => (
              <li
                key={message.id}
                className="rounded-card border border-dashed px-3 py-2 text-control leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {message.text}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <form className="flex items-start gap-2" onSubmit={submit}>
        <Field data-disabled={disabled || undefined} className="min-w-0 flex-1">
          {/* One line at rest; the label stays for screen readers. */}
          <FieldLabel className="sr-only">{messages.label}</FieldLabel>
          <Textarea
            rows={1}
            className="min-h-[var(--werft-control-height)]"
            value={text}
            placeholder={placeholder ?? messages.label}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendFromKeyboard}
          />
          {disabled && disabledReason ? (
            <FieldDescription>{disabledReason}</FieldDescription>
          ) : messages.hint ? (
            <FieldDescription>{messages.hint}</FieldDescription>
          ) : null}
          <FieldError>{error}</FieldError>
        </Field>
        <Button
          type="submit"
          size="icon"
          className="size-[var(--werft-control-height)] shrink-0 rounded-full"
          aria-label={messages.send}
          title={messages.send}
          disabled={blocked || !text.trim()}
          aria-busy={pending || sending || undefined}
        >
          <ArrowRight strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}
