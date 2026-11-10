import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ApiError, isApiError } from "@werft-ai/client";
import type {
  Agent,
  AgentListItem,
  CountAgentsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { AgentMark, ListToolbar } from "@werft-ai/react/components";
import {
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
  RelativeTime,
  RowLines,
  Tabs,
  TabsList,
  TabsTrigger,
  Text,
} from "@werft-ai/ui";
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
import { AgentStateText, agentState } from "../components/agent-state.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { ManagingTeamName } from "../components/managing-team.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { useProfileDisplay } from "../components/profile-options.tsx";
import { OPENS_ROW, TABLE_ROW_LINK } from "../components/row-link.ts";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { SlackActionLink } from "../components/slack-action-link.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { withNodes } from "../components/with-nodes.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";

// The release check's model refusal (release-ids.ts), as "<field>: <message>".
const MODEL_REFUSAL =
  /^card\.model: model (.+) is not the model of runtime profile (.+)$/;

/**
 * What a refused agent action says: a 403 in the words of the disabled
 * button, a model mismatch in our words, any other capability the profile
 * does not have with the server's reason.
 */
export function agentRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
  // Names a profile id from the shared list; without it the id is shown.
  profileText: (id: string) => string = (id) => id,
): string {
  if (error.code === "FORBIDDEN")
    return permissionReason(t, "agent.manage", role);
  // Only making an agent answers this: its slug is taken.
  if (error.code === "ALREADY_EXISTS") return t("agents.slugTaken");
  if (error.code === "PROFILE_BLOCKED") {
    const details = error.details as {
      readonly reason_code?: unknown;
      readonly profile_id?: unknown;
    } | null;
    if (typeof details?.profile_id === "string")
      return t(
        details.reason_code === "base_blocked"
          ? "agent.releases.baseProfileBlocked"
          : "agent.releases.profileBlocked",
        { profile: profileText(details.profile_id) },
      );
  }
  const model =
    error.code === "UNSUPPORTED_CAPABILITY"
      ? MODEL_REFUSAL.exec(error.message)
      : null;
  if (model)
    return t("agent.releases.modelRefused", {
      card: model[1] ?? "",
      profile: profileText(model[2] ?? ""),
    });
  if (error.code === "UNSUPPORTED_CAPABILITY" || error.code === "BAD_REQUEST")
    return `${t(errorKey(error.code))} ${error.message}`;
  return t(errorKey(error.code));
}

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
          <>
            {/* The map is another way to read the same agents. */}
            <Link
              to="/sessions/map"
              className={buttonVariants({ variant: "outline" })}
            >
              {t("sessionList.map.open")}
            </Link>
            <ReasonButton
              className={buttonVariants()}
              reason={reason}
              onClick={() => void navigate({ to: "/agents/new" })}
            >
              {t("agents.new")}
            </ReasonButton>
          </>
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
          <Tabs
            value={scope}
            onValueChange={(next) => setScope(next as typeof scope)}
          >
            <TabsList variant="line" aria-label={t("agents.tabs.label")}>
              <TabsTrigger value="all">{t("agents.tabs.all")}</TabsTrigger>
              <TabsTrigger value="administered">
                {t("agents.tabs.administered")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
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
  const { t, locale } = useI18n();
  return (
    <GridTable
      aria-label={t("agents.title")}
      columns={COLUMNS[0]}
      narrowAt={480}
      narrowColumns={COLUMNS[1]}
      framed={true}
    >
      <GridTableHeader>
        <GridTableColumnHeader>
          {t("agents.column.agent")}
        </GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>
          {t("agents.column.team")}
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          {t("agents.column.state")}
        </GridTableColumnHeader>
        <GridTableColumnHeader align="end" hideNarrow>
          {t("agents.column.updated")}
        </GridTableColumnHeader>
      </GridTableHeader>
      {agents.map((agent) => {
        const updated = (
          <RelativeTime
            value={agent.updated_at}
            locale={locale}
            className="relative z-1"
          />
        );
        return (
          <GridTableRow
            key={agent.id}
            inactive={agentState(agent) === "archived"}
            className={OPENS_ROW}
          >
            <GridTableCell className="gap-3">
              <AgentMark />
              <RowLines>
                <Link
                  to="/agents/$id"
                  params={{ id: agent.id }}
                  className={cn(
                    "font-medium text-link underline-offset-2 hover:underline [overflow-wrap:anywhere]",
                    TABLE_ROW_LINK,
                  )}
                >
                  {agent.name}
                </Link>
                <Code className="text-muted-foreground [overflow-wrap:anywhere]">
                  <span className="sr-only">{t("agents.slug")} </span>
                  {agent.slug}
                </Code>
                {/* GridTable's narrowAt={480}, where the time column drops. */}
                <Text
                  as="span"
                  variant="meta"
                  className="hidden [@container(width<480px)]:block"
                >
                  {withNodes((vars) => t("agents.updated", vars), {
                    at: updated,
                  })}
                </Text>
                <span className="hidden [@container(width<480px)]:block">
                  <span className="sr-only">{t("agents.column.team")} </span>
                  <ManagingTeamName agent={agent} />
                </span>
                <SlackActionLink agent={agent} />
              </RowLines>
            </GridTableCell>
            <GridTableCell hideNarrow>
              <ManagingTeamName agent={agent} />
            </GridTableCell>
            <GridTableCell>
              <AgentStateText agent={agent} />
            </GridTableCell>
            <GridTableCell
              align="end"
              hideNarrow
              className="text-caption text-muted-foreground"
            >
              {updated}
            </GridTableCell>
          </GridTableRow>
        );
      })}
    </GridTable>
  );
}

const COLUMNS = [
  "minmax(0,1fr) minmax(0,200px) 104px 120px",
  "minmax(0,1fr) 104px",
] as const;

export { agentState } from "../components/agent-state.tsx";

/**
 * A blank card, made in steps. One-line hiring (a model drafting the card)
 * is 94S-156's and adds its button here when it lands.
 */
export function NewAgentScreen() {
  const { t } = useI18n();
  const role = useRole();
  const profile = useProfileDisplay();
  const refuse = (error: unknown) =>
    isApiError(error)
      ? agentRefusal(t, error, role, profile.show)
      : t(errorKey("UNKNOWN"));
  return (
    <Page title={t("agents.newTitle")} description={t("agents.newIntro")}>
      <NewAgentFlow refuse={refuse} />
    </Page>
  );
}
