import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  AuditEvent,
  AuditEventKind,
  AuditExportEnd,
  CountAuditEventsResponse,
  ListAuditEventsResponse,
  ListMembersResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { ListToolbar } from "@werft-ai/react/components";
import {
  AppliedFilters,
  Button,
  Code,
  EmptyState,
  formatTableDateTime,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  type ListFilterChoice,
  type ListFilterFacet,
  ListFilters,
  Page,
  RowLines,
  type StatusDotStatus,
  StatusText,
  TableTime,
  Text,
} from "@werft-ai/ui";
import { useEffect, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import {
  CursorListFailure,
  ListPagination,
  useCursorPage,
} from "../components/list-pages.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../i18n/i18n.tsx";

/** Rows on one page of the list. */
export const AUDIT_PAGE_SIZE = 50;
// The contract's; the web takes contracts as types only, so a test pins them.
export const AUDIT_EXPORT_MEDIA_TYPE = "application/x-ndjson";
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

const PERIODS = { all: 0, day: 1, week: 7, month: 30 } as const;
type Period = keyof typeof PERIODS;
const SHORTEST_FIRST: readonly Period[] = ["day", "week", "month", "all"];
const PERIOD_LABEL: Record<Period, MessageKey> = {
  all: "auditLog.period.all",
  day: "auditLog.period.day",
  week: "auditLog.period.week",
  month: "auditLog.period.month",
};

export type Filter = {
  readonly period: Period;
  /** Fixed when the period is picked, so every page reads the same window. */
  readonly from: string | undefined;
  readonly kind: AuditEventKind | undefined;
  readonly actor: string | undefined;
};

const ALL: Filter = {
  period: "all",
  from: undefined,
  kind: undefined,
  actor: undefined,
};

/** The filters the screen sends; the rest of the query is the server's. */
type AuditQuery = {
  from?: string;
  kind?: AuditEventKind;
  actor_user_id?: string;
};

export function queryOf(filter: Filter): AuditQuery {
  return {
    ...(filter.from ? { from: filter.from } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.actor ? { actor_user_id: filter.actor } : {}),
  };
}

/** Where a period's window starts, counted back from `now`. */
function periodFrom(period: Period, now: number): string | undefined {
  const days = PERIODS[period];
  return days === 0
    ? undefined
    : new Date(now - days * 86_400_000).toISOString();
}

function auditCountsQuery(
  client: ApiClient,
  query: AuditQuery,
  enabled: boolean,
) {
  return {
    queryKey: scopedKey(client, "audit-counts", query),
    queryFn: () =>
      unwrap(
        client.GET("/v1/audit/events/counts", { params: { query } }),
      ) as Promise<CountAuditEventsResponse>,
    enabled,
    // Every count is recorded as a read, as the list is.
    gcTime: 0,
    retry: false,
  };
}

/** A count as a filter choice shows it; nothing while it is unknown. */
function counted(
  count: CountAuditEventsResponse["total"] | undefined,
): Pick<ListFilterChoice, "count" | "countCapped"> {
  return count ? { count: count.count, countCapped: count.more } : {};
}

function auditPagesQuery(client: ApiClient, filter: Filter) {
  const query = queryOf(filter);
  return infiniteQueryOptions({
    queryKey: scopedKey(client, "audit-events", query),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/audit/events", {
          params: {
            query: {
              ...query,
              limit: AUDIT_PAGE_SIZE,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListAuditEventsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    // Every read is itself recorded; a list left behind is read afresh.
    gcTime: 0,
    retry: false,
  });
}

/** Every member a person can be picked from, read 100 at a time to the end. */
function auditActorsQuery(client: ApiClient) {
  return {
    queryKey: scopedKey(client, "audit-actors"),
    queryFn: async () => {
      const items: ListMembersResponse["items"][number][] = [];
      let cursor: string | null = null;
      do {
        const page = (await unwrap(
          client.GET("/v1/members", {
            params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
          }),
        )) as ListMembersResponse;
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor !== null);
      return items;
    },
    retry: false,
  };
}

/** Settings > Workspace > Audit log: the owner's alone, menu and address. */
export function AuditLogScreen() {
  const { t } = useI18n();
  if (!useHasPermission("audit_log.read")) {
    return <StatusScreen kind="not-found" />;
  }
  return (
    <Page title={t("auditLog.title")} description={t("auditLog.description")}>
      <AuditLog />
    </Page>
  );
}

function AuditLog() {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const [filter, setFilter] = useState<Filter>(ALL);
  const [page, setPage] = useState(1);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const pages = useInfiniteQuery(auditPagesQuery(client, filter));
  const listed = useCursorPage({
    list: pages,
    page,
    pageSize: AUDIT_PAGE_SIZE,
    onPageChange: setPage,
  });
  // A person no longer in the workspace is shown by id.
  const people = useQuery(auditActorsQuery(client));
  const nameOf = new Map(
    (people.data ?? []).map((member) => [member.user_id, member.display_name]),
  );
  const pick = (next: Partial<Filter>) => {
    setFilter((current) => ({ ...current, ...next }));
    setPage(1);
    setOutcome(null);
  };
  // Counts are read only while the filters are open, each period's window
  // counted back from when they opened; the picked period keeps the list's own.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [anchor, setAnchor] = useState(() => Date.now());
  const filterButton = useRef<HTMLButtonElement>(null);
  const periods = Object.keys(PERIODS) as Period[];
  const periodQuery = (period: Period) =>
    queryOf({
      ...filter,
      period,
      from: period === filter.period ? filter.from : periodFrom(period, anchor),
    });
  const kindQuery = queryOf({ ...filter, kind: undefined });
  // Every count is itself recorded, so counts read at once would each miss
  // the others' rows and a longer period could show fewer. Read one after
  // another, shortest window first: each later count includes every earlier
  // read, so a longer window never shows less.
  const countQueries = [
    ...new Map(
      [...SHORTEST_FIRST.map(periodQuery), kindQuery].map((query) => [
        JSON.stringify(query),
        query,
      ]),
    ).values(),
  ];
  const queryClient = useQueryClient();
  const countResults = useQueries({
    queries: countQueries.map((query, index) => {
      const before = countQueries[index - 1];
      // A query that is waiting to be enabled is idle too, so wait for an answer.
      const state =
        before &&
        queryClient.getQueryState(scopedKey(client, "audit-counts", before));
      const settled =
        before === undefined ||
        (state !== undefined &&
          state.status !== "pending" &&
          state.fetchStatus === "idle");
      return auditCountsQuery(client, query, filtersOpen && settled);
    }),
  });
  const countsFor = (query: AuditQuery) =>
    countResults[
      countQueries.findIndex(
        (one) => JSON.stringify(one) === JSON.stringify(query),
      )
    ]?.data;
  const kinds = countsFor(kindQuery);
  const facets: ListFilterFacet[] = [
    {
      id: "period",
      label: t("auditLog.period.label"),
      value: filter.period,
      choices: periods.map((value) => ({
        value,
        label: t(PERIOD_LABEL[value]),
        ...counted(countsFor(periodQuery(value))?.total),
      })),
    },
    {
      id: "kind",
      label: t("auditLog.kind.label"),
      value: filter.kind ?? "all",
      choices: [
        {
          value: "all",
          label: t("auditLog.kind.all"),
          ...counted(kinds?.total),
        },
        {
          value: "decision",
          label: t("auditLog.kind.decision"),
          ...counted(kinds?.counts.decision),
        },
        {
          value: "receipt",
          label: t("auditLog.kind.receipt"),
          ...counted(kinds?.counts.receipt),
        },
      ],
    },
    {
      // No count per person: one read per member would grow with the team.
      id: "actor",
      label: t("auditLog.actor.label"),
      value: filter.actor ?? "all",
      choices: [
        { value: "all", label: t("auditLog.actor.all") },
        ...(people.data ?? []).map((member) => ({
          value: member.user_id,
          label: member.display_name,
        })),
      ],
    },
  ];
  const pickFacet = (facet: string, value: string) => {
    if (facet === "period") {
      const period = periods.find((name) => name === value) ?? "all";
      pick({ period, from: periodFrom(period, anchor) });
    } else if (facet === "kind") {
      pick({
        kind: value === "decision" || value === "receipt" ? value : undefined,
      });
    } else {
      pick({ actor: value === "all" ? undefined : value });
    }
  };
  const retentionStart = pages.data?.pages[0]?.retention_start;

  return (
    <div className="flex flex-col gap-4">
      {retentionStart ? (
        <Text variant="meta">
          {t("auditLog.retention", {
            start: formatTableDateTime(retentionStart, locale),
          })}
        </Text>
      ) : null}
      <ListToolbar
        filter={
          <ListFilters
            facets={facets}
            onValueChange={pickFacet}
            onOpenChange={(open) => {
              if (open) setAnchor(Date.now());
              setFiltersOpen(open);
            }}
            triggerRef={filterButton}
            messages={{
              trigger: t("filters.trigger"),
              count: (count) => t("filters.count", { count }),
              applied: (count) => t("filters.applied", { count }),
            }}
          />
        }
        view={
          <ExportButton
            // A capped export's rest belongs to the filters it ran with.
            key={JSON.stringify(queryOf(filter))}
            query={queryOf(filter)}
            onOutcome={setOutcome}
          />
        }
      />
      <AppliedFilters
        facets={facets}
        onValueChange={pickFacet}
        onClearAll={() => pick(ALL)}
        returnFocus={filterButton}
        messages={{
          label: t("filters.chips"),
          remove: (facet, choice) => t("filters.remove", { facet, choice }),
          clearAll: t("filters.clearAll"),
        }}
      />
      <OutcomeLine outcome={outcome} live />
      {pages.isPending ? (
        <StatusScreen kind="loading" />
      ) : pages.error &&
        !pages.data?.pages.some((one) => one.items.length > 0) ? (
        <LoadFailure error={pages.error} onRetry={() => void pages.refetch()} />
      ) : listed.items.length === 0 ? (
        <EmptyState
          title={t("auditLog.empty")}
          description={t("auditLog.emptyHint")}
        />
      ) : (
        <div
          aria-busy={listed.busy}
          data-busy={listed.busy}
          className="flex flex-col gap-4 transition-opacity data-[busy=true]:opacity-60 data-[busy=true]:delay-150"
        >
          <AuditTable rows={listed.items} nameOf={nameOf} />
          <CursorListFailure list={pages} page={listed} />
          <ListPagination list={listed} />
        </div>
      )}
    </div>
  );
}

const OUTCOME_DOT: Record<string, StatusDotStatus> = {
  allow: "done",
  succeeded: "done",
  deny: "failed",
  failed: "failed",
  require_approval: "wait",
  accepted: "wait",
  redact: "idle",
};

const OUTCOME_LABEL: Readonly<Record<string, MessageKey>> = {
  allow: "auditLog.outcome.allow",
  succeeded: "auditLog.outcome.succeeded",
  deny: "auditLog.outcome.deny",
  failed: "auditLog.outcome.failed",
  require_approval: "auditLog.outcome.require_approval",
  accepted: "auditLog.outcome.accepted",
  redact: "auditLog.outcome.redact",
};

/** An outcome's name; one this build has no words for reads as sent. */
function outcomeLabel(t: Translate, outcome: string): string {
  const key = OUTCOME_LABEL[outcome];
  return key === undefined ? outcome : t(key);
}

const short = (id: string) => id.slice(0, 8);

function actorLabel(
  t: Translate,
  row: AuditEvent,
  nameOf: ReadonlyMap<string, string>,
): string {
  const { actor } = row;
  if (actor.user_id) return nameOf.get(actor.user_id) ?? actor.user_id;
  if (actor.principal_kind === "api_key" && actor.principal_id) {
    return t("auditLog.actor.apiKey", { id: short(actor.principal_id) });
  }
  if (actor.agent_id)
    return t("auditLog.actor.agent", { id: short(actor.agent_id) });
  return t("auditLog.actor.unknown");
}

/** Whether a row belongs to the same request as the row above it. */
export function continuesRequest(
  rows: readonly AuditEvent[],
  index: number,
): boolean {
  const id = rows[index]?.request_id;
  return index > 0 && id != null && rows[index - 1]?.request_id === id;
}

function AuditTable({
  rows,
  nameOf,
}: {
  readonly rows: readonly AuditEvent[];
  readonly nameOf: ReadonlyMap<string, string>;
}) {
  const { t, locale } = useI18n();
  const column = {
    actor: t("auditLog.column.actor"),
    action: t("auditLog.column.action"),
    outcome: t("auditLog.column.outcome"),
    request: t("auditLog.column.request"),
  };
  return (
    <GridTable
      // The settings layout zeroes the row inset; a framed table needs it.
      className="[--werft-row-padding-x:var(--werft-space-4)]"
      aria-label={t("auditLog.title")}
      columns={COLUMNS}
      align={ALIGN}
      narrowAt={640}
      narrowCards={true}
      framed={true}
    >
      <GridTableHeader>
        <GridTableColumnHeader>{t("auditLog.column.at")}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.actor}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.action}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.outcome}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.request}</GridTableColumnHeader>
      </GridTableHeader>
      {rows.map((row, index) => {
        const grouped = continuesRequest(rows, index);
        return (
          <GridTableRow
            key={`${row.kind}:${row.id}`}
            data-same-request={grouped || undefined}
            className={grouped ? "border-t-0" : undefined}
          >
            <GridTableCell>
              <TableTime value={row.at} locale={locale} />
            </GridTableCell>
            <GridTableCell cardLabel={column.actor} className="min-w-0">
              <RowLines>
                <Text
                  as="span"
                  className="min-w-0 truncate"
                  title={actorLabel(t, row, nameOf)}
                >
                  {actorLabel(t, row, nameOf)}
                </Text>
                {row.surface ? <Text variant="meta">{row.surface}</Text> : null}
              </RowLines>
            </GridTableCell>
            <GridTableCell cardLabel={column.action} className="min-w-0">
              <RowLines>
                <Code className="min-w-0 truncate" title={row.action}>
                  {row.action}
                </Code>
                <Text
                  variant="meta"
                  className="min-w-0 truncate"
                  title={row.target.id ?? row.target.kind}
                >
                  {row.target.id
                    ? `${row.target.kind} ${short(row.target.id)}`
                    : row.target.kind}
                </Text>
              </RowLines>
            </GridTableCell>
            <GridTableCell cardLabel={column.outcome}>
              <RowLines>
                <StatusText status={OUTCOME_DOT[row.outcome] ?? "idle"}>
                  {outcomeLabel(t, row.outcome)}
                </StatusText>
                {/* An allow's reason is always "ok"; only a refusal's says why. */}
                {row.reason_code && row.outcome !== "allow" ? (
                  <Text variant="meta">{row.reason_code}</Text>
                ) : null}
              </RowLines>
            </GridTableCell>
            <GridTableCell cardLabel={column.request}>
              {row.request_id === null ? null : grouped ? (
                <Text variant="meta">{t("auditLog.sameRequest")}</Text>
              ) : (
                <Code title={row.request_id}>{short(row.request_id)}</Code>
              )}
            </GridTableCell>
          </GridTableRow>
        );
      })}
    </GridTable>
  );
}

// Time | who | what | outcome | request; one card per row at 640px or less.
const COLUMNS =
  "max-content minmax(0,1fr) minmax(0,1.4fr) max-content max-content";
const ALIGN = ["start", "start", "start", "start", "start"] as const;

/** The export's last line, or null when the stream stopped before it. */
export async function exportEnd(file: Blob): Promise<AuditExportEnd | null> {
  const tail = await file.slice(Math.max(0, file.size - 4096)).text();
  const last = tail.trimEnd().split("\n").at(-1) ?? "";
  try {
    const line = JSON.parse(last) as Partial<AuditExportEnd>;
    return line.kind === "end" && typeof line.rows === "number"
      ? (line as AuditExportEnd)
      : null;
  } catch {
    return null;
  }
}

function save(file: Blob) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-log-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.ndjson`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Downloads what the filters keep, as NDJSON. A file is saved only once its
 * end line has come; a capped export offers the rest from where it stopped.
 */
function ExportButton({
  query,
  onOutcome,
}: {
  readonly query: AuditQuery;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  // Other filters mount a new button: the export of the old ones is
  // cancelled, so it neither saves a file nor speaks for the new ones.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const run = async (cursor: string | null) => {
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    onOutcome(null);
    try {
      const file = (await unwrap(
        client.GET("/v1/audit/events", {
          params: { query: { ...query, ...(cursor ? { cursor } : {}) } },
          headers: { Accept: AUDIT_EXPORT_MEDIA_TYPE },
          parseAs: "blob",
          signal: controller.signal,
        }),
      )) as unknown as Blob;
      const end = await exportEnd(file);
      if (controller.signal.aborted) return;
      // A failure keeps the place to continue from: the rows before it are
      // already saved.
      if (end === null) {
        onOutcome({ kind: "error", text: t("auditLog.exportCut") });
        return;
      }
      save(file);
      setNext(end.truncated ? end.next_cursor : null);
      const count = new Intl.NumberFormat(locale).format(
        end.truncated ? AUDIT_EXPORT_MAX_ROWS : end.rows,
      );
      onOutcome({
        kind: "notice",
        text: t(
          end.truncated ? "auditLog.exportTruncated" : "auditLog.exported",
          {
            count,
          },
        ),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      onOutcome({
        kind: "error",
        text: isApiError(error, "RATE_LIMITED")
          ? t("auditLog.exportBusy")
          : t(isApiError(error) ? errorKey(error.code) : "error.UNKNOWN"),
      });
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {next ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) void run(next);
          }}
        >
          {t("auditLog.exportContinue")}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) void run(null);
        }}
      >
        {busy ? t("auditLog.exporting") : t("auditLog.export")}
      </Button>
    </div>
  );
}
