import type {
  AdmissionState,
  SessionStatus,
  SessionSummary,
} from "@werft-ai/contracts";
import {
  GridTableCell,
  GridTableRow,
  GridTableRowOpener,
  RelativeTime,
  type TimestampLocale,
} from "@werft-ai/ui";
import { Fragment, isValidElement, type JSX, type ReactNode } from "react";

import { StatusLabel } from "../status/status-label.tsx";
import { SessionStatusLabel } from "./session-status-label.tsx";
import { useMinute } from "./use-minute.ts";

/**
 * SessionTable's column template. The state columns fit their longest label
 * on one line: "Waiting for an answer" and "Needs recovery" in English. At
 * 820px of table width and below, admission and runtime drop out for
 * SESSION_NARROW_TEMPLATE, where a long status label wraps.
 */
export const SESSION_TEMPLATE =
  "minmax(0,5fr) 160px 136px minmax(0,3fr) minmax(120px,2fr)";
export const SESSION_NARROW_TEMPLATE = "minmax(0,1fr) 120px 72px";

export interface SessionRowMessages {
  readonly status: (status: SessionStatus) => string;
  readonly admission: (state: AdmissionState) => string;
  /** The axis names a screen reader hears before each state. */
  readonly statusAxis: string;
  readonly admissionAxis: string;
  /** Heard before the runtime; the row shows only its value. */
  readonly runtime: string;
  readonly lastEvent: string;
  readonly created: string;
  readonly queuedTurns: (count: number) => string;
  /** Stands in for a value the session does not have, such as a runtime. */
  readonly none: string;
}

/** What the row's link carries; the screen draws it with its router. */
export interface SessionRowLink {
  readonly children: ReactNode;
  readonly className: string;
  readonly "aria-label": string;
  readonly title: string;
  /** Marks the link as the row's opener for the row's hover and cell rules. */
  readonly "data-slot"?: string | undefined;
}

/*
 * The opener's own look, also given to the link itself: a renderLink that
 * returns more than one element (a fragment) cannot be the opener's Slot
 * child, so its link has to cover the row and show focus on its own.
 */
const OPENER_LINK =
  "absolute inset-0 z-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2";

/** The row's one link, over the whole row, from the screen's renderLink. */
export function SessionRowOpener({
  name,
  title,
  renderLink,
}: {
  /** What the link is called, e.g. "세션 열기: 배포 점검". */
  readonly name: string;
  readonly title: string;
  readonly renderLink: (link: SessionRowLink) => ReactNode;
}): ReactNode {
  const link = renderLink({
    children: null,
    "aria-label": name,
    title,
    className: OPENER_LINK,
    "data-slot": "grid-table-row-opener",
  });
  if (!isValidElement(link) || link.type === Fragment) return link;
  return (
    <GridTableRowOpener aria-label={name} asChild={true}>
      {link}
    </GridTableRowOpener>
  );
}

export interface SessionRowProps {
  readonly session: SessionSummary;
  /** Owned by the screen that routes; this package never builds URLs. */
  readonly renderLink: (link: SessionRowLink) => ReactNode;
  readonly messages: SessionRowMessages;
  readonly locale?: TimestampLocale | undefined;
  /** The instant "N분 전" counts from; a clock of its own if unset. */
  readonly now?: number | undefined;
  readonly className?: string | undefined;
}

export function SessionRow({
  session,
  renderLink,
  messages,
  locale = "ko",
  now,
  className,
}: SessionRowProps): JSX.Element {
  const clock = useMinute(now === undefined);
  const { runtime } = session;
  return (
    <GridTableRow
      data-slot="session-row"
      data-status={session.status}
      className={className}
    >
      <GridTableCell className="font-mono text-caption">
        <SessionRowOpener
          name={session.id}
          title={session.id}
          renderLink={renderLink}
        />
        <span className="min-w-0 truncate">{session.id}</span>
      </GridTableCell>
      {/* flex, not a line box: an inline badge would sit on the baseline and
          make the row 1–2px taller than its padding says. */}
      <GridTableCell>
        <SessionStatusLabel
          status={session.status}
          label={messages.status(session.status)}
          axisLabel={messages.statusAxis}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <StatusLabel
          className="whitespace-nowrap"
          axis="admission"
          state={session.admission_state}
          label={messages.admission(session.admission_state)}
          axisLabel={messages.admissionAxis}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <span className="min-w-0 truncate">
          <span className="sr-only">{messages.runtime}: </span>
          {runtime
            ? `${runtime.connection_id} · ${runtime.kind} ${runtime.version}`
            : messages.none}
          {session.queued_turn_count > 0
            ? ` · ${messages.queuedTurns(session.queued_turn_count)}`
            : null}
        </span>
      </GridTableCell>
      <GridTableCell
        align="end"
        className="overflow-hidden whitespace-nowrap text-caption text-muted-foreground"
      >
        <span className="sr-only">
          {session.last_event_at ? messages.lastEvent : messages.created}{" "}
        </span>
        {/* Above the row's opener, so hovering and focus reach it. */}
        <RelativeTime
          value={session.last_event_at ?? session.created_at}
          locale={locale}
          now={now ?? clock}
          // The cell cuts what overflows; the ring stays inside.
          // Important: apps/web's unlayered focus rule sets a 2px offset.
          className="relative truncate focus-visible:-outline-offset-2!"
        />
      </GridTableCell>
    </GridTableRow>
  );
}
