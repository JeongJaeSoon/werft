import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import type {
  Agent,
  AgentListItem,
  CountAgentsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { ListToolbar, ListViewSwitch } from "@werft-ai/react/components";
import {
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
import { LayoutGrid, List } from "lucide-react";
import { useRef, useState } from "react";
import {
  administeredAgentsQuery,
  agentCountsQuery,
  agentPagesQuery,
} from "../api/queries.ts";
import {
  permissionReason,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import {
  ADMINISTERED_LIST_LIMIT,
  AdministeredAgents,
} from "../components/agent-admins.tsx";
import { AgentCards } from "../components/agent-cards.tsx";
import {
  AgentChannels,
  AgentEngine,
  AgentRunning,
  AgentSlug,
  SlackActionMark,
} from "../components/agent-columns.tsx";
import { agentRefusal } from "../components/agent-refusal.ts";
import { AgentStateText, agentState } from "../components/agent-state.tsx";
import {
  AGENT_VIEWS,
  type AgentView,
  useAgentView,
} from "../components/agent-view.ts";
import { LoadFailure } from "../components/load-failure.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { OPENS_ROW, TABLE_ROW_LINK } from "../components/row-link.ts";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

export function AgentsScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const navigate = useNavigate();
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
        <AgentList counts={counts.data.counts} />
      )}
    </Page>
  );
}

const VIEW_ICON = { cards: LayoutGrid, table: List } as const;

function AgentList({
  counts,
}: {
  readonly counts: CountAgentsResponse["counts"];
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const principal = useMe()?.principal;
  const [view, setView] = useAgentView(
    principal?.kind === "user" ? principal.id : undefined,
  );
  const [scope, setScope] = useState<"all" | "administered">("all");
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const paged = scope !== "administered";
  const pages = useInfiniteQuery({
    ...agentPagesQuery(client, q),
    enabled: paged,
  });
  const administered = useQuery(administeredAgentsQuery(client));
  // The server stops at this many, so a full page may have left some out.
  const truncated =
    (administered.data?.items.length ?? 0) >= ADMINISTERED_LIST_LIMIT;
  const search = useRef<HTMLInputElement>(null);
  // The clear button goes away with the empty result, so focus returns to
  // the field it emptied.
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };
  const shown = paged
    ? pages.data?.pages.flatMap((page) => page.items)
    : administered.data?.items.filter((agent) =>
        matchesAgentQuery(agent, query),
      );
  return (
    <div className="flex flex-col gap-4">
      <ListToolbar
        filter={
          <SegmentedControl
            aria-label={t("agents.tabs.label")}
            value={scope}
            onValueChange={(next) => setScope(next as typeof scope)}
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
          </SegmentedControl>
        }
        view={
          <ListViewSwitch
            aria-label={t("agents.view.label")}
            value={view}
            onValueChange={setView}
            options={AGENT_VIEWS.map((option) => ({
              value: option,
              label: t(`agents.view.${option}`),
              icon: VIEW_ICON[option],
            }))}
          />
        }
        search={{
          ref: search,
          type: "search",
          "aria-label": t("agents.search"),
          placeholder: t("agents.search"),
          maxLength: SEARCH_MAX,
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }}
      />
      {/* Outside the lists, so switching category or state keeps the same
          live region and a screen reader hears each new count. */}
      <output className="sr-only">
        {query.trim() === "" || shown === undefined
          ? ""
          : t("agents.shown", { count: shown.length })}
      </output>
      {paged ? (
        counts.all === 0 ? (
          <EmptyState title={t("agents.empty")} />
        ) : pages.isPending ? (
          <StatusScreen kind="loading" />
        ) : pages.error && !shown?.length ? (
          <LoadFailure
            error={pages.error}
            onRetry={() => void pages.refetch()}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <AgentsIn
              view={view}
              agents={shown ?? []}
              onClear={clear}
              summarized
            />
            <PagedListFooter list={pages} />
          </div>
        )
      ) : administered.isPending ? (
        <StatusScreen kind="loading" />
      ) : administered.error ? (
        <LoadFailure
          error={administered.error}
          onRetry={() => void administered.refetch()}
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
          <AgentsIn view={view} agents={shown ?? []} onClear={clear} />
        </div>
      )}
    </div>
  );
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
  view,
  agents,
  onClear,
  summarized = false,
}: {
  readonly view: AgentView;
  /** The list after the search. */
  readonly agents: readonly AgentListItem[];
  readonly onClear: () => void;
  readonly summarized?: boolean;
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
  return view === "cards" ? (
    <AgentCards agents={agents} summarized={summarized} />
  ) : (
    <AgentTable agents={agents} />
  );
}

function AgentTable({ agents }: { readonly agents: readonly AgentListItem[] }) {
  const { t } = useI18n();
  return (
    <GridTable
      aria-label={t("agents.title")}
      columns={COLUMNS[0]}
      narrowAt={640}
      narrowColumns={COLUMNS[1]}
      framed={true}
    >
      <GridTableHeader>
        <GridTableColumnHeader>{t("agents.column.name")}</GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("agents.column.engine")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          {t("agents.column.state")}
        </GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("agents.column.channels")}
        </GridTableColumnHeader>
        <GridTableColumnHeader align="end" hideNarrow>
          {t("agents.column.running")}
        </GridTableColumnHeader>
      </GridTableHeader>
      {agents.map((agent) => (
        <GridTableRow
          key={agent.id}
          inactive={agentState(agent) === "archived"}
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
          <GridTableCell hideNarrow>
            <AgentEngine agent={agent} />
          </GridTableCell>
          <GridTableCell>
            <AgentStateText agent={agent} />
          </GridTableCell>
          <GridTableCell hideNarrow className="gap-2">
            <AgentChannels agent={agent} />
          </GridTableCell>
          <GridTableCell align="end" hideNarrow className="tabular-nums">
            <AgentRunning agent={agent} />
          </GridTableCell>
        </GridTableRow>
      ))}
    </GridTable>
  );
}

// Name | engine | state | channels | running sessions; at 640px of table width
// or less, name | state. The fixed tracks, gaps and padding take 520px, so a
// narrower breakpoint would leave the name no room.
const COLUMNS = [
  "minmax(0,1fr) 96px 104px 104px 120px",
  "minmax(0,1fr) 104px",
] as const;

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
