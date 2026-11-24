import { useQuery } from "@tanstack/react-query";
import type { SessionSummary } from "@werft-ai/contracts";
import { waitingSessionsQuery } from "@werft-ai/core";
import type { ReactNode } from "react";
import {
  LoadMoreButton,
  SessionRow,
  type SessionRowMessages,
  SessionTable,
} from "../components/index.ts";
import { useWerft } from "../provider.tsx";
import { useSessions } from "../sessions.ts";
import { useBlockText } from "./text.ts";

export interface SessionListProps {
  /** Shown until the first page arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
}

/** The caller's own sessions, a page at a time; the API lists nobody else's. */
export function SessionList({ loading, renderError }: SessionListProps) {
  const { t } = useBlockText();
  const sessions = useSessions();
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];

  if (sessions.isPending) return loading;
  if (sessions.error && items.length === 0) {
    return renderError(sessions.error, () => void sessions.refetch());
  }
  if (items.length === 0) {
    return <p className="m-0 text-muted-foreground">{t("sessions.empty")}</p>;
  }

  return (
    <div className="flex flex-col items-start gap-4">
      <Sessions items={items} />
      {sessions.error
        ? renderError(
            sessions.error,
            () =>
              void (sessions.isFetchNextPageError
                ? sessions.fetchNextPage()
                : sessions.refetch()),
          )
        : null}
      <LoadMoreButton
        hasMore={sessions.hasNextPage}
        loading={sessions.isFetchingNextPage}
        onLoadMore={() => void sessions.fetchNextPage({ cancelRefetch: false })}
        messages={{
          more: t("sessions.more"),
          loading: t("sessions.loadingMore"),
        }}
      />
    </div>
  );
}

/** A list shown beside others names its table so they read apart. */
export interface NamedSessionListProps extends SessionListProps {
  readonly label: string;
}

export interface RecentSessionsProps extends NamedSessionListProps {
  /** How many of the newest sessions to show. */
  readonly limit: number;
}

/** The newest of the caller's sessions; the session list has the rest. */
export function RecentSessions({
  label,
  limit,
  loading,
  renderError,
}: RecentSessionsProps) {
  const { t } = useBlockText();
  const sessions = useSessions();
  const items = sessions.data?.pages[0]?.items ?? [];

  if (sessions.isPending) return loading;
  if (sessions.error) {
    return renderError(sessions.error, () => void sessions.refetch());
  }
  if (items.length === 0) {
    return (
      <p className="m-0 text-muted-foreground text-body">
        {t("sessions.empty")}
      </p>
    );
  }
  return <Sessions label={label} items={items.slice(0, limit)} />;
}

/** The sessions waiting on an answer, read from the shell badge's page. */
export function WaitingSessions({
  label,
  loading,
  renderError,
}: NamedSessionListProps) {
  const { t } = useBlockText();
  const { client } = useWerft();
  const waiting = useQuery(waitingSessionsQuery(client));

  if (waiting.data === undefined) {
    return waiting.isPending
      ? loading
      : renderError(waiting.error, () => void waiting.refetch());
  }
  if (waiting.data.items.length === 0) {
    return (
      <p className="m-0 text-muted-foreground text-body">{t("inbox.empty")}</p>
    );
  }
  return <Sessions label={label} items={waiting.data.items} />;
}

function Sessions({
  items,
  label,
}: {
  readonly items: readonly SessionSummary[];
  readonly label?: string;
}) {
  const { t, locale } = useBlockText();
  const { renderLink } = useWerft();
  const messages: SessionRowMessages = {
    status: (status) => t(`sessions.status.${status}`),
    admission: (state) => t(`sessions.admission.${state}`),
    statusAxis: t("sessions.column.status"),
    capacityWait: t("sessions.capacityWait"),
    admissionAxis: t("sessions.column.admission"),
    runtime: t("sessions.column.runtime"),
    lastEvent: t("sessions.column.lastEvent"),
    created: t("sessions.column.created"),
    queuedTurns: (count) => `${t("session.queuedTurns")} ${count}`,
    none: t("sessions.none"),
  };
  return (
    <SessionTable
      label={label ?? t("sessions.tableLabel")}
      messages={{
        id: t("sessions.column.id"),
        status: t("sessions.column.status"),
        admission: t("sessions.column.admission"),
        runtime: t("sessions.column.runtime"),
        lastEvent: t("sessions.column.lastEvent"),
        created: t("sessions.column.created"),
      }}
    >
      {items.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          messages={messages}
          locale={locale}
          renderLink={(link) =>
            renderLink({ to: "session", id: session.id, ...link })
          }
        />
      ))}
    </SessionTable>
  );
}
