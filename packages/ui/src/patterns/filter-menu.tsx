import { Check, ChevronDown } from "lucide-react";
import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";
import { buttonVariants } from "../primitives/button.tsx";
import { MenuItem } from "../primitives/menu-item.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../primitives/popover.tsx";

/*
 * A list toolbar's secondary filter drawn as a chip: "관계 ▾", or
 * "관계 내가 시작 ▾" on a filled background once narrowed. A button rather
 * than a native select, so picking with the mouse leaves no focus outline
 * (Chrome keeps :focus-visible on a select after a mouse pick) while a
 * keyboard user still sees one. The popover lists the choices as pressed
 * buttons; arrows move between them and a pick closes it, focus returning to
 * the chip.
 */

export interface FilterMenuOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterMenuProps {
  /** The filter's name, always shown on the chip, e.g. "관계". */
  readonly label: ReactNode;
  /** The first option is the unfiltered one; the chip shows no value for it. */
  readonly options: readonly FilterMenuOption[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly className?: string | undefined;
}

export function FilterMenu({
  label,
  options,
  value,
  onValueChange,
  className,
}: FilterMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const list = useRef<HTMLUListElement>(null);
  const picked = options.find((option) => option.value === value);
  const filtered = picked !== undefined && picked !== options[0];
  // Up and Down walk the choices, wrapping; Tab still moves through them too.
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-slot="filter-menu"
        data-filtered={filtered ? "" : undefined}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "gap-1.5 border-border px-3 font-normal hover:border-subtle-foreground",
          filtered && "bg-active",
          className,
        )}
      >
        <span id={labelId} className={filtered ? "text-muted-foreground" : ""}>
          {label}
        </span>
        {/* The unfiltered value is still read, so the chip says what it shows. */}
        <span
          data-slot="filter-menu-value"
          className={filtered ? "font-medium" : "sr-only"}
        >
          {picked?.label}
        </span>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.5}
          className="text-subtle-foreground"
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // A long list (every member) scrolls within the room below the chip.
        className="max-h-(--radix-popover-content-available-height) w-56 overflow-y-auto p-1"
        aria-labelledby={labelId}
        onOpenAutoFocus={(event) => {
          // Start on the current choice, as a select does.
          event.preventDefault();
          list.current
            ?.querySelector<HTMLButtonElement>("[aria-pressed=true]")
            ?.focus();
        }}
      >
        <ul
          ref={list}
          className="m-0 flex list-none flex-col p-0"
          onKeyDown={move}
        >
          {options.map((option) => (
            <li key={option.value}>
              <MenuItem
                aria-pressed={option.value === value}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== value) onValueChange(option.value);
                }}
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0",
                    option.value === value ? "" : "invisible",
                  )}
                />
                {option.label}
              </MenuItem>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
