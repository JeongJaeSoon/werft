import { ChevronLeft, ChevronRight } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";
import { Button } from "../primitives/button.tsx";
import { Text } from "../primitives/text.tsx";

export interface PaginationMessages {
  /** The nav's name, e.g. "페이지 이동". */
  readonly label: string;
  readonly previous: string;
  readonly next: string;
  /** A page number's accessible name, e.g. "3페이지". */
  readonly page: (page: number) => string;
}

export interface PaginationProps {
  /** 1-based. */
  readonly page: number;
  /** The pages known to exist; with `hasMore`, more may follow the last. */
  readonly pageCount: number;
  readonly hasMore?: boolean | undefined;
  readonly onPageChange: (page: number) => void;
  /** Which rows are shown, such as "16–30 / 120"; announced when it changes. */
  readonly range?: ReactNode;
  readonly messages: PaginationMessages;
  readonly className?: string | undefined;
}

type PageItem = number | "gap-before" | "gap-after";

/** The first, last and neighbouring pages, with a gap where pages are left out. */
export function paginationItems(
  page: number,
  pageCount: number,
  hasMore: boolean,
): readonly PageItem[] {
  const shown = [1, page - 1, page, page + 1, pageCount]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b)
    .filter((n, index, all) => all[index - 1] !== n);
  const items: PageItem[] = [];
  for (const n of shown) {
    const previous = items.at(-1);
    if (typeof previous === "number" && n - previous > 1) {
      items.push(n < page ? "gap-before" : "gap-after");
    }
    items.push(n);
  }
  if (hasMore) items.push("gap-after");
  return items;
}

/*
 * Page links under a list. The edge buttons are aria-disabled, not disabled,
 * so the keyboard stays on "next" when it reaches the last page.
 */
export function Pagination({
  page,
  pageCount,
  hasMore = false,
  onPageChange,
  range,
  messages,
  className,
}: PaginationProps): JSX.Element {
  const atStart = page <= 1;
  const atEnd = page >= pageCount && !hasMore;
  const go = (target: number, blocked: boolean) => () => {
    if (!blocked && target !== page) onPageChange(target);
  };
  return (
    <div
      data-slot="pagination"
      className={cn(
        "flex w-full flex-wrap items-center gap-x-4 gap-y-2",
        range === undefined ? "justify-end" : "justify-between",
        className,
      )}
    >
      {range === undefined ? null : (
        <Text variant="meta" numeric={true} aria-live="polite">
          {range}
        </Text>
      )}
      <nav aria-label={messages.label}>
        <ul className="m-0 flex list-none items-center gap-1 p-0">
          <li>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={messages.previous}
              aria-disabled={atStart || undefined}
              onClick={go(page - 1, atStart)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
          </li>
          {paginationItems(page, pageCount, hasMore).map((item) =>
            typeof item === "number" ? (
              <li key={item}>
                <Button
                  type="button"
                  variant={item === page ? "outline" : "ghost"}
                  size="icon-sm"
                  className="w-auto min-w-[var(--werft-control-height-sm)] px-1.5 tabular-nums aria-[current=page]:text-foreground"
                  aria-label={messages.page(item)}
                  aria-current={item === page ? "page" : undefined}
                  onClick={go(item, false)}
                >
                  {item}
                </Button>
              </li>
            ) : (
              <li key={item} aria-hidden="true">
                <Text as="span" variant="meta" className="px-1">
                  …
                </Text>
              </li>
            ),
          )}
          <li>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={messages.next}
              aria-disabled={atEnd || undefined}
              onClick={go(page + 1, atEnd)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
