import type { SessionStatus, SessionSummary } from "@werft-ai/contracts";
import {
  Code,
  cn,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  RelativeTime,
  StatusDot,
  type TimestampLocale,
} from "@werft-ai/ui";
import { Folder } from "lucide-react";
import { createContext, type JSX, type ReactNode, useContext } from "react";
import { GitBranch } from "../console-icons.ts";
import { statusDot } from "../status/vocabulary.ts";
import {
  RepositorySummary,
  sessionRepositoriesOf,
} from "./session-repositories.tsx";
import { type SessionRowLink, SessionRowOpener } from "./session-row.tsx";
import { useMinute } from "./use-minute.ts";

/**
 * Console v4 `.t-sess`: title, status, agent · model, repository, started
 * by, recent. At 820px of table width and below, repository and started by
 * drop out for SESSION_OVERVIEW_NARROW_TEMPLATE; below 600px each row
 * stacks (PHONE). The status column fits en "Waiting for an answer · 59 min";
 * a longer wait truncates.
 */
export const SESSION_OVERVIEW_TEMPLATE =
  "minmax(0,2.2fr) 200px minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1fr) 72px";
/** v4 `.t-sess-home`: the same without the started-by column. */
export const SESSION_OVERVIEW_HOME_TEMPLATE =
  "minmax(0,2.2fr) 200px minmax(0,1.2fr) minmax(0,1.2fr) 72px";
export const SESSION_OVERVIEW_NARROW_TEMPLATE =
  "minmax(0,2fr) 116px minmax(0,1.2fr) 64px";

// A phone's table has no room for four columns side by side: the title
// takes the first line, status, agent and time the second, and the column
// names stay for screen readers only.
const PHONE = {
  row: "[@container(width<600px)]:grid-cols-[auto_minmax(0,1fr)_auto]! [@container(width<600px)]:gap-y-1",
  title: "[@container(width<600px)]:col-span-full",
  header: "[@container(width<600px)]:sr-only",
} as const;

/** The id a person can tell rows apart by; the full id stays in the title. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

export interface SessionOverviewHeadMessages {
  readonly session: string;
  readonly status: string;
  /** The third column's name when `agent` is not given. */
  readonly model: string;
  /** The third column's name, which holds the agent over its model. */
  readonly agent?: string | undefined;
  readonly repository: string;
  /** Given, the table has the started-by column (v4 `.t-sess`). */
  readonly startedBy?: string | undefined;
  readonly recent: string;
}

/** Which of the optional columns the rows draw; the table decides. */
const Columns = createContext({ agent: false, startedBy: false });

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
  const startedBy = messages.startedBy !== undefined;
  const agent = messages.agent !== undefined;
  return (
    // The row opener's focus ring sits outside the row, so this frame must
    // not clip overflow.
    <div
      className={cn("w-full min-w-0 rounded-card border bg-card", className)}
    >
      <GridTable
        aria-label={label}
        columns={
          startedBy ? SESSION_OVERVIEW_TEMPLATE : SESSION_OVERVIEW_HOME_TEMPLATE
        }
        narrowAt={820}
        narrowColumns={SESSION_OVERVIEW_NARROW_TEMPLATE}
      >
        <GridTableHeader className={cn(PHONE.row, PHONE.header)}>
          {/* One line each: a narrow column cuts its name rather than wrap. */}
          <GridTableColumnHeader>
            <span className="truncate">{messages.session}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.status}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.agent ?? messages.model}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            <span className="truncate">{messages.repository}</span>
          </GridTableColumnHeader>
          {startedBy ? (
            <GridTableColumnHeader hideNarrow={true}>
              <span className="truncate">{messages.startedBy}</span>
            </GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader align="end">
            <span className="truncate">{messages.recent}</span>
          </GridTableColumnHeader>
        </GridTableHeader>
        <Columns.Provider value={{ agent, startedBy }}>
          {children}
        </Columns.Provider>
      </GridTable>
    </div>
  );
}

export interface SessionOverviewRowMessages {
  readonly status: (status: SessionStatus) => string;
  /** The axis name a screen reader hears before the status. */
  readonly statusAxis: string;
  readonly noRepository: string;
  /** Names the "+N" button after the first repository, e.g. "저장소 2개 더". */
  readonly moreRepositories: (count: number) => string;
  /** Stands in for a value the session does not have: agent, model, starter. */
  readonly unknown: string;
  /** Heard before the time, which the row shows as a value only. */
  readonly recent: string;
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
  /**
   * Draws the last activity; when omitted, "12분 전" with the exact time in
   * a tooltip.
   */
  readonly renderTime?: ((iso: string) => ReactNode) | undefined;
  readonly locale?: TimestampLocale | undefined;
  /** The instant the default time counts from; a clock of its own if unset. */
  readonly now?: number | undefined;
  readonly className?: string | undefined;
}

export function SessionOverviewRow({
  session,
  renderLink,
  messages,
  statusDetail,
  renderTime,
  locale = "ko",
  now,
  className,
}: SessionOverviewRowProps): JSX.Element {
  const { agent, startedBy } = useContext(Columns);
  const clock = useMinute(!renderTime && now === undefined);
  const shortId = shortSessionId(session.id);
  // Untitled, the row shows the id's head; the opener's name keeps it whole.
  const name = session.title ?? session.id;
  const at = session.last_event_at ?? session.created_at;
  const repositories = sessionRepositoriesOf(session);
  const RepositoryIcon = repositories.length > 0 ? GitBranch : Folder;
  const statusLabel = messages.status(session.status);
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
        <StatusDot status={statusDot("session", session.status)} />
        <span className="sr-only">{messages.statusAxis}: </span>
        {/* A narrow column cuts the label, never the wait after it. */}
        <span className="flex min-w-0 whitespace-nowrap">
          <span className="min-w-0 truncate">{statusLabel}</span>
          {statusDetail ? (
            <span
              className={cn(
                "flex-none whitespace-pre",
                typeof statusDetail === "string" ? null : "relative",
              )}
            >
              {" · "}
              {statusDetail}
            </span>
          ) : null}
        </span>
      </GridTableCell>
      {agent ? (
        <GridTableCell lines={true}>
          <span className="max-w-full truncate">
            {session.agent?.name ?? messages.unknown}
          </span>
          {session.model ? (
            <Code className="text-subtle-foreground">{session.model}</Code>
          ) : null}
        </GridTableCell>
      ) : (
        // A table that names no agent column keeps the model column it had.
        <GridTableCell className="font-mono text-caption text-muted-foreground">
          <span className="min-w-0 truncate">
            {session.runtime?.model ?? messages.unknown}
          </span>
        </GridTableCell>
      )}
      <GridTableCell hideNarrow={true}>
        <RepositoryIcon
          className="size-3.5 flex-none text-subtle-foreground"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <RepositorySummary
          repositories={repositories}
          messages={{
            none: messages.noRepository,
            unknown: messages.unknown,
            more: messages.moreRepositories,
          }}
        />
      </GridTableCell>
      {startedBy ? (
        <GridTableCell hideNarrow={true}>
          <span className="truncate">
            {session.created_by?.display_name || messages.unknown}
          </span>
        </GridTableCell>
      ) : null}
      <GridTableCell
        align="end"
        className="overflow-hidden whitespace-nowrap text-caption text-subtle-foreground"
      >
        <span className="sr-only">{messages.recent} </span>
        {/* Above the opener, so hovering and focus reach the time. A longer
            word than the column ("yesterday 15:14") is cut, not spilled over
            the next column; the ring sits inside the cut. */}
        <span
          className={cn("relative min-w-0", renderTime ? "truncate" : "flex")}
        >
          {renderTime ? (
            renderTime(at)
          ) : (
            <RelativeTime
              value={at}
              locale={locale}
              now={now ?? clock}
              // Important: apps/web's unlayered focus rule sets a 2px offset.
              className="truncate focus-visible:-outline-offset-2!"
            />
          )}
        </span>
      </GridTableCell>
    </GridTableRow>
  );
}
