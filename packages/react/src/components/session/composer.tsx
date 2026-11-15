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
import { ArrowUp } from "lucide-react";
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

  // Enter sends and Shift+Enter breaks the line, as a chat does. Not while
  // an IME composes: Enter then picks the Korean or Japanese word.
  const sendFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
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
      <form onSubmit={submit}>
        <Field data-disabled={disabled || undefined} className="relative gap-1">
          <FieldLabel className="sr-only">{messages.label}</FieldLabel>
          {/* One line that grows with the text; the send button sits beside it. */}
          <div className="flex min-w-0 items-end gap-2">
            {/* The shell draws the field's focus ring: the textarea's own
                would be a second one inside it, on other corners. */}
            <div className="flex min-w-0 flex-1 items-center rounded-card border bg-card px-3 py-1 has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-focus-ring has-[textarea:disabled]:opacity-60">
              <Textarea
                rows={1}
                value={text}
                placeholder={placeholder}
                disabled={disabled}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={sendFromKeyboard}
                className="max-h-40 min-h-8 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none [field-sizing:content] focus-visible:outline-0 disabled:opacity-100"
              />
            </div>
            <Button
              type="submit"
              size="icon"
              className="mb-1 size-9 flex-none rounded-full"
              disabled={blocked || !text.trim()}
              aria-busy={pending || sending || undefined}
              aria-label={messages.send}
              title={messages.send}
            >
              <ArrowUp strokeWidth={2} aria-hidden="true" />
            </Button>
          </div>
          {disabled && disabledReason ? (
            <FieldDescription>{disabledReason}</FieldDescription>
          ) : messages.hint ? (
            // Read with the field, not shown: a chat line needs no caption.
            <FieldDescription className="absolute size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]">
              {messages.hint}
            </FieldDescription>
          ) : null}
          <FieldError>{error}</FieldError>
        </Field>
      </form>
    </div>
  );
}
