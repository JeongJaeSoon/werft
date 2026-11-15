import {
  Button,
  cn,
  Link,
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

const ITEM =
  "flex w-full items-center gap-1 rounded-control px-2 py-1.5 text-start text-control text-foreground no-underline hover:bg-hover focus-visible:bg-hover focus-visible:outline-none";

const itemsOf = (menu: HTMLElement) =>
  Array.from(
    menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    ),
  );

// Arrow keys, Home and End move between items; Tab leaves the menu, which
// closes it as the focus goes.
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
  children,
}: {
  /** Names the menu, and the ⋯ button: "acme · werft-agent 메뉴". */
  readonly label: string;
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
          if (menu instanceof HTMLElement) itemsOf(menu)[0]?.focus();
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
  children,
}: {
  readonly onSelect: () => void;
  readonly tone?: "danger" | undefined;
  /**
   * Why the item cannot be chosen now. It stays in the menu, dimmed and
   * skipped by the arrow keys, with the reason under its name.
   */
  readonly reason?: string | undefined;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  const reasonId = useId();
  const disabled = reason !== undefined;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      // Named by its label alone; the reason under it is its description.
      aria-labelledby={disabled ? labelId : undefined}
      aria-describedby={disabled ? reasonId : undefined}
      className={cn(
        ITEM,
        disabled
          ? "cursor-not-allowed flex-col items-start text-muted-foreground hover:bg-transparent"
          : tone === "danger" && "text-(color:--werft-tone-danger-fg)",
      )}
      onClick={disabled ? undefined : onSelect}
    >
      <span id={labelId}>{children}</span>
      {disabled ? (
        <span id={reasonId} className="text-caption text-subtle-foreground">
          {reason}
        </span>
      ) : null}
    </button>
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
    <Link
      role="menuitem"
      tabIndex={-1}
      href={href}
      target="_blank"
      newTabLabel={newTabLabel}
      className={cn(ITEM, "font-normal hover:no-underline")}
      onClick={onSelect}
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
    </Link>
  );
}
