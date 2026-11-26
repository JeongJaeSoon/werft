import { Check, ChevronRight, ListFilter } from "lucide-react";
import {
  type JSX,
  type KeyboardEvent,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Button, buttonVariants } from "../primitives/button.tsx";
import { ItemCount } from "../primitives/item-count.tsx";
import { MenuItem } from "../primitives/menu-item.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../primitives/popover.tsx";
import { RemoveButton } from "../primitives/remove-button.tsx";

/*
 * A list's filters gathered behind one "필터" button. Each facet is a section
 * that folds; its choices are pressed buttons, each with the number of rows
 * it would keep when the screen knows it. Picking keeps the panel open, so
 * several facets can be set in one visit. AppliedFilters shows what narrows
 * the list as removable chips, with one button that removes them all.
 */

export interface ListFilterChoice {
  readonly value: string;
  readonly label: string;
  /** Rows this choice keeps; absent while unknown or when the list is not counted. */
  readonly count?: number | undefined;
  /** The count stopped at a cap, so there are more: drawn as "1000+". */
  readonly countCapped?: boolean | undefined;
}

export interface ListFilterFacet {
  readonly id: string;
  readonly label: string;
  /** The first choice is the unfiltered one; no chip stands for it. */
  readonly choices: readonly ListFilterChoice[];
  readonly value: string;
}

export interface ListFiltersMessages {
  /** The button's text, e.g. "필터". */
  readonly trigger: string;
  /** A choice's count as read aloud, e.g. "12" → "12개". */
  readonly count: (count: string) => string;
  /** How many facets narrow the list, read after the button's text. */
  readonly applied: (count: number) => string;
}

export interface ListFiltersProps {
  readonly facets: readonly ListFilterFacet[];
  readonly onValueChange: (facet: string, value: string) => void;
  readonly messages: ListFiltersMessages;
  readonly triggerRef?: Ref<HTMLButtonElement> | undefined;
  /** Told when the panel opens or closes, e.g. to read counts only while open. */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  readonly className?: string | undefined;
}

/** The choice a facet narrows to, or undefined when it keeps every row. */
export function appliedChoice(
  facet: ListFilterFacet,
): ListFilterChoice | undefined {
  const picked = facet.choices.find((choice) => choice.value === facet.value);
  return picked === undefined || picked === facet.choices[0]
    ? undefined
    : picked;
}

function countText(choice: ListFilterChoice): string | undefined {
  if (choice.count === undefined) return undefined;
  return choice.countCapped ? `${choice.count}+` : String(choice.count);
}

export function ListFilters({
  facets,
  onValueChange,
  messages,
  triggerRef,
  onOpenChange,
  className,
}: ListFiltersProps): JSX.Element {
  const labelId = useId();
  const baseId = useId();
  const applied = facets.filter((facet) => appliedChoice(facet)).length;
  // Each opening unfolds the first facet and every facet that narrows.
  const unfolded = () =>
    new Set(
      facets
        .filter((facet, index) => index === 0 || appliedChoice(facet))
        .map((facet) => facet.id),
    );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(unfolded);
  const [open, setOpen] = useState(false);
  const openChange = (next: boolean) => {
    if (next) setExpanded(unfolded());
    setOpen(next);
    onOpenChange?.(next);
  };
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Up and Down walk every visible button, folded sections skipped; Home and
  // End go to either end. Tab moves through them too.
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => !button.closest("[hidden]"));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      event.key === "ArrowDown"
        ? (at + 1) % buttons.length
        : event.key === "ArrowUp"
          ? (at - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    buttons[target]?.focus();
  };
  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        ref={triggerRef}
        data-slot="list-filters"
        data-filtered={applied > 0 ? "" : undefined}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "gap-1.5 border-border px-3 font-normal hover:border-subtle-foreground",
          applied > 0 && "bg-active",
          className,
        )}
      >
        <ListFilter
          aria-hidden="true"
          strokeWidth={1.5}
          className="text-subtle-foreground"
        />
        <span id={labelId}>{messages.trigger}</span>
        {applied > 0 ? (
          <ItemCount count={applied} countLabel={messages.applied(applied)} />
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={labelId}
        // A long facet (every member) scrolls within the room below the button.
        className="max-h-(--radix-popover-content-available-height) w-64 overflow-y-auto p-1"
        onKeyDown={move}
      >
        <div data-slot="list-filters-panel" className="flex flex-col gap-1">
          {facets.map((facet) => {
            const open = expanded.has(facet.id);
            const bodyId = `${baseId}-${facet.id}`;
            const picked = appliedChoice(facet);
            return (
              <div key={facet.id} data-slot="list-filters-facet">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={() => toggle(facet.id)}
                  className="flex h-[var(--werft-control-height)] w-full items-center gap-2 rounded-control border-0 bg-transparent px-2 text-start font-medium text-control text-foreground transition-[background-color] hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring motion-reduce:transition-none"
                >
                  <ChevronRight
                    aria-hidden="true"
                    strokeWidth={1.5}
                    className={cn(
                      "size-4 shrink-0 text-subtle-foreground transition-transform duration-[var(--werft-motion-fast)] motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{facet.label}</span>
                  {picked ? (
                    <>
                      {" "}
                      <span className="min-w-0 max-w-[50%] truncate font-normal text-caption text-muted-foreground">
                        {picked.label}
                      </span>
                    </>
                  ) : null}
                </button>
                <ul
                  id={bodyId}
                  hidden={!open}
                  aria-label={facet.label}
                  className="m-0 flex list-none flex-col p-0 ps-4 [&[hidden]]:hidden"
                >
                  {facet.choices.map((choice) => {
                    const count = countText(choice);
                    const pressed = choice.value === facet.value;
                    return (
                      <li key={choice.value}>
                        <MenuItem
                          aria-pressed={pressed}
                          className="aria-pressed:bg-active"
                          onClick={() => {
                            if (!pressed) onValueChange(facet.id, choice.value);
                          }}
                        >
                          <Check
                            aria-hidden="true"
                            className={cn(
                              "size-4 shrink-0",
                              pressed ? "" : "invisible",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {choice.label}
                          </span>
                          {count === undefined ? null : (
                            <>
                              {" "}
                              <span
                                data-slot="list-filters-count"
                                aria-hidden="true"
                                className="text-caption text-subtle-foreground tabular-nums"
                              >
                                {count}
                              </span>
                              <span className="sr-only">
                                {messages.count(count)}
                              </span>
                            </>
                          )}
                        </MenuItem>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface AppliedFiltersMessages {
  /** The group's name, e.g. "적용한 필터". */
  readonly label: string;
  /** A chip's ×, e.g. ("관계", "내가 시작") → "관계 필터 빼기: 내가 시작". */
  readonly remove: (facet: string, choice: string) => string;
  readonly clearAll: string;
}

export interface AppliedFiltersProps {
  /** The facets the chips come from; one chip per facet that narrows. */
  readonly facets: readonly ListFilterFacet[];
  /** A chip's × sends the facet's first (unfiltered) choice. */
  readonly onValueChange: (facet: string, value: string) => void;
  readonly onClearAll: () => void;
  readonly messages: AppliedFiltersMessages;
  /** Where focus goes once the last chip is gone. */
  readonly returnFocus?: RefObject<HTMLElement | null> | undefined;
  readonly className?: string | undefined;
}

export function AppliedFilters({
  facets,
  onValueChange,
  onClearAll,
  messages,
  returnFocus,
  className,
}: AppliedFiltersProps): JSX.Element | null {
  const list = useRef<HTMLUListElement>(null);
  // The pressed chip's facet (null for "remove all") and the chips shown then,
  // kept until the screen has let go: the filters may live in the address,
  // which answers a render later.
  const pending = useRef<{
    facet: string | null;
    at: number;
    before: string;
  } | null>(null);
  const chips = facets.flatMap((facet) => {
    const choice = appliedChoice(facet);
    return choice ? [{ facet, choice }] : [];
  });
  const shown = JSON.stringify(
    chips.map((chip) => [chip.facet.id, chip.facet.value]),
  );
  // Focus the person moves while waiting stays where they put it. Watched as an
  // event: a removed button and a person both can leave focus on the body.
  useEffect(() => {
    const abandon = () => {
      pending.current = null;
    };
    document.addEventListener("focusin", abandon);
    return () => document.removeEventListener("focusin", abandon);
  }, []);
  useEffect(() => {
    const wait = pending.current;
    if (wait === null) return;
    const now: [string, string][] = JSON.parse(shown);
    const before = new Map<string, string>(JSON.parse(wait.before));
    // A value that was not there at the press came from somewhere else.
    if (now.some(([id, value]) => before.get(id) !== value)) {
      pending.current = null;
      return;
    }
    if (
      wait.facet === null
        ? now.length > 0
        : now.some(([id]) => id === wait.facet)
    ) {
      return;
    }
    pending.current = null;
    const buttons =
      list.current?.querySelectorAll<HTMLButtonElement>(
        "[data-slot=remove-button]",
      ) ?? [];
    const next = buttons[Math.min(wait.at, buttons.length - 1)];
    (next ?? returnFocus?.current)?.focus();
  }, [shown, returnFocus]);
  if (chips.length === 0) return null;
  return (
    <fieldset
      aria-label={messages.label}
      data-slot="applied-filters"
      className={cn(
        "m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0",
        className,
      )}
    >
      <ul ref={list} className="m-0 flex list-none flex-wrap gap-2 p-0">
        {chips.map(({ facet, choice }, index) => (
          <li
            key={facet.id}
            data-slot="applied-filter"
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-surface-sunken py-0.5 ps-2.5 pe-0.5 text-caption"
          >
            <span className="shrink-0 text-muted-foreground">
              {facet.label}
            </span>{" "}
            <span className="min-w-0 truncate font-medium" title={choice.label}>
              {choice.label}
            </span>
            <RemoveButton
              aria-label={messages.remove(facet.label, choice.label)}
              onClick={() => {
                pending.current = { facet: facet.id, at: index, before: shown };
                onValueChange(facet.id, facet.choices[0]?.value ?? "");
              }}
            />
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          pending.current = { facet: null, at: 0, before: shown };
          onClearAll();
        }}
      >
        {messages.clearAll}
      </Button>
    </fieldset>
  );
}
