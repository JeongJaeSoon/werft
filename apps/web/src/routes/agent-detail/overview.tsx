import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import type { AgentDetail, SessionSummary } from "@werft-ai/contracts";
import {
  agentSessionsQuery,
  agentSummariesQuery,
  usageBreakdownQuery,
} from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import {
  OPERATIONS_MESSAGES,
  SessionRowOpener,
  SessionStatusLabel,
  StatusLabel,
} from "@werft-ai/react/components";
import {
  Badge,
  Card,
  Code,
  CodeBlock,
  CopyButton,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  KeyValueList,
  MoreLink,
  RelativeTime,
  Section,
  Skeleton,
  StatCard,
  Steps,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useId, useState } from "react";
import { useHasPermission } from "../../auth/guard.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import { OutcomeLine } from "../../components/outcome.tsx";
import { withNodes } from "../../components/with-nodes.tsx";
import { LOCALE_NAMES, type Locale, useI18n } from "../../i18n/i18n.tsx";
import { usagePeriod } from "../operations.tsx";
import { credentialBindingsQuery } from "./credentials.tsx";
import { nextVersion, shownVersion } from "./versions.tsx";

// KeyValueList's dd does not break a long unspaced value; this does.
const VALUE = "min-w-0 [overflow-wrap:anywhere]";

const releasedVersion = (detail: AgentDetail, version: { id: string }) =>
  detail.releases.some((release) => release.version_id === version.id);

/** A figure, nothing yet while it loads, or why there is none. */
type Reading = string | { readonly missing: string } | undefined;

/**
 * The overview's figures: who waits on an answer, what runs, what it cost.
 * The counts are the agent list's summary of this one agent (GET /v1/agents
 * with `ids`, owners and admins only).
 */
export function AgentGlance({ detail }: { readonly detail: AgentDetail }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const lists = useHasPermission("agent.manage");
  const agents = useQuery({
    ...agentSummariesQuery(client, [detail.agent.id]),
    enabled: lists,
  });
  const failed = { missing: t("agents.cards.unavailable") };
  const summary = agents.data?.items.find(
    (item) => item.id === detail.agent.id,
  )?.summary;
  const count = (
    pick: (counts: NonNullable<typeof summary>) => number,
  ): Reading =>
    !lists
      ? { missing: t("agent.glance.countsWithheld") }
      : agents.isError
        ? failed
        : !agents.data
          ? undefined
          : summary
            ? String(pick(summary))
            : failed;
  return (
    <ul
      aria-label={t("agent.glance.label")}
      className="m-0 grid list-none grid-cols-1 items-stretch gap-4 p-0 @[720px]:grid-flow-col @[720px]:auto-cols-fr @[720px]:grid-cols-none"
    >
      <Figure
        label={t("agent.glance.waiting")}
        value={count((counts) => counts.needs_input_count)}
        note={t("agent.glance.waitingNote")}
      />
      <Figure
        label={t("agent.glance.running")}
        value={count((counts) => counts.running_count)}
        note={t("agent.glance.runningNote")}
      />
      <WeekCost agentId={detail.agent.id} />
    </ul>
  );
}

/**
 * The agent's cost over the last 7 days. Only the install-wide figures split
 * by agent, so only owners see a number.
 */
function WeekCost({ agentId }: { readonly agentId: string }) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const operator = useHasPermission("usage.installation_read");
  const { since, until } = usagePeriod(7);
  const breakdown = useQuery({
    ...usageBreakdownQuery(client, "installation", since, "agent", until),
    enabled: operator,
  });
  const row = breakdown.data?.rows.find((item) => item.key === agentId);
  return (
    <Figure
      label={t("agent.glance.cost")}
      badge={<Badge variant="gray">{t("usage.kpi.estimated")}</Badge>}
      value={
        !operator
          ? { missing: t("agent.glance.costWithheld") }
          : breakdown.isError
            ? { missing: t("agents.cards.unavailable") }
            : breakdown.data
              ? OPERATIONS_MESSAGES[locale].format.usd(row?.cost_usd ?? "0")
              : undefined
      }
      note={t("usage.kpi.costNote")}
    />
  );
}

function Figure({
  label,
  badge,
  value,
  note,
}: {
  readonly label: string;
  readonly badge?: ReactNode;
  readonly value: Reading;
  readonly note: string;
}) {
  const { t } = useI18n();
  const missing = typeof value === "object" ? value.missing : null;
  return (
    <li className="min-w-0">
      <StatCard
        className="h-full"
        label={label}
        badge={badge}
        value={
          value === undefined ? (
            <Skeleton lines={1} label={t("status.loading.title")} />
          ) : typeof value === "object" ? (
            // A screen reader hears the reason under it instead.
            <span aria-hidden="true">—</span>
          ) : (
            value
          )
        }
        muted={missing !== null}
        description={missing ?? note}
      />
    </li>
  );
}

type StepState = "done" | "todo" | "pending" | "unknown";

/**
 * What stands between the agent and new sessions: credentials, a release,
 * the activation. The first open step offers the release tab, where all
 * three are done.
 */
export function AgentReadiness({
  detail,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly toRelease: ReactNode;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const bindings = useQuery(credentialBindingsQuery(client, detail.agent.id));
  const { agent } = detail;
  const draft = nextVersion(detail);
  const active = detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
  const refs = [
    ...new Set([
      ...(draft?.card.capabilities.credential_refs ?? []),
      ...(active?.card.capabilities.credential_refs ?? []),
    ]),
  ];
  const bound = new Set(
    (bindings.data?.items ?? [])
      .filter((binding) => binding.revoked_at === null)
      .map((binding) => binding.credential_ref),
  );
  const missing = refs.filter((ref) => !bound.has(ref));

  const credentials: { state: StepState; desc: ReactNode } =
    refs.length === 0
      ? { state: "done", desc: t("agent.ready.credentialsNone") }
      : bindings.isPending
        ? {
            state: "pending",
            desc: <Skeleton lines={1} label={t("status.loading.title")} />,
          }
        : bindings.error
          ? { state: "unknown", desc: null }
          : missing.length === 0
            ? {
                state: "done",
                desc: t("agent.ready.credentialsBound", {
                  count: refs.length,
                }),
              }
            : {
                state: "todo",
                desc: t("agent.ready.credentialsMissing", {
                  names: missing.join(", "),
                }),
              };
  const released = detail.releases.length > 0;
  const newer = nextVersion(detail);
  const upToDate =
    agent.active_release_id !== null &&
    active !== undefined &&
    newer === undefined;
  // A paused or archived agent starts no session whatever its release, and
  // no screen changes the status, so its step offers nothing to press.
  const runnable = agent.status === "active";
  const steps: readonly {
    key: string;
    title: string;
    state: StepState;
    desc: ReactNode;
  }[] = [
    {
      key: "credentials",
      title: t("agent.ready.credentials"),
      state: credentials.state,
      desc: credentials.desc,
    },
    {
      key: "release",
      title: t("agent.ready.release"),
      state: released ? "done" : "todo",
      desc: released
        ? t("agent.ready.releaseDone", { count: detail.releases.length })
        : t("agent.ready.releaseTodo"),
    },
    {
      key: "activate",
      title: t("agent.ready.activate"),
      state: upToDate && runnable ? "done" : "todo",
      desc: !runnable
        ? t("agent.ready.notRunnable", {
            status: t(`agents.status.${agent.status}`),
          })
        : agent.active_release_id === null
          ? t("agent.overview.notActive")
          : newer && active
            ? t("agent.overview.newerVersion", {
                latest: newer.version_no,
                active: active.version_no,
              })
            : t("agent.overview.upToDate"),
    },
  ];
  const firstOpen = steps.findIndex((step) => step.state === "todo");
  const ready = firstOpen === -1 && credentials.state === "done";

  return (
    <Section
      className="min-w-0"
      title={t("agent.ready.title")}
      actions={
        <Badge variant={ready ? "green" : "amber"}>
          {ready ? t("agent.ready.on") : t("agent.ready.todo")}
        </Badge>
      }
    >
      <Card className="gap-0 p-4">
        <Steps
          completedLabel={t("agent.ready.stepDone")}
          todoLabel={t("agent.ready.stepTodo")}
          // Only the credentials step can be unreadable; its reason is the label.
          unknownLabel={t("agent.ready.credentialsUnknown")}
          items={steps.map((step, index) => ({
            id: step.key,
            title: step.title,
            // Still loading is not unreadable: the step waits as an open one.
            state: step.state === "pending" ? "todo" : step.state,
            description: step.state === "unknown" ? undefined : step.desc,
            action:
              index === firstOpen && (step.key !== "activate" || runnable)
                ? toRelease
                : undefined,
          }))}
        />
      </Card>
    </Section>
  );
}

const RECENT_COLUMNS = "minmax(0,2fr) 136px 120px minmax(0,1fr) 96px";
// Admission and release drop out; the title keeps the width at 390px.
const RECENT_NARROW_COLUMNS = "minmax(0,1fr) 116px 72px";

/** The newest sessions created for this agent that the reader can see. */
export function AgentRecentSessions({ agentId }: { readonly agentId: string }) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const sessions = useQuery(agentSessionsQuery(client, agentId));
  const items = sessions.data?.items;
  return (
    <Section
      className="min-w-0"
      title={t("agent.sessions.title")}
      actions={
        <MoreLink asChild size="control">
          <RouterLink to="/sessions">{t("agent.sessions.all")}</RouterLink>
        </MoreLink>
      }
    >
      {sessions.error ? (
        <LoadFailure
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : !items ? (
        <Card className="px-4 py-3">
          <Skeleton lines={3} label={t("status.loading.title")} />
        </Card>
      ) : items.length === 0 ? (
        <Card className="px-4 py-6 text-center text-control text-muted-foreground">
          {t("agent.sessions.empty")}
        </Card>
      ) : (
        // The row opener's focus ring sits outside the row: no overflow clipping.
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label={t("agent.sessions.title")}
            columns={RECENT_COLUMNS}
            narrowAt={640}
            narrowColumns={RECENT_NARROW_COLUMNS}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("sessions.column.id")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("sessions.column.status")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow={true}>
                {t("sessions.column.admission")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow={true}>
                {t("agent.sessions.release")}
              </GridTableColumnHeader>
              <GridTableColumnHeader align="end">
                {t("sessions.column.lastEvent")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {items.map((session) => (
              <AgentSessionRow
                key={session.id}
                session={session}
                locale={locale}
              />
            ))}
          </GridTable>
        </div>
      )}
    </Section>
  );
}

function AgentSessionRow({
  session,
  locale,
}: {
  readonly session: SessionSummary;
  readonly locale: Locale;
}) {
  const { t } = useI18n();
  const shortId = session.id.slice(0, 8);
  return (
    <GridTableRow data-status={session.status}>
      <GridTableCell lines={true}>
        <SessionRowOpener
          name={t("agent.sessions.open", { name: session.title ?? shortId })}
          title={session.id}
          renderLink={({ children, ...link }) => (
            <RouterLink
              to="/sessions/$id"
              params={{ id: session.id }}
              {...link}
            >
              {children}
            </RouterLink>
          )}
        />
        <span
          className="max-w-full truncate font-medium text-link"
          title={session.title ?? session.id}
        >
          {session.title ?? shortId}
        </span>
        {session.title ? (
          <Code className="text-muted-foreground">{shortId}</Code>
        ) : null}
      </GridTableCell>
      <GridTableCell>
        <SessionStatusLabel
          status={session.status}
          label={t(`sessions.status.${session.status}`)}
          axisLabel={t("sessions.column.status")}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <StatusLabel
          className="whitespace-nowrap"
          axis="admission"
          state={session.admission_state}
          label={t(`sessions.admission.${session.admission_state}`)}
          axisLabel={t("sessions.column.admission")}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <span className="sr-only">{t("agent.sessions.release")}: </span>
        {session.agent
          ? (session.agent.release_label ??
            t("agent.versionLabel", {
              version: session.agent.release_version_no,
            }))
          : t("agent.panel.none")}
      </GridTableCell>
      <GridTableCell
        align="end"
        className="overflow-hidden whitespace-nowrap text-caption text-muted-foreground"
      >
        <span className="sr-only">
          {session.last_event_at
            ? t("sessions.column.lastEvent")
            : t("sessions.column.created")}{" "}
        </span>
        {/* Above the row's opener, so hovering and focus reach it. */}
        <RelativeTime
          value={session.last_event_at ?? session.created_at}
          locale={locale}
          className="relative truncate focus-visible:-outline-offset-2!"
        />
      </GridTableCell>
    </GridTableRow>
  );
}

/** The card tab when not editing: the card in words, and as sent. */
export function CardSummary({
  detail,
  edit,
}: {
  readonly detail: AgentDetail;
  /** The button that turns this view into the editor. */
  readonly edit: ReactNode;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const rawId = useId();
  const [copyFailed, setCopyFailed] = useState(false);
  const version = shownVersion(detail);
  const card = version?.card;
  const live = version !== undefined && version.id === active(detail)?.id;
  const none = t("agent.panel.none");
  const names = (items: readonly string[]) =>
    items.length === 0 ? (
      none
    ) : (
      <span className="inline-flex flex-wrap gap-1">
        {items.map((item) => (
          <Badge key={item} variant="gray" className="font-mono font-normal">
            {item}
          </Badge>
        ))}
      </span>
    );
  const raw = card ? JSON.stringify(card, null, 2) : "";

  return (
    <div className="grid grid-cols-1 items-stretch gap-4 @[720px]:grid-cols-2">
      <Card role="region" className="min-w-0 px-4" aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Heading id={titleId}>{t("agent.card.summaryTitle")}</Heading>
            <Text as="span" variant="meta">
              {!version
                ? t("agent.noActive")
                : !live
                  ? releasedVersion(detail, version)
                    ? t("agent.card.subReleased")
                    : t("agent.card.subDraft")
                  : detail.agent.status === "active"
                    ? t("agent.card.subActive")
                    : t("agent.card.subStopped", {
                        status: t(`agents.status.${detail.agent.status}`),
                      })}
            </Text>
          </div>
          <div className="flex flex-none items-center gap-2">
            {version ? (
              <Badge variant="gray" className="font-mono font-normal">
                {t("agent.versionShort", { version: version.version_no })}
              </Badge>
            ) : null}
            {edit}
          </div>
        </div>
        <KeyValueList
          variant="grid"
          stack="sm"
          items={[
            {
              label: t("agents.name"),
              value: <span className={VALUE}>{detail.agent.name}</span>,
            },
            {
              label: t("agents.slug"),
              value: (
                <Code size="inherit" className={VALUE}>
                  {detail.agent.slug}
                </Code>
              ),
            },
            {
              label: t("agent.releases.title"),
              value: (
                <span className={`${VALUE} tabular-nums`}>
                  {detail.active_release === null
                    ? "-"
                    : withNodes((vars) => t("agent.card.releasedAt", vars), {
                        at: (
                          <RelativeTime
                            value={
                              detail.active_release.activated_at ??
                              detail.active_release.created_at
                            }
                            locale={locale}
                          />
                        ),
                      })}
                </span>
              ),
            },
            {
              label: t("agents.description"),
              value: detail.agent.description ? (
                <span className={`${VALUE} line-clamp-3`}>
                  {detail.agent.description}
                </span>
              ) : (
                none
              ),
            },
            ...(card
              ? [
                  {
                    label: t("agentCard.agentInstructions"),
                    value: card.agent_instructions ? (
                      <span className={`${VALUE} line-clamp-3`}>
                        {card.agent_instructions}
                      </span>
                    ) : (
                      none
                    ),
                  },
                  ...(card.instructions
                    ? [
                        {
                          label: t("agentCard.earlierInstructions"),
                          value: (
                            <span className={`${VALUE} line-clamp-3`}>
                              {card.instructions}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  {
                    label: t("agents.cards.credentials"),
                    value: names(card.capabilities.credential_refs ?? []),
                  },
                  {
                    label: t("agents.cards.mcp"),
                    value: names(
                      (card.capabilities.mcp ?? []).map(
                        (server) => server.server,
                      ),
                    ),
                  },
                  {
                    label: t("agentCard.model"),
                    value: (
                      <Code size="inherit" className={VALUE}>
                        {card.model}
                      </Code>
                    ),
                  },
                  {
                    label: t("agentCard.language"),
                    value: (
                      <span className={VALUE}>
                        {LOCALE_NAMES[card.language]}
                      </span>
                    ),
                  },
                  {
                    label: t("agentCard.tools"),
                    value:
                      card.capabilities.tools === null ? (
                        <span className={VALUE}>{t("agentCard.toolsAll")}</span>
                      ) : (
                        names(card.capabilities.tools)
                      ),
                  },
                  {
                    label: t("agentCard.forbidden"),
                    value: names(card.capabilities.forbidden),
                  },
                ]
              : []),
          ]}
        />
        {card ? null : <Text variant="sub">{t("agent.noActive")}</Text>}
      </Card>
      {card ? (
        <Card role="region" className="min-w-0 px-4" aria-labelledby={rawId}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Heading id={rawId}>{t("agent.card.raw")}</Heading>
              <Text as="span" variant="meta">
                {live ? t("agent.card.rawSubActive") : t("agent.card.rawSub")}
              </Text>
            </div>
            <CopyButton
              value={raw}
              variant="outline"
              size="sm"
              label={t("agent.card.copy")}
              copiedLabel={t("agent.card.copied")}
              iconClassName="size-3.5"
              onResult={(ok) => setCopyFailed(!ok)}
            />
          </div>
          <OutcomeLine
            outcome={
              copyFailed
                ? { kind: "error", text: t("agent.card.copyFailed") }
                : null
            }
          />
          <CodeBlock className="flex-1 overflow-auto">{raw}</CodeBlock>
        </Card>
      ) : null}
    </div>
  );
}

function active(detail: AgentDetail) {
  return detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
}
