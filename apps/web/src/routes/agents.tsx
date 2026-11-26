import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import type {
  Agent,
  AgentActivation,
  AgentListItem,
  CountAgentsResponse,
} from "@werft-ai/contracts";
import { privateChannelsPending } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { ListToolbar } from "@werft-ai/react/components";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  buttonVariants,
  cn,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Page,
  RowLines,
  SegmentedControl,
  SegmentedControlItem,
  Text,
} from "@werft-ai/ui";
import { useCallback, useRef, useState } from "react";
import {
  administeredAgentsQuery,
  agentCountsQuery,
  agentPagesQuery,
  agentSummariesQuery,
} from "../api/queries.ts";
import { permissionReason, useHasPermission, useRole } from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import {
  ADMINISTERED_LIST_LIMIT,
  AdministeredAgents,
} from "../components/agent-admins.tsx";
import {
  AgentChannels,
  AgentEngine,
  AgentRunning,
  AgentSlug,
  SlackActionMark,
} from "../components/agent-columns.tsx";
import {
  OWNERLESS_GRACE_DAYS,
  OwnerlessBadge,
} from "../components/agent-ownerless.tsx";
import { agentRefusal } from "../components/agent-refusal.ts";
import {
  AgentStateText,
  listedAgentState,
} from "../components/agent-state.tsx";
import {
  CursorListFailure,
  type GoToPage,
  ListPagination,
  pageParam,
  useClientPage,
  useCursorPage,
} from "../components/list-pages.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { PrivateChannelsPending } from "../components/private-channels-pending.tsx";
import { OPENS_ROW, TABLE_ROW_LINK } from "../components/row-link.ts";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

export interface AgentsSearch {
  /** Absent on the first page. */
  readonly page?: number;
}

/** Rows on one page of the agents list. */
export const AGENTS_PAGE_SIZE = 15;

export function agentsSearch(search: Record<string, unknown>): AgentsSearch {
  const page = pageParam(search.page);
  return page ? { page } : {};
}

export function AgentsScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const navigate = useNavigate();
  const page = agentsSearch(useSearch({ from: "/authed/agents" })).page ?? 1;
  // Each page is its own entry, so the back button returns to the last one.
  const goToPage = useCallback<GoToPage>(
    (next, options) =>
      void navigate({
        to: "/agents",
        search: next > 1 ? { page: next } : {},
        replace: options?.replace ?? false,
      }),
    [navigate],
  );
  const role = useRole();
  // The counts answer the same callers as the list, so they also say
  // whether the caller may list agents at all.
  const counts = useQuery(agentCountsQuery(client));
  // Making an agent needs less than listing them all: a member makes one and
  // becomes its admin.
  const reason = useHasPermission("agent.create")
    ? undefined
    : permissionReason(t, "agent.create", role);
  const failed = counts.isError && !isApiError(counts.error, "FORBIDDEN");

  return (
    <Page
      title={t("agents.title")}
      description={t("agents.intro")}
      actions={
        failed ? undefined : (
          <ReasonButton
            className={buttonVariants()}
            reason={reason}
            onClick={() => void navigate({ to: "/agents/new" })}
          >
            {t("agents.new")}
          </ReasonButton>
        )
      }
    >
      {counts.isPending ? (
        <StatusScreen kind="loading" />
      ) : counts.error ? (
        isApiError(counts.error, "FORBIDDEN") ? (
          <>
            <p className="web-page__intro">{t("agents.listWithheld")}</p>
            <AdministeredAgents showEmpty />
          </>
        ) : (
          <LoadFailure
            error={counts.error}
            onRetry={() => void counts.refetch()}
          />
        )
      ) : (
        <AgentList
          counts={counts.data.counts}
          page={page}
          onPageChange={goToPage}
        />
      )}
    </Page>
  );
}

function AgentList({
  counts,
  page,
  onPageChange,
}: {
  readonly counts: CountAgentsResponse["counts"];
  readonly page: number;
  readonly onPageChange: GoToPage;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const [scope, setScope] = useState<"all" | "administered" | "ownerless">(
    "all",
  );
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const paged = scope !== "administered";
  const pages = useInfiniteQuery({
    ...agentPagesQuery(client, q, AGENTS_PAGE_SIZE, scope === "ownerless"),
    enabled: paged,
  });
  // A new tab or search opens on the first page.
  const toFirstPage = () => {
    if (page > 1) onPageChange(1, { replace: true });
  };
  const administered = useQuery(administeredAgentsQuery(client));
  // The administered list carries no summaries; the engine, channels and
  // running count come from the list API by id, as the "all" tab reads them.
  const ids = administered.data?.items.map((agent) => agent.id) ?? [];
  const summaries = useQuery({
    ...agentSummariesQuery(client, ids),
    enabled: !paged && ids.length > 0,
  });
  const mine = administeredWithSummaries(
    administered.data?.items,
    summaries.data?.items,
  );
  // The server stops at this many, so a full page may have left some out.
  const truncated =
    (administered.data?.items.length ?? 0) >= ADMINISTERED_LIST_LIMIT;
  const search = useRef<HTMLInputElement>(null);
  // The clear button goes away with the empty result, so focus returns to
  // the field it emptied.
  const clear = () => {
    setQuery("");
    toFirstPage();
    search.current?.focus();
  };
  const listedPage = useCursorPage({
    list: pages,
    page,
    pageSize: AGENTS_PAGE_SIZE,
    // The counts know no search.
    total: q
      ? undefined
      : scope === "ownerless"
        ? counts.ownerless
        : counts.all,
    stale: !paged,
    onPageChange,
  });
  const minePage = useClientPage({
    items: paged
      ? undefined
      : mine?.filter((agent) => matchesAgentQuery(agent, query)),
    page,
    pageSize: AGENTS_PAGE_SIZE,
    onPageChange,
  });
  const listed = paged ? listedPage : minePage;
  const read = paged ? pages.data !== undefined : mine !== undefined;
  const shown = read ? (listed.total ?? listed.items.length) : undefined;
  const pickScope = (next: typeof scope) => {
    setScope(next);
    toFirstPage();
  };
  // Workspace managers are the ones who name a successor.
  const manager = role === "owner" || role === "admin";
  return (
    <div className="flex flex-col gap-4">
      {manager && counts.ownerless > 0 && scope !== "ownerless" ? (
        <Alert variant="amber" className="border-0">
          <AlertTitle>
            {t("agents.ownerless.alert", { count: counts.ownerless })}
          </AlertTitle>
          <AlertDescription>
            {t("agents.ownerless.alertText", { days: OWNERLESS_GRACE_DAYS })}
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => pickScope("ownerless")}
              >
                {t("agents.ownerless.show")}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      <ListToolbar
        filter={
          <SegmentedControl
            aria-label={t("agents.tabs.label")}
            value={scope}
            onValueChange={(next) => pickScope(next as typeof scope)}
          >
            <SegmentedControlItem value="all" count={counts.all}>
              {t("agents.tabs.all")}
            </SegmentedControlItem>
            <SegmentedControlItem
              value="administered"
              count={counts.administered}
            >
              {t("agents.tabs.administered")}
            </SegmentedControlItem>
            {counts.ownerless > 0 || scope === "ownerless" ? (
              <SegmentedControlItem value="ownerless" count={counts.ownerless}>
                {t("agents.tabs.ownerless")}
              </SegmentedControlItem>
            ) : null}
          </SegmentedControl>
        }
        search={{
          ref: search,
          type: "search",
          "aria-label": t("agents.search"),
          placeholder: t("agents.search"),
          maxLength: SEARCH_MAX,
          value: query,
          onChange: (event) => {
            setQuery(event.target.value);
            toFirstPage();
          },
        }}
      />
      {/* Outside the lists, so switching category or state keeps the same
          live region and a screen reader hears each new count. */}
      <output className="sr-only">
        {query.trim() === "" || shown === undefined
          ? ""
          : t("agents.shown", { count: shown })}
      </output>
      <PrivateChannelsPending
        pending={privateChannelsPending(paged ? pages.data : summaries.data)}
      />
      {paged ? (
        counts.all === 0 ? (
          <EmptyState title={t("agents.empty")} />
        ) : pages.isPending ? (
          <StatusScreen kind="loading" />
        ) : pages.error &&
          !pages.data?.pages.some((one) => one.items.length > 0) ? (
          <LoadFailure
            error={pages.error}
            onRetry={() => void pages.refetch()}
          />
        ) : (
          <div
            aria-busy={listed.busy}
            data-busy={listed.busy}
            className="flex flex-col gap-4 transition-opacity data-[busy=true]:opacity-60 data-[busy=true]:delay-150"
          >
            <AgentsIn agents={listed.items} onClear={clear} />
            <CursorListFailure list={pages} page={listed} />
            <ListPagination list={listed} />
          </div>
        )
      ) : administered.isPending || (ids.length > 0 && summaries.isPending) ? (
        <StatusScreen kind="loading" />
      ) : administered.error ? (
        <LoadFailure
          error={administered.error}
          onRetry={() => void administered.refetch()}
        />
      ) : summaries.error ? (
        // A dash would claim no engine or channel; say the read failed.
        <LoadFailure
          error={summaries.error}
          onRetry={() => void summaries.refetch()}
        />
      ) : administered.data.items.length === 0 ? (
        <EmptyState title={t("agentAdmins.mine.empty")} />
      ) : (
        <div>
          {truncated ? (
            <Text variant="meta" className="mb-3">
              {t("agentAdmins.mine.truncated", {
                count: ADMINISTERED_LIST_LIMIT,
              })}
            </Text>
          ) : null}
          <div className="flex flex-col gap-4">
            <AgentsIn agents={listed.items} onClear={clear} />
            <ListPagination list={listed} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The administered agents in their order, each with its list item (and so its
 * summary) when the list API returned it; one it left out keeps its row.
 */
function administeredWithSummaries(
  agents: readonly Agent[] | undefined,
  listed: readonly AgentListItem[] | undefined,
): readonly AgentListItem[] | undefined {
  if (agents === undefined) return undefined;
  const byId = new Map(listed?.map((item) => [item.id, item]));
  return agents.map(
    (agent) =>
      byId.get(agent.id) ?? { ...agent, activation: activationOf(agent) },
  );
}

/**
 * For a row the list left out: contracts' agentActivationOf, which the web
 * may not import as a value. Typed by AgentActivation, so a renamed value
 * fails the type check here.
 */
function activationOf(agent: Agent): AgentActivation {
  if (agent.status === "active" && agent.active_release_id !== null)
    return "active";
  if (agent.status !== "archived" && agent.active_release_id === null)
    return "draft";
  return "inactive";
}

/**
 * Name or slug, ignoring case, as the list API's `q` matches; for the
 * administered list, which takes no query.
 */
function matchesAgentQuery(agent: Agent, query: string) {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    agent.name.toLowerCase().includes(needle) ||
    agent.slug.toLowerCase().includes(needle)
  );
}

function AgentsIn({
  agents,
  onClear,
}: {
  /** The list after the search. */
  readonly agents: readonly AgentListItem[];
  readonly onClear: () => void;
}) {
  const { t } = useI18n();
  if (agents.length === 0) {
    return (
      <EmptyState
        title={t("agents.noMatch")}
        description={t("agents.noMatchHint")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            {t("agents.clearSearch")}
          </Button>
        }
      />
    );
  }
  return <AgentTable agents={agents} />;
}

function AgentTable({ agents }: { readonly agents: readonly AgentListItem[] }) {
  const { t } = useI18n();
  const column = {
    engine: t("agents.column.engine"),
    state: t("agents.column.state"),
    channels: t("agents.column.channels"),
    running: t("agents.column.running"),
  };
  return (
    <GridTable
      aria-label={t("agents.title")}
      columns={COLUMNS}
      align={ALIGN}
      narrowAt={640}
      narrowCards={true}
      framed={true}
    >
      <GridTableHeader>
        <GridTableColumnHeader>{t("agents.column.name")}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.engine}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.state}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.channels}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.running}</GridTableColumnHeader>
      </GridTableHeader>
      {agents.map((agent) => (
        <GridTableRow
          key={agent.id}
          inactive={listedAgentState(agent) === "archived"}
          className={OPENS_ROW}
        >
          <GridTableCell>
            <RowLines>
              <span className="flex min-w-0 items-center gap-2">
                <Link
                  to="/agents/$id"
                  params={{ id: agent.id }}
                  title={agent.name}
                  className={cn(
                    "min-w-0 truncate font-medium text-link underline-offset-2 hover:underline",
                    TABLE_ROW_LINK,
                  )}
                >
                  {agent.name}
                </Link>
                <SlackActionMark agent={agent} />
              </span>
              <AgentSlug slug={agent.slug} />
            </RowLines>
          </GridTableCell>
          <GridTableCell cardLabel={column.engine}>
            <AgentEngine agent={agent} />
          </GridTableCell>
          <GridTableCell cardLabel={column.state} className="gap-2">
            <AgentStateText agent={agent} />
            <OwnerlessBadge agent={agent} />
          </GridTableCell>
          <GridTableCell cardLabel={column.channels} className="gap-2">
            <AgentChannels agent={agent} />
          </GridTableCell>
          <GridTableCell cardLabel={column.running} className="tabular-nums">
            <AgentRunning agent={agent} />
          </GridTableCell>
        </GridTableRow>
      ))}
    </GridTable>
  );
}

// Name | engine | state | channels | running sessions; at 640px of table width
// or less, one card per agent. Engine, state, channels and the running count
// are as wide as their content and the name takes the rest; the running
// count sits at the end like numbers.
const COLUMNS = "minmax(0,1fr) max-content max-content max-content max-content";
const ALIGN = ["start", "start", "start", "start", "end"] as const;

/**
 * A blank card, made in steps.
 */
export function NewAgentScreen() {
  const { t } = useI18n();
  const role = useRole();
  const refuse = (error: unknown) =>
    isApiError(error) ? agentRefusal(t, error, role) : t(errorKey("UNKNOWN"));
  return (
    <Page title={t("agents.newTitle")} description={t("agents.newIntro")}>
      <NewAgentFlow refuse={refuse} />
    </Page>
  );
}
