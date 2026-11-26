import { isApiError } from "@werft-ai/client";
import type {
  SessionDetail as SessionDetailData,
  SessionShareView,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import { isCutOffTurnReason } from "@werft-ai/contracts";
import {
  Badge,
  Button,
  formatClockTime,
  PageFrame,
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
import {
  Fragment,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  OPERATIONS_MESSAGES,
  SessionStatusLabel,
  StatusLabel,
  shortSessionId,
} from "../components/index.ts";
import { useFollowEnd } from "../components/session/follow-end.ts";
import { useKeptFailure } from "../kept-failure.ts";
import { useWerft } from "../provider.tsx";
import {
  useAgentOpenable,
  usePendingRequests,
  useRetryFailedReadsOnStatus,
  useSession,
  useSessionEvents,
  useSessionShare,
  useSessionTurns,
  useSessionUsage,
} from "../sessions.ts";
import {
  ContinueTurn,
  focusLost,
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
  /**
   * The host's notice under the header, such as a takeover a manager may
   * make. It is given undefined when the session is not found for the
   * caller, and drawn under that message, since a manager may act on a
   * session it cannot read.
   */
  readonly notice?: (session: SessionDetailData | undefined) => ReactNode;
}

export type SessionDetailTab = "chat" | "outputs";

/** What the outputs tab lists, for its label. */
export interface SessionOutputsSummary {
  /** Undefined until every list has answered: a slow or failed one is not 0. */
  readonly count: number | undefined;
  /**
   * A GitHub refusal is among them: the count's badge turns danger and says
   * so, and with no count the badge's icon says it alone.
   */
  readonly refused: boolean;
}

// The chat keeps the composer on screen: the frame takes the screen under
// the top bar and the shell's notice, and only the chat scrolls. min-content lets a screen too short
// for that fall back to the page scroll. The outputs tab scrolls the page.
const CHAT_FRAME =
  "h-[calc(100dvh-var(--werft-topbar-h)-var(--werft-shell-notice-h))] min-h-min pb-4 [&>[data-slot=page-frame-body]]:min-h-0";

export function SessionDetail({
  id,
  loading,
  renderError,
  panel: panelSections,
  tab,
  onTabChange,
  timelineExtra,
  notice,
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
  const share = useSessionShare(id, readable);
  const shareFailure = useKeptFailure(share, id);
  useRetryFailedReadsOnStatus(id, detail?.status);
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
          <>
            <p className="m-0 text-destructive" role="alert">
              {t("session.notFound")}
            </p>
            {notice?.(undefined)}
          </>
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
  // The last turn cut off (a lost lease, an emergency stop), while nothing
  // follows it:
  // the session rests, but on work cut short, which the head says.
  const last = turns.data?.items.at(-1);
  const lostTurnId =
    last?.status === "failed" && isCutOffTurnReason(last.terminal_reason)
      ? last.turn_id
      : null;
  const cutOff = lostTurnId !== null && detail.status === "idle";

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
            failedAttempts={events.failedAttempts}
            onReconnect={events.reconnect}
            lostTurnAction={(turnId) =>
              cutOff &&
              turnId === lostTurnId &&
              detail.admission_state === "active" ? (
                <ContinueTurn
                  sessionId={id}
                  turnId={turnId}
                  unavailable={unavailable}
                  refusal={refusal}
                />
              ) : null
            }
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
      <BudgetExceeded usage={usage.data} attention={detail.attention} />
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
            ) : detail.title_deleted_at ? (
              <span className="text-muted-foreground">
                {t("session.sourceDeleted")}
              </span>
            ) : (
              <span className="font-mono">{shortSessionId(id)}</span>
            )}
            <span className="flex items-center gap-2 font-normal text-body">
              <SessionStatusLabel
                status={cutOff ? "failed" : detail.status}
                label={
                  cutOff
                    ? t("session.status.ownershipLost")
                    : t(`sessions.status.${detail.status}`)
                }
                capacityWait={detail}
                capacityWaitLabel={t("sessions.capacityWait")}
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
              {detail.preview ? (
                <Badge variant="violet" className="shrink-0">
                  {t("session.preview")}
                </Badge>
              ) : null}
            </span>
          </h1>
          <SessionControls
            session={detail}
            unavailable={unavailable}
            refusal={refusal}
          />
        </div>
        <SessionMeta
          session={detail}
          usage={usage.data}
          share={share.data}
          shareFailure={shareFailure}
          // A second press joins the read already going, data or not.
          retryShare={() => void share.refetch({ cancelRefetch: false })}
        />
        {usage.error
          ? renderError(usage.error, () => void usage.refetch())
          : null}
        {notice?.(detail)}
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
              // A refusal must not wait on a list that failed to read: with
              // no count, the badge holds its icon alone.
              countLabel={
                summary?.count === undefined
                  ? summary?.refused
                    ? t("session.tabs.outputs.refusedUncounted")
                    : undefined
                  : t(
                      summary.refused
                        ? "session.tabs.outputs.refused"
                        : "session.tabs.outputs.count",
                      { count: summary.count },
                    )
              }
            >
              {t("session.tabs.outputs")}
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
  share,
  shareFailure,
  retryShare,
}: {
  readonly session: SessionDetailData;
  readonly usage: SessionUsageResponse | undefined;
  readonly share: SessionShareView | undefined;
  readonly shareFailure: unknown;
  readonly retryShare: () => void;
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
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
        <Bot
          className="size-3.5 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <span className="sr-only">{t("session.info.agent")}: </span>
        <AgentName session={session} />
        <AgentRelease agent={session.agent} />
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
      <SessionShare
        key={session.id}
        share={share}
        failure={shareFailure}
        onRetry={retryShare}
      />
    </p>
  );
}

/** Null for a scope this build does not know, which may reach fewer people than the workspace. */
function shareText(t: BlockText, share: SessionShareView): string | null {
  if (share.scope === "people")
    return t("session.share.people", { count: share.user_ids.length });
  if (share.scope === "team")
    return t("session.share.team", { count: share.team_ids.length });
  if (share.scope === "private") return t("session.share.private");
  if (share.scope === "private_channel")
    return t("session.share.privateChannel");
  if (share.scope !== "workspace") return null;
  // Only those inside the agent see it when its managing team is not the
  // holding team.
  return t(
    share.audience_limited
      ? "session.share.workspaceLimited"
      : "session.share.workspace",
  );
}

/**
 * Who sees the session, read only. Nothing on its first read or for a viewer
 * who may no longer read it. A failed read says so in its place, even over
 * an earlier answer, which may no longer be true, and keeps saying so while
 * it reads again, unless another session has failed since.
 */
function SessionShare({
  share,
  failure,
  onRetry,
}: {
  readonly share: SessionShareView | undefined;
  readonly failure: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useBlockText();
  const failedId = useId();
  const pressed = useRef(false);
  const shown = useRef<HTMLElement | null>(null);
  const text = share ? shareText(t, share) : null;
  // A pressed retry takes its button away; focus lands on what it brought.
  useLayoutEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    if (!failure && text !== null && focusLost(shown.current))
      shown.current?.focus();
  }, [failure, text]);
  if (isApiError(failure, "NOT_FOUND") || isApiError(failure, "FORBIDDEN"))
    return null;
  if (failure) {
    return (
      <Text
        as="span"
        variant="meta"
        className="inline-flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
      >
        <Text
          as="span"
          variant="meta"
          id={failedId}
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
          aria-describedby={failedId}
          onClick={() => {
            pressed.current = true;
            onRetry();
          }}
        >
          {t("session.share.retry")}
        </Button>
      </Text>
    );
  }
  if (text === null) return null;
  return (
    <Text
      // Text types its ref as a paragraph whatever `as` says; this is a span.
      ref={(node: HTMLElement | null) => {
        shown.current = node;
      }}
      tabIndex={-1}
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
      {text}
    </Text>
  );
}

/**
 * The agent's name, opening its page when the viewer can read that agent;
 * plain text for a deleted one or one the viewer may not read, marked when
 * the agent is archived. Without a name, a session the server hid the agent
 * of says so rather than "none".
 */
function AgentName({ session }: { readonly session: SessionDetailData }) {
  const { t } = useBlockText();
  const { renderLink } = useWerft();
  const agent = session.agent;
  const openable = useAgentOpenable(agent?.id);
  if (!agent) {
    return t(
      session.agent_hidden ? "session.agent.hidden" : "session.agent.none",
    );
  }
  const name = openable
    ? renderLink({
        to: "agent",
        id: agent.id,
        className:
          "text-(color:--werft-color-link) underline underline-offset-2",
        children: agent.name,
      })
    : agent.name;
  if (!agent.archived) return name;
  return (
    <>
      {name}
      <Badge variant="gray" className="text-muted-foreground">
        {t("session.agent.archived")}
      </Badge>
    </>
  );
}

const MUTED = "text-muted-foreground";

/**
 * The release the session is pinned to, outside the agent's link. Not the
 * agent's active release only when the server says so; an older server's
 * null claims nothing, and an active one needs no word.
 */
function AgentRelease({
  agent,
}: {
  readonly agent: SessionDetailData["agent"];
}) {
  const { t } = useBlockText();
  if (!agent) return null;
  const version = agent.release_version_no;
  const name =
    agent.release_label ??
    (typeof version === "number"
      ? t("session.release.version", { version })
      : null);
  if (name === null) return null;
  return (
    <Text
      as="span"
      variant="meta"
      className={`min-w-0 ${MUTED} [overflow-wrap:anywhere]`}
    >
      {/* Every part on the meta line's own size, line and grey. Only the
          dots are hidden; the spaces still part the words when read. */}
      <Text as="span" variant="meta" className={MUTED} aria-hidden="true">
        ·
      </Text>{" "}
      <Text as="span" variant="meta" className="sr-only">
        {t("session.release.title")}:{" "}
      </Text>
      <Text as="span" variant="meta" className={MUTED} mono>
        {name}
      </Text>
      {agent.release_is_active === false ? (
        <>
          {" "}
          <Text as="span" variant="meta" className={MUTED} aria-hidden="true">
            {"· "}
          </Text>
          {t("session.release.notActive")}
        </>
      ) : null}
    </Text>
  );
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

/**
 * The session's own limit, as its usage reads it, else the budget account
 * that refused its last calls (attention.budget_owner): never both.
 */
function BudgetExceeded({
  usage,
  attention,
}: {
  readonly usage: SessionUsageResponse | undefined;
  readonly attention: SessionDetailData["attention"];
}) {
  const { t } = useBlockText();
  const owner =
    attention?.code === "BUDGET_EXCEEDED" ? attention.budget_owner : undefined;
  const text = usage?.budget_exceeded
    ? t("session.usage.budgetExceeded")
    : owner === "user"
      ? t("session.event.error.budgetAccountUser")
      : owner === "team"
        ? t("session.event.error.budgetAccountTeam")
        : null;
  return text === null ? null : (
    <output className="rounded-control border border-[var(--werft-tone-attention-border)] bg-card px-3 py-2 text-body">
      {text}
    </output>
  );
}
