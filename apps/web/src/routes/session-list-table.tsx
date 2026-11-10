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
  Skeleton,
} from "@werft-ai/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChannelIcon } from "../components/channel-icon.tsx";
import { MoreFailure } from "../components/paged-list-footer.tsx";
import { useI18n } from "../i18n/i18n.tsx";

/** One line per row, so the window can be worked out without measuring. */
const ROW_HEIGHT = 48;
const NARROW_ROW_HEIGHT = 68;
const NARROW_AT = 760;
const OVERSCAN = 8;
const TEMPLATE = "minmax(0,3fr) minmax(0,1.4fr) 56px 150px 104px 88px";
// Title over its agent and channel; status over the start time, at the end.
const NARROW_TEMPLATE = "minmax(0,1fr) auto";

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
  const [narrow, setNarrow] = useState(false);
  const rowHeight = narrow ? NARROW_ROW_HEIGHT : ROW_HEIGHT;

  useLayoutEffect(() => {
    const place = () => {
      const element = body.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      const viewport = window.innerHeight;
      // The two-line phone row is taller; the table's own width decides.
      const phone = element.clientWidth <= NARROW_AT;
      setNarrow(phone);
      const height = phone ? NARROW_ROW_HEIGHT : ROW_HEIGHT;
      const first = Math.floor((window.scrollY - top) / height) - OVERSCAN;
      const last =
        Math.ceil((window.scrollY + viewport - top) / height) + OVERSCAN;
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

  // A refresh can shorten the list below the scrolled range until the next scroll.
  const from = Math.min(range.from, Math.max(0, sessions.length - 1));
  const visible = sessions.slice(from, range.to + 1);
  const before = from * rowHeight;
  const after = Math.max(
    0,
    (sessions.length - from - visible.length) * rowHeight,
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
          <SessionListHeader />

          {/* biome-ignore lint/a11y/useSemanticElements: GridTable is a div grid, so its rowgroup is one too */}
          <div ref={body} role="rowgroup">
            <div aria-hidden="true" style={{ height: before }} />
            {visible.map((session, offset) => (
              <SessionListRow
                key={session.id}
                session={session}
                index={from + offset + 2}
                locale={locale}
                height={rowHeight}
              />
            ))}
            <div aria-hidden="true" style={{ height: after }} />
            {/* The next page is on its way: rows in the table's own shape. */}
            {loadingMore ? <SkeletonRows height={rowHeight} /> : null}
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
        {/* Said to screen readers only: the list loads as it is scrolled. */}
        <output className="sr-only">
          {loadingMore
            ? t("sessionList.loading")
            : allLoaded
              ? t("sessionList.loadedAll", { count: sessions.length })
              : t("sessionList.loadedCount", { count: sessions.length })}
        </output>
        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={list.isFetching || undefined}
            onClick={loadNext}
          >
            {t("sessionList.loadMore")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Shown only while the table is narrow (it has no media query of its own). */
const ONLY_NARROW = "hidden [@container(max-width:760px)]:flex";

/** Placeholder rows the width and height of real ones. */
function SkeletonRows({ height }: { readonly height: number }) {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((key) => (
        <GridTableRow key={key} style={{ height }}>
          <GridTableCell>
            <Skeleton className="h-4 w-2/3" />
          </GridTableCell>
          <GridTableCell hideNarrow={true}>
            <Skeleton className="h-4 w-24" />
          </GridTableCell>
          <GridTableCell hideNarrow={true}>
            <Skeleton className="size-5" />
          </GridTableCell>
          <GridTableCell>
            <Skeleton className="h-4 w-20" />
          </GridTableCell>
          <GridTableCell hideNarrow={true}>
            <Skeleton className="h-4 w-16" />
          </GridTableCell>
          <GridTableCell hideNarrow={true}>
            <Skeleton className="h-4 w-10" />
          </GridTableCell>
        </GridTableRow>
      ))}
    </div>
  );
}

function SessionListHeader() {
  const { t } = useI18n();
  return (
    <GridTableHeader aria-rowindex={1}>
      <GridTableColumnHeader>
        <span className="truncate">{t("sessionList.column.title")}</span>
      </GridTableColumnHeader>
      <GridTableColumnHeader hideNarrow={true}>
        <span className="truncate">{t("sessionList.column.agentName")}</span>
      </GridTableColumnHeader>
      <GridTableColumnHeader hideNarrow={true}>
        <span className="truncate">{t("sessionList.column.channel")}</span>
      </GridTableColumnHeader>
      <GridTableColumnHeader>
        <span className="truncate">{t("sessionList.column.status")}</span>
      </GridTableColumnHeader>
      <GridTableColumnHeader hideNarrow={true}>
        <span className="truncate">{t("sessionList.column.started")}</span>
      </GridTableColumnHeader>
      <GridTableColumnHeader hideNarrow={true}>
        <span className="truncate">{t("sessionList.column.duration")}</span>
      </GridTableColumnHeader>
    </GridTableHeader>
  );
}

/**
 * A short, whole list in the session list's own rows and columns, for the
 * places that show a handful of sessions (home, an agent's overview).
 */
export function SessionTable({
  sessions,
  label,
}: {
  readonly sessions: readonly SessionSummary[];
  readonly label: string;
}) {
  const { locale } = useI18n();
  return (
    <div className="w-full min-w-0 rounded-card border bg-card">
      <GridTable
        aria-label={label}
        columns={TEMPLATE}
        narrowAt={760}
        narrowColumns={NARROW_TEMPLATE}
      >
        <SessionListHeader />
        {sessions.map((session, index) => (
          <SessionListRow
            key={session.id}
            session={session}
            index={index + 2}
            locale={locale}
          />
        ))}
      </GridTable>
    </div>
  );
}

/** The first read: the table's header and rows, empty. */
export function SessionListSkeleton() {
  const { t } = useI18n();
  return (
    <div className="w-full min-w-0 rounded-card border bg-card">
      <GridTable
        aria-label={t("sessions.tableLabel")}
        aria-busy="true"
        columns={TEMPLATE}
        narrowAt={760}
        narrowColumns={NARROW_TEMPLATE}
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            <span className="truncate">{t("sessionList.column.title")}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true} />
          <GridTableColumnHeader hideNarrow={true} />
          <GridTableColumnHeader />
          <GridTableColumnHeader hideNarrow={true} />
          <GridTableColumnHeader hideNarrow={true} />
        </GridTableHeader>
        <SkeletonRows height={ROW_HEIGHT} />
        <SkeletonRows height={ROW_HEIGHT} />
        <SkeletonRows height={ROW_HEIGHT} />
      </GridTable>
    </div>
  );
}

function SessionListRow({
  session,
  index,
  locale,
  height,
}: {
  readonly session: SessionSummary;
  readonly index: number;
  readonly locale: string;
  /** Fixed while the list is windowed; a short list lets the row size itself. */
  readonly height?: number;
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
      style={height === undefined ? undefined : { height }}
    >
      <GridTableCell className="[@container(max-width:760px)]:flex-col [@container(max-width:760px)]:items-start [@container(max-width:760px)]:gap-0.5">
        <SessionRowOpener
          name={t("sessionList.open", { name })}
          title={name}
          renderLink={({ children, ...link }) => (
            <Link to="/sessions/$id" params={{ id: session.id }} {...link}>
              {children}
            </Link>
          )}
        />
        <span className="flex min-w-0 max-w-full items-center gap-2">
          <span className="min-w-0 truncate font-medium">{name}</span>
          {waiting ? (
            <span
              role="img"
              aria-label={t("sessionList.needsAnswer")}
              className="size-1.5 shrink-0 rounded-full bg-destructive"
            />
          ) : null}
        </span>
        <span
          className={`${ONLY_NARROW} max-w-full items-center gap-1.5 text-caption text-muted-foreground`}
        >
          <span className="min-w-0 truncate">
            {session.agent?.name ?? t("sessionList.unknown")}
          </span>
          <ChannelIcon channel={session.channel} />
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <span className="min-w-0 truncate">
          {session.agent?.name ?? t("sessionList.unknown")}
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <ChannelIcon channel={session.channel} />
      </GridTableCell>
      <GridTableCell className="[@container(max-width:760px)]:flex-col [@container(max-width:760px)]:items-stretch [@container(max-width:760px)]:gap-0.5">
        <SessionStatusLabel
          status={session.status}
          label={t(`sessions.status.${session.status}`)}
          axisLabel={t("sessions.column.status")}
          className="[@container(max-width:760px)]:justify-end"
        />
        <span
          className={`${ONLY_NARROW} justify-end whitespace-nowrap text-caption text-muted-foreground`}
        >
          {formatStart(session.created_at, locale)}
        </span>
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
