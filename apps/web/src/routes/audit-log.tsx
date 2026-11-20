import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  AuditEvent,
  AuditEventKind,
  AuditExportEnd,
  ListAuditEventsResponse,
  ListMembersResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { ListToolbar } from "@werft-ai/react/components";
import {
  Button,
  Code,
  EmptyState,
  FilterMenu,
  formatTableDateTime,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Page,
  RowLines,
  type StatusDotStatus,
  StatusText,
  TableTime,
  Text,
} from "@werft-ai/ui";
import { useState } from "react";
import { memberSummariesQuery, scopedKey } from "../api/queries.ts";
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
  isMessageKey,
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

/** The members a person can be picked from, by name. */
function auditActorsQuery(client: ApiClient) {
  return {
    queryKey: scopedKey(client, "audit-actors"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/members", { params: { query: { limit: 100 } } }),
      ) as Promise<ListMembersResponse>,
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
  const people = useQuery(auditActorsQuery(client));
  const ids = [
    ...new Set(
      listed.items.flatMap((row) =>
        row.actor.user_id ? [row.actor.user_id] : [],
      ),
    ),
  ];
  const names = useQuery({
    ...memberSummariesQuery(client, ids),
    enabled: ids.length > 0,
  });
  const nameOf = new Map(
    [...(people.data?.items ?? []), ...(names.data?.items ?? [])].map(
      (member) => [member.user_id, member.display_name],
    ),
  );
  const pick = (next: Partial<Filter>) => {
    setFilter((current) => ({ ...current, ...next }));
    setPage(1);
    setOutcome(null);
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
          <FilterMenu
            label={t("auditLog.period.label")}
            options={(Object.keys(PERIODS) as Period[]).map((value) => ({
              value,
              label: t(`auditLog.period.${value}`),
            }))}
            value={filter.period}
            onValueChange={(value) => {
              const period = value as Period;
              const days = PERIODS[period];
              pick({
                period,
                from:
                  days === 0
                    ? undefined
                    : new Date(Date.now() - days * 86_400_000).toISOString(),
              });
            }}
          />
        }
        filters={
          <>
            <FilterMenu
              label={t("auditLog.kind.label")}
              options={[
                { value: "all", label: t("auditLog.kind.all") },
                { value: "decision", label: t("auditLog.kind.decision") },
                { value: "receipt", label: t("auditLog.kind.receipt") },
              ]}
              value={filter.kind ?? "all"}
              onValueChange={(value) =>
                pick({
                  kind: value === "all" ? undefined : (value as AuditEventKind),
                })
              }
            />
            <FilterMenu
              label={t("auditLog.actor.label")}
              options={[
                { value: "all", label: t("auditLog.actor.all") },
                ...(people.data?.items ?? []).map((member) => ({
                  value: member.user_id,
                  label: member.display_name,
                })),
              ]}
              value={filter.actor ?? "all"}
              onValueChange={(value) =>
                pick({ actor: value === "all" ? undefined : value })
              }
            />
          </>
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

/** An outcome's name; one this build has no words for reads as sent. */
function outcomeLabel(t: Translate, outcome: string): string {
  const key = `auditLog.outcome.${outcome}`;
  return isMessageKey(key) ? t(key) : outcome;
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
  const run = async (cursor: string | null) => {
    setBusy(true);
    onOutcome(null);
    try {
      const file = (await unwrap(
        client.GET("/v1/audit/events", {
          params: { query: { ...query, ...(cursor ? { cursor } : {}) } },
          headers: { Accept: AUDIT_EXPORT_MEDIA_TYPE },
          parseAs: "blob",
        }),
      )) as unknown as Blob;
      const end = await exportEnd(file);
      if (end === null) {
        setNext(null);
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
      setNext(null);
      onOutcome({
        kind: "error",
        text: isApiError(error, "RATE_LIMITED")
          ? t("auditLog.exportBusy")
          : t(isApiError(error) ? errorKey(error.code) : "error.UNKNOWN"),
      });
    } finally {
      setBusy(false);
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
