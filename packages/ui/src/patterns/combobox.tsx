import { Check, Search } from "lucide-react";
import {
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Input } from "../primitives/input.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../primitives/popover.tsx";

/*
 * ARIA 1.2 combobox with a list popup, single select. Focus never leaves the
 * input: arrows move `aria-activedescendant` through the enabled options and,
 * last, the "load more" row. That row is an option of the listbox because
 * `aria-activedescendant` may only point into it, but it carries no
 * `aria-selected` and choosing it loads the next page instead. The list takes
 * the v4 command palette's values (`.cmd-list`, `.cmd-item`). The kit has no
 * words of its own, so every message is a prop.
 */

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Second line: an email, a channel's visibility. Strings are searched. */
  readonly description?: ReactNode;
  /** At the end of the label's line: a channel's visibility tag. Not searched. */
  readonly end?: ReactNode;
  /** Shown but not choosable, e.g. someone already on the team. */
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  /**
   * The chosen value; leave undefined to let the combobox keep it. When it
   * changes from outside, an uncontrolled input shows the new option's label.
   */
  readonly value?: string | null | undefined;
  readonly onValueChange?:
    | ((value: string, option: ComboboxOption) => void)
    | undefined;
  /** Empty the input after a choice, for flows that add and move on. */
  readonly clearOnSelect?: boolean | undefined;
  readonly inputValue?: string | undefined;
  /** Starting text, filtered by as if typed. */
  readonly defaultInputValue?: string | undefined;
  readonly onInputValueChange?: ((value: string) => void) | undefined;
  /**
   * `internal` matches the typed text inside each label and string
   * description, ignoring case and full-width forms. `none` shows `options`
   * as given: the caller searches, usually on the server, via `onQueryChange`.
   */
  readonly filter?: "internal" | "none" | undefined;
  /**
   * Called once typing pauses for `debounceMs`, and at once with "" after a
   * choice, so the next opening lists everything again. Only with
   * `filter="none"`. Dropping a response that a newer query overtook is the
   * caller's job.
   */
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly debounceMs?: number | undefined;
  readonly loading?: boolean | undefined;
  readonly loadingMessage?: ReactNode;
  readonly hasMore?: boolean | undefined;
  readonly onLoadMore?: (() => void) | undefined;
  readonly loadMoreLabel?: ReactNode;
  readonly emptyMessage: ReactNode;
  /** Read out in a polite status region when the open list's size changes. */
  readonly resultCountMessage?: ((count: number) => string) | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
}

const LOAD_MORE = Symbol("load-more");
type ActiveKey = string | typeof LOAD_MORE | null;

function normalize(text: string, locale: string | undefined): string {
  return text.normalize("NFKC").toLocaleLowerCase(locale);
}

function filterOptions(
  options: readonly ComboboxOption[],
  query: string,
): readonly ComboboxOption[] {
  const locale = document.documentElement.lang || undefined;
  const needle = normalize(query.trim(), locale);
  if (!needle) return options;
  return options.filter((option) =>
    [option.label, option.description].some(
      (text) =>
        typeof text === "string" && normalize(text, locale).includes(needle),
    ),
  );
}

const ROW =
  "flex min-h-10 cursor-default items-center gap-3 rounded-control px-3";

export function Combobox({
  options,
  value,
  onValueChange,
  clearOnSelect = false,
  inputValue: inputValueProp,
  defaultInputValue,
  onInputValueChange,
  filter = "internal",
  onQueryChange,
  debounceMs = 250,
  loading = false,
  loadingMessage,
  hasMore = false,
  onLoadMore,
  loadMoreLabel,
  emptyMessage,
  resultCountMessage,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  maxLength,
  placeholder,
  disabled = false,
  id,
  className,
}: ComboboxProps): JSX.Element {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const loadMoreId = `${baseId}-load-more`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const [ownValue, setOwnValue] = useState<string | null>(null);
  const selected = value === undefined ? ownValue : value;
  const selectedLabel = options.find(
    (option) => option.value === selected,
  )?.label;
  const [ownInput, setOwnInput] = useState(
    () => defaultInputValue ?? (clearOnSelect ? "" : (selectedLabel ?? "")),
  );
  const inputValue = inputValueProp ?? ownInput;
  // After a choice the input holds a label, not a query: every option shows
  // until someone types.
  const [showAll, setShowAll] = useState(
    defaultInputValue === undefined && inputValueProp === undefined,
  );
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ActiveKey>(null);

  // A controlled value moved by the parent, or its option arriving late,
  // updates an input the combobox owns.
  const [synced, setSynced] = useState({
    value: selected,
    label: selectedLabel,
  });
  if (
    value !== undefined &&
    (selected !== synced.value ||
      (synced.label === undefined && selectedLabel !== undefined))
  ) {
    const moved = selected !== synced.value;
    setSynced({ value: selected, label: selectedLabel });
    if (
      inputValueProp === undefined &&
      !clearOnSelect &&
      (moved || !ownInput)
    ) {
      setOwnInput(selectedLabel ?? "");
      setShowAll(true);
    }
  }

  // Text the parent put in a controlled input is a query, unless it is what
  // the combobox itself asked for.
  const requested = useRef(inputValueProp);
  const [seenInputProp, setSeenInputProp] = useState(inputValueProp);
  if (inputValueProp !== seenInputProp) {
    setSeenInputProp(inputValueProp);
    if (inputValueProp !== requested.current) setShowAll(false);
  }

  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestOnQueryChange = useRef(onQueryChange);
  latestOnQueryChange.current = onQueryChange;
  useEffect(() => () => clearTimeout(timer.current), []);

  const visible =
    filter === "internal"
      ? filterOptions(options, showAll ? "" : inputValue)
      : options;
  const showLoadMore = hasMore && !loading && onLoadMore !== undefined;
  const keys: ActiveKey[] = [
    ...visible.filter((option) => !option.disabled).map((o) => o.value),
    ...(showLoadMore ? [LOAD_MORE as ActiveKey] : []),
  ];
  const activeKey = keys.includes(active) ? active : null;
  const activeIndex = visible.findIndex((option) => option.value === activeKey);
  const activeId =
    activeKey === LOAD_MORE
      ? loadMoreId
      : activeIndex >= 0
        ? optionId(activeIndex)
        : undefined;
  const isOpen = open && !disabled;

  useEffect(() => {
    if (!isOpen || !activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [isOpen, activeId]);

  function changeInput(next: string) {
    requested.current = next;
    if (inputValueProp === undefined) setOwnInput(next);
    onInputValueChange?.(next);
  }

  function query(next: string) {
    latestOnQueryChange.current?.(next);
  }

  function close() {
    setOpen(false);
    setActive(null);
  }

  function choose(option: ComboboxOption) {
    if (option.disabled) return;
    clearTimeout(timer.current);
    if (value === undefined) setOwnValue(option.value);
    setSynced({ value: option.value, label: option.label });
    onValueChange?.(option.value, option);
    changeInput(clearOnSelect ? "" : option.label);
    setShowAll(true);
    // Even when nothing was sent yet: the caller may already be waiting on
    // the typing that this choice cancelled.
    if (filter === "none") query("");
    close();
  }

  function type(next: string) {
    changeInput(next);
    setShowAll(false);
    setActive(null);
    if (filter === "none") {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => query(next), debounceMs);
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    type(event.target.value);
    setOpen(true);
  }

  function move(to: ActiveKey) {
    setOpen(true);
    setActive(to);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // An IME's Enter or arrow belongs to the composition, not the list.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const at = activeKey === null ? -1 : keys.indexOf(activeKey);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) move(keys[0] ?? null);
        else move(keys[Math.min(at + 1, keys.length - 1)] ?? null);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen || at < 0) move(keys.at(-1) ?? null);
        else move(keys[Math.max(at - 1, 0)] ?? null);
        return;
      case "Home":
      case "End":
        if (!isOpen) return;
        event.preventDefault();
        move((event.key === "Home" ? keys[0] : keys.at(-1)) ?? null);
        return;
      case "Enter": {
        if (!isOpen) return;
        event.preventDefault();
        if (activeKey === LOAD_MORE) onLoadMore?.();
        else {
          const option = visible[activeIndex];
          if (option) choose(option);
        }
        return;
      }
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          close();
        } else if (inputValue) {
          event.preventDefault();
          type("");
        }
        return;
      case "Tab":
        close();
        return;
    }
  }

  const status = !isOpen
    ? ""
    : loading
      ? loadingMessage
      : visible.length === 0
        ? emptyMessage
        : (resultCountMessage?.(visible.length) ?? "");

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          data-slot="combobox"
          className={cn("relative w-full", className)}
        >
          <Search
            aria-hidden="true"
            strokeWidth={1.5}
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle-foreground"
          />
          <Input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            maxLength={maxLength}
            aria-autocomplete="list"
            aria-expanded={isOpen}
            aria-controls={isOpen ? listboxId : undefined}
            aria-activedescendant={isOpen ? activeId : undefined}
            placeholder={placeholder}
            disabled={disabled}
            value={inputValue}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onClick={() => setOpen(true)}
            onBlur={close}
            className="pl-8"
          />
          {/* biome-ignore lint/a11y/useSemanticElements: <output> is not announced as a live region by every screen reader. */}
          <div role="status" className="sr-only">
            {status}
          </div>
        </div>
      </PopoverAnchor>
      {/* biome-ignore lint/a11y/useValidAriaRole: undefined drops the dialog role Radix sets; the box only holds the listbox and is never focused, since focus stays in the input. */}
      <PopoverContent
        align="start"
        data-slot="combobox-content"
        role={undefined}
        tabIndex={undefined}
        className="flex max-h-80 w-[var(--radix-popover-trigger-width)] max-w-none flex-col p-1 text-control"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) {
            event.preventDefault();
          }
        }}
        // Keep focus, and with it typing, in the input on a pointer press.
        onMouseDown={(event) => event.preventDefault()}
      >
        {/* Kept when empty, so aria-controls always names the list. */}
        <div
          role="listbox"
          id={listboxId}
          // A FieldLabel names only the input; the list repeats its words.
          aria-label={
            ariaLabel ?? inputRef.current?.labels?.[0]?.textContent ?? undefined
          }
          aria-busy={loading || undefined}
          className="min-h-0 overflow-y-auto"
        >
          {visible.map((option, index) => {
            const isSelected = option.value === selected;
            return (
              // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: focus stays in the input, which handles the keys and points here with aria-activedescendant.
              <div
                key={option.value}
                role="option"
                id={optionId(index)}
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                data-active={option.value === activeKey || undefined}
                className={cn(
                  ROW,
                  option.description !== undefined && "py-1.5",
                  // MenuItem's inset outline: the input keeps the focus, so
                  // the option it points at shows the keyboard's place.
                  "data-[active]:bg-hover data-[active]:outline-2 data-[active]:outline-offset-[-2px] data-[active]:outline-focus-ring aria-disabled:opacity-50",
                )}
                onPointerMove={() => {
                  if (!option.disabled) setActive(option.value);
                }}
                onClick={() => choose(option)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{option.label}</span>
                  {option.description !== undefined && (
                    <span className="truncate text-caption text-subtle-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
                {option.end !== undefined && (
                  <span
                    className={cn(
                      "flex shrink-0 items-center",
                      // One line tall at the top, so it centres on the label.
                      option.description !== undefined && "h-[1lh] self-start",
                    )}
                  >
                    {option.end}
                  </span>
                )}
                <Check
                  aria-hidden="true"
                  strokeWidth={1.5}
                  className={cn("size-4 shrink-0", !isSelected && "invisible")}
                />
              </div>
            );
          })}
          {showLoadMore && (
            // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: as for the options above.
            <div
              role="option"
              id={loadMoreId}
              data-slot="combobox-load-more"
              data-active={activeKey === LOAD_MORE || undefined}
              className={cn(ROW, "data-[active]:bg-hover")}
              onPointerMove={() => setActive(LOAD_MORE)}
              onClick={onLoadMore}
            >
              {loadMoreLabel}
            </div>
          )}
        </div>
        {loading && (
          <p className="p-3 text-caption text-subtle-foreground">
            {loadingMessage}
          </p>
        )}
        {!loading && visible.length === 0 && (
          <p className="p-3 text-caption text-subtle-foreground">
            {emptyMessage}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
