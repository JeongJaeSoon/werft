import { isApiError } from "@werft-ai/client";
import type {
  SessionDetail as SessionDetailData,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import { Button, formatClockTime, KeyValueList } from "@werft-ai/ui";
import {
  ArrowDown,
  Globe,
  KeyRound,
  type LucideIcon,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  DetailLayout,
  DetailRail,
  DetailRailSection,
  type DetailRailToggle,
  OPERATIONS_MESSAGES,
  SessionStatusLabel,
  StatusLabel,
  shortSessionId,
  useDetailRailToggle,
} from "../components/index.ts";
import { useFollowEnd } from "../components/session/follow-end.ts";
import { useWerft } from "../provider.tsx";
import {
  useAgentOpenable,
  usePendingRequests,
  useSession,
  useSessionEvents,
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
import { useBlockText } from "./text.ts";

export interface SessionDetailProps extends SessionActionProps {
  readonly id: string;
  /** Shown until the session arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /**
   * The host's sections of the info card under the session's facts, such as
   * its pull requests and `out/` files (`InfoCardSection`s).
   */
  readonly panel?: (session: SessionDetailData) => ReactNode;
  /**
   * Drawn at the chat's end with the requests waiting for an answer, for
   * work that arrives after a turn ends and has no event of its own, such
   * as a push waiting for approval.
   */
  readonly timelineExtra?: (session: SessionDetailData) => ReactNode;
}

export function SessionDetail({
  id,
  loading,
  renderError,
  panel: panelSections,
  timelineExtra,
  unavailable,
  refusal,
}: SessionDetailProps) {
  const { t, locale } = useBlockText();
  const session = useSession(id);
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
    `${events.events.at(-1)?.id ?? ""}/${turns.data?.items.length ?? 0}/${pending.data?.items.length ?? 0}`,
  );
  const sheet = useDetailRailToggle({
    id: PANEL_ID,
    storageKey: PANEL_STORAGE_KEY,
    closeLabel: t("session.panel.fold"),
    // The route keeps this block mounted from one session to the next.
    visit: id,
  });
  // From 1280px the rail is always there: the head has no button to fold it,
  // so a fold remembered from before must not hide it.
  const panel = sheet.wide ? { ...sheet, open: true } : sheet;

  if (detail === undefined) {
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
  const controls = (
    <SessionControls
      session={detail}
      unavailable={unavailable}
      refusal={refusal}
    />
  );
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

  const rail = (
    <DetailRail
      label={t("session.info.title")}
      toggle={panel}
      separator="space"
    >
      <DetailRailSection title={t("session.info.overview")}>
        <KeyValueList
          variant="grid"
          className="grid-cols-[6rem_minmax(0,1fr)] gap-y-3"
          items={[
            {
              label: t("session.info.agent"),
              value: <AgentName session={detail} />,
            },
            {
              label: t("session.info.channel"),
              value: <Channel channel={detail.channel} />,
            },
            {
              label: t("session.info.started"),
              value: (
                <time dateTime={detail.created_at}>
                  {formatClockTime(detail.created_at, locale, true)}
                </time>
              ),
            },
            ...(usage.data
              ? [
                  {
                    label: t("session.info.tokens"),
                    value: (
                      <span className="tabular-nums">
                        {new Intl.NumberFormat(locale).format(
                          usage.data.token_count,
                        )}
                      </span>
                    ),
                  },
                  {
                    label: t("session.info.cost"),
                    value: <Cost usage={usage.data} />,
                  },
                ]
              : []),
          ]}
        />
        {usage.error
          ? renderError(usage.error, () => void usage.refetch())
          : null}
      </DetailRailSection>
      {panelSections?.(detail)}
      <DetailRailSection title={t("session.controls.title")}>
        {controls}
      </DetailRailSection>
    </DetailRail>
  );

  return (
    <DetailLayout
      rail={rail}
      // The chat keeps the composer on screen: the body takes the screen
      // under the top bar and only the chat scrolls. min-content lets a
      // screen too short for that fall back to the page scroll.
      className="[&>[data-slot=page-frame]]:h-[calc(100dvh-var(--werft-topbar-h))] [&>[data-slot=page-frame]]:min-h-min [&_[data-slot=page-frame-body]]:min-h-0"
    >
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-medium text-title">
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
          {/* Below 1280px the rail is a sheet, opened from here. */}
          {panel.wide ? null : <PanelToggle panel={panel} />}
        </div>
      </header>
      <div className="mt-[var(--werft-space-page-head)] flex min-h-0 min-w-0 flex-1 flex-col">
        {chat}
      </div>
    </DetailLayout>
  );
}

/** One browser remembers whether the reader folds the session info away. */
export const PANEL_STORAGE_KEY = "ap.session.panel";
const PANEL_ID = "session-panel";
/** Names the chat's waiting requests, where focus lands once all are answered. */
const WAITING_ID = "session-waiting";

/** The head's one button: folds and opens the session info rail. */
function PanelToggle({ panel }: { readonly panel: DetailRailToggle }) {
  const { t } = useBlockText();
  const Icon = panel.open ? PanelRightClose : PanelRightOpen;
  return (
    <Button
      ref={panel.triggerRef}
      type="button"
      variant="outline"
      size="sm"
      aria-expanded={panel.open}
      aria-controls={panel.id}
      onClick={panel.toggle}
    >
      <Icon strokeWidth={1.5} aria-hidden="true" />
      {panel.open ? t("session.panel.fold") : t("session.panel.unfold")}
    </Button>
  );
}

const CHANNEL_ICON: Record<"web" | "api", LucideIcon> = {
  web: Globe,
  api: KeyRound,
};

/** Where the session was started from, with that surface's mark. */
function Channel({
  channel,
}: {
  readonly channel: SessionDetailData["channel"];
}) {
  const { t } = useBlockText();
  // A server from before the field sends none at all.
  if (!channel) return t("sessions.none");
  const Icon = channel === "slack" ? null : CHANNEL_ICON[channel];
  return (
    <span className="inline-flex items-center gap-2">
      {Icon === null ? (
        <SlackMark className="size-4" />
      ) : (
        <Icon className="size-4" strokeWidth={1.5} aria-hidden="true" />
      )}
      {t(`session.channel.${channel}`)}
    </span>
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
