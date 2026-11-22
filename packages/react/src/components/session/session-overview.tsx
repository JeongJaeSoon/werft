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
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  SlackMark,
  TableTime,
  Text,
  type TimestampLocale,
} from "@werft-ai/ui";
import { Globe, SquareTerminal } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { type SessionRowLink, SessionRowOpener } from "./session-row.tsx";

/**
 * Title, agent, channel, status, started, duration. At 820px of table width
 * and below, channel and started drop out for
 * SESSION_OVERVIEW_NARROW_TEMPLATE; below 600px each row stacks (PHONE).
 * Channel, status, started and duration are as wide as their content; title
 * and agent share the rest.
 */
export const SESSION_OVERVIEW_TEMPLATE =
  "minmax(0,2fr) minmax(0,1fr) max-content max-content max-content max-content";
export const SESSION_OVERVIEW_NARROW_TEMPLATE =
  "minmax(0,2fr) minmax(0,1fr) max-content max-content";
const SESSION_OVERVIEW_ALIGN = [
  "start",
  "start",
  "start",
  "start",
  "start",
  "end",
] as const;

// A phone's table has no room for four columns side by side: the title
// takes the first line, agent, status and duration the second, and the
// column names stay for screen readers only. The status's detail drops out:
// the screens that draw this row show waits in their inbox above it. The
// rows are subgrids, so the template changes on the table.
const PHONE = {
  table: "[@container(width<600px)]:grid-cols-[minmax(0,1fr)_auto_auto]!",
  row: "[@container(width<600px)]:gap-y-1",
  title: "[@container(width<600px)]:col-span-full",
  header: "[@container(width<600px)]:sr-only",
  detail: "[@container(width<600px)]:hidden",
} as const;

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
    // The row opener's focus ring sits outside the row, so this frame must
    // not clip overflow.
    <div
      className={cn("w-full min-w-0 rounded-card border bg-card", className)}
    >
      <GridTable
        aria-label={label}
        className={PHONE.table}
        columns={SESSION_OVERVIEW_TEMPLATE}
        narrowAt={820}
        narrowColumns={SESSION_OVERVIEW_NARROW_TEMPLATE}
        align={SESSION_OVERVIEW_ALIGN}
      >
        <GridTableHeader className={cn(PHONE.row, PHONE.header)}>
          {/* One line each: a narrow column cuts its name rather than wrap. */}
          <GridTableColumnHeader>
            <span className="truncate">{messages.title}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.agent}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            <span className="truncate">{messages.channel}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.status}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            <span className="truncate">{messages.started}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
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
  /**
   * Beside the status of a session whose admission says more than it, e.g.
   * "복구 필요"; the row has no admission column of its own.
   */
  readonly admission: (state: AdmissionState) => string;
  /** The axis name a screen reader hears before the status. */
  readonly statusAxis: string;
  /** Names the channel icon: "Slack", "웹 콘솔", "API". */
  readonly channel: (channel: SurfaceKind) => string;
  /** The duration of a session still at work: "진행 중". */
  readonly inProgress: string;
  /** Stands in for a value the session does not have: agent, channel, time. */
  readonly unknown: string;
  /** Names the row's opener, e.g. "세션 열기: 배포 점검"; the name alone if unset. */
  readonly open?: ((name: string) => string) | undefined;
  /** The mark beside a preview session's title: "미리보기"; none if unset. */
  readonly preview?: string | undefined;
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

const CHANNEL_ICON = { web: Globe, api: SquareTerminal } as const;

function ChannelIcon({
  channel,
  label,
}: {
  readonly channel: SurfaceKind;
  readonly label: string;
}) {
  const Icon = channel === "slack" ? null : CHANNEL_ICON[channel];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-channel={channel}
      // Above the opener, so hovering shows the channel's name.
      className="relative inline-flex"
    >
      {Icon ? (
        <Icon
          className="size-4 text-muted-foreground"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      ) : (
        <SlackMark className="size-4" />
      )}
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
  const atWork = AT_WORK.has(session.status);
  // A session at work is "in progress"; otherwise its finished turns' run
  // time, so idle, paused and answer-waiting time between turns is not counted.
  const duration = atWork
    ? messages.inProgress
    : session.turn_time_ms > 0
      ? (formatDuration(session.turn_time_ms, locale) ?? messages.unknown)
      : messages.unknown;
  return (
    <GridTableRow
      data-slot="session-overview-row"
      data-status={session.status}
      className={cn(PHONE.row, className)}
    >
      <GridTableCell lines={true} className={PHONE.title}>
        <SessionRowOpener
          name={messages.open ? messages.open(name) : name}
          // The opener covers the row, so its hover text is the one shown.
          title={name}
          renderLink={renderLink}
        />
        <Text as="span" className="flex min-w-0 max-w-full items-center gap-2">
          <Text
            as="span"
            className={cn(
              "min-w-0 truncate font-medium",
              session.title ? null : "font-mono",
            )}
          >
            {session.title ?? shortId}
          </Text>
          {session.preview && messages.preview ? (
            <Badge variant="violet" className="shrink-0">
              {messages.preview}
            </Badge>
          ) : null}
        </Text>
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
      <GridTableCell hideNarrow={true}>
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
              PHONE.detail,
            )}
          >
            {statusDetail}
          </span>
        ) : null}
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="whitespace-nowrap">
        {/* Above the opener, so hovering and focus reach it. */}
        <TableTime
          value={session.created_at}
          locale={locale}
          // Important: apps/web's unlayered focus rule sets a 2px offset,
          // and the cell would cut a ring drawn outside the time.
          className="relative truncate focus-visible:-outline-offset-2!"
        />
      </GridTableCell>
      <GridTableCell className="whitespace-nowrap">
        <span
          className={cn("truncate", atWork ? "text-muted-foreground" : null)}
        >
          {duration}
        </span>
      </GridTableCell>
    </GridTableRow>
  );
}
