import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import type {
  Agent,
  AgentListItem,
  CountAgentsResponse,
  RuntimeKind,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { ListToolbar } from "@werft-ai/react/components";
import {
  Badge,
  type BadgeProps,
  Button,
  buttonVariants,
  Code,
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
import { Bot } from "lucide-react";
import { useRef, useState } from "react";
import {
  administeredAgentsQuery,
  agentCountsQuery,
  agentPagesQuery,
} from "../api/queries.ts";
import { permissionReason, useHasPermission, useRole } from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import {
  ADMINISTERED_LIST_LIMIT,
  AdministeredAgents,
} from "../components/agent-admins.tsx";
import { agentRefusal } from "../components/agent-refusal.ts";
import { AgentStateText, agentState } from "../components/agent-state.tsx";
import { GitHubMark, SlackMark } from "../components/brand-marks.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { OPENS_ROW, TABLE_ROW_LINK } from "../components/row-link.ts";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { SlackActionLink } from "../components/slack-action-link.tsx";
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

function AgentList({
  counts,
}: {
  readonly counts: CountAgentsResponse["counts"];
}) {
  const { t } = useI18n();
  const { client } = useWerft();
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
            size="toolbar"
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
            <AgentsIn agents={shown ?? []} onClear={clear} />
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
          <AgentsIn agents={shown ?? []} onClear={clear} />
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
  return (
    <GridTable aria-label={t("agents.title")} columns={COLUMNS}>
      <GridTableHeader>
        <GridTableColumnHeader>{t("agents.column.name")}</GridTableColumnHeader>
        <GridTableColumnHeader>
          {t("agents.column.engine")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          {t("agents.column.state")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          {t("agents.column.channels")}
        </GridTableColumnHeader>
        <GridTableColumnHeader align="end">
          {t("agents.column.running")}
        </GridTableColumnHeader>
      </GridTableHeader>
      {agents.map((agent) => {
        // A list without summaries (the agents a person administers) does
        // not know the engine, the channels or the running sessions.
        const summary = agent.summary;
        return (
          <GridTableRow
            key={agent.id}
            inactive={agentState(agent) === "archived"}
            className={OPENS_ROW}
          >
            <GridTableCell className="gap-3">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-muted-foreground"
              >
                <Bot className="size-4" />
              </span>
              <RowLines>
                <Link
                  to="/agents/$id"
                  params={{ id: agent.id }}
                  className={cn(
                    "font-medium text-foreground no-underline underline-offset-2 hover:underline [overflow-wrap:anywhere]",
                    TABLE_ROW_LINK,
                  )}
                >
                  {agent.name}
                </Link>
                <Code className="text-muted-foreground [overflow-wrap:anywhere]">
                  <span className="sr-only">{t("agents.slug")} </span>
                  {agent.slug}
                </Code>
                <SlackActionLink agent={agent} />
              </RowLines>
            </GridTableCell>
            <GridTableCell>
              {summary?.engine ? (
                <Badge variant={ENGINE_VARIANT[summary.engine]}>
                  {t(`agents.engine.${summary.engine}`)}
                </Badge>
              ) : (
                <Dash />
              )}
            </GridTableCell>
            <GridTableCell>
              <AgentStateText agent={agent} />
            </GridTableCell>
            <GridTableCell className="gap-2">
              {summary && summary.channels.length > 0 ? (
                summary.channels.map((channel) => {
                  const Mark = channel === "slack" ? SlackMark : GitHubMark;
                  const label = t(`agents.channel.${channel}`);
                  return (
                    <span
                      key={channel}
                      role="img"
                      aria-label={label}
                      title={label}
                      className="inline-flex"
                    >
                      <Mark className="size-4" />
                    </span>
                  );
                })
              ) : (
                <Dash />
              )}
            </GridTableCell>
            <GridTableCell align="end" className="tabular-nums">
              {summary && summary.running_count > 0 ? (
                summary.running_count
              ) : (
                <Dash />
              )}
            </GridTableCell>
          </GridTableRow>
        );
      })}
    </GridTable>
  );
}

/** A dash to the eye, "없음" to a screen reader. */
function Dash() {
  const { t } = useI18n();
  return (
    <span className="text-subtle-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("agent.panel.none")}</span>
    </span>
  );
}

const ENGINE_VARIANT = {
  claude_agent_sdk: "amber",
  codex_app_server: "teal",
  pi_coding_agent: "gray",
} as const satisfies Record<RuntimeKind, BadgeProps["variant"]>;

// Name | engine | state | channels | running sessions.
const COLUMNS = "minmax(0,1fr) 96px 112px 104px 120px";

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
