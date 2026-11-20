import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "@werft-ai/contracts";
import { usePendingRequests } from "@werft-ai/react";
import {
  type SessionOverviewHeadMessages,
  SessionOverviewRow,
  type SessionOverviewRowMessages,
  type SessionOverviewRowProps,
  SessionOverviewTable,
} from "@werft-ai/react/components";
import { formatElapsed } from "@werft-ai/ui";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n.tsx";

const MINUTE_MS = 60_000;

/** Moves on every minute, so waits and short times do not stay as drawn. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** The session list's column names, shared with home's recent sessions. */
export function useSessionOverviewHead(): SessionOverviewHeadMessages {
  const { t } = useI18n();
  return {
    title: t("sessionList.column.title"),
    agent: t("sessionList.column.agent"),
    channel: t("sessionList.column.channel"),
    status: t("sessionList.column.status"),
    started: t("sessionList.column.started"),
    duration: t("sessionList.column.duration"),
  };
}

export function useSessionOverviewRowMessages(): SessionOverviewRowMessages {
  const { t } = useI18n();
  return {
    status: (status) => t(`sessions.status.${status}`),
    admission: (state) => t(`sessions.admission.${state}`),
    statusAxis: t("sessions.column.status"),
    channel: (channel) => t(`session.channel.${channel}`),
    inProgress: t("sessionList.inProgress"),
    unknown: t("sessionList.unknown"),
    open: (name) => t("sessionList.open", { name }),
    preview: t("session.preview"),
  };
}

export function sessionLink(id: string): SessionOverviewRowProps["renderLink"] {
  return ({ children, ...link }) => (
    <Link to="/sessions/$id" params={{ id }} {...link}>
      {children}
    </Link>
  );
}

export function SessionsOverview({
  sessions,
}: {
  readonly sessions: readonly SessionSummary[];
}) {
  const { t } = useI18n();
  const now = useMinute();
  return (
    <SessionOverviewTable
      label={t("sessions.tableLabel")}
      messages={useSessionOverviewHead()}
    >
      {sessions.map((session) => (
        <Row key={session.id} session={session} now={now} />
      ))}
    </SessionOverviewTable>
  );
}

function Row({
  session,
  now,
}: {
  readonly session: SessionSummary;
  readonly now: number;
}) {
  const { locale } = useI18n();
  const messages = useSessionOverviewRowMessages();
  // "답변 대기 · 12분" reads the oldest open request, the inbox's own read.
  const waiting = session.status === "needs_input";
  const pending = usePendingRequests(session.id, waiting);
  const since = pending.data?.items
    .map((item) => item.created_at)
    .sort()
    .at(0);
  return (
    <SessionOverviewRow
      session={session}
      locale={locale}
      statusDetail={
        waiting && since ? formatElapsed(since, locale, now) : undefined
      }
      messages={messages}
      renderLink={sessionLink(session.id)}
    />
  );
}
