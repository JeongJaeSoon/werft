import { Alert, AlertDescription, Button, Text } from "@werft-ai/ui";
import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

const SHOWN_MS = 4000;
// An error is read, then acted on: it stays longer than a confirmation.
const ERROR_SHOWN_MS = 8000;
const PLACE =
  "pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6";

export type NotifyOptions = {
  /** Only shown, when a live region on the page already says the same. */
  readonly silent?: boolean;
  /** `error` is announced at once (role=alert); the default is polite. */
  readonly tone?: "error";
  /** An error the person must act on stays until dismissed. */
  readonly persistent?: boolean;
};

/**
 * A short notice floating over the page bottom. It never takes focus or
 * moves the layout. Each notice mounts a fresh region on `document.body`, so
 * a modal dialog opened earlier has not hidden it from assistive technology.
 */
export type Notify = (text: string, options?: NotifyOptions) => void;

type Current = {
  readonly id: number;
  readonly text: string;
  readonly options: NotifyOptions;
};

export function useToast(dismissLabel?: string): {
  readonly notify: Notify;
  readonly toast: ReactNode;
} {
  const [current, setCurrent] = useState<Current | null>(null);
  const notify = useCallback<Notify>(
    (text, options = {}) =>
      setCurrent((previous) => ({
        id: (previous?.id ?? 0) + 1,
        text,
        options,
      })),
    [],
  );
  const dismiss = useCallback(() => setCurrent(null), []);
  return {
    notify,
    toast: current ? (
      <Toast
        key={current.id}
        text={current.text}
        options={current.options}
        dismissLabel={dismissLabel}
        onDone={dismiss}
      />
    ) : null,
  };
}

const NotifyContext = createContext<Notify | null>(null);

/**
 * One toast for a whole area, so a notice outlives the screen that raised it
 * (a deleted team's page is gone by the time the list says so).
 */
export function ToastProvider({
  dismissLabel,
  children,
}: {
  readonly dismissLabel: string;
  readonly children: ReactNode;
}) {
  const { notify, toast } = useToast(dismissLabel);
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      {toast}
    </NotifyContext.Provider>
  );
}

export function useNotify(): Notify {
  const notify = useContext(NotifyContext);
  if (notify === null) throw new Error("useNotify needs a ToastProvider");
  return notify;
}

function Toast({
  text,
  options,
  dismissLabel,
  onDone,
}: {
  readonly text: string;
  readonly options: NotifyOptions;
  readonly dismissLabel: string | undefined;
  readonly onDone: () => void;
}) {
  const error = options.tone === "error";
  const persistent = error && options.persistent === true;
  // The region exists empty first: a live region inserted with its text
  // already in it is not announced by every screen reader.
  const [shown, setShown] = useState("");
  useEffect(() => {
    const fill = setTimeout(() => setShown(text), 50);
    const done = persistent
      ? undefined
      : setTimeout(onDone, error ? ERROR_SHOWN_MS : SHOWN_MS);
    return () => {
      clearTimeout(fill);
      clearTimeout(done);
    };
  }, [text, onDone, error, persistent]);
  const box = "pointer-events-auto max-w-sm shadow-pop";
  const body = !shown ? null : error ? (
    <Alert variant="red" className={`${box} bg-popover`}>
      <AlertDescription>{shown}</AlertDescription>
      {persistent ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-my-1 -me-2"
          aria-label={dismissLabel}
          onClick={onDone}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </Alert>
  ) : (
    <Text
      className={`${box} rounded-card border bg-popover px-4 py-3 text-popover-foreground`}
    >
      {shown}
    </Text>
  );
  return createPortal(
    options.silent && !error ? (
      <div aria-hidden="true" data-slot="toast" className={PLACE}>
        {body}
      </div>
    ) : error ? (
      <div role="alert" data-slot="toast" data-tone="error" className={PLACE}>
        {body}
      </div>
    ) : (
      <output aria-live="polite" data-slot="toast" className={PLACE}>
        {body}
      </output>
    ),
    document.body,
  );
}
