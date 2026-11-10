import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "@werft-ai/contracts";
import {
  SessionRowOpener,
  SessionStatusLabel,
} from "@werft-ai/react/components";
import {
  Button,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
} from "@werft-ai/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoreFailure } from "../components/paged-list-footer.tsx";
import { useI18n } from "../i18n/i18n.tsx";

/** One line per row, so the window can be worked out without measuring. */
const ROW_HEIGHT = 48;
const OVERSCAN = 8;
const TEMPLATE = "minmax(0,3fr) minmax(0,1.4fr) 72px 150px 104px 88px";
const NARROW_TEMPLATE = "minmax(0,1fr) 128px";

function formatStart(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatSpan(ms: number, locale: string): string {
  const unit = (value: number, name: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      unitDisplay: "narrow",
    }).format(value);
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0
      ? unit(minutes, "minute")
      : `${unit(minutes, "minute")} ${unit(rest, "second")}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${unit(hours, "hour")} ${unit(minutes % 60, "minute")}`;
}

/**
 * The sessions loaded so far, drawn as a window over fixed-height rows: only
 * the rows near the viewport exist in the page. Reaching the end loads the
 * next page by itself; the button is the same step for keyboard and screen
 * reader users.
 */
export function SessionListTable({
  sessions,
  total,
  list,
  stale,
}: {
  readonly sessions: readonly SessionSummary[];
  /** The count the filter matches, when the counts have arrived. */
  readonly total: number | undefined;
  readonly list: UseInfiniteQueryResult<InfiniteData<unknown>>;
  readonly stale: boolean;
}) {
  const { t, locale } = useI18n();
  const body = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ from: 0, to: 30 });

  useLayoutEffect(() => {
    const place = () => {
      const element = body.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      const viewport = window.innerHeight;
      const first = Math.floor((window.scrollY - top) / ROW_HEIGHT) - OVERSCAN;
      const last =
        Math.ceil((window.scrollY + viewport - top) / ROW_HEIGHT) + OVERSCAN;
      const from = Math.max(0, first);
      const to = Math.max(from, last);
      setRange((current) =>
        current.from === from && current.to === to ? current : { from, to },
      );
    };
    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, []);

  const hasMore =
    !stale && list.hasNextPage && (!list.error || list.isFetchNextPageError);
  const loadNext = () => {
    if (!list.isFetching) void list.fetchNextPage({ cancelRefetch: false });
  };
  // The sentinel sits under the last row: once it shows, the list has been
  // read to its end.
  const loadRef = useRef(loadNext);
  loadRef.current = loadNext;
  // biome-ignore lint/correctness/useExhaustiveDependencies: observe again after each page, so a sentinel still in view loads the next one
  useEffect(() => {
    const sentinel = end.current;
    if (!sentinel || !hasMore || typeof IntersectionObserver === "undefined")
      return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadRef.current();
      },
      { rootMargin: "240px" },
    );
    watch.observe(sentinel);
    return () => watch.disconnect();
  }, [hasMore, sessions.length]);

  const visible = sessions.slice(range.from, range.to + 1);
  const before = range.from * ROW_HEIGHT;
  const after = Math.max(
    0,
    (sessions.length - range.from - visible.length) * ROW_HEIGHT,
  );
  const totalRows = total ?? sessions.length;
  const loadingMore = list.isFetchingNextPage;
  const allLoaded = !list.hasNextPage && !list.error;

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="w-full min-w-0 rounded-card border bg-card">
        <GridTable
          aria-label={t("sessions.tableLabel")}
          aria-rowcount={totalRows + 1}
          columns={TEMPLATE}
          narrowAt={760}
          narrowColumns={NARROW_TEMPLATE}
        >
          <GridTableHeader aria-rowindex={1}>
            <GridTableColumnHeader>
              <span className="truncate">{t("sessionList.column.title")}</span>
            </GridTableColumnHeader>
            <GridTableColumnHeader hideNarrow={true}>
              <span className="truncate">
                {t("sessionList.column.agentName")}
              </span>
            </GridTableColumnHeader>
            <GridTableColumnHeader hideNarrow={true}>
              <span className="truncate">
                {t("sessionList.column.channel")}
              </span>
            </GridTableColumnHeader>
            <GridTableColumnHeader>
              <span className="truncate">{t("sessionList.column.status")}</span>
            </GridTableColumnHeader>
            <GridTableColumnHeader hideNarrow={true}>
              <span className="truncate">
                {t("sessionList.column.started")}
              </span>
            </GridTableColumnHeader>
            <GridTableColumnHeader hideNarrow={true}>
              <span className="truncate">
                {t("sessionList.column.duration")}
              </span>
            </GridTableColumnHeader>
          </GridTableHeader>
          {/* biome-ignore lint/a11y/useSemanticElements: GridTable is a div grid, so its rowgroup is one too */}
          <div ref={body} role="rowgroup">
            <div aria-hidden="true" style={{ height: before }} />
            {visible.map((session, offset) => (
              <SessionListRow
                key={session.id}
                session={session}
                index={range.from + offset + 2}
                locale={locale}
              />
            ))}
            <div aria-hidden="true" style={{ height: after }} />
          </div>
        </GridTable>
      </div>
      <div ref={end} className="flex flex-col items-center gap-2 py-1">
        {list.error ? (
          <MoreFailure
            error={list.error}
            busy={list.isFetching}
            onRetry={() =>
              void (list.isFetchNextPageError
                ? list.fetchNextPage({ cancelRefetch: false })
                : list.refetch({ cancelRefetch: false }))
            }
          />
        ) : null}
        <output className="text-center text-caption text-muted-foreground">
          {loadingMore
            ? t("sessionList.loading")
            : allLoaded
              ? t("sessionList.loadedAll", { count: sessions.length })
              : t("sessionList.loadedCount", { count: sessions.length })}
        </output>
        {hasMore ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={list.isFetching || undefined}
              onClick={loadNext}
            >
              {t("sessionList.loadMore")}
            </Button>
            <span className="text-caption text-muted-foreground">
              {t("sessionList.autoLoad")}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SessionListRow({
  session,
  index,
  locale,
}: {
  readonly session: SessionSummary;
  readonly index: number;
  readonly locale: string;
}) {
  const { t } = useI18n();
  const name = session.title ?? session.id;
  const waiting = session.status === "needs_input";
  const duration =
    session.status === "running" || waiting
      ? "—"
      : formatSpan(
          Date.parse(session.updated_at) - Date.parse(session.created_at),
          locale,
        );
  return (
    <GridTableRow
      aria-rowindex={index}
      data-status={session.status}
      style={{ height: ROW_HEIGHT }}
    >
      <GridTableCell>
        <SessionRowOpener
          name={t("sessionList.open", { name })}
          title={name}
          renderLink={({ children, ...link }) => (
            <Link to="/sessions/$id" params={{ id: session.id }} {...link}>
              {children}
            </Link>
          )}
        />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {waiting ? (
          <span
            role="img"
            aria-label={t("sessionList.needsAnswer")}
            className="size-2 shrink-0 rounded-full bg-destructive"
          />
        ) : null}
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <span className="min-w-0 truncate">
          {session.agent?.name ?? t("sessionList.unknown")}
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <span className="rounded-control border px-1.5 text-caption">
          {session.channel ?? "—"}
        </span>
      </GridTableCell>
      <GridTableCell>
        <SessionStatusLabel
          status={session.status}
          label={t(`sessions.status.${session.status}`)}
          axisLabel={t("sessions.column.status")}
        />
      </GridTableCell>
      <GridTableCell
        hideNarrow={true}
        className="whitespace-nowrap text-caption text-muted-foreground"
      >
        {formatStart(session.created_at, locale)}
      </GridTableCell>
      <GridTableCell
        hideNarrow={true}
        className="whitespace-nowrap text-caption text-muted-foreground"
      >
        {duration}
      </GridTableCell>
    </GridTableRow>
  );
}
