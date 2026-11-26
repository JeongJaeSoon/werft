import {
  hashKey,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  CountSessionsResponse,
  ListSessionsResponse,
  SessionRelation,
  SessionStatus,
} from "@werft-ai/contracts";
import { queryKeysOf } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import {
  ApprovalInbox,
  type SessionActionProps,
  SessionDetail,
} from "@werft-ai/react/blocks";
import { ListToolbar } from "@werft-ai/react/components";
import {
  AppliedFilters,
  Button,
  EmptyState,
  type ItemCountTone,
  type ListFilterFacet,
  ListFilters,
  Page,
  SegmentedControl,
  SegmentedControlItem,
  Text,
} from "@werft-ai/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCan } from "../auth/guard.tsx";
import {
  CursorListFailure,
  type GoToPage,
  isPaged,
  ListPagination,
  pageParam,
  useCursorPage,
} from "../components/list-pages.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { SessionGitHubWork } from "./session-github-work.tsx";
import { SessionOutputsPanel } from "./session-outputs.tsx";
import { SessionsOverview } from "./session-overview.tsx";
import { SessionTakeover } from "./session-takeover.tsx";

export function loadError(error: unknown, onRetry: () => void) {
  if (isApiError(error, "FORBIDDEN")) {
    return <StatusScreen kind="forbidden" />;
  }
  return <LoadFailure error={error} onRetry={onRetry} />;
}

/** The status tabs, in the order the design shows them. */
export const SESSION_FILTERS = [
  "needs_input",
  "running",
  "idle",
  "cut_off",
  "stopped",
  "failed",
] as const satisfies readonly (SessionStatus | "cut_off")[];
export type SessionFilter = (typeof SESSION_FILTERS)[number];

/**
 * A tab's query. The idle tab leaves out the sessions the cut-off tab lists,
 * so the tabs never share a row.
 */
function statusQuery(status: SessionFilter) {
  if (status === "cut_off") {
    return { status: "idle", last_turn_cut_off: "true" } as const;
  }
  if (status === "idle") {
    return { status, last_turn_cut_off: "false" } as const;
  }
  return { status };
}

/** A tab's count; `counts.idle` counts the cut-off sessions too. */
function tabCount(response: CountSessionsResponse, status: SessionFilter) {
  const { counts } = response;
  // A server older than cut_off leaves it out: none are cut off then.
  return status === "idle"
    ? counts.idle - (counts.cut_off ?? 0)
    : counts[status];
}

/**
 * The states someone has to act on: a count above 0 shows as a badge in the
 * status dot's colour, the rest stay quiet numbers.
 */
const FILTER_COUNT_TONE: Partial<Record<SessionFilter, ItemCountTone>> = {
  needs_input: "attention",
  cut_off: "danger",
  failed: "danger",
};

/** The relation filter's choices past "all", in the design's order. */
const SESSION_RELATIONS = [
  "started",
  "shared",
  "administered",
] as const satisfies readonly SessionRelation[];
export type SessionRelationFilter = (typeof SESSION_RELATIONS)[number];

export interface SessionsSearch {
  /** Absent for every session, so a plain sessions link opens them all. */
  readonly status?: SessionFilter;
  /** Absent for every relation, the API's own default. */
  readonly relation?: SessionRelationFilter;
  /** Absent on the first page. */
  readonly page?: number;
}

/** Rows on one page of the sessions list. */
export const SESSIONS_PAGE_SIZE = 15;

/**
 * The list's filters as the address holds them; a screen beside the list
 * applies one by navigating to /sessions with these.
 */
export type SessionsFilterState = Pick<SessionsSearch, "status" | "relation">;

/**
 * The address after a filter change: a field left out keeps its value, null
 * clears it, and the page goes back to the first.
 */
export function withSessionsFilter(
  current: SessionsFilterState,
  change: {
    readonly status?: SessionFilter | null;
    readonly relation?: SessionRelationFilter | null;
  },
): SessionsSearch {
  const status =
    change.status === undefined ? current.status : (change.status ?? undefined);
  const relation =
    change.relation === undefined
      ? current.relation
      : (change.relation ?? undefined);
  return {
    ...(status ? { status } : {}),
    ...(relation ? { relation } : {}),
  };
}

export function sessionsSearch(
  search: Record<string, unknown>,
): SessionsSearch {
  const status = SESSION_FILTERS.find((name) => name === search.status);
  const relation = SESSION_RELATIONS.find((name) => name === search.relation);
  const page = pageParam(search.page);
  return {
    ...(status ? { status } : {}),
    ...(relation ? { relation } : {}),
    ...(page ? { page } : {}),
  };
}

export interface SessionSearch {
  /** Absent for the chat, so a plain session link opens it. */
  readonly tab?: "outputs";
}

export function sessionSearch(search: Record<string, unknown>): SessionSearch {
  return search.tab === "outputs" ? { tab: "outputs" } : {};
}

export function SessionsScreen() {
  const { t } = useI18n();
  const unavailable = useUnavailable();
  // Validated again: the root route passes the raw query through, so an
  // unknown `status` still reaches this route's search.
  const address = sessionsSearch(useSearch({ from: "/authed/sessions" }));
  const tab = address.status ?? "all";
  const relation = address.relation;
  const navigate = useNavigate({ from: "/sessions" });
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const search = useRef<HTMLInputElement>(null);
  const counts = useSessionCounts(relation, q);
  // Each relation's count for the tab picked, read only while the filters
  // are open.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const relationCounts = {
    ...useRelationCounts(relation, q, filtersOpen),
    [relation ?? "all"]: counts.data,
  };
  const filterButton = useRef<HTMLButtonElement>(null);
  const refusal = (error: { readonly code: string }) => t(errorKey(error.code));
  // A new filter leaves `page` out, so it opens on the first page.
  const go = (next: SessionsSearch) =>
    void navigate({
      search: next,
      // Replace, not push: flipping through the filters would otherwise fill
      // the back button with filter entries.
      replace: true,
    });
  const { status, relation: kept } = address;
  // Each page is its own entry, so the back button returns to the last one.
  const goToPage = useCallback<GoToPage>(
    (page, options) =>
      void navigate({
        search: {
          ...(status ? { status } : {}),
          ...(kept ? { relation: kept } : {}),
          ...(page > 1 ? { page } : {}),
        },
        replace: options?.replace ?? false,
      }),
    [navigate, status, kept],
  );
  const pick = (next: string) =>
    go(
      withSessionsFilter(address, {
        status: SESSION_FILTERS.find((name) => name === next) ?? null,
      }),
    );
  const pickRelation = (next: string) =>
    go(
      withSessionsFilter(address, {
        relation: SESSION_RELATIONS.find((name) => name === next) ?? null,
      }),
    );
  // A server older than cut_off ignores the filter, so its tab would list
  // every idle session; it waits for one that counts.
  const statuses = SESSION_FILTERS.filter(
    (name) =>
      name !== "cut_off" ||
      counts.data?.counts.cut_off !== undefined ||
      counts.data === undefined,
  );
  const statusLabel = (name: SessionFilter) =>
    name === "cut_off"
      ? t("session.status.ownershipLost")
      : t(`sessions.status.${name}`);
  const countIn = (response: CountSessionsResponse | undefined) =>
    response === undefined
      ? undefined
      : tab === "all"
        ? response.total
        : tabCount(response, tab);
  const facets: ListFilterFacet[] = [
    {
      id: "status",
      label: t("sessionList.status.label"),
      value: tab,
      choices: [
        {
          value: "all",
          label: t("sessionList.filter.all"),
          count: counts.data?.total,
        },
        ...statuses.map((name) => ({
          value: name,
          label: statusLabel(name),
          count: counts.data ? tabCount(counts.data, name) : undefined,
        })),
      ],
    },
    {
      id: "relation",
      label: t("sessionList.relation.label"),
      value: relation ?? "all",
      choices: [
        {
          value: "all",
          label: t("sessionList.relation.all"),
          count: countIn(relationCounts.all),
        },
        ...SESSION_RELATIONS.map((name) => ({
          value: name,
          label: t(`sessionList.relation.${name}`),
          count: countIn(relationCounts[name]),
        })),
      ],
    },
  ];
  const pickFacet = (facet: string, value: string) =>
    facet === "status" ? pick(value) : pickRelation(value);
  // The clear button leaves with the empty state, so focus would fall to
  // the page; it goes back to the search box instead.
  const clear = () => {
    setQuery("");
    go({});
    search.current?.focus();
  };
  return (
    <Page title={t("sessions.title")} description={t("sessions.intro")}>
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <ApprovalInbox
          layout="summary"
          renderError={loadError}
          unavailable={unavailable}
          refusal={refusal}
        />
        <div className="flex min-w-0 flex-col gap-4">
          <ListToolbar
            filter={
              <SegmentedControl
                aria-label={t("sessionList.filter.label")}
                value={tab}
                onValueChange={pick}
                scroll={true}
              >
                <SegmentedControlItem value="all" count={counts.data?.total}>
                  {t("sessionList.filter.all")}
                </SegmentedControlItem>
                {statuses.map((name) => (
                  <SegmentedControlItem
                    key={name}
                    value={name}
                    count={
                      counts.data ? tabCount(counts.data, name) : undefined
                    }
                    countTone={FILTER_COUNT_TONE[name]}
                  >
                    {statusLabel(name)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            }
            filters={
              <ListFilters
                facets={facets}
                onValueChange={pickFacet}
                onOpenChange={setFiltersOpen}
                triggerRef={filterButton}
                messages={{
                  trigger: t("filters.trigger"),
                  count: (count) => t("filters.count", { count }),
                  applied: (count) => t("filters.applied", { count }),
                }}
              />
            }
            search={{
              ref: search,
              type: "search",
              "aria-label": t("sessionList.search"),
              placeholder: t("sessionList.search"),
              maxLength: SEARCH_MAX,
              value: query,
              onChange: (event) => {
                setQuery(event.target.value);
                if (address.page) goToPage(1, { replace: true });
              },
            }}
          />
          <AppliedFilters
            facets={facets}
            onValueChange={pickFacet}
            onClearAll={() => go({})}
            returnFocus={filterButton}
            messages={{
              label: t("filters.chips"),
              remove: (facet, choice) => t("filters.remove", { facet, choice }),
              clearAll: t("filters.clearAll"),
            }}
          />
          <SessionsView
            filter={{
              ...(tab === "all" ? {} : { status: tab }),
              ...(relation ? { relation } : {}),
              ...(q ? { q } : {}),
            }}
            total={
              counts.isPlaceholderData || !counts.data
                ? undefined
                : tab === "all"
                  ? counts.data.total
                  : tabCount(counts.data, tab)
            }
            page={address.page ?? 1}
            onPageChange={goToPage}
            onClear={clear}
          />
        </div>
      </div>
    </Page>
  );
}

const statusLists = (client: ApiClient) =>
  [...queryKeysOf(client).sessions, "status"] as const;

/**
 * The session hooks and the approval inbox refresh the full list and the
 * waiting page by their exact keys, which miss the status lists; follow
 * those refreshes so an answered or stopped session leaves its tab.
 */
function useFollowListRefresh() {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  useEffect(() => {
    const keys = queryKeysOf(client);
    const followed = new Set([
      hashKey(keys.sessions),
      hashKey(keys.waitingSessions),
    ]);
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "invalidate" &&
        followed.has(event.query.queryHash)
      ) {
        void queryClient.invalidateQueries({ queryKey: statusLists(client) });
        // An invalidated query reports no further invalidation, and the full
        // list (home's) sits unmounted here. It has no staleTime, so it
        // reads again on mount with or without the flag; clearing it keeps
        // the next refresh visible here.
        if (!event.query.isActive()) {
          event.query.setState({ isInvalidated: false });
        }
      }
    });
  }, [client, queryClient]);
}

interface SessionsFilter {
  readonly status?: SessionFilter;
  readonly relation?: SessionRelationFilter;
  readonly q?: string;
}

/**
 * One query whatever the filters, so a new filter keeps the last answer on
 * screen until its own arrives instead of mounting an empty list.
 */
function useListedSessions(filter: SessionsFilter) {
  const { client } = useWerft();
  return useInfiniteQuery({
    // Never the full list's own key, which home reads at the API's default
    // page size; under the sessions key, so its refreshes reach these too.
    queryKey: [...statusLists(client), filter],
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/sessions", {
          params: {
            query: {
              ...(filter.status ? statusQuery(filter.status) : {}),
              ...(filter.relation ? { relation: filter.relation } : {}),
              ...(filter.q ? { q: filter.q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: SESSIONS_PAGE_SIZE,
            },
          },
        }),
      ) as Promise<ListSessionsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** The tabs' numbers, for the relation and search the list is read with. */
function sessionCountsQuery(
  client: ApiClient,
  relation: SessionRelationFilter | undefined,
  q: string | undefined,
) {
  const filter = { ...(relation ? { relation } : {}), ...(q ? { q } : {}) };
  return {
    queryKey: [...statusLists(client), "counts", filter],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/counts", { params: { query: filter } }),
      ) as Promise<CountSessionsResponse>,
    retry: false,
  };
}

function useSessionCounts(
  relation: SessionRelationFilter | undefined,
  q: string | undefined,
) {
  const { client } = useWerft();
  // Here, read whatever the tab: the counts follow every list refresh, and
  // so does the filtered list under the same key.
  useFollowListRefresh();
  return useQuery({
    ...sessionCountsQuery(client, relation, q),
    // The tabs keep their numbers, and so their widths, until the new ones come.
    placeholderData: keepPreviousData,
  });
}

/**
 * Every relation's counts for the same search, keyed as useSessionCounts so
 * the one already read is not read again.
 */
function useRelationCount(
  name: SessionRelationFilter | "all",
  current: SessionRelationFilter | undefined,
  q: string | undefined,
  enabled: boolean,
): CountSessionsResponse | undefined {
  const { client } = useWerft();
  return useQuery({
    ...sessionCountsQuery(client, name === "all" ? undefined : name, q),
    // The relation picked is the tabs' own read.
    enabled: enabled && name !== (current ?? "all"),
    // A new search keeps the last numbers until its own arrive.
    placeholderData: keepPreviousData,
  }).data;
}

/** Every relation's counts for the same search, the tabs' one included. */
function useRelationCounts(
  current: SessionRelationFilter | undefined,
  q: string | undefined,
  enabled: boolean,
): Record<SessionRelationFilter | "all", CountSessionsResponse | undefined> {
  return {
    all: useRelationCount("all", current, q, enabled),
    started: useRelationCount("started", current, q, enabled),
    shared: useRelationCount("shared", current, q, enabled),
    administered: useRelationCount("administered", current, q, enabled),
  };
}

/** The caller's sessions for the filters picked, a page at a time. */
function SessionsView({
  filter,
  total,
  page,
  onPageChange,
  onClear,
}: {
  readonly filter: SessionsFilter;
  /** The tab's count, for the same relation and search. */
  readonly total: number | undefined;
  readonly page: number;
  readonly onPageChange: GoToPage;
  readonly onClear: () => void;
}) {
  const { t } = useI18n();
  const sessions = useListedSessions(filter);
  const read = sessions.data?.pages.some((one) => one.items.length > 0);
  // The last filter's rows stay while the new filter is read, marked busy;
  // the fade waits a moment so a quick answer never flickers.
  const stale = sessions.isPlaceholderData;
  const listed = useCursorPage({
    list: sessions,
    page,
    pageSize: SESSIONS_PAGE_SIZE,
    total,
    stale,
    onPageChange,
  });
  const busy = stale || listed.busy;

  if (sessions.isPending || (stale && !read)) {
    return <StatusScreen kind="loading" />;
  }
  if (sessions.error && !read) {
    return loadError(sessions.error, () => void sessions.refetch());
  }
  if (!read) {
    if (filter.relation || filter.q) {
      return (
        <EmptyState
          className="w-full"
          title={t("sessionList.noMatch")}
          description={t("sessionList.noMatchHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={onClear}>
              {t("sessionList.clearFilters")}
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        title={
          filter.status === undefined
            ? t("sessions.empty")
            : t("sessionList.filter.empty")
        }
      />
    );
  }
  return (
    <div
      aria-busy={busy}
      data-busy={busy}
      className="flex flex-col items-start gap-4 transition-opacity data-[busy=true]:opacity-60 data-[busy=true]:delay-150"
    >
      <SessionsOverview sessions={listed.items} />
      {isApiError(sessions.error, "FORBIDDEN") ? (
        // Asking again would be refused again: say who may see it instead.
        <StatusScreen kind="forbidden" />
      ) : (
        <CursorListFailure list={sessions} page={listed} />
      )}
      {/* The last filter's pages would lead past the new one's rows. */}
      {!stale && isPaged(listed) ? (
        <ListPagination list={listed} />
      ) : (
        <Text variant="meta">
          {t("sessionList.shown", { count: listed.items.length })}
        </Text>
      )}
    </div>
  );
}

/** Why the signed-in credential may not take each session action. */
export function useUnavailable(): SessionActionProps["unavailable"] {
  const { t } = useI18n();
  const missing = (scope: string) => t("guard.missingScope", { scope });
  const canAnswer = useCan("sessions:approve");
  const canControl = useCan("sessions:control");
  const canSend = useCan("sessions:write");
  return {
    ...(canAnswer ? {} : { answer: missing("sessions:approve") }),
    ...(canControl ? {} : { control: missing("sessions:control") }),
    ...(canSend ? {} : { send: missing("sessions:write") }),
  };
}

export function SessionDetailScreen() {
  const { t } = useI18n();
  const { id } = useParams({ from: "/authed/sessions/$id" });
  const { tab } = sessionSearch(useSearch({ from: "/authed/sessions/$id" }));
  const navigate = useNavigate({ from: "/sessions/$id" });
  const unavailable = useUnavailable();
  const [takenOver, setTakenOver] = useState<string | null>(null);
  return (
    // The screen fills the area under the top bar, so the chat reaches the bottom.
    <div className="flex flex-1 flex-col">
      <SessionDetail
        id={id}
        tab={tab ?? "chat"}
        onTabChange={(next) =>
          void navigate({
            search: ({ tab: _, ...rest }) =>
              next === "chat" ? rest : { ...rest, tab: next },
            replace: true,
          })
        }
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
        panel={(session, report) => (
          <SessionOutputsPanel session={session} onSummary={report} />
        )}
        timelineExtra={(session) => <SessionGitHubWork session={session} />}
        notice={(session) => (
          <SessionTakeover
            id={id}
            session={session}
            done={takenOver === id}
            onDone={() => setTakenOver(id)}
          />
        )}
        unavailable={unavailable}
        refusal={(error) => t(errorKey(error.code))}
      />
    </div>
  );
}
