import { Alert, AlertDescription, Button, Text } from "@werft-ai/ui";
import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  // An error to act on has its own place: a later notice must not push it
  // out before it is dismissed, and it must not hide that notice either.
  const [held, setHeld] = useState<Current | null>(null);
  const [heldHeight, setHeldHeight] = useState(0);
  const notify = useCallback<Notify>((text, options = {}) => {
    const set =
      options.tone === "error" && options.persistent ? setHeld : setCurrent;
    set((previous) => ({ id: (previous?.id ?? 0) + 1, text, options }));
  }, []);
  const dismiss = useCallback(() => setCurrent(null), []);
  const release = useCallback(() => setHeld(null), []);
  return {
    notify,
    toast: (
      <>
        {held ? (
          <Toast
            key={`held-${held.id}`}
            text={held.text}
            options={held.options}
            dismissLabel={dismissLabel}
            onHeight={setHeldHeight}
            onDone={release}
          />
        ) : null}
        {current ? (
          <Toast
            key={`current-${current.id}`}
            text={current.text}
            options={current.options}
            dismissLabel={dismissLabel}
            liftPx={held ? heldHeight : 0}
            onDone={dismiss}
          />
        ) : null}
      </>
    ),
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
  liftPx = 0,
  onHeight,
  onDone,
}: {
  readonly text: string;
  readonly options: NotifyOptions;
  readonly dismissLabel: string | undefined;
  /** The height of an error holding the corner; this sits above it. */
  readonly liftPx?: number;
  /** Reports this toast's height, for the one that sits above it. */
  readonly onHeight?: (height: number) => void;
  readonly onDone: () => void;
}) {
  const error = options.tone === "error";
  const persistent = error && options.persistent === true;
  const region = useRef<HTMLElement | null>(null);
  const setRegion = (node: HTMLElement | null) => {
    region.current = node;
  };
  // The last place the keyboard was outside the toast: the dismiss button is
  // removed with it, and focus must not fall to <body>.
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const track = (event: FocusEvent) => {
      if (!region.current?.contains(event.target as Node))
        opener.current = event.target as Element;
    };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);
  useEffect(() => {
    const node = region.current;
    if (!onHeight || !node || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() =>
      onHeight(node.getBoundingClientRect().height),
    );
    watch.observe(node);
    return () => watch.disconnect();
  }, [onHeight]);
  const dismiss = () => {
    onDone();
    const back = opener.current;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    // The control may be gone or disabled by now: the page's own landmark
    // (focusable, see components/main.tsx) keeps the keyboard in the page.
    const now = document.activeElement;
    if (!now || now === document.body || now.closest("[data-slot=toast]"))
      document.querySelector<HTMLElement>("main")?.focus();
  };
  const place = {
    className: PLACE,
    ref: setRegion,
    style:
      liftPx > 0
        ? { bottom: `calc(1.5rem + ${liftPx}px + 0.5rem)` }
        : undefined,
  };
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
      {/* The alert's content column stacks its children: the row keeps the
          dismiss button beside the words. */}
      <div className="flex items-start gap-2">
        <AlertDescription className="min-w-0 flex-1">{shown}</AlertDescription>
        {persistent ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-my-1 -me-2 flex-none"
            aria-label={dismissLabel}
            onClick={dismiss}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
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
      <div aria-hidden="true" data-slot="toast" {...place}>
        {body}
      </div>
    ) : error ? (
      // aria-live is explicit: a modal dialog opened later hides every
      // sibling of its content from assistive technology except live regions.
      <div
        role="alert"
        aria-live="assertive"
        data-slot="toast"
        data-tone="error"
        {...place}
      >
        {body}
      </div>
    ) : (
      <output aria-live="polite" data-slot="toast" {...place}>
        {body}
      </output>
    ),
    document.body,
  );
}
