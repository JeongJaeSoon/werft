import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  ConversationTurnItem,
  Initiator,
  ListConversationTurnsResponse,
} from "@werft-ai/contracts";
import { memberSummariesQuery } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { OPERATIONS_MESSAGES } from "@werft-ai/react/components";
import {
  EmptyState,
  FilterMenu,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Link,
  RowLines,
  Section,
  Skeleton,
  type StatusDotStatus,
  StatusText,
  TableTime,
  Text,
} from "@werft-ai/ui";
import { useState } from "react";
import { scopedKey } from "../../api/queries.ts";
import {
  CursorListFailure,
  ListPagination,
  useCursorPage,
} from "../../components/list-pages.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n.tsx";

/** Rows on one page of the list. */
export const TURN_PAGE_SIZE = 50;

type Turn = ConversationTurnItem;
type Show = "all" | Initiator;

const SHOWS = ["all", "person", "agent"] as const satisfies readonly Show[];
const SHOW_LABEL = {
  all: "agent.conversations.initiator.all",
  person: "agent.conversations.initiator.person",
  agent: "agent.conversations.initiator.agent",
} as const satisfies Record<Show, MessageKey>;

const REQUESTER_LABEL = {
  slack_user: "agent.conversations.requester.slack_user",
  slack_bot: "agent.conversations.requester.slack_bot",
  operator: "agent.conversations.requester.operator",
} as const satisfies Record<
  Exclude<Turn["requester"]["kind"], "user">,
  MessageKey
>;

const DECISION_LABEL = {
  reply: "agent.conversations.decision.reply",
  route_to_task: "agent.conversations.decision.route_to_task",
  spawn_task: "agent.conversations.decision.spawn_task",
  no_reply: "agent.conversations.decision.no_reply",
} as const satisfies Record<NonNullable<Turn["decision"]>, MessageKey>;

const STATE_LABEL = {
  running: "agent.conversations.state.running",
  decided: "agent.conversations.state.decided",
  no_decision: "agent.conversations.state.no_decision",
  voided_by_delete: "agent.conversations.state.voided_by_delete",
} as const satisfies Record<Turn["state"], MessageKey>;

const STATE_DOT = {
  running: "run",
  decided: "done",
  no_decision: "failed",
  voided_by_delete: "idle",
} as const satisfies Record<Turn["state"], StatusDotStatus>;

const LIMIT_LABEL = {
  model_call_limit: "agent.conversations.limit.model_call_limit",
  tool_call_limit: "agent.conversations.limit.tool_call_limit",
  time_limit: "agent.conversations.limit.time_limit",
} as const satisfies Record<NonNullable<Turn["limit"]>["reached"], MessageKey>;

const LIMIT_SIDE_LABEL = {
  runner: "agent.conversations.limitBy.runner",
  server: "agent.conversations.limitBy.server",
} as const satisfies Record<NonNullable<Turn["limit"]>["by"], MessageKey>;

function turnPagesQuery(
  client: ApiClient,
  agentId: string,
  show: Show,
  enabled: boolean,
) {
  const initiator = show === "all" ? undefined : show;
  return infiniteQueryOptions({
    queryKey: scopedKey(client, "agent-conversation-turns", agentId, show),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/agents/{id}/conversation-turns", {
          params: {
            path: { id: agentId },
            query: {
              limit: TURN_PAGE_SIZE,
              ...(initiator ? { initiator } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListConversationTurnsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled,
    retry: false,
  });
}

/**
 * The agent's conversation turns (v1-b/V3), newest first: when, for whom,
 * how each ended and what it cost. Metadata only; nothing anyone wrote.
 */
export function ConversationsTab({
  agentId,
  manages,
  mounted,
}: {
  readonly agentId: string;
  /** Owner, admin or the agent's admin: who the server answers. */
  readonly manages: boolean;
  /** Read once the tab has been opened. */
  readonly mounted: boolean;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const [show, setShow] = useState<Show>("all");
  const [page, setPage] = useState(1);
  const pages = useInfiniteQuery(
    turnPagesQuery(client, agentId, show, manages && mounted),
  );
  const listed = useCursorPage({
    list: pages,
    page,
    pageSize: TURN_PAGE_SIZE,
    onPageChange: setPage,
  });
  const forbidden = !manages || isApiError(pages.error, "FORBIDDEN");
  // The agent went away after the page read it: no rows of it stay.
  const gone = isApiError(pages.error, "NOT_FOUND");
  return (
    <Section
      className="min-w-0"
      title={t("agent.conversations.title")}
      description={t("agent.conversations.hint")}
    >
      {forbidden ? (
        <Text variant="sub">{t("agent.conversations.forbidden")}</Text>
      ) : gone ? (
        <EmptyState
          framed
          size="sm"
          title={t("agent.notFound.title")}
          description={t("agent.notFound.body")}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <FilterMenu
              label={t("agent.conversations.initiator.label")}
              options={SHOWS.map((value) => ({
                value,
                label: t(SHOW_LABEL[value]),
              }))}
              value={show}
              onValueChange={(value) => {
                setShow(value as Show);
                setPage(1);
              }}
            />
          </div>
          {pages.isPending ? (
            <Skeleton lines={3} label={t("agent.conversations.loading")} />
          ) : pages.error &&
            !pages.data?.pages.some((one) => one.items.length > 0) ? (
            <LoadFailure
              error={pages.error}
              onRetry={() => void pages.refetch()}
            />
          ) : listed.items.length === 0 ? (
            <EmptyState
              framed
              size="sm"
              title={t("agent.conversations.empty")}
              description={t("agent.conversations.emptyHint")}
            />
          ) : (
            <div
              aria-busy={listed.busy}
              data-busy={listed.busy}
              className="flex min-w-0 flex-col gap-4 transition-opacity data-[busy=true]:opacity-60 data-[busy=true]:delay-150"
            >
              <TurnTable rows={listed.items} />
              <CursorListFailure list={pages} page={listed} />
              <ListPagination list={listed} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// Started | requester | outcome | model | tokens | cost | links; one card per
// row at 640px or less.
const COLUMNS =
  "max-content minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) max-content max-content max-content";
const ALIGN = [
  "start",
  "start",
  "start",
  "start",
  "end",
  "end",
  "start",
] as const;

const short = (id: string) => id.slice(0, 8);

function TurnTable({ rows }: { readonly rows: readonly Turn[] }) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const userIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.requester.kind === "user" ? [row.requester.user_id] : [],
      ),
    ),
  ].sort();
  // A person no longer in the workspace, or a read refused, shows by id.
  const people = useQuery({
    ...memberSummariesQuery(client, userIds),
    enabled: userIds.length > 0,
  });
  const nameOf = new Map(
    (people.data?.items ?? []).map((member) => [
      member.user_id,
      member.display_name,
    ]),
  );
  const format = OPERATIONS_MESSAGES[locale].format;
  const column = {
    started: t("agent.conversations.column.started"),
    requester: t("agent.conversations.column.requester"),
    outcome: t("agent.conversations.column.outcome"),
    model: t("agent.conversations.column.model"),
    tokens: t("agent.conversations.column.tokens"),
    cost: t("agent.conversations.column.cost"),
    links: t("agent.conversations.column.links"),
  };
  return (
    <GridTable
      aria-label={t("agent.conversations.title")}
      columns={COLUMNS}
      align={ALIGN}
      narrowAt={640}
      narrowCards={true}
      framed={true}
    >
      <GridTableHeader>
        <GridTableColumnHeader>{column.started}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.requester}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.outcome}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.model}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.tokens}</GridTableColumnHeader>
        <GridTableColumnHeader>{column.cost}</GridTableColumnHeader>
        <GridTableColumnHeader>
          <span className="sr-only">{column.links}</span>
        </GridTableColumnHeader>
      </GridTableHeader>
      {rows.map((row) => (
        <GridTableRow key={row.id} data-state={row.state}>
          <GridTableCell>
            <RowLines>
              <TableTime value={row.started_at} locale={locale} />
              <Text variant="meta">
                {row.ended_at ? (
                  <>
                    {t("agent.conversations.endedAt")}{" "}
                    <TableTime value={row.ended_at} locale={locale} />
                  </>
                ) : (
                  t("agent.conversations.notEnded")
                )}
              </Text>
            </RowLines>
          </GridTableCell>
          <GridTableCell cardLabel={column.requester} className="min-w-0">
            <Text
              as="span"
              className="min-w-0 truncate"
              title={requesterLabel(t, row, nameOf)}
            >
              {requesterLabel(t, row, nameOf)}
            </Text>
          </GridTableCell>
          <GridTableCell cardLabel={column.outcome} className="min-w-0">
            <RowLines>
              <StatusText
                status={STATE_DOT[row.state]}
                className="whitespace-normal"
              >
                {row.decision
                  ? t(DECISION_LABEL[row.decision])
                  : t(STATE_LABEL[row.state])}
              </StatusText>
              {row.limit ? (
                <Text variant="meta">
                  {t("agent.conversations.limitReached", {
                    limit: t(LIMIT_LABEL[row.limit.reached]),
                    by: t(LIMIT_SIDE_LABEL[row.limit.by]),
                  })}
                </Text>
              ) : row.decision && row.state !== "decided" ? (
                <Text variant="meta">{t(STATE_LABEL[row.state])}</Text>
              ) : null}
            </RowLines>
          </GridTableCell>
          <GridTableCell cardLabel={column.model} className="min-w-0">
            <Text
              as="span"
              className="min-w-0 wrap-anywhere"
              title={row.models.join(", ") || undefined}
            >
              {row.models.length > 0
                ? row.models.join(", ")
                : t("agent.conversations.noModel")}
            </Text>
          </GridTableCell>
          <GridTableCell cardLabel={column.tokens} className="tabular-nums">
            <RowLines>
              <span>
                {t("agent.conversations.tokensIn", {
                  count: format.tokens(row.input_tokens),
                })}
              </span>
              <Text variant="meta" className="whitespace-normal">
                {t("agent.conversations.tokensOut", {
                  count: format.tokens(row.output_tokens),
                })}
              </Text>
            </RowLines>
          </GridTableCell>
          <GridTableCell cardLabel={column.cost} className="tabular-nums">
            <RowLines>
              <span>{format.usd(row.cost_usd)}</span>
              {/* The sums can still grow while a call has no usage report. */}
              {row.unpriced_calls > 0 ? (
                <Text variant="meta" className="whitespace-normal">
                  {t("agent.conversations.unpriced", {
                    count: row.unpriced_calls,
                  })}
                </Text>
              ) : null}
            </RowLines>
          </GridTableCell>
          <GridTableCell cardLabel={column.links}>
            <span className="flex flex-col items-start gap-1">
              {row.slack_thread ? (
                <Link
                  href={row.slack_thread.url}
                  target="_blank"
                  rel="noreferrer"
                  variant="table"
                >
                  {t("agent.conversations.slackThread")}
                </Link>
              ) : null}
              {row.thread_task_session_id ? (
                <Link asChild variant="table">
                  <RouterLink
                    to="/sessions/$id"
                    params={{ id: row.thread_task_session_id }}
                    title={row.thread_task_session_id}
                  >
                    {t("agent.conversations.taskSession")}
                  </RouterLink>
                </Link>
              ) : null}
            </span>
          </GridTableCell>
        </GridTableRow>
      ))}
    </GridTable>
  );
}

function requesterLabel(
  t: Translate,
  row: Turn,
  nameOf: ReadonlyMap<string, string>,
): string {
  const { requester } = row;
  if (requester.kind !== "user") return t(REQUESTER_LABEL[requester.kind]);
  return (
    nameOf.get(requester.user_id) ??
    t("agent.conversations.requester.user", { id: short(requester.user_id) })
  );
}
