import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { type ApiClient, unwrap } from "@werft-ai/client";
import type {
  CountSessionsResponse,
  InstallationLimitsResponse,
  MemberLimitsResponse,
  UsageBreakdownBy,
  UsageBreakdownResponse,
  UsageSeriesResponse,
  UsageSummaryScope,
  UsageToolCallsResponse,
  UsageToolsResponse,
} from "@werft-ai/contracts";
import {
  scopedKey,
  usageBreakdownQuery,
  usageSeriesQuery,
} from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import {
  DetailLayout,
  Findings,
  findTools,
  InstallationLimits,
  MoreLink,
  OperationsHead,
  type OperationsTab,
  SessionCounts,
  sortTools,
  TOOL_RAIL_CALLS,
  type ToolCallSort,
  ToolRail,
  type ToolSort,
  ToolsFilter,
  ToolsSummary,
  ToolTable,
  UsageBasis,
  UsageCostTable,
  UsageDailyCost,
  UsageFilters,
  UsageKpis,
  type UsagePeriod,
  UsageTokenMix,
} from "@werft-ai/react/components";
import { Badge, Card, EmptyState, Section, Skeleton } from "@werft-ai/ui";
import { useRef, useState } from "react";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  type OperationsSearch,
  operationsSearch,
} from "./operations-search.ts";
import { builtinToolNote } from "./operations-tool-notes.ts";
import { SESSION_FILTERS } from "./sessions.tsx";

const DAY_MS = 86_400_000;
const USAGE_STALE_MS = 60_000;
const TOP_AGENTS = 3;

// Cut at the next UTC midnight so the query key stays the same all day.
export function usagePeriod(
  days: number,
  now = new Date(),
): { readonly since: string; readonly until: string } {
  const until = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return {
    since: new Date(until - days * DAY_MS).toISOString(),
    until: new Date(until).toISOString(),
  };
}

function useUsageFilters() {
  // Every tab with filters validates its search as OperationsSearch at least.
  const search: OperationsSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const operator = useHasPermission("usage.installation_read");
  const scope: UsageSummaryScope = operator
    ? (search.scope ?? "installation")
    : "me";
  const days = search.days ?? 30;
  return {
    operator,
    scope,
    days,
    setScope: (next: UsageSummaryScope) =>
      void navigate({ to: ".", search: (prev) => ({ ...prev, scope: next }) }),
    setDays: (next: UsagePeriod) =>
      void navigate({ to: ".", search: (prev) => ({ ...prev, days: next }) }),
  };
}

function usageToolsQuery(
  client: ApiClient,
  scope: UsageSummaryScope,
  since: string,
  until: string,
  agentId: string | undefined,
) {
  return queryOptions({
    queryKey: scopedKey(
      client,
      "usage-tools",
      scope,
      since,
      until,
      agentId ?? null,
    ),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/tools", {
          params: {
            query: {
              scope,
              since,
              until,
              ...(agentId ? { agent_id: agentId } : {}),
            },
          },
        }),
      ) as Promise<UsageToolsResponse>,
    retry: false,
  });
}

function usageToolCallsQuery(
  client: ApiClient,
  name: string,
  scope: UsageSummaryScope,
  since: string,
  until: string,
  agentId: string | undefined,
  sort: ToolCallSort,
) {
  return queryOptions({
    queryKey: scopedKey(
      client,
      "usage-tool-calls",
      name,
      scope,
      since,
      until,
      agentId ?? null,
      sort,
    ),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/tools/{name}/calls", {
          params: {
            path: { name },
            query: {
              scope,
              since,
              until,
              sort,
              limit: TOOL_RAIL_CALLS,
              ...(agentId ? { agent_id: agentId } : {}),
            },
          },
        }),
      ) as Promise<UsageToolCallsResponse>,
    retry: false,
  });
}

export function useInstallationLimits(enabled: boolean) {
  const { client } = useWerft();
  return useQuery({
    // The home's key, so the two screens share one read.
    queryKey: scopedKey(client, "limits"),
    queryFn: () =>
      unwrap(client.GET("/v1/limits")) as Promise<InstallationLimitsResponse>,
    enabled,
    retry: false,
  });
}

const TAB_PATHS: Readonly<Record<OperationsTab, string>> = {
  overview: "/operations",
  usage: "/operations/usage",
  tools: "/operations/tools",
  limits: "/operations/limits",
};

const TABS: readonly OperationsTab[] = ["overview", "usage", "tools", "limits"];

function useCurrentTab() {
  const pathname = useRouterState({
    // The screen on show, not the one still loading: the head moves with it.
    select: (s) => (s.resolvedLocation ?? s.location).pathname,
  });
  const tabs = TABS;
  const current =
    tabs.find(
      (tab) =>
        tab !== "overview" && pathname.replace(/\/$/, "") === TAB_PATHS[tab],
    ) ?? "overview";
  return { tabs, current };
}

function periodFiltersFor(
  tab: OperationsTab,
  search: Record<string, unknown>,
): OperationsSearch {
  return tab === "limits" ? {} : operationsSearch(search);
}

function MenuHead() {
  const { tabs, current } = useCurrentTab();
  return (
    <OperationsHead
      tabs={tabs}
      current={current}
      tabLink={(tab, label) => (
        <Link
          to={TAB_PATHS[tab]}
          search={(prev) => periodFiltersFor(tab, prev)}
          activeOptions={{ exact: true, includeSearch: false }}
        >
          {label}
        </Link>
      )}
    />
  );
}

export function OperationsLayout() {
  const { current } = useCurrentTab();
  return (
    <>
      {/* The tools tab has a rail, so it draws the head inside its own body. */}
      {current === "tools" ? null : <MenuHead />}
      <Outlet />
    </>
  );
}

export function OperationsOverviewScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const filters = useUsageFilters();
  const { since, until } = usagePeriod(filters.days);
  const counts = useQuery({
    queryKey: scopedKey(client, "session-counts"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/counts"),
      ) as Promise<CountSessionsResponse>,
    refetchInterval: 30_000,
    retry: false,
  });
  const limits = useInstallationLimits(filters.operator);
  // The KPIs add up the series: the summary is slow over a long period.
  const series = useQuery({
    ...usageSeriesQuery(client, filters.scope, since, until),
    placeholderData: keepPreviousData,
    staleTime: USAGE_STALE_MS,
  });
  const tools = useQuery({
    ...usageToolsQuery(client, filters.scope, since, until, undefined),
    placeholderData: keepPreviousData,
    staleTime: USAGE_STALE_MS,
  });
  const agents = useQuery({
    ...usageBreakdownQuery(client, filters.scope, since, "agent", until),
    placeholderData: keepPreviousData,
    staleTime: USAGE_STALE_MS,
  });
  return (
    <div
      aria-busy={
        series.isPending || tools.isPending || agents.isPending || undefined
      }
      className="flex min-w-0 flex-col gap-8"
    >
      <SessionCounts
        counts={counts.data?.counts}
        slots={
          !filters.operator || limits.isError
            ? undefined
            : limits.data
              ? {
                  used: limits.data.usage.execution_slots_used,
                  limit: limits.data.limits.execution_slot_limit,
                }
              : null
        }
        statusLink={(status, link) => {
          const filter = SESSION_FILTERS.find((name) => name === status);
          return (
            <Link
              to="/sessions"
              search={filter ? { status: filter } : {}}
              className={link.className}
            >
              {link.children}
            </Link>
          );
        }}
        error={
          counts.isError ? (
            <Card className="py-0">
              <LoadFailure
                error={counts.error}
                onRetry={() => void counts.refetch()}
              />
            </Card>
          ) : undefined
        }
      />
      <div>
        <UsageFilters
          {...(filters.operator
            ? { scope: filters.scope, onScopeChange: filters.setScope }
            : {})}
          days={filters.days}
          onDaysChange={filters.setDays}
        />
        <Section
          title={t("operations.recent", { days: filters.days })}
          actions={
            <MoreLink asChild>
              <Link to="/operations/usage" search={(prev) => prev}>
                {t("operations.usageMore")}
              </Link>
            </MoreLink>
          }
        >
          {series.isError ? (
            <Card className="py-0">
              <LoadFailure
                error={series.error}
                onRetry={() => void series.refetch()}
              />
            </Card>
          ) : (
            <UsageKpis buckets={series.data?.buckets} />
          )}
        </Section>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section
          title={t("operations.findings")}
          description={t("operations.findings.description")}
          actions={
            <MoreLink asChild>
              <Link to="/operations/tools" search={(prev) => prev}>
                {t("operations.findings.more")}
              </Link>
            </MoreLink>
          }
        >
          {tools.isError ? (
            <Card className="py-0">
              <LoadFailure
                error={tools.error}
                onRetry={() => void tools.refetch()}
              />
            </Card>
          ) : (
            <Findings data={tools.data} />
          )}
        </Section>
        <Section
          title={t("operations.topAgents")}
          description={t("operations.topAgentsNote", { days: filters.days })}
        >
          {agents.isError ? (
            <Card className="py-0">
              <LoadFailure
                error={agents.error}
                onRetry={() => void agents.refetch()}
              />
            </Card>
          ) : (
            <UsageCostTable
              label={t("operations.topAgents")}
              head={t("operations.agent")}
              by="agent"
              rows={agents.data?.rows.slice(0, TOP_AGENTS)}
              tokens={false}
              placeholderRows={TOP_AGENTS}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

type Answer<T> = { readonly data: T | undefined; readonly error: Error | null };

type UsageSet = {
  readonly key: string;
  readonly scope: UsageSummaryScope;
  readonly series: Answer<UsageSeriesResponse>;
  readonly models: Answer<UsageBreakdownResponse>;
  readonly agents: Answer<UsageBreakdownResponse>;
};

export function OperationsUsageScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const filters = useUsageFilters();
  const period = usagePeriod(filters.days);
  const { since, until } = period;
  const series = useQuery({
    ...usageSeriesQuery(client, filters.scope, since, until),
    placeholderData: keepPreviousData,
    staleTime: USAGE_STALE_MS,
  });
  const breakdown = (by: UsageBreakdownBy) => ({
    ...usageBreakdownQuery(client, filters.scope, since, by, until),
    placeholderData: keepPreviousData,
    staleTime: USAGE_STALE_MS,
  });
  const models = useQuery(breakdown("model"));
  const agents = useQuery(breakdown("agent"));
  // The three answers are shown as one set (figures, failures and the basis
  // line together). A set is taken once every query has answered for the
  // picked scope and period and none is fetching, or at once when the picked
  // period is already cached; otherwise the set on screen stays.
  const queries = [series, models, agents];
  const key = `${filters.scope} ${since} ${until}`;
  const answered = queries.every(
    (query) => !query.isPlaceholderData && (query.isSuccess || query.isError),
  );
  const fetching = queries.some((query) => query.isFetching);
  const set = useRef<UsageSet | undefined>(undefined);
  if (answered && (!fetching || set.current?.key !== key))
    set.current = {
      key,
      scope: filters.scope,
      series: { data: series.data, error: series.error },
      models: { data: models.data, error: models.error },
      agents: { data: agents.data, error: agents.error },
    };
  const shown = set.current;
  const empty =
    shown?.series.data?.buckets.every((bucket) => bucket.session_count === 0) ??
    false;
  const failure = (error: Error, retry: () => unknown) => (
    <Card className="py-0">
      <LoadFailure error={error} onRetry={() => void retry()} />
    </Card>
  );
  const table = (
    shownAnswer: Answer<UsageBreakdownResponse> | undefined,
    retry: () => unknown,
    by: UsageBreakdownBy,
    label: string,
    head: string,
  ) =>
    shownAnswer?.error ? (
      failure(shownAnswer.error, retry)
    ) : (
      <UsageCostTable
        label={label}
        head={head}
        by={by}
        rows={shownAnswer?.data?.rows}
      />
    );
  return (
    <>
      <UsageFilters
        {...(filters.operator
          ? { scope: filters.scope, onScopeChange: filters.setScope }
          : {})}
        days={filters.days}
        onDaysChange={filters.setDays}
      />
      {shown?.series.error ? (
        <div aria-busy={fetching || undefined}>
          {failure(shown.series.error, series.refetch)}
        </div>
      ) : (
        <div
          aria-busy={fetching || undefined}
          className="flex min-w-0 flex-col gap-8"
        >
          <UsageKpis buckets={shown?.series.data?.buckets} />
          {empty ? (
            <EmptyState title={t("operations.usageEmpty")} />
          ) : (
            <>
              <UsageBasis
                scope={shown?.scope ?? filters.scope}
                period={shown?.series.data?.period ?? period}
                refreshedAt={shown?.series.data?.refreshed_at}
                className="-mt-4 leading-4"
              />
              <UsageDailyCost
                buckets={shown?.series.data?.buckets}
                days={shown?.series.data?.buckets.length ?? filters.days}
              />
              {shown?.models.error ? null : (
                <UsageTokenMix totals={shown?.models.data?.totals} />
              )}
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
                <Section title={t("operations.byModel")}>
                  {table(
                    shown?.models,
                    models.refetch,
                    "model",
                    t("operations.byModel"),
                    t("operations.model"),
                  )}
                </Section>
                <Section title={t("operations.byAgent")}>
                  {table(
                    shown?.agents,
                    agents.refetch,
                    "agent",
                    t("operations.byAgent"),
                    t("operations.agent"),
                  )}
                </Section>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

export function OperationsToolsScreen() {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const filters = useUsageFilters();
  const { agent_id: agentId } = useSearch({ from: "/authed/operations/tools" });
  const { since, until } = usagePeriod(filters.days);
  const tools = useQuery({
    ...usageToolsQuery(client, filters.scope, since, until, agentId),
    placeholderData: keepPreviousData,
    staleTime: USAGE_STALE_MS,
  });
  const [sort, setSort] = useState<ToolSort>("calls");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string>();
  const [callSort, setCallSort] = useState<ToolCallSort>("recent");
  const rows = tools.data?.tools;
  const tool = rows?.find((row) => row.name === picked) ?? rows?.[0];
  const calls = useQuery({
    ...usageToolCallsQuery(
      client,
      tool?.name ?? "",
      filters.scope,
      since,
      until,
      agentId,
      callSort,
    ),
    enabled: tool !== undefined,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === tool?.name ? previous : undefined,
    staleTime: USAGE_STALE_MS,
  });
  const shown = rows && findTools(sortTools(rows, sort), query);
  const rail =
    tools.isError || rows?.length === 0 ? undefined : (
      <ToolRail
        name={tool?.name}
        tool={tool}
        perDay={calls.data?.per_day}
        calls={calls.data?.calls}
        callSort={callSort}
        onCallSortChange={setCallSort}
        error={
          calls.isError ? (
            <LoadFailure
              error={calls.error}
              onRetry={() => void calls.refetch()}
            />
          ) : undefined
        }
      />
    );
  return (
    <DetailLayout rail={rail}>
      <MenuHead />
      <UsageFilters
        {...(filters.operator
          ? { scope: filters.scope, onScopeChange: filters.setScope }
          : {})}
        days={filters.days}
        onDaysChange={filters.setDays}
      />
      <div
        aria-busy={tools.isPending || undefined}
        className="@container flex min-w-0 flex-col gap-8"
      >
        {tools.isError ? null : rows?.length === 0 ? null : (
          <ToolsSummary
            tools={rows}
            period={t("operations.recent", { days: filters.days })}
          />
        )}
        <Section
          title={t("operations.tools")}
          badge={
            <Badge>
              {rows ? (
                rows.length
              ) : (
                <Skeleton
                  inline
                  decorative
                  width="0.75rem"
                  height="1lh"
                  className="justify-center"
                />
              )}
            </Badge>
          }
        >
          <ToolsFilter
            sort={sort}
            onSortChange={setSort}
            onQueryChange={setQuery}
          />
          {tools.isError ? (
            <Card className="py-0">
              <LoadFailure
                error={tools.error}
                onRetry={() => void tools.refetch()}
              />
            </Card>
          ) : (
            <ToolTable
              tools={shown}
              label={t("operations.tools")}
              selected={tool?.name}
              onSelect={setPicked}
              describe={(name) =>
                rows?.find((row) => row.name === name)?.description ??
                builtinToolNote(locale, name)
              }
              searched={query !== ""}
            />
          )}
        </Section>
      </div>
    </DetailLayout>
  );
}

export function OperationsLimitsScreen() {
  const { client } = useWerft();
  const operator = useHasPermission("usage.installation_read");
  const installation = useInstallationLimits(operator);
  const own = useQuery({
    queryKey: scopedKey(client, "limits", "me"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/limits", { params: { query: { scope: "me" } } }),
      ) as Promise<MemberLimitsResponse>,
    enabled: !operator,
    retry: false,
  });
  const limits = operator ? installation : own;
  return (
    <InstallationLimits
      scope={operator ? "installation" : "me"}
      limits={limits.data}
      error={
        limits.isError ? (
          <Card className="py-0">
            <LoadFailure
              error={limits.error}
              onRetry={() => void limits.refetch()}
            />
          </Card>
        ) : undefined
      }
    />
  );
}
