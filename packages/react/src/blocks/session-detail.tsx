import { isApiError } from "@werft-ai/client";
import type {
  SessionDetail as SessionDetailData,
  SessionShareView,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import {
  Button,
  formatClockTime,
  PageFrame,
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Text,
} from "@werft-ai/ui";
import {
  ArrowDown,
  Bot,
  Copy,
  Gauge,
  Globe,
  KeyRound,
  UserRound,
  UsersRound,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useState } from "react";
import {
  OPERATIONS_MESSAGES,
  SessionStatusLabel,
  StatusLabel,
  shortSessionId,
} from "../components/index.ts";
import { useFollowEnd } from "../components/session/follow-end.ts";
import { useWerft } from "../provider.tsx";
import {
  useAgentOpenable,
  useKeptFailure,
  usePendingRequests,
  useSession,
  useSessionEvents,
  useSessionShare,
  useSessionTurns,
  useSessionUsage,
} from "../sessions.ts";
import {
  PendingAnswers,
  type SessionActionProps,
  SessionComposer,
  SessionControls,
} from "./session-actions.tsx";
import { SessionChat } from "./session-chat.tsx";
import { SlackMark } from "./slack-mark.tsx";
import { SlackMessageLink } from "./slack-message-link.tsx";
import { type BlockText, useBlockText } from "./text.ts";

export interface SessionDetailProps extends SessionActionProps {
  readonly id: string;
  /** Shown until the session arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /**
   * The host's sections of the outputs tab, such as the session's pull
   * requests and `out/` files. The tab's label counts what `report` was
   * last given; the panel stays mounted while the chat shows, so it keeps
   * reading and reporting.
   */
  readonly panel?: (
    session: SessionDetailData,
    report: (summary: SessionOutputsSummary) => void,
  ) => ReactNode;
  /** The open tab; the chat when absent. */
  readonly tab?: SessionDetailTab | undefined;
  /** A tab was picked; without it the block keeps the choice itself. */
  readonly onTabChange?: ((tab: SessionDetailTab) => void) | undefined;
  /**
   * Drawn at the chat's end with the requests waiting for an answer, for
   * work that arrives after a turn ends and has no event of its own, such
   * as a push waiting for approval.
   */
  readonly timelineExtra?: (session: SessionDetailData) => ReactNode;
}

export type SessionDetailTab = "chat" | "outputs";

/** What the outputs tab lists, for its label. */
export interface SessionOutputsSummary {
  /** Undefined until every list has answered: a slow or failed one is not 0. */
  readonly count: number | undefined;
  /**
   * A GitHub refusal is among them: the count turns red and says so, and
   * with no count a red dot says it alone.
   */
  readonly refused: boolean;
}

// The chat keeps the composer on screen: the frame takes the screen under
// the top bar and only the chat scrolls. min-content lets a screen too short
// for that fall back to the page scroll. The outputs tab scrolls the page.
const CHAT_FRAME =
  "h-[calc(100dvh-var(--werft-topbar-h))] min-h-min pb-4 [&>[data-slot=page-frame-body]]:min-h-0";

export function SessionDetail({
  id,
  loading,
  renderError,
  panel: panelSections,
  tab,
  onTabChange,
  timelineExtra,
  unavailable,
  refusal,
}: SessionDetailProps) {
  const { t } = useBlockText();
  const session = useSession(id);
  const [draft, setDraft] = useState("");
  const [draftFor, setDraftFor] = useState(id);
  const [ownTab, setOwnTab] = useState<SessionDetailTab>(tab ?? "chat");
  // Kept with the session it came from, so another session's never shows.
  const [reported, setReported] = useState<{
    readonly id: string;
    readonly summary: SessionOutputsSummary;
  } | null>(null);
  const report = useCallback(
    (summary: SessionOutputsSummary) => setReported({ id, summary }),
    [id],
  );
  const summary = reported?.id === id ? reported.summary : undefined;
  if (draftFor !== id) {
    setDraftFor(id);
    setDraft("");
  }
  const current = onTabChange ? (tab ?? "chat") : ownTab;
  const changeTab = onTabChange ?? setOwnTab;
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
    `${events.events.at(-1)?.id ?? ""}/${turns.data?.items.length ?? 0}/${pending.data?.items.length ?? 0}`,
  );

  if (detail === undefined) {
    return (
      <PageFrame>
        {session.isPending ? (
          loading
        ) : isApiError(session.error, "NOT_FOUND") ? (
          <p className="m-0 text-destructive" role="alert">
            {t("session.notFound")}
          </p>
        ) : (
          renderError(session.error, () => void session.refetch())
        )}
      </PageFrame>
    );
  }
  const waiting = pending.data ? (
    // Titled for screen readers: once the last request is answered and its
    // notice goes, the keyboard lands on this title.
    <section aria-labelledby={WAITING_ID} className="flex flex-col">
      <h2 id={WAITING_ID} className="sr-only">
        {t("session.pending")}
      </h2>
      <PendingAnswers
        sessionId={id}
        items={pending.data.items}
        answerable={pending.data.answerable}
        status={detail.status}
        showEmpty={false}
        unavailable={unavailable}
        refusal={refusal}
      />
    </section>
  ) : pending.error ? (
    renderError(pending.error, () => void pending.refetch())
  ) : null;
  const working =
    detail.status === "running" ||
    detail.status === "queued" ||
    detail.status === "needs_input";

  const chat = (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4"
      // Whoever sends wants to see the reply, wherever they had scrolled.
      onSubmit={follow.toEnd}
    >
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
          // Scroll anchoring would move a list resized at its end away from
          // it, and the scroll that causes reads as the reader's.
          className="relative min-h-0 flex-1 overflow-y-auto py-2 pr-1 [overflow-anchor:none]"
        >
          <SessionChat
            events={events.events}
            state={events.state}
            turns={turns.data?.items}
            agentName={detail.agent?.name}
            working={working}
            after={
              <>
                {waiting}
                {timelineExtra?.(detail)}
              </>
            }
          />
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
    </div>
  );

  // Both panels stay mounted, so a reply being written, an answer in flight
  // and the outputs' own reads survive a switch; Radix leaves a
  // force-mounted panel visible and in the tab order. The class hides it
  // where the host has no Tailwind preflight to honour `hidden` over `flex`.
  const tabPanel = (name: SessionDetailTab) => ({
    value: name,
    forceMount: true as const,
    hidden: name !== current,
    tabIndex: name === current ? 0 : -1,
  });
  const inactiveHidden = "data-[state=inactive]:hidden";

  return (
    <PageFrame className={current === "chat" ? CHAT_FRAME : undefined}>
      <header className="flex min-w-0 flex-col gap-2">
        {/* Top-aligned, so an outcome under the buttons does not move the
            title down; the title is a button tall to stay level with them. */}
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h1 className="m-0 flex min-h-[var(--werft-control-height-sm)] min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-medium text-title">
            {/* A server from before titles sends none at all. */}
            {detail.title ? (
              <span className="[overflow-wrap:anywhere]">{detail.title}</span>
            ) : (
              <span className="font-mono">{shortSessionId(id)}</span>
            )}
            <span className="flex items-center gap-2 font-normal text-body">
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
          </h1>
          <SessionControls
            session={detail}
            unavailable={unavailable}
            refusal={refusal}
          />
        </div>
        <SessionMeta session={detail} usage={usage.data} />
        {usage.error
          ? renderError(usage.error, () => void usage.refetch())
          : null}
      </header>
      <Tabs
        value={current}
        onValueChange={(next) => changeTab(next as SessionDetailTab)}
        className="mt-[var(--werft-space-page-head)] min-h-0 min-w-0 flex-1 gap-[var(--werft-space-block)]"
      >
        {/* overflow-y-hidden: the active underline overhangs the row by 1px. */}
        <div className="overflow-x-auto overflow-y-hidden border-b">
          <TabsList variant="line" aria-label={t("session.tabs.label")}>
            <TabsTrigger value="chat">{t("session.tabs.chat")}</TabsTrigger>
            <TabsTrigger
              value="outputs"
              count={summary?.count}
              countTone={summary?.refused ? "danger" : undefined}
              countLabel={t(
                summary?.refused
                  ? "session.tabs.outputs.refused"
                  : "session.tabs.outputs.count",
                { count: summary?.count ?? 0 },
              )}
            >
              {t("session.tabs.outputs")}
              {/* A refusal must not wait on a list that failed to read. The
                  dot is the sidebar's size; the count's badge replaces it. */}
              {summary?.count === undefined && summary?.refused ? (
                <>
                  {" "}
                  <StatusDot status="failed" className="size-1.5" />
                  <span className="sr-only">
                    {t("session.tabs.outputs.refusedUncounted")}
                  </span>
                </>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          {...tabPanel("chat")}
          className={`flex min-h-0 min-w-0 flex-col ${inactiveHidden}`}
        >
          {chat}
        </TabsContent>
        <TabsContent
          {...tabPanel("outputs")}
          className={`flex min-w-0 flex-col gap-[var(--werft-space-section)] ${inactiveHidden}`}
        >
          {/* Mounted anew for another session, so it reports for that one. */}
          <Fragment key={detail.id}>{panelSections?.(detail, report)}</Fragment>
        </TabsContent>
      </Tabs>
    </PageFrame>
  );
}

/** Names the chat's waiting requests, where focus lands once all are answered. */
const WAITING_ID = "session-waiting";

/** Each surface's mark, by the words that name it. */
const CHANNEL_ICON: Record<
  NonNullable<SessionDetailData["channel"]>,
  (props: { readonly className?: string }) => ReactNode
> = {
  slack: ({ className }) => <SlackMark className={className} />,
  web: ({ className }) => (
    <Globe className={className} strokeWidth={1.5} aria-hidden="true" />
  ),
  api: ({ className }) => (
    <KeyRound className={className} strokeWidth={1.5} aria-hidden="true" />
  ),
};

/** Where the session was started from, with that surface's mark. */
/**
 * The head's one line under the title: the short id to copy, the agent,
 * where the session was started and by whom (the start time on hover), then
 * its cost and tokens. Grey and small; it wraps on a narrow screen.
 */
function SessionMeta({
  session,
  usage,
}: {
  readonly session: SessionDetailData;
  readonly usage: SessionUsageResponse | undefined;
}) {
  const { t, locale } = useBlockText();
  const [copied, setCopied] = useState(false);
  const copy = t("session.id.copy");
  const person = session.created_by?.display_name;
  const channel = session.channel;
  const ChannelIcon = channel ? CHANNEL_ICON[channel] : null;
  const started = `${t("session.info.started")} ${formatClockTime(session.created_at, locale, true)}`;
  return (
    <p
      data-slot="session-meta"
      className="m-0 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-caption text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1">
        <span className="sr-only">{t("session.info.id")}: </span>
        <span className="font-mono">{shortSessionId(session.id)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          aria-label={copy}
          title={copy}
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
      </span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Bot
          className="size-3.5 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <span className="sr-only">{t("session.info.agent")}: </span>
        <AgentName session={session} />
      </span>
      <span
        className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5"
        title={started}
      >
        {ChannelIcon === null ? (
          <UserRound
            className="size-3.5 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        ) : (
          <ChannelIcon className="size-3.5 shrink-0" />
        )}
        <span className="sr-only">{t("session.info.channel")}: </span>
        <span className="[overflow-wrap:anywhere]">
          {[person || null, channel ? t(`session.channel.${channel}`) : null]
            .filter((part) => part !== null)
            .join(" · ") || t("sessions.none")}
        </span>
        {session.slack_permalink ? (
          <SlackMessageLink href={session.slack_permalink} />
        ) : null}
        <span className="sr-only">
          {" · "}
          {started}
        </span>
      </span>
      {usage ? (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <Gauge
            className="size-3.5 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="sr-only">{t("session.usage")}: </span>
          <Cost usage={usage} />
          {" · "}
          {t("session.info.tokens")}{" "}
          {new Intl.NumberFormat(locale).format(usage.token_count)}
        </span>
      ) : null}
      <SessionShare id={session.id} />
    </p>
  );
}

function shareText(t: BlockText, share: SessionShareView): string {
  if (share.scope === "people")
    return t("session.share.people", { count: share.user_ids.length });
  if (share.scope === "team")
    return t("session.share.team", { count: share.team_ids.length });
  if (share.scope === "private") return t("session.share.private");
  // `workspace` that the agent's access setting keeps inside the agent.
  return t(
    share.audience_limited
      ? "session.share.workspaceLimited"
      : "session.share.workspace",
  );
}

/**
 * Who sees the session, read only. Nothing while it reads or for a viewer
 * who may no longer read it. A failed read says so in its place, even over
 * an earlier answer, which may no longer be true.
 */
function SessionShare({ id }: { readonly id: string }) {
  const { t } = useBlockText();
  const share = useSessionShare(id, true);
  const error = useKeptFailure(share, id);
  if (isApiError(error, "NOT_FOUND") || isApiError(error, "FORBIDDEN"))
    return null;
  if (error) {
    return (
      <Text
        as="span"
        variant="meta"
        className="inline-flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
      >
        <Text
          as="span"
          variant="meta"
          role="alert"
          className="text-muted-foreground"
        >
          {t("session.share.failed")}
        </Text>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 text-caption"
          onClick={() => void share.refetch()}
        >
          {t("session.share.retry")}
        </Button>
      </Text>
    );
  }
  if (!share.data) return null;
  return (
    <Text
      as="span"
      variant="meta"
      className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground"
    >
      <UsersRound
        className="size-3.5 shrink-0"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <Text as="span" className="sr-only">
        {t("session.share.title")}:{" "}
      </Text>
      {shareText(t, share.data)}
    </Text>
  );
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
    className: "text-(color:--werft-color-link) underline underline-offset-2",
    children: agent.name,
  });
}

/** The cost so far, and why it may still grow when it is not final. */
function Cost({ usage }: { readonly usage: SessionUsageResponse }) {
  const { t, locale } = useBlockText();
  const { cost } = usage;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="tabular-nums">
        {cost.kind === "unmetered"
          ? t("session.usage.unmetered")
          : OPERATIONS_MESSAGES[locale].format.usd(cost.amount_usd)}
      </span>
      {cost.complete ? null : (
        <span className="text-caption text-muted-foreground">
          {cost.open_turn_count > 0
            ? t("session.usage.incomplete")
            : t("session.usage.unreported")}
        </span>
      )}
    </span>
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
