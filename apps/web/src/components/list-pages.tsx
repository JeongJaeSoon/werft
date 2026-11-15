import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { Pagination } from "@werft-ai/ui";
import { useEffect } from "react";
import { useI18n } from "../i18n/i18n.tsx";
import { MoreFailure } from "./paged-list-footer.tsx";

/** The `page` search param: absent on the first page, a whole number from 2. */
export function pageParam(value: unknown): number | undefined {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 2
    ? n
    : undefined;
}

/** Moves the address to a page; `replace` for a correction, not a step. */
export type GoToPage = (
  page: number,
  options?: { readonly replace?: boolean },
) => void;

export interface ListPage<T> {
  readonly items: readonly T[];
  /** The page the address asks for, once brought within the list. */
  readonly page: number;
  readonly pageCount: number;
  /** The total is unknown and the list goes on past `pageCount`. */
  readonly hasMore: boolean;
  /** 1-based position of the first row shown. */
  readonly start: number;
  readonly total: number | undefined;
  /** The rows shown are an earlier page's while the asked one is read. */
  readonly busy: boolean;
  /** Moves to a page; past a page that failed to come, asks for it again. */
  readonly goTo: (page: number) => void;
}

type CursorList<T> = UseInfiniteQueryResult<
  InfiniteData<{ readonly items: readonly T[] }>
>;

/**
 * One page of a list the API reads by cursor, `pageSize` rows a read: the
 * reads up to the page asked for are made in turn, since a cursor only leads
 * to the next page. A page past the end moves the address to the last one,
 * and so does one whose read failed: the failure's retry, or the next page
 * pressed again, asks for it once more.
 */
export function useCursorPage<T>({
  list,
  page,
  pageSize,
  total,
  stale = false,
  onPageChange,
}: {
  readonly list: CursorList<T>;
  readonly page: number;
  readonly pageSize: number;
  /** Every row the list's filters match, when the API counts them. */
  readonly total?: number | undefined;
  /** The rows belong to an earlier filter: neither move nor read on. */
  readonly stale?: boolean | undefined;
  readonly onPageChange: GoToPage;
}): ListPage<T> {
  const pages = list.data?.pages ?? [];
  const loaded = pages.length;
  const more = list.hasNextPage;
  const byTotal =
    total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize));
  // The list's own end when it has one; past the pages read, the count.
  const last = more
    ? byTotal === undefined
      ? undefined
      : Math.max(byTotal, loaded + 1)
    : Math.max(loaded, 1);
  const wanted = last === undefined ? page : Math.min(page, last);
  const settled = !stale && loaded > 0 && !list.isFetching;
  const failed = list.isError;
  const { fetchNextPage } = list;

  useEffect(() => {
    if (!settled) return;
    // A failed read stays failed until asked again; reading on would loop.
    const reachable = failed ? Math.min(wanted, loaded) : wanted;
    if (reachable < page) {
      onPageChange(reachable, { replace: true });
    } else if (wanted > loaded && more) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [
    settled,
    wanted,
    page,
    loaded,
    more,
    failed,
    fetchNextPage,
    onPageChange,
  ]);

  const shown = Math.max(1, Math.min(wanted, loaded));
  let start = 1;
  for (const read of pages.slice(0, shown - 1)) start += read.items.length;
  const counted = more
    ? total
    : pages.reduce((sum, read) => sum + read.items.length, 0);
  return {
    items: pages[shown - 1]?.items ?? [],
    page: wanted,
    pageCount: Math.max(last ?? loaded, wanted),
    hasMore: last === undefined,
    start,
    total: stale ? undefined : counted,
    busy: shown !== wanted,
    goTo: (target) => {
      if (target > loaded && list.isFetchNextPageError) {
        void fetchNextPage({ cancelRefetch: false });
      }
      onPageChange(target);
    },
  };
}

/** One page of a list already read whole. */
export function useClientPage<T>({
  items,
  page,
  pageSize,
  onPageChange,
}: {
  readonly items: readonly T[] | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly onPageChange: GoToPage;
}): ListPage<T> {
  const last =
    items === undefined
      ? undefined
      : Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => {
    if (last !== undefined && page > last) {
      onPageChange(last, { replace: true });
    }
  }, [last, page, onPageChange]);
  const shown = Math.min(page, last ?? page);
  const from = (shown - 1) * pageSize;
  return {
    items: items?.slice(from, from + pageSize) ?? [],
    page: shown,
    pageCount: last ?? 1,
    hasMore: false,
    start: from + 1,
    total: items?.length,
    busy: false,
    goTo: (target) => onPageChange(target),
  };
}

/** Whether the rows run past one page. */
export function isPaged(list: ListPage<unknown>): boolean {
  return list.pageCount > 1 || list.hasMore;
}

/** The page links under a list, gone when every row fits on one page. */
export function ListPagination({ list }: { readonly list: ListPage<unknown> }) {
  const { t } = useI18n();
  if (!isPaged(list)) return null;
  const end = list.start + list.items.length - 1;
  const range =
    list.items.length === 0
      ? undefined
      : list.total === undefined
        ? t("pagination.rangeOpen", { start: list.start, end })
        : t("pagination.range", { start: list.start, end, total: list.total });
  return (
    <Pagination
      page={list.page}
      pageCount={list.pageCount}
      hasMore={list.hasMore}
      onPageChange={list.goTo}
      range={range}
      messages={{
        label: t("pagination.label"),
        previous: t("pagination.previous"),
        next: t("pagination.next"),
        page: (page) => t("pagination.page", { page }),
      }}
    />
  );
}

/**
 * Why the last read of a cursor list failed, with its retry: the page that
 * failed to come, moving to it, or the refresh of those already read.
 */
export function CursorListFailure({
  list,
  page,
}: {
  readonly list: CursorList<unknown>;
  readonly page: ListPage<unknown>;
}) {
  if (!list.error) return null;
  return (
    <MoreFailure
      error={list.error}
      busy={list.isFetching}
      onRetry={() =>
        list.isFetchNextPageError
          ? page.goTo(page.page + 1)
          : void list.refetch({ cancelRefetch: false })
      }
    />
  );
}
