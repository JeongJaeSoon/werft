import {
  Button,
  Link,
  MenuItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@werft-ai/ui";
import { ArrowUpRight, Ellipsis } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

/**
 * A Dialog's onCloseAutoFocus that gives the focus back to `opener`. Radix
 * returns it only to a Dialog.Trigger, and these dialogs open from plain
 * buttons and menus, so without this it falls to <body>.
 */
export const focusBack =
  (opener: HTMLElement | null | undefined) => (event: Event) => {
    if (!opener?.isConnected) return;
    event.preventDefault();
    opener.focus();
  };

const itemsOf = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));

// Arrow keys, Home and End move between items, disabled ones included so a
// keyboard hears why they are disabled; Tab leaves the menu, which closes it
// as the focus goes.
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const items = itemsOf(event.currentTarget);
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "ArrowDown"
      ? (at + 1) % items.length
      : event.key === "ArrowUp"
        ? (at - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

/**
 * The ⋯ button at the end of a row and the menu it opens. Escape and an
 * outside click close it and give the focus back to the button.
 */
export function RowMenu({
  label,
  text,
  disabled,
  children,
}: {
  /** Names the menu, and the ⋯ button: "acme · werft-agent 메뉴". */
  readonly label: string;
  /** The button cannot open the menu, as a row's buttons are while it saves. */
  readonly disabled?: boolean | undefined;
  /** A primary button with this text instead of the ⋯ button. */
  readonly text?: ReactNode;
  /**
   * RowMenuItem and RowMenuLink; each closes the menu when chosen. `close`
   * returns the menu's button, for a dialog the item opens to focus on close.
   */
  readonly children: (close: () => HTMLButtonElement | null) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {text === undefined ? (
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={label}
            aria-haspopup="menu"
            aria-controls={open ? menuId : undefined}
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        ) : (
          <Button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            aria-haspopup="menu"
            aria-controls={open ? menuId : undefined}
          >
            {text}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        id={menuId}
        role="menu"
        aria-label={label}
        align="end"
        className="flex min-w-44 flex-col gap-0.5 p-1"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const menu = event.currentTarget;
          if (!(menu instanceof HTMLElement)) return;
          const items = itemsOf(menu);
          (
            items.find((item) => !item.hasAttribute("aria-disabled")) ??
            items[0]
          )?.focus();
        }}
        onKeyDown={moveFocus}
      >
        {children(() => {
          setOpen(false);
          return triggerRef.current;
        })}
      </PopoverContent>
    </Popover>
  );
}

export function RowMenuItem({
  onSelect,
  tone,
  reason,
  label,
  children,
}: {
  readonly onSelect: () => void;
  readonly tone?: "danger" | undefined;
  /**
   * A fuller name than its text, such as one with the row's id; it must
   * contain the text. Ignored with a `reason`, which names it by its text.
   */
  readonly label?: string | undefined;
  /**
   * Why the item cannot be chosen now. It stays in the menu, dimmed, with
   * the reason under its name; the arrow keys still reach it, and a screen
   * reader reads the reason as its description.
   */
  readonly reason?: string | undefined;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  const reasonId = useId();
  const disabled = reason !== undefined;
  return (
    <MenuItem
      role="menuitem"
      tabIndex={-1}
      tone={disabled ? "default" : tone}
      aria-disabled={disabled || undefined}
      aria-label={disabled ? undefined : label}
      // Named by its label alone; the reason under it is its description.
      aria-labelledby={disabled ? labelId : undefined}
      aria-describedby={disabled ? reasonId : undefined}
      className={
        disabled
          ? "h-auto cursor-not-allowed flex-col items-start gap-0.5 py-2"
          : undefined
      }
      onClick={disabled ? undefined : onSelect}
    >
      <span id={labelId}>{children}</span>
      {disabled ? (
        <span id={reasonId} className="text-caption text-muted-foreground">
          {reason}
        </span>
      ) : null}
    </MenuItem>
  );
}

/** A menu item that opens a GitHub page in a new tab. */
export function RowMenuLink({
  href,
  newTabLabel,
  onSelect,
  children,
}: {
  readonly href: string;
  /** "(새 탭에서 열림)", read after the item's name. */
  readonly newTabLabel: string;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <MenuItem asChild>
      <Link
        role="menuitem"
        tabIndex={-1}
        href={href}
        target="_blank"
        newTabLabel={newTabLabel}
        className="font-normal hover:no-underline"
        onClick={onSelect}
      >
        {children}
        <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
      </Link>
    </MenuItem>
  );
}
