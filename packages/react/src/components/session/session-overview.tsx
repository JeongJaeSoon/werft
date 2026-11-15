import type {
  AdmissionState,
  SessionStatus,
  SessionSummary,
  SurfaceKind,
} from "@werft-ai/contracts";
import {
  Badge,
  type BadgeProps,
  Code,
  cn,
  formatDuration,
  formatTableDateTime,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  SlackMark,
  type TimestampLocale,
} from "@werft-ai/ui";
import { Globe, SquareTerminal } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { type SessionRowLink, SessionRowOpener } from "./session-row.tsx";

/**
 * Title, agent, channel, status, started, duration. Below the table's
 * minimum width it scrolls sideways. The status column fits en "Waiting for
 * an answer"; an admission pill beside it wraps under it.
 */
export const SESSION_OVERVIEW_TEMPLATE =
  "minmax(0,2.2fr) minmax(0,1.2fr) 56px 152px 148px 96px";

/** The id a person can tell rows apart by; the full id stays in the title. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

export interface SessionOverviewHeadMessages {
  readonly title: string;
  readonly agent: string;
  readonly channel: string;
  readonly status: string;
  readonly started: string;
  readonly duration: string;
}

export interface SessionOverviewTableProps {
  readonly label: string;
  readonly messages: SessionOverviewHeadMessages;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

export function SessionOverviewTable({
  label,
  messages,
  children,
  className,
}: SessionOverviewTableProps): JSX.Element {
  return (
    <div className={cn("w-full min-w-0", className)}>
      <GridTable
        aria-label={label}
        minWidth="52rem"
        columns={SESSION_OVERVIEW_TEMPLATE}
      >
        <GridTableHeader>
          {/* One line each: a narrow column cuts its name rather than wrap. */}
          <GridTableColumnHeader>
            <span className="truncate">{messages.title}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.agent}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.channel}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.status}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.started}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader align="end">
            <span className="truncate">{messages.duration}</span>
          </GridTableColumnHeader>
        </GridTableHeader>
        {children}
      </GridTable>
    </div>
  );
}

export interface SessionOverviewRowMessages {
  readonly status: (status: SessionStatus) => string;
  readonly admission: (state: AdmissionState) => string;
  /** The axis name a screen reader hears before the status. */
  readonly statusAxis: string;
  /** Names the channel icon: "Slack", "웹", "API". */
  readonly channel: (channel: SurfaceKind) => string;
  /** The duration of a session still at work: "진행 중". */
  readonly inProgress: string;
  /** Stands in for a value the session does not have: agent, channel, time. */
  readonly unknown: string;
  /** Names the row's opener, e.g. "세션 열기: 배포 점검"; the name alone if unset. */
  readonly open?: ((name: string) => string) | undefined;
}

export interface SessionOverviewRowProps {
  readonly session: SessionSummary;
  /**
   * Owned by the screen that routes; this package never builds URLs. The
   * link it returns is the row's opener, so it must be one element.
   */
  readonly renderLink: (link: SessionRowLink) => ReactNode;
  readonly messages: SessionOverviewRowMessages;
  /**
   * After the status, such as how long an answer has been awaited. Plain text
   * lies under the row's opener; any other node is raised above it, so a
   * tooltip trigger in it gets its own hover and focus.
   */
  readonly statusDetail?: ReactNode;
  readonly locale?: TimestampLocale | undefined;
  readonly className?: string | undefined;
}

/** A session's status as a pill; there is no "done" status to draw green. */
const STATUS_VARIANT = {
  queued: "gray",
  running: "blue",
  needs_input: "amber",
  idle: "gray",
  failed: "red",
  stopped: "gray",
} as const satisfies Record<SessionStatus, BadgeProps["variant"]>;

/** Statuses whose session is still at work, so it has no duration yet. */
const AT_WORK: ReadonlySet<SessionStatus> = new Set([
  "queued",
  "running",
  "needs_input",
]);

/** Admission states that say nothing beyond the status. */
const QUIET_ADMISSION: ReadonlySet<AdmissionState> = new Set([
  "active",
  "closed",
]);

function ChannelIcon({
  channel,
  label,
}: {
  readonly channel: SurfaceKind;
  readonly label: string;
}) {
  const icon =
    channel === "slack" ? (
      <SlackMark />
    ) : channel === "web" ? (
      <Globe
        className="size-4 text-muted-foreground"
        strokeWidth={1.5}
        aria-hidden="true"
      />
    ) : (
      <SquareTerminal
        className="size-4 text-muted-foreground"
        strokeWidth={1.5}
        aria-hidden="true"
      />
    );
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-channel={channel}
      // Above the opener, so hovering shows the channel's name.
      className="relative inline-flex"
    >
      {icon}
    </span>
  );
}

export function SessionOverviewRow({
  session,
  renderLink,
  messages,
  statusDetail,
  locale = "ko",
  className,
}: SessionOverviewRowProps): JSX.Element {
  const shortId = shortSessionId(session.id);
  // Untitled, the row shows the id's head; the opener's name keeps it whole.
  const name = session.title ?? session.id;
  const admission = QUIET_ADMISSION.has(session.admission_state)
    ? null
    : session.admission_state;
  // The API keeps no end for a session (an idle one takes the next message),
  // so a session that is not at work is measured from its start to its last
  // event.
  const duration = AT_WORK.has(session.status)
    ? messages.inProgress
    : session.last_event_at
      ? (formatDuration(session.created_at, session.last_event_at, locale) ??
        messages.unknown)
      : messages.unknown;
  return (
    <GridTableRow
      data-slot="session-overview-row"
      data-status={session.status}
      className={className}
    >
      <GridTableCell lines={true}>
        <SessionRowOpener
          name={messages.open ? messages.open(name) : name}
          // The opener covers the row, so its hover text is the one shown.
          title={name}
          renderLink={renderLink}
        />
        <span
          className={cn(
            "max-w-full truncate font-medium text-foreground",
            session.title ? null : "font-mono",
          )}
        >
          {session.title ?? shortId}
        </span>
        {session.title ? (
          // Above the opener, so hovering shows the whole id.
          <Code className="relative text-subtle-foreground" title={session.id}>
            {shortId}
          </Code>
        ) : null}
      </GridTableCell>
      <GridTableCell>
        <span className="min-w-0 truncate">
          {session.agent?.name ?? messages.unknown}
        </span>
      </GridTableCell>
      <GridTableCell>
        {session.channel ? (
          <ChannelIcon
            channel={session.channel}
            label={messages.channel(session.channel)}
          />
        ) : (
          <span className="text-subtle-foreground">{messages.unknown}</span>
        )}
      </GridTableCell>
      <GridTableCell className="flex-wrap gap-1">
        <span className="sr-only">{messages.statusAxis}: </span>
        <Badge variant={STATUS_VARIANT[session.status]}>
          {messages.status(session.status)}
        </Badge>
        {admission ? (
          <Badge variant={admission === "recovery_required" ? "red" : "gray"}>
            {messages.admission(admission)}
          </Badge>
        ) : null}
        {statusDetail ? (
          <span
            className={cn(
              "whitespace-nowrap text-caption text-muted-foreground",
              typeof statusDetail === "string" ? null : "relative",
            )}
          >
            {statusDetail}
          </span>
        ) : null}
      </GridTableCell>
      <GridTableCell className="whitespace-nowrap">
        <time
          dateTime={session.created_at}
          title={formatTimestamp(session.created_at, locale)}
          // Above the opener, so hovering shows the full time.
          className="relative truncate"
        >
          {formatTableDateTime(session.created_at, locale)}
        </time>
      </GridTableCell>
      <GridTableCell align="end" className="whitespace-nowrap">
        <span
          className={cn(
            "truncate",
            AT_WORK.has(session.status) ? "text-muted-foreground" : null,
          )}
        >
          {duration}
        </span>
      </GridTableCell>
    </GridTableRow>
  );
}
