import { isApiError } from "@werft-ai/client";
import type {
  PushIntent,
  PushRequest,
  SessionDetail as SessionDetailData,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import {
  Badge,
  Button,
  Checkbox,
  formatTimestamp,
  KeyValueList,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Section as TitledBlock,
} from "@werft-ai/ui";
import { ArrowDown, Copy, PanelRightOpen } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CircleCheck } from "../components/console-icons.ts";
import {
  DetailLayout,
  DetailRail,
  DetailRailSection,
  type DetailRailToggle,
  OPERATIONS_MESSAGES,
  RepositoryName,
  RepositorySummary,
  SessionStatusLabel,
  StatusLabel,
  sessionRepositoriesOf,
  useDetailRailToggle,
} from "../components/index.ts";
import { useFollowEnd } from "../components/session/follow-end.ts";
import { useWerft } from "../provider.tsx";
import {
  useAgentOpenable,
  usePendingRequests,
  useSession,
  useSessionEvents,
  useSessionGithubWork,
  useSessionTurns,
  useSessionUsage,
} from "../sessions.ts";
import {
  actionsFor,
  PendingAnswers,
  type SessionActionProps,
  SessionComposer,
  SessionControls,
} from "./session-actions.tsx";
import {
  listedRequests,
  SessionTimeline,
  useTimelineView,
} from "./session-timeline.tsx";
import { SlackMessageLink } from "./slack-message-link.tsx";
import { type BlockText, useBlockText } from "./text.ts";

/** A tab a host adds between the timeline and the info tab. */
export interface SessionDetailTab {
  readonly value: string;
  readonly label: ReactNode;
  /** Drawn muted after the label, such as how many outputs there are. */
  readonly count?: ReactNode;
  readonly content: ReactNode;
}

export interface SessionDetailProps extends SessionActionProps {
  readonly id: string;
  /** The way back to the list: the path over the title, drawn by the host. */
  readonly breadcrumb?: (session: SessionDetailData) => ReactNode;
  /** Sections the host adds to the panel, between the info and operations. */
  readonly railSections?: (session: SessionDetailData) => ReactNode;
  /** Shown until the session arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /** What the host lets the reader change in the operations panel. */
  readonly controls?: (session: SessionDetailData) => ReactNode;
  /** The host's own tabs, such as the session's outputs. */
  readonly tabs?: (session: SessionDetailData) => readonly SessionDetailTab[];
  /**
   * Drawn under the events inside the timeline's own scroll, for work that
   * arrives after a turn ends and has no event of its own, such as a push.
   */
  readonly timelineExtra?: (session: SessionDetailData) => ReactNode;
}

export function SessionDetail({
  id,
  breadcrumb,
  railSections,
  loading,
  renderError,
  controls,
  tabs,
  timelineExtra,
  unavailable,
  refusal,
}: SessionDetailProps) {
  const { t } = useBlockText();
  const session = useSession(id);
  const [tab, setTab] = useState("timeline");
  const [view, setView] = useTimelineView();
  const [draft, setDraft] = useState("");
  const [draftFor, setDraftFor] = useState(id);
  if (draftFor !== id) {
    setDraftFor(id);
    setDraft("");
  }
  const lostAccess =
    isApiError(session.error, "NOT_FOUND") ||
    isApiError(session.error, "FORBIDDEN");
  const detail = lostAccess ? undefined : session.data;
  const readable = detail !== undefined;
  const usage = useSessionUsage(id, readable);
  const pending = usePendingRequests(id, readable);
  const events = useSessionEvents(id, readable);
  const turns = useSessionTurns(id, readable);
  // The event window keeps its length once full, so the newest event's id
  // tells an arrival, not the count.
  const follow = useFollowEnd(
    id,
    `${events.events.at(-1)?.id ?? ""}/${turns.data?.items.length ?? 0}`,
  );
  const panel = useDetailRailToggle({
    id: "session-panel",
    storageKey: PANEL_STORAGE_KEY,
    closeLabel: t("session.panel.close"),
    // The route keeps this block mounted from one session to the next.
    visit: id,
  });

  if (detail === undefined) {
    // The host leaves the gutters to this layout, rail or not.
    return (
      <DetailLayout>
        {session.isPending ? (
          loading
        ) : isApiError(session.error, "NOT_FOUND") ? (
          <p className="m-0 text-destructive" role="alert">
            {t("session.notFound")}
          </p>
        ) : (
          renderError(session.error, () => void session.refetch())
        )}
      </DetailLayout>
    );
  }
  const pendingCount = pending.data?.items.length;
  const hostTabs = tabs?.(detail) ?? [];
  const body = (
    <Tabs
      value={tab}
      onValueChange={setTab}
      // Grows so the body ends where the rail does.
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b">
        <TabsList variant="line" aria-label={t("session.tabs.label")}>
          <TabsTrigger value="timeline">
            {t("session.tabs.timeline")}
          </TabsTrigger>
          {hostTabs.map((extra) => (
            <TabsTrigger key={extra.value} value={extra.value}>
              {extra.label}
              {extra.count === undefined ? null : (
                <span className="text-caption text-muted-foreground tabular-nums">
                  {extra.count}
                </span>
              )}
            </TabsTrigger>
          ))}
          <TabsTrigger value="info">{t("session.tabs.info")}</TabsTrigger>
        </TabsList>
        {tab === "timeline" ? (
          // Checked is the default; clearing it shows every event.
          // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox is a Radix button, which a label still names
          <label className="mb-1 inline-flex items-center gap-2 text-control">
            <Checkbox
              checked={view === "focus"}
              onCheckedChange={(next) =>
                setView(next === true ? "focus" : "all")
              }
            />
            {t("session.events.view.focusMode")}
            <span className="text-caption text-muted-foreground">
              · {t("session.events.view.focusHint")}
            </span>
          </label>
        ) : null}
      </div>
      {/* Kept mounted on other tabs: the composer holds a send in flight. */}
      <TabsContent
        value="timeline"
        forceMount
        hidden={tab !== "timeline"}
        className="flex min-h-0 flex-1 flex-col gap-4 data-[state=inactive]:hidden"
        // Whoever sends wants to see the reply, wherever they had scrolled.
        onSubmit={follow.toEnd}
      >
        {/* No height of its own, so the screen's height decides; a 0%
            basis would count the whole timeline when the page measures
            min-content. Only a screen too short for 16rem scrolls the page. */}
        <div className="relative flex min-h-64 min-w-0 flex-[1_1_0px] flex-col">
          <div
            ref={follow.ref}
            // A keyboard needs a stop to scroll it once it overflows.
            {...(follow.scrollable
              ? {
                  tabIndex: 0,
                  role: "group",
                  "aria-label": t("session.events"),
                }
              : undefined)}
            // Scroll anchoring would move a list resized at its end away
            // from it, and the scroll that causes reads as the reader's.
            // `relative` keeps absolute boxes inside (sr-only text) under
            // its clip; placed from the wrapper they stretch the page.
            className="relative min-h-0 flex-1 overflow-y-auto rounded-card border bg-card [overflow-anchor:none]"
          >
            <SessionTimeline
              events={events.events}
              state={events.state}
              view={view}
              pending={listedRequests(pending)}
              turns={turns.data?.items}
              agentName={detail.agent?.name}
            />
            {timelineExtra?.(detail)}
          </div>
          {follow.behind ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="-translate-x-1/2 absolute bottom-3 left-1/2 shadow-md"
              onClick={() => {
                follow.toEnd();
                // The button goes away; the list it scrolled keeps focus.
                follow.element?.focus({ preventScroll: true });
              }}
            >
              <ArrowDown strokeWidth={1.5} aria-hidden="true" />
              {t("session.events.newer")}
            </Button>
          ) : null}
        </div>
        {usage.data ? <BudgetExceeded usage={usage.data} /> : null}
        <SessionComposer
          session={detail}
          unavailable={unavailable}
          refusal={refusal}
          draft={draft}
          onDraftChange={setDraft}
        />
      </TabsContent>
      {hostTabs.map((extra) => (
        <TabsContent key={extra.value} value={extra.value}>
          {extra.content}
        </TabsContent>
      ))}
      <TabsContent value="info">
        <div className="flex flex-col gap-3 rounded-card border bg-card p-4">
          <Overview session={detail} />
          <Repositories session={detail} />
          {usage.data ? (
            <Usage usage={usage.data} />
          ) : usage.error ? (
            renderError(usage.error, () => void usage.refetch())
          ) : null}
        </div>
      </TabsContent>
    </Tabs>
  );
  const rail = (
    <DetailRail label={t("session.panel")} toggle={panel}>
      <DetailRailSection title={t("session.pending")}>
        <div
          // With nothing to show, the answers block keeps its live region
          // mounted but leaves the flow, so it does not open a gap.
          className="flex flex-col gap-3 [&>[data-slot=pending-answers]:not(:has(li,p,output:not(:empty)))]:absolute"
        >
          {pending.data ? (
            <PendingAnswers
              sessionId={id}
              items={pending.data.items}
              answerable={pending.data.answerable}
              status={detail.status}
              showEmpty={false}
              unavailable={unavailable}
              refusal={refusal}
            />
          ) : pending.error ? (
            renderError(pending.error, () => void pending.refetch())
          ) : (
            <output className="text-caption text-muted-foreground">
              {t("sessions.loadingMore")}
            </output>
          )}
          {pendingCount === 0 ? (
            <div className="flex items-start gap-2">
              <CircleCheck
                className="mt-0.5 size-4 shrink-0 text-[var(--werft-tone-success-fg)]"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <p className="m-0 flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-control">
                  {t("session.pending.emptyTitle")}
                </span>
                <span className="text-caption text-muted-foreground leading-[1.5]">
                  {t(idleNote(detail.status), {
                    status: t(`sessions.status.${detail.status}`),
                  })}
                </span>
              </p>
            </div>
          ) : null}
        </div>
      </DetailRailSection>
      <DetailRailSection title={t("session.info.title")}>
        <SessionMeta session={detail} usage={usage.data} />
      </DetailRailSection>
      {railSections?.(detail)}
      <Operations
        session={detail}
        answerable={pending.data?.answerable}
        unavailable={unavailable}
        controls={controls?.(detail)}
      />
      {/* No repository list here on purpose: the header and the info tab
          already show it, and a third copy is the repeat 94S-1469 removed.
          To show it, add a DetailRailSection holding <RepositoryList />. */}
    </DetailRail>
  );
  return (
    <DetailLayout
      rail={rail}
      // The conversation keeps the composer on screen: the body takes the
      // screen under the top bar and only the timeline scrolls. min-content
      // lets a screen too short for that fall back to the page scroll.
      className={
        tab === "timeline"
          ? "[&>[data-slot=page-frame]]:h-[calc(100dvh-var(--werft-topbar-h))] [&>[data-slot=page-frame]]:min-h-min [&_[data-slot=page-frame-body]]:min-h-0"
          : undefined
      }
    >
      {breadcrumb?.(detail)}
      <PageHeader
        // The commands run from one to four buttons: they go under the title
        // when the row cannot hold both, so the title, status and meta line
        // keep a readable width.
        stackBelow="wrap"
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* A server from before titles sends none at all. */}
            {detail.title ? (
              <span className="[overflow-wrap:anywhere]">{detail.title}</span>
            ) : (
              <span className="font-mono">{id.slice(0, 8)}</span>
            )}
            <SessionStatusLabel
              status={detail.status}
              label={t(`sessions.status.${detail.status}`)}
              axisLabel={t("sessions.column.status")}
              className="shrink-0 whitespace-nowrap"
            />
            {/* A paused session otherwise reads the same as an idle one. */}
            {detail.admission_state === "active" ? null : (
              <StatusLabel
                axis="admission"
                state={detail.admission_state}
                label={t(`sessions.admission.${detail.admission_state}`)}
                axisLabel={t("sessions.column.admission")}
                className="shrink-0 whitespace-nowrap"
              />
            )}
          </span>
        }
        actions={
          <SessionControls
            session={detail}
            unavailable={unavailable}
            refusal={refusal}
            variant="menu"
            trailing={<PanelToggle panel={panel} waiting={pendingCount ?? 0} />}
          />
        }
      />
      {body}
    </DetailLayout>
  );
}

/** One browser remembers whether the reader folds the wide column away. */
export const PANEL_STORAGE_KEY = "ap.session.panel";

/**
 * Opens and folds the rail. Folded, the requests waiting for an answer stay
 * in sight as a count on the button, so an approval is two clicks away.
 */
function PanelToggle({
  panel,
  waiting,
}: {
  readonly panel: DetailRailToggle;
  readonly waiting: number;
}) {
  const { t } = useBlockText();
  // Open, the rail shows the requests itself, and the head keeps its room.
  const shown = waiting > 0 && !panel.open;
  return (
    <>
      {/* Open, the panel's own head has the button that folds it. Folded,
          this one brings it back; a request waiting shows as one red dot,
          never a count. */}
      {panel.open ? null : (
        <Button
          ref={panel.triggerRef}
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={panel.open}
          aria-controls={panel.id}
          onClick={panel.toggle}
        >
          <PanelRightOpen strokeWidth={1.5} aria-hidden="true" />
          {t("session.panel.show")}
          {waiting > 0 ? (
            <>
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-destructive"
              />
              <span className="sr-only">
                {t("session.panel.waiting", { count: waiting })}
              </span>
            </>
          ) : null}
        </Button>
      )}
      {/* Folded, the rail's own live region is gone from the page; a new
          request is still announced. */}
      <output className="sr-only">
        {shown ? t("session.panel.waiting", { count: waiting }) : ""}
      </output>
    </>
  );
}

function idleNote(status: SessionDetailData["status"]) {
  switch (status) {
    case "idle":
      return "session.pending.note.idle";
    case "queued":
    case "running":
    case "needs_input":
      return "session.pending.note.running";
    case "failed":
    case "stopped":
      return "session.pending.note.ended";
  }
}

/**
 * The agent's name, opening its page when the viewer can read that agent;
 * plain text for a session with no agent, a deleted one, or one the viewer
 * may not read.
 */
function AgentName({ session }: { readonly session: SessionDetailData }) {
  const { t } = useBlockText();
  const { renderLink } = useWerft();
  const agent = session.agent;
  const openable = useAgentOpenable(agent?.id);
  if (!agent) return t("session.agent.none");
  if (!openable) return agent.name;
  return renderLink({
    to: "agent",
    id: agent.id,
    className:
      "text-(color:--werft-color-link) underline-offset-2 hover:underline focus-visible:underline",
    children: agent.name,
  });
}

/**
 * The person, then the surface the session was started from, and the Slack
 * message it started with when there is one.
 */
function startedBy(session: SessionDetailData, t: BlockText): ReactNode {
  const person =
    session.created_by?.display_name || t("session.startedBy.unknown");
  const text = session.channel
    ? `${person} · ${t(`session.channel.${session.channel}`)}`
    : person;
  return session.slack_permalink ? (
    <span key="startedBy" className="inline-flex flex-wrap gap-x-2">
      {text}
      <SlackMessageLink href={session.slack_permalink} />
    </span>
  ) : (
    text
  );
}

/**
 * The header's one line: id to copy, agent, who started it, repositories and
 * cost so far. The model and the rest are on the info tab.
 */
function SessionMeta({
  session,
  usage,
}: {
  readonly session: SessionDetailData;
  readonly usage: SessionUsageResponse | undefined;
}) {
  const { t } = useBlockText();
  const [copied, setCopied] = useState(false);
  const label = t("session.id.copy");
  const repositories = sessionRepositoriesOf(session);
  return (
    <Facts
      rows={[
        [
          t("session.info.id"),
          <span key="id" className="inline-flex items-center gap-1">
            <span className="font-mono text-caption">
              {session.id.slice(0, 8)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              title={label}
              onClick={() => {
                void navigator.clipboard?.writeText(session.id).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              <Copy className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
            </Button>
            <output className="sr-only">
              {copied ? t("session.id.copied") : null}
            </output>
          </span>,
        ],
        [t("session.info.agent"), <AgentName key="agent" session={session} />],
        [t("session.info.startedBy"), startedBy(session, t)],
        [
          t("session.meta.repository"),
          <RepositorySummary
            key="repo"
            repositories={repositories}
            messages={{
              none: t("session.repository.none"),
              unknown: t("session.repositories.unknown"),
              more: (count) =>
                count === 1
                  ? t("session.repositories.more.one")
                  : t("session.repositories.more", { count }),
            }}
          />,
        ],
        usage ? [t("session.usage"), <Cost key="usage" usage={usage} />] : null,
      ]}
    />
  );
}

function Cost({ usage }: { readonly usage: SessionUsageResponse }) {
  const { t, locale } = useBlockText();
  return usage.cost.kind === "unmetered"
    ? t("session.usage.unmetered")
    : OPERATIONS_MESSAGES[locale].format.usd(usage.cost.amount_usd);
}

// The rail's rows are split by lines instead of sitting in a card.
const RAIL_ROWS = "gap-0 divide-y [&>div]:py-2";

/**
 * Who may answer and what the reader may do to the session. The API names
 * no answerers, so the rule stands in for a list; the commands themselves
 * stay in the header.
 */
function Operations({
  session,
  answerable,
  unavailable,
  controls,
}: {
  readonly session: SessionDetailData;
  /** Unknown until the pending requests arrive. */
  readonly answerable: boolean | undefined;
  readonly unavailable: SessionActionProps["unavailable"];
  /** What the host lets the reader change, under the rows. */
  readonly controls?: ReactNode;
}) {
  const { t } = useBlockText();
  const actions = actionsFor(session);
  return (
    <DetailRailSection title={t("session.ops")}>
      <div className="flex min-w-0 flex-col gap-4">
        <TitledBlock
          titleAs="h3"
          title={t("session.answerers")}
          description={t("session.answerers.roles")}
        >
          {answerable === undefined ? null : (
            <p className="m-0 text-body">
              {/* The same condition that turns the answer buttons off. */}
              {!answerable
                ? t("session.answerers.viewOnly")
                : (unavailable?.answer ?? t("session.answerers.you"))}
            </p>
          )}
        </TitledBlock>
        <TitledBlock
          titleAs="h3"
          title={t("session.ops.actions")}
          description={t("session.ops.actions.note")}
        >
          <KeyValueList
            className={RAIL_ROWS}
            items={[
              {
                label: t("session.ops.available"),
                value:
                  actions.length === 0 ? (
                    t("session.ops.none")
                  ) : (
                    // A narrow panel breaks the line between commands only.
                    <span className="flex flex-wrap justify-end gap-x-1">
                      {actions.map((action, index) => (
                        <span key={action} className="whitespace-nowrap">
                          {t(`session.control.${action}`)}
                          {index < actions.length - 1 ? " · " : null}
                        </span>
                      ))}
                    </span>
                  ),
              },
              {
                label: t("session.ops.mine"),
                // The server judges each command again.
                value:
                  unavailable?.control === undefined ? (
                    <Badge variant="green">{t("session.ops.allowed")}</Badge>
                  ) : (
                    <span className="text-muted-foreground">
                      {unavailable.control}
                    </span>
                  ),
              },
            ]}
          />
        </TitledBlock>
        {controls}
      </div>
    </DetailRailSection>
  );
}

type Fact = readonly [label: string, value: ReactNode];

function Facts({ rows }: { readonly rows: readonly (Fact | null)[] }) {
  return (
    <dl className="m-0 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-control">
      {rows.map((row) =>
        row ? (
          <div key={row[0]} className="contents">
            <dt className="text-muted-foreground">{row[0]}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{row[1]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
function Overview({ session }: { readonly session: SessionDetailData }) {
  const { t, locale } = useBlockText();
  const { attention, runtime } = session;
  return (
    <Facts
      rows={[
        [
          t("sessions.column.status"),
          <SessionStatusLabel
            key="status"
            status={session.status}
            label={t(`sessions.status.${session.status}`)}
            axisLabel={t("sessions.column.status")}
          />,
        ],
        [
          t("sessions.column.admission"),
          <StatusLabel
            key="admission"
            axis="admission"
            state={session.admission_state}
            label={t(`sessions.admission.${session.admission_state}`)}
            axisLabel={t("sessions.column.admission")}
          />,
        ],
        [t("session.info.agent"), <AgentName key="agent" session={session} />],
        [t("session.info.startedBy"), startedBy(session, t)],
        [
          t("session.info.id"),
          <span key="id" className="font-mono">
            {session.id}
          </span>,
        ],
        [
          t("session.meta.model"),
          <span key="model" className="font-mono">
            {session.model ?? runtime?.model ?? t("sessions.none")}
          </span>,
        ],
        [
          t("sessions.column.runtime"),
          runtime
            ? `${runtime.profile_id} · ${runtime.kind} ${runtime.version}`
            : t("sessions.none"),
        ],
        [
          t("session.currentTurn"),
          session.current_turn_id ?? t("sessions.none"),
        ],
        [t("session.queuedTurns"), session.queued_turn_count],
        [t("session.updated"), formatTimestamp(session.updated_at, locale)],
        attention
          ? [
              t("session.attention"),
              <span key="attention">
                <code>{attention.code}</code>
                {"reason" in attention ? ` ${attention.reason}` : null}
              </span>,
            ]
          : null,
      ]}
    />
  );
}

const PUSH_TONE = {
  requested: "amber",
  approved: "blue",
  pushing: "blue",
  pushed: "green",
  rejected: "gray",
  failed: "red",
} as const satisfies Record<PushRequest["state"], string>;

const PR_TONE = {
  due: "blue",
  opening: "blue",
  opened: "green",
  closed_unrecorded: "gray",
  uncertain: "amber",
  failed: "red",
  cancelled: "gray",
} as const satisfies Record<NonNullable<PushRequest["pr_state"]>, string>;

/** The newest request of each repository; a session may ask more than once. */
function latestRequests(items: readonly PushRequest[]) {
  const latest = new Map<string, PushRequest>();
  for (const item of items) {
    const seen = latest.get(item.repository_id);
    if (!seen || item.requested_at > seen.requested_at) {
      latest.set(item.repository_id, item);
    }
  }
  return latest;
}

/**
 * The newest intent of each repository that never became a request. One that
 * did is already shown through its request.
 */
function latestIntents(items: readonly PushIntent[]) {
  const latest = new Map<string, PushIntent>();
  for (const item of items) {
    if (item.push_request_id !== null) continue;
    const seen = latest.get(item.repository_id);
    if (!seen || item.created_at > seen.created_at) {
      latest.set(item.repository_id, item);
    }
  }
  return latest;
}

/**
 * Every repository the session works on, one list in id order, each with
 * where its push and pull request stand. History stays on the outputs tab.
 */
function Repositories({ session }: { readonly session: SessionDetailData }) {
  const { t } = useBlockText();
  return (
    <TitledBlock
      titleAs="h2"
      title={
        sessionRepositoriesOf(session).length === 1
          ? t("session.repositories.title.one")
          : t("session.repositories.title", {
              count: sessionRepositoriesOf(session).length,
            })
      }
    >
      <RepositoryList session={session} />
    </TitledBlock>
  );
}

/** The list alone, so a rail section can hold it under a title of its own. */
function RepositoryList({ session }: { readonly session: SessionDetailData }) {
  const { t } = useBlockText();
  const repositories = sessionRepositoriesOf(session);
  const work = useSessionGithubWork(session.id, repositories.length > 0);
  const latest = latestRequests(work.data?.items ?? []);
  const intents = latestIntents(work.data?.intents ?? []);
  return (
    <>
      {repositories.length === 0 ? (
        <p className="m-0 text-control text-muted-foreground">
          {t("session.repositories.none")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y p-0">
          {repositories.map((repository, index) => {
            const request = repository.id
              ? latest.get(repository.id)
              : undefined;
            const intent = repository.id
              ? intents.get(repository.id)
              : undefined;
            // A failed or deferred ask made after the last request is the
            // current state; the older request must not hide it.
            const newerIntent =
              intent &&
              intent.status !== "requested" &&
              (!request ||
                Date.parse(intent.created_at) >
                  Date.parse(request.requested_at))
                ? { ...intent, status: intent.status }
                : null;
            const prLink =
              request?.pr_state === "opened" &&
              request.pr_number !== null &&
              request.pr_url?.startsWith("https://")
                ? request.pr_url
                : null;
            return (
              <li
                // The same id can come twice from a legacy row with no key.
                key={`${repository.id ?? ""}:${index}`}
                className="flex min-w-0 flex-col gap-1 py-2 first:pt-0 last:pb-0"
              >
                <RepositoryName
                  repository={{ ...repository, branch: null }}
                  unknown={t("session.repositories.unknown")}
                />
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
                  {repository.branch ? (
                    <span>
                      {t("session.repositories.cloneBranch")}{" "}
                      <code>{repository.branch}</code>
                    </span>
                  ) : null}
                  {newerIntent ? (
                    // Asked for in a turn, no request made (yet).
                    <>
                      <span>
                        {t("session.repositories.pushBranch")}{" "}
                        <code>{newerIntent.target_branch}</code>
                      </span>
                      <Badge
                        variant={
                          newerIntent.status === "failed" ? "red" : "gray"
                        }
                      >
                        {t(`session.repositories.intent.${newerIntent.status}`)}
                      </Badge>
                    </>
                  ) : request ? (
                    <>
                      <span>
                        {t("session.repositories.pushBranch")}{" "}
                        <code>{request.target_branch}</code>
                      </span>
                      <Badge variant={PUSH_TONE[request.state]}>
                        {t(`session.repositories.push.${request.state}`)}
                      </Badge>
                      {prLink ? (
                        <a
                          href={prLink}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-(color:--werft-color-link) underline-offset-2 hover:underline focus-visible:underline"
                        >
                          {t("session.repositories.pr.opened")} #
                          {request?.pr_number}
                          <span className="sr-only">
                            {" "}
                            {t("session.slackLink.newTab")}
                          </span>
                        </a>
                      ) : request.pr_state ? (
                        <Badge variant={PR_TONE[request.pr_state]}>
                          {t(`session.repositories.pr.${request.pr_state}`)}
                        </Badge>
                      ) : null}
                    </>
                  ) : work.data ? (
                    <span>{t("session.repositories.noPush")}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {work.error && !isApiError(work.error, "NOT_FOUND") ? (
        <p
          role="alert"
          className="m-0 mt-2 flex flex-wrap items-center gap-2 text-caption text-destructive"
        >
          {t("session.repositories.workFailed")}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void work.refetch()}
          >
            {t("session.repositories.retry")}
          </Button>
        </p>
      ) : null}
    </>
  );
}

function Usage({ usage }: { readonly usage: SessionUsageResponse }) {
  const { t, locale } = useBlockText();
  const { usd } = OPERATIONS_MESSAGES[locale].format;
  const { cost } = usage;
  return (
    <>
      <Facts
        rows={[
          [
            t("session.usage.amount"),
            <span key="amount">
              {cost.kind === "unmetered"
                ? t("session.usage.unmetered")
                : usd(cost.amount_usd)}
              {cost.complete ? null : (
                <span className="text-muted-foreground">
                  {" "}
                  (
                  {cost.open_turn_count > 0
                    ? t("session.usage.incomplete")
                    : t("session.usage.unreported")}
                  )
                </span>
              )}
            </span>,
          ],
          [
            t("session.usage.costLimit"),
            usage.cost_limit_usd === null
              ? t("session.usage.noLimit")
              : usd(usage.cost_limit_usd),
          ],
          [t("session.usage.tokens"), usage.token_count],
          [
            t("session.usage.tokenLimit"),
            usage.token_limit ?? t("session.usage.noLimit"),
          ],
        ]}
      />
      <BudgetExceeded usage={usage} />
    </>
  );
}

function BudgetExceeded({ usage }: { readonly usage: SessionUsageResponse }) {
  const { t } = useBlockText();
  return usage.budget_exceeded ? (
    <output className="rounded-control border border-[var(--werft-tone-attention-border)] bg-card px-3 py-2 text-body">
      {t("session.usage.budgetExceeded")}
    </output>
  ) : null;
}
