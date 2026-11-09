import {
  hashKey,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
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
  usePendingRail,
} from "@werft-ai/react/blocks";
import { DetailLayout, ListToolbar } from "@werft-ai/react/components";
import {
  Button,
  buttonVariants,
  EmptyState,
  FilterMenu,
  Page,
  SegmentedControl,
  SegmentedControlItem,
  Text,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCan } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { SessionGitHubWork } from "./session-github-work.tsx";
import { SessionOutputsCount, SessionOutputsTab } from "./session-outputs.tsx";
import { SessionsOverview } from "./session-overview.tsx";
import { SessionReleaseBlock } from "./session-release.tsx";
import { SessionShareBlock } from "./session-share.tsx";
import { SessionWorkspaceLimit } from "./session-workspace-limit.tsx";

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
  "stopped",
  "failed",
] as const satisfies readonly SessionStatus[];
export type SessionFilter = (typeof SESSION_FILTERS)[number];

/** The relation filter's choices past "all", in the design's order. */
export const SESSION_RELATIONS = [
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
}

export function sessionsSearch(
  search: Record<string, unknown>,
): SessionsSearch {
  const status = SESSION_FILTERS.find((name) => name === search.status);
  const relation = SESSION_RELATIONS.find((name) => name === search.relation);
  return { ...(status ? { status } : {}), ...(relation ? { relation } : {}) };
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
  const refusal = (error: { readonly code: string }) => t(errorKey(error.code));
  const rail = usePendingRail({
    renderError: loadError,
    unavailable,
    refusal,
  });
  const go = (next: SessionsSearch) =>
    void navigate({
      search: next,
      // Replace, not push: flipping through the filters would otherwise fill
      // the back button with filter entries.
      replace: true,
    });
  const pick = (next: string) =>
    go({
      ...(next === "all" ? {} : { status: next as SessionFilter }),
      ...(relation ? { relation } : {}),
    });
  const pickRelation = (next: string) =>
    go({
      ...(address.status ? { status: address.status } : {}),
      ...(next === "all" ? {} : { relation: next as SessionRelationFilter }),
    });
  // The clear button leaves with the empty state, so focus would fall to
  // the page; it goes back to the search box instead.
  const clear = () => {
    setQuery("");
    go({});
    search.current?.focus();
  };
  return (
    <DetailLayout rail={rail.rail}>
      <Page
        title={t("sessions.title")}
        description={t("sessions.intro")}
        actions={
          <Link
            to="/sessions/map"
            className={buttonVariants({ variant: "outline" })}
          >
            {t("sessionList.map")}
          </Link>
        }
      >
        <div className="flex flex-col gap-[var(--werft-space-block)]">
          <ApprovalInbox
            layout="summary"
            rail={rail}
            renderError={loadError}
            unavailable={unavailable}
            refusal={refusal}
          />
          <div className="flex min-w-0 flex-col gap-4">
            <ListToolbar
              filter={
                <SegmentedControl
                  aria-label={t("sessionList.filter.label")}
                  size="toolbar"
                  value={tab}
                  onValueChange={pick}
                >
                  <SegmentedControlItem value="all" count={counts.data?.total}>
                    {t("sessionList.filter.all")}
                  </SegmentedControlItem>
                  {SESSION_FILTERS.map((name) => (
                    <SegmentedControlItem
                      key={name}
                      value={name}
                      count={counts.data?.counts[name]}
                    >
                      {t(`sessions.status.${name}`)}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              }
              filters={
                <FilterMenu
                  label={t("sessionList.relation.label")}
                  options={[
                    { value: "all", label: t("sessionList.relation.all") },
                    ...SESSION_RELATIONS.map((name) => ({
                      value: name,
                      label: t(`sessionList.relation.${name}`),
                    })),
                  ]}
                  value={relation ?? "all"}
                  onValueChange={pickRelation}
                />
              }
              search={{
                ref: search,
                type: "search",
                "aria-label": t("sessionList.search"),
                placeholder: t("sessionList.search"),
                maxLength: SEARCH_MAX,
                value: query,
                onChange: (event) => setQuery(event.target.value),
              }}
            />
            <SessionsView
              filter={{
                ...(tab === "all" ? {} : { status: tab }),
                ...(relation ? { relation } : {}),
                ...(q ? { q } : {}),
              }}
              onClear={clear}
            />
          </div>
        </div>
      </Page>
    </DetailLayout>
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
        // list sits unmounted behind a status tab. It has no staleTime, so it
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
  const unfiltered = Object.keys(filter).length === 0;
  return useInfiniteQuery({
    // Unfiltered, it is the list the session hooks refresh by its exact key;
    // the rest sit under the sessions key, so those refreshes reach them too.
    queryKey: unfiltered
      ? queryKeysOf(client).sessions
      : [...statusLists(client), filter],
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/sessions", {
          params: {
            query: { ...filter, ...(pageParam ? { cursor: pageParam } : {}) },
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
function useSessionCounts(
  relation: SessionRelationFilter | undefined,
  q: string | undefined,
) {
  const { client } = useWerft();
  // Here, read whatever the tab: the counts follow every list refresh, and
  // so does the filtered list under the same key.
  useFollowListRefresh();
  const filter = { ...(relation ? { relation } : {}), ...(q ? { q } : {}) };
  return useQuery({
    queryKey: [...statusLists(client), "counts", filter],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/counts", { params: { query: filter } }),
      ) as Promise<CountSessionsResponse>,
    // The tabs keep their numbers, and so their widths, until the new ones come.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** The caller's sessions for the filters picked, a page at a time. */
function SessionsView({
  filter,
  onClear,
}: {
  readonly filter: SessionsFilter;
  readonly onClear: () => void;
}) {
  const { t } = useI18n();
  const sessions = useListedSessions(filter);
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  // The last filter's rows stay while the new filter is read, marked busy;
  // the fade waits a moment so a quick answer never flickers.
  const busy = sessions.isPlaceholderData;

  if (sessions.isPending || (busy && items.length === 0)) {
    return <StatusScreen kind="loading" />;
  }
  if (sessions.error && items.length === 0) {
    return loadError(sessions.error, () => void sessions.refetch());
  }
  if (items.length === 0) {
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
      <SessionsOverview sessions={items} />
      {isApiError(sessions.error, "FORBIDDEN") ? (
        // Asking again would be refused again: say who may see it instead.
        <StatusScreen kind="forbidden" />
      ) : (
        // A next page of the last filter's rows would land under the new one.
        <PagedListFooter list={sessions} stale={busy} />
      )}
      <Text variant="meta">
        {t("sessionList.shown", { count: items.length })}
      </Text>
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
  const unavailable = useUnavailable();
  return (
    // The screen fills the area under the top bar, so its rail reaches the bottom.
    <div className="flex flex-1 flex-col">
      <SessionDetail
        back={
          <Link
            to="/sessions"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
            {t("session.back")}
          </Link>
        }
        id={id}
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
        controls={(session) => (
          <>
            <SessionWorkspaceLimit mode={session.workspace_limit_mode} />
            <SessionReleaseBlock agent={session.agent} />
            <SessionShareBlock id={session.id} />
          </>
        )}
        tabs={(session) => [
          {
            value: "outputs",
            label: t("session.outputs.title"),
            count: <SessionOutputsCount session={session} />,
            content: <SessionOutputsTab session={session} />,
          },
        ]}
        timelineExtra={(session) => (
          <div className="px-4 pb-4">
            <SessionGitHubWork session={session} />
          </div>
        )}
        unavailable={unavailable}
        refusal={(error) => t(errorKey(error.code))}
      />
    </div>
  );
}
